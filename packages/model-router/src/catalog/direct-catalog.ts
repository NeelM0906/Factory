import { z } from "zod";

import {
  MODEL_MODALITIES,
  ModelCatalogEntrySchema,
  type ModelCatalogEntry,
  type ModelModality
} from "@autostack/contracts";

import { providerError } from "../failure/routing-failure.js";
import { classifyTransportResponse } from "../failure/http-classification.js";
import type {
  CatalogDiscoveryResult,
  DiscoverCatalogInput,
  RoutePricing
} from "./catalog-types.js";
import { applyDeclaredCapabilities, type DeclaredCapabilities } from "./declared-capabilities.js";

/**
 * `DiscoverCatalogInput` plus the DEC-1 overlay. `declaredCapabilities` is optional, so every
 * function in this module still conforms to `DiscoverCatalog` from `catalog-types.ts` and can be
 * used wherever that type is expected — the per-transport dispatcher (Task 5) simply never sets it
 * for routes that carry no operator declarations.
 */
export interface DirectDiscoverCatalogInput extends DiscoverCatalogInput {
  readonly declaredCapabilities?: DeclaredCapabilities;
}

/** DEC-1: the floor for a provider that publishes no capability metadata at all. */
const CONSERVATIVE_FLOOR_INPUT_MODALITIES = ["text"] as const;
const CONSERVATIVE_FLOOR_OUTPUT_MODALITIES = ["text"] as const;
const CONSERVATIVE_FLOOR_FEATURES: readonly never[] = [];

interface FetchCatalogJsonInput {
  readonly routeRef: string;
  readonly url: string;
  readonly fetch: typeof globalThis.fetch;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Shared GET + fail-closed JSON parse for the three direct providers in this module (ESC-3): a
 * network throw and a non-2xx status are both `classifyTransportResponse`, and a 2xx body that
 * itself fails to parse as JSON (e.g. an HTML proxy error page) is a `provider_error` distinct from
 * a well-formed JSON envelope that later fails its Zod schema.
 */
const fetchCatalogJson = async (input: FetchCatalogJsonInput): Promise<unknown> => {
  let response: Response;
  try {
    response = await input.fetch(input.url, { method: "GET", headers: input.headers });
  } catch (networkError) {
    throw classifyTransportResponse({ routeRef: input.routeRef, networkError });
  }

  if (!response.ok) {
    throw classifyTransportResponse({
      routeRef: input.routeRef,
      status: response.status,
      headers: response.headers
    });
  }

  try {
    return await response.json();
  } catch {
    throw classifyTransportResponse({
      routeRef: input.routeRef,
      status: response.status,
      headers: response.headers,
      malformedBody: true
    });
  }
};

// ---------------------------------------------------------------------------------------------
// openai (openai_compatible / openai) — GET {endpoint}/models, Authorization header.
// ---------------------------------------------------------------------------------------------

const OpenAiModelEntrySchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    created: z.number().int().nonnegative(),
    owned_by: z.string().min(1)
  })
  .strict();

const OpenAiModelListEnvelopeSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(z.unknown())
  })
  .strict();

type OpenAiModelEntry = z.infer<typeof OpenAiModelEntrySchema>;

const toFlooredCatalogEntry = (
  providerModel: string,
  displayName: string,
  routeRef: string,
  discoveredAt: string
): ModelCatalogEntry =>
  ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef,
    providerModel,
    displayName,
    inputModalities: CONSERVATIVE_FLOOR_INPUT_MODALITIES,
    outputModalities: CONSERVATIVE_FLOOR_OUTPUT_MODALITIES,
    features: CONSERVATIVE_FLOOR_FEATURES,
    discoveredAt
  });

