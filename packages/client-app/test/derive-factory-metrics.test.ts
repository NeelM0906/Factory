import { describe, expect, it } from "vitest";

import { StoredDomainEventSchema, type StoredDomainEvent } from "@autostack/contracts";

import { deriveFactoryMetrics } from "../src/metrics/derive-factory-metrics.js";
import {
  DASHBOARD_FIXTURE_COMPOSITION,
  DASHBOARD_RUN_IDS,
  SEEDED_DASHBOARD_EVENTS
} from "../src/testing/index.js";
import {
  buildDeterministicUuid,
  createDeterministicIdFactory
} from "../src/testing/deterministic-ids.js";

const NOW = "2026-08-20T12:00:00.000Z";

// ---------------------------------------------------------------------------------------------
// A light, test-local event builder for the adversarial guard cases below — deliberately separate
// from `dashboard-fixture-support.ts`'s builder, which exists to keep the big seeded fixture's
// internally-consistent narrative. These events are isolated, minimal, and sometimes deliberately
// incoherent (an unmatched lease, an orphan transition) — exactly what the seeded fixture must not
// be.
// ---------------------------------------------------------------------------------------------

const nextId = createDeterministicIdFactory();
const EDGE_WORKSPACE_ID = nextId("workspace");
let edgeSequence = 0;

function edgeEvent(
  body: { readonly type: string; readonly payload: unknown },
  stream: { readonly kind: "run" | "work_item"; readonly id: string },
  occurredAt: string
): StoredDomainEvent {
  edgeSequence += 1;
  return StoredDomainEventSchema.parse({
    workspaceId: EDGE_WORKSPACE_ID,
    actor: { kind: "system", id: "edge-case" },
    correlationId: buildDeterministicUuid(8_000_000 + edgeSequence),
    occurredAt,
    ...body,
    eventId: nextId("event"),
    stream,
    streamVersion: 1,
    globalSequence: edgeSequence,
    schemaVersion: 1
  });
}

