import { describe, expect, it } from "vitest";

import {
  CredentialRefIdSchema,
  type ModelCatalogEntry,
  type ModelRoute
} from "@autostack/contracts";

import { filterByCapability, type CapabilityCandidate } from "../src/catalog/capability-filter.js";

const credentialRefId = CredentialRefIdSchema.parse("cred_aaaaaaaa-e89b-42d3-a456-426614174000");
const discoveredAt = "2026-08-27T00:00:00.000Z";

const buildRoute = (overrides: Partial<ModelRoute> = {}): ModelRoute => ({
  schemaVersion: 1,
  routeRef: overrides.routeRef ?? "route.direct.openai",
  displayName: overrides.displayName ?? "Direct OpenAI",
  transport: overrides.transport ?? {
    kind: "direct",
    protocol: "openai_compatible",
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    providerModel: "gpt-4o",
    credentialRefId
  },
  enabled: overrides.enabled ?? true
});

const buildEntry = (overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  schemaVersion: 1,
  routeRef: overrides.routeRef ?? "route.direct.openai",
  providerModel: overrides.providerModel ?? "gpt-4o",
  displayName: overrides.displayName ?? "GPT-4o",
  inputModalities: overrides.inputModalities ?? ["text"],
  outputModalities: overrides.outputModalities ?? ["text"],
  features: overrides.features ?? [],
  discoveredAt: overrides.discoveredAt ?? discoveredAt
});

describe("filterByCapability", () => {
  it("matches the fake's declaredCapabilities for a single-entry catalog matching the pin", () => {
    const route = buildRoute();
    const entry = buildEntry({ features: ["tool_call"] });
    const candidates: CapabilityCandidate[] = [{ route, entries: [entry] }];

    const withCapability = filterByCapability(candidates, ["text", "tool_call"]);
    expect(withCapability.eligible.map((e) => e.route.routeRef)).toEqual([route.routeRef]);
    expect(withCapability.eligible[0]?.entry).toEqual(entry);

    const withoutCapability = filterByCapability(candidates, ["image"]);
    expect(withoutCapability.eligible.map((e) => e.route.routeRef)).not.toContain(route.routeRef);
    expect(withoutCapability.eligible).toHaveLength(0);
  });

  it("excludes a route when a SIBLING entry declares tool_call but the PINNED entry does not (DEC-0 tripwire)", () => {
    const route = buildRoute({ routeRef: "route.multi", displayName: "Multi" });
    const pinnedEntry = buildEntry({
      routeRef: "route.multi",
      providerModel: "gpt-4o",
      features: []
    });
    const siblingEntry = buildEntry({
      routeRef: "route.multi",
      providerModel: "gpt-4o-tools",
      features: ["tool_call"]
    });
    const candidates: CapabilityCandidate[] = [{ route, entries: [pinnedEntry, siblingEntry] }];

    const result = filterByCapability(candidates, ["tool_call"]);

    expect(result.eligible.map((e) => e.route.routeRef)).not.toContain(route.routeRef);
    expect(result.eligible).toHaveLength(0);
    expect(result.absentPinRouteRefs).not.toContain(route.routeRef);
  });

  it("excludes a route whose pin is absent from an otherwise successful discovery, with a reason distinct from a missing capability", () => {
    const route = buildRoute({ routeRef: "route.absent-pin" });
    const otherEntry = buildEntry({
      routeRef: "route.absent-pin",
      providerModel: "some-other-model",
      features: ["tool_call"]
    });
    const candidates: CapabilityCandidate[] = [{ route, entries: [otherEntry] }];

    const result = filterByCapability(candidates, ["tool_call"]);

    expect(result.eligible.map((e) => e.route.routeRef)).not.toContain(route.routeRef);
    expect(result.absentPinRouteRefs).toEqual([route.routeRef]);
  });

  it("drops a route missing one required capability and keeps every route whose pin resolves when requiredCapabilities is empty", () => {
    const capableRoute = buildRoute({ routeRef: "route.capable" });
    const incapableRoute = buildRoute({ routeRef: "route.incapable" });
    const capableEntry = buildEntry({
      routeRef: "route.capable",
      providerModel: "gpt-4o",
      features: ["tool_call"]
    });
    const incapableEntry = buildEntry({
      routeRef: "route.incapable",
      providerModel: "gpt-4o",
      features: []
    });
    const candidates: CapabilityCandidate[] = [
      { route: capableRoute, entries: [capableEntry] },
      { route: incapableRoute, entries: [incapableEntry] }
    ];

    const withRequirement = filterByCapability(candidates, ["tool_call"]);
    expect(withRequirement.eligible.map((e) => e.route.routeRef)).toEqual([capableRoute.routeRef]);
    expect(withRequirement.eligible.map((e) => e.route.routeRef)).not.toContain(
      incapableRoute.routeRef
    );

    const withoutRequirement = filterByCapability(candidates, []);
    expect(withoutRequirement.eligible.map((e) => e.route.routeRef).sort()).toEqual(
      [capableRoute.routeRef, incapableRoute.routeRef].sort()
    );
  });

  it("reads only ModelCatalogEntry values, never a route's display name or transport fields", () => {
    const route = buildRoute({
      routeRef: "route.misleading-name",
      displayName: "Definitely supports tool_call and image"
    });
    const entry = buildEntry({ routeRef: "route.misleading-name", features: [] });
    const candidates: CapabilityCandidate[] = [{ route, entries: [entry] }];

    const result = filterByCapability(candidates, ["tool_call"]);

    expect(result.eligible.map((e) => e.route.routeRef)).not.toContain(route.routeRef);
    expect(result.eligible).toHaveLength(0);
    expect(result.absentPinRouteRefs).toEqual([]);
  });
});
