import {
  ModelRouteSchema,
  ModelUsageSchema,
  type ModelRoute,
  type ModelUsage
} from "@autostack/contracts";

import type { ExactUsageSink } from "./usage/exact-usage-sink.js";

export type { ExactUsageSink } from "./usage/exact-usage-sink.js";

/** A route indexed for lookup and pinned-model resolution, with routes admitted immutably. */
export interface RouteRegistry {
  /** Every admitted route, in declaration order, including disabled ones. */
  list(): readonly ModelRoute[];
  getRoute(routeRef: string): ModelRoute | undefined;
  /**
   * The route's single pinned model, over an exhaustive switch on `transport.kind` with a
   * `never`-typed default so a future transport kind is a compile error (DEC-0).
   */
  pinnedModel(route: ModelRoute): string;
  /**
   * The port's flat exact-numbers surface: parses through `ModelUsageSchema` and forwards to the
   * injected `ExactUsageSink`. Rejection happens before the sink is touched, and the rejection
   * message carries no field values.
   */
  recordUsage(usage: ModelUsage): Promise<void>;
}

export interface CreateRouteRegistryOptions {
  readonly routes: readonly unknown[];
  readonly exactUsageSink: ExactUsageSink;
}

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

export const pinnedModel = (route: ModelRoute): string => {
  const transport = route.transport;
  switch (transport.kind) {
    case "vercel_ai_gateway":
      return transport.gatewayModel;
    case "openrouter":
      return transport.openRouterModel;
    case "direct":
      return transport.providerModel;
    default: {
      const exhaustive: never = transport;
      throw new TypeError(
        `Unknown transport kind for route ${route.routeRef}: ${String((exhaustive as { kind?: unknown }).kind)}`
      );
    }
  }
};

/**
 * Admits routes through `ModelRouteSchema.parse`, deep-freezes them, and indexes them by
 * `routeRef`. Immutable: no accessor ever mutates an admitted route, and every accessor returns a
 * copy or a frozen value.
 */
export const createRouteRegistry = (options: CreateRouteRegistryOptions): RouteRegistry => {
  const seenRefs = new Set<string>();
  const routes: ModelRoute[] = options.routes.map((raw, index) => {
    const result = ModelRouteSchema.safeParse(raw);
    if (!result.success) {
      throw new TypeError(`Route at index ${index} failed validation.`);
    }
    if (seenRefs.has(result.data.routeRef)) {
      throw new TypeError(`Route at index ${index} duplicates routeRef "${result.data.routeRef}".`);
    }
    seenRefs.add(result.data.routeRef);
    return deepFreeze(result.data);
  });

  const frozenRoutes = Object.freeze(routes);
  const byRef = new Map(frozenRoutes.map((route) => [route.routeRef, route] as const));

  return {
    list: () => frozenRoutes,
    getRoute: (routeRef: string) => byRef.get(routeRef),
    pinnedModel,
    recordUsage: async (usage: ModelUsage) => {
      const result = ModelUsageSchema.safeParse(usage);
      if (!result.success) {
        throw new TypeError("Usage payload failed validation.");
      }
      await options.exactUsageSink.record(result.data);
    }
  };
};
