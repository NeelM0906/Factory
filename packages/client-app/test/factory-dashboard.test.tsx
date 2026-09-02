// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { deriveFactoryMetrics } from "../src/metrics/derive-factory-metrics.js";
import type { FactoryMetrics } from "../src/metrics/types.js";
import { SEEDED_DASHBOARD_EVENTS } from "../src/testing/index.js";

import { FactoryDashboard } from "../src/dashboard/factory-dashboard.js";

afterEach(cleanup);

const NOW = "2026-08-20T12:00:00.000Z";

/** The Task 9a seeded fixture's metrics, window-complete — every card in the "hand-computed
 * composition constants" tests below is checked against this same object the plan points at. */
const seededMetrics: FactoryMetrics = deriveFactoryMetrics(SEEDED_DASHBOARD_EVENTS, {
  now: NOW,
  windowComplete: true
});

/** A minimal, all-zero `FactoryMetrics` for the adversarial guard cases below — literal, not
 * derived from events, so each guard test only varies the one field it is pinning. */
function emptyMetrics(overrides: Partial<FactoryMetrics> = {}): FactoryMetrics {
  const zeroUsage = { reportedSum: 0, unknownCount: 0 };
  return {
    partial: false,
    intakeVolume: 0,
    sourceCoverage: { manual: 0, github: 0, slack: 0, api: 0 },
    runStateCounts: {
      queued: 0,
      triaging: 0,
      needs_clarification: 0,
      planning: 0,
      awaiting_plan_approval: 0,
      provisioning: 0,
      implementing: 0,
      verifying: 0,
      reviewing: 0,
      awaiting_publish_approval: 0,
      publishing: 0,
      completed: 0,
      waiting_for_user: 0,
      retry_scheduled: 0,
      cancelling: 0,
      cancelled: 0,
      failed: 0
    },
    stageThroughput: { triage: 0, plan: 0, implement: 0, verify: 0, review: 0, publish: 0 },
    queueDepth: { triage: 0, plan: 0, implement: 0, verify: 0, review: 0, publish: 0 },
    stageLatency: {
      triage: { medianMs: 0, sampleCount: 0 },
      plan: { medianMs: 0, sampleCount: 0 },
      implement: { medianMs: 0, sampleCount: 0 },
      verify: { medianMs: 0, sampleCount: 0 },
      review: { medianMs: 0, sampleCount: 0 },
      publish: { medianMs: 0, sampleCount: 0 }
    },
    retryCounts: [],
    verifyPassRate: { succeeded: 0, failed: 0, rate: 0 },
    cycleTime: { medianMs: 0, sampleCount: 0 },
    approvalWaitTime: { medianMs: 0, sampleCount: 0 },
    humanInterventions: 0,
    pullRequestsDrafted: 0,
    validationChecksRun: 0,
    tokenUsage: {
      input: zeroUsage,
      output: zeroUsage,
      cachedInput: zeroUsage,
      reasoning: zeroUsage
    },
    cost: { reportedMicros: 0, unknownCount: 0 },
    ...overrides
  };
}

/** Locates the sibling element InspectorSection's `<dt>`/`<dd>` row renders next to a given term
 * text — the "element-level assertion" the brief asks for on the usage/cost guards, rather than a
 * substring match against the whole rendered tree. */
function usageValueFor(term: string): HTMLElement {
  const dt = screen.getByText(term, { selector: "dt" });
  const row = dt.parentElement;
  if (row === null) throw new Error(`Expected a parent row for term "${term}".`);
  const dd = within(row).getByText(/.*/, { selector: "dd" });
  return dd;
}

function queryUsageRow(term: string): HTMLElement | null {
  return screen.queryByText(term, { selector: "dt" });
}

