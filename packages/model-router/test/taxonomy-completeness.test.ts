import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  MODEL_ROUTING_FAILURE_CODES,
  ModelRoutingError,
  RunIdSchema,
  StageRunIdSchema,
  WorkspaceIdSchema,
  type ModelPolicy,
  type ModelRoute,
  type ModelRouteContext,
  type ModelRouterPort,
  type ModelRoutingFailureCode
} from "@autostack/contracts";

import { assertWithinInvocationBudget } from "../src/policy/budget.js";
import { createModelRouter, type ModelRouterDependencies } from "../src/model-router.js";
import { createFakeCredentialResolver } from "./support/fake-credential-resolver.js";
import { createFixtureFetch } from "./support/fixture-fetch.js";
import gatewayModelsFixture from "./fixtures/gateway-models.json" with { type: "json" };
import openAiModelsFixture from "./fixtures/openai-models.json" with { type: "json" };

/**
 * Deliverable 1 (Task 12c): a table driven off `MODEL_ROUTING_FAILURE_CODES` itself, proving every
 * declared taxonomy member is reachable THROUGH THE COMPOSED ROUTER with the correct `retryable`
 * value. Each scenario below is placed by the pipeline stage that owns it, per the plan's
 * "rejection pipeline (single source of truth)" — the single source these tests are derived from,
 * not restated.
 */

const credentialRefId = CredentialRefIdSchema.parse("cred_aaaaaaaa-e89b-42d3-a456-426614174000");
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_aaaaaaaa-e89b-42d3-a456-426614174000");
const RUN_ID = RunIdSchema.parse("run_aaaaaaaa-e89b-42d3-a456-426614174000");
const STAGE_RUN_ID = StageRunIdSchema.parse("stage_aaaaaaaa-e89b-42d3-a456-426614174000");
const fixedNow = (): string => "2026-08-27T00:00:00.000Z";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

const noopRouteEventSink = { record: async (): Promise<void> => undefined };
const noopUsageSink = { record: async (): Promise<void> => undefined };
const noopExactUsageSink = { record: async (): Promise<void> => undefined };

const openAiRoute = (
  overrides: Partial<{ routeRef: string; providerModel: string; enabled: boolean }> = {}
): ModelRoute => ({
  schemaVersion: 1,
  routeRef: overrides.routeRef ?? "route.openai",
  displayName: "OpenAI Fixture Route",
  transport: {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    providerModel: overrides.providerModel ?? "gpt-4o-mini",
    credentialRefId
  },
  enabled: overrides.enabled ?? true
});

const gatewayRoute = (
  overrides: Partial<{ routeRef: string; gatewayModel: string; enabled: boolean }> = {}
): ModelRoute => ({
  schemaVersion: 1,
  routeRef: overrides.routeRef ?? "route.gateway",
  displayName: "Gateway Fixture Route",
  transport: {
    kind: "vercel_ai_gateway",
    gatewayModel: overrides.gatewayModel ?? "openai/gpt-4o-mini",
    credentialRefId
  },
  enabled: overrides.enabled ?? true
});

const buildPolicy = (
  overrides: Partial<ModelPolicy> & {
    stage: ModelPolicy["stage"];
    allowedRouteRefs: readonly string[];
  }
): ModelPolicy => ({
  schemaVersion: 1,
  policyRef: overrides.policyRef ?? `policy.${overrides.stage}`,
  stage: overrides.stage,
  allowedRouteRefs: overrides.allowedRouteRefs,
  fallbackRouteRefs: overrides.fallbackRouteRefs ?? [],
  maxInputTokens: overrides.maxInputTokens,
  maxOutputTokens: overrides.maxOutputTokens,
  maxCostMicros: overrides.maxCostMicros,
  reasoningLevel: overrides.reasoningLevel
});

const buildContext = (
  overrides: Partial<ModelRouteContext> & { stage: ModelRouteContext["stage"] }
): ModelRouteContext => ({
  schemaVersion: 1,
  idempotencyKey: overrides.idempotencyKey ?? "idem-taxonomy",
  workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
  runId: overrides.runId ?? RUN_ID,
  stageRunId: overrides.stageRunId ?? STAGE_RUN_ID,
  stage: overrides.stage,
  requiredCapabilities: overrides.requiredCapabilities ?? []
});

