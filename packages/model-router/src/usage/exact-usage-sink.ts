import type { ModelUsage } from "@autostack/contracts";

/**
 * The injected target for `ModelRouterPort.recordUsage`'s flat, exact-numbers payload. Named
 * `ExactUsageSink` (not "legacy") because `ModelUsageSchema` remains valid for callers that
 * genuinely have exact numbers — the name describes its domain, not its age (finding 19).
 */
export interface ExactUsageSink {
  record(usage: ModelUsage): Promise<void>;
}
