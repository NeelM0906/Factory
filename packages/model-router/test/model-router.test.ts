import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelInferenceRequestSchema,
  ModelRoutingError,
  ModelUsageSchema,
  RunIdSchema,
  StageRunIdSchema,
  WorkspaceIdSchema,
  type ModelInferencePort,
  type ModelPolicy,
  type ModelRoute,
  type ModelRouteContext,
  type ModelRouteFallback,
  type ModelRouterPort,
  type ModelUsage,
  type ModelUsageRecord
} from "@autostack/contracts";

import { createModelRouter, type ModelRouterDependencies } from "../src/model-router.js";
import { createFakeCredentialResolver } from "./support/fake-credential-resolver.js";
import { createFixtureFetch, type FixtureFetchRoute } from "./support/fixture-fetch.js";
import gatewayModelsFixture from "./fixtures/gateway-models.json" with { type: "json" };
import openAiModelsFixture from "./fixtures/openai-models.json" with { type: "json" };

const credentialRefId = CredentialRefIdSchema.parse("cred_aaaaaaaa-e89b-42d3-a456-426614174000");
const fixedNow = (): string => "2026-08-27T00:00:00.000Z";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

const noopRouteEventSink = {
  record: async (_event: ModelRouteFallback): Promise<void> => undefined
};
const noopUsageSink = { record: async (_usage: ModelUsageRecord): Promise<void> => undefined };

const gatewayRoute = (
  overrides: Partial<{ routeRef: string; gatewayModel: string }> = {}
): ModelRoute => ({
  schemaVersion: 1,
  routeRef: overrides.routeRef ?? "route.gateway.low-cost",
  displayName: "Gateway Fixture Route",
  transport: {
    kind: "vercel_ai_gateway",
    gatewayModel: overrides.gatewayModel ?? "openai/gpt-4o-mini",
    credentialRefId
  },
  enabled: true
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
  idempotencyKey: overrides.idempotencyKey ?? "idem-1",
  workspaceId:
    overrides.workspaceId ?? WorkspaceIdSchema.parse("ws_aaaaaaaa-e89b-42d3-a456-426614174000"),
  runId: overrides.runId ?? RunIdSchema.parse("run_aaaaaaaa-e89b-42d3-a456-426614174000"),
  stageRunId:
    overrides.stageRunId ?? StageRunIdSchema.parse("stage_aaaaaaaa-e89b-42d3-a456-426614174000"),
  stage: overrides.stage,
  requiredCapabilities: overrides.requiredCapabilities ?? []
});

/**
 * Spec §10.2's default personal policy shape, supplied here as explicit test data — never a
 * router-internal default (Deliverable 3): a low-cost route for `triage`, and a higher-quality
 * route for `plan` and `isolated_review`. Deliberately no policy for `implement`/`verify`, which is
 * what exercises the "missing policy" TypeError.
 */
const lowCostRoute = gatewayRoute({
  routeRef: "route.low-cost",
  gatewayModel: "openai/gpt-4o-mini"
});
const highQualityRoute = gatewayRoute({
  routeRef: "route.high-quality",
  gatewayModel: "anthropic/claude-3-5-sonnet"
});

const buildDependencies = (
  overrides: Partial<ModelRouterDependencies> = {}
): ModelRouterDependencies => ({
  routes: overrides.routes ?? [lowCostRoute, highQualityRoute],
  policies:
    overrides.policies ??
    ([
      buildPolicy({ stage: "triage", allowedRouteRefs: [lowCostRoute.routeRef] }),
      buildPolicy({ stage: "plan", allowedRouteRefs: [highQualityRoute.routeRef] }),
      buildPolicy({ stage: "isolated_review", allowedRouteRefs: [highQualityRoute.routeRef] })
    ] as const),
  credentials: overrides.credentials ?? createFakeCredentialResolver(),
  routeEvents: overrides.routeEvents ?? noopRouteEventSink,
  usage: overrides.usage ?? noopUsageSink,
  exactUsage: overrides.exactUsage ?? {
    record: async (_usage: ModelUsage): Promise<void> => undefined
  },
  fetch:
    overrides.fetch ??
    createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [{ kind: "response", body: gatewayModelsFixture }]
      }
    ]).fetch,
  now: overrides.now ?? fixedNow,
  ...(overrides.catalogTtlMs === undefined ? {} : { catalogTtlMs: overrides.catalogTtlMs }),
  ...(overrides.maxStaleMs === undefined ? {} : { maxStaleMs: overrides.maxStaleMs }),
  ...(overrides.declaredCapabilities === undefined
    ? {}
    : { declaredCapabilities: overrides.declaredCapabilities })
});

