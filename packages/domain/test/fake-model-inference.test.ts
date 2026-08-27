import { describe, expect, it } from "vitest";

import {
  ModelInferenceRequestSchema,
  ModelInferenceResultSchema,
  ModelRoutingError,
  type ModelInferenceRequest
} from "@autostack/contracts";

import {
  createFakeModelInference,
  type FakeModelInferenceOutcome
} from "../src/testing/fake-model-inference.js";

const createClock = (): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 26, 12, 0, tick)).toISOString();
  };
};

const request = (overrides: { readonly idempotencyKey?: string } = {}): ModelInferenceRequest =>
  ModelInferenceRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: overrides.idempotencyKey ?? "model-infer:run:plan:1",
    selection: {
      schemaVersion: 1,
      idempotencyKey: overrides.idempotencyKey ?? "model-infer:run:plan:1",
      routeRef: "route.gateway.sonnet",
      reason: "Only allowed route for the plan station.",
      selectedAt: "2026-08-26T11:59:00.000Z"
    },
    messages: [
      { role: "system", content: "You produce a plan document." },
      { role: "user", content: "Fix the failing regression." }
    ],
    options: { maxOutputTokens: 4_096, responseFormat: "json" }
  });

const completion = {
  content: '{"summary":"Fix the regression."}',
  actual: { provider: "anthropic", model: "anthropic/claude-sonnet-4", providerRequestId: "req-1" },
  tokens: {
    input: { state: "reported", value: 900 },
    output: { state: "reported", value: 120 },
    cachedInput: { state: "unknown" },
    reasoning: { state: "unknown" }
  },
  cost: { state: "unknown" },
  finishReason: "stop",
  latencyMs: 1_400
} as const;

const createInference = (outcomes: readonly FakeModelInferenceOutcome[]) =>
  createFakeModelInference({ outcomes, now: createClock() });

describe("fake model inference", () => {
  it("returns scripted completions in request order, bound to the resolved route", async () => {
    const inference = createInference([
      { kind: "completed", result: completion },
      { kind: "completed", result: { ...completion, finishReason: "length" } }
    ]);

    const first = await inference.run(request());
    const second = await inference.run(request({ idempotencyKey: "model-infer:run:plan:2" }));

    expect(ModelInferenceResultSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      idempotencyKey: "model-infer:run:plan:1",
      routeRef: "route.gateway.sonnet",
      finishReason: "stop",
      cost: { state: "unknown" }
    });
    expect(second).toMatchObject({
      idempotencyKey: "model-infer:run:plan:2",
      finishReason: "length"
    });
    expect(Date.parse(second.completedAt)).toBeGreaterThan(Date.parse(first.completedAt));
    expect(inference.requests.map((recorded) => recorded.idempotencyKey)).toEqual([
      "model-infer:run:plan:1",
      "model-infer:run:plan:2"
    ]);
  });

  it("raises the contract routing taxonomy rather than a local error type", async () => {
    const inference = createInference([
      {
        kind: "failure",
        failure: {
          code: "rate_limited",
          message: "The gateway rejected the request.",
          retryable: true,
          routeRef: "route.gateway.sonnet"
        }
      },
      { kind: "completed", result: completion }
    ]);

    const failure = await inference.run(request()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure).toMatchObject({ code: "rate_limited", retryable: true });
    expect(await inference.run(request())).toMatchObject({ finishReason: "stop" });
    expect(inference.requests).toHaveLength(2);
  });

  it("refuses a scripted result the contract would reject", async () => {
    const inference = createInference([
      { kind: "completed", result: { ...completion, latencyMs: -1 } }
    ]);

    await expect(inference.run(request())).rejects.toThrow();
    expect(inference.requests).toHaveLength(1);
  });

  it("refuses to answer once the script is exhausted", async () => {
    const inference = createInference([]);

    await expect(inference.run(request())).rejects.toThrow(/scripted/i);
  });

  it("hands out copies so a consumer cannot mutate recorded state", async () => {
    const inference = createInference([{ kind: "completed", result: completion }]);
    await inference.run(request());

    const view = inference.requests;
    view.slice().pop();
    expect(inference.requests).toHaveLength(1);
    expect(inference.requests).not.toBe(view);
  });
});
