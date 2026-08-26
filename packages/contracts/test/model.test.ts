import { describe, expect, it } from "vitest";

import {
  ModelCatalogEntrySchema,
  ModelPolicySchema,
  ModelRouteFallbackSchema,
  ModelRouteSchema,
  ModelRouteSelectionSchema,
  ModelUsageRecordSchema,
  ModelUsageSchema
} from "../src/model.js";

const credentialRefId = "cred_123e4567-e89b-42d3-a456-426614174000";
const attribution = {
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000",
  stageRunId: "stage_123e4567-e89b-42d3-a456-426614174000"
} as const;
const catalogEntry = () => ({
  schemaVersion: 1 as const,
  routeRef: "route.gateway.default",
  providerModel: "anthropic/claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  features: ["tool_call", "structured_output", "streaming"],
  contextWindowTokens: 200_000,
  maxOutputTokens: 64_000,
  discoveredAt: "2026-08-23T12:00:00.000Z"
});
const usageRecord = () => ({
  schemaVersion: 1 as const,
  idempotencyKey: "model-usage:run:plan:1",
  ...attribution,
  stage: "plan" as const,
  adapterId: "native.autostack.v1",
  routeRef: "route.gateway.default",
  requested: { provider: "anthropic", model: "claude-sonnet-4" },
  actual: {
    provider: "anthropic",
    model: "claude-sonnet-4-20260101",
    providerRequestId: "provider-request-1"
  },
  tokens: {
    input: { state: "reported" as const, value: 1_200 },
    output: { state: "reported" as const, value: 380 },
    cachedInput: { state: "unknown" as const },
    reasoning: { state: "unknown" as const }
  },
  cost: { state: "reported" as const, currency: "USD" as const, micros: 4_200 },
  latencyMs: 1_800,
  outcome: "succeeded" as const,
  recordedAt: "2026-08-23T12:00:02.000Z"
});
const modelPolicy = () => ({
  schemaVersion: 1 as const,
  policyRef: "policy.personal.plan",
  stage: "plan" as const,
  allowedRouteRefs: ["route.gateway.default", "route.openrouter.default"],
  fallbackRouteRefs: ["route.openrouter.default"],
  maxInputTokens: 120_000,
  maxOutputTokens: 16_000,
  maxCostMicros: 500_000,
  reasoningLevel: "medium" as const
});

describe("model routing contracts", () => {
  it.each([
    { kind: "vercel_ai_gateway", gatewayModel: "anthropic/claude-sonnet-4" },
    { kind: "openrouter", openRouterModel: "anthropic/claude-sonnet-4" },
    {
      kind: "direct",
      protocol: "openai_compatible",
      provider: "example",
      endpoint: "https://models.example.test/v1",
      providerModel: "reasoner-v1"
    }
  ] as const)("admits a strict $kind route", (transport) => {
    const route = ModelRouteSchema.parse({
      schemaVersion: 1,
      routeRef: `route.${transport.kind}.default`,
      displayName: transport.kind,
      transport: { ...transport, credentialRefId },
      enabled: true
    });
    expect(route.transport.kind).toBe(transport.kind);
  });

  it("rejects embedded provider secrets", () => {
    expect(() =>
      ModelRouteSchema.parse({
        schemaVersion: 1,
        routeRef: "route.bad",
        displayName: "bad",
        transport: {
          kind: "openrouter",
          openRouterModel: "model",
          credentialRefId,
          apiKey: "secret"
        },
        enabled: true
      })
    ).toThrow();

    for (const endpoint of [
      "https://user@models.example.test/v1",
      "https://user:password@models.example.test/v1"
    ]) {
      expect(() =>
        ModelRouteSchema.parse({
          schemaVersion: 1,
          routeRef: "route.bad.direct",
          displayName: "bad direct route",
          transport: {
            kind: "direct",
            protocol: "openai_compatible",
            provider: "example",
            endpoint,
            providerModel: "reasoner-v1",
            credentialRefId
          },
          enabled: true
        })
      ).toThrow();
    }
  });

  it("binds route selection and usage to idempotent requests", () => {
    const selection = ModelRouteSelectionSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "model-route:run:plan:1",
      routeRef: "route.gateway.default",
      reason: "workspace default",
      selectedAt: "2026-08-23T12:00:00.000Z"
    });
    const usage = ModelUsageSchema.parse({
      schemaVersion: 1,
      idempotencyKey: selection.idempotencyKey,
      routeRef: selection.routeRef,
      providerRequestId: "provider-request-1",
      provider: "anthropic",
      model: "claude-sonnet-4",
      tokens: { input: 10, output: 4, cachedInput: 2, reasoning: 1 },
      cost: { currency: "USD", micros: 1250 },
      latencyMs: 420,
      recordedAt: "2026-08-23T12:00:01.000Z"
    });
    expect(usage.tokens.input).toBe(10);
    expect(() => ModelUsageSchema.parse({ ...usage, latencyMs: -1 })).toThrow();
  });
});

