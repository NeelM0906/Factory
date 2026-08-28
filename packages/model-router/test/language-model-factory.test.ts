import util from "node:util";

import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelInferenceRequestSchema,
  ModelRouteSchema,
  ModelRoutingError,
  type ModelInferenceRequest,
  type ModelRoute
} from "@autostack/contracts";

import { createRouteRegistry, type ExactUsageSink } from "../src/route-registry.js";
import { createLanguageModelFactory } from "../src/transport/language-model-factory.js";
import { createModelInference } from "../src/transport/transport-client.js";
import { createFixtureFetch, type FixtureFetchRoute } from "./support/fixture-fetch.js";
import { createFakeCredentialResolver } from "./support/fake-credential-resolver.js";

const credentialRefId = CredentialRefIdSchema.parse("cred_aaaaaaaa-e89b-42d3-a456-426614174000");
const fixedNow = (): string => "2026-08-27T00:00:00.000Z";

const noopExactUsageSink: ExactUsageSink = { record: async () => undefined };

const buildRoute = (raw: unknown): ModelRoute => ModelRouteSchema.parse(raw);

const gatewayRoute = buildRoute({
  schemaVersion: 1,
  routeRef: "route.gateway",
  displayName: "Gateway Fixture",
  transport: {
    kind: "vercel_ai_gateway",
    gatewayModel: "anthropic/claude-sonnet-fixture",
    credentialRefId
  },
  enabled: true
});

const openRouterRoute = buildRoute({
  schemaVersion: 1,
  routeRef: "route.openrouter",
  displayName: "OpenRouter Fixture",
  transport: {
    kind: "openrouter",
    openRouterModel: "anthropic/claude-sonnet-fixture",
    credentialRefId
  },
  enabled: true
});

const directOpenAiRoute = buildRoute({
  schemaVersion: 1,
  routeRef: "route.direct.openai",
  displayName: "Direct OpenAI Fixture",
  transport: {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    providerModel: "gpt-4o-mini-fixture",
    credentialRefId
  },
  enabled: true
});

const directAnthropicRoute = buildRoute({
  schemaVersion: 1,
  routeRef: "route.direct.anthropic",
  displayName: "Direct Anthropic Fixture",
  transport: {
    kind: "direct",
    protocol: "anthropic",
    provider: "anthropic",
    endpoint: "https://api.anthropic.com/v1",
    providerModel: "claude-3-5-sonnet-fixture",
    credentialRefId
  },
  enabled: true
});

const directXaiRoute = buildRoute({
  schemaVersion: 1,
  routeRef: "route.direct.xai",
  displayName: "Direct xAI Fixture",
  transport: {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "xai",
    endpoint: "https://api.x.ai/v1",
    providerModel: "grok-4-fixture",
    credentialRefId
  },
  enabled: true
});

interface TransportConfig {
  readonly name: string;
  readonly route: ModelRoute;
  readonly url: string;
  readonly authHeaderName: string;
  readonly expectedProvider: string;
  /** Body shaped for this transport's wire format, reporting a "stop" finish and token usage. */
  readonly successBody: unknown;
}

const openAiChatBody = (model: string, finishReason: string, includeUsage: boolean) => ({
  id: "chatcmpl-fixture",
  object: "chat.completion",
  created: 1,
  model,
  choices: [
    { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: finishReason }
  ],
  ...(includeUsage ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } : {})
});

