import { describe, expect, it } from "vitest";

import {
  ClarificationRequestSchema,
  ClarificationResponseSchema,
  PlanDocumentSchema,
  ReviewReportSchema,
  TriageReportSchema,
  VerificationReportSchema,
  admitPlanDocument,
  admitReviewReport,
  admitVerificationReport,
  canonicalizePlanDocumentForDigest,
  digestPlanDocument,
  digestVerificationReport
} from "../src/station-evidence.js";

const identity = {
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  workItemId: "wi_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000"
} as const;
const digest = (character: string): string => character.repeat(64);

const triageReport = () => ({
  schemaVersion: 1 as const,
  ...identity,
  taskType: "bug" as const,
  priority: "high" as const,
  complexity: "small" as const,
  actionable: true,
  rationale: "A failing regression with a reproducible test.",
  duplicates: [
    {
      kind: "pull_request" as const,
      reference: "NeelM0906/Factory:pull:42",
      url: "https://github.test/NeelM0906/Factory/pull/42",
      confidence: 0.8
    }
  ],
  producedAt: "2026-08-23T12:00:00.000Z"
});

const verificationCommand = (overrides: Record<string, unknown> = {}) => ({
  executable: "pnpm",
  args: ["--filter", "@autostack/contracts", "test"],
  usesShell: false,
  required: true,
  ...overrides
});

const planDocument = () => ({
  schemaVersion: 1 as const,
  ...identity,
  planDigest: digest("a"),
  summary: "Add the missing contract and its test.",
  acceptanceCriteria: ["The new schema rejects unknown keys."],
  affectedAreas: ["packages/contracts/src"],
  risks: [{ severity: "low" as const, summary: "None beyond contract churn." }],
  verificationCommands: [verificationCommand()],
  requiredPermissions: [
    { kind: "filesystem_write" as const, detail: "Write under packages/contracts." }
  ],
  requiredCredentialRefIds: [],
  producedAt: "2026-08-23T12:01:00.000Z"
});

const verificationReport = () => ({
  schemaVersion: 1 as const,
  ...identity,
  planDigest: digest("a"),
  status: "passed" as const,
  results: [
    {
      command: verificationCommand(),
      status: "passed" as const,
      exitCode: 0,
      durationMs: 12_400,
      startedAt: "2026-08-23T12:05:00.000Z",
      outputDigest: digest("b")
    }
  ],
  producedAt: "2026-08-23T12:06:00.000Z"
});

const reviewReport = () => ({
  schemaVersion: 1 as const,
  ...identity,
  planDigest: digest("a"),
  reviewedDiffDigest: digest("f"),
  verificationReportDigest: digest("b"),
  verdict: "changes_requested" as const,
  summary: "One blocking issue in the new schema.",
  findings: [
    {
      findingRef: "finding.1",
      severity: "high" as const,
      summary: "The strict object accepts an unbounded array.",
      evidenceDigest: digest("c"),
      location: { path: "packages/contracts/src/model.ts", startLine: 42, endLine: 48 }
    }
  ],
  producedAt: "2026-08-23T12:07:00.000Z"
});

describe("triage station report", () => {
  it("carries task type, priority, complexity, duplicates, and actionability", () => {
    const report = TriageReportSchema.parse(triageReport());
    expect(report.taskType).toBe("bug");
    expect(report.actionable).toBe(true);
    expect(report.duplicates[0]?.confidence).toBe(0.8);
  });

  it("rejects duplicate references repeated in one report", () => {
    const report = triageReport();
    expect(() =>
      TriageReportSchema.parse({
        ...report,
        duplicates: [report.duplicates[0], report.duplicates[0]]
      })
    ).toThrow();
    expect(() =>
      TriageReportSchema.parse({
        ...report,
        duplicates: [{ ...report.duplicates[0], confidence: 2 }]
      })
    ).toThrow();
  });
});

