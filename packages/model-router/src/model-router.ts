import type {
  ModelInferencePort,
  ModelPolicy,
  ModelRoute,
  ModelRouteContext,
  ModelRouteSelection,
  ModelRouterPort
} from "@autostack/contracts";

import type { CredentialResolver } from "./catalog/catalog-types.js";
import { createCatalogCache } from "./catalog/catalog-cache.js";
import { discoverCatalog } from "./catalog/catalog-discovery.js";
import {
  createDeclaredCapabilities,
  type DeclaredCapabilitiesInput
} from "./catalog/declared-capabilities.js";
import { evaluatePolicy, type EvaluatePolicyCandidate } from "./policy/evaluate-policy.js";
import { createPolicyRegistry } from "./policy/policy-registry.js";
import { createRouteRegistry } from "./route-registry.js";
import { createModelInference } from "./transport/transport-client.js";
import type { ExactUsageSink } from "./usage/exact-usage-sink.js";

/**
 * Operator-declared capability overrides (DEC-1), keyed by `providerModel`. Re-exported under this
 * name because `ModelRouterDependencies.declaredCapabilities` is the package's public surface for
 * it; `declared-capabilities.ts`'s own `DeclaredCapabilitiesInput` is the same shape.
 */
export type DeclaredCapabilityMap = DeclaredCapabilitiesInput;

/**
 * Deliberately excludes `ModelRouteEventSink` and `ModelUsageSink`. Fallback orchestration
 * (`runWithFallback`, which records `ModelRouteFallback` activations) and per-attempt usage
 * recording (`normalizeUsage`, which records `ModelUsageRecord`s) compose **above**
 * `ModelInferencePort`, not inside it: the port executes one already-resolved route and owns
 * neither policy nor orchestration (DEC-3, ESC-1). Wiring those sinks into the router's DI surface
 * would pull that orchestration back below the port. The caller composes them directly against the
 * exported `runWithFallback` and `normalizeUsage`, using the still-exported `ModelRouteEventSink`
 * and `ModelUsageSink` interfaces from `src/index.ts` as its composition kit.
 */
export interface ModelRouterDependencies {
  readonly routes: readonly ModelRoute[];
  readonly policies: readonly ModelPolicy[];
  readonly credentials: CredentialResolver;
  readonly exactUsage: ExactUsageSink;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => string;
  /**
   * A monotonic millisecond clock (I4), distinct from `now`: `now` produces ISO timestamps for
   * `recordedAt`/`occurredAt`/`completedAt`, while `monotonicNowMs` produces the numeric
   * milliseconds `run()` measures `latencyMs` from. No default — required, supplied by
   * composition, never `Date.now()`.
   */
  readonly monotonicNowMs: () => number;
  readonly catalogTtlMs?: number;
  readonly maxStaleMs?: number;
  readonly declaredCapabilities?: DeclaredCapabilityMap;
}

/** The composed router: `ModelRouterPort` (resolve/getRoute/recordUsage) plus `ModelInferencePort`
 * (run) over the same object, exactly as `ModelRouterDependencies` wires them together. */
export interface ModelRouter extends ModelRouterPort, ModelInferencePort {}

/**
 * Composes `createModelRouter(deps)` from the already-built, already-approved stage modules —
 * route registry, policy registry, catalog cache/discovery, selection (via `evaluatePolicy`),
 * transport (`createModelInference`), and the injected `ExactUsageSink`. Contains no logic of its
 * own beyond wiring: every rejection-pipeline decision, filter, and failure code is owned by the
 * module that implements that stage (Tasks 2–11); this file only assembles them in the order the
 * rejection pipeline (the plan's single source of truth) specifies. Fallback and per-attempt usage
 * recording are not part of this wiring — see `ModelRouterDependencies` above.
 */
export const createModelRouter = (deps: ModelRouterDependencies): ModelRouter => {
  const routeRegistry = createRouteRegistry({
    routes: deps.routes,
    exactUsageSink: deps.exactUsage
  });
  const policyRegistry = createPolicyRegistry(deps.policies);

  const declaredCapabilities =
    deps.declaredCapabilities === undefined
      ? undefined
      : createDeclaredCapabilities(deps.declaredCapabilities);

  const catalogCache = createCatalogCache({
    discover: (input) =>
      discoverCatalog({
        ...input,
        ...(declaredCapabilities === undefined ? {} : { declaredCapabilities })
      }),
    now: deps.now,
    ...(deps.catalogTtlMs === undefined ? {} : { ttlMs: deps.catalogTtlMs }),
    ...(deps.maxStaleMs === undefined ? {} : { maxStaleMs: deps.maxStaleMs })
  });

  const inference = createModelInference({
    credentials: deps.credentials,
    fetch: deps.fetch,
    routes: routeRegistry,
    now: deps.now,
    monotonicNowMs: deps.monotonicNowMs
  });

  const resolve = async (context: ModelRouteContext): Promise<ModelRouteSelection> => {
    // Pipeline stage 1 (policy admission), first: a missing policy fails closed here, at the call
    // boundary, before any catalog resolution is attempted for any route.
    const policy = policyRegistry.getForStage(context.stage);

    const routesByRef = new Map(
      routeRegistry.list().map((route) => [route.routeRef, route] as const)
    );

    // Pipeline stage 2 reads "each SURVIVING route's snapshot" — surviving stage 1's
    // allowedRouteRefs admission. Catalog resolution therefore runs only for policy-admitted
    // routes, so an out-of-policy route's discovery can never fail a resolve it was never eligible
    // for.
    const candidates: EvaluatePolicyCandidate[] = [];
    for (const routeRef of policy.allowedRouteRefs) {
      const route = routesByRef.get(routeRef);
      if (route === undefined) continue;
      const snapshot = await catalogCache.read({
        route,
        credentials: deps.credentials,
        fetch: deps.fetch
      });
      candidates.push({ route, snapshot });
    }

    return evaluatePolicy({ context, candidates, policies: policyRegistry, now: deps.now });
  };

  const getRoute = async (routeRef: string): Promise<ModelRoute | undefined> =>
    routeRegistry.getRoute(routeRef);

  return {
    resolve,
    getRoute,
    recordUsage: routeRegistry.recordUsage,
    run: inference.run
  };
};
