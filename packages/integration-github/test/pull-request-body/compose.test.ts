import { describe, expect, it } from "vitest";

import {
  DraftPullRequestBodySchema,
  admitPublicationEvidenceBundle,
  digestTriageReport,
  type ReviewFinding,
  type VerificationCommand,
  type VerificationResult
} from "@autostack/contracts";

import { DraftPullRequestBodyMismatchError } from "../../src/errors.js";
import {
  type DraftPullRequestBodyInput,
  composeDraftPullRequestBody
} from "../../src/pull-request-body/compose.js";
import {
  buildPublicationEvidenceFixture,
  type PublicationEvidenceFixture,
  type PublicationEvidenceOverrides
} from "../fixtures/publication-evidence.js";

const RUN_URL = "https://factory.local/runs/run_123e4567-e89b-42d3-a456-426614174000";
const CHANGE_SUMMARY = "Backfilled the export-visibility flag for pre-v2 workspaces.";
const hex = (seed: string): string => seed.repeat(64).slice(0, 64);

const toInput = (fixture: PublicationEvidenceFixture): DraftPullRequestBodyInput => ({
  bundle: fixture.bundle,
  triage: fixture.triage,
  plan: fixture.plan,
  verification: fixture.verification,
  review: fixture.review,
  changeSummary: CHANGE_SUMMARY,
  runUrl: RUN_URL
});

const build = async (
  overrides?: PublicationEvidenceOverrides
): Promise<DraftPullRequestBodyInput> => toInput(await buildPublicationEvidenceFixture(overrides));

