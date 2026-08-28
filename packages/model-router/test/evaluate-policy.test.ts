import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelRoutingError,
  RunIdSchema,
  StageRunIdSchema,
  WorkspaceIdSchema,
  type ModelCatalogEntry,
  type ModelPolicy,
  type ModelRoute,
  type ModelRouteContext
} from "@autostack/contracts";

import type { CatalogSnapshot } from "../src/catalog/catalog-cache.js";
import { evaluatePolicy, type EvaluatePolicyCandidate } from "../src/policy/evaluate-policy.js";
import { assertPolicyStage, createPolicyRegistry } from "../src/policy/policy-registry.js";

const credentialRefId = CredentialRefIdSchema.parse("cred_aaaaaaaa-e89b-42d3-a456-426614174000");
const discoveredAt = "2026-08-27T00:00:00.000Z";
const fixedNow = (): string => discoveredAt;

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

const toSnapshot = (entries: readonly ModelCatalogEntry[]): CatalogSnapshot => ({
  freshness: "fresh",
  entries,
  pricing: new Map(),
  discoveredAt
});

const buildPolicy = (
  overrides: Partial<ModelPolicy> & { stage: ModelPolicy["stage"] }
): ModelPolicy => ({
  schemaVersion: 1,
  policyRef: overrides.policyRef ?? `policy.${overrides.stage}`,
  stage: overrides.stage,
  allowedRouteRefs: overrides.allowedRouteRefs ?? ["route.a"],
  fallbackRouteRefs: overrides.fallbackRouteRefs ?? [],
  maxInputTokens: overrides.maxInputTokens,
  maxOutputTokens: overrides.maxOutputTokens,
  maxCostMicros: overrides.maxCostMicros,
  reasoningLevel: overrides.reasoningLevel
});

const buildContext = (
  overrides: Partial<ModelRouteContext> & { stage: ModelRouteContext["stage"] }
): ModelRouteContext => ({
  schemaVersion: 1,
  idempotencyKey: overrides.idempotencyKey ?? "idem-1",
  workspaceId:
    overrides.workspaceId ?? WorkspaceIdSchema.parse("ws_aaaaaaaa-e89b-42d3-a456-426614174000"),
  runId: overrides.runId ?? RunIdSchema.parse("run_aaaaaaaa-e89b-42d3-a456-426614174000"),
  stageRunId:
    overrides.stageRunId ?? StageRunIdSchema.parse("stage_aaaaaaaa-e89b-42d3-a456-426614174000"),
  stage: overrides.stage,
  requiredCapabilities: overrides.requiredCapabilities ?? []
});

