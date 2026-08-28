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

/**
 * Deliverable 2 (Task 12c): drives a full resolve -> fallback -> invoke -> usage sequence through
 * `createModelRouter`, once per shape in `KNOWN_CREDENTIAL_SPECS`, then sweeps every value the
 * router actually emitted for the fixture secret and for any credential-shaped substring. Table
 * driven off the exported constant itself (never a hand-picked sample), so a shape added upstream
 * gets a sweep row automatically.
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
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_aaaaaaaa-e89b-42d3-a456-426614174000");
const RUN_ID = RunIdSchema.parse("run_aaaaaaaa-e89b-42d3-a456-426614174000");
const STAGE_RUN_ID = StageRunIdSchema.parse("stage_aaaaaaaa-e89b-42d3-a456-426614174000");
const fixedNow = (): string => "2026-08-27T00:00:00.000Z";
const IDEMPOTENCY_KEY = "idem-credential-sweep";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const GATEWAY_INVOKE_URL = "https://ai-gateway.vercel.sh/v1/ai/language-model";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENAI_INVOKE_URL = "https://api.openai.com/v1/chat/completions";

// routeA (preferred) is direct/openai; routeB (fallback) is vercel_ai_gateway. Deliberately avoids
// direct/anthropic and direct/openai_compatible+xai routes for the invocation leg — see the task
// report: their discovery parsers (`discoverAnthropicCatalog`, `discoverXaiCatalog`) hardcode an
// extra "/v1" path segment onto `transport.endpoint` while the language-model factory's AI SDK
// `baseURL` is used verbatim, so no single `endpoint` value is simultaneously correct for both
// catalog discovery and invocation on those two provider configurations. Not this task's to fix.
const routeA: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.sweep.openai",
  displayName: "Sweep OpenAI Fixture",
  transport: {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
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
    gatewayModel: "openai/gpt-4o-mini",
    credentialRefId: CRED_REF_B
  },
  enabled: true
};

const buildPolicy = (): ModelPolicy => ({
  schemaVersion: 1,
  policyRef: "policy.sweep.triage",
  stage: "triage",
  allowedRouteRefs: [routeA.routeRef, routeB.routeRef],
  fallbackRouteRefs: [routeB.routeRef],
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
 * `router.resolve` picks the preferred route (stage 1-6), the preferred attempt fails with a
 * retryable `rate_limited` (HTTP 429), `runWithFallback` advances to the fallback route and records
 * one `ModelRouteFallback`, and `normalizeUsage` produces one `ModelUsageRecord` per attempt (DEC-4)
 * — a failed one for the first attempt, a succeeded one for the second. Every credential resolution
 * along the way goes through a resolver that always returns the one fixture secret shaped like
 * `spec`, so every value the router emits can be swept for it afterward.
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
    // The preferred route (routeA) is rate-limited on every invocation attempt -- retryable, so
    // runWithFallback advances to routeB.
    { method: "POST", url: OPENAI_INVOKE_URL, responses: [{ kind: "response", status: 429 }] },
    {
      method: "POST",
      url: GATEWAY_INVOKE_URL,
      responses: [
        {
          kind: "response",
          body: {
            content: [{ type: "text", text: "hi there" }],
            finishReason: "stop",
            usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
          }
        }
      ]
    }
  ]).fetch;

  const deps: ModelRouterDependencies = {
    routes: [routeA, routeB],
    policies: [buildPolicy()],
    credentials,
    routeEvents,
    usage,
    exactUsage,
    fetch: fetchDouble,
    now: fixedNow
  };
  const router = createModelRouter(deps);

  const context = buildContext();
  const selection = await router.resolve(context);

  const order: readonly ModelRouteTarget[] = [
    { routeRef: routeA.routeRef, model: pinnedModel(routeA) },
    { routeRef: routeB.routeRef, model: pinnedModel(routeB) }
  ];

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
        const attemptedRoute = target.routeRef === routeA.routeRef ? routeA : routeB;
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
  expect(result.routeRef).toBe(routeB.routeRef);

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
    expect(credentials.countFor(CRED_REF_A)).toBe(2);
    expect(credentials.countFor(CRED_REF_B)).toBe(2);

    expect(routeEvents.calls).toHaveLength(1);
    expect(routeEvents.calls[0]?.failureCode).toBe("rate_limited");
    expect(usage.calls).toHaveLength(2);
    expect(usage.calls[0]?.outcome).toBe("failed");
    expect(usage.calls[0]?.attempt).toBe(0);
    expect(usage.calls[1]?.outcome).toBe("succeeded");
    expect(usage.calls[1]?.attempt).toBe(1);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]).toBeInstanceOf(ModelRoutingError);

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
