import {
  ReadArtifactChunkResponseSchema,
  RunnerCapabilitiesSchema,
  type ArtifactDescriptor,
  type CancelCommandRequest,
  type CancelCommandResponse,
  type CommandAccepted,
  type CommandId,
  type DisposeEnvironmentRequest,
  type DisposeEnvironmentResponse,
  type InspectRepositoryRequest,
  type PreparedEnvironment,
  type PrepareEnvironmentRequest,
  type ReadArtifactChunkRequest,
  type ReadArtifactChunkResponse,
  type ReadCommandEventsRequest,
  type RepositoryInspection,
  type RunnerCapabilities,
  type RunnerDrainResult,
  type RunnerSubscriptionItem,
  type StartCommandRequest
} from "@autostack/contracts";
import type {
  LocalRunnerLifecycle,
  RunnerProvider
} from "../../domain/src/ports/runner-provider.js";

import { ArtifactStore, type ArtifactReadResult } from "./artifact-store.js";
import { CommandActivityCoordinator } from "./command-activity.js";
import { CommandExecutor } from "./command-executor.js";
import { GitClient } from "./git-client.js";
import {
  assertAuthorizationCurrent,
  parseArtifactRequest,
  parsePrepareRequest,
  parseStartRequest,
  rematerializeProviderError,
  snapshotProviderOptions,
  type LocalRunnerProviderOptions
} from "./local-runner-provider-admission.js";
import {
  LocalRunnerProviderError,
  type LocalRunnerProviderErrorCode
} from "./local-runner-provider-error.js";
import { DataPathPolicy } from "./path-policy.js";
import { WorktreeManager } from "./worktree-manager.js";

interface WorktreePort {
  prepareEnvironment(request: PrepareEnvironmentRequest): Promise<PreparedEnvironment>;
  listEnvironments(): Promise<readonly PreparedEnvironment[]>;
  disposeEnvironment(request: DisposeEnvironmentRequest): Promise<DisposeEnvironmentResponse>;
  resumePendingDisposals(): Promise<void>;
  close(): Promise<void>;
}

interface InspectorPort {
  inspectRepository(
    request: InspectRepositoryRequest
  ): Promise<{ inspection: RepositoryInspection }>;
}

interface ExecutorPort {
  startCommand(request: StartCommandRequest): Promise<CommandAccepted>;
  readCommandEvents(request: ReadCommandEventsRequest): AsyncIterable<RunnerSubscriptionItem>;
  cancelCommand(request: CancelCommandRequest): Promise<CancelCommandResponse>;
  resolveOwnedArtifact(request: ReadArtifactChunkRequest): Promise<ArtifactDescriptor>;
  terminalizeProtocolFailure(
    request: ReadCommandEventsRequest,
    reason: "output_quarantined"
  ): Promise<Readonly<{ commandId: CommandId; replayed: boolean }>>;
  quiesce(): Promise<void>;
  interruptAndDrain(): Promise<RunnerDrainResult>;
  close(): Promise<void>;
}

interface ArtifactPort {
  readArtifact(
    artifactId: ReadArtifactChunkRequest["artifactId"],
    range: Readonly<{ offset: number; length: number }>
  ): Promise<ArtifactReadResult>;
}

interface ProviderLimits {
  readonly eventBytes: number;
  readonly replayBytes: number;
  readonly transcriptBytes: number;
  readonly artifactBytes: number;
}

export interface LocalRunnerProviderTestComponents {
  readonly inspector: InspectorPort;
  readonly worktrees: WorktreePort;
  readonly executor: ExecutorPort;
  readonly artifacts: ArtifactPort;
  readonly now: () => string;
  readonly limits: ProviderLimits;
}

let constructLocalRunnerProviderForTesting:
  ((components: LocalRunnerProviderTestComponents) => LocalRunnerProvider) | undefined;

export interface LocalRunnerHostControl {
  readonly prepareEnvironmentWithReplay: (
    request: PrepareEnvironmentRequest
  ) => Promise<Readonly<{ environment: PreparedEnvironment; replayed: boolean }>>;
  readonly terminalizeProtocolFailure: (
    request: ReadCommandEventsRequest,
    reason: "output_quarantined"
  ) => Promise<Readonly<{ commandId: CommandId; replayed: boolean }>>;
}

