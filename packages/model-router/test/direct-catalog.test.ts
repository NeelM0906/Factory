import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelCatalogEntrySchema,
  ModelInferenceRequestSchema,
  ModelRoutingError,
  type ModelRoute
} from "@autostack/contracts";

import {
  ANTHROPIC_MAX_CATALOG_PAGES,
  discoverAnthropicCatalog,
  discoverOpenAiCatalog,
  discoverXaiCatalog
} from "../src/catalog/direct-catalog.js";
import { createDeclaredCapabilities } from "../src/catalog/declared-capabilities.js";
import { createRouteRegistry, type ExactUsageSink } from "../src/route-registry.js";
import { createModelInference } from "../src/transport/transport-client.js";
import { createFakeCredentialResolver } from "./support/fake-credential-resolver.js";
import { createFixtureFetch } from "./support/fixture-fetch.js";
import openAiModelsFixture from "./fixtures/openai-models.json" with { type: "json" };
import anthropicModelsFixture from "./fixtures/anthropic-models.json" with { type: "json" };
import xaiModelsFixture from "./fixtures/xai-models.json" with { type: "json" };

const credentialRefId = CredentialRefIdSchema.parse("cred_323e4567-e89b-42d3-a456-426614174000");
const fixedNow = () => "2026-08-27T00:00:00.000Z";

const openAiRoute: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.direct.openai.gpt4o",
  displayName: "Direct OpenAI GPT-4o",
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
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

const anthropicRoute: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.direct.anthropic.sonnet",
  displayName: "Direct Anthropic Sonnet",
  transport: {
    kind: "direct",
    protocol: "anthropic",
    provider: "anthropic",
    endpoint: "https://api.anthropic.com/v1",
    providerModel: "claude-3-5-sonnet-20241022",
    credentialRefId
  },
  enabled: true
};
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

const xaiRoute: ModelRoute = {
  schemaVersion: 1,
  routeRef: "route.direct.xai.grok",
  displayName: "Direct xAI Grok",
  transport: {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "xai",
    endpoint: "https://api.x.ai/v1",
    providerModel: "grok-2-latest",
    credentialRefId
  },
  enabled: true
};
const XAI_MODELS_URL = "https://api.x.ai/v1/language-models";

