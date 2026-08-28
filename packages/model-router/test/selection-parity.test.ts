import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  ModelRoutingError,
  RunIdSchema,
  StageRunIdSchema,
  WorkspaceIdSchema,
  type ModelCatalogEntry,
  type ModelRoute,
  type ModelRouteContext,
  type ModelUsage
} from "@autostack/contracts";

import { createFakeModelRouter, type FakeModelRouteDeclaration } from "@autostack/domain/testing";

import { createRouteRegistry, type ExactUsageSink } from "../src/route-registry.js";
import type { CatalogSnapshot } from "../src/catalog/catalog-cache.js";
import { selectRoute, type SelectRouteCandidate } from "../src/selection/select-route.js";

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
    discoveredAt: overrides.discoveredAt ?? discoveredAt
  };
};

const toSnapshot = (entries: readonly ModelCatalogEntry[]): CatalogSnapshot => ({
  freshness: "fresh",
  entries,
  pricing: new Map(),
  discoveredAt
});

const buildContext = (
  overrides: Partial<ModelRouteContext> & { requiredCapabilities?: readonly string[] }
): ModelRouteContext => ({
  schemaVersion: 1,
  idempotencyKey: overrides.idempotencyKey ?? "idem-1",
  workspaceId:
    overrides.workspaceId ?? WorkspaceIdSchema.parse("ws_aaaaaaaa-e89b-42d3-a456-426614174000"),
  runId: overrides.runId ?? RunIdSchema.parse("run_aaaaaaaa-e89b-42d3-a456-426614174000"),
  stageRunId:
    overrides.stageRunId ?? StageRunIdSchema.parse("stage_aaaaaaaa-e89b-42d3-a456-426614174000"),
  stage: overrides.stage ?? "implement",
  requiredCapabilities: overrides.requiredCapabilities ?? []
});

interface RunOutcome {
  readonly kind: "selected" | "failure";
  readonly routeRef?: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly failureRouteRef?: string | undefined;
  readonly idempotencyKey?: string;
  readonly selectedAt?: string;
}

const runFake = async (
  declarations: readonly FakeModelRouteDeclaration[],
  context: ModelRouteContext,
  scriptedRouteRef: string
): Promise<RunOutcome> => {
  const fake = createFakeModelRouter({
    catalog: declarations,
    outcomes: [{ kind: "selected", routeRef: scriptedRouteRef, reason: "scripted" }],
    now: fixedNow
  });
  try {
    const selection = await fake.resolve(context);
    return {
      kind: "selected",
      routeRef: selection.routeRef,
      idempotencyKey: selection.idempotencyKey,
      selectedAt: selection.selectedAt
    };
  } catch (error) {
    if (error instanceof ModelRoutingError) {
      return {
        kind: "failure",
        code: error.code,
        retryable: error.retryable,
        failureRouteRef: error.failure.routeRef
      };
    }
    throw error;
  }
};

const runReal = (
  candidates: readonly SelectRouteCandidate[],
  context: ModelRouteContext
): RunOutcome => {
  try {
    const selection = selectRoute({ context, candidates, now: fixedNow });
    return {
      kind: "selected",
      routeRef: selection.routeRef,
      idempotencyKey: selection.idempotencyKey,
      selectedAt: selection.selectedAt
    };
  } catch (error) {
    if (error instanceof ModelRoutingError) {
      return {
        kind: "failure",
        code: error.code,
        retryable: error.retryable,
        failureRouteRef: error.failure.routeRef
      };
    }
    throw error;
  }
};

