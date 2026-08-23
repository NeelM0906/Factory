import { isAbsolute } from "node:path";

import {
  ArtifactIdSchema,
  CancelCommandRequestSchema,
  EnvironmentAuthorizationSchema,
  PreparedEnvironmentSchema,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  digestVersionedValue,
  assertResolvedCommandDoesNotUseShellCommandString,
  normalizeSafeJson,
  validateCommandAuthorizationAgainstEnvironment,
  type ArtifactDescriptor,
  type CancelCommandRequest,
  type CancelCommandResponse,
  type CommandAccepted,
  type CommandId,
  type ReadArtifactChunkRequest,
  type ReadCommandEventsRequest,
  type RunnerDrainResult,
  type StartCommandRequest
} from "@autostack/contracts";

import { isTrustedCommandActivityError, type ActiveCommandLease } from "./command-activity.js";
import type { GuardianCloseOutcome, GuardianHostSession } from "./command-guardian.js";
import { snapshotSafeJson } from "./command-guardian-bounds.js";
import { CommandRegistry } from "./command-registry.js";
import type { ImmutableRunnerSubscriptionItem } from "./replay-spool.js";
import {
  captureUnadmittedActiveCommandLease,
  captureUnadmittedGuardianHostSession,
  closeUnadmittedActiveCommandLease,
  samePreparedEnvironment,
  snapshotActiveCommandLease,
  snapshotGuardianHostSession,
  snapshotPreparedEnvironmentResult,
  validateCommandExecutorRequest
} from "./command-executor-admission.js";
import {
  createCommandExecutorError,
  mapCommandRegistryError,
  safeCommandTimestamp
} from "./command-executor-error.js";
import {
  snapshotCommandExecutorOptions,
  type AdmittedCommandExecutorOptions
} from "./command-executor-options.js";
import { digestSpawnEnvelope } from "./command-spawn-envelope.js";
import { commandMetadataContainsResolvedSecret } from "./command-sensitive-admission.js";
import {
  materializeCommandEnvironment,
  createCommandPrivateBaseEnvironment,
  pinCommandCwd,
  planCommandPrivateBaseEnvironment,
  snapshotCommandCredentials,
  snapshotGuardianSession,
  snapshotResolvedExecutable,
  validateTrustedBaseEnvironmentPaths,
  validateCommandEnvironmentNames
} from "./command-runtime-preparation.js";
import type { CommandExecutorOptions, GuardianBootstrap } from "./command-executor-types.js";
import { KeyedLock } from "./keyed-lock.js";
import { registerExecutorSupervisionControl } from "./command-executor-control.js";
import { CommandDependencyTracker, DEPENDENCY_TIMEOUT_MS } from "./command-dependency-tracker.js";
import {
  guardianLifecycleTimeout,
  settleLateGuardianLaunch,
  settleRegisteredGuardianLifecycle
} from "./command-executor-lifecycle.js";

interface ActiveRuntime {
  readonly session: GuardianHostSession;
  readonly lifecycle: Promise<GuardianCloseOutcome>;
}

const canonicalRequestDigest = async (request: StartCommandRequest): Promise<string> =>
  await digestVersionedValue("autostack.start-command-request", request);
const MAXIMUM_PENDING_STARTS = 256;
const MAXIMUM_ORPHANED_AUTHORITIES = 256;

/** Owns start/idempotency ordering and delegates all post-transfer PTY control to a guardian. */
export class CommandExecutor {
  readonly #options: AdmittedCommandExecutorOptions;
  readonly #registry: CommandRegistry;
  readonly #active = new Map<CommandId, ActiveRuntime>();
  readonly #orphanedActivityLeases = new Set<ActiveCommandLease>();
  readonly #orphanedGuardianSessions = new Set<GuardianHostSession>();
  readonly #pendingWaiters = new Set<() => void>();
  readonly #startingCommandIds = new Set<CommandId>();
  readonly #dependencies = new CommandDependencyTracker();
  readonly #commandGates = new KeyedLock();
  #pendingStarts = 0;
  #quiescePromise: Promise<void> | undefined;
  #admissionClosed = false;
  #closed = false;