describe("FactoryDashboard — lifecycle strip (spec §4.2)", () => {
  it("renders the eight lifecycle stages Signal through Monitor, in order", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);

    const list = screen.getByRole("list", { name: "Software delivery lifecycle" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    const labels = items.map((item) => item.textContent);
    expect(labels[0]).toContain("Signal");
    expect(labels[1]).toContain("Triage");
    expect(labels[2]).toContain("Plan");
    expect(labels[3]).toContain("Implement");
    expect(labels[4]).toContain("Validate");
    expect(labels[5]).toContain("Release");
    expect(labels[6]).toContain("Document");
    expect(labels[7]).toContain("Monitor");
  });

  it(
    "marks Document and Monitor as future stages with a distinguishing detail, and no other " +
      "stage carries it (wrong impl: no distinguishing marker between implemented and future stages)",
    () => {
      render(<FactoryDashboard metrics={seededMetrics} />);

      const list = screen.getByRole("list", { name: "Software delivery lifecycle" });
      const items = within(list).getAllByRole("listitem");
      const futureMarker = /future stage/i;

      const documentItem = items[6];
      const monitorItem = items[7];
      if (documentItem === undefined || monitorItem === undefined) {
        throw new Error("Expected 8 lifecycle items.");
      }
      expect(documentItem.textContent).toMatch(futureMarker);
      expect(monitorItem.textContent).toMatch(futureMarker);

      for (const item of items.slice(0, 6)) {
        expect(item.textContent).not.toMatch(futureMarker);
      }
    }
  );
});

describe("FactoryDashboard — metric cards, one per FactoryMetrics group (hand-computed against the seeded fixture)", () => {
  it("intake volume: 7 work items received", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(
      screen.getByRole("group", { name: "Intake volume: 7, Work items received" })
    ).toBeVisible();
  });

  it("source coverage: 3 github, 2 slack, 1 manual, 1 api", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    const card = screen.getByRole("group", { name: /^Source coverage: 7,/ });
    expect(card).toHaveTextContent("Manual 1");
    expect(card).toHaveTextContent("GitHub 3");
    expect(card).toHaveTextContent("Slack 2");
    expect(card).toHaveTextContent("API 1");
  });

  it("run states: 2 completed, 1 failed, 1 implementing, 1 reviewing, 1 awaiting plan approval, 1 needs clarification", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    const card = screen.getByRole("group", { name: /^Run states: 7,/ });
    expect(card).toHaveTextContent("Completed 2");
    expect(card).toHaveTextContent("Failed 1");
    expect(card).toHaveTextContent("Implementing 1");
    expect(card).toHaveTextContent("Reviewing 1");
    expect(card).toHaveTextContent("Awaiting plan approval 1");
    expect(card).toHaveTextContent("Needs clarification 1");
    // Non-color-only status (spec §4.1): a run state card carrying a failed/blocked run reads
    // "Needs attention" as text, not merely a colour.
    expect(card).toHaveTextContent("Needs attention");
  });

  it("stage throughput: triage 6, plan 5, implement 3, verify 2, review 1, publish 1", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    const card = screen.getByRole("group", { name: /^Stage throughput: 18,/ });
    expect(card).toHaveTextContent("Triage 6");
    expect(card).toHaveTextContent("Plan 5");
    expect(card).toHaveTextContent("Implement 3");
    expect(card).toHaveTextContent("Verify 2");
    expect(card).toHaveTextContent("Review 1");
    expect(card).toHaveTextContent("Publish 1");
  });

  it("queue depth: 0 everywhere in the seeded fixture (every triple reaches a terminal outcome)", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(screen.getByRole("group", { name: /^Queue depth: 0,/ })).toHaveTextContent("Baseline");
  });

  it(
    "queue depth: a nonzero backlog reads Needs attention, not merely a colour " +
      "(wrong impl: tone stays neutral regardless of backlog)",
    () => {
      const metrics = emptyMetrics({
        queueDepth: { triage: 1, plan: 0, implement: 0, verify: 0, review: 0, publish: 0 }
      });
      render(<FactoryDashboard metrics={metrics} />);
      expect(screen.getByRole("group", { name: /^Queue depth: 1,/ })).toHaveTextContent(
        "Needs attention"
      );
    }
  );

  it("pass rate: 2 succeeded, 1 failed -> 67%", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(
      screen.getByRole("group", { name: "Verify pass rate: 67%, 2 succeeded, 1 failed" })
    ).toBeVisible();
  });

  it('cycle time: the plan\'s own 420_000 ms median renders as 420s (pinned rule: Math.round(ms / 1000) + "s", no locale formatting)', () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(
      screen.getByRole("group", { name: "Cycle time (median): 420s, 2 completed run(s)" })
    ).toBeVisible();
  });

  it("approval wait: the 60_000 ms median renders as 60s", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(
      screen.getByRole("group", { name: "Approval wait (median): 60s, 3 decided approval(s)" })
    ).toBeVisible();
  });

  it("human interventions: 3 decided approvals + 1 waiting_for_user transition = 4", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(screen.getByRole("group", { name: /^Human interventions: 4,/ })).toBeVisible();
  });

  it("pull requests drafted: 1", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(screen.getByRole("group", { name: /^Pull requests drafted: 1,/ })).toBeVisible();
  });

  it("validation checks run: 5", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(screen.getByRole("group", { name: /^Validation checks run: 5,/ })).toBeVisible();
  });
});

