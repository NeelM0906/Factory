import { describe, expect, it } from "vitest";

import {
  ModelCatalogEntrySchema,
  ModelRoutingError,
  ModelRouteContextSchema,
  ModelRouteSchema,
  ModelRouteSelectionSchema,
  ModelUsageRecordSchema,
  ModelUsageSchema,
  type ModelRouteContext
} from "@autostack/contracts";

import {
  createFakeModelRouter,
  type FakeModelRouterOutcome,
  type FakeModelRouteDeclaration
} from "../src/testing/fake-model-router.js";

const credentialRefId = "cred_123e4567-e89b-42d3-a456-426614174000";

const createClock = (): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 26, 12, 0, tick)).toISOString();
  };
};

const gateway: FakeModelRouteDeclaration = {
  route: ModelRouteSchema.parse({
    schemaVersion: 1,
    routeRef: "route.gateway.sonnet",
    displayName: "Gateway Sonnet",
    transport: {
      kind: "vercel_ai_gateway",
      gatewayModel: "anthropic/claude-sonnet",
      credentialRefId
    },
    enabled: true
  }),
  catalogEntry: ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef: "route.gateway.sonnet",
    providerModel: "anthropic/claude-sonnet",
    displayName: "Gateway Sonnet",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    features: ["tool_call", "streaming"],
    discoveredAt: "2026-08-26T11:00:00.000Z"
  })
};

const fallback: FakeModelRouteDeclaration = {
  route: ModelRouteSchema.parse({
    schemaVersion: 1,
    routeRef: "route.openrouter.sonnet",
    displayName: "OpenRouter Sonnet",
    transport: {
      kind: "openrouter",
      openRouterModel: "anthropic/claude-sonnet",
      credentialRefId
    },
    enabled: true
  }),
  catalogEntry: ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef: "route.openrouter.sonnet",
    providerModel: "anthropic/claude-sonnet",
    displayName: "OpenRouter Sonnet",
    inputModalities: ["text"],
    outputModalities: ["text"],
    features: ["tool_call"],
    discoveredAt: "2026-08-26T11:00:00.000Z"
  })
};

const context = (
  overrides: Partial<{
    readonly idempotencyKey: string;
    readonly requiredCapabilities: readonly string[];
  }> = {}
): ModelRouteContext =>
  ModelRouteContextSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "model:resolve:1",
    workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
    runId: "run_123e4567-e89b-42d3-a456-426614174000",
    stageRunId: "stage_123e4567-e89b-42d3-a456-426614174000",
    stage: "implement",
    requiredCapabilities: ["tool_call"],
    ...overrides
  });

const usageTemplate = {
  adapterId: "fake.agent-harness",
  requested: { provider: "anthropic", model: "anthropic/claude-sonnet" },
  actual: {
    provider: "anthropic",
    model: "anthropic/claude-sonnet",
    providerRequestId: "req-1"
  },
  tokens: {
    input: { state: "reported", value: 1_200 },
    output: { state: "reported", value: 340 },
    cachedInput: { state: "unknown" },
    reasoning: { state: "unknown" }
  },
  cost: { state: "reported", currency: "USD", micros: 4_200 },
  latencyMs: 812,
  outcome: "succeeded"
} as const;

const createRouterWith = (
  catalog: readonly FakeModelRouteDeclaration[],
  outcomes: readonly FakeModelRouterOutcome[]
) => createFakeModelRouter({ catalog, outcomes, now: createClock() });

const createRouter = (outcomes: readonly FakeModelRouterOutcome[]) =>
  createRouterWith([gateway, fallback], outcomes);

