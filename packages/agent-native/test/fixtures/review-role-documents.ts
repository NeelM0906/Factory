import {
  PlanDocumentSchema,
  VerificationReportSchema,
  digestPlanDocument,
  type PlanDocument,
  type VerificationReport
} from "@autostack/contracts";

import type { ReviewRoleDocuments } from "../../src/native-harness.js";

/**
 * The reviewer's typed inputs (T10), shared by every suite that starts a review session: a REAL
 * self-digest-admissible plan document, a verification report bound to it, and the reviewed diff
 * descriptor. The documents must carry the SAME run identity as the invocation that starts the
 * session, because the review role admits its inputs against the invocation BEFORE the model call
 * and fails the session closed otherwise.
 */
export interface ReviewDocumentsIdentity {
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly runId: string;
}

export const REVIEWED_DIFF_DIGEST = "5".repeat(64);
export const REVIEWED_DIFF_PATHS: readonly string[] = ["packages/checkout/src/totals.ts"];

export const buildInputPlanDocument = async (
  identity: ReviewDocumentsIdentity
): Promise<PlanDocument> => {
  const canonicalSource = PlanDocumentSchema.parse({
    schemaVersion: 1,
    ...identity,
    summary: "Sum the checkout line items first and round the discounted total once.",
    acceptanceCriteria: ["Invoice totals equal the sum of line items to the cent."],
    affectedAreas: ["packages/checkout/src/totals.ts"],
    risks: [],
    verificationCommands: [
      { executable: "pnpm", args: ["test"], usesShell: false, required: true }
    ],
    requiredPermissions: [],
    requiredCredentialRefIds: [],
    producedAt: "2026-08-26T00:10:00.000Z",
    planDigest: "0".repeat(64)
  });
  const planDigest = await digestPlanDocument(canonicalSource);
  return PlanDocumentSchema.parse({ ...canonicalSource, planDigest });
};

export const buildInputVerificationReport = (plan: PlanDocument): VerificationReport =>
  VerificationReportSchema.parse({
    schemaVersion: 1,
    workspaceId: plan.workspaceId,
    workItemId: plan.workItemId,
    runId: plan.runId,
    planDigest: plan.planDigest,
    status: "passed",
    results: [
      {
        command: { executable: "pnpm", args: ["test"], usesShell: false, required: true },
        status: "passed",
        exitCode: 0,
        durationMs: 1_240,
        startedAt: "2026-08-26T00:20:00.000Z",
        outputDigest: "4".repeat(64)
      }
    ],
    producedAt: "2026-08-26T00:21:00.000Z"
  });

export const buildReviewRoleDocuments = async (
  identity: ReviewDocumentsIdentity
): Promise<ReviewRoleDocuments> => {
  const plan = await buildInputPlanDocument(identity);
  return {
    kind: "review_documents",
    plan,
    verification: buildInputVerificationReport(plan),
    reviewedDiff: { digest: REVIEWED_DIFF_DIGEST, paths: [...REVIEWED_DIFF_PATHS] }
  };
};