const hostControls = new WeakMap<LocalRunnerProvider, LocalRunnerHostControl>();

type LifecycleState = "open" | "quiesced" | "draining" | "drained" | "closed";

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

const capabilities = (limits: ProviderLimits): RunnerCapabilities =>
  deepFreeze(
    RunnerCapabilitiesSchema.parse({
      runnerId: "autostack-local",
      version: "0.1.0",
      platform: Object.freeze({ os: "darwin" as const, architecture: "arm64" as const }),
      pty: true as const,
      cancellation: true as const,
      filesystemDisclosure: "host_user" as const,
      maximumBytes: Object.freeze({
        liveOutput: limits.eventBytes,
        replay: limits.replayBytes,
        transcript: limits.transcriptBytes,
        artifact: limits.artifactBytes
      }),
      supportedNetworkPolicies: ["host"],
      enforcement: Object.freeze({
        cpu: "advisory" as const,
        memory: "advisory" as const,
        duration: "hard" as const,
        autostackPathOperations: "hard" as const,
        childFilesystem: "advisory" as const,
        network: "unavailable" as const
      })
    })
  );

const samePreparedRequest = (
  environment: PreparedEnvironment,
  request: PrepareEnvironmentRequest
): boolean =>
  environment.workspaceId === request.workspaceId &&
  environment.runId === request.runId &&
  environment.environmentId === request.environmentId &&
  environment.repositoryIdentity === request.inspection.repositoryIdentity &&
  environment.sourceCommit === request.sourceCommit &&
  environment.branch === request.branch &&
  JSON.stringify(environment.authorization) === JSON.stringify(request.authorization);

export class LocalRunnerProvider implements RunnerProvider, LocalRunnerLifecycle {
  readonly #components: LocalRunnerProviderTestComponents;
  readonly #capabilities: RunnerCapabilities;
  #state: LifecycleState = "open";
  #quiescePromise: Promise<void> | undefined;
  #drainPromise: Promise<RunnerDrainResult> | undefined;
  #closePromise: Promise<void> | undefined;

  static {
    constructLocalRunnerProviderForTesting = (components) => new LocalRunnerProvider(components);
  }

  private constructor(components: LocalRunnerProviderTestComponents) {
    this.#components = components;
    this.#capabilities = capabilities(components.limits);
    hostControls.set(
      this,
      Object.freeze({
        prepareEnvironmentWithReplay: async (request: PrepareEnvironmentRequest) =>
          await this.#prepareWithReplay(request),
        terminalizeProtocolFailure: async (
          request: ReadCommandEventsRequest,
          reason: "output_quarantined"
        ) => {
          this.#assertAvailable();
          try {
            return await this.#components.executor.terminalizeProtocolFailure(request, reason);
          } catch (error) {
            throw rematerializeProviderError(error);
          }
        }
      })
    );
  }