describe("selection parity between createFakeModelRouter and selectRoute", () => {
  it("selects the same routeRef when every capable route is enabled", async () => {
    const routeA = buildRoute({ routeRef: "route.a" });
    const routeB = buildRoute({ routeRef: "route.b" });
    const entryA = buildEntry(routeA, { features: ["tool_call"] });
    const entryB = buildEntry(routeB, { features: [] });
    const context = buildContext({ requiredCapabilities: ["tool_call"] });

    const fakeOutcome = await runFake(
      [
        { route: routeA, catalogEntry: entryA },
        { route: routeB, catalogEntry: entryB }
      ],
      context,
      routeA.routeRef
    );
    const realOutcome = runReal(
      [
        { route: routeA, snapshot: toSnapshot([entryA]) },
        { route: routeB, snapshot: toSnapshot([entryB]) }
      ],
      context
    );

    expect(fakeOutcome.kind).toBe("selected");
    expect(realOutcome.kind).toBe("selected");
    expect(realOutcome.routeRef).toBe(routeA.routeRef);
    expect(fakeOutcome.routeRef).toBe(realOutcome.routeRef);
  });

  it("raises capability_unavailable, non-retryable, when no route declares the required capability", async () => {
    const routeA = buildRoute({ routeRef: "route.a" });
    const routeB = buildRoute({ routeRef: "route.b" });
    const entryA = buildEntry(routeA, { features: [] });
    const entryB = buildEntry(routeB, { features: [] });
    const context = buildContext({ requiredCapabilities: ["reasoning"] });

    const fakeOutcome = await runFake(
      [
        { route: routeA, catalogEntry: entryA },
        { route: routeB, catalogEntry: entryB }
      ],
      context,
      routeA.routeRef
    );
    const realOutcome = runReal(
      [
        { route: routeA, snapshot: toSnapshot([entryA]) },
        { route: routeB, snapshot: toSnapshot([entryB]) }
      ],
      context
    );

    for (const outcome of [fakeOutcome, realOutcome]) {
      expect(outcome.kind).toBe("failure");
      expect(outcome.code).toBe("capability_unavailable");
      expect(outcome.retryable).toBe(false);
    }
  });

  it("raises route_disabled, non-retryable, attributed, when capable routes exist but all are disabled", async () => {
    const routeA = buildRoute({ routeRef: "route.a", enabled: false });
    const routeB = buildRoute({ routeRef: "route.b", enabled: false });
    const entryA = buildEntry(routeA, { features: ["tool_call"] });
    const entryB = buildEntry(routeB, { features: ["tool_call"] });
    const context = buildContext({ requiredCapabilities: ["tool_call"] });

    const fakeOutcome = await runFake(
      [
        { route: routeA, catalogEntry: entryA },
        { route: routeB, catalogEntry: entryB }
      ],
      context,
      routeA.routeRef
    );
    const realOutcome = runReal(
      [
        { route: routeA, snapshot: toSnapshot([entryA]) },
        { route: routeB, snapshot: toSnapshot([entryB]) }
      ],
      context
    );

    for (const outcome of [fakeOutcome, realOutcome]) {
      expect(outcome.kind).toBe("failure");
      expect(outcome.code).toBe("route_disabled");
      expect(outcome.retryable).toBe(false);
      expect(outcome.failureRouteRef).toBe(routeA.routeRef);
    }
  });

  it("selects the capable+enabled route when a capable+disabled route also exists, with no failure", async () => {
    const routeA = buildRoute({ routeRef: "route.a", enabled: true });
    const routeB = buildRoute({ routeRef: "route.b", enabled: false });
    const entryA = buildEntry(routeA, { features: ["tool_call"] });
    const entryB = buildEntry(routeB, { features: ["tool_call"] });
    const context = buildContext({ requiredCapabilities: ["tool_call"] });

    const fakeOutcome = await runFake(
      [
        { route: routeA, catalogEntry: entryA },
        { route: routeB, catalogEntry: entryB }
      ],
      context,
      routeA.routeRef
    );
    const realOutcome = runReal(
      [
        { route: routeA, snapshot: toSnapshot([entryA]) },
        { route: routeB, snapshot: toSnapshot([entryB]) }
      ],
      context
    );

    expect(fakeOutcome.kind).toBe("selected");
    expect(realOutcome.kind).toBe("selected");
    expect(realOutcome.routeRef).toBe(routeA.routeRef);
    expect(fakeOutcome.routeRef).toBe(realOutcome.routeRef);
  });

  it("raises route_disabled, not capability_unavailable, when the required capability is declared only by a disabled route", async () => {
    const routeA = buildRoute({ routeRef: "route.a", enabled: false });
    const routeB = buildRoute({ routeRef: "route.b", enabled: true });
    const entryA = buildEntry(routeA, { features: ["tool_call"] });
    const entryB = buildEntry(routeB, { features: [] });
    const context = buildContext({ requiredCapabilities: ["tool_call"] });

    const fakeOutcome = await runFake(
      [
        { route: routeA, catalogEntry: entryA },
        { route: routeB, catalogEntry: entryB }
      ],
      context,
      routeA.routeRef
    );
    const realOutcome = runReal(
      [
        { route: routeA, snapshot: toSnapshot([entryA]) },
        { route: routeB, snapshot: toSnapshot([entryB]) }
      ],
      context
    );

    for (const outcome of [fakeOutcome, realOutcome]) {
      expect(outcome.kind).toBe("failure");
      expect(outcome.code).toBe("route_disabled");
      expect(outcome.failureRouteRef).toBe(routeA.routeRef);
      expect(outcome.code).not.toBe("capability_unavailable");
    }
  });

  it("DEC-0 (mandatory): a multi-entry catalog where the pinned model is the least capable entry filters the route out, matching the fake's equivalent single-entry pin declaration", async () => {
    const routeC = buildRoute({ routeRef: "route.c" });
    // The fake's catalog is one entry per route: its equivalent is the pin's own (least
    // capable) declaration — the one that actually matters.
    const pinnedEntry = buildEntry(routeC, { features: [] });
    const siblingEntry = buildEntry(routeC, {
      providerModel: "route.c.sibling-model",
      features: ["tool_call"]
    });
    const context = buildContext({ requiredCapabilities: ["tool_call"] });

    const fakeOutcome = await runFake(
      [{ route: routeC, catalogEntry: pinnedEntry }],
      context,
      routeC.routeRef
    );
    const realOutcome = runReal(
      [{ route: routeC, snapshot: toSnapshot([pinnedEntry, siblingEntry]) }],
      context
    );

    for (const outcome of [fakeOutcome, realOutcome]) {
      expect(outcome.kind).toBe("failure");
      expect(outcome.code).toBe("capability_unavailable");
      expect(outcome.retryable).toBe(false);
    }
  });

  it("echoes the request's idempotencyKey in the selection", async () => {
    const routeA = buildRoute({ routeRef: "route.a" });
    const entryA = buildEntry(routeA, { features: [] });
    const context = buildContext({ idempotencyKey: "idem-specific-42" });

    const fakeOutcome = await runFake(
      [{ route: routeA, catalogEntry: entryA }],
      context,
      routeA.routeRef
    );
    const realOutcome = runReal([{ route: routeA, snapshot: toSnapshot([entryA]) }], context);

    expect(fakeOutcome.idempotencyKey).toBe("idem-specific-42");
    expect(realOutcome.idempotencyKey).toBe("idem-specific-42");
  });

  it("takes selectedAt from the injected clock — the exact injected value, never a wall-clock time", async () => {
    const routeA = buildRoute({ routeRef: "route.a" });
    const entryA = buildEntry(routeA, { features: [] });
    const context = buildContext({});
    const farFutureNow = (): string => "2099-01-01T00:00:00.000Z";

    const fake = createFakeModelRouter({
      catalog: [{ route: routeA, catalogEntry: entryA }],
      outcomes: [{ kind: "selected", routeRef: routeA.routeRef, reason: "scripted" }],
      now: farFutureNow
    });
    const fakeSelection = await fake.resolve(context);
    const realSelection = selectRoute({
      context,
      candidates: [{ route: routeA, snapshot: toSnapshot([entryA]) }],
      now: farFutureNow
    });

    expect(fakeSelection.selectedAt).toBe("2099-01-01T00:00:00.000Z");
    expect(realSelection.selectedAt).toBe("2099-01-01T00:00:00.000Z");
    const wallClockYear = new Date().getFullYear();
    expect(new Date(fakeSelection.selectedAt).getFullYear()).not.toBe(wallClockYear);
    expect(new Date(realSelection.selectedAt).getFullYear()).not.toBe(wallClockYear);
  });

  it("derives attribution from each request's own context, never from a value fixed by an earlier script or call", async () => {
    const routeA = buildRoute({ routeRef: "route.a" });
    const entryA = buildEntry(routeA, { features: [] });
    const declarations = [{ route: routeA, catalogEntry: entryA }];
    const candidates: SelectRouteCandidate[] = [{ route: routeA, snapshot: toSnapshot([entryA]) }];

    const contextOne = buildContext({ idempotencyKey: "idem-call-one" });
    const contextTwo = buildContext({ idempotencyKey: "idem-call-two" });

    const fake = createFakeModelRouter({
      catalog: declarations,
      outcomes: [
        { kind: "selected", routeRef: routeA.routeRef, reason: "scripted" },
        { kind: "selected", routeRef: routeA.routeRef, reason: "scripted" }
      ],
      now: fixedNow
    });

    const fakeSelectionOne = await fake.resolve(contextOne);
    const fakeSelectionTwo = await fake.resolve(contextTwo);
    const realSelectionOne = selectRoute({ context: contextOne, candidates, now: fixedNow });
    const realSelectionTwo = selectRoute({ context: contextTwo, candidates, now: fixedNow });

    expect(fakeSelectionOne.idempotencyKey).toBe("idem-call-one");
    expect(fakeSelectionTwo.idempotencyKey).toBe("idem-call-two");
    expect(realSelectionOne.idempotencyKey).toBe("idem-call-one");
    expect(realSelectionTwo.idempotencyKey).toBe("idem-call-two");
  });

  it("returns undefined, not a throw, from getRoute on an unknown ref for both", async () => {
    const routeA = buildRoute({ routeRef: "route.a" });
    const entryA = buildEntry(routeA, { features: [] });

    const noopSink: ExactUsageSink = { record: async () => {} };
    const registry = createRouteRegistry({ routes: [routeA], exactUsageSink: noopSink });
    const fake = createFakeModelRouter({
      catalog: [{ route: routeA, catalogEntry: entryA }],
      outcomes: [],
      now: fixedNow
    });

    expect(registry.getRoute("route.unknown")).toBeUndefined();
    await expect(fake.getRoute("route.unknown")).resolves.toBeUndefined();
  });

  it("recordUsage isolation: the flat sink receives the payload and no ModelUsageRecord is emitted by recordUsage alone", async () => {
    const routeA = buildRoute({ routeRef: "route.a" });
    const entryA = buildEntry(routeA, { features: [] });

    const sinkCalls: ModelUsage[] = [];
    const noopSink: ExactUsageSink = {
      record: async (usage) => {
        sinkCalls.push(usage);
      }
    };
    const registry = createRouteRegistry({ routes: [routeA], exactUsageSink: noopSink });
    const fake = createFakeModelRouter({
      catalog: [{ route: routeA, catalogEntry: entryA }],
      outcomes: [],
      now: fixedNow
    });

    const usage: ModelUsage = {
      schemaVersion: 1,
      idempotencyKey: "idem-1",
      routeRef: routeA.routeRef,
      providerRequestId: "req-1",
      provider: "openai",
      model: "route.a.model",
      tokens: { input: 10, output: 20, cachedInput: 0, reasoning: 0 },
      cost: { currency: "USD", micros: 500 },
      latencyMs: 250,
      recordedAt: discoveredAt
    };

    await registry.recordUsage(usage);
    await fake.recordUsage(usage);

    expect(sinkCalls).toEqual([usage]);
    expect(fake.recordedUsage).toEqual([usage]);
    expect(fake.usageRecords).toEqual([]);
  });
});
