import util from "node:util";

import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  KNOWN_CREDENTIAL_SPECS,
  ModelInferenceRequestSchema,
  ModelRoutingError,
  RunIdSchema,
  StageRunIdSchema,
  WorkspaceIdSchema,
  containsSensitiveMaterial,
  type CredentialRefId,
  type KnownCredentialBodyClass,
  type KnownCredentialSpec,
  type ModelInferenceRequest,
  type ModelInferenceResult,
  type ModelPolicy,
  type ModelRoute,
  type ModelRouteContext,
  type ModelRouteFallback,
  type ModelRouteSelection,
  type ModelUsageRecord
} from "@autostack/contracts";

import type { CredentialResolver } from "../src/catalog/catalog-types.js";
import { runWithFallback, type ModelRouteTarget } from "../src/fallback/fallback-runner.js";
import type { ModelRouteEventSink } from "../src/fallback/route-event-sink.js";
import {
  createModelRouter,
  type ModelRouterDependencies,
  type ModelRouter
} from "../src/model-router.js";
import { pinnedModel } from "../src/route-registry.js";
import { normalizeUsage, type ProviderReportedUsage } from "../src/usage/normalize-usage.js";
import type { ModelUsageSink } from "../src/usage/usage-sink.js";
import { createFixtureFetch } from "./support/fixture-fetch.js";
import gatewayModelsFixture from "./fixtures/gateway-models.json" with { type: "json" };
import openAiModelsFixture from "./fixtures/openai-models.json" with { type: "json" };
import openRouterModelsFixture from "./fixtures/openrouter-models.json" with { type: "json" };
import anthropicModelsFixture from "./fixtures/anthropic-models.json" with { type: "json" };
import xaiModelsFixture from "./fixtures/xai-models.json" with { type: "json" };

/**
 * Deliverable 2 (Task 12c): drives a full resolve -> fallback -> invoke -> usage sequence through
 * `createModelRouter`, once per shape in `KNOWN_CREDENTIAL_SPECS`, then sweeps every value the
 * router actually emitted for the fixture secret and for any credential-shaped substring. Table
 * driven off the exported constant itself (never a hand-picked sample), so a shape added upstream
 * gets a sweep row automatically.
 *
 * I3: the fallback chain now runs all FIVE transport configurations (direct/openai,
 * vercel_ai_gateway, openrouter, direct/anthropic, direct/openai_compatible+xai) rather than just
 * two, so the `x-api-key` header path (anthropic) and the `xai-` credential shape are actually
 * exercised through the real header-building code path for their transport, not merely generated
 * as an abstract secret value against an unrelated provider. This was previously narrowed to
 * openai+gateway; DEC-8 fixed the `/v1`-endpoint defect that motivated the narrowing, so the
 * exclusion no longer applies.
 */

// ---------------------------------------------------------------------------------------------
// Fixture secret generation, one per KNOWN_CREDENTIAL_SPECS entry.
// ---------------------------------------------------------------------------------------------

const BODY_SAMPLES: Readonly<Record<KnownCredentialBodyClass, string>> = {
  ascii_alphanumeric: "AbCdEfGh12345678",
  alphanumeric_dash: "AbCd-Ef12-Gh34-56",
  alphanumeric_underscore: "AbCd_Ef12-Gh34_56",
  bearer: "AbCd.Ef12~Gh34+56=",
  upper_alphanumeric: "ABCD1234EFGH5678",
  jwt: "AbCd.Ef12-Gh34_56"
};

const bodyForSpec = (spec: KnownCredentialSpec): string => {
  const sample = BODY_SAMPLES[spec.bodyClass];
  let body = sample;
  while (body.length < spec.minimumBodyLength) {
    body += sample;
  }
  return body.slice(0, spec.minimumBodyLength);
};

const credentialValueForSpec = (spec: KnownCredentialSpec): string => {
  const separator = spec.separator === "required_whitespace" ? " " : "";
  return `${spec.prefix}${separator}${bodyForSpec(spec)}`;
};

