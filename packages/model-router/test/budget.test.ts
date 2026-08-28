import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelRoutingError,
  type ModelCatalogEntry,
  type ModelPolicy,
  type ModelRoute
} from "@autostack/contracts";

import {
  assertWithinInvocationBudget,
  filterByBudget,
  type BudgetCandidate
} from "../src/policy/budget.js";
import type { RoutePricing } from "../src/catalog/catalog-types.js";

const credentialRefId = CredentialRefIdSchema.parse("cred_aaaaaaaa-e89b-42d3-a456-426614174000");
const discoveredAt = "2026-08-27T00:00:00.000Z";

const buildRoute = (overrides: Partial<ModelRoute> & { routeRef: string }): ModelRoute => ({
  schemaVersion: 1,
  displayName: overrides.displayName ?? `Route ${overrides.routeRef}`,
  transport: overrides.transport ?? {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    providerModel: `${overrides.routeRef}.model`,
    credentialRefId
  },
  enabled: overrides.enabled ?? true,
  routeRef: overrides.routeRef
});

const buildEntry = (
  route: ModelRoute,
  overrides: Partial<ModelCatalogEntry> = {}
): ModelCatalogEntry => {
  const providerModel =
    overrides.providerModel ??
    (route.transport.kind === "direct" ? route.transport.providerModel : `${route.routeRef}.model`);
  return {
    schemaVersion: 1,
    routeRef: route.routeRef,
    providerModel,
    displayName: overrides.displayName ?? `${route.routeRef} model`,
    inputModalities: overrides.inputModalities ?? ["text"],
    outputModalities: overrides.outputModalities ?? ["text"],
    features: overrides.features ?? [],
    contextWindowTokens: overrides.contextWindowTokens,
    maxOutputTokens: overrides.maxOutputTokens,
    discoveredAt: overrides.discoveredAt ?? discoveredAt
  };
};

const buildCandidate = (
  route: ModelRoute,
  entryOverrides: Partial<ModelCatalogEntry> = {},
  pricing: RoutePricing | undefined = undefined
): BudgetCandidate => ({
  route,
  entry: buildEntry(route, entryOverrides),
  pricing
});

const buildPolicy = (overrides: Partial<ModelPolicy> = {}): ModelPolicy => ({
  schemaVersion: 1,
  policyRef: overrides.policyRef ?? "policy.implement",
  stage: overrides.stage ?? "implement",
  allowedRouteRefs: overrides.allowedRouteRefs ?? ["route.a"],
  fallbackRouteRefs: overrides.fallbackRouteRefs ?? [],
  maxInputTokens: overrides.maxInputTokens,
  maxOutputTokens: overrides.maxOutputTokens,
  maxCostMicros: overrides.maxCostMicros,
  reasoningLevel: overrides.reasoningLevel
});

const cheapPricing: RoutePricing = { inputUsdPerToken: 0.000_001, outputUsdPerToken: 0.000_002 };
const expensivePricing: RoutePricing = { inputUsdPerToken: 1, outputUsdPerToken: 1 };