describe("model catalog discovery", () => {
  it("declares discovered modalities and features for capability filtering", () => {
    const entry = ModelCatalogEntrySchema.parse(catalogEntry());
    expect(entry.inputModalities).toEqual(["text", "image"]);
    expect(entry.features).toContain("structured_output");
  });

  it("rejects undiscoverable modalities and duplicate features", () => {
    expect(() =>
      ModelCatalogEntrySchema.parse({ ...catalogEntry(), inputModalities: ["telepathy"] })
    ).toThrow();
    expect(() => ModelCatalogEntrySchema.parse({ ...catalogEntry(), features: [] })).not.toThrow();
    expect(() =>
      ModelCatalogEntrySchema.parse({ ...catalogEntry(), features: ["tool_call", "tool_call"] })
    ).toThrow();
  });
});

describe("model usage normalization", () => {
  it("separates requested from actual provider and model", () => {
    const usage = ModelUsageRecordSchema.parse(usageRecord());
    expect(usage.requested.model).toBe("claude-sonnet-4");
    expect(usage.actual.model).toBe("claude-sonnet-4-20260101");
    expect(usage.outcome).toBe("succeeded");
  });

  it("records missing provider usage as unknown rather than zero", () => {
    const record = usageRecord();
    const unknown = ModelUsageRecordSchema.parse({
      ...record,
      tokens: {
        input: { state: "unknown" },
        output: { state: "unknown" },
        cachedInput: { state: "unknown" },
        reasoning: { state: "unknown" }
      },
      cost: { state: "unknown" }
    });
    expect(unknown.tokens.input).toEqual({ state: "unknown" });
    expect(unknown.cost).toEqual({ state: "unknown" });

    expect(() =>
      ModelUsageRecordSchema.parse({
        ...record,
        cost: { state: "unknown", micros: 10 }
      })
    ).toThrow();
    expect(() =>
      ModelUsageRecordSchema.parse({
        ...record,
        tokens: { ...record.tokens, input: { state: "reported", value: -1 } }
      })
    ).toThrow();
  });
});

describe("model route fallback", () => {
  it("records the provider fallback that actually served the request", () => {
    const fallback = ModelRouteFallbackSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "model-fallback:run:plan:1",
      ...attribution,
      from: { routeRef: "route.gateway.default", model: "anthropic/claude-sonnet-4" },
      to: { routeRef: "route.openrouter.default", model: "anthropic/claude-sonnet-4" },
      failureCode: "provider_rate_limited",
      reason: "Gateway returned 429 for the requested provider.",
      occurredAt: "2026-08-23T12:00:01.000Z"
    });
    expect(fallback.to.routeRef).toBe("route.openrouter.default");
  });

  it("rejects a fallback that changes nothing", () => {
    expect(() =>
      ModelRouteFallbackSchema.parse({
        schemaVersion: 1,
        idempotencyKey: "model-fallback:run:plan:1",
        ...attribution,
        from: { routeRef: "route.gateway.default", model: "anthropic/claude-sonnet-4" },
        to: { routeRef: "route.gateway.default", model: "anthropic/claude-sonnet-4" },
        failureCode: "provider_rate_limited",
        reason: "Gateway returned 429 for the requested provider.",
        occurredAt: "2026-08-23T12:00:01.000Z"
      })
    ).toThrow();
  });
});

describe("model policy", () => {
  it("constrains routes, ceilings, and reasoning level per station", () => {
    const policy = ModelPolicySchema.parse(modelPolicy());
    expect(policy.stage).toBe("plan");
    expect(policy.maxCostMicros).toBe(500_000);
    expect(policy.reasoningLevel).toBe("medium");
  });

  it("cannot fall back to a route it does not allow", () => {
    expect(() =>
      ModelPolicySchema.parse({
        ...modelPolicy(),
        fallbackRouteRefs: ["route.direct.xai"]
      })
    ).toThrow();
  });

  it("requires a non-empty, duplicate-free allow list", () => {
    expect(() => ModelPolicySchema.parse({ ...modelPolicy(), allowedRouteRefs: [] })).toThrow();
    expect(() =>
      ModelPolicySchema.parse({
        ...modelPolicy(),
        allowedRouteRefs: ["route.gateway.default", "route.gateway.default"]
      })
    ).toThrow();
    expect(() =>
      ModelPolicySchema.parse({
        ...modelPolicy(),
        fallbackRouteRefs: ["route.openrouter.default", "route.openrouter.default"]
      })
    ).toThrow();
  });
});
