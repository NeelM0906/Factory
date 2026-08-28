import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelInferenceRequestSchema,
  ModelRoutingError,
  RunIdSchema,
  StageRunIdSchema,
  WorkspaceIdSchema,
  type CredentialRefId,
  type ModelPolicy,
  type ModelRoute,
  type ModelRouteContext,
  type ModelRouteFallback,
  type ModelTokenUsage,
  type ModelUsageRecord
} from "@autostack/contracts";

import type { DeclaredCapabilityMap } from "../src/model-router.js";
import { createModelRouter } from "../src/model-router.js";
import { runWithFallback, type ModelRouteTarget } from "../src/fallback/fallback-runner.js";
import { normalizeUsage, type ProviderReportedUsage } from "../src/usage/normalize-usage.js";
import { createFakeCredentialResolver } from "./support/fake-credential-resolver.js";
import { createFixtureFetch, type FixtureFetchResponseSpec } from "./support/fixture-fetch.js";

import gatewayModelsFixture from "./fixtures/gateway-models.json" with { type: "json" };
import openRouterModelsFixture from "./fixtures/openrouter-models.json" with { type: "json" };
import openAiModelsFixture from "./fixtures/openai-models.json" with { type: "json" };
import anthropicModelsFixture from "./fixtures/anthropic-models.json" with { type: "json" };
import xaiModelsFixture from "./fixtures/xai-models.json" with { type: "json" };

/**
 * Task 12b: the charter's headline exit criterion. One `describe.each` over the five transport
 * configurations, each running the SAME assertions — catalog discovery, DEC-0 pinned-model capability
 * (own capability selects, sibling-only capability excludes), fallback-with-route-event, a policy cost
 * ceiling, per-attempt usage normalization (DEC-4), and catalog staleness (finding 7) — through
 * `createModelRouter`, never against the individual unit modules.
 *
 * Every configuration is driven by exactly two routes, "primary" and "secondary", reused across every
 * assertion in that configuration's block:
 *   - `primaryOwnCapability` is a capability the fixture declares on the PRIMARY route's own pinned
 *     entry — used to prove a station requiring it resolves to primary (item 2).
 *   - `siblingOnlyCapability` is a capability the fixture declares only on the SECONDARY model, which
 *     nonetheless appears as a sibling entry inside the PRIMARY route's own discovered snapshot (both
 *     routes' discovery calls return the whole provider catalog). Requiring it must exclude primary —
 *     the DEC-0 union tripwire — and, when secondary is also in policy, must select secondary and
 *     never primary (item 3).
 */

const CREDENTIAL_REF_ID: CredentialRefId = CredentialRefIdSchema.parse(
  "cred_aaaaaaaa-e89b-42d3-a456-426614174000"
);
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_aaaaaaaa-e89b-42d3-a456-426614174000");
const RUN_ID = RunIdSchema.parse("run_aaaaaaaa-e89b-42d3-a456-426614174000");
const STAGE_RUN_ID = StageRunIdSchema.parse("stage_aaaaaaaa-e89b-42d3-a456-426614174000");

const fixedNow = (): string => "2026-08-27T00:00:00.000Z";
const fixedMonotonicNowMs = (): number => 1_000;

interface UsageAmounts {
  readonly input: number;
  readonly output: number;
}

const openAiChatBody = (model: string, finishReason: string, usage?: UsageAmounts) => ({
  id: "chatcmpl-fixture",
  object: "chat.completion",
  created: 1,
  model,
  choices: [
    { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: finishReason }
  ],
  ...(usage === undefined
    ? {}
    : {
        usage: {
          prompt_tokens: usage.input,
          completion_tokens: usage.output,
          total_tokens: usage.input + usage.output
        }
      })
});

const gatewayChatBody = (finishReason: string, usage?: UsageAmounts) => ({
  content: [{ type: "text", text: "hi there" }],
  finishReason,
  ...(usage === undefined
    ? {}
    : {
        usage: {
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.input + usage.output
        }
      })
});

const anthropicChatBody = (model: string, usage?: UsageAmounts) => ({
  id: "msg-fixture",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text: "hi there" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  ...(usage === undefined
    ? {}
    : { usage: { input_tokens: usage.input, output_tokens: usage.output } })
});

