import {
  AgentSessionIdSchema,
  ApprovalIdSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  digestPlanDocument,
  digestPublishScope,
  digestReviewReport,
  digestVerificationReport,
  type PlanDocument,
  type PublicationEvidenceBundle,
  type ReviewReport,
  type TriageReport,
  type VerificationCommand,
  type VerificationReport
} from "@autostack/contracts";

/**
 * A real `PublicationEvidenceBundle` plus the four station reports it is composed from, built so
 * that `admitPublicationEvidenceBundle` actually passes -- every digest below is computed with the
 * contracts' own helpers, never hand-written hex, except the arbitrary envelope `evidenceDigest`
 * values that the schema never recomputes (see the research note this fixture follows).
 *
 * Two ways to break a link on purpose, both supported deliberately:
 *  1. Pass an `overrides.*` field -- it is merged in BEFORE any digest is computed, so the result
 *     stays internally self-consistent (e.g. `overrides.plan.summary` still yields a `planDigest`
 *     that matches the edited plan).
 *  2. Spread the returned plain object in the test itself and change a digest field directly (e.g.
 *     `{ ...bundle, plan: { ...bundle.plan, planDigest: "bad".repeat(...) } }`) -- this deliberately
 *     produces an inconsistent bundle/report pair for a mismatch test.
 */

type DeepPartial<T> = T extends readonly (infer _Item)[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepMergeUnknown = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return base;
  if (Array.isArray(override)) return override;
  if (isPlainRecord(base) && isPlainRecord(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      merged[key] = deepMergeUnknown(base[key], override[key]);
    }
    return merged;
  }
  return override;
};

function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  return deepMergeUnknown(base, override) as T;
}

const IDENTITY = {
  workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000"),
  workItemId: WorkItemIdSchema.parse("wi_123e4567-e89b-42d3-a456-426614174000"),
  runId: RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000")
};

const AGENT_SESSION = {
  implementation: AgentSessionIdSchema.parse("agt_123e4567-e89b-42d3-a456-426614174000"),
  reviewer: AgentSessionIdSchema.parse("agt_123e4567-e89b-42d3-a456-426614174001")
};

const ENVIRONMENT = {
  implementation: EnvironmentIdSchema.parse("env_123e4567-e89b-42d3-a456-426614174000"),
  reviewer: EnvironmentIdSchema.parse("env_123e4567-e89b-42d3-a456-426614174001")
};

const APPROVAL = {
  plan: ApprovalIdSchema.parse("apr_123e4567-e89b-42d3-a456-426614174000"),
  publish: ApprovalIdSchema.parse("apr_123e4567-e89b-42d3-a456-426614174001")
};

/** Deterministic 64-hex synthetic digest. `seed` must be hex characters; it is repeated to fill. */
const hex = (seed: string): string => seed.repeat(64).slice(0, 64);

const PLACEHOLDER_DIGEST = "0".repeat(64);
const FINAL_DIFF_DIGEST = hex("f");

const EVIDENCE_DIGEST = {
  plan: hex("1"),
  planApproval: hex("2"),
  implementation: hex("3"),
  verification: hex("4"),
  review: hex("5"),
  publishApproval: hex("7")
} as const;

const TIMESTAMP = {
  triage: "2026-08-23T11:55:00.000Z",
  planDocument: "2026-08-23T11:58:00.000Z",
  planEvidence: "2026-08-23T12:00:00.000Z",
  planApproval: "2026-08-23T12:01:00.000Z",
  implementation: "2026-08-23T12:02:00.000Z",
  verificationReport: "2026-08-23T12:02:30.000Z",
  verificationEvidence: "2026-08-23T12:03:00.000Z",
  reviewReport: "2026-08-23T12:03:30.000Z",
  reviewEvidence: "2026-08-23T12:04:00.000Z",
  publishScope: "2026-08-23T12:05:00.000Z",
  publishApproval: "2026-08-23T12:06:00.000Z"
} as const;

const REPOSITORY_FULL_NAME = "autostack/factory";
const BASE_REF = "main";
const HEAD_REF = "autostack/issue-42";

const DEFAULT_VERIFICATION_COMMAND: VerificationCommand = {
  executable: "pnpm",
  args: ["test"],
  usesShell: false,
  required: true
};

export interface PublicationEvidencePublishScopeFields {
  readonly repositoryFullName: string;
  readonly base: string;
  readonly head: string;
  readonly finalDiffDigest: string;
}

export interface PublicationEvidenceFixture {
  readonly bundle: PublicationEvidenceBundle;
  readonly triage: TriageReport;
  readonly plan: PlanDocument;
  readonly verification: VerificationReport;
  readonly review: ReviewReport;
  readonly publishScopeFields: PublicationEvidencePublishScopeFields;
}

