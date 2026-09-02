import type { RunStage, RunStatus } from "@autostack/contracts";

/** `SourceRef.kind` mirrored here so this module does not need the whole entity import. */
export type WorkItemSourceKind = "manual" | "github" | "slack" | "api";

/**
 * A provider usage figure that preserves the `reported | unknown` discrimination end to end
 * (D4 revised, spec §10.2): `reportedSum` totals only the members whose provider actually reported
 * a value — a reported `0` contributes to the sum and NOT to `unknownCount` (the falsy-zero trap);
 * an `{ state: "unknown" }` member contributes to `unknownCount` and nothing to the sum. A single
 * number here would imply completeness the underlying data does not have.
 */
export interface ReportedUsageTotal {
  readonly reportedSum: number;
  readonly unknownCount: number;
}

/** The four `ModelTokenUsageSchema` members, each keeping its own reported/unknown split. */
export interface FactoryTokenUsageTotals {
  readonly input: ReportedUsageTotal;
  readonly output: ReportedUsageTotal;
  readonly cachedInput: ReportedUsageTotal;
  readonly reasoning: ReportedUsageTotal;
}

/** `ModelCostSchema` totalled the same way; `reportedMicros` never estimates past `unknownCount`. */
export interface FactoryCostTotal {
  readonly reportedMicros: number;
  readonly unknownCount: number;
}

/** A duration statistic. `sampleCount === 0` is the empty-stream case: `medianMs` is `0`, not `NaN`. */
export interface FactoryDurationStat {
  readonly medianMs: number;
  readonly sampleCount: number;
}

/** The highest `stage.leased.payload.attempt` seen for one run's pass through one stage. */
export interface FactoryStageRetry {
  readonly runId: string;
  readonly stage: RunStage;
  readonly maxAttempt: number;
}

/** `verify`-stage pass rate: `succeeded / (succeeded + failed)`. `0` samples reports `rate: 0`, not `NaN`. */
export interface FactoryPassRate {
  readonly succeeded: number;
  readonly failed: number;
  readonly rate: number;
}

/**
 * The control room's derived numbers (spec §4.2), one field per row of Task 9a's metric-derivation
 * table. Every field folds `readonly StoredDomainEvent[]` down to a number or a small record — no
 * React, no formatting decisions.
 *
 * `partial` mirrors the `partialMetrics` convention at `app.tsx:250`: when the caller's
 * `windowComplete` option (`DeriveFactoryMetricsOptions`) is `false` — a loaded page, not the whole
 * event history — every total here is marked partial together, because a page boundary can hide
 * events for any of them equally; there is no metric a partial window can vouch for as complete.
 */
export interface FactoryMetrics {
  readonly partial: boolean;
  readonly intakeVolume: number;
  readonly sourceCoverage: Readonly<Record<WorkItemSourceKind, number>>;
  readonly runStateCounts: Readonly<Record<RunStatus, number>>;
  readonly stageThroughput: Readonly<Record<RunStage, number>>;
  readonly queueDepth: Readonly<Record<RunStage, number>>;
  readonly stageLatency: Readonly<Record<RunStage, FactoryDurationStat>>;
  readonly retryCounts: readonly FactoryStageRetry[];
  readonly verifyPassRate: FactoryPassRate;
  readonly cycleTime: FactoryDurationStat;
  readonly approvalWaitTime: FactoryDurationStat;
  readonly humanInterventions: number;
  readonly pullRequestsDrafted: number;
  readonly validationChecksRun: number;
  readonly tokenUsage: FactoryTokenUsageTotals;
  readonly cost: FactoryCostTotal;
}

/** `deriveFactoryMetrics`'s options (the plan's signature, Task 9a). */
export interface DeriveFactoryMetricsOptions {
  readonly now: string;
  readonly windowComplete: boolean;
}
