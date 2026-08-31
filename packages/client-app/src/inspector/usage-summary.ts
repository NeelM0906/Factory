import type { ModelCost, ModelTokenCount, ModelUsageRecord } from "@autostack/contracts";

/**
 * A token count ready to render: the reported integer, or `undefined` for a provider-unreported
 * value. `undefined` here means the same thing `InspectorSection` (Task 4a, `@autostack/ui`)
 * already means by it: that primitive renders `value === undefined` as the literal "Not recorded"
 * (spec §10.2). This derivation does not mint its own marker string — doing so would be a second
 * source of that text that could drift from the primitive's.
 */
export type UsageTokenDisplay = number | undefined;

/**
 * Display-ready usage figures derived from one `ModelUsageRecord`. Every field preserves the
 * `reported | unknown` discrimination of the source record — see `deriveUsageSummary`. `undefined`
 * fields are passed straight into `InspectorSection` rows by the consuming component; the "Not
 * recorded" rendering happens there, not here.
 */
export interface UsageSummary {
  readonly inputTokens: UsageTokenDisplay;
  readonly outputTokens: UsageTokenDisplay;
  readonly cachedInputTokens: UsageTokenDisplay;
  readonly reasoningTokens: UsageTokenDisplay;
  /** `formatCostMicros` output for a reported cost, or `undefined` for an unreported one. */
  readonly cost: string | undefined;
}

/**
 * Derives display-ready usage fields from a `ModelUsageRecord`. Pure — no React, no formatting
 * decisions deferred to the caller. `reported` values pass through verbatim (including `0`);
 * `unknown` values become `undefined` (spec §10.2), which `InspectorSection` renders as "Not
 * recorded".
 */
export function deriveUsageSummary(record: ModelUsageRecord): UsageSummary {
  return {
    inputTokens: deriveTokenDisplay(record.tokens.input),
    outputTokens: deriveTokenDisplay(record.tokens.output),
    cachedInputTokens: deriveTokenDisplay(record.tokens.cachedInput),
    reasoningTokens: deriveTokenDisplay(record.tokens.reasoning),
    cost: deriveCostDisplay(record.cost)
  };
}

function deriveTokenDisplay(count: ModelTokenCount): UsageTokenDisplay {
  return count.state === "reported" ? count.value : undefined;
}

function deriveCostDisplay(cost: ModelCost): string | undefined {
  return cost.state === "reported" ? formatCostMicros(cost.micros) : undefined;
}

/**
 * Formats USD micros as `$<dollars>.<six-digit micros>` via exact integer string manipulation —
 * deliberately not `toLocaleString`/`Intl.NumberFormat`, whose output differs across environments
 * and would break an exact-string test. `micros` is a nonnegative integer (schema-enforced), so no
 * sign or fractional handling is needed.
 */
function formatCostMicros(micros: number): string {
  const digits = micros.toString().padStart(7, "0");
  const dollars = digits.slice(0, -6);
  const microsPart = digits.slice(-6);
  return `$${dollars}.${microsPart}`;
}
