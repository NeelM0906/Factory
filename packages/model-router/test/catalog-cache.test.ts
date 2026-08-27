import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelRoutingError,
  type CredentialRefId,
  type ModelCatalogEntry,
  type ModelRoute
} from "@autostack/contracts";

import {
  createCatalogCache,
  DEFAULT_CATALOG_MAX_STALE_MS,
  DEFAULT_CATALOG_TTL_MS
} from "../src/catalog/catalog-cache.js";
import { discoverCatalog, discoverDirectCatalog } from "../src/catalog/catalog-discovery.js";
import { discoverGatewayCatalog, GATEWAY_MODELS_URL } from "../src/catalog/gateway-catalog.js";
import { OPENROUTER_MODELS_URL } from "../src/catalog/openrouter-catalog.js";
import { createFakeCredentialResolver } from "./support/fake-credential-resolver.js";
import { createFixtureFetch } from "./support/fixture-fetch.js";
import gatewayModelsFixture from "./fixtures/gateway-models.json" with { type: "json" };
import openRouterModelsFixture from "./fixtures/openrouter-models.json" with { type: "json" };
import openAiModelsFixture from "./fixtures/openai-models.json" with { type: "json" };
import anthropicModelsFixture from "./fixtures/anthropic-models.json" with { type: "json" };
import xaiModelsFixture from "./fixtures/xai-models.json" with { type: "json" };

const credA = CredentialRefIdSchema.parse("cred_aaaaaaaa-e89b-42d3-a456-426614174000");
const credB = CredentialRefIdSchema.parse("cred_bbbbbbbb-e89b-42d3-a456-426614174000");
const credC = CredentialRefIdSchema.parse("cred_cccccccc-e89b-42d3-a456-426614174000");
const credD = CredentialRefIdSchema.parse("cred_dddddddd-e89b-42d3-a456-426614174000");
const credE = CredentialRefIdSchema.parse("cred_eeeeeeee-e89b-42d3-a456-426614174000");
const credF = CredentialRefIdSchema.parse("cred_ffffffff-e89b-42d3-a456-426614174000");

const buildGatewayRoute = (
  overrides: Partial<{
    readonly routeRef: string;
    readonly credentialRefId: CredentialRefId;
  }> = {}
): ModelRoute => ({
  schemaVersion: 1,
  routeRef: overrides.routeRef ?? "route.gateway.sonnet",
  displayName: "Gateway Sonnet",
  transport: {
    kind: "vercel_ai_gateway",
    gatewayModel: "anthropic/claude-3-5-sonnet",
    credentialRefId: overrides.credentialRefId ?? credA
  },
  enabled: true
});

/** A mutable clock the tests advance explicitly — never ambient Date.now(). */
const createClock = (startIso: string) => {
  let currentMs = Date.parse(startIso);
  return {
    now: (): string => new Date(currentMs).toISOString(),
    advance: (ms: number): void => {
      currentMs += ms;
    }
  };
};

