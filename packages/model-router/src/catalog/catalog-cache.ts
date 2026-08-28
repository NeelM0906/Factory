import type { ModelCatalogEntry, ModelRoute } from "@autostack/contracts";

import { providerError } from "../failure/routing-failure.js";
import type { CredentialResolver, DiscoverCatalog, RoutePricing } from "./catalog-types.js";

/** DEC-5: 15 minutes — short enough that a newly enabled model appears within a working session,
 * long enough that a burst of resolutions within it costs one discovery. */
export const DEFAULT_CATALOG_TTL_MS = 900_000;

/** DEC-5: 24 hours — a provider outage should not stop work for a day, but capability claims
 * older than a day have no business deciding routing. */
export const DEFAULT_CATALOG_MAX_STALE_MS = 86_400_000;

export type CatalogFreshness = "fresh" | "stale";

/**
 * A router-local, per-route discovery result with explicit freshness. `ModelCatalogEntrySchema`
 * has no pricing field (the contract audit scoped it to the capability declaration only), so
 * `pricing` travels alongside `entries` for cost-ceiling evaluation (finding 16 / DEC-5's
 * architecture note).
 */
export interface CatalogSnapshot {
  readonly freshness: CatalogFreshness;
  readonly entries: readonly ModelCatalogEntry[];
  readonly pricing: ReadonlyMap<string, RoutePricing>;
  readonly discoveredAt: string;
}

export interface CatalogCacheReadInput {
  readonly route: ModelRoute;
  readonly credentials: CredentialResolver;
  readonly fetch: typeof globalThis.fetch;
}

export interface CatalogCache {
  read(input: CatalogCacheReadInput): Promise<CatalogSnapshot>;
}

export interface CreateCatalogCacheOptions {
  readonly discover: DiscoverCatalog;
  readonly now: () => string;
  readonly ttlMs?: number;
  readonly maxStaleMs?: number;
}

/** What is actually cached per route — the discovery result plus the clock reading it was taken at. */
interface CachedCatalog {
  readonly entries: readonly ModelCatalogEntry[];
  readonly pricing: ReadonlyMap<string, RoutePricing>;
  readonly discoveredAt: string;
}

/** Always a fresh array/map copy, so a caller mutating a returned snapshot can never reach — or
 * be reached by — the next read (the cache's own immutability invariant). */
const toSnapshot = (cached: CachedCatalog, freshness: CatalogFreshness): CatalogSnapshot => ({
  freshness,
  entries: cached.entries.slice(),
  pricing: new Map(cached.pricing),
  discoveredAt: cached.discoveredAt
});

/**
 * Caches per-route catalog discovery results, keyed by `route.routeRef` (DEC-5) — never by
 * provider — so two routes that share a provider but differ in `credentialRefId` can never share
 * a snapshot: one route's authorization must never determine another's visible catalog.
 *
 * A read inside `ttlMs` of the last successful discovery is served from cache with no `fetch` and
 * no credential resolution. A read after `ttlMs` rediscovers. On rediscovery failure: a cached
 * snapshot no older than `maxStaleMs` is served as `"stale"` rather than raising — a provider
 * outage degrades, it does not block; a cached snapshot older than `maxStaleMs`, or a rediscovery
 * failure with no cached snapshot at all, raises instead of being served — routing on capability
 * claims of unbounded age is a fail-open this cache declines.
 *
 * Concurrent reads during one in-flight discovery for the same route share a single request
 * (single-flight): the first caller registers the in-flight promise synchronously, before any
 * `await`, so a second `read()` issued before the first settles finds and awaits that same
 * promise rather than starting a second discovery.
 */
export const createCatalogCache = (options: CreateCatalogCacheOptions): CatalogCache => {
  const { discover, now } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_CATALOG_MAX_STALE_MS;

  const store = new Map<string, CachedCatalog>();
  const inFlight = new Map<string, Promise<CachedCatalog>>();

  const startDiscovery = (input: CatalogCacheReadInput): Promise<CachedCatalog> => {
    const key = input.route.routeRef;
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    const discoveryPromise = (async (): Promise<CachedCatalog> => {
      const discoveredAt = now();
      const result = await discover({
        route: input.route,
        credentials: input.credentials,
        fetch: input.fetch,
        now
      });
      const cached: CachedCatalog = {
        entries: result.entries.slice(),
        pricing: new Map(result.pricing),
        discoveredAt
      };
      store.set(key, cached);
      return cached;
    })();

    inFlight.set(key, discoveryPromise);
    // Cleanup only; the settlement itself (success or failure) is observed by each awaiting
    // caller off `discoveryPromise` directly, never off this derived chain.
    discoveryPromise.then(
      () => inFlight.delete(key),
      () => inFlight.delete(key)
    );

    return discoveryPromise;
  };

  const read = async (input: CatalogCacheReadInput): Promise<CatalogSnapshot> => {
    const key = input.route.routeRef;
    const cached = store.get(key);
    const nowMs = Date.parse(now());

    if (cached !== undefined && nowMs - Date.parse(cached.discoveredAt) < ttlMs) {
      return toSnapshot(cached, "fresh");
    }

    try {
      const fresh = await startDiscovery(input);
      return toSnapshot(fresh, "fresh");
    } catch (error) {
      if (cached !== undefined) {
        const ageMs = nowMs - Date.parse(cached.discoveredAt);
        if (ageMs <= maxStaleMs) {
          return toSnapshot(cached, "stale");
        }
        throw providerError({ routeRef: input.route.routeRef, retryable: true });
      }
      throw error;
    }
  };

  return { read };
};
