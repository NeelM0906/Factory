import {
  RUN_STATUSES,
  SOURCE_REF_KINDS,
  type RunStage,
  type RunStatus,
  type StoredDomainEvent
} from "@autostack/contracts";

import type {
  DeriveFactoryMetricsOptions,
  FactoryMetrics,
  FactoryStageRetry,
  WorkItemSourceKind
} from "./types.js";

/**
 * The six pipeline stages `RunStageSchema` enumerates (`packages/contracts/src/entities.ts`).
 * Contracts exports no array constant for this enum (unlike `RUN_STATUSES`), so it is named here.
 */
const RUN_STAGES: readonly RunStage[] = [
  "triage",
  "plan",
  "implement",
  "verify",
  "review",
  "publish"
];

/** Safe array access under `noUncheckedIndexedAccess` — throws rather than silently `undefined`. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new RangeError(`Index ${index} is out of bounds.`);
  return value;
}

/**
 * `0` for an empty sample (never `NaN`); the exact middle value for an odd count; the mean of the
 * two middle values for an even count (pinned by the plan's own 240_000/600_000 -> 420_000 example).
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  if (sorted.length % 2 === 1) return at(sorted, Math.floor(middle));
  return (at(sorted, middle - 1) + at(sorted, middle)) / 2;
}

function zeroFilledRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  const record = {} as Record<K, number>;
  for (const key of keys) record[key] = 0;
  return record;
}

/** A mutable accumulator shape for the folding loop; `FactoryMetrics`'s own fields stay `readonly`. */
interface MutableUsageTotal {
  reportedSum: number;
  unknownCount: number;
}

function emptyUsageTotal(): MutableUsageTotal {
  return { reportedSum: 0, unknownCount: 0 };
}

/**
 * Orders events deterministically before folding, so the same set in a different array order
 * yields identical output (wrong impl: order-dependent folding). `occurredAt` is the semantic
 * order; `globalSequence` — durably unique per stored event — breaks ties without relying on the
 * input array's own position.
 */
function sortEvents(events: readonly StoredDomainEvent[]): readonly StoredDomainEvent[] {
  return [...events].sort((a, b) => {
    const byTime = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    if (byTime !== 0) return byTime;
    return a.globalSequence - b.globalSequence;
  });
}

interface JobState {
  stage: RunStage;
  queued: boolean;
  terminal: boolean;
}

/**
 * Folds `readonly StoredDomainEvent[]` down to the control room's derived numbers (spec §4.2,
 * Task 9a's metric table). Pure: no React, no I/O, no `Date.now()` — `options.now` is the only
 * clock this function ever reads, and only for the caller's own future use (it does not feed any
 * metric here; an unmatched `stage.leased` is deliberately never measured against it — see the
 * queue-depth section below).
 */