interface TransportTestConfig {
  readonly name: string;
  readonly buildRoute: (routeRef: string, providerModel: string) => ModelRoute;
  readonly discoveryUrl: string;
  readonly discoveryFixtureBody: unknown;
  readonly runUrl: string;
  readonly runSuccessBody: (providerModel: string, usage?: UsageAmounts) => unknown;
  readonly primaryModel: string;
  readonly secondaryModel: string;
  /** A capability the fixture declares on the primary route's own pinned entry. */
  readonly primaryOwnCapability: string;
  /** A capability declared only by the secondary model, present as a sibling entry inside the
   * primary route's own discovered snapshot but absent from the primary's own pinned entry. */
  readonly siblingOnlyCapability: string;
  /** Matches `routeProviderName` in `transport-client.ts` for this transport/provider. */
  readonly providerNameForActual: string;
  readonly declaredCapabilities?: DeclaredCapabilityMap;
}

const gatewayRouteBuilder =
  () =>
  (routeRef: string, providerModel: string): ModelRoute => ({
    schemaVersion: 1,
    routeRef,
    displayName: "Gateway Integration Fixture",
    transport: {
      kind: "vercel_ai_gateway",
      gatewayModel: providerModel,
      credentialRefId: CREDENTIAL_REF_ID
    },
    enabled: true
  });

const openRouterRouteBuilder =
  () =>
  (routeRef: string, providerModel: string): ModelRoute => ({
    schemaVersion: 1,
    routeRef,
    displayName: "OpenRouter Integration Fixture",
    transport: {
      kind: "openrouter",
      openRouterModel: providerModel,
      credentialRefId: CREDENTIAL_REF_ID
    },
    enabled: true
  });

const directRouteBuilder =
  (protocol: "openai_compatible" | "anthropic", provider: string, endpoint: string) =>
  (routeRef: string, providerModel: string): ModelRoute => ({
    schemaVersion: 1,
    routeRef,
    displayName: `Direct ${provider} Integration Fixture`,
    transport: {
      kind: "direct",
      protocol,
      provider,
      endpoint,
      providerModel,
      credentialRefId: CREDENTIAL_REF_ID
    },
    enabled: true
  });

const OPENAI_ENDPOINT = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1";
const XAI_ENDPOINT = "https://api.x.ai/v1";

/**
 * `transport.endpoint` is the versioned API root (e.g. `https://api.anthropic.com/v1`): catalog
 * discovery (`src/catalog/direct-catalog.ts`) appends only the resource path, and invocation
 * (`src/transport/language-model-factory.ts`) passes it straight through as the AI SDK's `baseURL`.
 * One endpoint value serves both call sites for every direct provider.
 */
const ANTHROPIC_DISCOVERY_URL = `${ANTHROPIC_ENDPOINT}/models`;
const XAI_DISCOVERY_URL = `${XAI_ENDPOINT}/language-models`;