describe("FactoryDashboard — usage/cost tiles (D4 revised, spec §10.2)", () => {
  it(
    "a partially-reported field (output tokens: 700 reported, 1 unknown) shows BOTH the sum and " +
      "the unknown count as separate elements (wrong impl: a tile that renders only the sum, " +
      "implying completeness)",
    () => {
      render(<FactoryDashboard metrics={seededMetrics} />);
      expect(usageValueFor("Output tokens")).toHaveTextContent("700");
      expect(usageValueFor("Output tokens (unreported)")).toHaveTextContent("1");
    }
  );

  it(
    "the all-reported positive companion (reasoning tokens: 50 reported, 0 unknown) has no " +
      "unreported-count row at all — element absent, not zero (fourth vector)",
    () => {
      render(<FactoryDashboard metrics={seededMetrics} />);
      expect(usageValueFor("Reasoning tokens")).toHaveTextContent("50");
      expect(queryUsageRow("Reasoning tokens (unreported)")).toBeNull();
    }
  );

  it('a reported 0 renders 0, not "Not recorded" (falsy-zero trap, wrong impl: `value || "Not recorded"`)', () => {
    const metrics = emptyMetrics({
      tokenUsage: {
        input: { reportedSum: 0, unknownCount: 0 },
        output: { reportedSum: 0, unknownCount: 0 },
        cachedInput: { reportedSum: 0, unknownCount: 0 },
        reasoning: { reportedSum: 0, unknownCount: 0 }
      }
    });
    render(<FactoryDashboard metrics={metrics} />);
    expect(usageValueFor("Input tokens")).toHaveTextContent("0");
    expect(usageValueFor("Input tokens")).not.toHaveTextContent("Not recorded");
  });

  it(
    'an all-unknown field (nothing reported, some unknown) renders "Not recorded" for the sum ' +
      "AND still shows the unknown count",
    () => {
      const metrics = emptyMetrics({
        tokenUsage: {
          input: { reportedSum: 0, unknownCount: 2 },
          output: { reportedSum: 0, unknownCount: 0 },
          cachedInput: { reportedSum: 0, unknownCount: 0 },
          reasoning: { reportedSum: 0, unknownCount: 0 }
        }
      });
      render(<FactoryDashboard metrics={metrics} />);
      expect(usageValueFor("Input tokens")).toHaveTextContent("Not recorded");
      expect(usageValueFor("Input tokens (unreported)")).toHaveTextContent("2");
    }
  );

  it("cost: 300_000 micros with 1 unknown renders $0.300000 and an unreported-count row", () => {
    render(<FactoryDashboard metrics={seededMetrics} />);
    expect(usageValueFor("Cost")).toHaveTextContent("$0.300000");
    expect(usageValueFor("Cost (unreported)")).toHaveTextContent("1");
  });
});

describe("FactoryDashboard — partial-window honesty note", () => {
  it("shows the loaded-run-window note when windowComplete is false (metrics.partial)", () => {
    const partialMetrics = deriveFactoryMetrics(SEEDED_DASHBOARD_EVENTS, {
      now: NOW,
      windowComplete: false
    });
    render(<FactoryDashboard metrics={partialMetrics} />);
    expect(screen.getByText(/showing the loaded run window/i)).toBeInTheDocument();
  });

  it(
    "the note is entirely absent from the DOM when the window is complete " +
      "(element absence, not a text-pattern check)",
    () => {
      render(<FactoryDashboard metrics={seededMetrics} />);
      expect(screen.queryByText(/showing the loaded run window/i)).toBeNull();
    }
  );
});
