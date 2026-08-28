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

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * OpenRouter's documented model-list shape, hand-authored per ESC-3 (no live network in the gate
 * suite): `data[].id`, `.name`, `.context_length`, `.architecture.input_modalities`,
 * `.architecture.output_modalities`, `.supported_parameters`, `.top_provider.max_completion_tokens`,
 * `.pricing.prompt` / `.pricing.completion`. Every object schema is `.strict()` — a provider payload
 * is untrusted input (spec §14.1).
 */
const OpenRouterArchitectureSchema = z
  .object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string())
  })
  .strict();

const OpenRouterTopProviderSchema = z
  .object({
    max_completion_tokens: z.number().int().positive().nullable().optional()
  })
  .strict();

const OpenRouterPricingSchema = z
  .object({
    prompt: z.string(),
    completion: z.string()
  })
  .strict();

const OpenRouterModelEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    context_length: z.number().int().positive().optional(),
    architecture: OpenRouterArchitectureSchema,
    supported_parameters: z.array(z.string()).default([]),
    top_provider: OpenRouterTopProviderSchema.optional(),
    pricing: OpenRouterPricingSchema.optional()
  })
  .strict();

const OpenRouterModelListEnvelopeSchema = z
  .object({
    data: z.array(z.unknown())
  })
  .strict();

type OpenRouterModelEntry = z.infer<typeof OpenRouterModelEntrySchema>;

/** OpenRouter's modality strings already match `MODEL_MODALITIES`; unmapped values are dropped. */
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

/**
 * OpenRouter's `supported_parameters` vocabulary translated into `MODEL_FEATURES`. Only the
 * parameters that name a genuine model capability are mapped; sampling controls (`temperature`,
 * `top_p`, `top_k`, `seed`, …) are request-shaping knobs, not capabilities, and are dropped like any
 * other unmapped value.
 */
const FEATURE_MAP: Readonly<Record<string, ModelFeature>> = {
  tools: "tool_call",
  reasoning: "reasoning"
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
 * Returns `undefined` when neither modality array survives mapping — an entry with no honest
 * capability to report is dropped rather than defaulted, the same fail-closed rule the Gateway
 * parser applies (ESC-3).
 */
const toCatalogEntry = (
  entry: OpenRouterModelEntry,
  routeRef: string,
  discoveredAt: string
): ModelCatalogEntry | undefined => {
  const inputModalities = mapModalities(entry.architecture.input_modalities);
  const outputModalities = mapModalities(entry.architecture.output_modalities);
  if (inputModalities.length === 0 || outputModalities.length === 0) return undefined;
  const features = mapFeatures(entry.supported_parameters);

  const maxOutputTokens = entry.top_provider?.max_completion_tokens;

  return ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef,
    providerModel: entry.id,
    displayName: entry.name,
    inputModalities,
    outputModalities,
    features,
    ...(entry.context_length === undefined ? {} : { contextWindowTokens: entry.context_length }),
    ...(maxOutputTokens === undefined || maxOutputTokens === null ? {} : { maxOutputTokens }),
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

const toPricing = (entry: OpenRouterModelEntry): RoutePricing | undefined => {
  if (entry.pricing === undefined) return undefined;
  const inputUsdPerToken = parsePrice(entry.pricing.prompt);
  const outputUsdPerToken = parsePrice(entry.pricing.completion);
  if (inputUsdPerToken === undefined || outputUsdPerToken === undefined) return undefined;
  return { inputUsdPerToken, outputUsdPerToken };
};

/**
 * Discovers the OpenRouter catalog, authenticated by the route's credential — the second legitimate
 * credential call site (catalog discovery), alongside the language-model factory (Task 10). The
 * secret is resolved once and used only to build the `Authorization` header; it is never assigned to
 * a field that outlives this call.
 */
export const discoverOpenRouterCatalog = async (
  input: DiscoverCatalogInput
): Promise<CatalogDiscoveryResult> => {
  const { route, credentials, fetch, now } = input;
  if (route.transport.kind !== "openrouter") {
    throw new TypeError(
      `discoverOpenRouterCatalog requires an openrouter route, got ${route.transport.kind}.`
    );
  }

  const secret = await credentials.resolve(route.transport.credentialRefId);

  let response: Response;
  try {
    response = await fetch(OPENROUTER_MODELS_URL, {
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

  const envelope = OpenRouterModelListEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw providerError({ routeRef: route.routeRef, retryable: true });
  }

  const discoveredAt = now();
  const entries: ModelCatalogEntry[] = [];
  const pricing = new Map<string, RoutePricing>();
  const seenProviderModels = new Set<string>();

  for (const rawEntry of envelope.data.data) {
    const parsedEntry = OpenRouterModelEntrySchema.safeParse(rawEntry);
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