const TRANSPORT_CONFIGS: readonly TransportTestConfig[] = [
  {
    name: "vercel_ai_gateway",
    buildRoute: gatewayRouteBuilder(),
    discoveryUrl: "https://ai-gateway.vercel.sh/v1/models",
    discoveryFixtureBody: gatewayModelsFixture,
    runUrl: "https://ai-gateway.vercel.sh/v1/ai/language-model",
    runSuccessBody: (_model, usage) => gatewayChatBody("stop", usage),
    primaryModel: "anthropic/claude-3-5-sonnet",
    secondaryModel: "anthropic/claude-3-5-sonnet-reasoning",
    primaryOwnCapability: "tool_call",
    siblingOnlyCapability: "reasoning",
    providerNameForActual: "vercel_ai_gateway"
  },
  {
    name: "openrouter",
    buildRoute: openRouterRouteBuilder(),
    discoveryUrl: "https://openrouter.ai/api/v1/models",
    discoveryFixtureBody: openRouterModelsFixture,
    runUrl: "https://openrouter.ai/api/v1/chat/completions",
    runSuccessBody: (model, usage) => openAiChatBody(model, "stop", usage),
    primaryModel: "openai/gpt-4o-mini",
    secondaryModel: "anthropic/claude-3-5-sonnet",
    primaryOwnCapability: "text",
    siblingOnlyCapability: "tool_call",
    providerNameForActual: "openrouter"
  },
  {
    name: "direct-openai",
    buildRoute: directRouteBuilder("openai_compatible", "openai", OPENAI_ENDPOINT),
    discoveryUrl: `${OPENAI_ENDPOINT}/models`,
    discoveryFixtureBody: openAiModelsFixture,
    runUrl: `${OPENAI_ENDPOINT}/chat/completions`,
    runSuccessBody: (model, usage) => openAiChatBody(model, "stop", usage),
    primaryModel: "gpt-4o-mini",
    secondaryModel: "gpt-4o",
    primaryOwnCapability: "text",
    siblingOnlyCapability: "tool_call",
    providerNameForActual: "openai",
    declaredCapabilities: {
      "gpt-4o": { inputModalities: ["text"], outputModalities: ["text"], features: ["tool_call"] }
    }
  },
  {
    name: "direct-anthropic",
    buildRoute: directRouteBuilder("anthropic", "anthropic", ANTHROPIC_ENDPOINT),
    discoveryUrl: ANTHROPIC_DISCOVERY_URL,
    discoveryFixtureBody: anthropicModelsFixture,
    runUrl: `${ANTHROPIC_ENDPOINT}/messages`,
    runSuccessBody: (model, usage) => anthropicChatBody(model, usage),
    primaryModel: "claude-3-haiku-20240307",
    secondaryModel: "claude-3-5-sonnet-20241022",
    primaryOwnCapability: "text",
    siblingOnlyCapability: "tool_call",
    providerNameForActual: "anthropic",
    declaredCapabilities: {
      "claude-3-5-sonnet-20241022": {
        inputModalities: ["text"],
        outputModalities: ["text"],
        features: ["tool_call"]
      }
    }
  },
  {
    name: "direct-xai",
    buildRoute: directRouteBuilder("openai_compatible", "xai", XAI_ENDPOINT),
    discoveryUrl: XAI_DISCOVERY_URL,
    discoveryFixtureBody: xaiModelsFixture,
    runUrl: `${XAI_ENDPOINT}/chat/completions`,
    runSuccessBody: (model, usage) => openAiChatBody(model, "stop", usage),
    primaryModel: "grok-2-mini",
    secondaryModel: "grok-2-latest",
    primaryOwnCapability: "text",
    siblingOnlyCapability: "image",
    providerNameForActual: "xai"
  }
];

const buildContext = (
  overrides: Partial<ModelRouteContext> & { stage: ModelRouteContext["stage"] }
): ModelRouteContext => ({
  schemaVersion: 1,
  idempotencyKey: overrides.idempotencyKey ?? "idem-1",
  workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
  runId: overrides.runId ?? RUN_ID,
  stageRunId: overrides.stageRunId ?? STAGE_RUN_ID,
  stage: overrides.stage,
  requiredCapabilities: overrides.requiredCapabilities ?? []
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

interface BuildRouterOptions {
  readonly routes: readonly ModelRoute[];
  readonly policies: readonly ModelPolicy[];
  readonly discoveryResponses?: readonly FixtureFetchResponseSpec[];
  readonly runResponses?: readonly FixtureFetchResponseSpec[];
  readonly now?: () => string;
  readonly catalogTtlMs?: number;
  readonly maxStaleMs?: number;
}

const noopExactUsageSink = { record: async (): Promise<void> => undefined };

/** Builds a fresh composed router for one test, wired to fixture-scripted discovery (and, when
 * `runResponses` is supplied, invocation) endpoints for this transport configuration alone. */
const buildRouter = (config: TransportTestConfig, options: BuildRouterOptions) => {
  const fixtureRoutes = [
    {
      method: "GET",
      url: config.discoveryUrl,
      responses: options.discoveryResponses ?? [
        { kind: "response" as const, body: config.discoveryFixtureBody }
      ]
    },
    ...(options.runResponses === undefined
      ? []
      : [{ method: "POST", url: config.runUrl, responses: options.runResponses }])
  ];
  const fixture = createFixtureFetch(fixtureRoutes);

  const router = createModelRouter({
    routes: options.routes,
    policies: options.policies,
    credentials: createFakeCredentialResolver(),
    exactUsage: noopExactUsageSink,
    fetch: fixture.fetch,
    now: options.now ?? fixedNow,
    monotonicNowMs: fixedMonotonicNowMs,
    ...(options.catalogTtlMs === undefined ? {} : { catalogTtlMs: options.catalogTtlMs }),
    ...(options.maxStaleMs === undefined ? {} : { maxStaleMs: options.maxStaleMs }),
    ...(config.declaredCapabilities === undefined
      ? {}
      : { declaredCapabilities: config.declaredCapabilities })
  });

  return { router, fixture };
};

const buildInferenceRequest = (
  target: ModelRouteTarget,
  idempotencyKey: string,
  now: () => string
) =>
  ModelInferenceRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey,
    selection: {
      schemaVersion: 1,
      idempotencyKey,
      routeRef: target.routeRef,
      reason: "Route selected for a fixture attempt.",
      selectedAt: now()
    },
    messages: [{ role: "user", content: "Say hi in one word." }],
    options: { maxOutputTokens: 32 }
  });