describe("plan station document", () => {
  it("carries acceptance criteria, risks, verification commands, and required permissions", () => {
    const plan = PlanDocumentSchema.parse(planDocument());
    expect(plan.acceptanceCriteria).toHaveLength(1);
    expect(plan.verificationCommands[0]?.executable).toBe("pnpm");
    expect(plan.requiredPermissions[0]?.kind).toBe("filesystem_write");
  });

  it("makes shell interpretation explicit and requires at least one required check", () => {
    const plan = planDocument();
    expect(
      PlanDocumentSchema.parse({
        ...plan,
        verificationCommands: [
          verificationCommand(),
          verificationCommand({ executable: "make", args: ["check"], usesShell: true })
        ]
      }).verificationCommands[1]?.usesShell
    ).toBe(true);

    expect(() =>
      PlanDocumentSchema.parse({
        ...plan,
        verificationCommands: [verificationCommand({ required: false })]
      })
    ).toThrow();
    expect(() => PlanDocumentSchema.parse({ ...plan, acceptanceCriteria: [] })).toThrow();
  });
});

describe("verification station report", () => {
  it("records exact commands, exit codes, and durations", () => {
    const report = VerificationReportSchema.parse(verificationReport());
    expect(report.results[0]?.exitCode).toBe(0);
    expect(report.results[0]?.durationMs).toBe(12_400);
  });

  it("treats a skipped required check as failure, not success", () => {
    const report = verificationReport();
    expect(() =>
      VerificationReportSchema.parse({
        ...report,
        results: [{ ...report.results[0], status: "skipped", exitCode: undefined }]
      })
    ).toThrow();
    expect(
      VerificationReportSchema.parse({
        ...report,
        status: "failed",
        results: [{ ...report.results[0], status: "skipped", exitCode: undefined }]
      }).status
    ).toBe("failed");
    expect(() =>
      VerificationReportSchema.parse({
        ...report,
        results: [{ ...report.results[0], status: "skipped" }]
      })
    ).toThrow();
    expect(() =>
      VerificationReportSchema.parse({
        ...report,
        results: [{ ...report.results[0], exitCode: undefined }]
      })
    ).toThrow();
  });

  it("cannot report success while a required check failed", () => {
    const report = verificationReport();
    expect(() =>
      VerificationReportSchema.parse({
        ...report,
        results: [{ ...report.results[0], status: "failed", exitCode: 1 }]
      })
    ).toThrow();
  });

  it("cannot report failure while every check passed", () => {
    const report = verificationReport();
    expect(() => VerificationReportSchema.parse({ ...report, status: "failed" })).toThrow();
    expect(
      VerificationReportSchema.parse({
        ...report,
        status: "failed",
        results: [
          report.results[0],
          {
            command: verificationCommand({ executable: "pnpm", args: ["lint"], required: false }),
            status: "failed",
            exitCode: 1,
            durationMs: 900,
            startedAt: "2026-08-23T12:05:20.000Z",
            outputDigest: digest("c")
          }
        ]
      }).status
    ).toBe("failed");
  });
});

describe("review station report", () => {
  it("carries findings with severity, location, and evidence", () => {
    const report = ReviewReportSchema.parse(reviewReport());
    expect(report.findings[0]?.location?.startLine).toBe(42);
    expect(report.verdict).toBe("changes_requested");
  });

  it("never approves while blocking findings remain", () => {
    const report = reviewReport();
    expect(() => ReviewReportSchema.parse({ ...report, verdict: "approved" })).toThrow();
    expect(
      ReviewReportSchema.parse({ ...report, verdict: "approved", findings: [] }).findings
    ).toEqual([]);
    expect(() =>
      ReviewReportSchema.parse({
        ...report,
        findings: [
          report.findings[0],
          { ...report.findings[0], location: { path: "a.ts", startLine: 9, endLine: 2 } }
        ]
      })
    ).toThrow();
  });
});

describe("clarification exchange", () => {
  it("binds an answer to the question that blocked the run", () => {
    const request = ClarificationRequestSchema.parse({
      schemaVersion: 1,
      ...identity,
      clarificationRef: "clarify.1",
      stage: "triage",
      question: "Which repository should this change target?",
      evidenceDigest: digest("d"),
      requestedAt: "2026-08-23T12:00:00.000Z"
    });
    const response = ClarificationResponseSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "clarification:run:1",
      runId: identity.runId,
      clarificationRef: request.clarificationRef,
      answer: "NeelM0906/Factory",
      origin: "slack",
      actorId: "U123",
      answeredAt: "2026-08-23T12:02:00.000Z"
    });
    expect(response.clarificationRef).toBe(request.clarificationRef);
    expect(() =>
      ClarificationResponseSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "clarification:run:1",
        runId: identity.runId,
        clarificationRef: request.clarificationRef,
        answer: "NeelM0906/Factory",
        origin: "carrier-pigeon",
        actorId: "U123",
        answeredAt: "2026-08-23T12:02:00.000Z"
      })
    ).toThrow();
  });
});

