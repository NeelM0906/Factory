import type { RunStatus } from "@autostack/contracts";

export class InvalidRunTransitionError extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus, detail?: string) {
    super(detail ?? `Cannot transition run from ${from} to ${to}.`);
    this.name = "InvalidRunTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class ApprovalDecisionConflictError extends Error {
  constructor() {
    super("The approval already has a different decision.");
    this.name = "ApprovalDecisionConflictError";
  }
}

export class StaleApprovalEvidenceError extends Error {
  constructor() {
    super("The approval evidence has changed and requires a new decision.");
    this.name = "StaleApprovalEvidenceError";
  }
}

export class IneligibleApproverError extends Error {
  constructor(actorId: string) {
    super(`Actor ${actorId} is not eligible to decide this approval.`);
    this.name = "IneligibleApproverError";
  }
}

export class ProjectionOrderError extends Error {
  constructor(streamId: string) {
    super(`Events for stream ${streamId} are not strictly ordered.`);
    this.name = "ProjectionOrderError";
  }
}

export class OptimisticConcurrencyError extends Error {
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(streamId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Stream ${streamId} expected version ${expectedVersion}, but current version is ${actualVersion}.`
    );
    this.name = "OptimisticConcurrencyError";
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class LeaseConflictError extends Error {
  constructor(jobId: string) {
    super(`Workflow job ${jobId} is not owned by the supplied active lease.`);
    this.name = "LeaseConflictError";
  }
}