describe("policy admission (pipeline stage 1)", () => {
  it("throws a TypeError, not a ModelRoutingError, at construction when two policies declare the same stage", () => {
    const policyOne = buildPolicy({ stage: "implement", policyRef: "policy.one" });
    const policyTwo = buildPolicy({ stage: "implement", policyRef: "policy.two" });

    expect(() => createPolicyRegistry([policyOne, policyTwo])).toThrow(TypeError);
    try {
      createPolicyRegistry([policyOne, policyTwo]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(ModelRoutingError);
    }
  });

  it("throws a TypeError, not a ModelRoutingError, and never falls back to permissive, when a stage has no configured policy", () => {
    const registry = createPolicyRegistry([buildPolicy({ stage: "implement" })]);

    expect(() => registry.getForStage("verify")).toThrow(TypeError);
    try {
      registry.getForStage("verify");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(ModelRoutingError);
    }
  });

  it("throws a TypeError when queried against an empty registry (no policy configured anywhere)", () => {
    const registry = createPolicyRegistry([]);

    expect(() => registry.getForStage("triage")).toThrow(TypeError);
  });

  it("throws a TypeError, not a ModelRoutingError, when a policy's own stage differs from the queried stage", () => {
    const policy = buildPolicy({ stage: "implement" });

    expect(() => assertPolicyStage(policy, "verify")).toThrow(TypeError);
    try {
      assertPolicyStage(policy, "verify");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(ModelRoutingError);
    }
  });

  it("does not throw when a policy's own stage matches the queried stage", () => {
    const policy = buildPolicy({ stage: "plan" });
    expect(() => assertPolicyStage(policy, "plan")).not.toThrow();
  });

  it("throws a TypeError at construction, naming the index, when a policy fails ModelPolicySchema validation", () => {
    const valid = buildPolicy({ stage: "implement" });
    const invalid = { ...buildPolicy({ stage: "plan" }), allowedRouteRefs: [] }; // min(1) violated

    expect(() => createPolicyRegistry([valid, invalid])).toThrow(TypeError);
    try {
      createPolicyRegistry([valid, invalid]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(ModelRoutingError);
      expect((error as TypeError).message).toContain("index 1");
    }
  });
});

describe("policy filtering (pipeline stage 1's second half, and stage 4's reasoning contribution)", () => {
  it("excludes a route absent from allowedRouteRefs BEFORE the capability filter runs: excluding the only tool_call-capable route reports capability_unavailable naming the allowed routes' gap, never the excluded route", () => {
    const allowedRoute = buildRoute({ routeRef: "route.allowed" });
    const excludedRoute = buildRoute({ routeRef: "route.excluded" });
    // The excluded route is the ONLY one that actually declares tool_call — an out-of-policy
    // route must never be the reason a station reads capability_unavailable.
    const allowedEntry = buildEntry(allowedRoute, { features: [] });
    const excludedEntry = buildEntry(excludedRoute, { features: ["tool_call"] });
    const policy = buildPolicy({ stage: "implement", allowedRouteRefs: [allowedRoute.routeRef] });
    const registry = createPolicyRegistry([policy]);
    const context = buildContext({ stage: "implement", requiredCapabilities: ["tool_call"] });
    const candidates: EvaluatePolicyCandidate[] = [
      { route: allowedRoute, snapshot: toSnapshot([allowedEntry]) },
      { route: excludedRoute, snapshot: toSnapshot([excludedEntry]) }
    ];

    try {
      evaluatePolicy({ context, candidates, policies: registry, now: fixedNow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRoutingError);
      if (error instanceof ModelRoutingError) {
        expect(error.code).toBe("capability_unavailable");
        expect(error.message).toContain("tool_call");
        expect(error.message).not.toContain(excludedRoute.routeRef);
        expect(error.failure.message).not.toContain(excludedRoute.routeRef);
      }
    }
  });

  it("selects the first surviving allowedRouteRefs entry as preferred, regardless of the candidates array's own order", () => {
    const routeA = buildRoute({ routeRef: "route.a" });
    const routeB = buildRoute({ routeRef: "route.b" });
    const entryA = buildEntry(routeA, { features: [] });
    const entryB = buildEntry(routeB, { features: [] });
    // allowedRouteRefs lists B first, deliberately the reverse of the candidates array order.
    const policy = buildPolicy({
      stage: "implement",
      allowedRouteRefs: [routeB.routeRef, routeA.routeRef]
    });
    const registry = createPolicyRegistry([policy]);
    const context = buildContext({ stage: "implement" });
    const candidates: EvaluatePolicyCandidate[] = [
      { route: routeA, snapshot: toSnapshot([entryA]) },
      { route: routeB, snapshot: toSnapshot([entryB]) }
    ];

    const selection = evaluatePolicy({ context, candidates, policies: registry, now: fixedNow });

    expect(selection.routeRef).toBe(routeB.routeRef);
  });

  it("contributes the reasoning feature to the effective required set when reasoningLevel is not none, excluding a route that lacks it", () => {
    const route = buildRoute({ routeRef: "route.no-reasoning" });
    const entry = buildEntry(route, { features: [] });
    const policy = buildPolicy({
      stage: "implement",
      allowedRouteRefs: [route.routeRef],
      reasoningLevel: "medium"
    });
    const registry = createPolicyRegistry([policy]);
    const context = buildContext({ stage: "implement", requiredCapabilities: [] });
    const candidates: EvaluatePolicyCandidate[] = [{ route, snapshot: toSnapshot([entry]) }];

    try {
      evaluatePolicy({ context, candidates, policies: registry, now: fixedNow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRoutingError);
      if (error instanceof ModelRoutingError) {
        expect(error.code).toBe("capability_unavailable");
      }
    }
  });

  it("selects a route once it declares reasoning, when reasoningLevel is not none", () => {
    const route = buildRoute({ routeRef: "route.reasoning" });
    const entry = buildEntry(route, { features: ["reasoning"] });
    const policy = buildPolicy({
      stage: "implement",
      allowedRouteRefs: [route.routeRef],
      reasoningLevel: "high"
    });
    const registry = createPolicyRegistry([policy]);
    const context = buildContext({ stage: "implement", requiredCapabilities: [] });
    const candidates: EvaluatePolicyCandidate[] = [{ route, snapshot: toSnapshot([entry]) }];

    const selection = evaluatePolicy({ context, candidates, policies: registry, now: fixedNow });

    expect(selection.routeRef).toBe(route.routeRef);
  });

  it("does not add the reasoning requirement when reasoningLevel is none or unset", () => {
    const route = buildRoute({ routeRef: "route.plain" });
    const entry = buildEntry(route, { features: [] });
    const policy = buildPolicy({
      stage: "implement",
      allowedRouteRefs: [route.routeRef],
      reasoningLevel: "none"
    });
    const registry = createPolicyRegistry([policy]);
    const context = buildContext({ stage: "implement", requiredCapabilities: [] });
    const candidates: EvaluatePolicyCandidate[] = [{ route, snapshot: toSnapshot([entry]) }];

    const selection = evaluatePolicy({ context, candidates, policies: registry, now: fixedNow });

    expect(selection.routeRef).toBe(route.routeRef);
  });
});

describe("budget (pipeline stage 6), evaluated end to end through evaluatePolicy", () => {
  it("reports budget_exceeded, non-retryable, attributed to the excluding route, when every capable+enabled route is over the cost ceiling", () => {
    const route = buildRoute({ routeRef: "route.over-budget" });
    const entry = buildEntry(route, {
      features: [],
      contextWindowTokens: 1_000,
      maxOutputTokens: 1_000
    });
    const snapshot: CatalogSnapshot = {
      freshness: "fresh",
      entries: [entry],
      pricing: new Map([[entry.providerModel, { inputUsdPerToken: 1, outputUsdPerToken: 1 }]]),
      discoveredAt
    };
    const policy = buildPolicy({
      stage: "implement",
      allowedRouteRefs: [route.routeRef],
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxCostMicros: 1
    });
    const registry = createPolicyRegistry([policy]);
    const context = buildContext({ stage: "implement", requiredCapabilities: [] });
    const candidates: EvaluatePolicyCandidate[] = [{ route, snapshot }];

    try {
      evaluatePolicy({ context, candidates, policies: registry, now: fixedNow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRoutingError);
      if (error instanceof ModelRoutingError) {
        expect(error.code).toBe("budget_exceeded");
        expect(error.retryable).toBe(false);
        expect(error.failure.routeRef).toBe(route.routeRef);
      }
    }
  });
});

describe("stage ordering: enabled (5) runs before budget (6)", () => {
  it('reports budget_exceeded, not route_disabled, when one candidate is capable-but-disabled and the other is capable-but-unaffordable — stage 5 removes the disabled route while a candidate still survives, so it empties nothing; stage 6 then empties the set on the affordability of the one route the operator is actually permitted to use, and owns the failure (attribution rule, plan §"The rejection pipeline")', () => {
    const disabledRoute = buildRoute({ routeRef: "route.disabled", enabled: false });
    const expensiveRoute = buildRoute({ routeRef: "route.expensive", enabled: true });
    const disabledEntry = buildEntry(disabledRoute, { features: ["tool_call"] });
    const expensiveEntry = buildEntry(expensiveRoute, {
      features: ["tool_call"],
      contextWindowTokens: 100_000,
      maxOutputTokens: 100_000
    });
    const expensiveSnapshot: CatalogSnapshot = {
      freshness: "fresh",
      entries: [expensiveEntry],
      pricing: new Map([
        [expensiveEntry.providerModel, { inputUsdPerToken: 1, outputUsdPerToken: 1 }]
      ]),
      discoveredAt
    };
    const policy = buildPolicy({
      stage: "implement",
      allowedRouteRefs: [disabledRoute.routeRef, expensiveRoute.routeRef],
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxCostMicros: 1
    });
    const registry = createPolicyRegistry([policy]);
    const context = buildContext({ stage: "implement", requiredCapabilities: ["tool_call"] });
    const candidates: EvaluatePolicyCandidate[] = [
      { route: disabledRoute, snapshot: toSnapshot([disabledEntry]) },
      { route: expensiveRoute, snapshot: expensiveSnapshot }
    ];

    try {
      evaluatePolicy({ context, candidates, policies: registry, now: fixedNow });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelRoutingError);
      if (error instanceof ModelRoutingError) {
        // Attribution rule: the raised code belongs to the stage that empties the candidate set.
        // Stage 5 (enabled) removes disabledRoute but expensiveRoute survives — the set is still
        // non-empty, so stage 5 contributes nothing. Stage 6 (budget) then removes expensiveRoute
        // for cost, emptying the set, so budget_exceeded is stage 6's to raise. The disabled route
        // was excluded by a deliberate administrative act; naming it as the blocker would tell the
        // operator their own configuration is at fault when the route they are actually permitted
        // to use failed on cost.
        expect(error.code).toBe("budget_exceeded");
        expect(error.code).not.toBe("route_disabled");
        expect(error.retryable).toBe(false);
        expect(error.failure.routeRef).toBe(expensiveRoute.routeRef);
      }
    }
  });
});
