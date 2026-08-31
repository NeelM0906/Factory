import { ModelUsageRecordSchema, type ModelCost, type ModelTokenCount } from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import { deriveUsageSummary } from "../src/inspector/usage-summary.js";

const UNKNOWN_TOKEN: ModelTokenCount = { state: "unknown" };
const UNKNOWN_COST: ModelCost = { state: "unknown" };

/**
 * Builds a schema-valid `ModelUsageRecord`, parsed through `ModelUsageRecordSchema` so every
 * fixture is guaranteed to match the real contract shape rather than a hand-typed approximation.
 * Only `tokens`/`cost` vary between tests; every other field is a fixed, valid filler value.
 */
function buildUsageRecord(overrides: {
  tokens?: Partial<{
    input: ModelTokenCount;
    output: ModelTokenCount;
    cachedInput: ModelTokenCount;
    reasoning: ModelTokenCount;
  }>;
  cost?: ModelCost;
}) {
  return ModelUsageRecordSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "idem-usage-1",
    workspaceId: "ws_aaaaaaaa-e89b-42d3-a456-426614174000",
    runId: "run_aaaaaaaa-e89b-42d3-a456-426614174000",
    stageRunId: "stage_aaaaaaaa-e89b-42d3-a456-426614174000",
    stage: "implement",
    adapterId: "adapter.codex",
    routeRef: "route.default",
    requested: { model: "gpt-5" },
    actual: { provider: "openai", model: "gpt-5" },
    tokens: {
      input: overrides.tokens?.input ?? UNKNOWN_TOKEN,
      output: overrides.tokens?.output ?? UNKNOWN_TOKEN,
      cachedInput: overrides.tokens?.cachedInput ?? UNKNOWN_TOKEN,
      reasoning: overrides.tokens?.reasoning ?? UNKNOWN_TOKEN
    },
    cost: overrides.cost ?? UNKNOWN_COST,
    latencyMs: 100,
    outcome: "succeeded",
    recordedAt: "2026-08-26T00:00:00.000Z"
  });
}

describe("deriveUsageSummary", () => {
  it("displays a reported token value of 0 as 0, not as undefined (falsy-zero trap)", () => {
    const record = buildUsageRecord({ tokens: { input: { state: "reported", value: 0 } } });

    const summary = deriveUsageSummary(record);

    expect(summary.inputTokens).toBe(0);
  });

  it("displays an unknown token count as undefined, never a fabricated 0", () => {
    const record = buildUsageRecord({ tokens: { input: { state: "unknown" } } });

    const summary = deriveUsageSummary(record);

    expect(summary.inputTokens).toBeUndefined();
    expect(summary.inputTokens).not.toBe(0);
  });

  it("maps every token field independently (output, cachedInput, reasoning)", () => {
    const record = buildUsageRecord({
      tokens: {
        input: { state: "reported", value: 12 },
        output: { state: "reported", value: 34 },
        cachedInput: { state: "unknown" },
        reasoning: { state: "reported", value: 0 }
      }
    });

    const summary = deriveUsageSummary(record);

    expect(summary.inputTokens).toBe(12);
    expect(summary.outputTokens).toBe(34);
    expect(summary.cachedInputTokens).toBeUndefined();
    expect(summary.reasoningTokens).toBe(0);
  });

  it("formats a reported cost deterministically as an exact micros-to-dollars string", () => {
    const record = buildUsageRecord({
      cost: { state: "reported", currency: "USD", micros: 1234567 }
    });

    const summary = deriveUsageSummary(record);

    expect(summary.cost).toBe("$1.234567");
  });

  it("formats a reported cost of 0 micros as $0.000000, not undefined", () => {
    const record = buildUsageRecord({ cost: { state: "reported", currency: "USD", micros: 0 } });

    const summary = deriveUsageSummary(record);

    expect(summary.cost).toBe("$0.000000");
  });

  it("displays an unknown cost as undefined and never as a string containing 0", () => {
    const record = buildUsageRecord({ cost: { state: "unknown" } });

    const summary = deriveUsageSummary(record);

    expect(summary.cost).toBeUndefined();
  });
});