  private constructor(options: AdmittedCommandExecutorOptions, registry: CommandRegistry) {
    this.#options = options;
    this.#registry = registry;
    registerExecutorSupervisionControl(this, {
      registry,
      dependencies: this.#dependencies,
      orphanedActivityLeases: this.#orphanedActivityLeases,
      orphanedGuardianSessions: this.#orphanedGuardianSessions
    });
  }
  static async create(optionsInput: CommandExecutorOptions): Promise<CommandExecutor> {
    const options = snapshotCommandExecutorOptions(optionsInput);
    try {
      await validateTrustedBaseEnvironmentPaths(options.dataRoot, options.trustedBaseEnvironment);
      const registry = await CommandRegistry.create({
        dataRoot: options.dataRoot,
        artifactStore: options.artifactStore,
        subscriberQueueFrames: options.limits.subscriberQueueFrames,
        subscriberQueueBytes: options.limits.subscriberQueueBytes
      });
      await registry.recoverAll();
      return new CommandExecutor(options, registry);
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }
  static async validateRequest(input: StartCommandRequest): Promise<StartCommandRequest> {
    return await validateCommandExecutorRequest(input);
  }
  async startCommand(requestInput: StartCommandRequest): Promise<CommandAccepted> {
    if (this.#closed || this.#admissionClosed) throw createCommandExecutorError("closed");
    if (
      this.#pendingStarts >= MAXIMUM_PENDING_STARTS ||
      this.#orphanedActivityLeases.size >= MAXIMUM_ORPHANED_AUTHORITIES ||
      this.#orphanedGuardianSessions.size >= MAXIMUM_ORPHANED_AUTHORITIES
    ) {
      throw createCommandExecutorError("execution_unavailable");
    }
    this.#pendingStarts += 1;
    try {
      return await this.#startAdmittedCommand(requestInput);
    } catch (error) {
      throw mapCommandRegistryError(error);
    } finally {
      this.#pendingStarts -= 1;
      if (this.#pendingStarts === 0) {
        for (const resolve of this.#pendingWaiters) resolve();
        this.#pendingWaiters.clear();
      }
    }
  }
  async #startAdmittedCommand(requestInput: StartCommandRequest): Promise<CommandAccepted> {
    const request = await CommandExecutor.validateRequest(requestInput);
    const requestDigest = await canonicalRequestDigest(request);
    return await this.#commandGates.run(
      request.commandId,
      async () => await this.#startSerializedCommand(request, requestDigest)
    );
  }
  async #startSerializedCommand(
    request: StartCommandRequest,
    requestDigest: string
  ): Promise<CommandAccepted> {
    const existing = this.#registry.receipt(request.commandId);
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        throw createCommandExecutorError("command_conflict");
      }
      if (
        !this.#startingCommandIds.has(request.commandId) &&
        !(await this.#registry.isReplayAttached(request.commandId))
      ) {
        throw createCommandExecutorError("maintenance_required");
      }
      return Object.freeze({
        commandId: existing.commandId,
        acceptedAt: existing.acceptedAt,
        replayed: true
      });
    }