interface BuildRouterOptions {
  readonly routes: readonly ModelRoute[];
  readonly policies: readonly ModelPolicy[];
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => string;
  readonly catalogTtlMs?: number;
  readonly maxStaleMs?: number;
}

const buildRouter = (options: BuildRouterOptions): ModelRouterPort => {
  const deps: ModelRouterDependencies = {
    routes: options.routes,
    policies: options.policies,
    credentials: createFakeCredentialResolver(),
    routeEvents: noopRouteEventSink,
    usage: noopUsageSink,
    exactUsage: noopExactUsageSink,
    fetch: options.fetch,
    now: options.now ?? fixedNow,
    ...(options.catalogTtlMs === undefined ? {} : { catalogTtlMs: options.catalogTtlMs }),
    ...(options.maxStaleMs === undefined ? {} : { maxStaleMs: options.maxStaleMs })
  };
  return createModelRouter(deps);
};

/** Awaits `router.resolve(context)`, expecting it to raise a `ModelRoutingError`, and returns it. */
const resolveExpectingFailure = async (
  router: ModelRouterPort,
  context: ModelRouteContext
): Promise<ModelRoutingError> => {
  try {
    await router.resolve(context);
  } catch (error: unknown) {
    if (error instanceof ModelRoutingError) {
      return error;
    }
    throw error;
  }
  throw new Error(
    `Expected router.resolve to raise a ModelRoutingError for stage "${context.stage}", but it resolved successfully.`
  );
};

interface TaxonomyScenario {
  /** Table row label: code, owning pipeline stage, and the scenario that reaches it. */
  readonly name: string;
  readonly expectedCode: ModelRoutingFailureCode;
  readonly expectedRetryable: boolean;
  /** Self-contained: builds its own router/fixtures and returns the raised failure. Safe to call
   * more than once (used both per-row and again by the completeness assertion). */
  readonly run: () => Promise<ModelRoutingError>;
}