  static async create(optionsInput: LocalRunnerProviderOptions): Promise<LocalRunnerProvider> {
    const options = snapshotProviderOptions(optionsInput);
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new LocalRunnerProviderError("unsupported_policy");
    }
    const activity = new CommandActivityCoordinator();
    let worktrees: WorktreeManager | undefined;
    let executor: CommandExecutor | undefined;
    try {
      worktrees = await WorktreeManager.create({
        dataRoot: options.dataRoot,
        now: options.now,
        deferStartupDisposal: true,
        verifyTerminalEvidence: options.verifyTerminalEvidence,
        acquireEnvironmentQuiescence: (environmentId) =>
          activity.acquireEnvironmentQuiescence(environmentId),
        ...(options.trustedGitExecutable === undefined
          ? {}
          : { trustedGitExecutable: options.trustedGitExecutable })
      });
      const paths = await DataPathPolicy.openExisting(options.dataRoot);
      const managedWorktreeRoot = await paths.ensureDirectory("worktrees");
      const privateConfigRoot = await paths.ensureDirectory("git-config");
      const inspector = await GitClient.create({
        managedWorktreeRoot,
        privateConfigRoot,
        ...(options.trustedGitExecutable === undefined
          ? {}
          : { trustedGitExecutable: options.trustedGitExecutable })
      });
      const artifacts = await ArtifactStore.create({ dataRoot: options.dataRoot });
      executor = await CommandExecutor.create({
        dataRoot: options.dataRoot,
        worktrees,
        artifactStore: artifacts,
        activity,
        guardianLauncher: options.guardianLauncher,
        resolveCredentials: options.resolveCredentials,
        executableResolver: options.executableResolver,
        trustedBaseEnvironment: options.trustedBaseEnvironment,
        limits: options.limits,
        now: options.now,
        monotonicNowMs: options.monotonicNowMs,
        createArtifactId: options.createArtifactId,
        createGuardianSession: options.createGuardianSession
      });
      await worktrees.resumePendingDisposals();
      return new LocalRunnerProvider({
        inspector,
        worktrees,
        executor,
        artifacts,
        now: options.now,
        limits: options.limits
      });
    } catch (error) {
      try {
        await executor?.close();
      } catch {
        throw new LocalRunnerProviderError("unsafe_state");
      }
      try {
        await worktrees?.close();
      } catch {
        throw new LocalRunnerProviderError("unsafe_state");
      }
      throw rematerializeProviderError(error);
    }
  }

  async capabilities(): Promise<RunnerCapabilities> {
    this.#assertAvailable();
    return this.#capabilities;
  }

  async inspectRepository(request: InspectRepositoryRequest): Promise<RepositoryInspection> {
    this.#assertAvailable();
    try {
      return (await this.#components.inspector.inspectRepository(request)).inspection;
    } catch (error) {
      throw rematerializeProviderError(error);
    }
  }

  async prepareEnvironment(request: PrepareEnvironmentRequest): Promise<PreparedEnvironment> {
    return (await this.#prepareWithReplay(request)).environment;
  }

  async #prepareWithReplay(
    requestInput: PrepareEnvironmentRequest
  ): Promise<Readonly<{ environment: PreparedEnvironment; replayed: boolean }>> {
    this.#assertWritable();
    try {
      const request = await parsePrepareRequest(requestInput);
      const existing = (await this.#components.worktrees.listEnvironments()).find(
        (environment) => environment.environmentId === request.environmentId
      );
      const replayed = existing !== undefined && samePreparedRequest(existing, request);
      if (!replayed) assertAuthorizationCurrent(request.authorization, this.#components.now());
      const environment = await this.#components.worktrees.prepareEnvironment(request);
      return Object.freeze({ environment, replayed });
    } catch (error) {
      throw rematerializeProviderError(error);
    }
  }

  async listEnvironments(): Promise<readonly PreparedEnvironment[]> {
    this.#assertAvailable();
    try {
      return await this.#components.worktrees.listEnvironments();
    } catch (error) {
      throw rematerializeProviderError(error);
    }
  }

  async startCommand(requestInput: StartCommandRequest): Promise<CommandAccepted> {
    this.#assertWritable();
    try {
      const request = await parseStartRequest(requestInput);
      const prepared = (await this.#components.worktrees.listEnvironments()).some(
        (environment) => environment.environmentId === request.environmentId
      );
      if (!prepared) throw new LocalRunnerProviderError("environment_not_prepared");
      return await this.#components.executor.startCommand(request);
    } catch (error) {
      throw rematerializeProviderError(error);
    }
  }

  readCommandEvents(request: ReadCommandEventsRequest): AsyncIterable<RunnerSubscriptionItem> {
    if (this.#state === "closed") {
      return Object.freeze({
        async *[Symbol.asyncIterator]() {
          throw new LocalRunnerProviderError("closed");
        }
      });
    }
    try {
      const source = this.#components.executor.readCommandEvents(request);
      return Object.freeze({
        [Symbol.asyncIterator](): AsyncIterator<RunnerSubscriptionItem> {
          let iterator: AsyncIterator<RunnerSubscriptionItem>;
          try {
            iterator = source[Symbol.asyncIterator]();
          } catch (error) {
            throw rematerializeProviderError(error);
          }
          const wrapped: AsyncIterator<RunnerSubscriptionItem> &
            AsyncIterable<RunnerSubscriptionItem> = {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next(value?: unknown) {
              try {
                return await iterator.next(value as never);
              } catch (error) {
                throw rematerializeProviderError(error);
              }
            },
            async return(value?: unknown) {
              try {
                return iterator.return === undefined
                  ? { done: true, value: value as never }
                  : await iterator.return(value as never);
              } catch (error) {
                throw rematerializeProviderError(error);
              }
            },
            async throw(value?: unknown) {
              try {
                if (iterator.throw === undefined) throw value;
                return await iterator.throw(value);
              } catch (error) {
                throw rematerializeProviderError(error);
              }
            }
          };
          return Object.freeze(wrapped);
        }
      });
    } catch (error) {
      throw rematerializeProviderError(error);
    }
  }

  async cancelCommand(request: CancelCommandRequest): Promise<CancelCommandResponse> {
    this.#assertAvailable();
    try {
      return await this.#components.executor.cancelCommand(request);
    } catch (error) {
      throw rematerializeProviderError(error);
    }
  }

  async readArtifactChunk(request: ReadArtifactChunkRequest): Promise<ReadArtifactChunkResponse> {
    this.#assertAvailable();
    try {
      const admitted = parseArtifactRequest(request);
      const descriptor = await this.#components.executor.resolveOwnedArtifact(admitted);
      const read = await this.#components.artifacts.readArtifact(admitted.artifactId, {
        offset: admitted.offset,
        length: admitted.length
      });
      if (JSON.stringify(read.descriptor) !== JSON.stringify(descriptor)) {
        throw new LocalRunnerProviderError("artifact_not_found");
      }
      return ReadArtifactChunkResponseSchema.parse({
        artifact: descriptor,
        offset: read.offset,
        bytes: read.bytes.toString("base64"),
        nextOffset: read.nextOffset,
        done: read.done
      });
    } catch (error) {
      throw rematerializeProviderError(error);
    }
  }

  async disposeEnvironment(
    request: DisposeEnvironmentRequest
  ): Promise<DisposeEnvironmentResponse> {
    this.#assertAvailable();
    try {
      return await this.#components.worktrees.disposeEnvironment(request);
    } catch (error) {
      throw rematerializeProviderError(error);
    }
  }

  async quiesce(): Promise<void> {
    if (this.#state === "closed") throw new LocalRunnerProviderError("closed");
    if (this.#state !== "open") return await this.#quiescePromise;
    this.#state = "quiesced";
    this.#quiescePromise = this.#components.executor.quiesce().catch((error: unknown) => {
      throw rematerializeProviderError(error);
    });
    return await this.#quiescePromise;
  }

  async interruptAndDrain(): Promise<RunnerDrainResult> {
    if (this.#state === "closed") throw new LocalRunnerProviderError("closed");
    if (this.#drainPromise !== undefined) return await this.#drainPromise;
    this.#drainPromise = (async () => {
      await this.quiesce();
      this.#state = "draining";
      try {
        const result = await this.#components.executor.interruptAndDrain();
        this.#state = "drained";
        return result;
      } catch (error) {
        throw rematerializeProviderError(error);
      }
    })();
    return await this.#drainPromise;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return await this.#closePromise;
    if (this.#state === "closed") return;
    this.#closePromise = (async () => {
      await this.interruptAndDrain();
      try {
        await this.#components.executor.close();
        await this.#components.worktrees.close();
        this.#state = "closed";
      } catch (error) {
        throw rematerializeProviderError(error);
      }
    })();
    return await this.#closePromise;
  }

  #assertAvailable(): void {
    if (this.#state === "closed") throw new LocalRunnerProviderError("closed");
  }

  #assertWritable(): void {
    this.#assertAvailable();
    if (this.#state !== "open") throw new LocalRunnerProviderError("closed");
  }
}

/** @internal Package-private factory; absent from the package entry export. */
export const createLocalRunnerProviderFromTestComponents = (
  components: LocalRunnerProviderTestComponents
): LocalRunnerProvider => {
  const construct = constructLocalRunnerProviderForTesting;
  if (construct === undefined) throw new LocalRunnerProviderError("unsafe_state");
  return construct(components);
};

export const localRunnerHostControl = (provider: LocalRunnerProvider): LocalRunnerHostControl => {
  const control = hostControls.get(provider);
  if (control === undefined) throw new LocalRunnerProviderError("invalid_request");
  return control;
};

export { type LocalRunnerProviderOptions } from "./local-runner-provider-admission.js";
export {
  LocalRunnerProviderError,
  type LocalRunnerProviderErrorCode
} from "./local-runner-provider-error.js";
