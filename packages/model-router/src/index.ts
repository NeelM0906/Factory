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