export const discoverOpenAiCatalog = async (
  input: DirectDiscoverCatalogInput
): Promise<CatalogDiscoveryResult> => {
  const { route, credentials, fetch, now } = input;
  const { transport } = route;
  if (
    transport.kind !== "direct" ||
    transport.protocol !== "openai_compatible" ||
    transport.provider !== "openai"
  ) {
    throw new TypeError(
      `discoverOpenAiCatalog requires a direct/openai_compatible route with provider "openai", got ${describeTransport(transport)}.`
    );
  }

  const secret = await credentials.resolve(transport.credentialRefId);
  const json = await fetchCatalogJson({
    routeRef: route.routeRef,
    url: `${transport.endpoint}/models`,
    fetch,
    headers: { Authorization: `Bearer ${secret}` }
  });

  const envelope = OpenAiModelListEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw providerError({ routeRef: route.routeRef, retryable: true });
  }

  const discoveredAt = now();
  const entries: ModelCatalogEntry[] = [];
  const seenProviderModels = new Set<string>();

  for (const rawEntry of envelope.data.data) {
    const parsedEntry = OpenAiModelEntrySchema.safeParse(rawEntry);
    if (!parsedEntry.success) continue;
    const entry: OpenAiModelEntry = parsedEntry.data;
    if (seenProviderModels.has(entry.id)) continue;
    seenProviderModels.add(entry.id);
    entries.push(toFlooredCatalogEntry(entry.id, entry.id, route.routeRef, discoveredAt));
  }

  return {
    entries: applyDeclaredCapabilities(entries, input.declaredCapabilities),
    pricing: new Map<string, RoutePricing>()
  };
};

// ---------------------------------------------------------------------------------------------
// anthropic (anthropic / anthropic) — GET {endpoint}/v1/models, x-api-key header, has_more
// pages followed via after_id up to a bounded page count.
// ---------------------------------------------------------------------------------------------

/**
 * Provider responses are untrusted input (spec §14.1): a `has_more: true` page that never actually
 * terminates (a hostile or buggy provider repeating the same cursor) must not hang discovery
 * forever. This bound is generous for any real catalog and small enough to cap worst-case latency.
 */
export const ANTHROPIC_MAX_CATALOG_PAGES = 20;

const AnthropicModelEntrySchema = z
  .object({
    type: z.literal("model"),
    id: z.string().min(1),
    display_name: z.string().min(1),
    created_at: z.string().min(1)
  })
  .strict();

const AnthropicModelListEnvelopeSchema = z
  .object({
    data: z.array(z.unknown()),
    has_more: z.boolean(),
    first_id: z.string().nullable().optional(),
    last_id: z.string().nullable().optional()
  })
  .strict();

export const discoverAnthropicCatalog = async (
  input: DirectDiscoverCatalogInput
): Promise<CatalogDiscoveryResult> => {
  const { route, credentials, fetch, now } = input;
  const { transport } = route;
  if (transport.kind !== "direct" || transport.protocol !== "anthropic") {
    throw new TypeError(
      `discoverAnthropicCatalog requires a direct/anthropic route, got ${describeTransport(transport)}.`
    );
  }

  const secret = await credentials.resolve(transport.credentialRefId);
  const headers = { "x-api-key": secret, "anthropic-version": "2023-06-01" };
  const discoveredAt = now();

  const entries: ModelCatalogEntry[] = [];
  const seenProviderModels = new Set<string>();
  let afterId: string | undefined;
  let pageCount = 0;

  for (;;) {
    const url =
      afterId === undefined
        ? `${transport.endpoint}/v1/models`
        : `${transport.endpoint}/v1/models?after_id=${encodeURIComponent(afterId)}`;
    const json = await fetchCatalogJson({ routeRef: route.routeRef, url, fetch, headers });

    const envelope = AnthropicModelListEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw providerError({ routeRef: route.routeRef, retryable: true });
    }
    pageCount += 1;

    for (const rawEntry of envelope.data.data) {
      const parsedEntry = AnthropicModelEntrySchema.safeParse(rawEntry);
      if (!parsedEntry.success) continue;
      if (seenProviderModels.has(parsedEntry.data.id)) continue;
      seenProviderModels.add(parsedEntry.data.id);
      entries.push(
        toFlooredCatalogEntry(
          parsedEntry.data.id,
          parsedEntry.data.display_name,
          route.routeRef,
          discoveredAt
        )
      );
    }

    const nextAfterId = envelope.data.last_id;
    if (!envelope.data.has_more || pageCount >= ANTHROPIC_MAX_CATALOG_PAGES) break;
    if (nextAfterId === undefined || nextAfterId === null) break;
    afterId = nextAfterId;
  }

  return {
    entries: applyDeclaredCapabilities(entries, input.declaredCapabilities),
    pricing: new Map<string, RoutePricing>()
  };
};

