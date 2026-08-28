import {
  ModelRouteSelectionSchema,
  type ModelRoute,
  type ModelRouteContext,
  type ModelRouteSelection
} from "@autostack/contracts";

import type { CatalogSnapshot } from "../catalog/catalog-cache.js";
import { filterByCapability, type CapabilityCandidate } from "../catalog/capability-filter.js";
import { capabilityUnavailable, routeDisabled } from "../failure/routing-failure.js";

/** One route paired with its already-resolved per-route catalog snapshot (pipeline stage 2's
 * output — discovery/staleness failures are raised by the catalog cache before this is reached). */
export interface SelectRouteCandidate {
  readonly route: ModelRoute;
  readonly snapshot: CatalogSnapshot;
}

export interface SelectRouteInput {
  readonly context: ModelRouteContext;
  /**
   * Already ordered per policy — the composition root (Task 7) applies pipeline stage 1
   * (allowedRouteRefs admission and ordering) before calling this function. This function
   * implements stages 3–5 and 7 over the given candidates: DEC-0 pinned-model capability
   * resolution, the enabled filter, and preferred-route selection with a `reason` naming the
   * catalog's freshness and discovery time.
   */
  readonly candidates: readonly SelectRouteCandidate[];
  readonly now: () => string;
}

/**
 * `noUncheckedIndexedAccess` types every index/`Map.get` read as possibly `undefined`, even where
 * a prior length check makes that unreachable. One shared guard — rather than one inline check per
 * call site — keeps that invariant expressed exactly once, so a genuinely unreachable state still
 * has no `as`/`!` escape hatch without multiplying untestable branches across the file.
 */
const assertDefined = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) {
    throw new TypeError(`Internal error: ${label} unexpectedly missing.`);
  }
  return value;
};

/**
 * Pipeline stages 3–5 and 7 (stage 1 policy admission and stage 6 budget are Task 7's). Raises
 * `capability_unavailable` when no candidate's pinned entry satisfies every required capability
 * (naming both the missing capabilities and, separately, any routes excluded for an absent pin —
 * DEC-0), and `route_disabled` when capable routes exist but every one of them is disabled,
 * attributing the first capable-but-disabled route.
 */
export const selectRoute = (input: SelectRouteInput): ModelRouteSelection => {
  const required = input.context.requiredCapabilities;

  const snapshotByRouteRef = new Map(
    input.candidates.map((candidate) => [candidate.route.routeRef, candidate.snapshot] as const)
  );

  const capabilityCandidates: CapabilityCandidate[] = input.candidates.map((candidate) => ({
    route: candidate.route,
    entries: candidate.snapshot.entries
  }));

  const { eligible, absentPinRouteRefs } = filterByCapability(capabilityCandidates, required);

  if (eligible.length === 0) {
    throw capabilityUnavailable({ required, absentPins: absentPinRouteRefs });
  }

  const enabled = eligible.filter((candidate) => candidate.route.enabled);
  if (enabled.length === 0) {
    const firstCapable = assertDefined(eligible[0], "the first capability-eligible candidate");
    throw routeDisabled({ routeRef: firstCapable.route.routeRef, required });
  }

  const chosen = assertDefined(enabled[0], "the first enabled candidate");
  const snapshot = assertDefined(
    snapshotByRouteRef.get(chosen.route.routeRef),
    `the catalog snapshot for route ${chosen.route.routeRef}`
  );

  return ModelRouteSelectionSchema.parse({
    schemaVersion: 1,
    idempotencyKey: input.context.idempotencyKey,
    routeRef: chosen.route.routeRef,
    reason: `Selected route ${chosen.route.routeRef} from a ${snapshot.freshness} catalog discovered at ${snapshot.discoveredAt}.`,
    selectedAt: input.now()
  });
};
