import type { ModelRoute } from "@autostack/contracts";

import type { CatalogDiscoveryResult, DiscoverCatalogInput } from "./catalog-types.js";
import type { DeclaredCapabilities } from "./declared-capabilities.js";
import {
  discoverAnthropicCatalog,
  discoverOpenAiCatalog,
  discoverXaiCatalog
} from "./direct-catalog.js";
import { discoverGatewayCatalog } from "./gateway-catalog.js";
import { discoverOpenRouterCatalog } from "./openrouter-catalog.js";

/**
 * `DiscoverCatalogInput` plus the DEC-1 overlay `direct-catalog.ts` accepts. Optional, so this
 * type — and therefore `discoverCatalog` below — still conforms to `DiscoverCatalog` from
 * `catalog-types.ts` and can be used wherever that type is expected (e.g. as the `discover`
 * dependency of `createCatalogCache`).
 */
export interface DiscoverCatalogDispatchInput extends DiscoverCatalogInput {
  readonly declaredCapabilities?: DeclaredCapabilities;
}

/**
 * Dispatches a route's catalog discovery to the discoverer matching its transport, threading the
 * `CredentialResolver` through unchanged. Exhaustive over `ModelTransportSchema`'s discriminated
 * union (`vercel_ai_gateway`, `openrouter`, `direct`) with a `never`-typed default, so a future
 * transport kind is a compile error rather than a silent fallthrough — the same pattern
 * `route-registry.ts`'s `pinnedModel` uses for the same union.
 */
export const discoverCatalog = async (
  input: DiscoverCatalogDispatchInput
): Promise<CatalogDiscoveryResult> => {
  const { transport } = input.route;
  switch (transport.kind) {
    case "vercel_ai_gateway":
      return discoverGatewayCatalog(input);
    case "openrouter":
      return discoverOpenRouterCatalog(input);
    case "direct":
      return discoverDirectCatalog(input);
    default: {
      const exhaustive: never = transport;
      throw new TypeError(
        `Unsupported transport kind for route ${input.route.routeRef}: ${String((exhaustive as { kind?: unknown }).kind)}`
      );
    }
  }
};

/**
 * Sub-dispatches a `direct` route to one of the three provider parsers by `protocol`/`provider`
 * (the five existing discoverers, per the plan: gateway, openrouter, openai, anthropic, xai). A
 * `direct` route naming a protocol/provider combination none of them handles — e.g. the `google`
 * protocol `ModelTransportSchema` already admits but no discoverer yet implements — is a
 * composition-root configuration error, not a routing failure, so it throws a `TypeError` rather
 * than a `ModelRoutingError`, matching each individual discoverer's own wrong-route guard.
 */
export const discoverDirectCatalog = (
  input: DiscoverCatalogDispatchInput
): Promise<CatalogDiscoveryResult> => {
  const { transport } = input.route;
  if (transport.kind !== "direct") {
    throw new TypeError(
      `discoverDirectCatalog requires a direct route, got ${describeRouteTransportKind(input.route)}.`
    );
  }
  if (transport.protocol === "openai_compatible" && transport.provider === "openai") {
    return discoverOpenAiCatalog(input);
  }
  if (transport.protocol === "openai_compatible" && transport.provider === "xai") {
    return discoverXaiCatalog(input);
  }
  if (transport.protocol === "anthropic") {
    return discoverAnthropicCatalog(input);
  }
  throw new TypeError(
    `Unsupported direct provider for route ${input.route.routeRef}: protocol="${transport.protocol}" provider="${transport.provider}".`
  );
};

const describeRouteTransportKind = (route: ModelRoute): string => route.transport.kind;