const SCENARIOS: readonly TaxonomyScenario[] = [
  {
    name: "capability_unavailable | stage 4 | required capability absent from every allowed route's pinned entry",
    expectedCode: "capability_unavailable",
    expectedRetryable: false,
    run: async () => {
      const route = openAiRoute({ routeRef: "route.stage4.capability-absent" });
      const router = buildRouter({
        routes: [route],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [route.routeRef] })],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: OPENAI_MODELS_URL,
            responses: [{ kind: "response", body: openAiModelsFixture }]
          }
        ]).fetch
      });
      // The route's pinned entry floors to `features: []` (DEC-1, no declaredCapabilities
      // override), so requiring `tool_call` empties the candidate set at stage 4.
      return resolveExpectingFailure(
        router,
        buildContext({ stage: "triage", requiredCapabilities: ["tool_call"] })
      );
    }
  },
  {
    name: "capability_unavailable | stage 3 | pinned model absent from a successful discovery",
    expectedCode: "capability_unavailable",
    expectedRetryable: false,
    run: async () => {
      const route = openAiRoute({
        routeRef: "route.stage3.pin-absent",
        providerModel: "gpt-9-not-in-catalog"
      });
      const router = buildRouter({
        routes: [route],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [route.routeRef] })],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: OPENAI_MODELS_URL,
            responses: [{ kind: "response", body: openAiModelsFixture }]
          }
        ]).fetch
      });
      // Discovery itself succeeds (the fixture parses cleanly); the route's pin is simply not
      // among the discovered entries, excluding it at stage 3 with no required capabilities at all.
      return resolveExpectingFailure(
        router,
        buildContext({ stage: "triage", requiredCapabilities: [] })
      );
    }
  },
  {
    name: "route_disabled | stage 5 | the only capable route is enabled: false",
    expectedCode: "route_disabled",
    expectedRetryable: false,
    run: async () => {
      const route = openAiRoute({ routeRef: "route.stage5.disabled", enabled: false });
      const router = buildRouter({
        routes: [route],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [route.routeRef] })],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: OPENAI_MODELS_URL,
            responses: [{ kind: "response", body: openAiModelsFixture }]
          }
        ]).fetch
      });
      return resolveExpectingFailure(
        router,
        buildContext({ stage: "triage", requiredCapabilities: [] })
      );
    }
  },
  {
    name: "budget_exceeded | stage 6 | cost ceiling below every candidate",
    expectedCode: "budget_exceeded",
    expectedRetryable: false,
    run: async () => {
      // The gateway fixture's reasoning entry is the one with declared pricing.
      const route = gatewayRoute({
        routeRef: "route.stage6.over-budget",
        gatewayModel: "anthropic/claude-3-5-sonnet-reasoning"
      });
      const router = buildRouter({
        routes: [route],
        policies: [
          buildPolicy({ stage: "triage", allowedRouteRefs: [route.routeRef], maxCostMicros: 1 })
        ],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: GATEWAY_MODELS_URL,
            responses: [{ kind: "response", body: gatewayModelsFixture }]
          }
        ]).fetch
      });
      return resolveExpectingFailure(
        router,
        buildContext({ stage: "triage", requiredCapabilities: [] })
      );
    }
  },
  {
    name: "budget_exceeded | invocation | stated output demand above maxOutputTokens",
    expectedCode: "budget_exceeded",
    expectedRetryable: false,
    run: async () => {
      // DEC-3's invocation-time demand check (`assertWithinInvocationBudget`, Task 7) composes
      // above `ModelInferencePort.run` exactly as fallback composes above it (ESC-1): the request
      // shape `run` takes carries no stage/policy reference, so the check runs against the SAME
      // `ModelPolicy` the composed router was built with, using the route `resolve()` — itself run
      // through the composed pipeline — actually selected. Raised before any provider call.
      //
      // Uses the gateway route (its fixture entry declares `max_tokens: 16384`) rather than the
      // OpenAI route: the OpenAI route floors to no declared `maxOutputTokens` at all (DEC-1), which
      // would already fail the RESOLVE-time ceiling check at stage 6 for a policy that sets
      // `maxOutputTokens`, raising `budget_exceeded` for an unrelated reason before this scenario
      // ever reaches the invocation-time demand check it means to isolate.
      const route = gatewayRoute({
        routeRef: "route.invocation.over-budget",
        gatewayModel: "openai/gpt-4o-mini"
      });
      const policy = buildPolicy({
        stage: "triage",
        allowedRouteRefs: [route.routeRef],
        maxOutputTokens: 100
      });
      const router = buildRouter({
        routes: [route],
        policies: [policy],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: GATEWAY_MODELS_URL,
            responses: [{ kind: "response", body: gatewayModelsFixture }]
          }
        ]).fetch
      });

      const selection = await router.resolve(
        buildContext({ stage: "triage", requiredCapabilities: [] })
      );

      try {
        assertWithinInvocationBudget({
          policy,
          routeRef: selection.routeRef,
          demand: { inputTokens: 10, outputTokens: 5_000 }
        });
      } catch (error: unknown) {
        if (error instanceof ModelRoutingError) {
          return error;
        }
        throw error;
      }
      throw new Error("Expected assertWithinInvocationBudget to raise a ModelRoutingError.");
    }
  },
  {
    name: "rate_limited | stage 2 | catalog fetch returns 429, no cached snapshot",
    expectedCode: "rate_limited",
    expectedRetryable: true,
    run: async () => {
      const route = openAiRoute({ routeRef: "route.stage2.rate-limited" });
      const router = buildRouter({
        routes: [route],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [route.routeRef] })],
        fetch: createFixtureFetch([
          { method: "GET", url: OPENAI_MODELS_URL, responses: [{ kind: "response", status: 429 }] }
        ]).fetch
      });
      return resolveExpectingFailure(
        router,
        buildContext({ stage: "triage", requiredCapabilities: [] })
      );
    }
  },
  {
    name: "provider_error | stage 2 | catalog fetch returns 503 (no retry-after), no cached snapshot -> retryable TRUE",
    expectedCode: "provider_error",
    expectedRetryable: true,
    run: async () => {
      const route = openAiRoute({ routeRef: "route.stage2.provider-error-503" });
      const router = buildRouter({
        routes: [route],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [route.routeRef] })],
        fetch: createFixtureFetch([
          { method: "GET", url: OPENAI_MODELS_URL, responses: [{ kind: "response", status: 503 }] }
        ]).fetch
      });
      return resolveExpectingFailure(
        router,
        buildContext({ stage: "triage", requiredCapabilities: [] })
      );
    }
  },
  {
    name: "provider_error | stage 2 | catalog fetch returns 401, no cached snapshot -> retryable FALSE",
    expectedCode: "provider_error",
    expectedRetryable: false,
    run: async () => {
      const route = openAiRoute({ routeRef: "route.stage2.provider-error-401" });
      const router = buildRouter({
        routes: [route],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [route.routeRef] })],
        fetch: createFixtureFetch([
          { method: "GET", url: OPENAI_MODELS_URL, responses: [{ kind: "response", status: 401 }] }
        ]).fetch
      });
      return resolveExpectingFailure(
        router,
        buildContext({ stage: "triage", requiredCapabilities: [] })
      );
    }
  },
  {
    name: "provider_error | stage 2 | cached snapshot older than maxStaleMs",
    expectedCode: "provider_error",
    expectedRetryable: true,
    run: async () => {
      const route = openAiRoute({ routeRef: "route.stage2.stale-past-ceiling" });
      let currentTimeMs = 0;
      const clock = (): string => new Date(currentTimeMs).toISOString();
      const router = buildRouter({
        routes: [route],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [route.routeRef] })],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: OPENAI_MODELS_URL,
            responses: [
              { kind: "response", body: openAiModelsFixture },
              { kind: "response", status: 500 }
            ]
          }
        ]).fetch,
        now: clock,
        catalogTtlMs: 1_000,
        maxStaleMs: 2_000
      });

      // Warms the cache (fresh) at t=0.
      await router.resolve(buildContext({ stage: "triage", requiredCapabilities: [] }));

      // Past both ttlMs (forces rediscovery) and maxStaleMs (forbids serving the cached snapshot
      // stale): rediscovery fails, and the cached snapshot is now too old to serve.
      currentTimeMs = 3_000;
      return resolveExpectingFailure(
        router,
        buildContext({ stage: "triage", requiredCapabilities: [] })
      );
    }
  }
];