// ---------------------------------------------------------------------------------------------
// xai (openai_compatible / xai) — GET {endpoint}/v1/language-models. Modalities are read from
// the provider rather than floored; pricing lands in RoutePricing.
// ---------------------------------------------------------------------------------------------

const mapModalities = (values: readonly string[]): ModelModality[] => {
  const mapped = new Set<ModelModality>();
  for (const value of values) {
    if ((MODEL_MODALITIES as readonly string[]).includes(value)) {
      mapped.add(value as ModelModality);
    }
  }
  return Array.from(mapped);
};

const XaiPricingSchema = z
  .object({
    prompt: z.string(),
    completion: z.string()
  })
  .strict();

const XaiModelEntrySchema = z
  .object({
    id: z.string().min(1),
    input_modalities: z.array(z.string()).min(1),
    output_modalities: z.array(z.string()).min(1),
    pricing: XaiPricingSchema.optional()
  })
  .strict();

const XaiModelListEnvelopeSchema = z
  .object({
    models: z.array(z.unknown())
  })
  .strict();

type XaiModelEntry = z.infer<typeof XaiModelEntrySchema>;

const toXaiCatalogEntry = (
  entry: XaiModelEntry,
  routeRef: string,
  discoveredAt: string
): ModelCatalogEntry | undefined => {
  const inputModalities = mapModalities(entry.input_modalities);
  const outputModalities = mapModalities(entry.output_modalities);
  if (inputModalities.length === 0 || outputModalities.length === 0) return undefined;

  return ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef,
    providerModel: entry.id,
    displayName: entry.id,
    inputModalities,
    outputModalities,
    features: [],
    discoveredAt
  });
};

const toXaiPricing = (entry: XaiModelEntry): RoutePricing | undefined => {
  if (entry.pricing === undefined) return undefined;
  return {
    inputUsdPerToken: Number(entry.pricing.prompt),
    outputUsdPerToken: Number(entry.pricing.completion)
  };
};

export const discoverXaiCatalog = async (
  input: DirectDiscoverCatalogInput
): Promise<CatalogDiscoveryResult> => {
  const { route, credentials, fetch, now } = input;
  const { transport } = route;
  if (
    transport.kind !== "direct" ||
    transport.protocol !== "openai_compatible" ||
    transport.provider !== "xai"
  ) {
    throw new TypeError(
      `discoverXaiCatalog requires a direct/openai_compatible route with provider "xai", got ${describeTransport(transport)}.`
    );
  }

  const secret = await credentials.resolve(transport.credentialRefId);
  const json = await fetchCatalogJson({
    routeRef: route.routeRef,
    url: `${transport.endpoint}/v1/language-models`,
    fetch,
    headers: { Authorization: `Bearer ${secret}` }
  });

  const envelope = XaiModelListEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw providerError({ routeRef: route.routeRef, retryable: true });
  }

  const discoveredAt = now();
  const entries: ModelCatalogEntry[] = [];
  const pricing = new Map<string, RoutePricing>();
  const seenProviderModels = new Set<string>();

  for (const rawEntry of envelope.data.models) {
    const parsedEntry = XaiModelEntrySchema.safeParse(rawEntry);
    if (!parsedEntry.success) continue;
    if (seenProviderModels.has(parsedEntry.data.id)) continue;
    seenProviderModels.add(parsedEntry.data.id);

    const catalogEntry = toXaiCatalogEntry(parsedEntry.data, route.routeRef, discoveredAt);
    if (catalogEntry === undefined) continue;
    entries.push(catalogEntry);

    const entryPricing = toXaiPricing(parsedEntry.data);
    if (entryPricing !== undefined) {
      pricing.set(parsedEntry.data.id, entryPricing);
    }
  }

  return {
    entries: applyDeclaredCapabilities(entries, input.declaredCapabilities),
    pricing
  };
};

// ---------------------------------------------------------------------------------------------

type TransportDescription =
  | { readonly kind: "vercel_ai_gateway" | "openrouter" }
  | { readonly kind: "direct"; readonly protocol: string; readonly provider: string };

const describeTransport = (transport: TransportDescription): string =>
  transport.kind === "direct"
    ? `direct/${transport.protocol} (provider "${transport.provider}")`
    : transport.kind;