describe("discoverOpenAiCatalog", () => {
  it("resolves the route's credential exactly once, authenticated by header name only", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "response", body: openAiModelsFixture }]
      }
    ]);

    await discoverOpenAiCatalog({ route: openAiRoute, credentials, fetch, now: fixedNow });

    expect(credentials.countFor(openAiRoute.transport.credentialRefId)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(OPENAI_MODELS_URL);
    expect(calls[0]?.headerNames).toContain("authorization");
  });

  it("lands every entry at the DEC-1 conservative floor", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "response", body: openAiModelsFixture }]
      }
    ]);

    const result = await discoverOpenAiCatalog({
      route: openAiRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(result.entries).toHaveLength(3);
    for (const entry of result.entries) {
      expect(() => ModelCatalogEntrySchema.parse(entry)).not.toThrow();
      expect(entry.inputModalities).toEqual(["text"]);
      expect(entry.outputModalities).toEqual(["text"]);
      expect(entry.features).toEqual([]);
      expect(entry.routeRef).toBe(openAiRoute.routeRef);
      expect(entry.discoveredAt).toBe(fixedNow());
    }
  });

  it("raises provider_error (retryable true) when the network call itself throws", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "throws", error: new TypeError("fetch failed: ECONNRESET") }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverOpenAiCatalog({
        route: openAiRoute,
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
    expect(routingError.message).not.toContain("sk-fixture-secret-for-");
  });

  it("raises provider_error (retryable true) when the response body is not JSON", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "response", rawBody: "<html>upstream error</html>" }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverOpenAiCatalog({
        route: openAiRoute,
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
    expect(routingError.message).not.toContain("sk-fixture-secret-for-");
  });

  it("raises provider_error (retryable true) on a well-formed JSON envelope that fails the schema", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "response", body: { unexpected: "shape" } }]
      }
    ]);

    await expect(
      discoverOpenAiCatalog({
        route: openAiRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      })
    ).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("raises rate_limited on HTTP 429", async () => {
    const { fetch } = createFixtureFetch([
      { method: "GET", url: OPENAI_MODELS_URL, responses: [{ kind: "response", status: 429 }] }
    ]);

    let caught: unknown;
    try {
      await discoverOpenAiCatalog({
        route: openAiRoute,
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

  it("throws a TypeError, not a ModelRoutingError, for a route with the wrong protocol", async () => {
    const { fetch } = createFixtureFetch([]);

    let caught: unknown;
    try {
      await discoverOpenAiCatalog({
        route: anthropicRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(ModelRoutingError);
  });

  it("applies a declared capability override for a named model while its siblings stay at the floor", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "response", body: openAiModelsFixture }]
      }
    ]);

    const declaredCapabilities = createDeclaredCapabilities({
      "gpt-4o": {
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        features: ["tool_call", "structured_output"]
      }
    });

    const result = await discoverOpenAiCatalog({
      route: openAiRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow,
      declaredCapabilities
    });

    const gpt4o = result.entries.find((entry) => entry.providerModel === "gpt-4o");
    expect(gpt4o?.inputModalities).toEqual(["text", "image"]);
    expect(gpt4o?.features).toEqual(["tool_call", "structured_output"]);

    const gpt4oMini = result.entries.find((entry) => entry.providerModel === "gpt-4o-mini");
    expect(gpt4oMini?.inputModalities).toEqual(["text"]);
    expect(gpt4oMini?.features).toEqual([]);
  });

  it("rejects a declared capability outside MODEL_MODALITIES/MODEL_FEATURES at construction", () => {
    expect(() =>
      createDeclaredCapabilities({
        "gpt-4o": {
          inputModalities: ["telepathy"],
          outputModalities: ["text"],
          features: []
        }
      })
    ).toThrow();
  });

  it("does not resurrect a model the provider did not list via a declared capability", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "response", body: openAiModelsFixture }]
      }
    ]);

    const declaredCapabilities = createDeclaredCapabilities({
      "gpt-4-ghost": {
        inputModalities: ["text"],
        outputModalities: ["text"],
        features: ["tool_call"]
      }
    });

    const result = await discoverOpenAiCatalog({
      route: openAiRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow,
      declaredCapabilities
    });

    expect(result.entries.some((entry) => entry.providerModel === "gpt-4-ghost")).toBe(false);
    expect(result.entries).toHaveLength(3);
  });
});

