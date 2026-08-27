import { describe, expect, it, vi } from "vitest";

import { ModelRouteFallbackSchema, createId, type ModelRouteContext } from "@autostack/contracts";

import {
  capabilityUnavailable,
  providerError,
  rateLimited
} from "../src/failure/routing-failure.js";
import { runWithFallback, type ModelRouteTarget } from "../src/fallback/fallback-runner.js";
import type { ModelRouteEventSink } from "../src/fallback/route-event-sink.js";

const WORKSPACE_ID = createId("workspace", "00000000-0000-4000-8000-000000000001");
const RUN_ID = createId("run", "00000000-0000-4000-8000-000000000002");
const STAGE_RUN_ID = createId("stageRun", "00000000-0000-4000-8000-000000000003");

const context: ModelRouteContext = {
  schemaVersion: 1,
  idempotencyKey: "idem-1",
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  stageRunId: STAGE_RUN_ID,
  stage: "implement",
  requiredCapabilities: []
};

const routeA: ModelRouteTarget = { routeRef: "route:openai", model: "gpt-5" };
const routeB: ModelRouteTarget = { routeRef: "route:anthropic", model: "claude-opus" };
const routeC: ModelRouteTarget = { routeRef: "route:xai", model: "grok-4" };

const OCCURRED_AT = "2026-08-27T00:00:00.000Z";
const now = (): string => OCCURRED_AT;

const createSink = (): ModelRouteEventSink & { record: ReturnType<typeof vi.fn> } => ({
  record: vi.fn(async () => {})
});

describe("runWithFallback", () => {
  it("succeeds on the first target and records no fallback", async () => {
    const sink = createSink();
    const attempt = vi.fn(async (_target: ModelRouteTarget, _ordinal: number) => "ok");

    const result = await runWithFallback({ order: [routeA, routeB], context, attempt, sink, now });

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenNthCalledWith(1, routeA, 0);
    expect(sink.record).not.toHaveBeenCalled();
  });

  it("advances to the next target on a retryable failure and records one fallback", async () => {
    const sink = createSink();
    const failure = providerError({ routeRef: routeA.routeRef, statusCode: 503, retryable: true });
    const attempt = vi.fn(async (_target: ModelRouteTarget, ordinal: number) => {
      if (ordinal === 0) {
        throw failure;
      }
      return "ok";
    });

    const result = await runWithFallback({ order: [routeA, routeB], context, attempt, sink, now });

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenNthCalledWith(1, routeA, 0);
    expect(attempt).toHaveBeenNthCalledWith(2, routeB, 1);
    expect(sink.record).toHaveBeenCalledTimes(1);

    const [event] = sink.record.mock.calls[0] as [unknown];
    expect(() => ModelRouteFallbackSchema.parse(event)).not.toThrow();
    const parsed = ModelRouteFallbackSchema.parse(event);
    expect(parsed.from).toEqual(routeA);
    expect(parsed.to).toEqual(routeB);
    expect(parsed.failureCode).toBe("provider_error");
    expect(parsed.workspaceId).toBe(context.workspaceId);
    expect(parsed.runId).toBe(context.runId);
    expect(parsed.stageRunId).toBe(context.stageRunId);
    expect(parsed.idempotencyKey).toBe(context.idempotencyKey);
    expect(parsed.occurredAt).toBe(OCCURRED_AT);
  });

  it("does not advance and records no fallback on a non-retryable failure", async () => {
    const sink = createSink();
    const failure = capabilityUnavailable({ required: ["tool_call"], absentPins: [] });
    const attempt = vi.fn(async (_target: ModelRouteTarget, _ordinal: number) => {
      throw failure;
    });

    await expect(
      runWithFallback({ order: [routeA, routeB], context, attempt, sink, now })
    ).rejects.toBe(failure);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sink.record).not.toHaveBeenCalled();
  });

  it("increments ordinals across every attempt and records two fallbacks in activation order", async () => {
    const sink = createSink();
    const failA = providerError({ routeRef: routeA.routeRef, retryable: true });
    const failB = rateLimited({ routeRef: routeB.routeRef });
    const attempt = vi.fn(async (_target: ModelRouteTarget, ordinal: number) => {
      if (ordinal === 0) {
        throw failA;
      }
      if (ordinal === 1) {
        throw failB;
      }
      return "ok";
    });

    const result = await runWithFallback({
      order: [routeA, routeB, routeC],
      context,
      attempt,
      sink,
      now
    });

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenNthCalledWith(1, routeA, 0);
    expect(attempt).toHaveBeenNthCalledWith(2, routeB, 1);
    expect(attempt).toHaveBeenNthCalledWith(3, routeC, 2);
    expect(sink.record).toHaveBeenCalledTimes(2);

    const firstEvent = ModelRouteFallbackSchema.parse(sink.record.mock.calls[0]?.[0]);
    const secondEvent = ModelRouteFallbackSchema.parse(sink.record.mock.calls[1]?.[0]);
    expect(firstEvent.from).toEqual(routeA);
    expect(firstEvent.to).toEqual(routeB);
    expect(firstEvent.failureCode).toBe("provider_error");
    expect(secondEvent.from).toEqual(routeB);
    expect(secondEvent.to).toEqual(routeC);
    expect(secondEvent.failureCode).toBe("rate_limited");
  });

  it("re-raises the last failure, preserving its code and retryability, when the order is exhausted", async () => {
    const sink = createSink();
    const failA = providerError({ routeRef: routeA.routeRef, retryable: true });
    const failB = rateLimited({ routeRef: routeB.routeRef });
    const attempt = vi.fn(async (_target: ModelRouteTarget, ordinal: number) => {
      if (ordinal === 0) {
        throw failA;
      }
      throw failB;
    });

    await expect(
      runWithFallback({ order: [routeA, routeB], context, attempt, sink, now })
    ).rejects.toBe(failB);

    expect(attempt).toHaveBeenCalledTimes(2);
    // Only the A->B fallback is recorded; there is no further target to fall back to after B fails.
    expect(sink.record).toHaveBeenCalledTimes(1);
  });

  it("awaits the sink and propagates a sink rejection instead of swallowing it", async () => {
    const sinkError = new Error("sink unavailable");
    const sink: ModelRouteEventSink & { record: ReturnType<typeof vi.fn> } = {
      record: vi.fn(async () => {
        throw sinkError;
      })
    };
    const failure = providerError({ routeRef: routeA.routeRef, retryable: true });
    const attempt = vi.fn(async (_target: ModelRouteTarget, ordinal: number) => {
      if (ordinal === 0) {
        throw failure;
      }
      return "ok";
    });

    await expect(
      runWithFallback({ order: [routeA, routeB], context, attempt, sink, now })
    ).rejects.toBe(sinkError);

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("raises before calling attempt when adjacent targets share both routeRef and model", async () => {
    const sink = createSink();
    const attempt = vi.fn(async (_target: ModelRouteTarget, _ordinal: number) => "ok");
    const degenerateOrder: ModelRouteTarget[] = [routeA, { ...routeA }, routeB];

    await expect(
      runWithFallback({ order: degenerateOrder, context, attempt, sink, now })
    ).rejects.toThrow(TypeError);

    expect(attempt).not.toHaveBeenCalled();
    expect(sink.record).not.toHaveBeenCalled();
  });
});
