import type { ModelCatalogEntry, ModelPolicy, ModelRoute } from "@autostack/contracts";

import type { RoutePricing } from "../catalog/catalog-types.js";
import { budgetExceeded } from "../failure/routing-failure.js";

export type BudgetCeiling = "maxCostMicros" | "maxInputTokens" | "maxOutputTokens";

/** One capability+enabled-eligible candidate, carrying what pipeline stage 6 needs: the route's
 * pinned catalog entry (for its declared token ceilings) and its pricing, when known. */
export interface BudgetCandidate {
  readonly route: ModelRoute;
  readonly entry: ModelCatalogEntry;
  readonly pricing: RoutePricing | undefined;
}

export interface BudgetExclusion {
  readonly routeRef: string;
  readonly ceiling: BudgetCeiling;
}

export interface BudgetFilterResult {
  readonly eligible: readonly BudgetCandidate[];
  /** The first candidate excluded, in input order — used to attribute `budget_exceeded` when
   * every candidate is excluded and there is no more specific reason to report. */
  readonly firstExclusion: BudgetExclusion | undefined;
}

/**
 * A route's worst-case per-request cost bound, in USD micros: the tighter of the policy's own
 * ceiling and the route's declared catalog limit, for each direction. Neither this module nor
 * `ModelRouteContext` carries an actual token demand at resolve time (DEC-3), so the router can
 * only bound cost by the tightest limit it already knows — if a direction has no limit from either
 * source, cost cannot be bounded and the route fails closed exactly as DEC-2's "cannot prove the
 * ceiling holds" already requires for unknown pricing.
 */
const estimatedCostMicros = (
  candidate: BudgetCandidate,
  policy: ModelPolicy
): number | undefined => {
  if (candidate.pricing === undefined) return undefined;
  const inputBound = policy.maxInputTokens ?? candidate.entry.contextWindowTokens;
  const outputBound = policy.maxOutputTokens ?? candidate.entry.maxOutputTokens;
  if (inputBound === undefined || outputBound === undefined) return undefined;
  return Math.round(
    inputBound * candidate.pricing.inputUsdPerToken * 1_000_000 +
      outputBound * candidate.pricing.outputUsdPerToken * 1_000_000
  );
};

/**
 * Evaluates one candidate against the policy's resolve-time ceilings, returning the ceiling that
 * excludes it, or `undefined` if it survives all of them.
 *
 * - Token ceilings (DEC-3): a route whose pinned entry declares `maxOutputTokens` below
 *   `policy.maxOutputTokens`, or `contextWindowTokens` below `policy.maxInputTokens`, is ineligible;
 *   a route declaring neither, under a policy that sets the corresponding ceiling, is ineligible by
 *   the same fail-closed rule.
 * - Cost ceiling (DEC-2): pricing unknown fails closed unconditionally; pricing known but over the
 *   ceiling is ineligible; pricing known and under is eligible; no `maxCostMicros` set is unaffected
 *   by pricing state entirely.
 */
const evaluateCandidate = (
  candidate: BudgetCandidate,
  policy: ModelPolicy
): BudgetCeiling | undefined => {
  if (policy.maxOutputTokens !== undefined) {
    const declared = candidate.entry.maxOutputTokens;
    if (declared === undefined || declared < policy.maxOutputTokens) return "maxOutputTokens";
  }
  if (policy.maxInputTokens !== undefined) {
    const declared = candidate.entry.contextWindowTokens;
    if (declared === undefined || declared < policy.maxInputTokens) return "maxInputTokens";
  }
  if (policy.maxCostMicros !== undefined) {
    const estimated = estimatedCostMicros(candidate, policy);
    if (estimated === undefined || estimated > policy.maxCostMicros) return "maxCostMicros";
  }
  return undefined;
};

/** Pipeline stage 6, run over the capability+enabled survivors only (stage 5 runs before stage 6). */
export const filterByBudget = (
  candidates: readonly BudgetCandidate[],
  policy: ModelPolicy
): BudgetFilterResult => {
  const eligible: BudgetCandidate[] = [];
  let firstExclusion: BudgetExclusion | undefined;

  for (const candidate of candidates) {
    const ceiling = evaluateCandidate(candidate, policy);
    if (ceiling === undefined) {
      eligible.push(candidate);
    } else if (firstExclusion === undefined) {
      firstExclusion = { routeRef: candidate.route.routeRef, ceiling };
    }
  }

  return { eligible, firstExclusion };
};

export interface TokenDemand {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AssertWithinInvocationBudgetInput {
  readonly policy: ModelPolicy;
  readonly routeRef: string;
  readonly demand: TokenDemand;
}

/**
 * Invocation-time demand checks (DEC-3), raised before any provider call. Both directions: a stated
 * output demand above `policy.maxOutputTokens`, or a stated input demand above
 * `policy.maxInputTokens`, raises `budget_exceeded`, `retryable: false`.
 */
export const assertWithinInvocationBudget = (input: AssertWithinInvocationBudgetInput): void => {
  const { policy, routeRef, demand } = input;
  if (policy.maxOutputTokens !== undefined && demand.outputTokens > policy.maxOutputTokens) {
    throw budgetExceeded({ routeRef, ceiling: "maxOutputTokens" });
  }
  if (policy.maxInputTokens !== undefined && demand.inputTokens > policy.maxInputTokens) {
    throw budgetExceeded({ routeRef, ceiling: "maxInputTokens" });
  }
};