describe("deriveFactoryMetrics — the plan's metric table, one hand-computed row at a time", () => {
  const metrics = deriveFactoryMetrics(SEEDED_DASHBOARD_EVENTS, { now: NOW, windowComplete: true });

  it("intake volume: work_item.created count", () => {
    // 7 work_item.created events (composition table).
    expect(metrics.intakeVolume).toBe(7);
  });

  it("source coverage: work_item.created -> payload.workItem.source.kind", () => {
    // 3 github, 2 slack, 1 manual, 1 api (composition table) = 7.
    expect(metrics.sourceCoverage).toEqual({ github: 3, slack: 2, manual: 1, api: 1 });
  });

  it("run state counts: fold run.created + run.transitioned per runId to a final RunStatus", () => {
    // completed: 2 (fast + slow); failed: 1; implementing: 1; reviewing: 1;
    // awaiting_plan_approval: 1; needs_clarification: 1. Every other RunStatus: 0. Sum = 7.
    expect(metrics.runStateCounts.completed).toBe(2);
    expect(metrics.runStateCounts.failed).toBe(1);
    expect(metrics.runStateCounts.implementing).toBe(1);
    expect(metrics.runStateCounts.reviewing).toBe(1);
    expect(metrics.runStateCounts.awaiting_plan_approval).toBe(1);
    expect(metrics.runStateCounts.needs_clarification).toBe(1);
    const total = Object.values(metrics.runStateCounts).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(7);
    // Every RunStatus is represented (zero-filled), not just the ones this fixture hits.
    expect(Object.keys(metrics.runStateCounts)).toHaveLength(17);
  });

  it("stage throughput: stage.succeeded per payload.stage", () => {
    // triage 6, plan 5, implement 3 (fixture composition table), verify 2 (of 3 triples, 1 failed),
    // review 1, publish 1. Sum = 6+5+3+2+1+1 = 18, matching the fixture's stage.succeeded count.
    expect(metrics.stageThroughput).toEqual({
      triage: 6,
      plan: 5,
      implement: 3,
      verify: 2,
      review: 1,
      publish: 1
    });
  });

  it("queue depth: stage.queued minus stage.leased-through-to-terminal, per stage", () => {
    // Every one of the fixture's 19 triples reaches a terminal outcome (succeeded or failed), so
    // nothing is left sitting in the queue — depth is 0 everywhere. The non-trivial case (a
    // leased-but-never-terminal job) is pinned separately below against a small ad hoc fixture.
    expect(metrics.queueDepth).toEqual({
      triage: 0,
      plan: 0,
      implement: 0,
      verify: 0,
      review: 0,
      publish: 0
    });
  });

  it("stage latency: stage.leased.occurredAt -> stage.succeeded|failed.occurredAt, matched on jobId", () => {
    // Every triple uses a uniform 60s leased->succeeded gap and 45s leased->failed gap (fixture
    // doc comment). triage's 6 samples are [60,60,60,60,60,45]s; sorted [45,60,60,60,60,60]s,
    // even count -> median = (60_000 + 60_000) / 2 = 60_000 ms.
    expect(metrics.stageLatency.triage).toEqual({ medianMs: 60_000, sampleCount: 6 });
    // plan: 5 samples, all 60s -> median (odd count, middle value) = 60_000 ms.
    expect(metrics.stageLatency.plan).toEqual({ medianMs: 60_000, sampleCount: 5 });
    // implement: 3 samples, all 60s -> median = 60_000 ms.
    expect(metrics.stageLatency.implement).toEqual({ medianMs: 60_000, sampleCount: 3 });
    // verify: samples [60, 45, 60]s (one is a stage.failed gap) -> sorted [45,60,60], median = 60_000 ms.
    expect(metrics.stageLatency.verify).toEqual({ medianMs: 60_000, sampleCount: 3 });
    // review and publish: exactly 1 sample each (the odd-count, single-value case) = 60_000 ms.
    expect(metrics.stageLatency.review).toEqual({ medianMs: 60_000, sampleCount: 1 });
    expect(metrics.stageLatency.publish).toEqual({ medianMs: 60_000, sampleCount: 1 });
  });

  it("retry counts: max stage.leased.payload.attempt per (runId, stage)", () => {
    // 19 (runId, stage) pairs, one per triple (composition table: no run/stage pair repeats).
    expect(metrics.retryCounts).toHaveLength(19);
    const failedImplement = metrics.retryCounts.find(
      (entry) => entry.runId === DASHBOARD_RUN_IDS.failed && entry.stage === "implement"
    );
    expect(failedImplement?.maxAttempt).toBe(
      DASHBOARD_FIXTURE_COMPOSITION.implementRetryAttempt.maxAttempt
    );
    expect(failedImplement?.maxAttempt).toBe(3);
    // Every other pair leased exactly once, at attempt 1.
    const others = metrics.retryCounts.filter((entry) => entry !== failedImplement);
    expect(others).toHaveLength(18);
    expect(others.every((entry) => entry.maxAttempt === 1)).toBe(true);
  });

  it("pass rate: verify-stage succeeded / (succeeded + failed)", () => {
    // 2 succeeded (completedFast, activeReviewing) + 1 failed (run_failed) -> rate = 2 / 3.
    expect(metrics.verifyPassRate).toEqual({ succeeded: 2, failed: 1, rate: 2 / 3 });
  });

  it("cycle time: run.created.occurredAt -> the run.transitioned whose to === completed", () => {
    // run_completed_fast: 240_000 ms; run_completed_slow: 600_000 ms (the plan's own example).
    // Even count (2) -> median = (240_000 + 600_000) / 2 = 420_000 ms.
    expect(metrics.cycleTime).toEqual({ medianMs: 420_000, sampleCount: 2 });
  });

  it("approval wait time: approval.requested -> approval.decided, matched on approvalId", () => {
    // 3 decided gaps: 30_000, 60_000, 120_000 ms. Odd count (3) -> median = the middle value,
    // 60_000 ms, once sorted. The 4th (pending) approval contributes no sample.
    expect(metrics.approvalWaitTime).toEqual({ medianMs: 60_000, sampleCount: 3 });
  });

  it("human interventions: approval.decided count + transitions into waiting_for_user", () => {
    // 3 decided approvals + 1 transition into waiting_for_user (run_active_reviewing) = 4.
    expect(metrics.humanInterventions).toBe(4);
  });

  it("pull requests drafted: stage.succeeded where stage === publish", () => {
    // The fixture's sole publish success (run_completed_fast).
    expect(metrics.pullRequestsDrafted).toBe(1);
  });

  it("validation checks run: command.completed count", () => {
    expect(metrics.validationChecksRun).toBe(5);
  });

  it("tokens / cost (D4 revised): sums reported usage, counts unknown members, never fabricates a zero", () => {
    // See dashboard-fixture-detail-events.ts's own hand-computed comment for the per-field arithmetic.
    expect(metrics.tokenUsage).toEqual(DASHBOARD_FIXTURE_COMPOSITION.usageTotals.tokens);
    expect(metrics.cost).toEqual(DASHBOARD_FIXTURE_COMPOSITION.usageTotals.cost);
    // The falsy-zero pin: U3 reports 0 for input/cachedInput/reasoning and 0 cost — every one of
    // those contributes to its field's reportedSum, not its unknownCount. A `value ?? 0`
    // implementation that never checks `state` would get these numbers right by coincidence but
    // get `output`/`cachedInput`/`cost` unknownCount wrong (see the next test) — pinning the sums
    // alone would not catch it, so both are asserted.
    expect(metrics.tokenUsage.input.reportedSum).toBe(1_800);
    expect(metrics.tokenUsage.reasoning.reportedSum).toBe(50);
    expect(metrics.tokenUsage.reasoning.unknownCount).toBe(0);
  });

  it("windowComplete: false marks the whole metrics object partial", () => {
    const complete = deriveFactoryMetrics(SEEDED_DASHBOARD_EVENTS, {
      now: NOW,
      windowComplete: true
    });
    const partialWindow = deriveFactoryMetrics(SEEDED_DASHBOARD_EVENTS, {
      now: NOW,
      windowComplete: false
    });
    expect(complete.partial).toBe(false);
    expect(partialWindow.partial).toBe(true);
    // Every other field is untouched by the flag — only `partial` differs.
    const { partial: _completePartial, ...completeRest } = complete;
    const { partial: _partialWindowPartial, ...partialWindowRest } = partialWindow;
    expect(partialWindowRest).toEqual(completeRest);
  });

  it("is deterministic: the same events in a different order yield identical metrics", () => {
    const reversed = deriveFactoryMetrics([...SEEDED_DASHBOARD_EVENTS].reverse(), {
      now: NOW,
      windowComplete: true
    });
    const byEventId = deriveFactoryMetrics(
      [...SEEDED_DASHBOARD_EVENTS].sort((a, b) => a.eventId.localeCompare(b.eventId)),
      { now: NOW, windowComplete: true }
    );
    expect(reversed).toEqual(metrics);
    expect(byEventId).toEqual(metrics);
  });
});

