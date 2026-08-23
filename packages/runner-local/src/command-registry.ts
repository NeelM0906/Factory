import {
  CancelCommandRequestSchema,
  ReadArtifactChunkRequestSchema,
  ReadCommandEventsRequestSchema,
  normalizeSafeJson,
  digestVersionedValue,
  type ArtifactDescriptor,
  type CancelCommandRequest,
  type CommandId,
  type ReadArtifactChunkRequest,
  type ReadCommandEventsRequest
} from "@autostack/contracts";

import type { GuardianHostSession } from "./command-guardian.js";
import { recoverCommandUnderLease } from "./command-recovery.js";
import { admitRecoveryPublications } from "./command-recovery-admission.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  admitArtifactStoreRecoveryCapability,
  admitArtifactStoreRecoveryRoot,
  type ArtifactStoreRecoveryCapability
} from "./artifact-mutation-authority.js";
import { acquireCommandGuardianLease } from "./data-root-lock.js";
import { KeyedLock } from "./keyed-lock.js";
import { DataPathPolicy } from "./path-policy.js";
import {
  ReplaySpool,
  type CommandIntentInput,
  type DurableRunnerFrame,
  type ImmutableRunnerSubscriptionItem,
  type RecoveredCommandSpool,
  type ReplaySpoolRegistration
} from "./replay-spool.js";
import { isReplaySpoolError } from "./replay-spool-error.js";
import { admitIntent, canonicalJson, parseFrame } from "./replay-spool-codec.js";
import { snapshotSafeJson } from "./command-guardian-bounds.js";
import {
  CommandRegistryError,
  createCommandRegistryError,
  isTrustedCommandRegistryError,
  type CommandCancelRegistration,
  type CommandProtocolFailureRegistration,
  type CommandRegistryEntry as CommandEntry,
  type CommandRegistryOptions,
  type CommandSubscriberState as SubscriberState
} from "./command-registry-types.js";
import {
  decodeCommandDirectory,
  hasConsistentTerminalEvidence,
  sameArtifactOwnership,
  sameCancelOwnership,
  sameReadOwnership,
  terminalFrame
} from "./command-registry-validation.js";
import { isExactUnusedScaffolding } from "./command-registry-scaffolding.js";
import {
  CommandSubscription,
  armCommandSubscriberIdle,
  closeAllCommandSubscribers,
  closeCommandSubscriberState
} from "./command-registry-subscription.js";
import { admitCommandRegistryOptions } from "./command-registry-options.js";

export {
  CommandRegistryError,
  type CommandCancelRegistration,
  type CommandProtocolFailureRegistration,
  type CommandRegistryErrorCode,
  type CommandRegistryOptions
} from "./command-registry-types.js";

export class CommandRegistry {
  readonly #dataRoot: string;
  readonly #artifactStore: ArtifactStore;
  readonly #artifactCapability: ArtifactStoreRecoveryCapability;
  readonly #subscriberQueueFrames: number;
  readonly #subscriberQueueBytes: number;
  readonly #maximumCommands: number;
  readonly #maximumCommandSubscribers: number;
  readonly #maximumSubscribers: number;
  readonly #subscriberIdleMs: number;
  readonly #entries = new Map<CommandId, CommandEntry>();
  readonly #gates = new KeyedLock();
  readonly #registrationGate = new KeyedLock();
  readonly #subscriberLifecycleGate = new KeyedLock();
  #subscriberCount = 0;
  #closed = false;

  private constructor(
    dataRoot: string,
    artifactStore: ArtifactStore,
    artifactCapability: ArtifactStoreRecoveryCapability,
    queueFrames: number,
    queueBytes: number,
    maximumCommands: number,
    maximumCommandSubscribers: number,
    maximumSubscribers: number,
    subscriberIdleMs: number
  ) {
    this.#dataRoot = dataRoot;
    this.#artifactStore = artifactStore;
    this.#artifactCapability = artifactCapability;
    this.#subscriberQueueFrames = queueFrames;
    this.#subscriberQueueBytes = queueBytes;
    this.#maximumCommands = maximumCommands;
    this.#maximumCommandSubscribers = maximumCommandSubscribers;
    this.#maximumSubscribers = maximumSubscribers;
    this.#subscriberIdleMs = subscriberIdleMs;
  }