const TRANSPORT_CONFIGS: readonly TransportConfig[] = [
  {
    name: "vercel_ai_gateway",
    route: gatewayRoute,
    url: "https://ai-gateway.vercel.sh/v1/ai/language-model",
    authHeaderName: "authorization",
    expectedProvider: "gateway",
    successBody: {
      content: [{ type: "text", text: "hi there" }],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
    }
  },
  {
    name: "openrouter",
    route: openRouterRoute,
    url: "https://openrouter.ai/api/v1/chat/completions",
    authHeaderName: "authorization",
    expectedProvider: "openrouter",
    successBody: openAiChatBody("anthropic/claude-sonnet-fixture", "stop", true)
  },
  {
    name: "direct-openai",
    route: directOpenAiRoute,
    url: "https://api.openai.com/v1/chat/completions",
    authHeaderName: "authorization",
    expectedProvider: "openai.chat",
    successBody: openAiChatBody("gpt-4o-mini-fixture", "stop", true)
  },
  {
    name: "direct-anthropic",
    route: directAnthropicRoute,
    url: "https://api.anthropic.com/v1/messages",
    authHeaderName: "x-api-key",
    expectedProvider: "anthropic.messages",
    successBody: {
      id: "msg-fixture",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet-fixture",
      content: [{ type: "text", text: "hi there" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 }
    }
  },
  {
    name: "direct-xai",
    route: directXaiRoute,
    url: "https://api.x.ai/v1/chat/completions",
    authHeaderName: "authorization",
    // xai is reached through the OpenAI-compatible client, so the AI SDK's own provider label
    // matches OpenAI's, not the route's "xai" transport.provider value (used instead for
    // `ModelInferenceResult.actual.provider` — see routeProviderName in transport-client.ts).
    expectedProvider: "openai.chat",
    successBody: openAiChatBody("grok-4-fixture", "stop", true)
  }
];

const buildRequest = (
  route: ModelRoute,
  idempotencyKey: string,
  messages: ModelInferenceRequest["messages"] = [{ role: "user", content: "Say hi in one word." }]
): ModelInferenceRequest =>
  ModelInferenceRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey,
    selection: {
      schemaVersion: 1,
      idempotencyKey,
      routeRef: route.routeRef,
      reason: "Route selected for a fixture test.",
      selectedAt: fixedNow()
    },
    messages,
    options: { maxOutputTokens: 32 }
  });

