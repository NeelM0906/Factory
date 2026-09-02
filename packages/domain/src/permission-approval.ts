import {
  digestCommandScope,
  type Actor,
  type Approval,
  type ApprovalId,
  type CommandScope,
  type IdFactory,
  type Origin,
  type PendingDomainEvent,
  type Run,
  type RunStage
} from "@autostack/contracts";

import { requestApproval, decideApproval } from "./approval.js";
import { StaleApprovalEvidenceError } from "./errors.js";
import type { NewWorkflowJob, StreamAppend } from "./ports/durable-store.js";
import { transitionRun } from "./run-machine.js";

const REJECTED_REASON = "A human rejected the out-of-envelope action.";
const APPROVED_REASON = "A human approved the out-of-envelope action.";

// ---------------------------------------------------------------------------
// Request: the station parks the run and creates the approval
// ---------------------------------------------------------------------------

export interface PermissionApprovalRequestCommand {
  readonly run: Run;
  readonly streamVersion: number;
  readonly actionScope: CommandScope;
  readonly resumeHandler: string;
  readonly resumeStage: RunStage;
  readonly resumePayload: Readonly<Record<string, unknown>>;
  readonly eligibleApproverIds: readonly string[];
  readonly actor: Actor;
  readonly correlationId: string;
}

export interface PermissionApprovalRequestDependencies {
  readonly now: () => string;
  readonly approvalId: () => ApprovalId;
}

export interface PermissionApprovalRequestResult {
  readonly approval: Approval;
  readonly run: Run;
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
}

/**
 * Parks the run at `waiting_for_user` and creates a `permission` approval. Enqueues nothing (D2):
 * the decision route is responsible for creating the resume job when the human decides.
 */
export async function requestPermissionApproval(
  command: PermissionApprovalRequestCommand,
  dependencies: PermissionApprovalRequestDependencies
): Promise<PermissionApprovalRequestResult> {
  const { run } = command;
  const occurredAt = dependencies.now();

  const { approval, events: approvalEvents } = requestApproval(
    {
      workspaceId: run.workspaceId,
      runId: run.id,
      kind: "permission",
      evidence: command.actionScope,
      eligibleApproverIds: command.eligibleApproverIds,
      actor: command.actor,
      correlationId: command.correlationId
    },
    { now: () => occurredAt, approvalId: dependencies.approvalId }
  );

  const transition = transitionRun({
    run,
    to: "waiting_for_user",
    resumeStatus: run.status,
    reason: "An out-of-envelope action requires a human permission decision.",
    actor: command.actor,
    correlationId: command.correlationId,
    occurredAt
  });

  return {
    approval,
    run: transition.run,
    appends: [
      {
        stream: { kind: "run", id: run.id },
        expectedVersion: command.streamVersion,
        events: [...approvalEvents, ...transition.events]
      }
    ],
    jobs: []
  };
}

// ---------------------------------------------------------------------------
// Decision: the human approves or rejects the out-of-envelope action
// ---------------------------------------------------------------------------

export interface PermissionApprovalDecisionCommand {
  readonly approval: Approval;
  readonly decision: "approved" | "rejected";
  readonly run: Run;
  readonly streamVersion: number;
  readonly actionScope: CommandScope;
  readonly resumeHandler: string;
  readonly resumeStage: RunStage;
  readonly resumePayload: Readonly<Record<string, unknown>>;
  readonly actor: Actor;
  readonly origin: Origin;
  readonly correlationId: string;
}

export interface PermissionApprovalDecisionDependencies {
  readonly now: () => string;
  readonly ids: Pick<IdFactory, "job">;
}

export interface PermissionApprovalDecision {
  readonly approval: Approval;
  readonly run: Run;
  readonly decidedAt: string;
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
  readonly idempotency: { readonly scope: string; readonly key: string };
  readonly replayed: boolean;
}