describe.each(SCENARIOS)("$name", (scenario) => {
  it("raises the expected code and retryable value through the composed router", async () => {
    const failure = await scenario.run();
    expect(failure.code).toBe(scenario.expectedCode);
    expect(failure.retryable).toBe(scenario.expectedRetryable);
  });
});

describe("taxonomy completeness", () => {
  it("both provider_error retryability states are exercised by the table above (finding 10, mandatory)", () => {
    const providerErrorRows = SCENARIOS.filter(
      (scenario) => scenario.expectedCode === "provider_error"
    );
    const retryableStates = new Set(
      providerErrorRows.map((scenario) => scenario.expectedRetryable)
    );
    expect(retryableStates).toEqual(new Set([true, false]));
  });

  it("the union of every scenario's observed code covers every member of MODEL_ROUTING_FAILURE_CODES", async () => {
    const observedCodes = new Set<ModelRoutingFailureCode>();
    for (const scenario of SCENARIOS) {
      const failure = await scenario.run();
      expect(failure.code).toBe(scenario.expectedCode);
      expect(failure.retryable).toBe(scenario.expectedRetryable);
      observedCodes.add(failure.code);
    }
    // Derived from the imported constant, never hand-maintained: a taxonomy member added upstream
    // with no S3 scenario above fails this assertion rather than silently narrowing the surface.
    expect(observedCodes).toEqual(new Set(MODEL_ROUTING_FAILURE_CODES));
  });
});