describe("deriveFactoryMetrics — guards pinned against small, adversarial event arrays", () => {
  it("returns zeros, not NaN, for an empty event stream (wrong impl: mean/median dividing by zero)", () => {
    const metrics = deriveFactoryMetrics([], { now: NOW, windowComplete: true });

    expect(metrics.intakeVolume).toBe(0);
    expect(metrics.cycleTime).toEqual({ medianMs: 0, sampleCount: 0 });
    expect(metrics.approvalWaitTime).toEqual({ medianMs: 0, sampleCount: 0 });
    expect(metrics.verifyPassRate).toEqual({ succeeded: 0, failed: 0, rate: 0 });
    expect(metrics.retryCounts).toEqual([]);
    expect(metrics.partial).toBe(false);
    for (const stat of Object.values(metrics.stageLatency)) {
      expect(stat).toEqual({ medianMs: 0, sampleCount: 0 });
    }
    expect(Number.isNaN(metrics.cycleTime.medianMs)).toBe(false);
    expect(Number.isNaN(metrics.approvalWaitTime.medianMs)).toBe(false);
    expect(Number.isNaN(metrics.verifyPassRate.rate)).toBe(false);
  });

  it("counts an unmatched stage.leased toward queue depth and nothing else (crash mid-stage)", () => {
    const runId = nextId("run");
    const jobId = nextId("job");
    const events = [
      edgeEvent(
        { type: "stage.queued", payload: { runId, stage: "implement", jobId } },
        { kind: "run", id: runId },
        "2026-08-20T12:00:00.000Z"
      ),
      edgeEvent(
        {
          type: "stage.leased",
          payload: { runId, stage: "implement", jobId, workerId: "worker-crash", attempt: 1 }
        },
        { kind: "run", id: runId },
        "2026-08-20T12:00:05.000Z"
      )
      // Crash: no stage.succeeded or stage.failed ever arrives for this job.
    ];

    const metrics = deriveFactoryMetrics(events, {
      now: "2026-08-21T00:00:00.000Z",
      windowComplete: true
    });

    // wrong impl A: counting it as a completed stage.
    expect(metrics.stageThroughput.implement).toBe(0);
    // wrong impl B: measuring its latency against `now` as if it just finished.
    expect(metrics.stageLatency.implement).toEqual({ medianMs: 0, sampleCount: 0 });
    // correct: it is still outstanding work, so it counts toward the queue.
    expect(metrics.queueDepth.implement).toBe(1);
  });

  it("counts a run.transitioned with no run.created in the window, not dropped (wrong impl: keyBy-runId skipping unknown runs)", () => {
    const runId = nextId("run");
    const events = [
      edgeEvent(
        {
          type: "run.transitioned",
          payload: {
            runId,
            from: "queued",
            to: "implementing",
            reason: "Orphan transition — no run.created in this window."
          }
        },
        { kind: "run", id: runId },
        "2026-08-20T12:00:00.000Z"
      )
    ];

    const metrics = deriveFactoryMetrics(events, { now: NOW, windowComplete: true });

    expect(metrics.runStateCounts.implementing).toBe(1);
    const total = Object.values(metrics.runStateCounts).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(1);
  });

  it("sums a reported 0 into the total and does not count it unknown (the falsy-zero trap, wrong impl: `value ?? 0`)", () => {
    const runId = nextId("run");
    const agentSessionId = nextId("agentSession");
    const events = [
      edgeEvent(
        {
          type: "agent.session_event",
          payload: {
            runId,
            stage: "implement",
            agentSessionId,
            sequence: 1,
            event: {
              schemaVersion: 1,
              sessionId: agentSessionId,
              sequence: 1,
              occurredAt: "2026-08-20T12:00:00.000Z",
              type: "usage",
              tokens: {
                input: { state: "reported", value: 0 },
                output: { state: "unknown" },
                cachedInput: { state: "reported", value: 0 },
                reasoning: { state: "reported", value: 0 }
              },
              cost: { state: "unknown" }
            }
          }
        },
        { kind: "run", id: runId },
        "2026-08-20T12:00:00.000Z"
      )
    ];

    const metrics = deriveFactoryMetrics(events, { now: NOW, windowComplete: true });

    // The reported 0 contributes 0 to the sum and is NOT counted as unknown.
    expect(metrics.tokenUsage.input).toEqual({ reportedSum: 0, unknownCount: 0 });
    expect(metrics.tokenUsage.cachedInput).toEqual({ reportedSum: 0, unknownCount: 0 });
    expect(metrics.tokenUsage.reasoning).toEqual({ reportedSum: 0, unknownCount: 0 });
    // The genuinely unknown member increments its unknown count and contributes nothing.
    expect(metrics.tokenUsage.output).toEqual({ reportedSum: 0, unknownCount: 1 });
    expect(metrics.cost).toEqual({ reportedMicros: 0, unknownCount: 1 });
  });

  it("states and pins the median rule for an odd sample count: the exact middle value", () => {
    const runId = nextId("run");
    const events = [30_000, 10_000, 20_000].map((waitMs, index) => {
      const approvalId = nextId("approval");
      const requestedAt = "2026-08-20T12:00:00.000Z";
      const decidedAt = new Date(Date.parse(requestedAt) + waitMs).toISOString();
      return [
        edgeEvent(
          {
            type: "approval.requested",
            payload: {
              approval: {
                schemaVersion: 1,
                id: approvalId,
                workspaceId: EDGE_WORKSPACE_ID,
                runId,
                kind: "plan",
                status: "pending",
                evidenceDigest: (index + 1).toString(16).padStart(64, "0"),
                eligibleApproverIds: ["fixture-approver-1"],
                createdAt: requestedAt,
                updatedAt: requestedAt
              }
            }
          },
          { kind: "run", id: runId },
          requestedAt
        ),
        edgeEvent(
          {
            type: "approval.decided",
            payload: {
              approvalId,
              runId,
              decision: "approved",
              evidenceDigest: (index + 1).toString(16).padStart(64, "0"),
              origin: "web",
              decidedAt
            }
          },
          { kind: "run", id: runId },
          decidedAt
        )
      ];
    });

    const metrics = deriveFactoryMetrics(events.flat(), { now: NOW, windowComplete: true });

    // Waits sorted: [10_000, 20_000, 30_000] — odd count (3) -> median is the exact middle, 20_000.
    expect(metrics.approvalWaitTime).toEqual({ medianMs: 20_000, sampleCount: 3 });
  });
});
