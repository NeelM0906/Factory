import {
  LocalArtifactReadRequestSchema,
  LocalCancelRequestSchema,
  LocalDisposeRequestSchema,
  LocalEventsRequestSchema,
  LocalInspectRequestSchema,
  LocalPrepareRequestSchema,
  LocalStartRequestSchema,
  type ArtifactDescriptor,
  type ApprovalId,
  type CancelCommandRequest,
  type CancelCommandResponse,
  type CommandAccepted,
  type DisposeEnvironmentRequest,
  type DisposeEnvironmentResponse,
  type HostResponseBodyByRoute,
  type ListEnvironmentsResponse,
  type LocalArtifactReadRequest,
  type LocalCancelRequest,
  type LocalDisposeRequest,
  type LocalEventsRequest,
  type LocalInspectRequest,
  type LocalPrepareRequest,
  type LocalStartRequest,
  type PrepareEnvironmentRequest,
  type ReadArtifactChunkRequest,
  type ReadArtifactChunkResponse,
  type ReadCommandEventsRequest,
  type RepositoryInspection,
  type RunnerSubscriptionItem,
  type StartCommandRequest
} from "@autostack/contracts";

export class LocalRunnerUnavailableError extends Error {
  constructor() {
    super("Local runner unavailable.");
    this.name = "LocalRunnerUnavailableError";
  }
}

interface LocalHostClient {
  inspectRepository?(request: LocalInspectRequest): Promise<RepositoryInspection>;
  listEnvironments?(): Promise<ListEnvironmentsResponse>;
  prepareEnvironment?(
    request: PrepareEnvironmentRequest
  ): Promise<HostResponseBodyByRoute["POST /v1/environments"]>;
  startCommand?(request: StartCommandRequest): Promise<CommandAccepted>;
  openCommandEvents?(request: ReadCommandEventsRequest): AsyncIterable<RunnerSubscriptionItem>;
  cancelCommand?(request: CancelCommandRequest): Promise<CancelCommandResponse>;
  readArtifactRange?(request: ReadArtifactChunkRequest): Promise<ReadArtifactChunkResponse>;
  disposeEnvironment?(request: DisposeEnvironmentRequest): Promise<DisposeEnvironmentResponse>;
}

export interface LocalExecutionState {
  authorizePreparation?(
    input: LocalPrepareRequest,
    inspection: RepositoryInspection,
    idempotencyKey: string
  ): Promise<PrepareEnvironmentRequest>;
  recordPreparationIntent?(request: PrepareEnvironmentRequest): Promise<void>;
  recordPrepared?(
    request: PrepareEnvironmentRequest,
    result: HostResponseBodyByRoute["POST /v1/environments"]
  ): Promise<void>;
  authorizeStart?(input: LocalStartRequest, idempotencyKey: string): Promise<StartCommandRequest>;
  recordCommandIntent?(request: StartCommandRequest): Promise<void>;
  resolveEvents?(input: LocalEventsRequest): Promise<ReadCommandEventsRequest>;
  resolveCancellation?(input: LocalCancelRequest): Promise<CancelCommandRequest>;
  resolveArtifactRead?(input: LocalArtifactReadRequest): Promise<ReadArtifactChunkRequest>;
  resolveDisposal?(input: LocalDisposeRequest): Promise<DisposeEnvironmentRequest>;
  resolveArtifactDescriptor?(artifactId: string): Promise<ArtifactDescriptor>;
  resolvePreparationApproval?(
    runId: LocalPrepareRequest["runId"],
    environmentId: LocalPrepareRequest["environmentId"],
    authorizationId: LocalPrepareRequest["environmentAuthorizationId"]
  ): Promise<ApprovalId>;
  resolveCommandApproval?(
    runId: LocalStartRequest["runId"],
    environmentId: LocalStartRequest["environmentId"],
    commandId: LocalStartRequest["commandId"],
    authorizationId: LocalStartRequest["commandAuthorizationId"]
  ): Promise<ApprovalId>;
}

interface Reconciler {
  trackAccepted(request: StartCommandRequest): Promise<void>;
}

export interface HostGenerationRetirement {
  closeIngress(): Promise<void>;
  stopReconciliation(): Promise<void>;
  closePersistence(): Promise<void>;
}

export interface LocalExecutionServiceDependencies {
  readonly host: LocalHostClient;
  readonly state: LocalExecutionState;
  readonly reconciler?: Reconciler;
  readonly retirement?: HostGenerationRetirement;
}

const required = <Value>(value: Value | undefined): Value => {
  if (value === undefined) throw new LocalRunnerUnavailableError();
  return value;
};