describe("station evidence digests", () => {
  const sealedPlan = async () => {
    const draft = planDocument();
    return { ...draft, planDigest: await digestPlanDocument(draft) };
  };
  const sealedVerification = async (plan: { readonly planDigest: string }) => ({
    ...verificationReport(),
    planDigest: plan.planDigest
  });

  it("digests a plan document to its own planDigest", async () => {
    const plan = await sealedPlan();
    const admitted = await admitPlanDocument(plan);
    expect(admitted.planDigest).toBe(plan.planDigest);
    expect(await digestPlanDocument(admitted)).toBe(plan.planDigest);
  });

  it("rejects a plan document whose digest does not cover its content", async () => {
    const plan = await sealedPlan();
    await expect(
      admitPlanDocument({ ...plan, summary: "A different plan entirely." })
    ).rejects.toThrow(/digest/);
    await expect(admitPlanDocument({ ...plan, planDigest: digest("e") })).rejects.toThrow(/digest/);
  });

  it("excludes the self digest and the production timestamp from the canonical form", async () => {
    const plan = await sealedPlan();
    const canonical = canonicalizePlanDocumentForDigest(PlanDocumentSchema.parse(plan));
    expect(canonical).not.toHaveProperty("planDigest");
    expect(canonical).not.toHaveProperty("producedAt");
    expect(await digestPlanDocument({ ...plan, producedAt: "2027-01-01T00:00:00.000Z" })).toBe(
      plan.planDigest
    );
  });

  it("changes the plan digest when any approved field changes", async () => {
    const plan = await sealedPlan();
    const mutations = [
      { acceptanceCriteria: ["Something else entirely."] },
      { affectedAreas: ["apps/desktop"] },
      { risks: [{ severity: "high" as const, summary: "Now risky." }] },
      { verificationCommands: [verificationCommand({ args: ["lint"] })] },
      { requiredPermissions: [{ kind: "network_egress" as const, detail: "Fetch packages." }] }
    ];
    for (const mutation of mutations) {
      expect(await digestPlanDocument({ ...plan, ...mutation })).not.toBe(plan.planDigest);
    }
  });

  it("binds a verification report to the plan it verified", async () => {
    const plan = await sealedPlan();
    const report = await sealedVerification(plan);
    const admitted = await admitVerificationReport(report, plan);
    expect(admitted.planDigest).toBe(plan.planDigest);
    expect(await digestVerificationReport(admitted)).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      admitVerificationReport({ ...report, planDigest: digest("e") }, plan)
    ).rejects.toThrow(/not bound to this plan/);
  });

  it("binds a review report to the plan and verification evidence it read", async () => {
    const plan = await sealedPlan();
    const verification = await sealedVerification(plan);
    const review = {
      ...reviewReport(),
      planDigest: plan.planDigest,
      verificationReportDigest: await digestVerificationReport(verification)
    };
    const admitted = await admitReviewReport(review, plan, verification);
    expect(admitted.verdict).toBe("changes_requested");

    await expect(
      admitReviewReport({ ...review, verificationReportDigest: digest("e") }, plan, verification)
    ).rejects.toThrow(/verification/);
    await expect(
      admitReviewReport({ ...review, planDigest: digest("e") }, plan, verification)
    ).rejects.toThrow(/not bound to this plan/);
  });

  it("refuses evidence that belongs to another run", async () => {
    const plan = await sealedPlan();
    const otherRunId = "run_123e4567-e89b-42d3-a456-426614174999";
    const report = { ...(await sealedVerification(plan)), runId: otherRunId };
    await expect(admitVerificationReport(report, plan)).rejects.toThrow(/run/);
  });
});