export interface PublicationEvidenceOverrides {
  /** Overrides applied to the triage station report before it is used (identity, prose, etc). */
  readonly triage?: DeepPartial<TriageReport>;
  /** Overrides applied to the plan document's content; `planDigest` is always recomputed after. */
  readonly plan?: DeepPartial<Omit<PlanDocument, "planDigest">>;
  /** Overrides applied to the verification report's content. */
  readonly verification?: DeepPartial<VerificationReport>;
  /** Overrides applied to the review report's content. */
  readonly review?: DeepPartial<ReviewReport>;
  /** Overrides applied to the publish scope's non-digest fields before `scopeDigest` is computed. */
  readonly publishScope?: DeepPartial<
    Pick<PublicationEvidencePublishScopeFields, "repositoryFullName" | "base" | "head">
  >;
  /** `bundle.verification.status`; defaults to `"passed"`. */
  readonly verificationStatus?: "passed" | "failed";
  /**
   * `bundle.review.reviewReportDigest`. `"auto"` (default) computes the real digest of the review
   * report; `"omit"` leaves the optional field unset so the `reviewedDiffDigest` fallback is
   * exercised; any other value is used verbatim, which is how a test breaks that link on purpose.
   */
  readonly bundleReviewReportDigest?: "auto" | "omit" | string;
  /** `bundle.plan.planDigest`, verbatim. Defaults to the real `digestPlanDocument(plan)`. */
  readonly bundlePlanDigest?: string;
}

const defaultTriageReport = (): TriageReport => ({
  schemaVersion: 1,
  ...IDENTITY,
  taskType: "bug",
  priority: "normal",
  complexity: "small",
  actionable: true,
  rationale:
    "Users report the export button silently fails for workspaces created before the v2 migration.",
  duplicates: [],
  producedAt: TIMESTAMP.triage
});

const buildPlanDraft = (): Omit<PlanDocument, "planDigest"> => ({
  schemaVersion: 1,
  ...IDENTITY,
  summary: "Restore export-button availability for pre-v2 workspaces by backfilling the flag.",
  acceptanceCriteria: [
    "Export button is visible for pre-v2 workspaces.",
    "Existing export tests still pass."
  ],
  affectedAreas: ["packages/web/src/export"],
  risks: [],
  verificationCommands: [DEFAULT_VERIFICATION_COMMAND],
  requiredPermissions: [],
  requiredCredentialRefIds: [],
  producedAt: TIMESTAMP.planDocument
});

