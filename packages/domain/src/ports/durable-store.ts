import type {
  Actor,
  EventId,
  IdFactory,
  JobId,
  PendingDomainEvent,
  RunId,
  RunStage,
  StoredDomainEvent,
  WorkspaceId
} from "@autostack/contracts";

export type StreamKind = "workspace" | "project" | "work_item" | "run" | "automation";

export interface StreamRef {
  readonly kind: StreamKind;
  readonly id: string;
}

export interface StreamAppend {
  readonly stream: StreamRef;
  readonly expectedVersion: number;
  readonly events: readonly PendingDomainEvent[];
}

export interface NewWorkflowJob {
  readonly jobId: JobId;
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly stage: RunStage;
  readonly handler: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
}

export interface CommitRequest {
  readonly idempotency: { readonly scope: string; readonly key: string };
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
}

export interface CommitResult {
  readonly events: readonly StoredDomainEvent[];
  readonly jobIds: readonly JobId[];
  readonly replayed: boolean;
}

export interface ReadStreamRequest {
  readonly stream: StreamRef;
  readonly afterVersion?: number;
}

export interface ReadAllRequest {
  readonly afterGlobalSequence?: number;
  readonly workspaceId?: WorkspaceId;
  readonly limit?: number;
}

export interface LeasedWorkflowJob extends NewWorkflowJob {
  readonly attempt: number;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface LeaseNextRequest {
  readonly workerId: string;
  readonly now: string;
  readonly leaseDurationMs: number;
}

export interface HeartbeatRequest {
  readonly jobId: JobId;
  readonly leaseToken: string;
  readonly now: string;
  readonly leaseDurationMs: number;
}

export interface CompleteJobRequest {
  readonly jobId: JobId;
  readonly leaseToken: string;
  readonly now: string;
  readonly idempotency: { readonly scope: string; readonly key: string };
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
}

export interface FailJobRequest {
  readonly jobId: JobId;
  readonly leaseToken: string;
  readonly now: string;
  readonly error: { readonly name: string; readonly message: string; readonly retryable: boolean };
  readonly nextAvailableAt?: string;
}

export interface StoreHealth {
  readonly status: "ok" | "degraded";
  readonly journalMode: "wal";
  readonly schemaVersion: number;
}

export interface DurableStore {
  commit(request: CommitRequest): Promise<CommitResult>;
  readStream(request: ReadStreamRequest): Promise<readonly StoredDomainEvent[]>;
  readAll(request: ReadAllRequest): Promise<readonly StoredDomainEvent[]>;
  leaseNext(request: LeaseNextRequest): Promise<LeasedWorkflowJob | null>;
  heartbeat(request: HeartbeatRequest): Promise<void>;
  completeJob(request: CompleteJobRequest): Promise<CommitResult>;
  failJob(request: FailJobRequest): Promise<void>;
  health(): Promise<StoreHealth>;
  close(): Promise<void>;
}

export interface DomainContext {
  readonly workspaceId: WorkspaceId;
  readonly actor: Actor;
  readonly correlationId: string;
}

export type StoreIdFactory = Pick<IdFactory, "event">;
export type EventCausationId = EventId;