describe("createModelRouter — structural conformance", () => {
  it("satisfies ModelRouterPort and ModelInferencePort structurally", () => {
    const router = createModelRouter(buildDependencies());
    const port: ModelRouterPort = router;
    const inferencePort: ModelInferencePort = router;
    expect(port).toBe(router);
    expect(inferencePort).toBe(router);
  });
});

describe("createModelRouter — resolve", () => {
  it("selects the low-cost route for triage through the fully composed pipeline", async () => {
    const router = createModelRouter(buildDependencies());
    const selection = await router.resolve(buildContext({ stage: "triage" }));
    expect(selection.routeRef).toBe(lowCostRoute.routeRef);
  });

  it("selects the high-quality route for plan when a capability only it declares is required", async () => {
    const router = createModelRouter(buildDependencies());
    const selection = await router.resolve(
      buildContext({ stage: "plan", requiredCapabilities: ["tool_call"] })
    );
    expect(selection.routeRef).toBe(highQualityRoute.routeRef);
  });

  it("raises a ModelRoutingError through the composed resolve when no route in policy satisfies the requirement", async () => {
    const router = createModelRouter(buildDependencies());
    await expect(
      router.resolve(buildContext({ stage: "triage", requiredCapabilities: ["tool_call"] }))
    ).rejects.toThrow(ModelRoutingError);
  });

  it("skips a policy-allowed routeRef that has no matching registered route, rather than crashing", async () => {
    const router = createModelRouter(
      buildDependencies({
        routes: [lowCostRoute],
        policies: [
          buildPolicy({
            stage: "triage",
            allowedRouteRefs: [lowCostRoute.routeRef, "route.not-registered"]
          })
        ]
      })
    );

    const selection = await router.resolve(buildContext({ stage: "triage" }));
    expect(selection.routeRef).toBe(lowCostRoute.routeRef);
  });

  it("threads catalogTtlMs and maxStaleMs through to the catalog cache (wiring, not the cache's own logic)", async () => {
    let currentTimeMs = 0;
    const clock = (): string => new Date(currentTimeMs).toISOString();

    const router = createModelRouter(
      buildDependencies({
        routes: [lowCostRoute],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [lowCostRoute.routeRef] })],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: GATEWAY_MODELS_URL,
            responses: [
              { kind: "response", body: gatewayModelsFixture },
              { kind: "response", status: 500 }
            ]
          }
        ]).fetch,
        now: clock,
        catalogTtlMs: 1_000,
        maxStaleMs: 2_000
      })
    );

    await router.resolve(buildContext({ stage: "triage" }));

    // Past both the custom ttlMs (forces rediscovery) and the custom maxStaleMs (forbids serving
    // the cached snapshot stale) — the default ttlMs (15 min) / maxStaleMs (24h) would not trigger
    // this at 3 seconds, so a passing assertion here proves the constructor options were threaded
    // through rather than the cache's own defaults being used.
    currentTimeMs = 3_000;
    await expect(router.resolve(buildContext({ stage: "triage" }))).rejects.toThrow(
      ModelRoutingError
    );
  });

  it("throws a TypeError, not a ModelRoutingError, at resolve for a stage with no configured policy (Deliverable 3)", async () => {
    const router = createModelRouter(buildDependencies());

    let caught: unknown;
    try {
      await router.resolve(buildContext({ stage: "implement" }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(ModelRoutingError);
  });

  it("throws a TypeError, not a ModelRoutingError, at construction for a duplicate stage policy (Deliverable 3)", () => {
    let caught: unknown;
    try {
      createModelRouter(
        buildDependencies({
          policies: [
            buildPolicy({ stage: "triage", allowedRouteRefs: [lowCostRoute.routeRef] }),
            buildPolicy({
              stage: "triage",
              policyRef: "policy.triage.duplicate",
              allowedRouteRefs: [lowCostRoute.routeRef]
            })
          ]
        })
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(ModelRoutingError);
  });

  it("threads declaredCapabilities through composition, overriding the DEC-1 floor for an otherwise text-only OpenAI model", async () => {
    const openAiRoute: ModelRoute = {
      schemaVersion: 1,
      routeRef: "route.direct.openai",
      displayName: "Direct OpenAI Fixture",
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
    const router = createModelRouter(
      buildDependencies({
        routes: [openAiRoute],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [openAiRoute.routeRef] })],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: OPENAI_MODELS_URL,
            responses: [{ kind: "response", body: openAiModelsFixture }]
          }
        ]).fetch,
        declaredCapabilities: {
          "gpt-4o": {
            inputModalities: ["text"],
            outputModalities: ["text"],
            features: ["tool_call"]
          }
        }
      })
    );

    const selection = await router.resolve(
      buildContext({ stage: "triage", requiredCapabilities: ["tool_call"] })
    );

    expect(selection.routeRef).toBe(openAiRoute.routeRef);
  });

  it("without a declaredCapabilities override, the same OpenAI route floors to no features and fails capability_unavailable", async () => {
    const openAiRoute: ModelRoute = {
      schemaVersion: 1,
      routeRef: "route.direct.openai",
      displayName: "Direct OpenAI Fixture",
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
    const router = createModelRouter(
      buildDependencies({
        routes: [openAiRoute],
        policies: [buildPolicy({ stage: "triage", allowedRouteRefs: [openAiRoute.routeRef] })],
        fetch: createFixtureFetch([
          {
            method: "GET",
            url: OPENAI_MODELS_URL,
            responses: [{ kind: "response", body: openAiModelsFixture }]
          }
        ]).fetch
      })
    );

    await expect(
      router.resolve(buildContext({ stage: "triage", requiredCapabilities: ["tool_call"] }))
    ).rejects.toThrow(ModelRoutingError);
  });
});