describe("filterByBudget — cost ceiling (DEC-2)", () => {
  it("keeps a route eligible when maxCostMicros is set, pricing is known, and the estimate is under the ceiling", () => {
    const route = buildRoute({ routeRef: "route.cheap" });
    const candidate = buildCandidate(
      route,
      { contextWindowTokens: 1_000, maxOutputTokens: 1_000 },
      cheapPricing
    );
    const policy = buildPolicy({
      allowedRouteRefs: [route.routeRef],
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxCostMicros: 1_000_000
    });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible.map((c) => c.route.routeRef)).toEqual([route.routeRef]);
    expect(result.firstExclusion).toBeUndefined();
  });

  it("excludes a route when maxCostMicros is set, pricing is known, and the estimate is over the ceiling; all-over reports budget_exceeded, non-retryable", () => {
    const route = buildRoute({ routeRef: "route.expensive" });
    const candidate = buildCandidate(
      route,
      { contextWindowTokens: 1_000, maxOutputTokens: 1_000 },
      expensivePricing
    );
    const policy = buildPolicy({
      allowedRouteRefs: [route.routeRef],
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxCostMicros: 1
    });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible).toHaveLength(0);
    expect(result.eligible.map((c) => c.route.routeRef)).not.toContain(route.routeRef);
    expect(result.firstExclusion).toEqual({ routeRef: route.routeRef, ceiling: "maxCostMicros" });
  });

  it("fails closed (ineligible) when pricing is unknown, regardless of amount; all-unknown reports budget_exceeded", () => {
    const route = buildRoute({ routeRef: "route.unpriced" });
    const candidate = buildCandidate(
      route,
      { contextWindowTokens: 1_000, maxOutputTokens: 1_000 },
      undefined
    );
    const policy = buildPolicy({
      allowedRouteRefs: [route.routeRef],
      maxCostMicros: 1_000_000_000
    });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible).toHaveLength(0);
    expect(result.firstExclusion).toEqual({ routeRef: route.routeRef, ceiling: "maxCostMicros" });
  });

  it("is unaffected by unknown pricing when maxCostMicros is unset — a policy with no ceiling is not constrained by one", () => {
    const route = buildRoute({ routeRef: "route.unpriced-unconstrained" });
    const candidate = buildCandidate(route, {}, undefined);
    const policy = buildPolicy({ allowedRouteRefs: [route.routeRef] });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible.map((c) => c.route.routeRef)).toEqual([route.routeRef]);
  });

  it("fails closed when pricing is known but neither the policy nor the route bounds the token count needed to estimate cost", () => {
    const route = buildRoute({ routeRef: "route.unbounded" });
    // No policy maxInputTokens/maxOutputTokens AND no route-declared contextWindowTokens/
    // maxOutputTokens: the cost cannot be bounded from any source, so it fails closed exactly as
    // unknown pricing does — the ceiling cannot be proven to hold.
    const candidate = buildCandidate(
      route,
      { contextWindowTokens: undefined, maxOutputTokens: undefined },
      cheapPricing
    );
    const policy = buildPolicy({
      allowedRouteRefs: [route.routeRef],
      maxCostMicros: 1_000_000_000
    });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible).toHaveLength(0);
    expect(result.firstExclusion).toEqual({ routeRef: route.routeRef, ceiling: "maxCostMicros" });
  });

  it("attributes budget_exceeded to the FIRST excluded candidate, in input order, when several are over the ceiling", () => {
    const routeFirst = buildRoute({ routeRef: "route.first-over" });
    const routeSecond = buildRoute({ routeRef: "route.second-over" });
    const candidateFirst = buildCandidate(
      routeFirst,
      { contextWindowTokens: 1_000, maxOutputTokens: 1_000 },
      expensivePricing
    );
    const candidateSecond = buildCandidate(
      routeSecond,
      { contextWindowTokens: 1_000, maxOutputTokens: 1_000 },
      expensivePricing
    );
    const policy = buildPolicy({
      allowedRouteRefs: [routeFirst.routeRef, routeSecond.routeRef],
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxCostMicros: 1
    });

    const result = filterByBudget([candidateFirst, candidateSecond], policy);

    expect(result.eligible).toHaveLength(0);
    expect(result.firstExclusion).toEqual({
      routeRef: routeFirst.routeRef,
      ceiling: "maxCostMicros"
    });
    expect(result.firstExclusion?.routeRef).not.toBe(routeSecond.routeRef);
  });
});

describe("filterByBudget — token ceilings, resolve time (DEC-3)", () => {
  it("excludes a route whose declared maxOutputTokens is below policy.maxOutputTokens", () => {
    const route = buildRoute({ routeRef: "route.small-output" });
    const candidate = buildCandidate(route, { maxOutputTokens: 500 });
    const policy = buildPolicy({ allowedRouteRefs: [route.routeRef], maxOutputTokens: 4_000 });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible).toHaveLength(0);
    expect(result.firstExclusion).toEqual({ routeRef: route.routeRef, ceiling: "maxOutputTokens" });
  });

  it("excludes a route whose declared contextWindowTokens is below policy.maxInputTokens", () => {
    const route = buildRoute({ routeRef: "route.small-context" });
    const candidate = buildCandidate(route, { contextWindowTokens: 8_000 });
    const policy = buildPolicy({ allowedRouteRefs: [route.routeRef], maxInputTokens: 32_000 });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible).toHaveLength(0);
    expect(result.firstExclusion).toEqual({ routeRef: route.routeRef, ceiling: "maxInputTokens" });
  });

  it("excludes a route declaring neither ceiling under a policy that sets one (fail closed) — output direction", () => {
    const route = buildRoute({ routeRef: "route.undeclared-output" });
    const candidate = buildCandidate(route, { maxOutputTokens: undefined });
    const policy = buildPolicy({ allowedRouteRefs: [route.routeRef], maxOutputTokens: 1_000 });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible).toHaveLength(0);
    expect(result.firstExclusion).toEqual({ routeRef: route.routeRef, ceiling: "maxOutputTokens" });
  });

  it("excludes a route declaring neither ceiling under a policy that sets one (fail closed) — input direction", () => {
    const route = buildRoute({ routeRef: "route.undeclared-input" });
    const candidate = buildCandidate(route, { contextWindowTokens: undefined });
    const policy = buildPolicy({ allowedRouteRefs: [route.routeRef], maxInputTokens: 1_000 });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible).toHaveLength(0);
    expect(result.firstExclusion).toEqual({ routeRef: route.routeRef, ceiling: "maxInputTokens" });
  });

  it("keeps a route eligible when its declared ceilings meet or exceed the policy's on both directions", () => {
    const route = buildRoute({ routeRef: "route.roomy" });
    const candidate = buildCandidate(route, {
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_000
    });
    const policy = buildPolicy({
      allowedRouteRefs: [route.routeRef],
      maxInputTokens: 32_000,
      maxOutputTokens: 4_000
    });

    const result = filterByBudget([candidate], policy);

    expect(result.eligible.map((c) => c.route.routeRef)).toEqual([route.routeRef]);
  });
});