describe("createCatalogCache", () => {
  it("discovers on first read and returns fresh entries stamped with discoveredAt", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [{ kind: "response", body: gatewayModelsFixture }]
      }
    ]);
    const cache = createCatalogCache({ discover: discoverGatewayCatalog, now: clock.now });

    const snapshot = await cache.read({ route, credentials, fetch });

    expect(snapshot.freshness).toBe("fresh");
    expect(snapshot.entries).toHaveLength(4);
    expect(snapshot.discoveredAt).toBe(clock.now());
    expect(calls).toHaveLength(1);
    expect(credentials.countFor(credA)).toBe(1);
  });

  it("serves a read inside ttlMs from cache, with no second fetch and no second credential resolution", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [{ kind: "response", body: gatewayModelsFixture }]
      }
    ]);
    const cache = createCatalogCache({
      discover: discoverGatewayCatalog,
      now: clock.now,
      ttlMs: 900_000
    });

    const first = await cache.read({ route, credentials, fetch });
    clock.advance(899_999);
    const second = await cache.read({ route, credentials, fetch });

    expect(second.freshness).toBe("fresh");
    expect(second.entries).toEqual(first.entries);
    expect(calls).toHaveLength(1);
    expect(credentials.countFor(credA)).toBe(1);
  });

  it("rediscovers and returns fresh once ttlMs has elapsed", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [{ kind: "response", body: gatewayModelsFixture }]
      }
    ]);
    const cache = createCatalogCache({
      discover: discoverGatewayCatalog,
      now: clock.now,
      ttlMs: 900_000
    });

    await cache.read({ route, credentials, fetch });
    clock.advance(900_000);
    const second = await cache.read({ route, credentials, fetch });

    expect(second.freshness).toBe("fresh");
    expect(second.discoveredAt).toBe(clock.now());
    expect(calls).toHaveLength(2);
    expect(credentials.countFor(credA)).toBe(2);
  });

  it("serves the cached snapshot as stale, without raising, when rediscovery fails", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute();
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [
          { kind: "response", body: gatewayModelsFixture },
          { kind: "response", status: 500 }
        ]
      }
    ]);
    const cache = createCatalogCache({
      discover: discoverGatewayCatalog,
      now: clock.now,
      ttlMs: 900_000,
      maxStaleMs: 86_400_000
    });

    const first = await cache.read({ route, credentials, fetch });
    clock.advance(900_000);
    const second = await cache.read({ route, credentials, fetch });

    expect(second.freshness).toBe("stale");
    expect(second.entries).toEqual(first.entries);
    expect(second.discoveredAt).toBe(first.discoveredAt);
  });

  it("serves a stale snapshot exactly at maxStaleMs, but raises provider_error one millisecond past it", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute();
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [
          { kind: "response", body: gatewayModelsFixture },
          { kind: "response", status: 500 }
        ]
      }
    ]);
    const ttlMs = 1_000;
    const maxStaleMs = 5_000;
    const cache = createCatalogCache({
      discover: discoverGatewayCatalog,
      now: clock.now,
      ttlMs,
      maxStaleMs
    });

    await cache.read({ route, credentials, fetch });

    clock.advance(maxStaleMs);
    const atBoundary = await cache.read({ route, credentials, fetch });
    expect(atBoundary.freshness).toBe("stale");

    clock.advance(1);
    let caught: unknown;
    try {
      await cache.read({ route, credentials, fetch });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelRoutingError);
    const routingError = caught as ModelRoutingError;
    expect(routingError.code).toBe("provider_error");
    expect(routingError.retryable).toBe(true);
  });

  it("raises the classified provider_error, attributed with routeRef, when discovery fails with no cached snapshot", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute({ routeRef: "route.gateway.no-cache", credentialRefId: credB });
    const { fetch } = createFixtureFetch([
      { method: "GET", url: GATEWAY_MODELS_URL, responses: [{ kind: "response", status: 500 }] }
    ]);
    const cache = createCatalogCache({ discover: discoverGatewayCatalog, now: clock.now });

    let caught: unknown;
    try {
      await cache.read({ route, credentials, fetch });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelRoutingError);
    const routingError = caught as ModelRoutingError;
    expect(routingError.code).toBe("provider_error");
    expect(routingError.retryable).toBe(true);
    expect(routingError.failure.routeRef).toBe(route.routeRef);
  });

  it("raises rate_limited, attributed with routeRef, on a 429 with no cached snapshot", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute({
      routeRef: "route.gateway.rate-limited",
      credentialRefId: credC
    });
    const { fetch } = createFixtureFetch([
      { method: "GET", url: GATEWAY_MODELS_URL, responses: [{ kind: "response", status: 429 }] }
    ]);
    const cache = createCatalogCache({ discover: discoverGatewayCatalog, now: clock.now });

    let caught: unknown;
    try {
      await cache.read({ route, credentials, fetch });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelRoutingError);
    const routingError = caught as ModelRoutingError;
    expect(routingError.code).toBe("rate_limited");
    expect(routingError.retryable).toBe(true);
    expect(routingError.failure.routeRef).toBe(route.routeRef);
  });

  it("keeps independent per-route snapshots for two routes sharing a provider but differing credentialRefId", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const routeA = buildGatewayRoute({
      routeRef: "route.gateway.shared.a",
      credentialRefId: credD
    });
    const routeB = buildGatewayRoute({
      routeRef: "route.gateway.shared.b",
      credentialRefId: credE
    });
    const alternateGatewayBody = {
      object: "list",
      data: [
        {
          id: "openai/gpt-3.5-turbo",
          name: "GPT-3.5 Turbo",
          modality: { input: ["text"], output: ["text"] },
          capabilities: []
        }
      ]
    };
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [
          { kind: "response", body: gatewayModelsFixture },
          { kind: "response", body: alternateGatewayBody }
        ]
      }
    ]);
    const cache = createCatalogCache({ discover: discoverGatewayCatalog, now: clock.now });

    const snapshotA = await cache.read({ route: routeA, credentials, fetch });
    const snapshotB = await cache.read({ route: routeB, credentials, fetch });

    expect(calls).toHaveLength(2);
    expect(credentials.countFor(credD)).toBe(1);
    expect(credentials.countFor(credE)).toBe(1);
    expect(snapshotB.entries.map((entry) => entry.providerModel)).toEqual(["openai/gpt-3.5-turbo"]);
    expect(snapshotA.entries.some((entry) => entry.providerModel === "openai/gpt-3.5-turbo")).toBe(
      false
    );

    const snapshotAAgain = await cache.read({ route: routeA, credentials, fetch });
    expect(snapshotAAgain.entries).toEqual(snapshotA.entries);
    expect(calls).toHaveLength(2);
  });

  it("single-flights concurrent reads during one in-flight discovery into exactly one fetch call", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute({
      routeRef: "route.gateway.single-flight",
      credentialRefId: credF
    });
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [{ kind: "response", body: gatewayModelsFixture }]
      }
    ]);
    const cache = createCatalogCache({ discover: discoverGatewayCatalog, now: clock.now });

    const [first, second] = await Promise.all([
      cache.read({ route, credentials, fetch }),
      cache.read({ route, credentials, fetch })
    ]);

    expect(calls).toHaveLength(1);
    expect(credentials.countFor(credF)).toBe(1);
    expect(first.entries).toEqual(second.entries);
  });

  it("defaults ttlMs to 900_000 and maxStaleMs to 86_400_000 when unspecified", async () => {
    expect(DEFAULT_CATALOG_TTL_MS).toBe(900_000);
    expect(DEFAULT_CATALOG_MAX_STALE_MS).toBe(86_400_000);

    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [{ kind: "response", body: gatewayModelsFixture }]
      }
    ]);
    const cache = createCatalogCache({ discover: discoverGatewayCatalog, now: clock.now });

    await cache.read({ route, credentials, fetch });
    clock.advance(DEFAULT_CATALOG_TTL_MS - 1);
    await cache.read({ route, credentials, fetch });

    expect(calls).toHaveLength(1);
  });

  it("never lets a caller's mutation of the returned entries array affect the next read", async () => {
    const clock = createClock("2026-08-27T00:00:00.000Z");
    const credentials = createFakeCredentialResolver();
    const route = buildGatewayRoute();
    const { fetch } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [{ kind: "response", body: gatewayModelsFixture }]
      }
    ]);
    const cache = createCatalogCache({ discover: discoverGatewayCatalog, now: clock.now });

    const first = await cache.read({ route, credentials, fetch });
    const originalLength = first.entries.length;
    const firstEntry = first.entries[0];
    if (firstEntry === undefined) throw new Error("expected at least one entry in the fixture");
    (first.entries as ModelCatalogEntry[]).push({
      ...firstEntry,
      providerModel: "mutated/injected"
    });

    const second = await cache.read({ route, credentials, fetch });

    expect(second.entries).toHaveLength(originalLength);
    expect(second.entries.some((entry) => entry.providerModel === "mutated/injected")).toBe(false);
  });
});

