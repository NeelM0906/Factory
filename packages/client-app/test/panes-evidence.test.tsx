// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  createId,
  ReviewReportSchema,
  VerificationReportSchema,
  type ReviewFinding,
  type ReviewReport,
  type VerificationReport,
  type VerificationResult
} from "@autostack/contracts";

import { FindingsPane } from "../src/panes/findings-pane.js";
import { VerificationPane } from "../src/panes/verification-pane.js";

afterEach(cleanup);

const uuid = (counter: number): string => {
  const hex = counter.toString(16).padStart(30, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(12, 15)}`,
    `8${hex.slice(15, 18)}`,
    hex.slice(18, 30)
  ].join("-");
};

const workspaceId = createId("workspace", uuid(1));
const workItemId = createId("workItem", uuid(2));
const runId = createId("run", uuid(3));

const OCCURRED_AT = "2026-08-20T12:00:00.000Z";

function verificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    command: { executable: "pnpm", args: ["test"], usesShell: false, required: true },
    status: "passed",
    exitCode: 0,
    durationMs: 1200,
    startedAt: OCCURRED_AT,
    outputDigest: "e".repeat(64),
    ...overrides
  };
}

function buildVerificationReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    schemaVersion: 1,
    workspaceId,
    workItemId,
    runId,
    planDigest: "a".repeat(64),
    status: "passed",
    results: [verificationResult()],
    producedAt: OCCURRED_AT,
    ...overrides
  };
}

function reviewFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    findingRef: "finding-1",
    severity: "medium",
    summary: "Consider extracting this helper.",
    evidenceDigest: "d".repeat(64),
    ...overrides
  };
}

function buildReviewReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    schemaVersion: 1,
    workspaceId,
    workItemId,
    runId,
    planDigest: "a".repeat(64),
    reviewedDiffDigest: "b".repeat(64),
    verificationReportDigest: "c".repeat(64),
    verdict: "approved",
    summary: "Looks solid overall.",
    findings: [],
    producedAt: OCCURRED_AT,
    ...overrides
  };
}

describe("VerificationPane", () => {
  it("renders a named empty state when there is no verification report yet", () => {
    render(<VerificationPane report={undefined} />);

    expect(screen.getByText(/no verification report/i)).toBeInTheDocument();
  });

  it("renders each check's command, status, exit code, and duration", () => {
    const report = VerificationReportSchema.parse(
      buildVerificationReport({
        status: "failed",
        results: [
          verificationResult({
            command: { executable: "pnpm", args: ["lint"], usesShell: false, required: true },
            status: "failed",
            exitCode: 1,
            durationMs: 340
          })
        ]
      })
    );

    render(<VerificationPane report={report} />);

    expect(screen.getByText("pnpm lint")).toBeInTheDocument();
    expect(screen.getByText("Status: failed")).toBeInTheDocument();
    expect(screen.getByText("Exit code: 1")).toBeInTheDocument();
    expect(screen.getByText("Duration: 340ms")).toBeInTheDocument();
  });

  it("renders a visible, labelled shell marker when a check's command uses a shell", () => {
    const report = VerificationReportSchema.parse(
      buildVerificationReport({
        results: [
          verificationResult({
            command: {
              executable: "sh",
              args: ["-c", "pnpm test"],
              usesShell: true,
              required: true
            }
          })
        ]
      })
    );

    render(<VerificationPane report={report} />);

    expect(screen.getByText("Runs via shell")).toBeInTheDocument();
  });

  it("renders no shell marker when the command does not use a shell", () => {
    const report = VerificationReportSchema.parse(buildVerificationReport());

    render(<VerificationPane report={report} />);

    expect(screen.queryByText("Runs via shell")).not.toBeInTheDocument();
  });

  it("renders exit code 0 for a passed check (falsy-zero trap)", () => {
    const report = VerificationReportSchema.parse(
      buildVerificationReport({ results: [verificationResult({ status: "passed", exitCode: 0 })] })
    );

    render(<VerificationPane report={report} />);

    expect(screen.getByText("Exit code: 0")).toBeInTheDocument();
  });

  it("makes a passed report with a skipped required check unrepresentable at the contract level", () => {
    const invalid = buildVerificationReport({
      status: "passed",
      results: [
        verificationResult({
          command: { executable: "pnpm", args: ["test"], usesShell: false, required: true },
          status: "skipped",
          exitCode: undefined
        })
      ]
    });

    expect(() => VerificationReportSchema.parse(invalid)).toThrow();
  });

  it("renders a passed report where every required check actually passed (positive companion)", () => {
    const report = VerificationReportSchema.parse(
      buildVerificationReport({
        status: "passed",
        results: [
          verificationResult({ status: "passed", exitCode: 0 }),
          verificationResult({
            command: { executable: "pnpm", args: ["typecheck"], usesShell: false, required: false },
            status: "skipped",
            exitCode: undefined
          })
        ]
      })
    );

    render(<VerificationPane report={report} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Status: skipped")).toBeInTheDocument();
    expect(screen.getByText("Exit code: Not applicable")).toBeInTheDocument();
  });
});

describe("FindingsPane", () => {
  it("renders a named empty state when there is no review report yet", () => {
    render(<FindingsPane report={undefined} />);

    expect(screen.getByText(/no review report/i)).toBeInTheDocument();
  });

  it("renders a distinct named state for a report with zero findings (not the same as no report)", () => {
    const report = ReviewReportSchema.parse(
      buildReviewReport({ verdict: "approved", findings: [] })
    );

    render(<FindingsPane report={report} />);

    expect(screen.getByText(/no findings recorded/i)).toBeInTheDocument();
    // Distinct from the absent-report state: the verdict itself is present here.
    expect(screen.getByText(/Approved/)).toBeInTheDocument();
    expect(screen.queryByText(/no review report/i)).not.toBeInTheDocument();
  });

  it("renders findings labelled by severity, in the report's own order", () => {
    const report = ReviewReportSchema.parse(
      buildReviewReport({
        verdict: "changes_requested",
        findings: [
          reviewFinding({ findingRef: "f-1", severity: "medium", summary: "Tidy this up." }),
          reviewFinding({ findingRef: "f-2", severity: "critical", summary: "Unchecked write." })
        ]
      })
    );

    render(<FindingsPane report={report} />);

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Tidy this up."),
      expect.stringContaining("Unchecked write.")
    ]);
    expect(items[0]).toHaveAttribute("data-severity", "medium");
    expect(items[1]).toHaveAttribute("data-severity", "critical");
  });

  it("renders location when present and fabricates none when absent", () => {
    const report = ReviewReportSchema.parse(
      buildReviewReport({
        verdict: "changes_requested",
        findings: [
          reviewFinding({
            findingRef: "f-1",
            location: { path: "src/app.ts", startLine: 10, endLine: 12 }
          }),
          reviewFinding({ findingRef: "f-2" })
        ]
      })
    );

    render(<FindingsPane report={report} />);

    expect(screen.getByText("src/app.ts:10-12")).toBeInTheDocument();
    // f-2 has no location: no location element at all renders for its item — not merely a blank
    // one. A React child of `undefined` is skipped silently rather than printed as the text
    // "undefined", so asserting on the rendered *text* here would pass even for a fabricating
    // implementation that always renders the location paragraph; asserting on the *element's
    // presence* is what actually distinguishes "no location" from "a location made of `undefined`s".
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items.at(1)?.querySelector(".findings-pane__finding-location")).toBeNull();
  });

  it("renders changes_requested with a critical finding's verdict prominently (visible text + data-verdict)", () => {
    const report = ReviewReportSchema.parse(
      buildReviewReport({
        verdict: "changes_requested",
        findings: [
          reviewFinding({ findingRef: "f-1", severity: "critical", summary: "Unchecked write." })
        ]
      })
    );

    render(<FindingsPane report={report} />);

    const verdict = screen.getByText(/Changes requested/);
    expect(verdict).toBeInTheDocument();
    expect(verdict).toHaveAttribute("data-verdict", "changes_requested");
    expect(screen.getByText(/Unchecked write\./)).toBeInTheDocument();
  });

  it("makes an approved report with a high finding unrepresentable at the contract level", () => {
    const invalid = buildReviewReport({
      verdict: "approved",
      findings: [reviewFinding({ findingRef: "f-1", severity: "high" })]
    });

    expect(() => ReviewReportSchema.parse(invalid)).toThrow();
  });
});