// ---------------------------------------------------------------------------------------------
// A credential resolver that returns one fixed (spec-shaped) secret for every ref, and records
// every call so the test can assert exactly two call sites per credential ref (finding 3).
// ---------------------------------------------------------------------------------------------

interface TrackedCredentialResolver extends CredentialResolver {
  readonly calls: readonly CredentialRefId[];
  countFor(id: CredentialRefId): number;
}

const createTrackedCredentialResolver = (secret: string): TrackedCredentialResolver => {
  const calls: CredentialRefId[] = [];
  return {
    calls,
    resolve: async (credentialRefId: CredentialRefId): Promise<string> => {
      calls.push(credentialRefId);
      return secret;
    },
    countFor: (id: CredentialRefId): number => calls.filter((call) => call === id).length
  };
};

// ---------------------------------------------------------------------------------------------
// Fixed identity/fixture scaffolding, shared across every spec iteration.
// ---------------------------------------------------------------------------------------------

const CRED_REF_A = CredentialRefIdSchema.parse("cred_aaaaaaaa-e89b-42d3-a456-426614174000");
const CRED_REF_B = CredentialRefIdSchema.parse("cred_bbbbbbbb-e89b-42d3-a456-426614174000");
const CRED_REF_C = CredentialRefIdSchema.parse("cred_cccccccc-e89b-42d3-a456-426614174000");
const CRED_REF_D = CredentialRefIdSchema.parse("cred_dddddddd-e89b-42d3-a456-426614174000");
const CRED_REF_E = CredentialRefIdSchema.parse("cred_eeeeeeee-e89b-42d3-a456-426614174000");
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_aaaaaaaa-e89b-42d3-a456-426614174000");
const RUN_ID = RunIdSchema.parse("run_aaaaaaaa-e89b-42d3-a456-426614174000");
const STAGE_RUN_ID = StageRunIdSchema.parse("stage_aaaaaaaa-e89b-42d3-a456-426614174000");
const fixedNow = (): string => "2026-08-27T00:00:00.000Z";
const IDEMPOTENCY_KEY = "idem-credential-sweep";

const OPENAI_ENDPOINT = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1";
const XAI_ENDPOINT = "https://api.x.ai/v1";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const GATEWAY_INVOKE_URL = "https://ai-gateway.vercel.sh/v1/ai/language-model";
const OPENAI_MODELS_URL = `${OPENAI_ENDPOINT}/models`;
const OPENAI_INVOKE_URL = `${OPENAI_ENDPOINT}/chat/completions`;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_INVOKE_URL = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_MODELS_URL = `${ANTHROPIC_ENDPOINT}/models`;
const ANTHROPIC_INVOKE_URL = `${ANTHROPIC_ENDPOINT}/messages`;
const XAI_MODELS_URL = `${XAI_ENDPOINT}/language-models`;
const XAI_INVOKE_URL = `${XAI_ENDPOINT}/chat/completions`;

// Five routes, one per transport configuration, forming the fallback chain in this fixed order:
// direct/openai (preferred) -> vercel_ai_gateway -> openrouter -> direct/anthropic ->
// direct/openai_compatible+xai. The first four are scripted to rate-limit on invocation so the
// chain advances through every transport before the fifth (xai) succeeds -- driving discovery AND
// invocation, and therefore both credential call sites, for all five.
const routeA: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.sweep.openai",
  displayName: "Sweep OpenAI Fixture",
  transport: {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "openai",
    endpoint: OPENAI_ENDPOINT,
    providerModel: "gpt-4o-mini",
    credentialRefId: CRED_REF_A
  },
  enabled: true
};

const routeB: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.sweep.gateway",
  displayName: "Sweep Gateway Fixture",
  transport: {
    kind: "vercel_ai_gateway",
    gatewayModel: "anthropic/claude-3-5-sonnet",
    credentialRefId: CRED_REF_B
  },
  enabled: true
};

const routeC: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.sweep.openrouter",
  displayName: "Sweep OpenRouter Fixture",
  transport: {
    kind: "openrouter",
    openRouterModel: "openai/gpt-4o-mini",
    credentialRefId: CRED_REF_C
  },
  enabled: true
};