/** Round-trips a normalized `ModelInferenceResult.tokens` back into the raw, provider-reported shape
 * `normalizeUsage` expects — an `unknown` state omits the key, exactly as a provider that never
 * reported that count would (never coerced to zero). */
const toProviderUsage = (tokens: ModelTokenUsage): ProviderReportedUsage => ({
  ...(tokens.input.state === "reported" ? { inputTokens: tokens.input.value } : {}),
  ...(tokens.output.state === "reported" ? { outputTokens: tokens.output.value } : {}),
  ...(tokens.cachedInput.state === "reported"
    ? { cachedInputTokens: tokens.cachedInput.value }
    : {}),
  ...(tokens.reasoning.state === "reported" ? { reasoningTokens: tokens.reasoning.value } : {})
});

describe("transport integration matrix (Task 12b)", () => {
  describe.each(TRANSPORT_CONFIGS)("$name", (config) => {
    const primaryRoute = config.buildRoute("route.primary", config.primaryModel);
    const secondaryRoute = config.buildRoute("route.secondary", config.secondaryModel);

    it("discovers the catalog and resolves the pinned route for a capability its own entry declares", async () => {
      // Discovery succeeding at all — rather than rejecting with a raw ZodError — is itself proof
      // every parsed entry passed `ModelCatalogEntrySchema`: every catalog parser builds each entry
      // via `ModelCatalogEntrySchema.parse` inline, so a non-conformant entry would abort discovery
      // rather than being silently included. The capability-based selection below is the concrete,
      // through-the-router proof that the parsed entry's own declared capability — not a guess or a
      // union — is what drove the outcome.
      const policy = buildPolicy({
        stage: "triage",
        allowedRouteRefs: [primaryRoute.routeRef, secondaryRoute.routeRef]
      });
      const { router } = buildRouter(config, {
        routes: [primaryRoute, secondaryRoute],
        policies: [policy]
      });

      const selection = await router.resolve(
        buildContext({ stage: "triage", requiredCapabilities: [config.primaryOwnCapability] })
      );

      expect(selection.routeRef).toBe(primaryRoute.routeRef);
      expect(selection.reason).toContain("fresh");
      expect(selection.reason).toContain(fixedNow());
    });

    it("excludes a route whose own pin lacks a capability only a sibling catalog entry declares (DEC-0 union tripwire)", async () => {
      // 3a: with only the primary route in policy, the sibling-only capability has nothing else that
      // could satisfy it — a union-across-entries bug would pass this because the sibling entry (from
      // the SAME discovery call, tagged with the SAME routeRef) does declare it.
      const solePolicy = buildPolicy({
        stage: "triage",
        allowedRouteRefs: [primaryRoute.routeRef]
      });
      const { router: soleRouter } = buildRouter(config, {
        routes: [primaryRoute, secondaryRoute],
        policies: [solePolicy]
      });
      const soleFailure = await soleRouter
        .resolve(
          buildContext({ stage: "triage", requiredCapabilities: [config.siblingOnlyCapability] })
        )
        .catch((error: unknown) => error);

      expect(soleFailure).toBeInstanceOf(ModelRoutingError);
      expect((soleFailure as ModelRoutingError).code).toBe("capability_unavailable");
      expect((soleFailure as ModelRoutingError).retryable).toBe(false);

      // 3b: with both routes in policy, the genuinely-capable secondary route must be the one
      // selected, and primary must be absent from the selection entirely — the assertion-discipline
      // rule that a filtered-out identifier is asserted absent, not merely counted away.
      const bothPolicy = buildPolicy({
        stage: "triage",
        allowedRouteRefs: [primaryRoute.routeRef, secondaryRoute.routeRef]
      });
      const { router: bothRouter } = buildRouter(config, {
        routes: [primaryRoute, secondaryRoute],
        policies: [bothPolicy]
      });
      const selection = await bothRouter.resolve(
        buildContext({ stage: "triage", requiredCapabilities: [config.siblingOnlyCapability] })
      );

      expect(selection.routeRef).toBe(secondaryRoute.routeRef);
      expect(selection.routeRef).not.toBe(primaryRoute.routeRef);
    });

    it("raises budget_exceeded, non-retryable, when the cost ceiling is below every candidate", async () => {
      const policy = buildPolicy({
        stage: "triage",
        allowedRouteRefs: [primaryRoute.routeRef, secondaryRoute.routeRef],
        maxCostMicros: 1
      });
      const { router } = buildRouter(config, {
        routes: [primaryRoute, secondaryRoute],
        policies: [policy]
      });

      const failure = await router
        .resolve(buildContext({ stage: "triage" }))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelRoutingError);
      expect((failure as ModelRoutingError).code).toBe("budget_exceeded");
      expect((failure as ModelRoutingError).retryable).toBe(false);
    });

    it("falls back from a rate_limited primary to the secondary route, recording one taxonomy-coded route event and two per-attempt usage records (DEC-4)", async () => {
      const policy = buildPolicy({
        stage: "triage",
        allowedRouteRefs: [primaryRoute.routeRef, secondaryRoute.routeRef],
        fallbackRouteRefs: [secondaryRoute.routeRef]
      });
      const { router } = buildRouter(config, {
        routes: [primaryRoute, secondaryRoute],
        policies: [policy],
        runResponses: [
          { kind: "response", status: 429, body: { error: { message: "slow down" } } },
          {
            kind: "response",
            body: config.runSuccessBody(config.secondaryModel, { input: 7, output: 4 })
          }
        ]
      });

      const context = buildContext({ stage: "triage", idempotencyKey: "idem-fallback" });

      // Proves the preferred route is genuinely primary, through the composed pipeline, before any
      // invocation is attempted.
      const selection = await router.resolve(context);
      expect(selection.routeRef).toBe(primaryRoute.routeRef);

      const order: readonly [ModelRouteTarget, ModelRouteTarget] = [
        { routeRef: primaryRoute.routeRef, model: config.primaryModel },
        { routeRef: secondaryRoute.routeRef, model: config.secondaryModel }
      ];

      const routeEvents: ModelRouteFallback[] = [];
      const usageRecords: ModelUsageRecord[] = [];

      const attempt = async (target: ModelRouteTarget, ordinal: number) => {
        try {
          const result = await router.run(
            buildInferenceRequest(target, context.idempotencyKey, fixedNow)
          );
          usageRecords.push(
            normalizeUsage({
              context,
              routeRef: target.routeRef,
              adapterId: "transport-integration-test",
              attempt: ordinal,
              requested: { provider: config.providerNameForActual, model: order[0].model },
              actual: {
                provider: result.actual.provider,
                model: result.actual.model,
                ...(result.actual.providerRequestId === undefined
                  ? {}
                  : { providerRequestId: result.actual.providerRequestId })
              },
              providerUsage: toProviderUsage(result.tokens),
              latencyMs: result.latencyMs,
              outcome: "succeeded",
              now: fixedNow
            })
          );
          return result;
        } catch (error) {
          if (error instanceof ModelRoutingError) {
            usageRecords.push(
              normalizeUsage({
                context,
                routeRef: target.routeRef,
                adapterId: "transport-integration-test",
                attempt: ordinal,
                requested: { provider: config.providerNameForActual, model: order[0].model },
                actual: { provider: config.providerNameForActual, model: target.model },
                providerUsage: {},
                latencyMs: 0,
                outcome: "failed",
                now: fixedNow
              })
            );
          }
          throw error;
        }
      };

      const result = await runWithFallback({
        order,
        context,
        attempt,
        sink: {
          record: async (event: ModelRouteFallback) => {
            routeEvents.push(event);
          }
        },
        now: fixedNow
      });

      expect(result.routeRef).toBe(secondaryRoute.routeRef);

      // Item 4: exactly one taxonomy-coded fallback event, naming both targets.
      expect(routeEvents).toHaveLength(1);
      expect(routeEvents[0]?.failureCode).toBe("rate_limited");
      expect(routeEvents[0]?.from).toEqual(order[0]);
      expect(routeEvents[0]?.to).toEqual(order[1]);

      // Item 6: two per-attempt usage records, ordinals 0 and 1, failed then succeeded, the second's
      // `actual` naming the fallback route, and unreported counts unknown rather than dropped or
      // coerced to zero.
      expect(usageRecords).toHaveLength(2);

      expect(usageRecords[0]?.attempt).toBe(0);
      expect(usageRecords[0]?.outcome).toBe("failed");
      expect(usageRecords[0]?.routeRef).toBe(primaryRoute.routeRef);
      expect(usageRecords[0]?.tokens.input).toEqual({ state: "unknown" });
      expect(usageRecords[0]?.tokens.output).toEqual({ state: "unknown" });
      expect(usageRecords[0]?.cost).toEqual({ state: "unknown" });

      expect(usageRecords[1]?.attempt).toBe(1);
      expect(usageRecords[1]?.outcome).toBe("succeeded");
      expect(usageRecords[1]?.routeRef).toBe(secondaryRoute.routeRef);
      expect(usageRecords[1]?.actual.model).toBe(config.secondaryModel);
      expect(usageRecords[1]?.actual.model).not.toBe(config.primaryModel);
      expect(usageRecords[1]?.tokens.input).toEqual({ state: "reported", value: 7 });
      expect(usageRecords[1]?.tokens.output).toEqual({ state: "reported", value: 4 });
      // cachedInput/reasoning are intentionally not asserted here: whether an AI SDK provider
      // normalizes an unmentioned nested usage field to `undefined` (unknown, per `tokenCount`) or to
      // `0` (reported) varies by provider and is that provider's own usage-parsing behavior, not a
      // decision this package makes — DEC-4's "unreported counts unknown" is already proven, provider
      // by provider, in `test/language-model-factory.test.ts`'s "preserves unreported token counts and
      // cost as unknown, never zero".
    });

    it("names catalog freshness and discoveredAt in the selection, serves stale within maxStaleMs, and fails closed past it", async () => {
      let currentTimeMs = 0;
      const clock = (): string => new Date(currentTimeMs).toISOString();

      const policy = buildPolicy({ stage: "triage", allowedRouteRefs: [primaryRoute.routeRef] });
      const { router } = buildRouter(config, {
        routes: [primaryRoute, secondaryRoute],
        policies: [policy],
        now: clock,
        catalogTtlMs: 1_000,
        maxStaleMs: 5_000,
        discoveryResponses: [
          { kind: "response", body: config.discoveryFixtureBody },
          { kind: "response", status: 503 }
        ]
      });

      const discoveredAt = clock();
      const freshSelection = await router.resolve(buildContext({ stage: "triage" }));
      expect(freshSelection.reason).toContain("fresh");
      expect(freshSelection.reason).toContain(discoveredAt);

      // Past ttlMs(1000) but within maxStaleMs(5000) of the original discovery: rediscovery is
      // attempted, fails (503, no cached snapshot survives), and the cached snapshot is served stale
      // rather than the resolve failing — a provider outage degrades, it does not block.
      currentTimeMs = 1_500;
      const staleSelection = await router.resolve(buildContext({ stage: "triage" }));
      expect(staleSelection.reason).toContain("stale");
      expect(staleSelection.reason).toContain(discoveredAt);

      // Past maxStaleMs(5000): the cached snapshot is too old to serve even as stale, and rediscovery
      // still fails, so resolve fails closed with provider_error, retryable.
      currentTimeMs = 6_000;
      const staleFailure = await router
        .resolve(buildContext({ stage: "triage" }))
        .catch((error: unknown) => error);
      expect(staleFailure).toBeInstanceOf(ModelRoutingError);
      expect((staleFailure as ModelRoutingError).code).toBe("provider_error");
      expect((staleFailure as ModelRoutingError).retryable).toBe(true);
    });
  });
});