describe("composeDraftPullRequestBody", () => {
  it("produces a schema-valid body from a genuinely admitted publication evidence bundle", async () => {
    const fixture = await buildPublicationEvidenceFixture();
    const body = await composeDraftPullRequestBody(toInput(fixture));

    expect(() => DraftPullRequestBodySchema.parse(body)).not.toThrow();
    expect(body.problemStatement).toBe(fixture.triage.rationale);
    expect(body.approvedPlanDigest).toBe(fixture.bundle.plan.planDigest);
    expect(body.approvedPlanSummary).toBe(fixture.plan.summary);
    expect(body.verificationSummary).toContain("pnpm");
    expect(body.verificationSummary).toContain("exit 0");
    expect(body.verificationSummary).toContain("1250ms");
    expect(body.reviewVerdict).toBe("approved");
    expect(body.knownLimitations).toEqual([]);
    expect(body.changeSummary).toBe(CHANGE_SUMMARY);
    expect(body.runUrl).toBe(RUN_URL);
  });

  it("admits the plan document through the contract's own admission, not a hand-rolled check", async () => {
    const input = await build();
    const tamperedPlan = { ...input.plan, summary: "A different, unapproved plan summary." };

    await expect(composeDraftPullRequestBody({ ...input, plan: tamperedPlan })).rejects.toThrow(
      /plan document digest/i
    );
  });

  it("admits the verification report through the contract's own admission", async () => {
    const input = await build();
    const tamperedVerification = { ...input.verification, planDigest: hex("9") };

    await expect(
      composeDraftPullRequestBody({ ...input, verification: tamperedVerification })
    ).rejects.toThrow(/not bound to this plan document/i);
  });

  it("admits the review report through the contract's own admission", async () => {
    const input = await build();
    const tamperedReview = { ...input.review, planDigest: hex("9") };

    await expect(composeDraftPullRequestBody({ ...input, review: tamperedReview })).rejects.toThrow(
      /not bound to this plan document/i
    );
  });

  it("admits the triage report against its recorded digest when one is supplied", async () => {
    const input = await build();
    const triageReportDigest = await digestTriageReport(input.triage);
    const tamperedTriage = { ...input.triage, rationale: "A different, unrecorded rationale." };

    await expect(
      composeDraftPullRequestBody({ ...input, triage: tamperedTriage, triageReportDigest })
    ).rejects.toThrow(/does not match the digest/i);
  });

  it("rejects inputs whose identity does not match across the four reports and the bundle", async () => {
    const fixture = await buildPublicationEvidenceFixture({
      triage: { runId: "run_123e4567-e89b-42d3-a456-426614174099" }
    });

    await expect(composeDraftPullRequestBody(toInput(fixture))).rejects.toThrow(
      DraftPullRequestBodyMismatchError
    );
  });

  it("rejects a plan whose digest does not match the bundle's plan.planDigest (link 1)", async () => {
    const fixture = await buildPublicationEvidenceFixture({ bundlePlanDigest: hex("9") });

    await expect(composeDraftPullRequestBody(toInput(fixture))).rejects.toThrow(
      DraftPullRequestBodyMismatchError
    );
  });

  it("rejects a mismatched reviewReportDigest even when reviewedDiffDigest still agrees (link 2)", async () => {
    const fixture = await buildPublicationEvidenceFixture({
      bundleReviewReportDigest: hex("9")
    });
    // Positive control: the weaker fallback link still agrees, so only the primary link can fail.
    expect(fixture.review.reviewedDiffDigest).toBe(fixture.bundle.review.reviewedDiffDigest);

    await expect(composeDraftPullRequestBody(toInput(fixture))).rejects.toThrow(
      DraftPullRequestBodyMismatchError
    );
  });

  it("composes successfully on the reviewedDiffDigest fallback when reviewReportDigest is absent", async () => {
    const fixture = await buildPublicationEvidenceFixture({ bundleReviewReportDigest: "omit" });
    expect(fixture.bundle.review.reviewReportDigest).toBeUndefined();

    const body = await composeDraftPullRequestBody(toInput(fixture));
    expect(body.reviewVerdict).toBe("approved");
  });

  it("rejects a stale reviewedDiffDigest on the fallback path (link 3)", async () => {
    const fixture = await buildPublicationEvidenceFixture({
      bundleReviewReportDigest: "omit",
      review: { reviewedDiffDigest: hex("9") }
    });

    await expect(composeDraftPullRequestBody(toInput(fixture))).rejects.toThrow(
      DraftPullRequestBodyMismatchError
    );
  });

  // Link 4 (review.verificationReportDigest === digestVerificationReport(verification)) is enforced
  // by `admitReviewReport` itself -- by the time admission succeeds, the link already holds, so
  // there is nothing left for the composer to check. A tampered digest is therefore rejected by
  // admission's own error, not by DraftPullRequestBodyMismatchError; wrapping it would just be a
  // hand-rolled restatement of a check the contract already performs.
  it("rejects a stale verificationReportDigest via the contract's own review admission (link 4)", async () => {
    const input = await build();
    const tamperedReview = { ...input.review, verificationReportDigest: hex("9") };

    await expect(composeDraftPullRequestBody({ ...input, review: tamperedReview })).rejects.toThrow(
      /stale for this verification report/i
    );
  });

  it("rejects a bundle with a failed verification, both at admission and at composition", async () => {
    const fixture = await buildPublicationEvidenceFixture({ verificationStatus: "failed" });

    await expect(admitPublicationEvidenceBundle(fixture.bundle)).rejects.toThrow();
    await expect(composeDraftPullRequestBody(toInput(fixture))).rejects.toThrow(
      DraftPullRequestBodyMismatchError
    );
  });

  it("refuses to compose a body claiming an approval the review does not grant", async () => {
    const fixture = await buildPublicationEvidenceFixture({
      review: { verdict: "changes_requested" }
    });

    await expect(composeDraftPullRequestBody(toInput(fixture))).rejects.toThrow(
      DraftPullRequestBodyMismatchError
    );
  });

  it("throws rather than silently slicing a plan summary over the schema maximum", async () => {
    const input = await build();
    const oversizedPlan = { ...input.plan, summary: "x".repeat(20_001) };

    await expect(composeDraftPullRequestBody({ ...input, plan: oversizedPlan })).rejects.toThrow();
  });

  it("throws when sensitive material appears in caller-supplied prose", async () => {
    const input = await build();
    const changeSummary = `Deployed using ghp_${"a".repeat(20)} for the release.`;

    await expect(composeDraftPullRequestBody({ ...input, changeSummary })).rejects.toThrow();
  });

  it("lists non-blocking findings in severity order (medium, then low, then info)", async () => {
    const findings: ReviewFinding[] = [
      {
        findingRef: "f-info",
        severity: "info",
        summary: "Info finding.",
        evidenceDigest: hex("1")
      },
      { findingRef: "f-low", severity: "low", summary: "Low finding.", evidenceDigest: hex("2") },
      {
        findingRef: "f-medium",
        severity: "medium",
        summary: "Medium finding.",
        evidenceDigest: hex("3")
      }
    ];
    const fixture = await buildPublicationEvidenceFixture({ review: { findings } });

    const body = await composeDraftPullRequestBody(toInput(fixture));
    expect(body.knownLimitations).toEqual(["Medium finding.", "Low finding.", "Info finding."]);
  });

  it("bounds a plan naming 50 verification commands with a deterministic, count-bearing elision", async () => {
    const commandCount = 50;
    const commands: VerificationCommand[] = Array.from({ length: commandCount }, (_, index) => ({
      executable: `check-${index}`,
      args: [],
      usesShell: false,
      required: true
    }));
    const results: VerificationResult[] = commands.map((command, index) => ({
      command,
      status: "passed",
      exitCode: 0,
      durationMs: 100 + index,
      startedAt: "2026-08-23T12:02:30.000Z",
      outputDigest: hex("d")
    }));

    const fixture = await buildPublicationEvidenceFixture({
      plan: { verificationCommands: commands },
      verification: { results }
    });

    const body = await composeDraftPullRequestBody(toInput(fixture));

    expect(body.verificationSummary).toContain("check-0");
    expect(body.verificationSummary).toContain("check-19");
    expect(body.verificationSummary).not.toContain("check-20");
    expect(body.verificationSummary).toContain("_30 further commands not shown._");
    expect(body.verificationSummary.length).toBeLessThanOrEqual(20_000);

    const secondBody = await composeDraftPullRequestBody(toInput(fixture));
    expect(secondBody.verificationSummary).toBe(body.verificationSummary);
  });

  it("never throws on merely large verification volume", async () => {
    const commands: VerificationCommand[] = Array.from({ length: 50 }, (_, index) => ({
      executable: `check-${index}`,
      args: [],
      usesShell: false,
      required: true
    }));
    const results: VerificationResult[] = commands.map((command, index) => ({
      command,
      status: "passed",
      exitCode: 0,
      durationMs: 100 + index,
      startedAt: "2026-08-23T12:02:30.000Z",
      outputDigest: hex("d")
    }));
    const fixture = await buildPublicationEvidenceFixture({
      plan: { verificationCommands: commands },
      verification: { results }
    });

    await expect(composeDraftPullRequestBody(toInput(fixture))).resolves.not.toThrow();
  });

  it("bounds a review with 500 findings under the knownLimitations schema maximum, with elision", async () => {
    const findings: ReviewFinding[] = Array.from({ length: 500 }, (_, index) => ({
      findingRef: `finding-${index}`,
      severity: "low",
      summary: `Non-blocking finding number ${index}.`,
      evidenceDigest: hex("2")
    }));
    const fixture = await buildPublicationEvidenceFixture({ review: { findings } });

    const body = await composeDraftPullRequestBody(toInput(fixture));

    expect(body.knownLimitations).toHaveLength(50);
    expect(body.knownLimitations[0]).toBe("Non-blocking finding number 0.");
    expect(body.knownLimitations[48]).toBe("Non-blocking finding number 48.");
    expect(body.knownLimitations[49]).toBe("_451 further findings not shown._");
    expect(() => DraftPullRequestBodySchema.parse(body)).not.toThrow();
  });
});