export class LocalExecutionService {
  readonly #dependencies: LocalExecutionServiceDependencies;
  #available = true;
  #retirement: Promise<void> | undefined;

  constructor(dependencies: LocalExecutionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  #assertAvailable(): void {
    if (!this.#available) throw new LocalRunnerUnavailableError();
  }

  inspect(input: LocalInspectRequest): Promise<RepositoryInspection> {
    this.#assertAvailable();
    const request = LocalInspectRequestSchema.parse(structuredClone(input));
    return required(this.#dependencies.host.inspectRepository)?.call(
      this.#dependencies.host,
      request
    );
  }

  list(): Promise<ListEnvironmentsResponse> {
    this.#assertAvailable();
    return required(this.#dependencies.host.listEnvironments)?.call(this.#dependencies.host);
  }

  async prepare(
    inputCandidate: LocalPrepareRequest,
    idempotencyKey: string
  ): Promise<HostResponseBodyByRoute["POST /v1/environments"]> {
    this.#assertAvailable();
    const input = LocalPrepareRequestSchema.parse(structuredClone(inputCandidate));
    const inspection = await this.inspect({ sourcePath: input.sourcePath, baseRef: input.baseRef });
    const request = await required(this.#dependencies.state.authorizePreparation)?.call(
      this.#dependencies.state,
      input,
      inspection,
      idempotencyKey
    );
    await required(this.#dependencies.state.recordPreparationIntent)?.call(
      this.#dependencies.state,
      request
    );
    const result = await required(this.#dependencies.host.prepareEnvironment)?.call(
      this.#dependencies.host,
      request
    );
    await required(this.#dependencies.state.recordPrepared)?.call(
      this.#dependencies.state,
      request,
      result
    );
    return result;
  }

  async start(inputCandidate: LocalStartRequest, idempotencyKey: string): Promise<CommandAccepted> {
    this.#assertAvailable();
    const input = LocalStartRequestSchema.parse(structuredClone(inputCandidate));
    const request = await required(this.#dependencies.state.authorizeStart)?.call(
      this.#dependencies.state,
      input,
      idempotencyKey
    );
    await required(this.#dependencies.state.recordCommandIntent)?.call(
      this.#dependencies.state,
      request
    );
    const result = await required(this.#dependencies.host.startCommand)?.call(
      this.#dependencies.host,
      request
    );
    if (this.#dependencies.reconciler !== undefined) {
      void this.#dependencies.reconciler.trackAccepted(request).catch(() => undefined);
    }
    return result;
  }

  async events(inputCandidate: LocalEventsRequest): Promise<AsyncIterable<RunnerSubscriptionItem>> {
    this.#assertAvailable();
    const input = LocalEventsRequestSchema.parse(structuredClone(inputCandidate));
    const request = await required(this.#dependencies.state.resolveEvents)?.call(
      this.#dependencies.state,
      input
    );
    return required(this.#dependencies.host.openCommandEvents)?.call(
      this.#dependencies.host,
      request
    );
  }

  async cancel(inputCandidate: LocalCancelRequest): Promise<CancelCommandResponse> {
    this.#assertAvailable();
    const input = LocalCancelRequestSchema.parse(structuredClone(inputCandidate));
    const request = await required(this.#dependencies.state.resolveCancellation)?.call(
      this.#dependencies.state,
      input
    );
    return required(this.#dependencies.host.cancelCommand)?.call(this.#dependencies.host, request);
  }

  async readArtifact(inputCandidate: LocalArtifactReadRequest): Promise<ReadArtifactChunkResponse> {
    this.#assertAvailable();
    const input = LocalArtifactReadRequestSchema.parse(structuredClone(inputCandidate));
    const request = await required(this.#dependencies.state.resolveArtifactRead)?.call(
      this.#dependencies.state,
      input
    );
    return required(this.#dependencies.host.readArtifactRange)?.call(
      this.#dependencies.host,
      request
    );
  }

  async dispose(inputCandidate: LocalDisposeRequest): Promise<DisposeEnvironmentResponse> {
    this.#assertAvailable();
    const input = LocalDisposeRequestSchema.parse(structuredClone(inputCandidate));
    const request = await required(this.#dependencies.state.resolveDisposal)?.call(
      this.#dependencies.state,
      input
    );
    return required(this.#dependencies.host.disposeEnvironment)?.call(
      this.#dependencies.host,
      request
    );
  }

  retireHostGeneration(): Promise<void> {
    if (this.#retirement !== undefined) return this.#retirement;
    this.#available = false;
    const retirement = required(this.#dependencies.retirement);
    this.#retirement = (async () => {
      await retirement.closeIngress();
      await retirement.stopReconciliation();
      await retirement.closePersistence();
    })();
    return this.#retirement;
  }
}