describe("discoverAnthropicCatalog", () => {
  it("resolves the route's credential exactly once, authenticated by x-api-key header name only", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [{ kind: "response", body: anthropicModelsFixture }]
      }
    ]);

    await discoverAnthropicCatalog({ route: anthropicRoute, credentials, fetch, now: fixedNow });

    expect(credentials.countFor(anthropicRoute.transport.credentialRefId)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(ANTHROPIC_MODELS_URL);
    expect(calls[0]?.headerNames).toContain("x-api-key");
  });

  it("takes displayName from display_name and lands the capability floor", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [{ kind: "response", body: anthropicModelsFixture }]
      }
    ]);

    const result = await discoverAnthropicCatalog({
      route: anthropicRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(result.entries).toHaveLength(2);
    const sonnet = result.entries.find(
      (entry) => entry.providerModel === "claude-3-5-sonnet-20241022"
    );
    expect(sonnet?.displayName).toBe("Claude 3.5 Sonnet");
    expect(sonnet?.inputModalities).toEqual(["text"]);
    expect(sonnet?.outputModalities).toEqual(["text"]);
    expect(sonnet?.features).toEqual([]);
    for (const entry of result.entries) {
      expect(() => ModelCatalogEntrySchema.parse(entry)).not.toThrow();
    }
  });

  it("follows has_more pages via after_id only up to a bounded page count", async () => {
    const foreverLoopingUrl = `${ANTHROPIC_MODELS_URL}?after_id=${encodeURIComponent("claude-forever")}`;
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [
          {
            kind: "response",
            body: {
              data: [
                {
                  type: "model",
                  id: "claude-forever",
                  display_name: "Claude Forever",
                  created_at: "2024-01-01T00:00:00Z"
                }
              ],
              has_more: true,
              first_id: "claude-forever",
              last_id: "claude-forever"
            }
          }
        ]
      },
      {
        method: "GET",
        url: foreverLoopingUrl,
        // A hostile/buggy provider that always claims more pages exist behind the same cursor.
        // Without a bound this would never terminate (provider responses are untrusted input,
        // spec §14.1). The fixture-fetch double repeats this single response indefinitely.
        responses: [
          {
            kind: "response",
            body: {
              data: [
                {
                  type: "model",
                  id: "claude-forever",
                  display_name: "Claude Forever",
                  created_at: "2024-01-01T00:00:00Z"
                }
              ],
              has_more: true,
              first_id: "claude-forever",
              last_id: "claude-forever"
            }
          }
        ]
      }
    ]);

    const result = await discoverAnthropicCatalog({
      route: anthropicRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(calls).toHaveLength(ANTHROPIC_MAX_CATALOG_PAGES);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.providerModel).toBe("claude-forever");
  });

  it("raises provider_error (retryable true) when the network call itself throws", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [{ kind: "throws", error: new TypeError("fetch failed: ECONNRESET") }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverAnthropicCatalog({
        route: anthropicRoute,
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
    expect(routingError.message).not.toContain("sk-fixture-secret-for-");
  });

  it("raises provider_error (retryable true) when the response body is not JSON", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [{ kind: "response", rawBody: "<html>upstream error</html>" }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverAnthropicCatalog({
        route: anthropicRoute,
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
    expect(routingError.message).not.toContain("sk-fixture-secret-for-");
  });

  it("raises provider_error (retryable true) on a well-formed JSON envelope that fails the schema", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [{ kind: "response", body: { unexpected: "shape" } }]
      }
    ]);

    await expect(
      discoverAnthropicCatalog({
        route: anthropicRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      })
    ).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("raises rate_limited on HTTP 429", async () => {
    const { fetch } = createFixtureFetch([
      { method: "GET", url: ANTHROPIC_MODELS_URL, responses: [{ kind: "response", status: 429 }] }
    ]);

    let caught: unknown;
    try {
      await discoverAnthropicCatalog({
        route: anthropicRoute,
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

  it("skips a malformed entry, keeping its valid siblings", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [
          {
            kind: "response",
            body: {
              data: [
                {
                  type: "model",
                  id: "claude-3-5-sonnet-20241022",
                  display_name: "Claude 3.5 Sonnet",
                  created_at: "2024-10-22T00:00:00Z"
                },
                { type: "model", display_name: "Missing id", created_at: "2024-01-01T00:00:00Z" }
              ],
              has_more: false
            }
          }
        ]
      }
    ]);

    const result = await discoverAnthropicCatalog({
      route: anthropicRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.providerModel).toBe("claude-3-5-sonnet-20241022");
  });

  it("stops pagination when has_more is true but last_id is absent", async () => {
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [
          {
            kind: "response",
            body: {
              data: [
                {
                  type: "model",
                  id: "claude-3-5-sonnet-20241022",
                  display_name: "Claude 3.5 Sonnet",
                  created_at: "2024-10-22T00:00:00Z"
                }
              ],
              has_more: true
            }
          }
        ]
      }
    ]);

    const result = await discoverAnthropicCatalog({
      route: anthropicRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(calls).toHaveLength(1);
    expect(result.entries).toHaveLength(1);
  });

  it("throws a TypeError, not a ModelRoutingError, for a route with the wrong protocol", async () => {
    const { fetch } = createFixtureFetch([]);

    let caught: unknown;
    try {
      await discoverAnthropicCatalog({
        route: xaiRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(ModelRoutingError);
  });
});

describe("discoverXaiCatalog", () => {
  it("resolves the route's credential exactly once, authenticated by header name only", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [{ kind: "response", body: xaiModelsFixture }]
      }
    ]);

    await discoverXaiCatalog({ route: xaiRoute, credentials, fetch, now: fixedNow });

    expect(credentials.countFor(xaiRoute.transport.credentialRefId)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(XAI_MODELS_URL);
    expect(calls[0]?.headerNames).toContain("authorization");
  });

  it("reads modalities from the provider rather than flooring them, and carries pricing", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [{ kind: "response", body: xaiModelsFixture }]
      }
    ]);

    const result = await discoverXaiCatalog({
      route: xaiRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    const grok = result.entries.find((entry) => entry.providerModel === "grok-2-latest");
    expect(grok?.inputModalities).toEqual(["text", "image"]);
    expect(grok?.outputModalities).toEqual(["text"]);
    for (const entry of result.entries) {
      expect(() => ModelCatalogEntrySchema.parse(entry)).not.toThrow();
    }

    expect(result.pricing.get("grok-2-latest")).toEqual({
      inputUsdPerToken: 0.000002,
      outputUsdPerToken: 0.00001
    });
    expect(result.pricing.has("grok-2-mini")).toBe(false);
  });

  it.each([
    ["free", "free"],
    ["empty string", ""],
    ["negative", "-1"],
    ["non-numeric (N/A)", "N/A"]
  ])(
    "drops pricing for a junk %s price string without dropping the model, leaving a valid sibling's pricing intact (C1)",
    async (_label, junkPrice) => {
      const payload = {
        models: [
          {
            id: "grok-junk-priced",
            input_modalities: ["text"],
            output_modalities: ["text"],
            pricing: { prompt: junkPrice, completion: "0.000001" }
          },
          {
            id: "grok-valid-priced",
            input_modalities: ["text"],
            output_modalities: ["text"],
            pricing: { prompt: "0.000002", completion: "0.000004" }
          }
        ]
      };
      const { fetch } = createFixtureFetch([
        { method: "GET", url: XAI_MODELS_URL, responses: [{ kind: "response", body: payload }] }
      ]);

      const result = await discoverXaiCatalog({
        route: xaiRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      });

      // The junk-priced entry's catalog declaration still parses -- a junk price must not
      // silently drop the model itself, only its pricing.
      expect(result.entries.some((entry) => entry.providerModel === "grok-junk-priced")).toBe(true);
      expect(result.pricing.has("grok-junk-priced")).toBe(false);

      // A valid sibling in the same payload keeps its pricing -- the drop is per-entry.
      expect(result.pricing.get("grok-valid-priced")).toEqual({
        inputUsdPerToken: 0.000002,
        outputUsdPerToken: 0.000004
      });
    }
  );

  it("drops an entry whose modality strings are all unmapped, keeping its valid siblings", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [{ kind: "response", body: xaiModelsFixture }]
      }
    ]);

    const result = await discoverXaiCatalog({
      route: xaiRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(result.entries.some((entry) => entry.providerModel === "grok-telepathic")).toBe(false);
    expect(result.entries.some((entry) => entry.providerModel === "grok-2-latest")).toBe(true);
    expect(result.entries.some((entry) => entry.providerModel === "grok-2-mini")).toBe(true);
  });

  it("deduplicates entries by providerModel, keeping the first, and skips a malformed entry", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [
          {
            kind: "response",
            body: {
              models: [
                { id: "grok-2-latest", input_modalities: ["text"], output_modalities: ["text"] },
                {
                  id: "grok-2-latest",
                  input_modalities: ["text", "image"],
                  output_modalities: ["text"]
                },
                { input_modalities: ["text"], output_modalities: ["text"] }
              ]
            }
          }
        ]
      }
    ]);

    const result = await discoverXaiCatalog({
      route: xaiRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.inputModalities).toEqual(["text"]);
  });

  it("raises provider_error (retryable true) when the network call itself throws", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [{ kind: "throws", error: new TypeError("fetch failed: ECONNRESET") }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverXaiCatalog({
        route: xaiRoute,
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
    expect(routingError.message).not.toContain("sk-fixture-secret-for-");
  });

  it("raises provider_error (retryable true) when the response body is not JSON", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [{ kind: "response", rawBody: "<html>upstream error</html>" }]
      }
    ]);

    let caught: unknown;
    try {
      await discoverXaiCatalog({
        route: xaiRoute,
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
    expect(routingError.message).not.toContain("sk-fixture-secret-for-");
  });

  it("raises provider_error (retryable true) on a well-formed JSON envelope that fails the schema", async () => {
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [{ kind: "response", body: { unexpected: "shape" } }]
      }
    ]);

    await expect(
      discoverXaiCatalog({
        route: xaiRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      })
    ).rejects.toMatchObject({ code: "provider_error", retryable: true });
  });

  it("raises rate_limited on HTTP 429", async () => {
    const { fetch } = createFixtureFetch([
      { method: "GET", url: XAI_MODELS_URL, responses: [{ kind: "response", status: 429 }] }
    ]);

    let caught: unknown;
    try {
      await discoverXaiCatalog({
        route: xaiRoute,
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

  it("throws a TypeError, not a ModelRoutingError, for a route with the wrong transport kind", async () => {
    const gatewayRoute: ModelRoute = {
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
      await discoverXaiCatalog({
        route: gatewayRoute,
        credentials: createFakeCredentialResolver(),
        fetch,
        now: fixedNow
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(ModelRoutingError);
  });
});

/**
 * Regression coverage for the endpoint-convention defect: catalog discovery
 * (`src/catalog/direct-catalog.ts`) and model invocation (`src/transport/language-model-factory.ts`,
 * via `createModelInference`) used to disagree about what `transport.endpoint` means for anthropic
 * and xai — no single endpoint value made both call sites hit the real provider URL. Each block below
 * takes ONE route with ONE endpoint value, composes discovery AND invocation against it (through
 * `createModelInference`, never the individual unit modules), and asserts both resulting URLs against
 * the provider's real, correct URL — no missing `/v1`, no doubled `/v1`. A per-module test cannot
 * catch a disagreement between modules; this can only be caught by composing both against one route.
 */
describe("endpoint convention: discovery and invocation composed against one route", () => {
  const noopExactUsageSink: ExactUsageSink = { record: async () => undefined };

  const buildInferenceRequest = (route: ModelRoute, idempotencyKey: string) =>
    ModelInferenceRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey,
      selection: {
        schemaVersion: 1,
        idempotencyKey,
        routeRef: route.routeRef,
        reason: "Route selected for a regression test.",
        selectedAt: fixedNow()
      },
      messages: [{ role: "user", content: "Say hi in one word." }],
      options: { maxOutputTokens: 32 }
    });

  const runInference = async (route: ModelRoute, fetch: typeof globalThis.fetch) => {
    const registry = createRouteRegistry({ routes: [route], exactUsageSink: noopExactUsageSink });
    const inference = createModelInference({
      routes: registry,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow,
      monotonicNowMs: () => 0
    });
    await inference.run(buildInferenceRequest(route, `idem-regression-${route.routeRef}`));
  };

  it("openai: discovery hits {endpoint}/models and invocation hits {endpoint}/chat/completions", async () => {
    const invocationUrl = "https://api.openai.com/v1/chat/completions";
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "response", body: openAiModelsFixture }]
      },
      {
        method: "POST",
        url: invocationUrl,
        responses: [
          {
            kind: "response",
            body: {
              id: "chatcmpl-fixture",
              object: "chat.completion",
              created: 1,
              model: "gpt-4o",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "hi there" },
                  finish_reason: "stop"
                }
              ]
            }
          }
        ]
      }
    ]);

    await discoverOpenAiCatalog({
      route: openAiRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });
    await runInference(openAiRoute, fetch);

    expect(calls.find((call) => call.method === "GET")?.url).toBe(OPENAI_MODELS_URL);
    expect(calls.find((call) => call.method === "GET")?.url).toBe(
      "https://api.openai.com/v1/models"
    );
    expect(calls.find((call) => call.method === "POST")?.url).toBe(invocationUrl);
    expect(calls.find((call) => call.method === "POST")?.url).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
  });

  it("anthropic: discovery hits {endpoint}/models and invocation hits {endpoint}/messages, from the same versioned-root endpoint", async () => {
    const invocationUrl = "https://api.anthropic.com/v1/messages";
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [{ kind: "response", body: anthropicModelsFixture }]
      },
      {
        method: "POST",
        url: invocationUrl,
        responses: [
          {
            kind: "response",
            body: {
              id: "msg-fixture",
              type: "message",
              role: "assistant",
              model: "claude-3-5-sonnet-20241022",
              content: [{ type: "text", text: "hi there" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 3 }
            }
          }
        ]
      }
    ]);

    await discoverAnthropicCatalog({
      route: anthropicRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });
    await runInference(anthropicRoute, fetch);

    // The route's single `endpoint` value ("https://api.anthropic.com/v1") is the versioned API
    // root: discovery appends only the resource path, and invocation passes it straight through as
    // the AI SDK's `baseURL` — neither call site adds or expects a second `/v1` segment.
    expect(anthropicRoute.transport.kind).toBe("direct");
    if (anthropicRoute.transport.kind === "direct") {
      expect(anthropicRoute.transport.endpoint).toBe("https://api.anthropic.com/v1");
    }
    expect(calls.find((call) => call.method === "GET")?.url).toBe(ANTHROPIC_MODELS_URL);
    expect(calls.find((call) => call.method === "GET")?.url).toBe(
      "https://api.anthropic.com/v1/models"
    );
    expect(calls.find((call) => call.method === "POST")?.url).toBe(invocationUrl);
    expect(calls.find((call) => call.method === "POST")?.url).toBe(
      "https://api.anthropic.com/v1/messages"
    );
    // Neither URL carries a doubled version segment.
    expect(calls.find((call) => call.method === "GET")?.url).not.toContain("/v1/v1");
    expect(calls.find((call) => call.method === "POST")?.url).not.toContain("/v1/v1");
  });

  it("xai: discovery hits {endpoint}/language-models and invocation hits {endpoint}/chat/completions, from the same versioned-root endpoint", async () => {
    const invocationUrl = "https://api.x.ai/v1/chat/completions";
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [{ kind: "response", body: xaiModelsFixture }]
      },
      {
        method: "POST",
        url: invocationUrl,
        responses: [
          {
            kind: "response",
            body: {
              id: "chatcmpl-fixture",
              object: "chat.completion",
              created: 1,
              model: "grok-2-latest",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "hi there" },
                  finish_reason: "stop"
                }
              ]
            }
          }
        ]
      }
    ]);

    await discoverXaiCatalog({
      route: xaiRoute,
      credentials: createFakeCredentialResolver(),
      fetch,
      now: fixedNow
    });
    await runInference(xaiRoute, fetch);

    expect(xaiRoute.transport.kind).toBe("direct");
    if (xaiRoute.transport.kind === "direct") {
      expect(xaiRoute.transport.endpoint).toBe("https://api.x.ai/v1");
    }
    expect(calls.find((call) => call.method === "GET")?.url).toBe(XAI_MODELS_URL);
    expect(calls.find((call) => call.method === "GET")?.url).toBe(
      "https://api.x.ai/v1/language-models"
    );
    expect(calls.find((call) => call.method === "POST")?.url).toBe(invocationUrl);
    expect(calls.find((call) => call.method === "POST")?.url).toBe(
      "https://api.x.ai/v1/chat/completions"
    );
    expect(calls.find((call) => call.method === "GET")?.url).not.toContain("/v1/v1");
    expect(calls.find((call) => call.method === "POST")?.url).not.toContain("/v1/v1");
  });
});