describe("assertWithinInvocationBudget — invocation-time demand checks (DEC-3), both directions", () => {
  it("raises budget_exceeded, non-retryable, when the stated output demand exceeds policy.maxOutputTokens", () => {
    const policy = buildPolicy({ maxOutputTokens: 1_000 });

    expect(() =>
      assertWithinInvocationBudget({
        policy,
        routeRef: "route.a",
        demand: { inputTokens: 10, outputTokens: 1_001 }
      })
    ).toThrow(ModelRoutingError);

    try {
      assertWithinInvocationBudget({
        policy,
        routeRef: "route.a",
        demand: { inputTokens: 10, outputTokens: 1_001 }
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRoutingError);
      if (error instanceof ModelRoutingError) {
        expect(error.code).toBe("budget_exceeded");
        expect(error.retryable).toBe(false);
        expect(error.failure.routeRef).toBe("route.a");
        expect(error.message).toContain("maxOutputTokens");
        expect(error.message).toContain("route.a");
      }
    }
  });

  it("raises budget_exceeded, non-retryable, when the stated input demand exceeds policy.maxInputTokens", () => {
    const policy = buildPolicy({ maxInputTokens: 4_000 });

    try {
      assertWithinInvocationBudget({
        policy,
        routeRef: "route.b",
        demand: { inputTokens: 4_001, outputTokens: 10 }
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRoutingError);
      if (error instanceof ModelRoutingError) {
        expect(error.code).toBe("budget_exceeded");
        expect(error.retryable).toBe(false);
        expect(error.message).toContain("maxInputTokens");
      }
    }
  });

  it("does not throw when both directions are within their ceilings, or when a ceiling is unset", () => {
    const policy = buildPolicy({ maxInputTokens: 4_000, maxOutputTokens: 1_000 });
    expect(() =>
      assertWithinInvocationBudget({
        policy,
        routeRef: "route.a",
        demand: { inputTokens: 4_000, outputTokens: 1_000 }
      })
    ).not.toThrow();

    const unconstrainedPolicy = buildPolicy({});
    expect(() =>
      assertWithinInvocationBudget({
        policy: unconstrainedPolicy,
        routeRef: "route.a",
        demand: { inputTokens: 1_000_000, outputTokens: 1_000_000 }
      })
    ).not.toThrow();
  });

  it("the budget_exceeded message names the ceiling and the route ref, and carries no pricing arithmetic", () => {
    const policy = buildPolicy({ maxOutputTokens: 1_000, maxCostMicros: 42 });
    try {
      assertWithinInvocationBudget({
        policy,
        routeRef: "route.named",
        demand: { inputTokens: 0, outputTokens: 5_000 }
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRoutingError);
      if (error instanceof ModelRoutingError) {
        expect(error.message).toContain("route.named");
        expect(error.message).toContain("maxOutputTokens");
        // No pricing figure (the policy's maxCostMicros, or any derived dollar amount) appears —
        // a reader must never mistake this for a cost quote.
        expect(error.message).not.toContain("42");
        expect(error.message).not.toContain("5000");
        expect(error.message).not.toContain("micros");
      }
    }
  });
});
