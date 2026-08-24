import { describe, expect, it } from "vitest";

import { ModelRouteSchema, ModelRouteSelectionSchema, ModelUsageSchema } from "../src/model.js";

const credentialRefId = "cred_123e4567-e89b-42d3-a456-426614174000";

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
