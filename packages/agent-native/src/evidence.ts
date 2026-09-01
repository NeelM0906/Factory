import {
  ReviewReportSchema,
  admitPlanDocument,
  admitTriageReport,
  digestPlanDocument,
  digestReviewReport,
  digestTriageReport,
  type PlanDocument,
  type ReviewReport,
  type TriageReport
} from "@autostack/contracts";

/**
 * Evidence wrappers for the native station roles: THIN delegations to the digest and admission
 * helpers in `@autostack/contracts` (station-evidence). This module deliberately defines NO
 * canonicalization of its own — the contracts helpers are the single canonical authority, so a
 * digest computed through here can never drift from one computed anywhere else in the system.
 */

/** Digests a triage report under the contracts' canonical form — `producedBy` INCLUDED (0.12). */
export const digestTriageEvidence = (report: TriageReport): Promise<string> =>
  digestTriageReport(report);

/**
 * Admits a triage report against the digest it was recorded under — the TWO-argument
 * digest-compare form, since triage is the first station and has no upstream document to bind to.
 */
export const admitTriageEvidence = (
  report: unknown,
  expectedDigest: string
): Promise<TriageReport> => admitTriageReport(report, expectedDigest);

/**
 * Digests a plan document under the contracts' canonical form — `producedBy` and `producedAt`
 * EXCLUDED (0.12), the exact opposite of the triage and review rules: the digest measures the
 * approved content, so a prompt bump must not revoke an outstanding plan approval.
 */
export const digestPlanEvidence = (document: PlanDocument): Promise<string> =>
  digestPlanDocument(document);

/**
 * Admits a plan document through the ONE-argument contracts admission, which recomputes the
 * digest from the canonical fields and rejects a mismatch — the plan binds to its own
 * self-`planDigest`, not to an upstream document.
 */
export const admitPlanEvidence = (document: unknown): Promise<PlanDocument> =>
  admitPlanDocument(document);

/** Digests a review report under the contracts' canonical form — `producedBy` INCLUDED (0.12). */
export const digestReviewEvidence = (report: ReviewReport): Promise<string> =>
  digestReviewReport(report);

/**
 * Admits a review report against the digest it was recorded under — the TWO-argument
 * digest-compare form, like triage. The THREE-argument transitive contracts admission
 * (`admitReviewReport`) needs the upstream plan and verification report, which live where the
 * role inputs live: `admitRoleInputs` before the model call and `buildDocument` at assembly. The
 * registry's gate re-checks only that this is the exact report the completion recorded.
 */
export const admitReviewEvidence = async (
  report: unknown,
  expectedDigest: string
): Promise<ReviewReport> => {
  const admitted = ReviewReportSchema.parse(report);
  if ((await digestReviewReport(admitted)) !== expectedDigest) {
    throw new TypeError("Review report does not match the digest it was recorded under.");
  }
  return admitted;
};
