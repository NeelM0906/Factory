import type { ModelCatalogEntry, ModelRoute } from "@autostack/contracts";

import { pinnedModel } from "../route-registry.js";

/**
 * One route paired with the full set of catalog entries its own provider discovery produced —
 * possibly several models, of which at most one has a `providerModel` equal to the route's pin.
 */
export interface CapabilityCandidate {
  readonly route: ModelRoute;
  readonly entries: readonly ModelCatalogEntry[];
}

export interface CapabilityFilterEligible {
  readonly route: ModelRoute;
  readonly entry: ModelCatalogEntry;
}

export interface CapabilityFilterResult {
  readonly eligible: readonly CapabilityFilterEligible[];
  /** routeRefs whose pinned model was absent from an otherwise successful discovery. */
  readonly absentPinRouteRefs: readonly string[];
}

/** Mirrors `packages/domain/src/testing/fake-model-router.ts`'s `declaredCapabilities`. */
const declaredCapabilities = (entry: ModelCatalogEntry): ReadonlySet<string> =>
  new Set<string>([...entry.inputModalities, ...entry.outputModalities, ...entry.features]);

/**
 * Pipeline stages 3+4 (DEC-0): a route's eligible capability set is the union of
 * `inputModalities`, `outputModalities`, and `features` of the SINGLE discovered entry whose
 * `providerModel` equals the route's pinned model — never a union across entries. A pin absent
 * from an otherwise successful discovery excludes the route with a reason distinct from a route
 * whose pinned entry simply does not declare every required capability.
 *
 * Reads only `ModelCatalogEntry` values — never a route's `displayName` or `transport` fields
 * (beyond `pinnedModel`, which identifies which entry to read, not what it declares).
 */
export const filterByCapability = (
  candidates: readonly CapabilityCandidate[],
  requiredCapabilities: readonly string[]
): CapabilityFilterResult => {
  const eligible: CapabilityFilterEligible[] = [];
  const absentPinRouteRefs: string[] = [];

  for (const candidate of candidates) {
    const pin = pinnedModel(candidate.route);
    const entry = candidate.entries.find((candidateEntry) => candidateEntry.providerModel === pin);

    if (entry === undefined) {
      absentPinRouteRefs.push(candidate.route.routeRef);
      continue;
    }

    const declared = declaredCapabilities(entry);
    const satisfiesAll = requiredCapabilities.every((capability) => declared.has(capability));
    if (satisfiesAll) {
      eligible.push({ route: candidate.route, entry });
    }
  }

  return { eligible, absentPinRouteRefs };
};
