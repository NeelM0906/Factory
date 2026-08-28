import { z } from "zod";

import {
  MODEL_FEATURES,
  MODEL_MODALITIES,
  ModelCatalogEntrySchema,
  type ModelCatalogEntry,
  type ModelFeature,
  type ModelModality
} from "@autostack/contracts";

import { providerError } from "../failure/routing-failure.js";
import { classifyTransportResponse } from "../failure/http-classification.js";
import type {
  CatalogDiscoveryResult,
  DiscoverCatalogInput,
  RoutePricing
} from "./catalog-types.js";

export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

/**
 * Vercel AI Gateway's published model-list shape, hand-authored per ESC-3 (no live network in the
 * gate suite). Every object schema is `.strict()` — a provider payload is untrusted input
 * (spec §14.1) — so an envelope Gateway did not actually publish fails closed instead of being
 * guessed at.
 */
const GatewayModalitySchema = z
  .object({
    input: z.array(z.string()).min(1),
    output: z.array(z.string()).min(1)
  })
  .strict();

const GatewayPricingSchema = z
  .object({
    input: z.string(),
    output: z.string()
  })
  .strict();

const GatewayModelEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    modality: GatewayModalitySchema,
    capabilities: z.array(z.string()).default([]),
    context_window: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    pricing: GatewayPricingSchema.optional()
  })
  .strict();

const GatewayModelListEnvelopeSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(z.unknown())
  })
  .strict();

type GatewayModelEntry = z.infer<typeof GatewayModelEntrySchema>;

/** Gateway's modality strings already match `MODEL_MODALITIES`; unmapped values are dropped. */
const MODALITY_VOCABULARY = new Set<string>(MODEL_MODALITIES);
const mapModalities = (values: readonly string[]): ModelModality[] => {
  const mapped = new Set<ModelModality>();
  for (const value of values) {
    if (MODALITY_VOCABULARY.has(value)) {
      mapped.add(value as ModelModality);
    }
  }
  return Array.from(mapped);
};

/** Gateway's capability vocabulary translated into `MODEL_FEATURES`; unmapped values are dropped. */
const FEATURE_MAP: Readonly<Record<string, ModelFeature>> = {
  tool_calling: "tool_call",
  structured_outputs: "structured_output",
  streaming: "streaming",
  reasoning: "reasoning",
  prompt_caching: "prompt_caching"
};
const mapFeatures = (values: readonly string[]): ModelFeature[] => {
  const mapped = new Set<ModelFeature>();
  for (const value of values) {
    const feature = FEATURE_MAP[value];
    if (feature !== undefined && (MODEL_FEATURES as readonly string[]).includes(feature)) {
      mapped.add(feature);
    }
  }
  return Array.from(mapped);
};

/**
 * Returns `undefined` when neither modality array survives mapping — an entry whose every declared
 * modality is outside `MODEL_MODALITIES` has no honest capability to report, and inventing one
 * (e.g. defaulting to `["text"]`) would be exactly the guessed capability set ESC-3 forbids. Such an
 * entry is dropped like any other entry that fails to parse.
 */
const toCatalogEntry = (
  entry: GatewayModelEntry,
  routeRef: string,
  discoveredAt: string
): ModelCatalogEntry | undefined => {
  const inputModalities = mapModalities(entry.modality.input);
  const outputModalities = mapModalities(entry.modality.output);
  if (inputModalities.length === 0 || outputModalities.length === 0) return undefined;
  const features = mapFeatures(entry.capabilities);

  return ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef,
    providerModel: entry.id,
    displayName: entry.name,
    inputModalities,
    outputModalities,
    features,
    ...(entry.context_window === undefined ? {} : { contextWindowTokens: entry.context_window }),
    ...(entry.max_tokens === undefined ? {} : { maxOutputTokens: entry.max_tokens }),
    discoveredAt
  });
};

/** Admits a price only if it is a well-formed, finite, non-negative numeric string (C1): a
 * provider price string is untrusted input (spec §14.1), and a bare `Number()` turns junk like
 * `"free"` or `"N/A"` into `NaN` and an empty (or whitespace-only) string into `0` — both of which
 * would read as affordable under `maxCostMicros` instead of failing closed. */
const parsePrice = (raw: string): number | undefined => {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
};

const toPricing = (entry: GatewayModelEntry): RoutePricing | undefined => {
  if (entry.pricing === undefined) return undefined;
  const inputUsdPerToken = parsePrice(entry.pricing.input);
  const outputUsdPerToken = parsePrice(entry.pricing.output);
  if (inputUsdPerToken === undefined || outputUsdPerToken === undefined) return undefined;
  return { inputUsdPerToken, outputUsdPerToken };
};

/**
 * Discovers the Vercel AI Gateway catalog, authenticated by the route's credential — this is the
 * second legitimate credential call site (catalog discovery), alongside the language-model factory
 * (Task 10). The secret is resolved once and used only to build the `Authorization` header; it is
 * never assigned to a field that outlives this call.
 */
export const discoverGatewayCatalog = async (
  input: DiscoverCatalogInput
): Promise<CatalogDiscoveryResult> => {
  const { route, credentials, fetch, now } = input;
  if (route.transport.kind !== "vercel_ai_gateway") {
    throw new TypeError(
      `discoverGatewayCatalog requires a vercel_ai_gateway route, got ${route.transport.kind}.`
    );
  }

  const secret = await credentials.resolve(route.transport.credentialRefId);

  let response: Response;
  try {
    response = await fetch(GATEWAY_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` }
    });
  } catch (networkError) {
    throw classifyTransportResponse({ routeRef: route.routeRef, networkError });
  }

  if (!response.ok) {
    throw classifyTransportResponse({
      routeRef: route.routeRef,
      status: response.status,
      headers: response.headers
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw classifyTransportResponse({
      routeRef: route.routeRef,
      status: response.status,
      headers: response.headers,
      malformedBody: true
    });
  }

  const envelope = GatewayModelListEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw providerError({ routeRef: route.routeRef, retryable: true });
  }

  const discoveredAt = now();
  const entries: ModelCatalogEntry[] = [];
  const pricing = new Map<string, RoutePricing>();
  const seenProviderModels = new Set<string>();

  for (const rawEntry of envelope.data.data) {
    const parsedEntry = GatewayModelEntrySchema.safeParse(rawEntry);
    if (!parsedEntry.success) continue;
    if (seenProviderModels.has(parsedEntry.data.id)) continue;
    seenProviderModels.add(parsedEntry.data.id);

    const catalogEntry = toCatalogEntry(parsedEntry.data, route.routeRef, discoveredAt);
    if (catalogEntry === undefined) continue;
    entries.push(catalogEntry);

    const entryPricing = toPricing(parsedEntry.data);
    if (entryPricing !== undefined) {
      pricing.set(parsedEntry.data.id, entryPricing);
    }
  }

  return { entries, pricing };
};
