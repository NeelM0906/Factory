import type {
  CancelCommandRequest,
  CancelCommandResponse,
  CommandAccepted,
  DisposeEnvironmentRequest,
  DisposeEnvironmentResponse,
  InspectRepositoryRequest,
  PreparedEnvironment,
  PrepareEnvironmentRequest,
  ReadArtifactChunkRequest,
  ReadArtifactChunkResponse,
  ReadCommandEventsRequest,
  RepositoryInspection,
  RunnerCapabilities,
  RunnerDrainResult,
  RunnerSubscriptionItem,
  StartCommandRequest
} from "@autostack/contracts";

/** Implementation-neutral local execution boundary. */
export interface RunnerProvider {
  capabilities(): Promise<RunnerCapabilities>;
  inspectRepository(request: InspectRepositoryRequest): Promise<RepositoryInspection>;
  prepareEnvironment(request: PrepareEnvironmentRequest): Promise<PreparedEnvironment>;
  listEnvironments(): Promise<readonly PreparedEnvironment[]>;
  startCommand(request: StartCommandRequest): Promise<CommandAccepted>;
  readCommandEvents(request: ReadCommandEventsRequest): AsyncIterable<RunnerSubscriptionItem>;
  cancelCommand(request: CancelCommandRequest): Promise<CancelCommandResponse>;
  readArtifactChunk(request: ReadArtifactChunkRequest): Promise<ReadArtifactChunkResponse>;
  disposeEnvironment(request: DisposeEnvironmentRequest): Promise<DisposeEnvironmentResponse>;
}

/** Lifecycle boundary for a local provider composed by the host daemon. */
export interface LocalRunnerLifecycle {
  quiesce(): Promise<void>;
  interruptAndDrain(): Promise<RunnerDrainResult>;
  close(): Promise<void>;
}
