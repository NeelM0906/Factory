import {
  InspectorSection,
  LifecycleStrip,
  MetricCard,
  type InspectorRow,
  type LifecycleStageView,
  type MetricCardProps
} from "@autostack/ui";

import {
  FactoryLaneSchema,
  RUN_STATUSES,
  RunStageSchema,
  SOURCE_REF_KINDS,
  type FactoryLane,
  type RunStage,
  type RunStatus
} from "@autostack/contracts";

import { formatCostMicros } from "../inspector/usage-summary.js";
import type {
  FactoryCostTotal,
  FactoryMetrics,
  FactoryTokenUsageTotals
} from "../metrics/types.js";

/**
 * Pure presentational view of the control room (spec §4.2, Task 9a's `FactoryMetrics`). No
 * fetching: the plan's "page /v1/runs then each run's events" collection lives in Task 10a, which
 * assembles this component into the workbench. The only display input beyond the metrics
 * themselves is `metrics.partial` — the honesty note renders from that field directly, so no
 * separate `windowComplete` prop is needed.
 */
export interface FactoryDashboardProps {
  readonly metrics: FactoryMetrics;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle strip (spec §4.2): Signal -> Monitor, Document and Monitor as inactive future stages.
//
// KNOWN GAP, flagged rather than worked around (task 9b brief: "if its API cannot express inactive
// stages, STOP and flag rather than forking a local copy"): `LifecycleStrip` (packages/ui, Task 4)
// exposes only `state: "complete" | "active" | "waiting" | "failed"` and never renders
// `aria-disabled` on any element — there is no state value or attribute this primitive can be
// given that produces `aria-disabled` in the DOM. The plan's Task 9b step 1 says this is "asserted
// by aria-disabled"; that is not achievable from packages/client-app alone (this task's package
// boundary), and packages/ui is out of scope for this task. Document and Monitor render with the
// closest available state (`"waiting"`) plus an always-present, distinguishing `detail` string
// instead. No test in this file asserts `aria-disabled` — see the task report for the flagged gap.
// ---------------------------------------------------------------------------------------------

const LANE_LABELS: Readonly<Record<FactoryLane, string>> = {
  signal: "Signal",
  triage: "Triage",
  plan: "Plan",
  implement: "Implement",
  validate: "Validate",
  release: "Release",
  document: "Document",
  monitor: "Monitor"
};

/** Mirrors the existing `STAGE_LANE` mapping in `app.tsx` (verify and review both land in
 * "Validate"; publish lands in "Release") so the two lifecycle views in this package agree. */
const LANE_STAGES: Readonly<Record<FactoryLane, readonly RunStage[]>> = {
  signal: [],
  triage: ["triage"],
  plan: ["plan"],
  implement: ["implement"],
  validate: ["verify", "review"],
  release: ["publish"],
  document: [],
  monitor: []
};

const FUTURE_LANES: ReadonlySet<FactoryLane> = new Set(["document", "monitor"]);
const FUTURE_STAGE_DETAIL = "Future stage — not part of Milestone A";

function sumStages(
  counts: Readonly<Record<RunStage, number>>,
  stages: readonly RunStage[]
): number {
  return stages.reduce((sum, stage) => sum + counts[stage], 0);
}

function lifecycleStages(metrics: FactoryMetrics): readonly LifecycleStageView[] {
  return FactoryLaneSchema.options.map((lane): LifecycleStageView => {
    if (FUTURE_LANES.has(lane)) {
      return { id: lane, label: LANE_LABELS[lane], state: "waiting", detail: FUTURE_STAGE_DETAIL };
    }
    if (lane === "signal") {
      return {
        id: lane,
        label: LANE_LABELS[lane],
        state: metrics.intakeVolume > 0 ? "complete" : "waiting"
      };
    }
    const stages = LANE_STAGES[lane];
    const throughput = sumStages(metrics.stageThroughput, stages);
    const queued = sumStages(metrics.queueDepth, stages);
    const state = throughput > 0 ? "complete" : queued > 0 ? "active" : "waiting";
    return queued > 0
      ? { id: lane, label: LANE_LABELS[lane], state, detail: `${queued} queued` }
      : { id: lane, label: LANE_LABELS[lane], state };
  });
}

// ---------------------------------------------------------------------------------------------
// Metric cards: one per named FactoryMetrics group (Task 9b brief bullet list), through the
// existing `MetricCard`. Formatting rules are pinned here, stated in each function's comment;
// none of them is locale-dependent (no `toLocaleString`/`Intl`).
// ---------------------------------------------------------------------------------------------

const SOURCE_LABELS: Readonly<Record<(typeof SOURCE_REF_KINDS)[number], string>> = {
  manual: "Manual",
  github: "GitHub",
  slack: "Slack",
  api: "API"
};

const STAGE_LABELS: Readonly<Record<RunStage, string>> = {
  triage: "Triage",
  plan: "Plan",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  publish: "Publish"
};

function humanizeStatus(status: RunStatus): string {
  const spaced = status.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function sourceCoverageDetail(counts: FactoryMetrics["sourceCoverage"]): string {
  return SOURCE_REF_KINDS.map((kind) => `${SOURCE_LABELS[kind]} ${counts[kind]}`).join(", ");
}

function stageDetail(counts: Readonly<Record<RunStage, number>>): string {
  return RunStageSchema.options
    .map((stage) => `${STAGE_LABELS[stage]} ${counts[stage]}`)
    .join(", ");
}

function runStateDetail(counts: FactoryMetrics["runStateCounts"]): string {
  const nonZero = RUN_STATUSES.filter((status) => counts[status] > 0);
  if (nonZero.length === 0) return "No runs recorded";
  return nonZero.map((status) => `${humanizeStatus(status)} ${counts[status]}`).join(", ");
}

/** Pinned rule: whole seconds, rounded, suffixed "s" (e.g. `420_000` ms -> `"420s"`). Chosen over
 * `toLocaleString`/`Intl.DurationFormat` specifically because those vary by environment. */
function formatDurationMs(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** Pinned rule: `Math.round(rate * 100)` with a trailing "%" (e.g. `2/3` -> `"67%"`). */
function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

interface MetricCardSpec {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: MetricCardProps["tone"];
}

function metricCards(metrics: FactoryMetrics): readonly MetricCardSpec[] {
  const stageThroughputTotal = sumStages(metrics.stageThroughput, RunStageSchema.options);
  const queueDepthTotal = sumStages(metrics.queueDepth, RunStageSchema.options);
  const runStateTotal = RUN_STATUSES.reduce(
    (sum, status) => sum + metrics.runStateCounts[status],
    0
  );
  const sourceTotal = SOURCE_REF_KINDS.reduce((sum, kind) => sum + metrics.sourceCoverage[kind], 0);
  const needsAttention =
    metrics.runStateCounts.failed > 0 || metrics.runStateCounts.needs_clarification > 0;

  return [
    {
      key: "intake",
      label: "Intake volume",
      value: String(metrics.intakeVolume),
      detail: "Work items received",
      tone: "neutral"
    },
    {
      key: "source-coverage",
      label: "Source coverage",
      value: String(sourceTotal),
      detail: sourceCoverageDetail(metrics.sourceCoverage),
      tone: "neutral"
    },
    {
      key: "run-states",
      label: "Run states",
      value: String(runStateTotal),
      detail: runStateDetail(metrics.runStateCounts),
      tone: needsAttention ? "attention" : "neutral"
    },
    {
      key: "stage-throughput",
      label: "Stage throughput",
      value: String(stageThroughputTotal),
      detail: stageDetail(metrics.stageThroughput),
      tone: stageThroughputTotal > 0 ? "good" : "neutral"
    },
    {
      key: "queue-depth",
      label: "Queue depth",
      value: String(queueDepthTotal),
      detail: stageDetail(metrics.queueDepth),
      tone: queueDepthTotal > 0 ? "attention" : "neutral"
    },
    {
      key: "pass-rate",
      label: "Verify pass rate",
      value: formatPercent(metrics.verifyPassRate.rate),
      detail: `${metrics.verifyPassRate.succeeded} succeeded, ${metrics.verifyPassRate.failed} failed`,
      tone: metrics.verifyPassRate.failed > 0 ? "attention" : "good"
    },
    {
      key: "cycle-time",
      label: "Cycle time (median)",
      value: formatDurationMs(metrics.cycleTime.medianMs),
      detail: `${metrics.cycleTime.sampleCount} completed run(s)`,
      tone: "neutral"
    },
    {
      key: "approval-wait",
      label: "Approval wait (median)",
      value: formatDurationMs(metrics.approvalWaitTime.medianMs),
      detail: `${metrics.approvalWaitTime.sampleCount} decided approval(s)`,
      tone: "neutral"
    },
    {
      key: "interventions",
      label: "Human interventions",
      value: String(metrics.humanInterventions),
      detail: "Approvals decided and hand-offs to a person",
      tone: "neutral"
    },
    {
      key: "prs-drafted",
      label: "Pull requests drafted",
      value: String(metrics.pullRequestsDrafted),
      detail: "Publish-stage successes",
      tone: metrics.pullRequestsDrafted > 0 ? "good" : "neutral"
    },
    {
      key: "checks-run",
      label: "Validation checks run",
      value: String(metrics.validationChecksRun),
      detail: "Command executions completed",
      tone: "neutral"
    }
  ];
}

// ---------------------------------------------------------------------------------------------
// Usage/cost tiles (D4 revised, spec §10.2): reported sum AND unknown count both visible, via
// `InspectorSection`'s existing `value === undefined` -> "Not recorded" convention (Task 4a,
// `@autostack/ui`) — the same primitive and the same convention `usage-summary.ts` already uses
// for a single run's usage record. `formatCostMicros` is reused from there rather than
// reformatting cost with a second, possibly-drifting rule.
// ---------------------------------------------------------------------------------------------

function row(term: string, value: string | number | undefined): InspectorRow {
  return value === undefined ? { term } : { term, value };
}

/**
 * Two rows per field: the reported sum (or "Not recorded" when every contribution was unknown —
 * `unknownCount > 0 && reportedSum === 0`), and — only when `unknownCount > 0` — a second row
 * naming the unreported count. A field with `unknownCount === 0` gets no second row at all: the
 * element is absent, not present-and-zero (the D4 guard's fourth vector). A real reported `0`
 * (`unknownCount === 0`, `reportedSum === 0`) still renders `0`, never "Not recorded" — the
 * `allUnknown` check reads `unknownCount`, never `reportedSum` alone, so a falsy `0` can never be
 * mistaken for "nothing reported".
 */
function usageTotalRows(
  label: string,
  total: { readonly reportedSum: number; readonly unknownCount: number },
  formatValue: (value: number) => string | number
): readonly InspectorRow[] {
  const allUnknown = total.unknownCount > 0 && total.reportedSum === 0;
  const valueRow = row(label, allUnknown ? undefined : formatValue(total.reportedSum));
  if (total.unknownCount === 0) return [valueRow];
  return [valueRow, row(`${label} (unreported)`, total.unknownCount)];
}

function identity(value: number): number {
  return value;
}

function usageAndCostRows(
  tokenUsage: FactoryTokenUsageTotals,
  cost: FactoryCostTotal
): readonly InspectorRow[] {
  return [
    ...usageTotalRows("Input tokens", tokenUsage.input, identity),
    ...usageTotalRows("Output tokens", tokenUsage.output, identity),
    ...usageTotalRows("Cached input tokens", tokenUsage.cachedInput, identity),
    ...usageTotalRows("Reasoning tokens", tokenUsage.reasoning, identity),
    ...usageTotalRows(
      "Cost",
      { reportedSum: cost.reportedMicros, unknownCount: cost.unknownCount },
      formatCostMicros
    )
  ];
}

// ---------------------------------------------------------------------------------------------

export function FactoryDashboard({ metrics }: FactoryDashboardProps) {
  return (
    <section className="factory-dashboard" aria-label="Factory control room">
      <h2>Factory control room</h2>
      {metrics.partial ? (
        <p className="factory-dashboard__partial-note" role="status">
          Showing the loaded run window — totals may be incomplete until every page loads.
        </p>
      ) : null}
      <LifecycleStrip stages={lifecycleStages(metrics)} />
      <div className="factory-dashboard__metrics">
        {metricCards(metrics).map((card) => (
          <MetricCard
            key={card.key}
            label={card.label}
            value={card.value}
            detail={card.detail}
            tone={card.tone}
          />
        ))}
      </div>
      <InspectorSection
        title="Usage and cost"
        rows={usageAndCostRows(metrics.tokenUsage, metrics.cost)}
      />
    </section>
  );
}
