import type { CredentialRefId, ModelCatalogEntry, ModelRoute } from "@autostack/contracts";

/**
 * Resolves a `CredentialRefId` to its plaintext secret. Both legitimate credential call sites take
 * this rather than a value (the plan's architecture section) — the language-model factory (Task 10)
 * and catalog discovery (this module). A secret exists as a string only inside the call expression
 * that needs it, never assigned to a field, event, or serialized structure.
 */
export interface CredentialResolver {
  resolve(credentialRefId: CredentialRefId): Promise<string>;
}

/**
 * Pricing carried alongside a discovered catalog entry, keyed by `providerModel`.
 * `ModelCatalogEntrySchema` has no pricing field (the contract audit scoped it to the capability
 * declaration only), so cost-ceiling evaluation reads this router-local value instead. Absent for
 * providers that publish no pricing (OpenAI, Anthropic today).
 */
export interface RoutePricing {
  readonly inputUsdPerToken: number;
  readonly outputUsdPerToken: number;
}

export interface CatalogDiscoveryResult {
  readonly entries: readonly ModelCatalogEntry[];
  readonly pricing: ReadonlyMap<string, RoutePricing>;
}

export interface DiscoverCatalogInput {
  readonly route: ModelRoute;
  readonly credentials: CredentialResolver;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => string;
}

export type DiscoverCatalog = (input: DiscoverCatalogInput) => Promise<CatalogDiscoveryResult>;