const routeD: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.sweep.anthropic",
  displayName: "Sweep Anthropic Fixture",
  transport: {
    kind: "direct",
    protocol: "anthropic",
    provider: "anthropic",
    endpoint: ANTHROPIC_ENDPOINT,
    providerModel: "claude-3-haiku-20240307",
    credentialRefId: CRED_REF_D
  },
  enabled: true
};

const routeE: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.sweep.xai",
  displayName: "Sweep xAI Fixture",
  transport: {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "xai",
    endpoint: XAI_ENDPOINT,
    providerModel: "grok-2-mini",
    credentialRefId: CRED_REF_E
  },
  enabled: true
};

const ALL_ROUTES: readonly ModelRoute[] = [routeA, routeB, routeC, routeD, routeE];
const ALL_CRED_REFS: readonly CredentialRefId[] = [
  CRED_REF_A,
  CRED_REF_B,
  CRED_REF_C,
  CRED_REF_D,
  CRED_REF_E
];

const buildPolicy = (): ModelPolicy => ({
  schemaVersion: 1,
  policyRef: "policy.sweep.triage",
  stage: "triage",
  allowedRouteRefs: ALL_ROUTES.map((route) => route.routeRef),
  fallbackRouteRefs: [routeB.routeRef, routeC.routeRef, routeD.routeRef, routeE.routeRef],
  maxInputTokens: undefined,
  maxOutputTokens: undefined,
  maxCostMicros: undefined,
  reasoningLevel: undefined
});

const buildContext = (): ModelRouteContext => ({
  schemaVersion: 1,
  idempotencyKey: IDEMPOTENCY_KEY,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  stageRunId: STAGE_RUN_ID,
  stage: "triage",
  requiredCapabilities: []
});

const buildInferenceRequest = (target: ModelRouteTarget): ModelInferenceRequest =>
  ModelInferenceRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: IDEMPOTENCY_KEY,
    selection: {
      schemaVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      routeRef: target.routeRef,
      reason: `Fixture selection for ${target.routeRef}.`,
      selectedAt: fixedNow()
    },
    messages: [{ role: "user", content: "Say hi in one word." }],
    options: { maxOutputTokens: 32 }
  });

const routeProviderName = (route: ModelRoute): string =>
  route.transport.kind === "direct" ? route.transport.provider : route.transport.kind;

/** Un-wraps a `ModelInferenceResult`'s already-normalized token states back into the raw,
 * provider-shaped input `normalizeUsage` expects, so the record reflects what was actually served. */
const rawProviderUsageFrom = (result: ModelInferenceResult): ProviderReportedUsage => ({
  inputTokens: result.tokens.input.state === "reported" ? result.tokens.input.value : undefined,
  outputTokens: result.tokens.output.state === "reported" ? result.tokens.output.value : undefined,
  cachedInputTokens:
    result.tokens.cachedInput.state === "reported" ? result.tokens.cachedInput.value : undefined,
  reasoningTokens:
    result.tokens.reasoning.state === "reported" ? result.tokens.reasoning.value : undefined
});

interface RouteEventSinkCapture extends ModelRouteEventSink {
  readonly calls: readonly ModelRouteFallback[];
}

interface UsageSinkCapture extends ModelUsageSink {
  readonly calls: readonly ModelUsageRecord[];
}

const createRouteEventCapture = (): RouteEventSinkCapture => {
  const calls: ModelRouteFallback[] = [];
  return { calls, record: async (event) => void calls.push(event) };
};

const createUsageCapture = (): UsageSinkCapture => {
  const calls: ModelUsageRecord[] = [];
  return { calls, record: async (record) => void calls.push(record) };
};

interface SweepRunResult {
  readonly router: ModelRouter;
  readonly credentials: TrackedCredentialResolver;
  readonly routeEvents: RouteEventSinkCapture;
  readonly usage: UsageSinkCapture;
  readonly selection: ModelRouteSelection;
  readonly capturedErrors: readonly ModelRoutingError[];
  readonly secret: string;
}