describe("discoverCatalog", () => {
  const fixedNow = () => "2026-08-27T00:00:00.000Z";

  const openRouterRoute: ModelRoute = {
    schemaVersion: 1,
    routeRef: "route.openrouter.sonnet",
    displayName: "OpenRouter Sonnet",
    transport: {
      kind: "openrouter",
      openRouterModel: "anthropic/claude-3-5-sonnet",
      credentialRefId: credC
    },
    enabled: true
  };
  const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
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
      credentialRefId: credD
    },
    enabled: true
  };
  const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
  const anthropicRoute: ModelRoute = {
    schemaVersion: 1,
    routeRef: "route.direct.anthropic.sonnet",
    displayName: "Direct Anthropic Sonnet",
    transport: {
      kind: "direct",
      protocol: "anthropic",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      providerModel: "claude-3-5-sonnet-20241022",
      credentialRefId: credE
    },
    enabled: true
  };
  const XAI_MODELS_URL = "https://api.x.ai/v1/language-models";
  const xaiRoute: ModelRoute = {
    schemaVersion: 1,
    routeRef: "route.direct.xai.grok",
    displayName: "Direct xAI Grok",
    transport: {
      kind: "direct",
      protocol: "openai_compatible",
      provider: "xai",
      endpoint: "https://api.x.ai",
      providerModel: "grok-2-latest",
      credentialRefId: credF
    },
    enabled: true
  };

  it("dispatches a vercel_ai_gateway route to the gateway discoverer", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: GATEWAY_MODELS_URL,
        responses: [{ kind: "response", body: gatewayModelsFixture }]
      }
    ]);

    const result = await discoverCatalog({
      route: buildGatewayRoute(),
      credentials,
      fetch,
      now: fixedNow
    });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(credentials.countFor(credA)).toBe(1);
  });

  it("dispatches an openrouter route to the openrouter discoverer", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: OPENROUTER_MODELS_URL,
        responses: [{ kind: "response", body: openRouterModelsFixture }]
      }
    ]);

    const result = await discoverCatalog({
      route: openRouterRoute,
      credentials,
      fetch,
      now: fixedNow
    });

    expect(
      result.entries.some((entry) => entry.providerModel === "anthropic/claude-3-5-sonnet")
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(credentials.countFor(credC)).toBe(1);
  });

  it("dispatches a direct/openai_compatible/openai route to the openai discoverer", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: OPENAI_MODELS_URL,
        responses: [{ kind: "response", body: openAiModelsFixture }]
      }
    ]);

    const result = await discoverCatalog({ route: openAiRoute, credentials, fetch, now: fixedNow });

    expect(
      result.entries.every(
        (entry) => entry.inputModalities.length === 1 && entry.inputModalities[0] === "text"
      )
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(credentials.countFor(credD)).toBe(1);
  });

  it("dispatches a direct/anthropic route to the anthropic discoverer", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: ANTHROPIC_MODELS_URL,
        responses: [{ kind: "response", body: anthropicModelsFixture }]
      }
    ]);

    const result = await discoverCatalog({
      route: anthropicRoute,
      credentials,
      fetch,
      now: fixedNow
    });

    expect(
      result.entries.some((entry) => entry.providerModel === "claude-3-5-sonnet-20241022")
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(credentials.countFor(credE)).toBe(1);
  });

  it("dispatches a direct/openai_compatible/xai route to the xai discoverer", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch, calls } = createFixtureFetch([
      {
        method: "GET",
        url: XAI_MODELS_URL,
        responses: [{ kind: "response", body: xaiModelsFixture }]
      }
    ]);

    const result = await discoverCatalog({ route: xaiRoute, credentials, fetch, now: fixedNow });

    expect(result.entries.some((entry) => entry.providerModel === "grok-2-latest")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(credentials.countFor(credF)).toBe(1);
  });

  it("throws a TypeError for an unsupported direct protocol/provider combination", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch } = createFixtureFetch([]);
    const unsupportedRoute: ModelRoute = {
      schemaVersion: 1,
      routeRef: "route.direct.google.gemini",
      displayName: "Direct Google Gemini",
      transport: {
        kind: "direct",
        protocol: "google",
        provider: "google",
        endpoint: "https://generativelanguage.googleapis.com",
        providerModel: "gemini-1.5-pro",
        credentialRefId: credA
      },
      enabled: true
    };

    let caught: unknown;
    try {
      await discoverCatalog({ route: unsupportedRoute, credentials, fetch, now: fixedNow });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(ModelRoutingError);
  });

  it("throws a TypeError when discoverDirectCatalog is called with a non-direct route", async () => {
    const credentials = createFakeCredentialResolver();
    const { fetch } = createFixtureFetch([]);

    let caught: unknown;
    try {
      await discoverDirectCatalog({
        route: buildGatewayRoute(),
        credentials,
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
