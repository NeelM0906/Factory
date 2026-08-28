import type { ModelPolicy, ModelRouteContext, ModelRouteSelection } from "@autostack/contracts";

import { filterByCapability, type CapabilityCandidate } from "../catalog/capability-filter.js";
import { budgetExceeded } from "../failure/routing-failure.js";
import { selectRoute, type SelectRouteCandidate } from "../selection/select-route.js";
import { filterByBudget, type BudgetCandidate } from "./budget.js";
import { assertPolicyStage, type PolicyRegistry } from "./policy-registry.js";

/**
 * `noUncheckedIndexedAccess` types every index read as possibly `undefined`, even where a prior
 * length check makes that unreachable. Mirrors `selectRoute`'s own `assertDefined` guard (same
 * file-local pattern, kept local here too rather than shared, since each call site's "impossible"
 * case is specific to its own invariant).
 */
const assertDefined = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) {
    throw new TypeError(`Internal error: ${label} unexpectedly missing.`);
  }
  return value;
};

/** One registered route paired with its already-resolved catalog snapshot (pipeline stage 2's
 * output) — the same shape `selectRoute` itself takes, since this is the pool it is called over. */
export type EvaluatePolicyCandidate = SelectRouteCandidate;

export interface EvaluatePolicyInput {
  readonly context: ModelRouteContext;
  /** Every registered route resolvable for this call, unfiltered by policy — stage 1's admission
   * (allowedRouteRefs) is applied inside this function, first. */
  readonly candidates: readonly EvaluatePolicyCandidate[];
  readonly policies: PolicyRegistry;
  readonly now: () => string;
}

/**
 * The effective required-capability set for pipeline stage 4: `context.requiredCapabilities` plus,
 * when `policy.reasoningLevel` is anything other than `none`, the derived `reasoning` feature. A
 * route lacking it is excluded at the capability stage like any other missing capability — there is
 * no separate taxonomy code for a reasoning shortfall.
 */
const effectiveRequiredCapabilities = (
  context: ModelRouteContext,
  policy: ModelPolicy
): string[] =>
  policy.reasoningLevel !== undefined && policy.reasoningLevel !== "none"
    ? [...context.requiredCapabilities, "reasoning"]
    : [...context.requiredCapabilities];

/** Routes admitted by `policy.allowedRouteRefs`, in that array's order — pipeline stage 1's second
 * half. A route absent from the policy is gone before the capability filter ever runs, so it can
 * never be the reason a station reads `capability_unavailable`; this ordering also implements
 * pipeline stage 7's "preferred route is the first surviving allowedRouteRefs entry". */
const admitByPolicy = (
  candidates: readonly EvaluatePolicyCandidate[],
  policy: ModelPolicy
): readonly EvaluatePolicyCandidate[] => {
  const byRouteRef = new Map(
    candidates.map((candidate) => [candidate.route.routeRef, candidate] as const)
  );
  const admitted: EvaluatePolicyCandidate[] = [];
  for (const routeRef of policy.allowedRouteRefs) {
    const candidate = byRouteRef.get(routeRef);
    if (candidate !== undefined) admitted.push(candidate);
  }
  return admitted;
};

const withRequiredCapabilities = (
  context: ModelRouteContext,
  requiredCapabilities: string[]
): ModelRouteContext => ({
  ...context,
  requiredCapabilities
});

/**
 * Runs the full rejection pipeline for one resolve call: stage 1 (policy admission, both halves),
 * then delegates stages 3–5 and 7 to `selectRoute` unmodified, with stage 6 (budget) slotted in
 * between the enabled filter and the final pick. Per the pipeline's attribution rule, the raised
 * code is owned by whichever stage empties the candidate set — the enabled filter (stage 5) removing
 * some-but-not-all candidates contributes nothing to the failure, so a route excluded there never
 * displaces a `budget_exceeded` that stage 6 goes on to raise.
 */
export const evaluatePolicy = (input: EvaluatePolicyInput): ModelRouteSelection => {
  const policy = input.policies.getForStage(input.context.stage);
  assertPolicyStage(policy, input.context.stage);

  const admitted = admitByPolicy(input.candidates, policy);
  const requiredCapabilities = effectiveRequiredCapabilities(input.context, policy);
  const effectiveContext = withRequiredCapabilities(input.context, requiredCapabilities);

  const capabilityCandidates: CapabilityCandidate[] = admitted.map((candidate) => ({
    route: candidate.route,
    entries: candidate.snapshot.entries
  }));
  const { eligible: capable } = filterByCapability(capabilityCandidates, requiredCapabilities);

  const enabledCapable = capable.filter((candidate) => candidate.route.enabled);

  if (capable.length === 0 || enabledCapable.length === 0) {
    // Let selectRoute raise capability_unavailable or route_disabled itself, over the identical
    // stage-1-admitted candidate set, so the message text has exactly one source of truth.
    return selectRoute({ context: effectiveContext, candidates: admitted, now: input.now });
  }

  const snapshotByRouteRef = new Map(
    admitted.map((candidate) => [candidate.route.routeRef, candidate.snapshot] as const)
  );
  const budgetCandidates: BudgetCandidate[] = enabledCapable.map((candidate) => ({
    route: candidate.route,
    entry: candidate.entry,
    pricing: snapshotByRouteRef
      .get(candidate.route.routeRef)
      ?.pricing.get(candidate.entry.providerModel)
  }));
  const { eligible: affordable, firstExclusion } = filterByBudget(budgetCandidates, policy);

  if (affordable.length === 0) {
    // Budget (stage 6) empties the set here: any capable-but-disabled route was already removed by
    // the enabled filter (stage 5) while a capable-and-enabled candidate still survived, so stage 5
    // contributed nothing to this failure. Per the attribution rule, the code belongs to the stage
    // that empties the set — the last elimination, never the most sympathetic one.
    // `filterByBudget` only returns an empty `eligible` set alongside a defined `firstExclusion` —
    // `budgetCandidates` here is non-empty (guarded by the `enabledCapable.length === 0` return
    // above), so at least one candidate was excluded and recorded it.
    const exclusion = assertDefined(firstExclusion, "the excluding budget ceiling");
    throw budgetExceeded({ routeRef: exclusion.routeRef, ceiling: exclusion.ceiling });
  }

  const affordableRouteRefs = new Set(affordable.map((candidate) => candidate.route.routeRef));
  const finalCandidates: SelectRouteCandidate[] = admitted.filter((candidate) =>
    affordableRouteRefs.has(candidate.route.routeRef)
  );

  return selectRoute({ context: effectiveContext, candidates: finalCandidates, now: input.now });
};
