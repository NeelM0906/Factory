import {
  EnvironmentAuthorizationSchema,
  PlanApprovalEvidenceSchema,
  digestEnvironmentAuthorization,
  digestVersionedValue,
  type ApprovalId,
  type EnvironmentAuthorization,
  type EnvironmentAuthorizationId,
  type ExecutionScope,
  type PipelineEvidence,
  type RunId,
  type WorkItemId,
  type WorkspaceId
} from "@autostack/contracts";

/**
 * The two durable records an approved plan decision mints. They live apart from the decision
 * because they are sealed values with their own digest rules — get either digest wrong and
 * `admitPrepareEnvironment` refuses a perfectly valid approval — while the decision itself is
 * ordinary control flow.
 */

export type PlanApprovalEvidence = Extract<PipelineEvidence, { stage: "plan_approval" }>;

/**
 * The digest domain a `PipelineEvidence` envelope is sealed under. It must be the string
 * `createStationKernel` uses (`packages/workflow/src/stations/station-kernel.ts`), because the
 * publication bundle chains implementation evidence to *this* envelope's digest, and a station that
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
export const ENVIRONMENT_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1_000;

/** Derived from the injected clock, never read from one: `from` is always `dependencies.now()`. */
export const futureTimestamp = (from: string, milliseconds: number): string => {
  const parsed = Date.parse(from);
  if (Number.isNaN(parsed)) throw new TypeError("A decision needs a parseable timestamp.");
  return new Date(parsed + milliseconds).toISOString();
};

export interface PlanApprovalEvidenceInput {
  readonly workspaceId: WorkspaceId;
  readonly workItemId: WorkItemId;
  readonly runId: RunId;
  readonly approvalId: ApprovalId;
  /** The plan evidence a human decided over — the binding that makes the approval specific. */
  readonly approvedEvidenceDigest: string;
  readonly actorId: string;
  readonly producedAt: string;
}

export const sealPlanApprovalEvidence = async (
  input: PlanApprovalEvidenceInput
): Promise<PlanApprovalEvidence> => {
  const envelope = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    workItemId: input.workItemId,
    runId: input.runId,
    stage: "plan_approval",
    artifactIds: [],
    approvalId: input.approvalId,
    decision: "approved",
    approvedEvidenceDigest: input.approvedEvidenceDigest,
    actorId: input.actorId,
    producedAt: input.producedAt
  };
  const evidenceDigest = await digestVersionedValue(EVIDENCE_DIGEST_DOMAIN, envelope);
  return PlanApprovalEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

export interface EnvironmentAuthorizationInput {
  readonly id: EnvironmentAuthorizationId;
  readonly approvalId: ApprovalId;
  /** `digestExecutionScope(scope)`, which must equal the approval's own `evidenceDigest`. */
  readonly approvalEvidenceDigest: string;
  readonly scope: ExecutionScope;
  readonly createdAt: string;
}

export const authorizeEnvironment = async (
  input: EnvironmentAuthorizationInput
): Promise<EnvironmentAuthorization> => {
  const draft = {
    id: input.id,
    approvalId: input.approvalId,
    approvalEvidenceDigest: input.approvalEvidenceDigest,
    scope: input.scope,
    createdAt: input.createdAt,
    expiresAt: futureTimestamp(input.createdAt, ENVIRONMENT_AUTHORIZATION_TTL_MS),
    digest: PLACEHOLDER_DIGEST
  };
  return EnvironmentAuthorizationSchema.parse({
    ...draft,
    digest: await digestEnvironmentAuthorization(draft)
  });
};
