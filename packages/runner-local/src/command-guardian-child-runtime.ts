import { createHash, randomBytes } from "node:crypto";

import type { ArtifactStore } from "./artifact-store.js";
import { GUARDIAN_INTERNAL_PROTOCOL_FAILURE } from "./command-guardian.js";
import { CommandGuardian } from "./command-guardian-launch.js";
import {
  GuardianSupervisionError,
  isGuardianSupervisionError,
  type GuardianCloseOutcome,
  type GuardianHostSession
} from "./command-guardian-types.js";
import {
  MAXIMUM_PENDING_PROTOCOL_MESSAGES,
  captureGuardianMethod,
  runAbortableGuardianOperation,
  settleBounded,
  snapshotBytes,
  snapshotDataRecord,
  snapshotSafeJson
} from "./command-guardian-bounds.js";
import { parseHostPayload } from "./command-guardian-protocol-codec.js";
import type {
  AdmittedGuardianChildProtocolOptions,
  GuardianChildRuntimeOptions,
  GuardianToHostPayload
} from "./command-guardian-protocol-types.js";
import { acquireCommandGuardianLease, type CommandGuardianLease } from "./data-root-lock.js";
import type { GuardianBootstrap } from "./command-executor-types.js";
import {
  MAXIMUM_GUARDIAN_ENVELOPE_BYTES,
  sealGuardianEnvelope,
  verifyGuardianEnvelope,
  type GuardianAuthenticatedEnvelope
} from "./pty.js";
import { ReplaySpool } from "./replay-spool.js";
import { snapshotGuardianBootstrap } from "./command-spawn-envelope.js";
import { admitGuardianCloseOutcome } from "./command-executor-admission.js";
import {
  registerCommandGuardianChildRuntime,
  type CommandGuardianChildRetentionAudit
} from "./command-guardian-child-control.js";

