import { describe, expect, it } from "vitest";

import { ModelUsageRecordSchema, createId, type ModelRouteContext } from "@autostack/contracts";

import {
  normalizeUsage,
  type NormalizeUsageInput,
  type ProviderReportedUsage
} from "../src/usage/normalize-usage.js";
import type { RoutePricing } from "../src/catalog/catalog-types.js";

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

const RECORDED_AT = "2026-08-27T00:00:00.000Z";
const now = (): string => RECORDED_AT;

const baseInput: NormalizeUsageInput = {
  context,
  routeRef: "route:openai",
  adapterId: "adapter:harness",
  attempt: 0,
  requested: { provider: "openai", model: "gpt-5" },
  actual: { provider: "openai", model: "gpt-5", providerRequestId: "req:abc123" },
  providerUsage: {},
  latencyMs: 250,
  outcome: "succeeded",
  now
};

describe("normalizeUsage", () => {
  it("derives attribution from the request context, ignoring conflicting provider-reported values", () => {
    const hostileWorkspace = createId("workspace", "00000000-0000-4000-8000-00000000dead");
    const hostileRun = createId("run", "00000000-0000-4000-8000-00000000dead");
    const hostileStageRun = createId("stageRun", "00000000-0000-4000-8000-00000000dead");
    const providerUsage: ProviderReportedUsage = {
      workspaceId: hostileWorkspace,
      runId: hostileRun,
      stageRunId: hostileStageRun,
      stage: "triage",
      routeRef: "route:some-other-route",
      idempotencyKey: "idem-hostile"
    };

    const record = normalizeUsage({ ...baseInput, providerUsage });

    expect(record.workspaceId).toBe(context.workspaceId);
    expect(record.workspaceId).not.toBe(hostileWorkspace);
    expect(record.runId).toBe(context.runId);
    expect(record.runId).not.toBe(hostileRun);
    expect(record.stageRunId).toBe(context.stageRunId);
    expect(record.stageRunId).not.toBe(hostileStageRun);
    expect(record.stage).toBe(context.stage);
    expect(record.stage).not.toBe("triage");
    expect(record.routeRef).toBe(baseInput.routeRef);
    expect(record.routeRef).not.toBe("route:some-other-route");
    expect(record.idempotencyKey).toBe(context.idempotencyKey);
    expect(record.idempotencyKey).not.toBe("idem-hostile");
  });

  it("reports all four token counts when the provider reports all four", () => {
    const providerUsage: ProviderReportedUsage = {
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 10,
      reasoningTokens: 5
    };

    const record = normalizeUsage({ ...baseInput, providerUsage });

    expect(record.tokens.input).toEqual({ state: "reported", value: 100 });
    expect(record.tokens.output).toEqual({ state: "reported", value: 40 });
    expect(record.tokens.cachedInput).toEqual({ state: "reported", value: 10 });
    expect(record.tokens.reasoning).toEqual({ state: "reported", value: 5 });
  });

  it("reports all four token counts unknown, and cost unknown, when the provider reports none", () => {
    const record = normalizeUsage({ ...baseInput, providerUsage: {} });

    expect(record.tokens.input).toEqual({ state: "unknown" });
    expect(record.tokens.output).toEqual({ state: "unknown" });
    expect(record.tokens.cachedInput).toEqual({ state: "unknown" });
    expect(record.tokens.reasoning).toEqual({ state: "unknown" });
    expect(record.cost).toEqual({ state: "unknown" });
  });

  it("keeps partial data partial: input and output reported, cached and reasoning absent", () => {
    const providerUsage: ProviderReportedUsage = { inputTokens: 100, outputTokens: 40 };

    const record = normalizeUsage({ ...baseInput, providerUsage });

    expect(record.tokens.input).toEqual({ state: "reported", value: 100 });
    expect(record.tokens.output).toEqual({ state: "reported", value: 40 });
    expect(record.tokens.cachedInput).toEqual({ state: "unknown" });
    expect(record.tokens.reasoning).toEqual({ state: "unknown" });
  });

  it("treats a negative, non-integer, or non-numeric provider count as unknown rather than coercing it", () => {
    const providerUsage: ProviderReportedUsage = {
      inputTokens: -5,
      outputTokens: 12.5,
      cachedInputTokens: "3",
      reasoningTokens: Number.NaN
    };

    const record = normalizeUsage({ ...baseInput, providerUsage });

    expect(record.tokens.input).toEqual({ state: "unknown" });
    expect(record.tokens.output).toEqual({ state: "unknown" });
    expect(record.tokens.cachedInput).toEqual({ state: "unknown" });
    expect(record.tokens.reasoning).toEqual({ state: "unknown" });
  });

  it("reports cost directly when the provider reports it", () => {
    const providerUsage: ProviderReportedUsage = { costMicros: 4_200 };

    const record = normalizeUsage({ ...baseInput, providerUsage });

    expect(record.cost).toEqual({ state: "reported", currency: "USD", micros: 4_200 });
  });

  it("derives cost exactly from route pricing when both input and output token counts are reported", () => {
    const pricing: RoutePricing = { inputUsdPerToken: 0.000_002, outputUsdPerToken: 0.000_004 };
    const providerUsage: ProviderReportedUsage = { inputTokens: 1_000, outputTokens: 500 };
    // 1000 * 0.000002 = 0.002 USD; 500 * 0.000004 = 0.002 USD; total 0.004 USD = 4000 micros.

    const record = normalizeUsage({ ...baseInput, providerUsage, pricing });

    expect(record.cost).toEqual({ state: "reported", currency: "USD", micros: 4_000 });
  });

  it("leaves cost unknown when derivation would require an unknown token count", () => {
    const pricing: RoutePricing = { inputUsdPerToken: 0.000_002, outputUsdPerToken: 0.000_004 };
    // Output is unreported, so a derived cost would be an estimate — forbidden.
    const providerUsage: ProviderReportedUsage = { inputTokens: 1_000 };

    const record = normalizeUsage({ ...baseInput, providerUsage, pricing });

    expect(record.tokens.output).toEqual({ state: "unknown" });
    expect(record.cost).toEqual({ state: "unknown" });
  });

  it("leaves cost unknown when pricing is absent even though both token counts are reported", () => {
    const providerUsage: ProviderReportedUsage = { inputTokens: 1_000, outputTokens: 500 };

    const record = normalizeUsage({ ...baseInput, providerUsage });

    expect(record.cost).toEqual({ state: "unknown" });
  });

  it("carries both the requested and actual model when they differ after a fallback", () => {
    const record = normalizeUsage({
      ...baseInput,
      requested: { provider: "openai", model: "gpt-5" },
      actual: { provider: "anthropic", model: "claude-opus", providerRequestId: "req:xyz" }
    });

    expect(record.requested).toEqual({ provider: "openai", model: "gpt-5" });
    expect(record.actual.provider).toBe("anthropic");
    expect(record.actual.model).toBe("claude-opus");
  });

  it("assigns the zero-based attempt ordinal across a three-attempt chain under one idempotencyKey", () => {
    const first = normalizeUsage({ ...baseInput, attempt: 0 });
    const second = normalizeUsage({ ...baseInput, attempt: 1 });
    const third = normalizeUsage({ ...baseInput, attempt: 2 });

    expect(first.attempt).toBe(0);
    expect(second.attempt).toBe(1);
    expect(third.attempt).toBe(2);
    expect(new Set([first.idempotencyKey, second.idempotencyKey, third.idempotencyKey]).size).toBe(
      1
    );
  });

  it("still produces a record for a failed attempt, carrying whatever the provider billed", () => {
    const providerUsage: ProviderReportedUsage = {
      inputTokens: 80,
      outputTokens: 0,
      costMicros: 1_000
    };

    const record = normalizeUsage({
      ...baseInput,
      outcome: "failed",
      providerUsage
    });

    expect(record.outcome).toBe("failed");
    expect(record.tokens.input).toEqual({ state: "reported", value: 80 });
    expect(record.cost).toEqual({ state: "reported", currency: "USD", micros: 1_000 });
  });

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "accepts %s as a valid outcome",
    (outcome) => {
      const record = normalizeUsage({ ...baseInput, outcome });
      expect(record.outcome).toBe(outcome);
    }
  );

  it("produces a record that always passes ModelUsageRecordSchema.parse", () => {
    const record = normalizeUsage({
      ...baseInput,
      providerUsage: { inputTokens: 10, outputTokens: 20, costMicros: 99 }
    });

    expect(() => ModelUsageRecordSchema.parse(record)).not.toThrow();
  });

  it("never takes providerRequestId from the untrusted providerUsage payload", () => {
    const providerUsage: ProviderReportedUsage = {
      providerRequestId: "not a valid stable ref !!! ///"
    };

    const record = normalizeUsage({
      ...baseInput,
      actual: { provider: "openai", model: "gpt-5" },
      providerUsage
    });

    expect(record.actual.providerRequestId).toBeUndefined();
  });

  it("carries no provider response text, only numeric usage and the caller-supplied identifiers", () => {
    const providerUsage: ProviderReportedUsage = {
      inputTokens: 10,
      outputTokens: 5,
      rawResponseBody: "some huge provider response blob",
      headers: { authorization: "Bearer secret-token" }
    };

    const record = normalizeUsage({ ...baseInput, providerUsage });
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain("some huge provider response blob");
    expect(serialized).not.toContain("Bearer secret-token");
  });
});
