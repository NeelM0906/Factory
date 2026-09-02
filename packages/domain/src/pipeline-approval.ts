import {
  PIPELINE_REWORK_MAX_ATTEMPTS,
  PendingDomainEventSchema,
  digestExecutionScope,
  digestLocalExecutionPhase,
  digestPlanDocument,
  type Actor,
  type Approval,
  type ExecutionScope,
  type IdFactory,
  type Origin,
  type PendingDomainEvent,
  type PipelineEvidence,
  type PlanDocument,
  type Run
} from "@autostack/contracts";

import { decideApproval } from "./approval.js";
import { StaleApprovalEvidenceError } from "./errors.js";
import { authorizeEnvironment, sealPlanApprovalEvidence } from "./pipeline-approval-records.js";
import type { NewWorkflowJob, StreamAppend } from "./ports/durable-store.js";
import { transitionRun } from "./run-machine.js";

const IMPLEMENT_HANDLER = "pipeline.implement";
const APPROVED_REASON = "A human approved the plan and its execution scope.";
const REJECTED_REASON = "A human rejected the plan.";

export interface PipelineApprovalDecisionCommand {
  /** The durable approval record. Never a shape reconstructed from a request body. */
  readonly approval: Approval;
  readonly decision: "approved" | "rejected";
  readonly run: Run;
  /** The run stream version the caller read, stamped so a concurrent writer conflicts. */
  readonly streamVersion: number;
  /** The plan-stage evidence recorded on the run stream, whichever envelope the caller found. */
  readonly planEvidence: PipelineEvidence;
  /** The plan document that evidence names, re-read so its digest can be recomputed. */
  readonly planDocument: PlanDocument;
  /**
   * The `ExecutionScope` re-derived from the same repository inspection and project configuration
   * the plan station used — `executionEnvironmentForRun(runId)` for the environment id, never a
   * fresh mint. The plan station digested its scope into `approval.evidenceDigest` and discarded
   * the object, so this is the only way the environment authorization can name the scope a human
   * actually approved.
   */
  readonly executionScope: ExecutionScope;
  readonly actor: Actor;
  readonly origin: Origin;
  readonly correlationId: string;
}

export interface PipelineApprovalDecisionDependencies {
  readonly now: () => string;
  /**
   * How long the recorded environment authorization stays usable. Optional so existing callers keep
   * `ENVIRONMENT_AUTHORIZATION_TTL_MS`, but composition should pass it explicitly: a window nobody
   * chose is still a window, and running past it fails provisioning on a valid approval.
   */
  readonly authorizationTtlMs?: number;
  readonly ids: Pick<IdFactory, "job" | "environmentAuthorization">;
}

export interface PipelineApprovalDecision {
  readonly approval: Approval;
  readonly run: Run;
  /** When the approval was decided — the original instant on a replay, never a recomputed one. */
  readonly decidedAt: string;
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
  readonly idempotency: { readonly scope: string; readonly key: string };
  readonly replayed: boolean;
}

/**
 * The idempotency key is **derived, never supplied** (plan D9). A caller-chosen key would let two
 * different decisions on one approval share a key — or one decision arrive twice under two keys —
 * and the store would replay or duplicate accordingly. Deriving it from the approval, the decision
 * and the evidence digest makes a repeated *identical* decision collide by construction while a
 * changed decision or changed evidence necessarily lands on a different key.
 */
const idempotencyFor = (
  approval: Approval,
  decision: "approved" | "rejected"
): { readonly scope: string; readonly key: string } => ({
  scope: `api:approval-decision:${approval.workspaceId}`,
  key: `${approval.id}:${decision}:${approval.evidenceDigest}`
});

/**
 * The two-sided freshness gate (spec §14.2, plan D1). Both halves refuse rather than pass when the
 * value they need is missing: an approval is a judgement over specific bytes, and a comparison that
 * cannot find those bytes has not established anything.
 *
 * The plan side is checked through the envelope's discriminant rather than through its digest
 * field. `PipelineEvidence` is a union, and every stage other than `plan` simply has no
 * `planDigest`; a guard shaped `recorded !== undefined && recorded !== computed` would read that
 * absence as "nothing to compare" and let a decision through over evidence that never named a plan.
 */
const assertFreshEvidence = async (
  command: PipelineApprovalDecisionCommand,
  scopeDigest: string
): Promise<void> => {
  // The scope side. `decideApproval` also compares the evidence it is handed, but the equality that
  // matters downstream is this one: `admitPrepareEnvironment` recomputes `digestExecutionScope` and
  // holds it against the approval, so the digest recorded on the authorization has to be checked
  // under the same function the environment boundary will use.
  if (scopeDigest !== command.approval.evidenceDigest) throw new StaleApprovalEvidenceError();
  if (command.planEvidence.stage !== "plan") throw new StaleApprovalEvidenceError();
  if ((await digestPlanDocument(command.planDocument)) !== command.planEvidence.planDigest) {
    throw new StaleApprovalEvidenceError();
  }
};

/**
 * Decides a plan approval and produces everything that decision implies (spec §14.2, plan D1).
 *
 * An approval says a human accepted one plan *and* the execution scope that plan implies. The plan
 * station only ever recorded the digest of that scope, so this function is handed the scope
 * re-derived from the same inspection and configuration and records the environment authorization
 * over it. `admitPrepareEnvironment` later recomputes `digestExecutionScope(authorization.scope)`
 * and compares it to the approval's `evidenceDigest`, which is why a scope carrying a freshly
 * minted environment id fails a perfectly valid approval.
 *
 * Nothing here writes: the caller commits the returned appends and jobs under the returned
 * idempotency descriptor, so a refusal necessarily precedes any durable record — including the
 * idempotency record, which is why a refused submission never poisons the corrected one.
 */
