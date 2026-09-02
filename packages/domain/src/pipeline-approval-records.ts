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
/**
 * The digest domain for a `PipelineEvidence` envelope. Exported because `station-kernel.ts` seals
 * every envelope with it and this module must reproduce those digests exactly — two copies of the
 * string would let the two drift silently, and the whole approval chain is digest equality.
 * `packages/workflow` depends on `packages/domain`, so the shared constant lives here and the
 * kernel imports it; the reverse direction is not available.
 */
export const PIPELINE_EVIDENCE_DIGEST_DOMAIN = "autostack.pipeline-evidence";

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
/**
 * How long an environment authorization stays usable, in milliseconds.
 *
 * Nothing in the contracts constrains this beyond `expiresAt > createdAt`, so it is a local
 * operational policy rather than a contract shape — which is exactly why it is a named, injectable
 * default rather than an inline literal. The failure it governs is unpleasant: a run that sits
 * queued past the window fails provisioning on a *valid* approval, which reads as a stale-approval
 * error with no stale approval. Composition should set it deliberately (plan Task 16).
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
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PlanApprovalEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

export interface EnvironmentAuthorizationInput {
  readonly id: EnvironmentAuthorizationId;
  readonly approvalId: ApprovalId;
  /** `digestExecutionScope(scope)`, which must equal the approval's own `evidenceDigest`. */
  readonly approvalEvidenceDigest: string;
  readonly scope: ExecutionScope;
  readonly createdAt: string;
  /** Overrides `ENVIRONMENT_AUTHORIZATION_TTL_MS`. Composition should set it deliberately. */
  readonly ttlMs?: number;
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
    expiresAt: futureTimestamp(input.createdAt, input.ttlMs ?? ENVIRONMENT_AUTHORIZATION_TTL_MS),
    digest: PLACEHOLDER_DIGEST
  };
  return EnvironmentAuthorizationSchema.parse({
    ...draft,
    digest: await digestEnvironmentAuthorization(draft)
  });
};