  static async create(options: CommandRegistryOptions): Promise<CommandRegistry> {
    const admitted = await admitCommandRegistryOptions(options);
    return new CommandRegistry(
      admitted.dataRoot,
      admitted.artifactStore,
      admitted.artifactCapability,
      admitted.queueFrames,
      admitted.queueBytes,
      admitted.maximumCommands,
      admitted.maximumCommandSubscribers,
      admitted.maximumSubscribers,
      admitted.subscriberIdleMs
    );
  }

  async registerIntent(intent: CommandIntentInput): Promise<ReplaySpoolRegistration> {
    return await this.#registrationGate.run("commands", async () => {
      this.#assertOpen();
      try {
        const admittedIntent = admitIntent(intent);
        const commandId = admittedIntent.commandId;
        if (this.#entries.size >= this.#maximumCommands && !this.#entries.has(commandId)) {
          throw createCommandRegistryError("capacity_exceeded");
        }
        const registration = await ReplaySpool.register({
          dataRoot: this.#dataRoot,
          intent: admittedIntent
        });
        await this.#gates.run(registration.receipt.commandId, async () => {
          const existing = this.#entries.get(registration.receipt.commandId);
          if (
            existing !== undefined &&
            existing.spool.intent.receiptDigest !== registration.receipt.receiptDigest
          ) {
            throw createCommandRegistryError("command_conflict");
          }
          if (existing === undefined) {
            const recovered = await registration.spool.recover();
            this.#entries.set(registration.receipt.commandId, {
              spool: registration.spool,
              terminal: recovered.events.some(terminalFrame),
              subscribers: new Set()
            });
          }
        });
        return registration;
      } catch (error) {
        if (isTrustedCommandRegistryError(error)) throw error;
        if (isReplaySpoolError(error) && error.code === "command_conflict") {
          throw createCommandRegistryError("command_conflict");
        }
        throw createCommandRegistryError("unsafe_state");
      }
    });
  }

  async attachSession(commandId: CommandId, session: GuardianHostSession): Promise<void> {
    this.#assertOpen();
    await this.#gates.run(commandId, async () => {
      const entry = this.#requireEntry(commandId);
      if (entry.session !== undefined && entry.session !== session) {
        throw createCommandRegistryError("command_conflict");
      }
      entry.session = session;
    });
  }

  async observeDurableFrame(commandId: CommandId, frame: DurableRunnerFrame): Promise<void> {
    if (this.#closed) return;
    let supplied: DurableRunnerFrame;
    try {
      supplied = parseFrame(snapshotSafeJson(frame, 128 * 1_024));
    } catch {
      throw createCommandRegistryError("maintenance_required");
    }
    await this.#gates.run(commandId, async () => {
      const entry = this.#requireEntry(commandId);
      const durable = await entry.spool.readEvent(supplied.sequence);
      if (
        durable === undefined ||
        canonicalJson(durable) !== canonicalJson(supplied) ||
        durable.frameDigest !== supplied.frameDigest
      ) {
        throw createCommandRegistryError("maintenance_required");
      }
      if (terminalFrame(supplied)) entry.terminal = true;
      const encodedBytes = Buffer.byteLength(
        JSON.stringify({ type: "runner.event", event: supplied.event })
      );
      for (const subscriber of entry.subscribers) {
        if (subscriber.done || subscriber.lagged || supplied.sequence <= subscriber.snapshotHead)
          continue;
        if (
          subscriber.queue.length >= this.#subscriberQueueFrames ||
          subscriber.queueBytes + encodedBytes > this.#subscriberQueueBytes
        ) {
          subscriber.queue.splice(0);
          subscriber.queueBytes = 0;
          subscriber.lagged = true;
          subscriber.waiter?.();
          delete subscriber.waiter;
          continue;
        }
        subscriber.queue.push(supplied);
        subscriber.queueBytes += encodedBytes;
        subscriber.waiter?.();
        delete subscriber.waiter;
      }
    });
  }

  subscribe(
    requestInput: ReadCommandEventsRequest
  ): AsyncIterable<ImmutableRunnerSubscriptionItem> {
    let request: ReadCommandEventsRequest;
    try {
      request = ReadCommandEventsRequestSchema.parse(
        normalizeSafeJson(snapshotSafeJson(requestInput, 64 * 1_024))
      );
    } catch {
      throw createCommandRegistryError("invalid_request");
    }
    return new CommandSubscription(this, request);
  }

  async initializeSubscriber(request: ReadCommandEventsRequest): Promise<SubscriberState> {
    return await this.#subscriberLifecycleGate.run(
      "registry",
      async () =>
        await this.#gates.run(request.commandId, async () => {
          const entry = this.#requireEntry(request.commandId);
          if (!sameReadOwnership(request, entry))
            throw createCommandRegistryError("invalid_request");
          const snapshotHead = await entry.spool.head();
          this.#assertOpen();
          if (request.after > snapshotHead) throw createCommandRegistryError("cursor_invalid");
          if (
            entry.subscribers.size >= this.#maximumCommandSubscribers ||
            this.#subscriberCount >= this.#maximumSubscribers
          ) {
            throw createCommandRegistryError("capacity_exceeded");
          }
          const state: SubscriberState = {
            commandId: request.commandId,
            entry,
            cursor: request.after,
            snapshotHead,
            queue: [],
            queueBytes: 0,
            lagged: false,
            done: false
          };
          entry.subscribers.add(state);
          this.#subscriberCount += 1;
          return state;
        })
    );
  }

  async nextSubscriber(
    state: SubscriberState
  ): Promise<IteratorResult<ImmutableRunnerSubscriptionItem>> {
    try {
      if (state.idleTimer !== undefined) {
        clearTimeout(state.idleTimer);
        delete state.idleTimer;
      }
      for (;;) {
        const result = await this.#gates.run(state.commandId, async () => {
          if (state.done) return { kind: "done" as const };
          if (state.cursor < state.snapshotHead) {
            const frame = await state.entry.spool.readEvent(state.cursor + 1);
            if (frame === undefined) throw createCommandRegistryError("maintenance_required");
            state.cursor = frame.sequence;
            if (terminalFrame(frame)) {
              state.done = true;
              state.entry.subscribers.delete(state);
              this.#subscriberCount -= 1;
            }
            return { kind: "item" as const, frame };
          }
          if (state.lagged) {
            state.done = true;
            state.entry.subscribers.delete(state);
            this.#subscriberCount -= 1;
            return { kind: "lagged" as const, cursor: state.cursor };
          }
          const frame = state.queue.shift();
          if (frame !== undefined) {
            state.queueBytes -= Buffer.byteLength(
              JSON.stringify({ type: "runner.event", event: frame.event })
            );
            state.cursor = frame.sequence;
            if (terminalFrame(frame)) {
              state.done = true;
              state.entry.subscribers.delete(state);
              this.#subscriberCount -= 1;
            }
            return { kind: "item" as const, frame };
          }
          if (state.entry.terminal) {
            state.done = true;
            state.entry.subscribers.delete(state);
            this.#subscriberCount -= 1;
            return { kind: "done" as const };
          }
          return {
            kind: "wait" as const,
            wait: new Promise<void>((resolve) => {
              state.waiter = resolve;
            })
          };
        });
        if (result.kind === "done") return { done: true, value: undefined };
        if (result.kind === "item") {
          if (!state.done) this.#armSubscriberIdle(state);
          return { done: false, value: { type: "runner.event", event: result.frame.event } };
        }
        if (result.kind === "lagged") {
          return {
            done: false,
            value: {
              type: "subscription.lagged",
              lastDurableSequence: result.cursor,
              resumeCursor: result.cursor
            }
          };
        }
        this.#armSubscriberIdle(state);
        await result.wait;
      }
    } catch (error) {
      try {
        await this.closeSubscriber(state);
      } catch {
        // Preserve the original historical/gate failure.
      }
      throw error;
    }
  }

  async closeSubscriber(state: SubscriberState): Promise<void> {
    await this.#gates.run(state.commandId, async () => {
      if (closeCommandSubscriberState(state) && this.#subscriberCount > 0) {
        this.#subscriberCount -= 1;
      }
    });
  }

  async resolveOwnedArtifact(requestInput: ReadArtifactChunkRequest): Promise<ArtifactDescriptor> {
    let request: ReadArtifactChunkRequest;
    try {
      request = ReadArtifactChunkRequestSchema.parse(
        normalizeSafeJson(snapshotSafeJson(requestInput, 64 * 1_024))
      );
    } catch {
      throw createCommandRegistryError("invalid_request");
    }
    return await this.#gates.run(request.commandId, async () => {
      const entry = this.#requireEntry(request.commandId);
      if (!sameArtifactOwnership(request, entry))
        throw createCommandRegistryError("invalid_request");
      const recovered = await entry.spool.recover();
      if (
        recovered.phases.at(-1)?.phase !== "terminal" ||
        !hasConsistentTerminalEvidence(recovered)
      ) {
        throw createCommandRegistryError("command_not_found");
      }
      const artifactEvent = recovered.events.find(
        (frame) =>
          frame.event.type === "artifact.created" &&
          frame.event.artifact.artifactId === request.artifactId
      )?.event;
      if (artifactEvent?.type !== "artifact.created") {
        throw createCommandRegistryError("maintenance_required");
      }
      return artifactEvent.artifact;
    });
  }

  async prepareProtocolFailure(
    requestInput: ReadCommandEventsRequest,
    reason: "output_quarantined"
  ): Promise<CommandProtocolFailureRegistration> {
    let request: ReadCommandEventsRequest;
    try {
      request = ReadCommandEventsRequestSchema.parse(
        normalizeSafeJson(snapshotSafeJson(requestInput, 64 * 1_024))
      );
      if (reason !== "output_quarantined") throw new TypeError();
    } catch {
      throw createCommandRegistryError("invalid_request");
    }
    try {
      return await this.#gates.run(request.commandId, async () => {
        const entry = this.#requireEntry(request.commandId);
        if (!sameReadOwnership(request, entry)) throw createCommandRegistryError("invalid_request");
        const recovered = await entry.spool.recover();
        const highest = recovered.phases.at(-1)?.phase;
        const terminal = recovered.events.filter(terminalFrame);
        if (!hasConsistentTerminalEvidence(recovered)) {
          throw createCommandRegistryError("maintenance_required");
        }
        if (highest === "terminal") {
          const finalizing = recovered.phases.find((phase) => phase.phase === "finalizing");
          const finalEvent = recovered.events.at(-1)?.event;
          const finalizingEvidence =
            finalizing?.phase === "finalizing" ? finalizing.evidence : undefined;
          const finalizingCause =
            typeof finalizingEvidence === "object" &&
            finalizingEvidence !== null &&
            !Array.isArray(finalizingEvidence)
              ? (finalizingEvidence as Readonly<Record<string, unknown>>).cause
              : undefined;
          if (
            finalEvent?.type !== "stream.error" ||
            finalEvent.code !== "output_quarantined" ||
            finalizingCause !== "output_quarantined"
          ) {
            throw createCommandRegistryError("command_conflict");
          }
          entry.terminal = true;
          return Object.freeze({ commandId: request.commandId, replayed: true });
        }
        if (
          highest !== "running" ||
          terminal.length !== 0 ||
          recovered.events[0]?.event.type !== "command.started" ||
          recovered.events.some((frame) => frame.event.type === "artifact.created") ||
          entry.terminal ||
          entry.session === undefined
        ) {
          throw createCommandRegistryError("maintenance_required");
        }
        return Object.freeze({
          commandId: request.commandId,
          replayed: false,
          session: entry.session
        });
      });
    } catch (error) {
      if (isTrustedCommandRegistryError(error)) throw error;
      if (isReplaySpoolError(error)) {
        throw createCommandRegistryError("maintenance_required");
      }
      throw createCommandRegistryError("unsafe_state");
    }
  }

  async recordCancel(
    requestInput: CancelCommandRequest,
    decidedAt: string
  ): Promise<CommandCancelRegistration> {
    let request: CancelCommandRequest;
    try {
      request = CancelCommandRequestSchema.parse(
        normalizeSafeJson(snapshotSafeJson(requestInput, 64 * 1_024))
      );
      if (new Date(decidedAt).toISOString() !== decidedAt) throw new TypeError();
    } catch {
      throw createCommandRegistryError("invalid_request");
    }
    try {
      return await this.#gates.run(request.commandId, async () => {
        const entry = this.#requireEntry(request.commandId);
        if (!sameCancelOwnership(request, entry))
          throw createCommandRegistryError("invalid_request");
        const recovered = await entry.spool.recover();
        const terminalReceipt = recovered.phases.at(-1)?.phase === "terminal";
        const terminalEvent = recovered.events.some(terminalFrame);
        if (terminalReceipt !== terminalEvent)
          throw createCommandRegistryError("maintenance_required");
        const requestDigest = await digestVersionedValue(
          "autostack.cancel-command-request",
          request
        );
        const claim = recovered.cancel;
        if (claim !== undefined && claim.requestDigest !== requestDigest) {
          throw createCommandRegistryError("command_conflict");
        }
        if (terminalReceipt) {
          return Object.freeze({
            commandId: request.commandId,
            cancelled: claim?.cancelled ?? false,
            replayed: true
          });
        }
        if (entry.session === undefined) throw createCommandRegistryError("maintenance_required");
        const control = Object.freeze({
          type: "host.cancel" as const,
          reason: "user" as const,
          requestDigest,
          decidedAt: claim?.decidedAt ?? decidedAt
        });
        return Object.freeze({
          commandId: request.commandId,
          cancelled: recovered.cancelAck !== undefined,
          replayed: claim !== undefined,
          ...(claim === undefined || recovered.cancelAck === undefined
            ? { session: entry.session, control }
            : {})
        });
      });
    } catch (error) {
      if (isTrustedCommandRegistryError(error)) throw error;
      if (isReplaySpoolError(error) && error.code === "command_conflict") {
        throw createCommandRegistryError("command_conflict");
      }
      throw createCommandRegistryError("unsafe_state");
    }
  }

  async confirmCancel(requestInput: CancelCommandRequest): Promise<CommandCancelRegistration> {
    let request: CancelCommandRequest;
    try {
      request = CancelCommandRequestSchema.parse(
        normalizeSafeJson(snapshotSafeJson(requestInput, 64 * 1_024))
      );
    } catch {
      throw createCommandRegistryError("invalid_request");
    }
    return await this.#gates.run(request.commandId, async () => {
      const entry = this.#requireEntry(request.commandId);
      if (!sameCancelOwnership(request, entry)) throw createCommandRegistryError("invalid_request");
      const recovered = await entry.spool.recover();
      const requestDigest = await digestVersionedValue("autostack.cancel-command-request", request);
      if (recovered.cancel === undefined) {
        return Object.freeze({
          commandId: request.commandId,
          cancelled: false,
          replayed: recovered.phases.at(-1)?.phase === "terminal"
        });
      }
      if (recovered.cancel.requestDigest !== requestDigest) {
        throw createCommandRegistryError("command_conflict");
      }
      if (
        recovered.cancelAck === undefined ||
        recovered.cancelAck.claimDigest !== recovered.cancel.claimDigest ||
        recovered.cancelAck.commandId !== request.commandId
      ) {
        throw createCommandRegistryError("maintenance_required");
      }
      return Object.freeze({ commandId: request.commandId, cancelled: true, replayed: true });
    });
  }

  async recoverAll(): Promise<void> {
    this.#assertOpen();
    try {
      const preadmittedCapability = admitArtifactStoreRecoveryCapability(
        this.#artifactStore,
        this.#dataRoot
      );
      if (preadmittedCapability !== this.#artifactCapability) throw new TypeError();
      const paths = await DataPathPolicy.openExisting(this.#dataRoot);
      const artifactCapability = await admitArtifactStoreRecoveryRoot(
        this.#artifactStore,
        paths.root
      );
      if (artifactCapability !== this.#artifactCapability) throw new TypeError();
      const entries = (await paths.listExistingDirectory("commands", this.#maximumCommands)) ?? [];
      for (const entry of entries) {
        if (entry.type !== "directory") throw createCommandRegistryError("maintenance_required");
        const commandId = decodeCommandDirectory(entry.name);
        const commandEntries = await paths.listExistingDirectory(`commands/${entry.name}`, 5);
        if (commandEntries === undefined) throw createCommandRegistryError("maintenance_required");
        if (
          commandEntries.length === 1 &&
          commandEntries[0]?.type === "file" &&
          commandEntries[0].name === "guardian-lease.sqlite3"
        ) {
          const unusedLease = await acquireCommandGuardianLease(this.#dataRoot, commandId);
          unusedLease.close();
          continue;
        }
        if (await isExactUnusedScaffolding(paths, entry.name, commandEntries)) continue;
        const lease = await acquireCommandGuardianLease(this.#dataRoot, commandId);
        let spool: ReplaySpool;
        let recovered: RecoveredCommandSpool;
        try {
          await admitRecoveryPublications(paths, commandId, artifactCapability);
          spool = await ReplaySpool.openForRecovery({
            dataRoot: this.#dataRoot,
            commandId,
            lease
          });
          recovered = await recoverCommandUnderLease({
            dataRoot: this.#dataRoot,
            commandId,
            spool,
            artifactStore: this.#artifactStore,
            acquiredLease: lease
          });
        } finally {
          lease.close();
        }
        const highest = recovered.phases.at(-1)?.phase;
        if (!hasConsistentTerminalEvidence(recovered)) {
          throw createCommandRegistryError("maintenance_required");
        }
        this.#entries.set(commandId, {
          spool,
          terminal: highest === "terminal",
          subscribers: new Set()
        });
      }
    } catch (error) {
      if (isTrustedCommandRegistryError(error)) throw error;
      throw createCommandRegistryError("maintenance_required");
    }
  }
  receipt(commandId: CommandId): ReplaySpool["intent"] | undefined {
    return this.#entries.get(commandId)?.spool.intent;
  }

  async isReplayAttached(commandId: CommandId): Promise<boolean> {
    return await this.#gates.run(commandId, async () => {
      const entry = this.#requireEntry(commandId);
      if (entry.session !== undefined && !entry.terminal) return true;
      if (!entry.terminal) return false;
      return hasConsistentTerminalEvidence(await entry.spool.recover());
    });
  }

  async markSessionClosed(commandId: CommandId): Promise<void> {
    await this.#gates.run(commandId, async () => {
      const entry = this.#requireEntry(commandId);
      const recovered = await entry.spool.recover();
      if (
        recovered.phases.at(-1)?.phase !== "terminal" ||
        !hasConsistentTerminalEvidence(recovered)
      ) {
        throw createCommandRegistryError("maintenance_required");
      }
      delete entry.session;
      entry.terminal = true;
    });
  }
  activeSessions(): readonly Readonly<{ commandId: CommandId; session: GuardianHostSession }>[] {
    return Object.freeze(
      [...this.#entries.entries()].flatMap(([commandId, entry]) =>
        entry.session === undefined || entry.terminal
          ? []
          : [Object.freeze({ commandId, session: entry.session })]
      )
    );
  }
  async close(): Promise<void> {
    await this.#subscriberLifecycleGate.run("registry", async () => {
      if (this.#closed) return;
      this.#closed = true;
      for (const [commandId, entry] of this.#entries) {
        await this.#gates.run(commandId, async () => closeAllCommandSubscribers(entry.subscribers));
      }
      this.#subscriberCount = 0;
    });
  }
  #armSubscriberIdle(state: SubscriberState): void {
    armCommandSubscriberIdle(state, this.#subscriberIdleMs, () => {
      void this.closeSubscriber(state).catch(() => undefined);
    });
  }
  #requireEntry(commandId: CommandId): CommandEntry {
    const entry = this.#entries.get(commandId);
    if (entry === undefined) throw createCommandRegistryError("command_not_found");
    return entry;
  }
  #assertOpen(): void {
    if (this.#closed) throw createCommandRegistryError("closed");
  }
}