describe("createLanguageModelFactory", () => {
  describe.each(TRANSPORT_CONFIGS)("$name", (config) => {
    it("builds a language model pinned to the route's model and issues one authenticated request", async () => {
      const fixture = createFixtureFetch([
        {
          method: "POST",
          url: config.url,
          responses: [{ kind: "response", body: config.successBody }]
        }
      ]);
      const credentials = createFakeCredentialResolver();
      const factory = createLanguageModelFactory({ credentials, fetch: fixture.fetch });

      const model = await factory.build(config.route);
      expect(model.modelId).toBe(
        config.route.transport.kind === "direct"
          ? config.route.transport.providerModel
          : config.route.transport.kind === "vercel_ai_gateway"
            ? config.route.transport.gatewayModel
            : config.route.transport.openRouterModel
      );
      expect(model.provider).toBe(config.expectedProvider);

      // The factory itself never stashes a secret field.
      expect(JSON.stringify(factory)).not.toContain("sk-fixture-secret-for-");
      expect(util.inspect(model, { depth: null })).not.toContain("sk-fixture-secret-for-");

      const request = buildRequest(config.route, `idem-${config.name}`);
      const registry = createRouteRegistry({
        routes: [config.route],
        exactUsageSink: noopExactUsageSink
      });
      const inference = createModelInference({
        routes: registry,
        credentials,
        fetch: fixture.fetch,
        now: fixedNow
      });

      const result = await inference.run(request);

      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]?.url).toBe(config.url);
      expect(fixture.calls[0]?.method).toBe("POST");
      expect(fixture.calls[0]?.headerNames).toContain(config.authHeaderName);

      expect(result.idempotencyKey).toBe(request.idempotencyKey);
      expect(result.routeRef).toBe(config.route.routeRef);
      expect(result.content).toBe("hi there");
      expect(result.finishReason).toBe("stop");
      expect(result.completedAt).toBe(fixedNow());
      expect(Number.isInteger(result.latencyMs)).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      // Exactly two credential call sites exist in this package: catalog discovery and this
      // factory (finding 3). This test only drives the factory, so the fixture resolver should
      // show exactly one resolution — one per model construction — for this route's credential.
      // `factory.build` above plus `inference.run` below each construct their own model, so the
      // ref is resolved twice in this test, once per construction.
      expect(credentials.countFor(credentialRefId)).toBe(2);
    });
  });

  it("holds no secret field after construction, independent of any request", () => {
    const credentials = createFakeCredentialResolver();
    const fixture = createFixtureFetch([]);
    const factory = createLanguageModelFactory({ credentials, fetch: fixture.fetch });
    expect(JSON.stringify(factory)).toBe("{}");
    expect(util.inspect(factory, { depth: null })).not.toMatch(/sk-fixture-secret-for-/);
  });

  it("resolves the route's credential exactly once per model construction", async () => {
    const credentials = createFakeCredentialResolver();
    const fixture = createFixtureFetch([]);
    const factory = createLanguageModelFactory({ credentials, fetch: fixture.fetch });

    await factory.build(directOpenAiRoute);
    expect(credentials.countFor(credentialRefId)).toBe(1);

    await factory.build(directOpenAiRoute);
    expect(credentials.countFor(credentialRefId)).toBe(2);
  });

  it("raises a TypeError for a route whose direct protocol is not yet supported", async () => {
    const googleRoute = buildRoute({
      schemaVersion: 1,
      routeRef: "route.direct.google",
      displayName: "Direct Google Fixture",
      transport: {
        kind: "direct",
        protocol: "google",
        provider: "google",
        endpoint: "https://generativelanguage.googleapis.com/v1",
        providerModel: "gemini-fixture",
        credentialRefId
      },
      enabled: true
    });
    const credentials = createFakeCredentialResolver();
    const fixture = createFixtureFetch([]);
    const factory = createLanguageModelFactory({ credentials, fetch: fixture.fetch });

    await expect(factory.build(googleRoute)).rejects.toThrow(TypeError);
    // The unsupported protocol is rejected before any credential is spent on it.
    expect(credentials.countFor(credentialRefId)).toBe(0);
  });

  it("raises a TypeError at runtime for an unknown transport.kind (defensive, not reachable via valid input)", async () => {
    // `ModelRouteSchema` makes this state unconstructible through normal validation — the
    // discriminated union only admits the three known transport kinds. This is deliberately
    // testing the exhaustive switch's runtime fallback (Task 10's explicit requirement), which
    // guards against a future transport kind landing in the contract without a matching S3
    // dispatch arm. The cast below does not skip any schema validation of a real value; it
    // fabricates the one shape the schema itself makes otherwise unreachable.
    const invalidRoute = {
      schemaVersion: 1,
      routeRef: "route.invalid",
      displayName: "Invalid Fixture",
      transport: { kind: "unknown_future_transport", credentialRefId },
      enabled: true
    } as unknown as ModelRoute;

    const credentials = createFakeCredentialResolver();
    const fixture = createFixtureFetch([]);
    const factory = createLanguageModelFactory({ credentials, fetch: fixture.fetch });

    await expect(factory.build(invalidRoute)).rejects.toThrow(TypeError);
  });
});