export async function decidePipelineApproval(
  command: PipelineApprovalDecisionCommand,
  dependencies: PipelineApprovalDecisionDependencies
): Promise<PipelineApprovalDecision> {
  const { approval, run, executionScope } = command;
  // Identity comes from the durable records, never from the request that carried them (plan D13).
  if (approval.kind !== "plan") {
    throw new TypeError(`A plan decision applies to a plan approval, not a ${approval.kind} one.`);
  }
  if (approval.workspaceId !== run.workspaceId || approval.runId !== run.id) {
    throw new TypeError("This approval belongs to a different run.");
  }
  if (command.planDocument.runId !== run.id) {
    throw new TypeError("This plan document belongs to a different run.");
  }

  const idempotency = idempotencyFor(approval, command.decision);
  const scopeDigest = await digestExecutionScope(executionScope);
  await assertFreshEvidence(command, scopeDigest);

  const occurredAt = dependencies.now();
  // `decideApproval` owns eligibility and conflict. An identical re-decision comes back from it
  // with no events, which is the replay: the approval already carries the decision and the instant
  // it was taken, and both are returned unchanged rather than recomputed.
  const decided = decideApproval({
    approval,
    decision: command.decision,
    evidence: executionScope,
    actor: command.actor,
    origin: command.origin,
    occurredAt,
    correlationId: command.correlationId
  });
  const decidedAt = decided.approval.decision?.decidedAt;
  if (decidedAt === undefined) {
    throw new TypeError("A decided approval must record when it was decided.");
  }
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

  const event = (type: string, payload: unknown): PendingDomainEvent =>
    PendingDomainEventSchema.parse({
      workspaceId: run.workspaceId,
      actor: command.actor,
      correlationId: command.correlationId,
      occurredAt,
      type,
      payload
    });
  const appendOf = (events: readonly PendingDomainEvent[]): readonly StreamAppend[] => [
    { stream: { kind: "run", id: run.id }, expectedVersion: command.streamVersion, events }
  ];

  if (command.decision === "rejected") {
    // A declared edge back to planning, and no successor job: rejection ends this attempt rather
    // than starting the next one.
    const transition = transitionRun({
      run,
      to: "planning",
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

  // Minted before the evidence so the envelope can name the job this approval authorized: the
  // decision is not itself a leased stage, and borrowing the plan station's job id would attribute
  // the approval to work that has already closed.
  const jobId = dependencies.ids.job();
  const evidence = await sealPlanApprovalEvidence({
    workspaceId: run.workspaceId,
    workItemId: run.workItemId,
    runId: run.id,
    approvalId: approval.id,
    approvedEvidenceDigest: command.planEvidence.evidenceDigest,
    actorId: command.actor.id,
    producedAt: occurredAt
  });
  const authorization = await authorizeEnvironment({
    id: dependencies.ids.environmentAuthorization(),
    approvalId: approval.id,
    approvalEvidenceDigest: scopeDigest,
    scope: executionScope,
    createdAt: occurredAt,
    ...(dependencies.authorizationTtlMs === undefined
      ? {}
      : { ttlMs: dependencies.authorizationTtlMs })
  });
  const phasePayload = {
    runId: run.id,
    environmentId: executionScope.environmentId,
    authorization,
    phaseKey: `environment:${executionScope.environmentId}:authorization`
  };
  const transition = transitionRun({
    run,
    to: "provisioning",
    reason: APPROVED_REASON,
    actor: command.actor,
    correlationId: command.correlationId,
    occurredAt
  });

  return {
    approval: decided.approval,
    run: transition.run,
    decidedAt,
    // One append, so the decision, its evidence, the authorization it grants and the transition it
    // causes are either all durable or none of them are. The decision precedes the authorization
    // because `validateRunStreamCoherence` refuses an authorization whose approval is not yet
    // approved in the fold.
    appends: appendOf([
      ...decided.events,
      event("pipeline.evidence_recorded", { runId: run.id, jobId, attempt: 1, evidence }),
      event("environment.authorization_recorded", {
        ...phasePayload,
        phaseDigest: await digestLocalExecutionPhase(
          "environment.authorization_recorded",
          phasePayload
        )
      }),
      ...transition.events
    ]),
    jobs: [
      {
        jobId,
        workspaceId: run.workspaceId,
        runId: run.id,
        stage: "implement",
        handler: IMPLEMENT_HANDLER,
        payload: {
          workItemId: run.workItemId,
          pipelineStage: "implement",
          // The implement-rework counter, which an approval never spends: this is the first attempt
          // at implementing, not a rework of a failed judgement.
          attempt: 1,
          inputEvidenceDigests: [evidence.evidenceDigest]
        },
        maxAttempts: PIPELINE_REWORK_MAX_ATTEMPTS,
        availableAt: occurredAt,
        createdAt: occurredAt
      }
    ],
    idempotency,
    replayed: false
  };
}

export { PIPELINE_EVIDENCE_DIGEST_DOMAIN } from "./pipeline-approval-records.js";
