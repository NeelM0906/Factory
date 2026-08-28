export {
  budgetExceeded,
  capabilityUnavailable,
  coveredCodes,
  providerError,
  rateLimited,
  routeDisabled
} from "./failure/routing-failure.js";

export {
  classifyTransportResponse,
  type ClassifyTransportResponseInput
} from "./failure/http-classification.js";

export {
  createModelRouter,
  type DeclaredCapabilityMap,
  type ModelRouter,
  type ModelRouterDependencies
} from "./model-router.js";

export { createCredentialRefStore } from "./credential-ref-store.js";
export type { SecretProtector } from "./credential/secret-protector.js";

export {
  createCredentialResolver,
  type CredentialRefRegistry
} from "./credential/credential-resolver.js";

export type { CredentialResolver, RoutePricing } from "./catalog/catalog-types.js";

export type { ModelRouteEventSink } from "./fallback/route-event-sink.js";
export type { ModelUsageSink } from "./usage/usage-sink.js";
export type { ExactUsageSink } from "./usage/exact-usage-sink.js";

// Fallback orchestration and per-attempt usage normalization compose above `ModelInferencePort`
// (DEC-3, ESC-1) rather than living inside the router's DI surface, so this package exports the
// functions themselves as the composition kit a caller (Wave 2) wires up alongside the sink
// interfaces above.
export {
  runWithFallback,
  type ModelRouteTarget,
  type RunWithFallbackInput
} from "./fallback/fallback-runner.js";

export {
  normalizeUsage,
  type ModelUsageOutcome,
  type NormalizeUsageActual,
  type NormalizeUsageInput,
  type NormalizeUsageRequested,
  type ProviderReportedUsage
} from "./usage/normalize-usage.js";

export {
  assertWithinInvocationBudget,
  type AssertWithinInvocationBudgetInput,
  type TokenDemand
} from "./policy/budget.js";
