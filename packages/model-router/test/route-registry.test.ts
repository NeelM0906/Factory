import { describe, expect, it, vi } from "vitest";

import {
  ModelRouteSchema,
  ModelUsageSchema,
  type ModelRoute,
  type ModelUsage
} from "@autostack/contracts";

import { createRouteRegistry, type ExactUsageSink } from "../src/route-registry.js";

const credentialRefId = "cred_123e4567-e89b-42d3-a456-426614174000";

const gatewayRoute = {
  schemaVersion: 1,
  routeRef: "route.gateway.sonnet",
  displayName: "Gateway Sonnet",
  transport: {
    kind: "vercel_ai_gateway",
    gatewayModel: "anthropic/claude-sonnet",
    credentialRefId
  },
  enabled: true
};

const openRouterRoute = {
  schemaVersion: 1,
  routeRef: "route.openrouter.sonnet",
  displayName: "OpenRouter Sonnet",
  transport: {
    kind: "openrouter",
    openRouterModel: "anthropic/claude-sonnet",
    credentialRefId
  },
  enabled: true
};

const directRoute = {
  schemaVersion: 1,
  routeRef: "route.direct.openai",
  displayName: "Direct OpenAI",
  transport: {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    providerModel: "gpt-4o",
    credentialRefId
  },
  enabled: true
};

const disabledRoute = {
  schemaVersion: 1,
  routeRef: "route.disabled.sonnet",
  displayName: "Disabled Sonnet",
  transport: {
    kind: "vercel_ai_gateway",
    gatewayModel: "anthropic/claude-sonnet",
    credentialRefId
  },
  enabled: false
};

const noopSink: ExactUsageSink = {
  record: async () => {}
};

describe("createRouteRegistry", () => {
  it("admits every route through ModelRouteSchema.parse at construction", () => {
    const registry = createRouteRegistry({
      routes: [gatewayRoute, openRouterRoute],
      exactUsageSink: noopSink
    });

    const expected: ModelRoute[] = [gatewayRoute, openRouterRoute].map((route) =>
      ModelRouteSchema.parse(route)
    );
    expect(registry.list()).toEqual(expected);
  });

  it("throws on the first invalid route, naming the index but never the credentialRefId", () => {
    const invalidRoute = {
      ...gatewayRoute,
      routeRef: "route with spaces" // fails StableRefSchema's pattern
    };

    let caught: unknown;
    try {
      createRouteRegistry({
        routes: [gatewayRoute, invalidRoute],
        exactUsageSink: noopSink
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    const message = (caught as TypeError).message;
    expect(message).toContain("1");
    expect(message).not.toContain(credentialRefId);
  });

  it("rejects duplicate routeRef values", () => {
    expect(() =>
      createRouteRegistry({
        routes: [gatewayRoute, { ...openRouterRoute, routeRef: gatewayRoute.routeRef }],
        exactUsageSink: noopSink
      })
    ).toThrow(TypeError);
  });

  it("returns a frozen route from getRoute(routeRef) and undefined for an unknown ref", () => {
    const registry = createRouteRegistry({
      routes: [gatewayRoute],
      exactUsageSink: noopSink
    });

    const route = registry.getRoute(gatewayRoute.routeRef);
    expect(route).toEqual(ModelRouteSchema.parse(gatewayRoute));
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route?.transport)).toBe(true);

    expect(registry.getRoute("route.unknown")).toBeUndefined();
  });

  it("returns routes in declaration order from list(), including disabled ones", () => {
    const registry = createRouteRegistry({
      routes: [disabledRoute, gatewayRoute, openRouterRoute],
      exactUsageSink: noopSink
    });

    expect(registry.list().map((route) => route.routeRef)).toEqual([
      disabledRoute.routeRef,
      gatewayRoute.routeRef,
      openRouterRoute.routeRef
    ]);
    expect(registry.list().some((route) => route.enabled === false)).toBe(true);
  });

  it("exposes pinnedModel(route) over an exhaustive switch per transport kind", () => {
    const registry = createRouteRegistry({
      routes: [gatewayRoute, openRouterRoute, directRoute],
      exactUsageSink: noopSink
    });

    const [gateway, openRouter, direct] = registry.list();
    expect(registry.pinnedModel(gateway!)).toBe("anthropic/claude-sonnet");
    expect(registry.pinnedModel(openRouter!)).toBe("anthropic/claude-sonnet");
    expect(registry.pinnedModel(direct!)).toBe("gpt-4o");
  });
});

describe("recordUsage", () => {
  const validUsage: ModelUsage = ModelUsageSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "idem-1",
    routeRef: gatewayRoute.routeRef,
    providerRequestId: "req-1",
    provider: "anthropic",
    model: "claude-sonnet",
    tokens: { input: 10, output: 20 },
    cost: { currency: "USD", micros: 1_000 },
    latencyMs: 500,
    recordedAt: "2026-08-26T12:00:00.000Z"
  });

  it("forwards a valid payload to the injected ExactUsageSink exactly once", async () => {
    const record = vi.fn(async () => {});
    const registry = createRouteRegistry({
      routes: [gatewayRoute],
      exactUsageSink: { record }
    });

    await registry.recordUsage(validUsage);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(validUsage);
  });

  it("rejects a payload failing ModelUsageSchema before the sink is touched, with no field values leaked", async () => {
    const record = vi.fn(async () => {});
    const registry = createRouteRegistry({
      routes: [gatewayRoute],
      exactUsageSink: { record }
    });

    const invalidUsage = { ...validUsage, tokens: { ...validUsage.tokens, input: -1 } };

    await expect(registry.recordUsage(invalidUsage)).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });
});
