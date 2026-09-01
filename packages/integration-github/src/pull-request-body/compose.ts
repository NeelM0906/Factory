import {
  DraftPullRequestBodySchema,
  TriageReportSchema,
  admitPlanDocument,
  admitReviewReport,
  admitTriageReport,
  admitVerificationReport,
  digestPlanDocument,
  digestReviewReport,
  type DraftPullRequestBody,
  type PlanDocument,
  type PublicationEvidenceBundle,
  type ReviewReport,
  type TriageReport,
  type VerificationReport
} from "@autostack/contracts";

import { DraftPullRequestBodyMismatchError } from "../errors.js";

/** Inputs for the spec §4.4 draft pull-request body: the publication evidence bundle plus the
 * station reports it does not itself carry prose for (decision D3). */
export interface DraftPullRequestBodyInput {
  readonly bundle: PublicationEvidenceBundle;
  readonly triage: TriageReport;
  readonly plan: PlanDocument;
  readonly verification: VerificationReport;
  readonly review: ReviewReport;
  readonly changeSummary: string;
  readonly runUrl: string;
  /**
   * The digest the triage report was recorded under, if one exists. `PublicationEvidenceBundle`
   * carries no triage member to bind against (escalation E-8), so this is the only cryptographic tie
   * available for the problem statement; when absent the problem statement is caller-attested.
   */
  readonly triageReportDigest?: string;
}

/**
 * Required-command lines shown in the verification summary before an elision line takes over. A
 * plan's `verificationCommands` (and therefore a verification report's `results`) is capped at 50 by
 * the contract schema, but a single command's `args` can still be large enough to blow the summary's
 * 20,000-character ceiling -- so bounding is by rendered-item count, independent of that cap.
 */
const MAX_VERIFICATION_SUMMARY_LINES = 20;

/**
 * `DraftPullRequestBodySchema.knownLimitations` is capped at 50 entries by the contract schema, but
 * a review report can carry up to 500 findings. One slot is reserved for the elision line whenever
 * truncation is needed, so at most 49 real entries are ever shown.
 */
const MAX_KNOWN_LIMITATIONS = 50;

const NON_BLOCKING_SEVERITY_RANK: Readonly<Record<string, number>> = {
  medium: 0,
  low: 1,
  info: 2
};

const isNonBlockingSeverity = (severity: string): boolean => severity in NON_BLOCKING_SEVERITY_RANK;

const buildVerificationSummary = (verification: VerificationReport): string => {
  const requiredResults = verification.results.filter((result) => result.command.required);
  const shown = requiredResults.slice(0, MAX_VERIFICATION_SUMMARY_LINES);
  const remaining = requiredResults.length - shown.length;

  const lines = shown.map((result) => {
    const exit = result.exitCode === undefined ? "n/a" : String(result.exitCode);
    return `- \`${result.command.executable}\`: status ${result.status}, exit ${exit}, ${result.durationMs}ms`;
  });

  if (remaining > 0) {
    lines.push(`_${remaining} further commands not shown._`);
  }

  return lines.length === 0 ? "No required verification commands were recorded." : lines.join("\n");
};

const buildKnownLimitations = (review: ReviewReport): readonly string[] => {
  const nonBlocking = review.findings
    .filter((finding) => isNonBlockingSeverity(finding.severity))
    .slice()
    .sort(
      (left, right) =>
        (NON_BLOCKING_SEVERITY_RANK[left.severity] ?? 0) -
        (NON_BLOCKING_SEVERITY_RANK[right.severity] ?? 0)
    );

  if (nonBlocking.length <= MAX_KNOWN_LIMITATIONS) {
    return nonBlocking.map((finding) => finding.summary);
  }

  const shown = nonBlocking.slice(0, MAX_KNOWN_LIMITATIONS - 1);
  const remaining = nonBlocking.length - shown.length;
  return [...shown.map((finding) => finding.summary), `_${remaining} further findings not shown._`];
};

interface StationIdentity {
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly runId: string;
}

const assertSameIdentity = (
  bundle: PublicationEvidenceBundle,
  triage: StationIdentity,
  plan: StationIdentity,
  verification: StationIdentity,
  review: StationIdentity
): void => {
  const subjects: ReadonlyArray<readonly [string, StationIdentity]> = [
    ["triage", triage],
    ["plan", plan],
    ["verification", verification],
    ["review", review]
  ];
  for (const [name, document] of subjects) {
    if (
      document.workspaceId !== bundle.workspaceId ||
      document.workItemId !== bundle.workItemId ||
      document.runId !== bundle.runId
    ) {
      throw new DraftPullRequestBodyMismatchError(`${name}.identity`);
    }
  }
};

/**
 * Composes the spec §4.4 draft pull-request body from a real `PublicationEvidenceBundle` plus the
 * station reports it does not carry prose for (decision D3). Every station report is admitted
 * through the contracts' own admission functions before anything is read from it -- a report whose
 * self-digest does not recompute is rejected by admission, never by a hand-rolled shape check.
 */
export const composeDraftPullRequestBody = async (
  input: DraftPullRequestBodyInput
): Promise<DraftPullRequestBody> => {
  const { bundle, triage, plan, verification, review, changeSummary, runUrl, triageReportDigest } =
    input;

  const admittedTriage =
    triageReportDigest === undefined
      ? TriageReportSchema.parse(triage)
      : await admitTriageReport(triage, triageReportDigest);
  const admittedPlan = await admitPlanDocument(plan);
  const admittedVerification = await admitVerificationReport(verification, plan);
  // `admitReviewReport` re-admits `plan` and `verification` itself; it also enforces
  // `review.verificationReportDigest === digestVerificationReport(verification)` (D3 link 4) as part
  // of admission, so a mismatch there surfaces here as the contract's own admission error.
  const admittedReview = await admitReviewReport(review, plan, verification);

  assertSameIdentity(bundle, admittedTriage, admittedPlan, admittedVerification, admittedReview);

  if (bundle.verification.status !== "passed") {
    throw new DraftPullRequestBodyMismatchError("verification.status");
  }
  if (admittedReview.verdict !== "approved") {
    throw new DraftPullRequestBodyMismatchError("review.verdict");
  }

  // D3 link 1: the rendered plan is the approved plan.
  if ((await digestPlanDocument(admittedPlan)) !== bundle.plan.planDigest) {
    throw new DraftPullRequestBodyMismatchError("plan.planDigest");
  }

  // D3 links 2/3: when the bundle names a review-report digest it is the primary binding; otherwise
  // the weaker reviewedDiffDigest link is the fallback. Never both -- an optional binding that is
  // present is authoritative over the field it strengthens.
  if (bundle.review.reviewReportDigest !== undefined) {
    if ((await digestReviewReport(admittedReview)) !== bundle.review.reviewReportDigest) {
      throw new DraftPullRequestBodyMismatchError("review.reviewReportDigest");
    }
  } else if (admittedReview.reviewedDiffDigest !== bundle.review.reviewedDiffDigest) {
    throw new DraftPullRequestBodyMismatchError("review.reviewedDiffDigest");
  }

  return DraftPullRequestBodySchema.parse({
    schemaVersion: 1,
    problemStatement: admittedTriage.rationale,
    approvedPlanDigest: bundle.plan.planDigest,
    approvedPlanSummary: admittedPlan.summary,
    changeSummary,
    verificationSummary: buildVerificationSummary(admittedVerification),
    reviewVerdict: "approved",
    knownLimitations: buildKnownLimitations(admittedReview),
    runUrl
  });
};
