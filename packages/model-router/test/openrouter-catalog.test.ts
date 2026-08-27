import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelCatalogEntrySchema,
  ModelRoutingError,
  type ModelRoute
} from "@autostack/contracts";

import {
  discoverOpenRouterCatalog,
  OPENROUTER_MODELS_URL
} from "../src/catalog/openrouter-catalog.js";
import { createFakeCredentialResolver } from "./support/fake-credential-resolver.js";
import { createFixtureFetch } from "./support/fixture-fetch.js";
import openRouterModelsFixture from "./fixtures/openrouter-models.json" with { type: "json" };

const credentialRefId = CredentialRefIdSchema.parse("cred_223e4567-e89b-42d3-a456-426614174000");

const openRouterRoute: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.openrouter.sonnet",
  displayName: "OpenRouter Sonnet",
  transport: {
    kind: "openrouter",
    openRouterModel: "anthropic/claude-3-5-sonnet",
    credentialRefId
  },
  enabled: true
};

const fixedNow = () => "2026-08-27T00:00:00.000Z";

describe("discoverOpenRouterCatalog", () => {
  it("resolves the route's credential exactly once, authenticated by header name only", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    await discoverOpenRouterCatalog({ route: openRouterRoute, credentials, fetch, now: fixedNow });

    expect(credentials.countFor(openRouterRoute.transport.credentialRefId)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(OPENROUTER_MODELS_URL);
    expect(calls[0]?.headerNames).toContain("authorization");
  });

  it("issues exactly one GET to the openrouter models URL", async () => {
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    await discoverOpenRouterCatalog({
      route: openRouterRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(calls).toHaveLength(1);
  });

  it("returns one ModelCatalogEntry per payload entry, routeRef and discoveredAt stamped", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    const result = await discoverOpenRouterCatalog({
      route: openRouterRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(result.entries).toHaveLength(3);
    for (const entry of result.entries) {
      expect(() => ModelCatalogEntrySchema.parse(entry)).not.toThrow();
      expect(entry.routeRef).toBe(openRouterRoute.routeRef);
      expect(entry.discoveredAt).toBe(fixedNow());
    }
  });

  it("drops an unmapped modality string rather than passing it through", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    const result = await discoverOpenRouterCatalog({
      route: openRouterRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    const gpt4oMini = result.entries.find((entry) => entry.providerModel === "openai/gpt-4o-mini");
    expect(gpt4oMini?.inputModalities).toEqual(["text"]);
    expect(gpt4oMini?.inputModalities).not.toContain("file");
  });

  it("maps supported_parameters 'tools' to tool_call and 'reasoning' to reasoning, dropping an unmapped parameter", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    const result = await discoverOpenRouterCatalog({
      route: openRouterRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    const sonnet = result.entries.find(
      (entry) => entry.providerModel === "anthropic/claude-3-5-sonnet"
    );
    expect(sonnet?.features).toEqual(expect.arrayContaining(["tool_call", "reasoning"]));
    expect(sonnet?.features).toHaveLength(2);
    // "top_k" is a real OpenRouter supported_parameters value with no MODEL_FEATURES mapping.
    expect(sonnet?.features).not.toContain("top_k");
  });

  it("reads context_length and top_provider.max_completion_tokens, omitting them when absent", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    const result = await discoverOpenRouterCatalog({
      route: openRouterRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    const sonnet = result.entries.find(
      (entry) => entry.providerModel === "anthropic/claude-3-5-sonnet"
    );
    expect(sonnet?.contextWindowTokens).toBe(200000);
    expect(sonnet?.maxOutputTokens).toBe(8192);

    const llama = result.entries.find((entry) => entry.providerModel === "meta/llama-3-70b");
    expect(llama?.maxOutputTokens).toBeUndefined();
  });

  it("carries pricing into RoutePricing for entries that report it and omits it for those that do not", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    const result = await discoverOpenRouterCatalog({
      route: openRouterRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(result.pricing.get("anthropic/claude-3-5-sonnet")).toEqual({
      inputUsdPerToken: 0.000003,
      outputUsdPerToken: 0.000015
    });
    expect(result.pricing.has("meta/llama-3-70b")).toBe(false);
  });

  it("raises provider_error (retryable true) on a payload whose top-level shape does not parse", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: { unexpected: "shape" } }]
      }
    ]);

    await expect(
      discoverOpenRouterCatalog({
        route: openRouterRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      })
    ).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("raises rate_limited on HTTP 429", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", status: 429 }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverOpenRouterCatalog({
        route: openRouterRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelRoutingError);
    expect((caught as ModelRoutingError).code).toBe("rate_limited");
    expect((caught as ModelRoutingError).retryable).toBe(true);
  });

  it("raises provider_error (retryable true) when the network call itself throws", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "throws", error: new TypeError("fetch failed: ECONNRESET") }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverOpenRouterCatalog({
        route: openRouterRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelRoutingError);
    const routingError = caught as ModelRoutingError;
    expect(routingError.code).toBe("provider_error");
    expect(routingError.retryable).toBe(true);
    expect(routingError.message).toContain(openRouterRoute.routeRef);
    expect(routingError.message).not.toContain("sk-fixture-secret-for-");
  });

  it("raises provider_error (retryable true) when the response body is not JSON", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", rawBody: "<html>upstream error</html>" }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverOpenRouterCatalog({
        route: openRouterRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelRoutingError);
    const routingError = caught as ModelRoutingError;
    expect(routingError.code).toBe("provider_error");
    expect(routingError.retryable).toBe(true);
    expect(routingError.message).toContain(openRouterRoute.routeRef);
    expect(routingError.message).not.toContain("sk-fixture-secret-for-");
  });

  it("throws a TypeError, not a ModelRoutingError, when given a non-openrouter route", async () => {
    const wrongKindRoute: ModelRoute = {
      schemaVersion: 1,
      routeRef: "route.gateway.sonnet",
      displayName: "Gateway Sonnet",
      transport: {
        kind: "vercel_ai_gateway",
        gatewayModel: "anthropic/claude-3-5-sonnet",
        credentialRefId
      },
      enabled: true
    };
    const { fetch } = createFixtureFetch([]);

    let caught: unknown;
    try {
      await discoverOpenRouterCatalog({
        route: wrongKindRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(ModelRoutingError);
    expect((caught as TypeError).message).toContain("vercel_ai_gateway");
  });

  it("drops an entry whose modality strings are all unmapped, keeping its valid siblings", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    const result = await discoverOpenRouterCatalog({
      route: openRouterRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(result.entries.some((entry) => entry.providerModel === "vendor/telepathic-model")).toBe(
      false
    );
    expect(result.entries.some((entry) => entry.providerModel === "openai/gpt-4o-mini")).toBe(true);
  });
});
