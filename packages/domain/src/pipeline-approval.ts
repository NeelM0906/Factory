import {
  EnvironmentAuthorizationSchema,
  PIPELINE_REWORK_MAX_ATTEMPTS,
  PendingDomainEventSchema,
  PlanApprovalEvidenceSchema,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  digestLocalExecutionPhase,
  digestVersionedValue,
  type Actor,
  type Approval,
  type EnvironmentAuthorization,
  type ExecutionScope,
  type IdFactory,
  type Origin,
  type PendingDomainEvent,
  type PipelineEvidence,
  type PlanDocument,
  type Run
} from "@autostack/contracts";

import { decideApproval } from "./approval.js";
import type { NewWorkflowJob, StreamAppend } from "./ports/durable-store.js";
import { transitionRun } from "./run-machine.js";

/**
 * The digest domain a `PipelineEvidence` envelope is sealed under. It must be the string
 * `createStationKernel` uses (`packages/workflow/src/stations/station-kernel.ts`), because the
 * publication bundle chains implement evidence to *this* envelope's digest, and a station that
 * sealed the same envelope differently would produce a second, unequal name for one decision.
 * Workflow depends on domain, so the intended end state is that the kernel imports this constant;
 * that edit belongs to the workflow package and is out of this module's scope.
 */
const EVIDENCE_DIGEST_DOMAIN = "autostack.pipeline-evidence";

/**
 * `digestEnvironmentAuthorization` parses its input under the *full* authorization schema — which
 * is `.strict()` and requires `digest` — before dropping the field it is about to recompute. A
 * well-formed placeholder is therefore required to compute the real one, and it cannot influence
 * the result it helps produce.
 */
const PLACEHOLDER_DIGEST = "0".repeat(64);

/**
 * How long the recorded environment authorization stays admissible. It bounds the window between a
 * human's decision and the provisioning that decision authorizes: `admitPrepareEnvironment` refuses
 * an expired authorization, so a run whose implement job never ran must be decided again rather
 * than provisioned days later against a repository that has moved on.
 */
const ENVIRONMENT_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1_000;

const IMPLEMENT_HANDLER = "pipeline.implement";
const APPROVED_REASON = "A human approved the plan and its execution scope.";
const REJECTED_REASON = "A human rejected the plan.";

type PlanApprovalEvidence = Extract<PipelineEvidence, { stage: "plan_approval" }>;

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

const futureTimestamp = (from: string, milliseconds: number): string => {
  const parsed = Date.parse(from);
  if (Number.isNaN(parsed)) throw new TypeError("A decision needs a parseable timestamp.");
  return new Date(parsed + milliseconds).toISOString();
};

const sealPlanApprovalEvidence = async (
  command: PipelineApprovalDecisionCommand,
  producedAt: string
): Promise<PlanApprovalEvidence> => {
  const { run } = command;
  const envelope = {
    schemaVersion: 1,
    workspaceId: run.workspaceId,
    workItemId: run.workItemId,
    runId: run.id,
    stage: "plan_approval",
    artifactIds: [],
    approvalId: command.approval.id,
    decision: "approved",
    // The binding that makes the approval specific: the envelope names the plan evidence it was
    // taken over, so a later stage can prove which plan a human saw.
    approvedEvidenceDigest: command.planEvidence.evidenceDigest,
    actorId: command.actor.id,
    producedAt
  };
  const evidenceDigest = await digestVersionedValue(EVIDENCE_DIGEST_DOMAIN, envelope);
  return PlanApprovalEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const authorizeEnvironment = async (
  command: PipelineApprovalDecisionCommand,
  dependencies: PipelineApprovalDecisionDependencies,
  scopeDigest: string,
  createdAt: string
): Promise<EnvironmentAuthorization> => {
  const draft = {
    id: dependencies.ids.environmentAuthorization(),
    approvalId: command.approval.id,
    approvalEvidenceDigest: scopeDigest,
    scope: command.executionScope,
    createdAt,
    expiresAt: futureTimestamp(createdAt, ENVIRONMENT_AUTHORIZATION_TTL_MS),
    digest: PLACEHOLDER_DIGEST
  };
  return EnvironmentAuthorizationSchema.parse({
    ...draft,
    digest: await digestEnvironmentAuthorization(draft)
  });
};

/**
 * Decides a plan approval and commits everything that decision implies (spec §14.2, plan D1).
 *
 * An approval says a human accepted one plan *and* the execution scope that plan implies. The plan
 * station only ever recorded the digest of that scope, so this function is handed the scope
 * re-derived from the same inspection and configuration and records the environment authorization
 * over it. `admitPrepareEnvironment` later recomputes `digestExecutionScope(authorization.scope)`
 * and compares it to the approval's `evidenceDigest`, which is why a scope carrying a freshly
 * minted environment id fails a perfectly valid approval.
 *
 * Nothing here writes: the caller commits the returned appends and jobs under the returned
 * idempotency descriptor, so a refusal necessarily precedes any durable record.
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
  const occurredAt = dependencies.now();
  // `decideApproval` owns eligibility, conflict and evidence matching. Passing the re-derived scope
  // as the evidence is what makes it check the scope side of freshness for us.
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
  const evidence = await sealPlanApprovalEvidence(command, occurredAt);
  const authorization = await authorizeEnvironment(command, dependencies, scopeDigest, occurredAt);
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
      event("pipeline.evidence_recorded", {
        runId: run.id,
        jobId,
        attempt: 1,
        evidence
      }),
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