export const buildPublicationEvidenceFixture = async (
  overrides: PublicationEvidenceOverrides = {}
): Promise<PublicationEvidenceFixture> => {
  const triage = deepMerge<TriageReport>(defaultTriageReport(), overrides.triage);

  const planDraft = deepMerge<Omit<PlanDocument, "planDigest">>(buildPlanDraft(), overrides.plan);
  const planWithPlaceholder: PlanDocument = { ...planDraft, planDigest: PLACEHOLDER_DIGEST };
  const planDigestValue = await digestPlanDocument(planWithPlaceholder);
  const plan: PlanDocument = { ...planDraft, planDigest: planDigestValue };

  const verificationDraft: VerificationReport = {
    schemaVersion: 1,
    ...IDENTITY,
    planDigest: plan.planDigest,
    status: "passed",
    results: [
      {
        command: DEFAULT_VERIFICATION_COMMAND,
        status: "passed",
        exitCode: 0,
        durationMs: 1_250,
        startedAt: TIMESTAMP.verificationReport,
        outputDigest: hex("d")
      }
    ],
    producedAt: TIMESTAMP.verificationReport
  };
  const verification = deepMerge<VerificationReport>(verificationDraft, overrides.verification);

  const reviewDraft: ReviewReport = {
    schemaVersion: 1,
    ...IDENTITY,
    planDigest: plan.planDigest,
    reviewedDiffDigest: FINAL_DIFF_DIGEST,
    verificationReportDigest: await digestVerificationReport(verification),
    verdict: "approved",
    summary: "Confirmed the backfill restores visibility without regressing existing coverage.",
    findings: [],
    producedAt: TIMESTAMP.reviewReport
  };
  const review = deepMerge<ReviewReport>(reviewDraft, overrides.review);

  const publishScopeContent = deepMerge<
    Pick<PublicationEvidencePublishScopeFields, "repositoryFullName" | "base" | "head">
  >(
    { repositoryFullName: REPOSITORY_FULL_NAME, base: BASE_REF, head: HEAD_REF },
    overrides.publishScope
  );
  const publishScopeDraft = {
    schemaVersion: 1 as const,
    ...IDENTITY,
    repositoryFullName: publishScopeContent.repositoryFullName,
    base: publishScopeContent.base,
    head: publishScopeContent.head,
    finalDiffDigest: FINAL_DIFF_DIGEST,
    action: "create_draft_pr" as const,
    scopeDigest: PLACEHOLDER_DIGEST,
    createdAt: TIMESTAMP.publishScope
  };
  const scopeDigest = await digestPublishScope(publishScopeDraft);
  const publishScope = { ...publishScopeDraft, scopeDigest };

  const bundlePlanDigest = overrides.bundlePlanDigest ?? (await digestPlanDocument(plan));

  const reviewReportDigestSetting = overrides.bundleReviewReportDigest ?? "auto";
  const reviewReportDigest =
    reviewReportDigestSetting === "omit"
      ? undefined
      : reviewReportDigestSetting === "auto"
        ? await digestReviewReport(review)
        : reviewReportDigestSetting;

  const bundle: PublicationEvidenceBundle = {
    schemaVersion: 1,
    ...IDENTITY,
    plan: {
      schemaVersion: 1,
      ...IDENTITY,
      stage: "plan",
      evidenceDigest: EVIDENCE_DIGEST.plan,
      artifactIds: [],
      producedAt: TIMESTAMP.planEvidence,
      planDigest: bundlePlanDigest
    },
    planApproval: {
      schemaVersion: 1,
      ...IDENTITY,
      stage: "plan_approval",
      evidenceDigest: EVIDENCE_DIGEST.planApproval,
      artifactIds: [],
      producedAt: TIMESTAMP.planApproval,
      approvalId: APPROVAL.plan,
      decision: "approved",
      approvedEvidenceDigest: EVIDENCE_DIGEST.plan,
      actorId: "local-user"
    },
    implementation: {
      schemaVersion: 1,
      ...IDENTITY,
      stage: "implement",
      evidenceDigest: EVIDENCE_DIGEST.implementation,
      artifactIds: [],
      producedAt: TIMESTAMP.implementation,
      planApprovalEvidenceDigest: EVIDENCE_DIGEST.planApproval,
      agentSessionId: AGENT_SESSION.implementation,
      environmentId: ENVIRONMENT.implementation,
      sourceCommit: "a".repeat(40),
      resultCommit: "b".repeat(40),
      finalDiffDigest: FINAL_DIFF_DIGEST
    },
    verification: {
      schemaVersion: 1,
      ...IDENTITY,
      stage: "verify",
      evidenceDigest: EVIDENCE_DIGEST.verification,
      artifactIds: [],
      producedAt: TIMESTAMP.verificationEvidence,
      implementationEvidenceDigest: EVIDENCE_DIGEST.implementation,
      status: overrides.verificationStatus ?? "passed"
    },
    review: {
      schemaVersion: 1,
      ...IDENTITY,
      stage: "isolated_review",
      evidenceDigest: EVIDENCE_DIGEST.review,
      artifactIds: [],
      producedAt: TIMESTAMP.reviewEvidence,
      implementationEvidenceDigest: EVIDENCE_DIGEST.implementation,
      verificationEvidenceDigest: EVIDENCE_DIGEST.verification,
      reviewedDiffDigest: FINAL_DIFF_DIGEST,
      implementation: {
        agentSessionId: AGENT_SESSION.implementation,
        environmentId: ENVIRONMENT.implementation
      },
      reviewer: {
        agentSessionId: AGENT_SESSION.reviewer,
        environmentId: ENVIRONMENT.reviewer
      },
      ...(reviewReportDigest === undefined ? {} : { reviewReportDigest }),
      verdict: "approved",
      findings: []
    },
    publishScope,
    publishApproval: {
      schemaVersion: 1,
      ...IDENTITY,
      stage: "publish_approval",
      evidenceDigest: EVIDENCE_DIGEST.publishApproval,
      artifactIds: [],
      producedAt: TIMESTAMP.publishApproval,
      approvalId: APPROVAL.publish,
      decision: "approved",
      approvedEvidenceDigest: scopeDigest,
      reviewEvidenceDigest: EVIDENCE_DIGEST.review,
      publishScopeDigest: scopeDigest,
      actorId: "local-user"
    }
  };

  return {
    bundle,
    triage,
    plan,
    verification,
    review,
    publishScopeFields: {
      repositoryFullName: publishScope.repositoryFullName,
      base: publishScope.base,
      head: publishScope.head,
      finalDiffDigest: publishScope.finalDiffDigest
    }
  };
};
