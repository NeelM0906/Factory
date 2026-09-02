import { describe, expect, it } from "vitest";

import { StoredDomainEventSchema, type StoredDomainEvent } from "@autostack/contracts";

import {
  DASHBOARD_FIXTURE_COMPOSITION,
  DASHBOARD_RUN_IDS,
  SEEDED_DASHBOARD_EVENTS
} from "../src/testing/index.js";

type EventOfType<T extends StoredDomainEvent["type"]> = Extract<StoredDomainEvent, { type: T }>;

function eventsOfType<T extends StoredDomainEvent["type"]>(
  events: readonly StoredDomainEvent[],
  type: T
): readonly EventOfType<T>[] {
  return events.filter((event): event is EventOfType<T> => event.type === type);
}

/** Safe array access under `noUncheckedIndexedAccess` — throws rather than silently returning `undefined`. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new RangeError(`Index ${index} is out of bounds.`);
  return value;
}

function requireOne<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

describe("seedDashboardEvents (fixture integrity)", () => {
  it("parses every seeded event through its own contract schema", () => {
    expect(SEEDED_DASHBOARD_EVENTS.length).toBeGreaterThan(0);
    for (const event of SEEDED_DASHBOARD_EVENTS) {
      expect(() => StoredDomainEventSchema.parse(event)).not.toThrow();
    }
  });

  it("matches its own advertised total and per-type event counts", () => {
    expect(SEEDED_DASHBOARD_EVENTS.length).toBe(DASHBOARD_FIXTURE_COMPOSITION.totalEventCount);

    const counted = new Map<string, number>();
    for (const event of SEEDED_DASHBOARD_EVENTS) {
      counted.set(event.type, (counted.get(event.type) ?? 0) + 1);
    }

    for (const [type, expectedCount] of Object.entries(
      DASHBOARD_FIXTURE_COMPOSITION.eventTypeCounts
    )) {
      expect(counted.get(type) ?? 0).toBe(expectedCount);
    }
    // Every counted event type is one the composition table advertises — nothing untracked crept in.
    const advertisedTypes = new Set(Object.keys(DASHBOARD_FIXTURE_COMPOSITION.eventTypeCounts));
    for (const type of counted.keys()) {
      expect(advertisedTypes.has(type)).toBe(true);
    }

    // 6(completedFast) + 0(completedSlow) + 4(failed) + 2(activeImplementing) + 4(activeReviewing)
    // + 2(awaitingPlanApproval) + 1(needsClarification) = 19 triples -> 19 queued + 19 leased.
    expect(counted.get("stage.queued")).toBe(19);
    expect(counted.get("stage.leased")).toBe(19);
    // 18 succeeded + 1 failed (run_failed's verify) = 19 terminal stage outcomes, one per triple.
    expect((counted.get("stage.succeeded") ?? 0) + (counted.get("stage.failed") ?? 0)).toBe(19);
  });

  it("matches its advertised work item source coverage (3 github, 2 slack, 1 manual, 1 api)", () => {
    const created = eventsOfType(SEEDED_DASHBOARD_EVENTS, "work_item.created");
    expect(created).toHaveLength(7);

    const counted = { manual: 0, github: 0, slack: 0, api: 0 };
    for (const event of created) {
      counted[event.payload.workItem.source.kind] += 1;
    }
    expect(counted).toEqual(DASHBOARD_FIXTURE_COMPOSITION.workItemSourceCounts);
  });

  it("folds run.created + run.transitioned to the advertised final status per run", () => {
    const created = eventsOfType(SEEDED_DASHBOARD_EVENTS, "run.created");
    const transitioned = eventsOfType(SEEDED_DASHBOARD_EVENTS, "run.transitioned");
    expect(created).toHaveLength(7);
    expect(transitioned).toHaveLength(15);

    const latest = new Map<string, { readonly status: string; readonly at: number }>();
    for (const event of created) {
      latest.set(event.payload.run.id, {
        status: event.payload.run.status,
        at: Date.parse(event.occurredAt)
      });
    }
    for (const event of transitioned) {
      const at2 = Date.parse(event.occurredAt);
      const current = latest.get(event.payload.runId);
      if (current === undefined || at2 >= current.at) {
        latest.set(event.payload.runId, { status: event.payload.to, at: at2 });
      }
    }

    for (const [runId, expectedStatus] of Object.entries(
      DASHBOARD_FIXTURE_COMPOSITION.runFinalStatuses
    )) {
      const folded = requireOne(
        latest.get(runId),
        `Fixture has no run status folded for ${runId}.`
      );
      expect(folded.status).toBe(expectedStatus);
    }
    // Seven runs, seven folded final statuses — none dropped, none extra.
    expect(latest.size).toBe(7);
  });

  it("reproduces the plan's own cycle-time example from the fixture's own timestamps", () => {
    const created = eventsOfType(SEEDED_DASHBOARD_EVENTS, "run.created");
    const transitioned = eventsOfType(SEEDED_DASHBOARD_EVENTS, "run.transitioned");

    const cycleTimeMs = (runId: string): number => {
      const createdEvent = requireOne(
        created.find((event) => event.payload.run.id === runId),
        `Fixture has no run.created for ${runId}.`
      );
      const completedEvent = requireOne(
        transitioned.find(
          (event) => event.payload.runId === runId && event.payload.to === "completed"
        ),
        `Fixture has no completed transition for ${runId}.`
      );
      return Date.parse(completedEvent.occurredAt) - Date.parse(createdEvent.occurredAt);
    };

    // run_completed_fast: created 2026-08-20T10:00:00.000Z -> completed 10:04:00.000Z = 240_000 ms.
    const fastMs = cycleTimeMs(DASHBOARD_RUN_IDS.completedFast);
    expect(fastMs).toBe(240_000);
    expect(fastMs).toBe(DASHBOARD_FIXTURE_COMPOSITION.cycleTimesMs.completedFast);

    // run_completed_slow: created 2026-08-20T10:01:00.000Z -> completed 10:11:00.000Z = 600_000 ms.
    const slowMs = cycleTimeMs(DASHBOARD_RUN_IDS.completedSlow);
    expect(slowMs).toBe(600_000);
    expect(slowMs).toBe(DASHBOARD_FIXTURE_COMPOSITION.cycleTimesMs.completedSlow);

    // Even sample count (2): median = (240_000 + 600_000) / 2 = 420_000 ms (the plan's own example).
    expect((fastMs + slowMs) / 2).toBe(420_000);
  });

  it("reproduces the 3 decided approval wait gaps from the fixture's own timestamps", () => {
    const requested = eventsOfType(SEEDED_DASHBOARD_EVENTS, "approval.requested");
    const decided = eventsOfType(SEEDED_DASHBOARD_EVENTS, "approval.decided");
    expect(requested).toHaveLength(4);
    expect(decided).toHaveLength(3);

    const waitMs = (approvalId: string): number => {
      const request = requireOne(
        requested.find((event) => event.payload.approval.id === approvalId),
        `Fixture has no approval.requested for ${approvalId}.`
      );
      const decision = requireOne(
        decided.find((event) => event.payload.approvalId === approvalId),
        `Fixture has no approval.decided for ${approvalId}.`
      );
      return Date.parse(decision.occurredAt) - Date.parse(request.occurredAt);
    };

    const gaps = decided.map((event) => waitMs(event.payload.approvalId)).sort((a, b) => a - b);
    // request -> decide gaps: 30s (publish), 60s (plan), 120s (permission), sorted ascending.
    expect(gaps).toEqual([30_000, 60_000, 120_000]);
    expect(gaps).toEqual([
      DASHBOARD_FIXTURE_COMPOSITION.approvalWaitsMs.publishFast,
      DASHBOARD_FIXTURE_COMPOSITION.approvalWaitsMs.planFast,
      DASHBOARD_FIXTURE_COMPOSITION.approvalWaitsMs.permissionReviewing
    ]);
    // Odd sample count (3): the median is the exact middle value once sorted.
    expect(at(gaps, 1)).toBe(60_000);

    const decidedApprovalIds = new Set(decided.map((event) => event.payload.approvalId));
    const pending = requested.filter((event) => !decidedApprovalIds.has(event.payload.approval.id));
    expect(pending).toHaveLength(1);
    expect(at(pending, 0).payload.approval.runId).toBe(DASHBOARD_RUN_IDS.awaitingPlanApproval);
  });

  it("carries the one implement triple at attempt 3 and the fixture's sole publish success", () => {
    const leased = eventsOfType(SEEDED_DASHBOARD_EVENTS, "stage.leased");
    const succeeded = eventsOfType(SEEDED_DASHBOARD_EVENTS, "stage.succeeded");

    const attemptThree = leased.filter((event) => event.payload.attempt === 3);
    expect(attemptThree).toHaveLength(1);
    expect(at(attemptThree, 0).payload.stage).toBe("implement");
    expect(at(attemptThree, 0).payload.runId).toBe(DASHBOARD_RUN_IDS.failed);

    const publishSuccesses = succeeded.filter((event) => event.payload.stage === "publish");
    expect(publishSuccesses).toHaveLength(1);
    expect(at(publishSuccesses, 0).payload.runId).toBe(DASHBOARD_RUN_IDS.completedFast);

    // Every stage is represented at least once among the 19 triples' leased events.
    const stagesSeen = new Set(leased.map((event) => event.payload.stage));
    expect(stagesSeen).toEqual(
      new Set(["triage", "plan", "implement", "verify", "review", "publish"])
    );
  });

  it("reproduces the usage totals (reported sums + unknown counts) from the fixture's own usage events", () => {
    const usageEvents = eventsOfType(SEEDED_DASHBOARD_EVENTS, "agent.session_event").filter(
      (event) => event.payload.event.type === "usage"
    );
    expect(usageEvents).toHaveLength(3);

    const tokenFields = ["input", "output", "cachedInput", "reasoning"] as const;
    const tokenSums = { input: 0, output: 0, cachedInput: 0, reasoning: 0 };
    const tokenUnknownCounts = { input: 0, output: 0, cachedInput: 0, reasoning: 0 };
    let costReportedMicros = 0;
    let costUnknownCount = 0;

    for (const event of usageEvents) {
      const inner = event.payload.event;
      if (inner.type !== "usage") continue;
      for (const field of tokenFields) {
        const count = inner.tokens[field];
        if (count.state === "reported") {
          // A reported 0 contributes to the sum and NOT to the unknown count (the falsy-zero trap).
          tokenSums[field] += count.value;
        } else {
          tokenUnknownCounts[field] += 1;
        }
      }
      if (inner.cost.state === "reported") {
        costReportedMicros += inner.cost.micros;
      } else {
        costUnknownCount += 1;
      }
    }

    // reported input sum  = 1000 (U1) +  800 (U2) +   0 (U3) = 1800
    expect(tokenSums.input).toBe(1_800);
    expect(tokenUnknownCounts.input).toBe(0);
    // reported output sum =  500 (U1) + 200 (U3); U2's output is unknown -> excluded = 700
    expect(tokenSums.output).toBe(700);
    expect(tokenUnknownCounts.output).toBe(1);
    // reported cachedInput = 100 (U1) + 0 (U3); U2's cachedInput is unknown -> excluded = 100
    expect(tokenSums.cachedInput).toBe(100);
    expect(tokenUnknownCounts.cachedInput).toBe(1);
    // reported reasoning = 50 (U1) + 0 (U2) + 0 (U3) = 50, all reported (none unknown).
    expect(tokenSums.reasoning).toBe(50);
    expect(tokenUnknownCounts.reasoning).toBe(0);
    // reported cost sum (micros) = 300_000 (U1) + 0 (U3); U2's cost is unknown -> excluded = 300_000.
    expect(costReportedMicros).toBe(300_000);
    expect(costUnknownCount).toBe(1);

    expect({
      tokens: {
        input: { reportedSum: tokenSums.input, unknownCount: tokenUnknownCounts.input },
        output: { reportedSum: tokenSums.output, unknownCount: tokenUnknownCounts.output },
        cachedInput: {
          reportedSum: tokenSums.cachedInput,
          unknownCount: tokenUnknownCounts.cachedInput
        },
        reasoning: { reportedSum: tokenSums.reasoning, unknownCount: tokenUnknownCounts.reasoning }
      },
      cost: { reportedMicros: costReportedMicros, unknownCount: costUnknownCount }
    }).toEqual(DASHBOARD_FIXTURE_COMPOSITION.usageTotals);
  });
});