/**
 * The idempotency key is derived, never supplied (plan D9). Same derivation as `decidePipelineApproval`.
 */
const idempotencyFor = (
  approval: Approval,
  decision: "approved" | "rejected"
): { readonly scope: string; readonly key: string } => ({
  scope: `api:approval-decision:${approval.workspaceId}`,
  key: `${approval.id}:${decision}:${approval.evidenceDigest}`
});

/**
 * Decides a permission approval: an out-of-envelope action a station asked a human to authorize.
 *
 * **Approved** -> resumes the run back to its prior status and enqueues the station's resume job
 * with the granted action's digest so the resumed attempt performs exactly that action.
 *
 * **Rejected** -> the run replans (transitions to `planning`) and no action is performed.
 */
export async function decidePermissionApproval(
  command: PermissionApprovalDecisionCommand,
  dependencies: PermissionApprovalDecisionDependencies
): Promise<PermissionApprovalDecision> {
  const { approval, run } = command;

  if (approval.kind !== "permission") {
    throw new TypeError(
      `A permission decision applies to a permission approval, not a ${approval.kind} one.`
    );
  }
  if (approval.workspaceId !== run.workspaceId || approval.runId !== run.id) {
    throw new TypeError("This approval belongs to a different run.");
  }

  const idempotency = idempotencyFor(approval, command.decision);

  // Staleness: the action scope the decision was made over must still match.
  const scopeDigest = await digestCommandScope(command.actionScope);
  if (scopeDigest !== approval.evidenceDigest) {
    throw new StaleApprovalEvidenceError();
  }

  const occurredAt = dependencies.now();
  const decided = decideApproval({
    approval,
    decision: command.decision,
    evidence: command.actionScope,
    actor: command.actor,
    origin: command.origin,
    occurredAt,
    correlationId: command.correlationId
  });

  const decidedAt = decided.approval.decision?.decidedAt;
  if (decidedAt === undefined) {
    throw new TypeError("A decided approval must record when it was decided.");
  }

  // Replay: identical re-decision, no events.
  if (decided.events.length === 0) {
    return {
      approval: decided.approval,
      run,
      decidedAt,
      appends: [],
      jobs: [],
      idempotency,
      replayed: true
    };
  }

  const appendOf = (events: readonly PendingDomainEvent[]): readonly StreamAppend[] => [
    { stream: { kind: "run", id: run.id }, expectedVersion: command.streamVersion, events }
  ];

  if (command.decision === "rejected") {
    // Rejected: the plan says "replans or fails" (§17.4). From waiting_for_user the only
    // forward path is to the resume status, and from there no declared edge reaches planning.
    // So the run fails — the action is never performed.
    const transition = transitionRun({
      run,
      to: "failed",
      reason: REJECTED_REASON,
      actor: command.actor,
      correlationId: command.correlationId,
      occurredAt
    });
    return {
      approval: decided.approval,
      run: transition.run,
      decidedAt,
      appends: appendOf([...decided.events, ...transition.events]),
      jobs: [],
      idempotency,
      replayed: false
    };
  }

  // Approved: resume the run back to its prior status and enqueue the resume job.
  const transition = transitionRun({
    run,
    to: run.resumeStatus!,
    reason: APPROVED_REASON,
    actor: command.actor,
    correlationId: command.correlationId,
    occurredAt
  });

  const jobId = dependencies.ids.job();
  return {
    approval: decided.approval,
    run: transition.run,
    decidedAt,
    appends: appendOf([...decided.events, ...transition.events]),
    jobs: [
      {
        jobId,
        workspaceId: run.workspaceId,
        runId: run.id,
        stage: command.resumeStage,
        handler: command.resumeHandler,
        payload: {
          ...command.resumePayload,
          grantedActionDigest: scopeDigest
        },
        maxAttempts: 1,
        availableAt: occurredAt,
        createdAt: occurredAt
      }
    ],
    idempotency,
    replayed: false
  };
}