    let activityLease: ActiveCommandLease | undefined;
    let launchedSession: GuardianHostSession | undefined;
    let durableIntentPublished = false;
    this.#startingCommandIds.add(request.commandId);
    try {
      const rawActivityLease = await this.#dependencies.wait(
        this.#options.activity.reserveCommand(request.environmentId, request.commandId),
        async (lateLease) =>
          await closeUnadmittedActiveCommandLease(
            lateLease,
            request.environmentId,
            request.commandId
          )
      );
      activityLease = captureUnadmittedActiveCommandLease(
        rawActivityLease,
        request.environmentId,
        request.commandId
      );
      snapshotActiveCommandLease(rawActivityLease, request.environmentId, request.commandId);
      const preparedCandidate = snapshotPreparedEnvironmentResult(
        await this.#dependencies.wait(
          this.#options.worktrees.resolvePreparedEnvironment(request.environmentId)
        )
      );
      if (
        typeof preparedCandidate.managedPath !== "string" ||
        typeof preparedCandidate.intentDigest !== "string"
      ) {
        throw createCommandExecutorError("environment_conflict");
      }
      const prepared = Object.freeze({
        environment: PreparedEnvironmentSchema.parse(
          normalizeSafeJson(preparedCandidate.environment)
        ),
        managedPath: preparedCandidate.managedPath,
        intentDigest: preparedCandidate.intentDigest
      });
      if (!isAbsolute(prepared.managedPath) || !samePreparedEnvironment(prepared, request)) {
        throw createCommandExecutorError("environment_conflict");
      }
      const environmentAuthorization = EnvironmentAuthorizationSchema.parse(
        normalizeSafeJson(prepared.environment.authorization)
      );
      if (
        environmentAuthorization.approvalEvidenceDigest !==
          (await digestExecutionScope(environmentAuthorization.scope)) ||
        environmentAuthorization.digest !==
          (await digestEnvironmentAuthorization(environmentAuthorization))
      ) {
        throw createCommandExecutorError("environment_conflict");
      }
      try {
        validateCommandAuthorizationAgainstEnvironment(
          request.authorization,
          environmentAuthorization
        );
      } catch {
        throw createCommandExecutorError("invalid_request");
      }
      const now = safeCommandTimestamp(this.#options.now);
      const nowMs = Date.parse(now);
      if (
        nowMs < Date.parse(environmentAuthorization.createdAt) ||
        nowMs >= Date.parse(environmentAuthorization.expiresAt) ||
        nowMs < Date.parse(request.authorization.createdAt) ||
        nowMs >= Date.parse(request.authorization.expiresAt) ||
        Date.parse(request.authorization.createdAt) <
          Date.parse(environmentAuthorization.createdAt) ||
        Date.parse(request.authorization.expiresAt) > Date.parse(environmentAuthorization.expiresAt)
      ) {
        throw createCommandExecutorError("authorization_stale");
      }
      const cwd = await pinCommandCwd(prepared.managedPath, request.command.cwd);
      const commandBaseEnvironment = planCommandPrivateBaseEnvironment(
        this.#options.dataRoot,
        request.commandId,
        this.#options.trustedBaseEnvironment
      );
      validateCommandEnvironmentNames(commandBaseEnvironment, request);
      const executable = snapshotResolvedExecutable(
        await this.#dependencies.wait(
          this.#options.executableResolver.resolve({
            executable: request.command.executable,
            cwd: cwd.canonicalPath,
            environment: Object.freeze([
              Object.freeze({ name: "PATH", value: this.#options.trustedBaseEnvironment[0]!.value })
            ])
          })
        )
      );
      const credentialRefIds = Object.freeze(
        [
          ...new Set(
            request.command.environment.flatMap((entry) =>
              entry.kind === "credential_ref" ? [entry.credentialRefId] : []
            )
          )
        ].sort()
      );
      let credentials: ReturnType<typeof snapshotCommandCredentials>;
      try {
        credentials = snapshotCommandCredentials(
          await this.#dependencies.wait(
            this.#options.resolveCredentials({
              workspaceId: request.workspaceId,
              runId: request.runId,
              environmentId: request.environmentId,
              commandId: request.commandId,
              credentialRefIds
            })
          ),
          credentialRefIds
        );
      } catch {
        throw createCommandExecutorError("missing_credential");
      }
      const environment = materializeCommandEnvironment(
        commandBaseEnvironment,
        request,
        credentials
      );
      try {
        assertResolvedCommandDoesNotUseShellCommandString(
          executable.canonicalPath,
          request.command.args
        );
      } catch {
        throw createCommandExecutorError("invalid_request");
      }
      const artifactId = ArtifactIdSchema.parse(
        normalizeSafeJson(this.#options.createArtifactId())
      );
      const guardianSession = snapshotGuardianSession(this.#options.createGuardianSession());
      if (
        !(await this.#dependencies.wait(cwd.revalidate())) ||
        !(await this.#dependencies.wait(executable.revalidate()))
      ) {
        throw createCommandExecutorError("environment_conflict");
      }
      const sensitiveValues: string[] = [];
      for (const entry of request.command.environment) {
        if (entry.kind !== "credential_ref") continue;
        const secret = credentials.get(entry.credentialRefId);
        if (secret === undefined) throw createCommandExecutorError("missing_credential");
        sensitiveValues.push(secret);
      }
      const envelope = Object.freeze({
        executable: executable.canonicalPath,
        args: Object.freeze(request.command.args.map((argument) => argument)),
        cwd: cwd.canonicalPath,
        environment,
        terminal: Object.freeze({ ...request.command.terminal })
      });
      const spawnEnvelopeDigest = digestSpawnEnvelope({
        request,
        envelope,
        executableIdentityDigest: executable.identityDigest,
        cwdIdentityDigest: cwd.identityDigest,
        sensitiveValues
      });
      const intent = {
        commandId: request.commandId,
        workspaceId: request.workspaceId,
        runId: request.runId,
        environmentId: request.environmentId,
        request,
        requestDigest,
        environmentIntentDigest: prepared.intentDigest,
        environmentAuthorizationId: environmentAuthorization.id,
        environmentAuthorizationDigest: environmentAuthorization.digest,
        environmentAuthorization,
        commandAuthorizationId: request.authorization.id,
        commandAuthorizationDigest: request.authorization.digest,
        acceptedAt: now,
        executablePath: executable.canonicalPath,
        executableIdentityDigest: executable.identityDigest,
        cwdRelativePath: cwd.relativePath,
        cwdIdentityDigest: cwd.identityDigest,
        spawnEnvelopeDigest,
        transcriptArtifactId: artifactId,
        artifactCreatedAt: now,
        guardianSessionBindingDigest: guardianSession.bindingDigest,
        limits: {
          eventBytes: this.#options.limits.eventBytes,
          replayBytes: this.#options.limits.replayBytes,
          transcriptBytes: Math.min(
            this.#options.limits.transcriptBytes,
            this.#options.limits.artifactBytes
          ),
          cancellationGraceMs: this.#options.limits.cancellationGraceMs,
          eofSettleMs: this.#options.limits.eofSettleMs
        }
      };
      if (commandMetadataContainsResolvedSecret({ request, intent, envelope, sensitiveValues })) {
        throw createCommandExecutorError("invalid_request");
      }
      const registration = await this.#registry.registerIntent(intent);
      if (registration.replayed) {
        await activityLease.close();
        activityLease = undefined;
        this.#startingCommandIds.delete(request.commandId);
        return Object.freeze({
          commandId: registration.receipt.commandId,
          acceptedAt: now,
          replayed: true
        });
      }
      durableIntentPublished = true;
      await createCommandPrivateBaseEnvironment(
        this.#options.dataRoot,
        request.commandId,
        this.#options.trustedBaseEnvironment
      );
      const bootstrap: GuardianBootstrap = Object.freeze({
        dataRoot: this.#options.dataRoot,
        commandId: request.commandId,
        intentRelativePath: registration.intentRelativePath,
        envelope,
        sensitiveValues: Object.freeze(sensitiveValues),
        timeoutMs: request.command.timeoutSeconds * 1_000,
        cancellationGraceMs: this.#options.limits.cancellationGraceMs,
        eofSettleMs: this.#options.limits.eofSettleMs,
        executableIdentityDigest: executable.identityDigest,
        cwdIdentityDigest: cwd.identityDigest,
        session: guardianSession
      });
      const launchActivityLease = activityLease;
      const rawSession = await this.#dependencies.wait(
        this.#options.guardianLauncher.launch(bootstrap, {
          onDurableFrame: async (frame) =>
            await this.#registry.observeDurableFrame(request.commandId, frame)
        }),
        async (lateSession) => {
          await settleLateGuardianLaunch({
            commandId: request.commandId,
            lateSession,
            lease: launchActivityLease,
            dependencies: this.#dependencies,
            timeoutMs: guardianLifecycleTimeout(bootstrap.timeoutMs, bootstrap.cancellationGraceMs),
            registry: this.#registry,
            retainedLeases: this.#orphanedActivityLeases,
            retainedSessions: this.#orphanedGuardianSessions
          });
        },
        Math.max(DEPENDENCY_TIMEOUT_MS, Math.min(bootstrap.timeoutMs, 10_000))
      );
      launchedSession = captureUnadmittedGuardianHostSession(rawSession);
      const session = snapshotGuardianHostSession(rawSession, request.commandId);
      launchedSession = session;
      await this.#registry.attachSession(request.commandId, session);
      const lease = activityLease;
      activityLease = undefined;
      const lifecycle = settleRegisteredGuardianLifecycle({
        commandId: request.commandId,
        session,
        lease,
        dependencies: this.#dependencies,
        timeoutMs: guardianLifecycleTimeout(bootstrap.timeoutMs, bootstrap.cancellationGraceMs),
        registry: this.#registry,
        onClosed: () => this.#active.delete(request.commandId)
      });
      void lifecycle.catch(() => undefined);
      this.#active.set(request.commandId, { session, lifecycle });
      this.#startingCommandIds.delete(request.commandId);
      return Object.freeze({
        commandId: registration.receipt.commandId,
        acceptedAt: registration.receipt.acceptedAt,
        replayed: false
      });
    } catch (error) {
      this.#startingCommandIds.delete(request.commandId);
      if (activityLease !== undefined) {
        if (durableIntentPublished) {
          if (launchedSession !== undefined) {
            this.#orphanedGuardianSessions.add(launchedSession);
            void launchedSession.disconnect().catch(() => undefined);
          }
          this.#orphanedActivityLeases.add(activityLease);
          activityLease = undefined;
          throw createCommandExecutorError("maintenance_required");
        }
        try {
          await this.#dependencies.wait(activityLease.close());
        } catch {
          throw createCommandExecutorError("unsafe_state");
        }
      }
      if (isTrustedCommandActivityError(error) && error.code === "environment_active") {
        throw createCommandExecutorError("active_command");
      }
      throw mapCommandRegistryError(error);
    }
  }

  readCommandEvents(
    request: ReadCommandEventsRequest
  ): AsyncIterable<ImmutableRunnerSubscriptionItem> {
    if (this.#closed) throw createCommandExecutorError("closed");
    try {
      const iterator = this.#registry.subscribe(request)[Symbol.asyncIterator]();
      const rematerialized: AsyncIterator<ImmutableRunnerSubscriptionItem> &
        AsyncIterable<ImmutableRunnerSubscriptionItem> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          try {
            return await iterator.next();
          } catch (error) {
            throw mapCommandRegistryError(error);
          }
        },
        async return() {
          try {
            return iterator.return === undefined
              ? { done: true, value: undefined }
              : await iterator.return();
          } catch (error) {
            throw mapCommandRegistryError(error);
          }
        }
      };
      return Object.freeze(rematerialized);
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }

  async cancelCommand(requestInput: CancelCommandRequest): Promise<CancelCommandResponse> {
    if (this.#closed) throw createCommandExecutorError("closed");
    let request: CancelCommandRequest;
    try {
      request = CancelCommandRequestSchema.parse(
        normalizeSafeJson(snapshotSafeJson(requestInput, 64 * 1_024))
      );
    } catch {
      throw createCommandExecutorError("invalid_request");
    }
    try {
      return await this.#commandGates.run(
        request.commandId,
        async () => await this.#cancelSerialized(request)
      );
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }

  async #cancelSerialized(request: CancelCommandRequest): Promise<CancelCommandResponse> {
    try {
      const decision = await this.#registry.recordCancel(
        request,
        safeCommandTimestamp(this.#options.now)
      );
      if (decision.session !== undefined && decision.control !== undefined) {
        try {
          await this.#dependencies.wait(decision.session.send(decision.control), undefined, 10_000);
        } catch {
          try {
            await this.#dependencies.wait(decision.session.disconnect());
          } catch {
            // Local interruption was attempted; durable guardian state remains authoritative.
          }
          throw createCommandExecutorError("maintenance_required");
        }
      }
      const confirmed = await this.#registry.confirmCancel(request);
      return Object.freeze({
        commandId: confirmed.commandId,
        cancelled: confirmed.cancelled,
        replayed: decision.replayed
      });
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }

  async resolveOwnedArtifact(request: ReadArtifactChunkRequest): Promise<ArtifactDescriptor> {
    if (this.#closed) throw createCommandExecutorError("closed");
    try {
      return await this.#registry.resolveOwnedArtifact(request);
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }

  async terminalizeProtocolFailure(
    request: ReadCommandEventsRequest,
    reason: "output_quarantined"
  ): Promise<Readonly<{ commandId: CommandId; replayed: boolean }>> {
    if (this.#closed) throw createCommandExecutorError("closed");
    try {
      const decision = await this.#registry.prepareProtocolFailure(request, reason);
      if (decision.session !== undefined) {
        try {
          await this.#dependencies.wait(
            decision.session.send({ type: "host.protocol_failure", reason }),
            undefined,
            10_000
          );
        } catch {
          try {
            await this.#dependencies.wait(decision.session.disconnect());
          } catch {
            // The guardian remains the durable supervision authority.
          }
          throw createCommandExecutorError("maintenance_required");
        }
        const outcome = await this.#dependencies.wait(decision.session.closed, undefined, 10_000);
        if (outcome.terminalFrame === undefined) {
          throw createCommandExecutorError("maintenance_required");
        }
      }
      const confirmed = await this.#registry.prepareProtocolFailure(request, reason);
      if (!confirmed.replayed) throw createCommandExecutorError("maintenance_required");
      return Object.freeze({
        commandId: confirmed.commandId,
        replayed: decision.replayed
      });
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }

  async quiesce(): Promise<void> {
    try {
      this.#quiescePromise ??= this.#performQuiesce();
      await this.#quiescePromise;
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }

  async #performQuiesce(): Promise<void> {
    this.#admissionClosed = true;
    try {
      this.#options.activity.closeAdmission();
    } catch {
      throw createCommandExecutorError("unsafe_state");
    }
    if (this.#pendingStarts > 0) {
      await new Promise<void>((resolve) => this.#pendingWaiters.add(resolve));
    }
    if (this.#dependencies.unsettledCount > 0) {
      throw createCommandExecutorError("maintenance_required");
    }
  }

  async interruptAndDrain(): Promise<RunnerDrainResult> {
    try {
      return await this.#performInterruptAndDrain();
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }

  async #performInterruptAndDrain(): Promise<RunnerDrainResult> {
    await this.quiesce();
    const active = [...this.#active.entries()];
    const orphaned = [...this.#orphanedGuardianSessions];
    await Promise.all(
      [...active.map(([, { session }]) => session), ...orphaned].map(async (session) => {
        try {
          await this.#dependencies.wait(
            session.send({ type: "host.interrupt" }),
            undefined,
            10_000
          );
        } catch {
          try {
            await this.#dependencies.wait(session.disconnect());
          } catch {
            // Sticky supervision state is reported below.
          }
        }
      })
    );
    const outcomes = await Promise.all(active.map(([, { lifecycle }]) => lifecycle));
    if (
      this.#pendingStarts !== 0 ||
      this.#active.size !== 0 ||
      this.#orphanedActivityLeases.size !== 0 ||
      this.#orphanedGuardianSessions.size !== 0 ||
      this.#dependencies.unsettledCount !== 0 ||
      outcomes.some((outcome) => !outcome.releasedLease)
    ) {
      throw createCommandExecutorError("maintenance_required");
    }
    return Object.freeze({
      interruptedCommandIds: active.map(([commandId]) => commandId),
      releasedGuardianLeaseCount: outcomes.length,
      remainingGuardianLeaseCount: 0 as const
    });
  }

  async close(): Promise<void> {
    try {
      if (this.#closed) return;
      await this.quiesce();
      await this.interruptAndDrain();
      await this.#registry.close();
      this.#closed = true;
    } catch (error) {
      throw mapCommandRegistryError(error);
    }
  }
}