export function deriveFactoryMetrics(
  events: readonly StoredDomainEvent[],
  options: DeriveFactoryMetricsOptions
): FactoryMetrics {
  const sorted = sortEvents(events);

  const sourceCoverage = zeroFilledRecord<WorkItemSourceKind>(SOURCE_REF_KINDS);
  const stageThroughput = zeroFilledRecord<RunStage>(RUN_STAGES);
  const queueDepthByStage = zeroFilledRecord<RunStage>(RUN_STAGES);
  const stageLatencySamples: Record<RunStage, number[]> = Object.fromEntries(
    RUN_STAGES.map((stage) => [stage, [] as number[]])
  ) as Record<RunStage, number[]>;

  let intakeVolume = 0;
  // Unconditional `set` on both `run.created` and `run.transitioned` — never a lookup-then-skip —
  // is what lets an orphan `run.transitioned` (no `run.created` in the window) still get counted
  // rather than silently dropped (wrong impl: keyBy-runId that only accepts known runs).
  const runLatestStatus = new Map<string, RunStatus>();
  const runCreatedAt = new Map<string, string>();

  // Queue depth: a job counts as still outstanding when it has been queued but never resolved to
  // a terminal outcome — whether or not it was ever leased. This is what lets a crashed,
  // leased-but-never-terminal job still count toward depth (wrong impl: subtracting leased from
  // queued as if a lease alone removed it from the backlog).
  const jobState = new Map<string, JobState>();
  // Stage latency: leased -> terminal, matched on jobId. A job with no matching leased event
  // contributes no sample — never `now - queuedAt` or similar, which would fabricate a duration.
  const leasedAtByJob = new Map<string, string>();
  const retryByRunStage = new Map<string, FactoryStageRetry>();

  let verifySucceeded = 0;
  let verifyFailed = 0;
  const cycleTimeSamples: number[] = [];

  const approvalRequestedAt = new Map<string, string>();
  const approvalWaitSamples: number[] = [];
  let approvalDecidedCount = 0;
  let waitingForUserTransitions = 0;

  let pullRequestsDrafted = 0;
  let validationChecksRun = 0;

  const tokenTotals = {
    input: emptyUsageTotal(),
    output: emptyUsageTotal(),
    cachedInput: emptyUsageTotal(),
    reasoning: emptyUsageTotal()
  };
  let costReportedMicros = 0;
  let costUnknownCount = 0;

  for (const event of sorted) {
    switch (event.type) {
      case "work_item.created": {
        intakeVolume += 1;
        sourceCoverage[event.payload.workItem.source.kind] += 1;
        break;
      }
      case "run.created": {
        runLatestStatus.set(event.payload.run.id, event.payload.run.status);
        runCreatedAt.set(event.payload.run.id, event.occurredAt);
        break;
      }
      case "run.transitioned": {
        runLatestStatus.set(event.payload.runId, event.payload.to);
        if (event.payload.to === "completed") {
          const createdAt = runCreatedAt.get(event.payload.runId);
          if (createdAt !== undefined) {
            cycleTimeSamples.push(Date.parse(event.occurredAt) - Date.parse(createdAt));
          }
        }
        if (event.payload.to === "waiting_for_user") waitingForUserTransitions += 1;
        break;
      }
      case "stage.queued": {
        const existing = jobState.get(event.payload.jobId);
        jobState.set(event.payload.jobId, {
          stage: event.payload.stage,
          queued: true,
          terminal: existing?.terminal ?? false
        });
        break;
      }
      case "stage.leased": {
        leasedAtByJob.set(event.payload.jobId, event.occurredAt);
        const retryKey = `${event.payload.runId}:${event.payload.stage}`;
        const previous = retryByRunStage.get(retryKey);
        retryByRunStage.set(retryKey, {
          runId: event.payload.runId,
          stage: event.payload.stage,
          maxAttempt: Math.max(previous?.maxAttempt ?? 0, event.payload.attempt)
        });
        break;
      }
      case "stage.succeeded": {
        const existing = jobState.get(event.payload.jobId);
        jobState.set(event.payload.jobId, {
          stage: event.payload.stage,
          queued: existing?.queued ?? false,
          terminal: true
        });
        stageThroughput[event.payload.stage] += 1;
        if (event.payload.stage === "verify") verifySucceeded += 1;
        if (event.payload.stage === "publish") pullRequestsDrafted += 1;
        const leasedAt = leasedAtByJob.get(event.payload.jobId);
        if (leasedAt !== undefined) {
          stageLatencySamples[event.payload.stage].push(
            Date.parse(event.occurredAt) - Date.parse(leasedAt)
          );
        }
        break;
      }
      case "stage.failed": {
        const existing = jobState.get(event.payload.jobId);
        jobState.set(event.payload.jobId, {
          stage: event.payload.stage,
          queued: existing?.queued ?? false,
          terminal: true
        });
        if (event.payload.stage === "verify") verifyFailed += 1;
        const leasedAt = leasedAtByJob.get(event.payload.jobId);
        if (leasedAt !== undefined) {
          stageLatencySamples[event.payload.stage].push(
            Date.parse(event.occurredAt) - Date.parse(leasedAt)
          );
        }
        break;
      }
      case "approval.requested": {
        approvalRequestedAt.set(event.payload.approval.id, event.occurredAt);
        break;
      }
      case "approval.decided": {
        approvalDecidedCount += 1;
        const requestedAt = approvalRequestedAt.get(event.payload.approvalId);
        if (requestedAt !== undefined) {
          approvalWaitSamples.push(Date.parse(event.occurredAt) - Date.parse(requestedAt));
        }
        break;
      }
      case "command.completed": {
        validationChecksRun += 1;
        break;
      }
      case "agent.session_event": {
        const inner = event.payload.event;
        if (inner.type !== "usage") break;
        for (const field of ["input", "output", "cachedInput", "reasoning"] as const) {
          const count = inner.tokens[field];
          // A reported 0 adds 0 to the sum and is NOT counted unknown — the falsy-zero trap. Only
          // the `state` discriminant decides which bucket a member goes into; `count.value` is
          // read only inside the `"reported"` branch, so there is no `?? 0` to fabricate anything.
          if (count.state === "reported") {
            tokenTotals[field].reportedSum += count.value;
          } else {
            tokenTotals[field].unknownCount += 1;
          }
        }
        if (inner.cost.state === "reported") {
          costReportedMicros += inner.cost.micros;
        } else {
          costUnknownCount += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  for (const state of jobState.values()) {
    if (state.queued && !state.terminal) queueDepthByStage[state.stage] += 1;
  }

  const runStateCounts = zeroFilledRecord(RUN_STATUSES);
  for (const status of runLatestStatus.values()) {
    runStateCounts[status] += 1;
  }

  const stageLatency = Object.fromEntries(
    RUN_STAGES.map((stage) => [
      stage,
      {
        medianMs: median(stageLatencySamples[stage]),
        sampleCount: stageLatencySamples[stage].length
      }
    ])
  ) as FactoryMetrics["stageLatency"];

  const retryCounts = Array.from(retryByRunStage.values()).sort(
    (a, b) => a.runId.localeCompare(b.runId) || a.stage.localeCompare(b.stage)
  );

  const verifyTotal = verifySucceeded + verifyFailed;

  return {
    partial: !options.windowComplete,
    intakeVolume,
    sourceCoverage,
    runStateCounts,
    stageThroughput,
    queueDepth: queueDepthByStage,
    stageLatency,
    retryCounts,
    verifyPassRate: {
      succeeded: verifySucceeded,
      failed: verifyFailed,
      rate: verifyTotal === 0 ? 0 : verifySucceeded / verifyTotal
    },
    cycleTime: { medianMs: median(cycleTimeSamples), sampleCount: cycleTimeSamples.length },
    approvalWaitTime: {
      medianMs: median(approvalWaitSamples),
      sampleCount: approvalWaitSamples.length
    },
    humanInterventions: approvalDecidedCount + waitingForUserTransitions,
    pullRequestsDrafted,
    validationChecksRun,
    tokenUsage: tokenTotals,
    cost: { reportedMicros: costReportedMicros, unknownCount: costUnknownCount }
  };
}