describe("fake model router scripted selection", () => {
  it("resolves scripted routes in request order and records every request", async () => {
    const router = createRouter([
      { kind: "selected", routeRef: gateway.route.routeRef, reason: "Primary route." },
      { kind: "selected", routeRef: fallback.route.routeRef, reason: "Secondary route." }
    ]);

    const first = await router.resolve(context());
    const second = await router.resolve(context({ idempotencyKey: "model:resolve:2" }));

    expect(ModelRouteSelectionSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      idempotencyKey: "model:resolve:1",
      routeRef: gateway.route.routeRef,
      reason: "Primary route."
    });
    expect(second).toMatchObject({
      idempotencyKey: "model:resolve:2",
      routeRef: fallback.route.routeRef
    });
    expect(Date.parse(second.selectedAt)).toBeGreaterThan(Date.parse(first.selectedAt));
    expect(router.requests.map((request) => request.idempotencyKey)).toEqual([
      "model:resolve:1",
      "model:resolve:2"
    ]);
  });

  it("records a contract-valid usage record attributed to the resolved request", async () => {
    const router = createRouter([
      {
        kind: "selected",
        routeRef: gateway.route.routeRef,
        reason: "Primary route.",
        usage: usageTemplate
      }
    ]);

    await router.resolve(context());

    expect(router.usageRecords).toHaveLength(1);
    const [record] = router.usageRecords;
    expect(record).toBeDefined();
    expect(ModelUsageRecordSchema.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      idempotencyKey: "model:resolve:1",
      stage: "implement",
      routeRef: gateway.route.routeRef,
      outcome: "succeeded",
      tokens: { cachedInput: { state: "unknown" } }
    });
  });

  it("throws a declared failure with its retry taxonomy and then serves the fallback", async () => {
    const router = createRouter([
      {
        kind: "failure",
        failure: {
          code: "rate_limited",
          message: "The gateway rejected the request.",
          retryable: true,
          routeRef: gateway.route.routeRef
        }
      },
      { kind: "selected", routeRef: fallback.route.routeRef, reason: "Gateway rate limited." }
    ]);

    const failure = await router.resolve(context()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure).toMatchObject({
      code: "rate_limited",
      retryable: true,
      failure: { routeRef: gateway.route.routeRef }
    });
    expect(await router.resolve(context({ idempotencyKey: "model:resolve:2" }))).toMatchObject({
      routeRef: fallback.route.routeRef
    });
    expect(router.requests).toHaveLength(2);
  });
});

describe("fake model router capability honesty", () => {
  it("fails a request for a capability no catalog route declares", async () => {
    const router = createRouter([
      { kind: "selected", routeRef: gateway.route.routeRef, reason: "Primary route." }
    ]);

    const failure = await router
      .resolve(context({ requiredCapabilities: ["audio"] }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure).toMatchObject({ code: "capability_unavailable", retryable: false });
  });

  it("reports a capable but disabled route as route_disabled, not capability_unavailable", async () => {
    const router = createRouterWith(
      [
        {
          route: ModelRouteSchema.parse({ ...gateway.route, enabled: false }),
          catalogEntry: gateway.catalogEntry
        }
      ],
      [{ kind: "selected", routeRef: gateway.route.routeRef, reason: "Primary route." }]
    );

    const failure = await router.resolve(context()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure).toMatchObject({ code: "route_disabled", retryable: false });
  });

  it("refuses a script that selects a route the required capabilities exclude", async () => {
    const router = createRouter([
      { kind: "selected", routeRef: fallback.route.routeRef, reason: "Ignores the requirement." }
    ]);

    await expect(router.resolve(context({ requiredCapabilities: ["image"] }))).rejects.toThrow(
      /capabilit/i
    );
  });

  it("exposes declared routes and catalog entries without inventing others", async () => {
    const router = createRouter([]);

    expect(await router.getRoute(gateway.route.routeRef)).toEqual(gateway.route);
    expect(await router.getRoute("route.unknown")).toBeUndefined();
    expect(router.catalog.map((entry) => entry.routeRef)).toEqual([
      gateway.route.routeRef,
      fallback.route.routeRef
    ]);
  });
});

describe("fake model router usage accounting", () => {
  const usage = ModelUsageSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "model:usage:1",
    routeRef: gateway.route.routeRef,
    providerRequestId: "req-1",
    provider: "anthropic",
    model: "anthropic/claude-sonnet",
    tokens: { input: 1_200, output: 340 },
    cost: { currency: "USD", micros: 4_200 },
    latencyMs: 812,
    recordedAt: "2026-08-26T12:00:01.000Z"
  });

  it("records reported usage and rejects usage the contract refuses", async () => {
    const router = createRouter([]);

    await router.recordUsage(usage);

    expect(router.recordedUsage).toEqual([usage]);
    await expect(router.recordUsage({ ...usage, latencyMs: -1 })).rejects.toThrow();
    expect(router.recordedUsage).toEqual([usage]);
  });

  it("hands out copies so a consumer cannot mutate recorded state", async () => {
    const router = createRouter([]);
    await router.recordUsage(usage);

    const view = router.recordedUsage;
    expect(view).toEqual([usage]);
    expect(router.recordedUsage).not.toBe(view);
  });
});