describe("createModelRouter — getRoute", () => {
  it("returns the registered route for a known ref and undefined for an unknown one, through the composed object", async () => {
    const router = createModelRouter(buildDependencies());
    await expect(router.getRoute(lowCostRoute.routeRef)).resolves.toEqual(lowCostRoute);
    await expect(router.getRoute("route.unknown")).resolves.toBeUndefined();
  });
});

describe("createModelRouter — recordUsage", () => {
  const validUsage: ModelUsage = ModelUsageSchema.parse({
    schemaVersion: 1,
    idempotencyKey: "idem-1",
    routeRef: lowCostRoute.routeRef,
    providerRequestId: "req-1",
    provider: "vercel_ai_gateway",
    model: "openai/gpt-4o-mini",
    tokens: { input: 10, output: 20 },
    cost: { currency: "USD", micros: 500 },
    latencyMs: 250,
    recordedAt: fixedNow()
  });

  it("forwards a valid payload to the injected ExactUsageSink exactly once, through the composed object", async () => {
    const sinkCalls: ModelUsage[] = [];
    const router = createModelRouter(
      buildDependencies({
        exactUsage: {
          record: async (usage) => {
            sinkCalls.push(usage);
          }
        }
      })
    );

    await router.recordUsage(validUsage);

    expect(sinkCalls).toEqual([validUsage]);
  });

  it("rejects a payload failing ModelUsageSchema before the sink is touched, through the composed object", async () => {
    const sinkCalls: ModelUsage[] = [];
    const router = createModelRouter(
      buildDependencies({
        exactUsage: {
          record: async (usage) => {
            sinkCalls.push(usage);
          }
        }
      })
    );
    const invalidUsage = { ...validUsage, tokens: { ...validUsage.tokens, input: -1 } };

    await expect(router.recordUsage(invalidUsage)).rejects.toThrow();
    expect(sinkCalls).toEqual([]);
  });
});

describe("createModelRouter — run (ModelInferencePort)", () => {
  const directRoute: ModelRoute = {
    schemaVersion: 1,
    routeRef: "route.direct.openai.run",
    displayName: "Direct OpenAI Fixture (run)",
    transport: {
      kind: "direct",
      protocol: "openai_compatible",
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      providerModel: "gpt-4o-mini-fixture",
      credentialRefId
    },
    enabled: true
  };

  const openAiChatBody = (finishReason: string) => ({
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o-mini-fixture",
    choices: [
      { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: finishReason }
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
  });

  const buildRequest = (idempotencyKey: string) =>
    ModelInferenceRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey,
      selection: {
        schemaVersion: 1,
        idempotencyKey,
        routeRef: directRoute.routeRef,
        reason: "Route selected for a fixture test.",
        selectedAt: fixedNow()
      },
      messages: [{ role: "user", content: "Say hi in one word." }],
      options: { maxOutputTokens: 32 }
    });

  const buildRunRouter = (fixtureRoutes: readonly FixtureFetchRoute[]) =>
    createModelRouter(
      buildDependencies({
        routes: [directRoute],
        policies: [],
        fetch: createFixtureFetch(fixtureRoutes).fetch
      })
    );

  it("runs one generateText call through the composed object and returns an admitted result", async () => {
    const router = buildRunRouter([
      {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        responses: [{ kind: "response", body: openAiChatBody("stop") }]
      }
    ]);

    const result = await router.run(buildRequest("idem-run-1"));

    expect(result.routeRef).toBe(directRoute.routeRef);
    expect(result.content).toBe("hi there");
    expect(result.finishReason).toBe("stop");
    expect(result.actual.model).toBe("gpt-4o-mini-fixture");
    expect(result.tokens.input).toEqual({ state: "reported", value: 5 });
  });

  it("classifies a provider HTTP failure as a ModelRoutingError through the composed object", async () => {
    const router = buildRunRouter([
      {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        responses: [{ kind: "response", status: 500 }]
      }
    ]);

    await expect(router.run(buildRequest("idem-run-2"))).rejects.toBeInstanceOf(ModelRoutingError);
  });
});