/** Process-side authenticated protocol state machine used by fake IPC and the Task 9 child entry. */
export class CommandGuardianProtocolRuntime {
  #options: AdmittedGuardianChildProtocolOptions;
  readonly #commandId: GuardianBootstrap["commandId"];
  readonly #retentionAudit: CommandGuardianChildRetentionAudit = {
    transientCleared: false,
    guardianCleared: false
  };
  readonly #closedResolve: (outcome: GuardianCloseOutcome) => void;
  readonly #closedReject: (error: GuardianSupervisionError) => void;
  #nonce: string;
  #nonceDigest: string;
  readonly closed: Promise<GuardianCloseOutcome>;
  #lease: CommandGuardianLease | undefined;
  #guardian: GuardianHostSession | undefined;
  #startingGuardian: Promise<GuardianHostSession> | undefined;
  #hostSequence = 0;
  #guardianSequence = 0;
  #transferred = false;
  #failed = false;
  #receiveTail: Promise<void> = Promise.resolve();
  #sendTail: Promise<void> = Promise.resolve();
  #pendingReceives = 0;
  #disconnectRequested = false;
  #sentEventSequence = 0;
  #lastEventAck = 0;
  #protocolFailureDuringStart = false;
  #protocolFailureTerminalizing = false;
  #protocolFailureNotificationBarrier: Promise<void> | undefined;
  #releaseProtocolFailureNotification: (() => void) | undefined;
  readonly #unsettledTransport = new Set<Promise<void>>();
  #transportHeartbeat: ReturnType<typeof setInterval> | undefined;

  private constructor(options: AdmittedGuardianChildProtocolOptions, nonce: string) {
    this.#options = options;
    this.#commandId = options.commandId;
    this.#nonce = nonce;
    this.#nonceDigest = createHash("sha256").update(nonce, "utf8").digest("hex");
    let resolveClosed!: (outcome: GuardianCloseOutcome) => void;
    let rejectClosed!: (error: GuardianSupervisionError) => void;
    this.closed = new Promise((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    void this.closed.catch(() => undefined);
    this.#closedResolve = resolveClosed;
    this.#closedReject = rejectClosed;
    registerCommandGuardianChildRuntime(this, this.#retentionAudit);
  }

  static async bootstrap(
    options: GuardianChildRuntimeOptions
  ): Promise<CommandGuardianProtocolRuntime> {
    let nonceBytes: Uint8Array;
    let admitted: AdmittedGuardianChildProtocolOptions;
    try {
      const candidate = snapshotDataRecord(options, 8);
      const bootstrap = snapshotGuardianBootstrap(candidate.bootstrap as GuardianBootstrap);
      const spawnAuthority = candidate.spawnAuthority;
      const spawnBound = captureGuardianMethod(spawnAuthority, "spawnBound")!;
      const now = captureGuardianMethod(candidate, "now")!;
      const monotonicNowMs = captureGuardianMethod(candidate, "monotonicNowMs")!;
      const send = captureGuardianMethod(candidate, "send")!;
      const createNonce = captureGuardianMethod(candidate, "createNonce", true);
      const spool = await ReplaySpool.open({
        dataRoot: bootstrap.dataRoot,
        commandId: bootstrap.commandId
      });
      const expectedIntentRelativePath = `commands/${Buffer.from(bootstrap.commandId).toString("hex")}/receipt/01-intent.json`;
      if (bootstrap.intentRelativePath !== expectedIntentRelativePath) throw new TypeError();
      const source = createNonce ?? (() => randomBytes(32));
      nonceBytes = snapshotBytes(Reflect.apply(source, undefined, []) as unknown, {
        maximumBytes: 32,
        exactBytes: 32
      });
      if (
        bootstrap.session.bindingDigest !== spool.intent.guardianSessionBindingDigest ||
        spool.intent.commandId !== bootstrap.commandId
      ) {
        throw new TypeError();
      }
      admitted = Object.freeze({
        dataRoot: bootstrap.dataRoot,
        commandId: bootstrap.commandId,
        spool,
        artifactStore: candidate.artifactStore as ArtifactStore,
        spawnAuthority: Object.freeze({ spawnBound: spawnBound as never }),
        envelope: bootstrap.envelope,
        sensitiveValues: bootstrap.sensitiveValues,
        timeoutMs: bootstrap.timeoutMs,
        cancellationGraceMs: bootstrap.cancellationGraceMs,
        eofSettleMs: bootstrap.eofSettleMs,
        now: now as never,
        monotonicNowMs: monotonicNowMs as never,
        session: bootstrap.session,
        send: send as never,
        ...(createNonce === undefined ? {} : { createNonce: createNonce as never })
      });
    } catch {
      throw new TypeError("Guardian bootstrap is invalid.");
    }
    const runtime = new CommandGuardianProtocolRuntime(
      admitted,
      Buffer.from(nonceBytes).toString("hex")
    );
    try {
      await runtime.#initialize();
      return runtime;
    } catch (error) {
      runtime.#forgetTransientState();
      throw error;
    }
  }

  receive(envelope: GuardianAuthenticatedEnvelope<unknown>): Promise<void> {
    if (++this.#pendingReceives > MAXIMUM_PENDING_PROTOCOL_MESSAGES) {
      this.#pendingReceives -= 1;
      void this.#failProtocol();
      return Promise.reject(new TypeError("Guardian protocol is saturated."));
    }
    let snapshot: GuardianAuthenticatedEnvelope<unknown>;
    let payload: ReturnType<typeof parseHostPayload>;
    try {
      snapshot = snapshotSafeJson(
        envelope,
        MAXIMUM_GUARDIAN_ENVELOPE_BYTES
      ) as unknown as GuardianAuthenticatedEnvelope<unknown>;
      if (this.#failed) throw new TypeError();
      payload = parseHostPayload(
        verifyGuardianEnvelope({
          envelope: snapshot,
          secret: this.#options.session.secret,
          sessionId: this.#options.session.sessionId,
          direction: "host_to_guardian",
          expectedSequence: this.#hostSequence + 1
        })
      );
      this.#hostSequence += 1;
      if (this.#transferred && payload.type === "host.event_ack") {
        if (
          payload.sequence !== this.#lastEventAck + 1 ||
          payload.sequence > this.#sentEventSequence
        ) {
          throw new TypeError();
        }
        this.#lastEventAck = payload.sequence;
        this.#pendingReceives -= 1;
        return Promise.resolve();
      }
    } catch {
      this.#pendingReceives -= 1;
      void this.#failProtocol();
      return Promise.reject(new TypeError("Guardian protocol failed."));
    }
    const operation = this.#receiveTail.then(async () => await this.#receive(payload));
    this.#receiveTail = operation.catch(() => undefined);
    return operation.finally(() => {
      this.#pendingReceives -= 1;
    });
  }

  async disconnect(): Promise<void> {
    this.#disconnectRequested = true;
    if (this.#guardian !== undefined) {
      await this.#guardian.disconnect();
      return;
    }
    if (this.#startingGuardian !== undefined) {
      try {
        const guardian = await this.#startingGuardian;
        await guardian.disconnect();
      } catch {
        if (!this.#failed) {
          this.#failed = true;
          this.#closedReject(new GuardianSupervisionError("maintenance_required"));
          this.#forgetTransientState();
        }
      }
      return;
    }
    if (this.#releaseBeforeTransfer()) await this.#settleBeforeTransfer();
  }

  async #initialize(): Promise<void> {
    try {
      await this.#send({
        type: "guardian.hello",
        commandId: this.#options.commandId,
        bindingDigest: this.#options.session.bindingDigest,
        nonce: this.#nonce
      });
      this.#lease = await acquireCommandGuardianLease(
        this.#options.dataRoot,
        this.#options.commandId
      );
      await this.#send({
        type: "guardian.lease_acquired",
        commandId: this.#options.commandId,
        bindingDigest: this.#options.session.bindingDigest,
        nonceDigest: this.#nonceDigest,
        receiptDigest: this.#options.spool.intent.receiptDigest
      });
    } catch {
      this.#lease?.close();
      this.#lease = undefined;
      throw new TypeError("Guardian bootstrap failed.");
    }
  }

  async #receive(payload: ReturnType<typeof parseHostPayload>): Promise<void> {
    if (this.#failed) throw new TypeError("Guardian protocol failed.");
    try {
      if (!this.#transferred) {
        if (
          payload.type !== "host.lease_transfer" ||
          payload.bindingDigest !== this.#options.session.bindingDigest ||
          payload.receiptDigest !== this.#options.spool.intent.receiptDigest ||
          this.#lease === undefined
        ) {
          throw new TypeError();
        }
        await this.#transferAndStart();
        return;
      }
      if (payload.type === "host.lease_transfer") throw new TypeError();
      if (payload.type === "host.event_ack") {
        throw new TypeError();
      }
      if (this.#guardian === undefined) throw new TypeError();
      if (payload.type === "host.protocol_failure" && payload.reason === "protocol_failure") {
        const internal = this.#guardian as GuardianHostSession & {
          [GUARDIAN_INTERNAL_PROTOCOL_FAILURE](): Promise<void>;
        };
        await internal[GUARDIAN_INTERNAL_PROTOCOL_FAILURE]();
        return;
      }
      await this.#guardian.send(payload);
    } catch {
      await this.#failProtocol();
      throw new TypeError("Guardian protocol failed.");
    }
  }

  async #transferAndStart(): Promise<void> {
    const lease = this.#lease!;
    this.#lease = undefined;
    this.#transferred = true;
    try {
      const starting = CommandGuardian.launch({
        dataRoot: this.#options.dataRoot,
        spool: this.#options.spool,
        artifactStore: this.#options.artifactStore,
        spawnAuthority: this.#options.spawnAuthority,
        envelope: this.#options.envelope,
        sensitiveValues: this.#options.sensitiveValues,
        timeoutMs: this.#options.timeoutMs,
        cancellationGraceMs: this.#options.cancellationGraceMs,
        eofSettleMs: this.#options.eofSettleMs,
        now: this.#options.now,
        monotonicNowMs: this.#options.monotonicNowMs,
        acquiredLease: lease,
        guardianNonceDigest: this.#nonceDigest,
        observer: {
          onDurableFrame: async (frame) => {
            try {
              if (frame.sequence !== this.#sentEventSequence + 1) throw new TypeError();
              this.#sentEventSequence = frame.sequence;
              await this.#send({ type: "guardian.event_committed", frame });
            } catch {
              this.#onOutboundFailure();
            }
          },
          onDurablePhase: async (phase, receiptDigest) => {
            try {
              await this.#send({ type: "guardian.phase", phase, receiptDigest });
            } catch {
              this.#onOutboundFailure();
            }
          },
          onCancelAck: async (requestDigest, claimDigest, ackDigest) => {
            try {
              await this.#send({
                type: "guardian.cancel_ack",
                requestDigest,
                claimDigest,
                ackDigest
              });
            } catch {
              this.#onOutboundFailure();
              throw new TypeError();
            }
          }
        }
      });
      this.#startingGuardian = starting;
      this.#guardian = await starting;
      this.#startingGuardian = undefined;
      if (this.#protocolFailureDuringStart) await this.#terminalizeOutboundFailure();
      if (this.#disconnectRequested) await this.#guardian.disconnect();
    } catch {
      this.#startingGuardian = undefined;
      if (!this.#failed) {
        this.#failed = true;
        this.#closedReject(new GuardianSupervisionError("maintenance_required"));
        this.#forgetTransientState();
      }
      throw new TypeError();
    }
    void this.#guardian.closed.then(
      async (outcome) => {
        try {
          const admittedOutcome = admitGuardianCloseOutcome(outcome, this.#commandId);
          await this.#protocolFailureNotificationBarrier;
          if (admittedOutcome.terminalFrame !== undefined) {
            await this.#send({
              type: "guardian.terminal",
              commandId: admittedOutcome.commandId,
              terminalFrame: admittedOutcome.terminalFrame,
              releasedLease: admittedOutcome.releasedLease
            });
          }
          this.#forgetTransientState();
          this.#closedResolve(admittedOutcome);
        } catch {
          // Terminal durability is authoritative even when the parent channel has disappeared.
          this.#forgetTransientState();
          this.#closedReject(new GuardianSupervisionError("unsafe_state"));
        }
      },
      (error: unknown) => {
        this.#forgetTransientState();
        this.#closedReject(
          isGuardianSupervisionError(error) ? error : new GuardianSupervisionError("unsafe_state")
        );
      }
    );
  }

  async #failProtocol(): Promise<void> {
    if (this.#failed) return;
    this.#failed = true;
    this.#disconnectRequested = true;
    this.#protocolFailureNotificationBarrier = new Promise<void>((resolve) => {
      this.#releaseProtocolFailureNotification = resolve;
    });
    if (this.#startingGuardian !== undefined) {
      try {
        this.#guardian = await this.#startingGuardian;
      } catch {
        this.#closedReject(new GuardianSupervisionError("maintenance_required"));
        this.#forgetTransientState();
      } finally {
        this.#startingGuardian = undefined;
      }
    }
    if (this.#guardian !== undefined) {
      try {
        const internal = this.#guardian as GuardianHostSession & {
          [GUARDIAN_INTERNAL_PROTOCOL_FAILURE](): Promise<void>;
        };
        await internal[GUARDIAN_INTERNAL_PROTOCOL_FAILURE]();
      } catch {
        // The guardian retains authority when cleanup cannot be proven.
      }
    } else if (this.#releaseBeforeTransfer()) {
      await this.#settleBeforeTransfer();
    }
    try {
      const notification = this.#send({
        type: "guardian.protocol_failure",
        code: "protocol_failure"
      });
      void notification.catch(() => undefined);
      try {
        await settleBounded(notification);
      } catch {
        // Local cleanup is authoritative when the peer is unavailable.
      }
    } finally {
      this.#releaseProtocolFailureNotification?.();
      this.#releaseProtocolFailureNotification = undefined;
    }
  }

  #onOutboundFailure(): void {
    this.#protocolFailureDuringStart = true;
    if (this.#guardian !== undefined && !this.#protocolFailureTerminalizing) {
      void this.#terminalizeOutboundFailure().catch(() => undefined);
    }
  }

  async #terminalizeOutboundFailure(): Promise<void> {
    if (this.#guardian === undefined || this.#protocolFailureTerminalizing) return;
    this.#protocolFailureTerminalizing = true;
    const internal = this.#guardian as GuardianHostSession & {
      [GUARDIAN_INTERNAL_PROTOCOL_FAILURE](): Promise<void>;
    };
    await internal[GUARDIAN_INTERNAL_PROTOCOL_FAILURE]();
  }

  async #settleBeforeTransfer(): Promise<void> {
    const outcome = Object.freeze({
      commandId: this.#commandId,
      releasedLease: true as const
    });
    try {
      await this.#send({
        type: "guardian.released",
        commandId: this.#options.commandId,
        releasedLease: true
      });
    } catch {
      // The exact lease was released even when the notification channel is gone.
    } finally {
      this.#forgetTransientState();
      this.#closedResolve(outcome);
    }
  }

  #releaseBeforeTransfer(): boolean {
    if (this.#lease === undefined) return false;
    try {
      this.#lease.close();
      this.#lease = undefined;
      return true;
    } catch {
      this.#failed = true;
      this.#closedReject(new GuardianSupervisionError("maintenance_required"));
      this.#forgetTransientState();
      return false;
    }
  }

  async #send(payload: GuardianToHostPayload): Promise<void> {
    const sending = this.#sendTail.then(async () => {
      const envelope = sealGuardianEnvelope({
        sessionId: this.#options.session.sessionId,
        secret: this.#options.session.secret,
        direction: "guardian_to_host",
        sequence: ++this.#guardianSequence,
        payload
      });
      const outcome = await runAbortableGuardianOperation(
        (signal) => this.#options.send(envelope, signal),
        Math.max(2_000, Math.min(this.#options.timeoutMs, 10_000))
      );
      if (outcome.status === "timed_out") this.#retainUnsettledTransport(outcome.settled);
      if (outcome.status !== "completed") throw new TypeError();
    });
    this.#sendTail = sending.catch(() => undefined);
    await sending;
  }

  #retainUnsettledTransport(settled: Promise<void>): void {
    this.#unsettledTransport.add(settled);
    this.#transportHeartbeat ??= setInterval(() => undefined, 1_000);
    this.#transportHeartbeat.ref();
    void settled.finally(() => {
      this.#unsettledTransport.delete(settled);
      if (this.#unsettledTransport.size === 0 && this.#transportHeartbeat !== undefined) {
        clearInterval(this.#transportHeartbeat);
        this.#transportHeartbeat = undefined;
      }
    });
  }

  #forgetTransientState(): void {
    if (this.#retentionAudit.transientCleared) return;
    this.#options.session.secret.fill(0);
    this.#guardian = undefined;
    this.#startingGuardian = undefined;
    this.#nonce = "";
    this.#nonceDigest = "";
    this.#options = undefined as never;
    this.#retentionAudit.transientCleared = true;
    this.#retentionAudit.guardianCleared = true;
  }
}