/**
 * Drives one full resolve -> fallback -> invoke -> usage sequence through the composed router:
 * `router.resolve` picks the preferred route (stage 1-6), the preferred route and the next three
 * fallbacks each fail invocation with a retryable `rate_limited` (HTTP 429), `runWithFallback`
 * advances through each in turn recording one `ModelRouteFallback` per activation, and the fifth
 * (xai) succeeds. `normalizeUsage` produces one `ModelUsageRecord` per attempt (DEC-4) -- a failed
 * one for each of the first four attempts, a succeeded one for the fifth. Every credential
 * resolution along the way goes through a resolver that always returns the one fixture secret
 * shaped like `spec`, so every value the router emits can be swept for it afterward.
 */
const runFullSequence = async (spec: KnownCredentialSpec): Promise<SweepRunResult> => {
  const secret = credentialValueForSpec(spec);
  const credentials = createTrackedCredentialResolver(secret);
  const routeEvents = createRouteEventCapture();
  const usage = createUsageCapture();
  const exactUsage = { record: async (): Promise<void> => undefined };

  const fetchDouble = createFixtureFetch([
    {
      method: "GET",
      url: OPENAI_MODELS_URL,
      responses: [{ kind: "response", body: openAiModelsFixture }]
    },
    {
      method: "GET",
      url: GATEWAY_MODELS_URL,
      responses: [{ kind: "response", body: gatewayModelsFixture }]
    },
    {
      method: "GET",
      url: OPENROUTER_MODELS_URL,
      responses: [{ kind: "response", body: openRouterModelsFixture }]
    },
    {
      method: "GET",
      url: ANTHROPIC_MODELS_URL,
      responses: [{ kind: "response", body: anthropicModelsFixture }]
    },
    {
      method: "GET",
      url: XAI_MODELS_URL,
      responses: [{ kind: "response", body: xaiModelsFixture }]
    },
    // routeA through routeD are rate-limited on every invocation attempt -- retryable, so
    // runWithFallback advances all the way to routeE (xai), which succeeds.
    { method: "POST", url: OPENAI_INVOKE_URL, responses: [{ kind: "response", status: 429 }] },
    { method: "POST", url: GATEWAY_INVOKE_URL, responses: [{ kind: "response", status: 429 }] },
    { method: "POST", url: OPENROUTER_INVOKE_URL, responses: [{ kind: "response", status: 429 }] },
    { method: "POST", url: ANTHROPIC_INVOKE_URL, responses: [{ kind: "response", status: 429 }] },
    {
      method: "POST",
      url: XAI_INVOKE_URL,
      responses: [
        {
          kind: "response",
          body: {
            id: "chatcmpl-fixture",
            object: "chat.completion",
            created: 1,
            model: "grok-2-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi there" },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
          }
        }
      ]
    }
  ]).fetch;

  const deps: ModelRouterDependencies = {
    routes: ALL_ROUTES,
    policies: [buildPolicy()],
    credentials,
    exactUsage,
    fetch: fetchDouble,
    now: fixedNow,
    monotonicNowMs: () => 0
  };
  const router = createModelRouter(deps);

  const context = buildContext();
  const selection = await router.resolve(context);

  const order: readonly ModelRouteTarget[] = ALL_ROUTES.map((route) => ({
    routeRef: route.routeRef,
    model: pinnedModel(route)
  }));

  const capturedErrors: ModelRoutingError[] = [];

  const attempt = async (
    target: ModelRouteTarget,
    ordinal: number
  ): Promise<ModelInferenceResult> => {
    const request = buildInferenceRequest(target);
    try {
      const result = await router.run(request);
      // `exactOptionalPropertyTypes` distinguishes an omitted `providerRequestId` from one
      // explicitly set to `undefined`; the zod-inferred `result.actual` allows the latter, but
      // `NormalizeUsageActual` does not, so the key is omitted rather than copied through as-is.
      const actual = {
        provider: result.actual.provider,
        model: result.actual.model,
        ...(result.actual.providerRequestId === undefined
          ? {}
          : { providerRequestId: result.actual.providerRequestId })
      };
      await usage.record(
        normalizeUsage({
          context,
          routeRef: target.routeRef,
          adapterId: "credential-sweep-test",
          attempt: ordinal,
          requested: { model: target.model },
          actual,
          providerUsage: rawProviderUsageFrom(result),
          latencyMs: result.latencyMs,
          outcome: "succeeded",
          now: fixedNow
        })
      );
      return result;
    } catch (error: unknown) {
      if (error instanceof ModelRoutingError) {
        capturedErrors.push(error);
        const attemptedRoute =
          ALL_ROUTES.find((route) => route.routeRef === target.routeRef) ?? routeA;
        await usage.record(
          normalizeUsage({
            context,
            routeRef: target.routeRef,
            adapterId: "credential-sweep-test",
            attempt: ordinal,
            requested: { model: target.model },
            actual: { provider: routeProviderName(attemptedRoute), model: target.model },
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
    sink: routeEvents,
    now: fixedNow
  });
  expect(result.routeRef).toBe(routeE.routeRef);

  return { router, credentials, routeEvents, usage, selection, capturedErrors, secret };
};

describe.each(KNOWN_CREDENTIAL_SPECS)("credential shape: $prefix", (spec) => {
  it("the generated fixture secret is genuinely detected as credential-shaped (generator sanity check)", () => {
    expect(containsSensitiveMaterial(credentialValueForSpec(spec))).toBe(true);
  });

  it("drives resolve -> fallback -> invoke -> usage through the composed router without leaking the fixture secret", async () => {
    const { router, credentials, routeEvents, usage, selection, capturedErrors, secret } =
      await runFullSequence(spec);

    expect(selection.routeRef).toBe(routeA.routeRef);

    // Exactly two credential call sites per route: catalog discovery (stage 2, during resolve) and
    // the language-model factory (during run) -- a third site added later fails this assertion.
    // Now asserted across all five transports (I3), not just openai+gateway.
    for (const credRef of ALL_CRED_REFS) {
      expect(credentials.countFor(credRef)).toBe(2);
    }

    expect(routeEvents.calls).toHaveLength(4);
    for (const event of routeEvents.calls) {
      expect(event.failureCode).toBe("rate_limited");
    }
    expect(usage.calls).toHaveLength(5);
    for (let index = 0; index < 4; index += 1) {
      expect(usage.calls[index]?.outcome).toBe("failed");
      expect(usage.calls[index]?.attempt).toBe(index);
    }
    expect(usage.calls[4]?.outcome).toBe("succeeded");
    expect(usage.calls[4]?.attempt).toBe(4);
    expect(capturedErrors).toHaveLength(4);
    for (const error of capturedErrors) {
      expect(error).toBeInstanceOf(ModelRoutingError);
    }

    // Sweep the router's REAL emissions -- not a curated sample -- for the fixture secret and for
    // any KNOWN_CREDENTIAL_SPECS-shaped substring. `containsSensitiveMaterial` checks both at once.
    const haystacks: Readonly<Record<string, string>> = {
      selection: JSON.stringify(selection),
      routeFallbackEvents: JSON.stringify(routeEvents.calls),
      usageRecords: JSON.stringify(usage.calls),
      routingErrorMessages: capturedErrors.map((error) => error.message).join("\n"),
      routingErrorStacks: capturedErrors.map((error) => error.stack ?? "").join("\n"),
      routerStringified: JSON.stringify(router),
      routerInspected: util.inspect(router, { depth: null })
    };

    for (const [name, text] of Object.entries(haystacks)) {
      expect(text.includes(secret), `${name} contained the literal fixture secret`).toBe(false);
      expect(
        containsSensitiveMaterial(text, [secret]),
        `${name} matched a KNOWN_CREDENTIAL_SPECS pattern or the fixture secret`
      ).toBe(false);
    }
  });
});