describe("createModelInference", () => {
  it("raises a TypeError (not a ModelRoutingError) when the selected route is not configured", async () => {
    const request = buildRequest(directOpenAiRoute, "idem-unconfigured");
    const registry = createRouteRegistry({ routes: [], exactUsageSink: noopExactUsageSink });
    const credentials = createFakeCredentialResolver();
    const fixture = createFixtureFetch([]);
    const inference = createModelInference({
      routes: registry,
      credentials,
      fetch: fixture.fetch,
      now: fixedNow
    });

    await expect(inference.run(request)).rejects.toThrow(TypeError);
    await expect(inference.run(request)).rejects.not.toBeInstanceOf(ModelRoutingError);
  });

  it("preserves unreported token counts and cost as unknown, never zero", async () => {
    const fixture = createFixtureFetch([
      {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        responses: [
          { kind: "response", body: openAiChatBody("gpt-4o-mini-fixture", "stop", false) }
        ]
      }
    ]);
    const credentials = createFakeCredentialResolver();
    const registry = createRouteRegistry({
      routes: [directOpenAiRoute],
      exactUsageSink: noopExactUsageSink
    });
    const inference = createModelInference({
      routes: registry,
      credentials,
      fetch: fixture.fetch,
      now: fixedNow
    });

    const result = await inference.run(buildRequest(directOpenAiRoute, "idem-no-usage"));

    expect(result.tokens.input).toEqual({ state: "unknown" });
    expect(result.tokens.output).toEqual({ state: "unknown" });
    expect(result.tokens.cachedInput).toEqual({ state: "unknown" });
    expect(result.tokens.reasoning).toEqual({ state: "unknown" });
    expect(result.cost).toEqual({ state: "unknown" });
  });

  it("reports reasoning and cached-input token counts as reported when the provider sends them", async () => {
    const fixture = createFixtureFetch([
      {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        responses: [
          {
            kind: "response",
            body: {
              id: "chatcmpl-fixture",
              object: "chat.completion",
              created: 1,
              model: "gpt-4o-mini-fixture",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "hi there" },
                  finish_reason: "stop"
                }
              ],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 4,
                total_tokens: 16,
                completion_tokens_details: { reasoning_tokens: 2 },
                prompt_tokens_details: { cached_tokens: 6 }
              }
            }
          }
        ]
      }
    ]);
    const credentials = createFakeCredentialResolver();
    const registry = createRouteRegistry({
      routes: [directOpenAiRoute],
      exactUsageSink: noopExactUsageSink
    });
    const inference = createModelInference({
      routes: registry,
      credentials,
      fetch: fixture.fetch,
      now: fixedNow
    });

    const result = await inference.run(buildRequest(directOpenAiRoute, "idem-full-usage"));

    expect(result.tokens.input).toEqual({ state: "reported", value: 12 });
    expect(result.tokens.output).toEqual({ state: "reported", value: 4 });
    expect(result.tokens.cachedInput).toEqual({ state: "reported", value: 6 });
    expect(result.tokens.reasoning).toEqual({ state: "reported", value: 2 });
  });

  it("openrouter reports cachedInputTokens as 0 (not unknown) when the provider mentioned nothing about caching — a known SDK-level limitation, see the comment at the cachedInput normalization site in transport-client.ts", async () => {
    // `@openrouter/ai-sdk-provider` normalizes `cachedInputTokens` to 0 whenever the upstream
    // provider's response carries no `prompt_tokens_details.cached_tokens` at all — this fixture
    // omits that field entirely, exactly as a provider that never reports caching would. `tokenCount`
    // cannot tell that apart from a genuine "0 tokens were served from cache": both are a reported
    // non-negative integer. This test pins that current, imperfect behavior rather than hiding it —
    // do NOT change `normalizeUsage`/`tokenCount` to make this pass differently; the information is
    // lost upstream, in the SDK.
    const fixture = createFixtureFetch([
      {
        method: "POST",
        url: "https://openrouter.ai/api/v1/chat/completions",
        responses: [
          {
            kind: "response",
            body: openAiChatBody("anthropic/claude-sonnet-fixture", "stop", true)
          }
        ]
      }
    ]);
    const credentials = createFakeCredentialResolver();
    const registry = createRouteRegistry({
      routes: [openRouterRoute],
      exactUsageSink: noopExactUsageSink
    });
    const inference = createModelInference({
      routes: registry,
      credentials,
      fetch: fixture.fetch,
      now: fixedNow
    });

    const result = await inference.run(buildRequest(openRouterRoute, "idem-openrouter-cache-zero"));

    expect(result.tokens.input).toEqual({ state: "reported", value: 5 });
    expect(result.tokens.output).toEqual({ state: "reported", value: 3 });
    // The known limitation: reported as 0, not "unknown", even though the provider said nothing.
    expect(result.tokens.cachedInput).toEqual({ state: "reported", value: 0 });
  });

  describe("finish reason mapping (fails closed)", () => {
    const runWithFinishReason = async (finishReason: string) => {
      const fixture = createFixtureFetch([
        {
          method: "POST",
          url: "https://api.openai.com/v1/chat/completions",
          responses: [
            { kind: "response", body: openAiChatBody("gpt-4o-mini-fixture", finishReason, true) }
          ]
        }
      ]);
      const credentials = createFakeCredentialResolver();
      const registry = createRouteRegistry({
        routes: [directOpenAiRoute],
        exactUsageSink: noopExactUsageSink
      });
      const inference = createModelInference({
        routes: registry,
        credentials,
        fetch: fixture.fetch,
        now: fixedNow
      });
      return inference.run(buildRequest(directOpenAiRoute, `idem-finish-${finishReason}`));
    };

    it.each([
      ["stop", "stop"],
      ["length", "length"],
      ["content_filter", "content_filter"]
    ])("maps provider finish reason %s to %s", async (providerReason, expected) => {
      const result = await runWithFinishReason(providerReason);
      expect(result.finishReason).toBe(expected);
    });

    it("maps an unrecognized/unmapped finish reason to error, never to stop", async () => {
      // "tool_calls" is a real, valid finish reason the AI SDK normalizes to "tool-calls" — a
      // value this taxonomy has no member for. It must not be silently widened into "stop".
      const result = await runWithFinishReason("tool_calls");
      expect(result.finishReason).toBe("error");
      expect(result.finishReason).not.toBe("stop");
    });
  });

  describe("failure classification", () => {
    const buildFailingInference = (fixtureRoutes: readonly FixtureFetchRoute[]) => {
      const fixture = createFixtureFetch(fixtureRoutes);
      const credentials = createFakeCredentialResolver();
      const registry = createRouteRegistry({
        routes: [directOpenAiRoute],
        exactUsageSink: noopExactUsageSink
      });
      const inference = createModelInference({
        routes: registry,
        credentials,
        fetch: fixture.fetch,
        now: fixedNow
      });
      return { fixture, inference };
    };

    it("classifies a 429 as rate_limited and retryable", async () => {
      const { inference } = buildFailingInference([
        {
          method: "POST",
          url: "https://api.openai.com/v1/chat/completions",
          responses: [{ kind: "response", status: 429, body: { error: { message: "slow down" } } }]
        }
      ]);

      const failure = await inference
        .run(buildRequest(directOpenAiRoute, "idem-429"))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelRoutingError);
      expect((failure as ModelRoutingError).code).toBe("rate_limited");
      expect((failure as ModelRoutingError).retryable).toBe(true);
    });

    it("classifies a 401 as provider_error and non-retryable", async () => {
      const { inference } = buildFailingInference([
        {
          method: "POST",
          url: "https://api.openai.com/v1/chat/completions",
          responses: [{ kind: "response", status: 401, body: { error: { message: "bad key" } } }]
        }
      ]);

      const failure = await inference
        .run(buildRequest(directOpenAiRoute, "idem-401"))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelRoutingError);
      expect((failure as ModelRoutingError).code).toBe("provider_error");
      expect((failure as ModelRoutingError).retryable).toBe(false);
    });

    it("classifies a network throw as provider_error and retryable", async () => {
      const { inference } = buildFailingInference([
        {
          method: "POST",
          url: "https://api.openai.com/v1/chat/completions",
          responses: [{ kind: "throws", error: new TypeError("fetch failed: network down") }]
        }
      ]);

      const failure = await inference
        .run(buildRequest(directOpenAiRoute, "idem-network"))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelRoutingError);
      expect((failure as ModelRoutingError).code).toBe("provider_error");
      expect((failure as ModelRoutingError).retryable).toBe(true);
    });

    it("classifies a thrown non-Error value as provider_error and retryable", async () => {
      const { inference } = buildFailingInference([
        {
          method: "POST",
          url: "https://api.openai.com/v1/chat/completions",
          responses: [{ kind: "throws", error: "connection reset" }]
        }
      ]);

      const failure = await inference
        .run(buildRequest(directOpenAiRoute, "idem-primitive-throw"))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelRoutingError);
      expect((failure as ModelRoutingError).code).toBe("provider_error");
      expect((failure as ModelRoutingError).retryable).toBe(true);
    });

    it("classifies a malformed (non-JSON) 2xx body as provider_error and retryable", async () => {
      const { inference } = buildFailingInference([
        {
          method: "POST",
          url: "https://api.openai.com/v1/chat/completions",
          responses: [{ kind: "response", status: 200, rawBody: "not json {{{" }]
        }
      ]);

      const failure = await inference
        .run(buildRequest(directOpenAiRoute, "idem-malformed"))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelRoutingError);
      expect((failure as ModelRoutingError).code).toBe("provider_error");
      expect((failure as ModelRoutingError).retryable).toBe(true);
    });

    it("classifies a gateway-wrapped HTTP failure (not an APICallError) through the same taxonomy", async () => {
      const fixture = createFixtureFetch([
        {
          method: "POST",
          url: "https://ai-gateway.vercel.sh/v1/ai/language-model",
          responses: [{ kind: "response", status: 500, body: { error: { message: "boom" } } }]
        }
      ]);
      const credentials = createFakeCredentialResolver();
      const registry = createRouteRegistry({
        routes: [gatewayRoute],
        exactUsageSink: noopExactUsageSink
      });
      const inference = createModelInference({
        routes: registry,
        credentials,
        fetch: fixture.fetch,
        now: fixedNow
      });

      const failure = await inference
        .run(buildRequest(gatewayRoute, "idem-gateway-500"))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelRoutingError);
      expect((failure as ModelRoutingError).code).toBe("provider_error");
      expect((failure as ModelRoutingError).retryable).toBe(true);
    });
  });

  it("issues exactly one request per run — no retry, no streaming", async () => {
    let callCount = 0;
    const fixture = createFixtureFetch([
      {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        responses: [{ kind: "response", body: openAiChatBody("gpt-4o-mini-fixture", "stop", true) }]
      }
    ]);
    const countingFetch: typeof globalThis.fetch = async (input, init) => {
      callCount += 1;
      return fixture.fetch(input, init);
    };
    const credentials = createFakeCredentialResolver();
    const registry = createRouteRegistry({
      routes: [directOpenAiRoute],
      exactUsageSink: noopExactUsageSink
    });
    const inference = createModelInference({
      routes: registry,
      credentials,
      fetch: countingFetch,
      now: fixedNow
    });

    await inference.run(buildRequest(directOpenAiRoute, "idem-single-call"));
    expect(callCount).toBe(1);
  });

  it("converts every message role (system, user, assistant) into the AI SDK's own message shape", async () => {
    const fixture = createFixtureFetch([
      {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        responses: [{ kind: "response", body: openAiChatBody("gpt-4o-mini-fixture", "stop", true) }]
      }
    ]);
    const credentials = createFakeCredentialResolver();
    const registry = createRouteRegistry({
      routes: [directOpenAiRoute],
      exactUsageSink: noopExactUsageSink
    });
    const inference = createModelInference({
      routes: registry,
      credentials,
      fetch: fixture.fetch,
      now: fixedNow
    });

    const request = buildRequest(directOpenAiRoute, "idem-multi-role", [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: "Say hi in one word." },
      { role: "assistant", content: "Hi." },
      { role: "user", content: "Say it again." }
    ]);

    await expect(inference.run(request)).resolves.toMatchObject({ finishReason: "stop" });
    expect(fixture.calls).toHaveLength(1);
  });
});
