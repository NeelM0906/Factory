import type { ModelUsageRecord } from "@autostack/contracts";

/**
 * The injected target for per-attempt normalized usage records produced by `normalizeUsage`
 * (`src/usage/normalize-usage.ts`). Deliberately distinct from `ExactUsageSink`
 * (`src/usage/exact-usage-sink.ts`), which receives the flat, exact-numbers `ModelUsageSchema`
 * payload `ModelRouterPort.recordUsage` takes. `ModelUsageRecord` cannot travel through that port
 * because `ModelUsageSchema` has no way to express "unknown" (finding 19) — these are deliberately
 * two different sinks, not a duplicate of one.
 */
export interface ModelUsageSink {
  record(usage: ModelUsageRecord): Promise<void>;
}
