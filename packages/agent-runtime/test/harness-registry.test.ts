import { describe, expect, it } from "vitest";

import {
  AgentHarnessProfileSchema,
  type AgentHarnessPort,
  type AgentHarnessProfile,
  type AgentPermissionResponderPort
} from "@autostack/contracts";

import {
  createFakeAgentHarness,
  type FakeAgentHarnessDescriptorOverrides
} from "@autostack/domain/testing";

import { AgentRuntimeError } from "../src/errors.js";
import type { AgentHarnessAvailabilityFacts } from "../src/harness-availability.js";
import {
  createAgentHarnessRegistry,
  type AgentHarnessRegistration,
  type AgentHarnessRegistry
} from "../src/harness-registry.js";

const clock = (): string => "2026-08-31T12:00:00.000Z";
const neverExpires = (): Promise<void> => new Promise<void>(() => undefined);

const emptySelection: AgentHarnessProfile["selection"] = {
  modelSelection: true,
  reasoningSelection: false,
  permissionModes: []
};

const availableFacts: AgentHarnessAvailabilityFacts = {
  installed: true,
  authenticated: true
};

/** The registry is always driven by the reference fake, never a hand-rolled stub. */
const buildHarness = (adapterId: string, overrides: FakeAgentHarnessDescriptorOverrides = {}) =>
  createFakeAgentHarness({
    script: [],
    now: clock,
    providerSessionRef: () => "provider.session.fake",
    descriptor: { adapterId, ...overrides }
  });

const buildRegistration = (
  adapterId: string,
  overrides: FakeAgentHarnessDescriptorOverrides = {},
  probe: () => Promise<AgentHarnessAvailabilityFacts> = async () => availableFacts
): AgentHarnessRegistration => ({
  harness: buildHarness(adapterId, overrides),
  selection: emptySelection,
  probe
});

const buildRegistry = (): AgentHarnessRegistry =>
  createAgentHarnessRegistry({ now: clock, probeTimeout: neverExpires });

const expectRuntimeFailure = (run: () => unknown, code: string): AgentRuntimeError => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentRuntimeError);
  if (!(caught instanceof AgentRuntimeError)) {
    throw new Error("Expected the call to raise an AgentRuntimeError.");
  }
  expect(caught.code).toBe(code);
  return caught;
};

describe("createAgentHarnessRegistry", () => {
  it("registers a valid harness and rejects a duplicate adapterId with agent_harness_already_registered (rejects a last-write-wins registry that silently replaces the earlier adapter)", () => {
    const registry = buildRegistry();
    const first = buildRegistration("adapter.dup");

    registry.register(first);
    // Positive companion: the registered harness is retrievable, and it is the same instance.
    expect(registry.get("adapter.dup")).toBe(first.harness);

    expectRuntimeFailure(
      () => registry.register(buildRegistration("adapter.dup")),
      "agent_harness_already_registered"
    );
    // The earlier registration survives the rejected duplicate.
    expect(registry.get("adapter.dup")).toBe(first.harness);
  });

  it("validates the descriptor at registration time (rejects a registry that trusts an adapter's self-description and lets an invalid descriptor poison every listing)", () => {
    const registry = buildRegistry();
    const honest = buildRegistration("adapter.honest");

    // Reshape an honest fake's surface by object spread: the descriptor is corrupted after
    // construction, because createFakeAgentHarness refuses to build a dishonest subject.
    const corrupted: AgentHarnessRegistration = {
      ...honest,
      harness: {
        ...honest.harness,
        descriptor: { ...honest.harness.descriptor, displayName: "" }
      }
    };

    expect(() => registry.register(corrupted)).toThrow();
    // Fail closed: nothing was admitted under the corrupted id.
    expectRuntimeFailure(() => registry.get("adapter.honest"), "agent_harness_not_registered");

    // Positive companion: the untouched honest registration is accepted.
    registry.register(honest);
    expect(registry.get("adapter.honest")).toBe(honest.harness);
  });

  it("raises agent_harness_not_registered for an unknown adapterId (rejects a registry that returns undefined and defers the failure to the first call site)", () => {
    const registry = buildRegistry();
    const known = buildRegistration("adapter.known");
    registry.register(known);

    expectRuntimeFailure(() => registry.get("adapter.unknown"), "agent_harness_not_registered");
    // Positive companion: the known id still resolves.
    expect(registry.get("adapter.known")).toBe(known.harness);
  });

  it("lists descriptors by kind in registration order and returns an empty array, not an error, for a kind with no adapters (rejects a registry that throws on an empty kind)", () => {
    const registry = buildRegistry();
    registry.register(buildRegistration("adapter.native.first", { kind: "native" }));
    registry.register(buildRegistration("adapter.codex.only", { kind: "codex" }));
    registry.register(buildRegistration("adapter.native.second", { kind: "native" }));

    // Positive companion: populated kinds come back in registration order.
    expect(registry.listByKind("native").map((descriptor) => descriptor.adapterId)).toEqual([
      "adapter.native.first",
      "adapter.native.second"
    ]);
    expect(registry.listByKind("codex").map((descriptor) => descriptor.adapterId)).toEqual([
      "adapter.codex.only"
    ]);
    // Negative: a kind with no adapters is an empty listing, never an exception.
    expect(registry.listByKind("acp")).toEqual([]);
  });

  it("probes every registration concurrently and fails one rejecting probe closed without erasing the others (rejects a sequential prober and a bare Promise.all that lets one rejection destroy the whole listing)", async () => {
    const registry = buildRegistry();
    const started: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    registry.register(
      buildRegistration("adapter.gated", {}, async () => {
        started.push("adapter.gated");
        await gate;
        return availableFacts;
      })
    );
    registry.register(
      buildRegistration("adapter.broken", {}, async () => {
        started.push("adapter.broken");
        throw new Error("the probe process exploded");
      })
    );
    registry.register(
      buildRegistration("adapter.ready", {}, async () => {
        started.push("adapter.ready");
        return availableFacts;
      })
    );

    const pending = registry.profiles();
    // One macrotask turn is enough for every probe to have started. A sequential
    // implementation would still be stuck behind the gated first probe.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(started).toEqual(["adapter.gated", "adapter.broken", "adapter.ready"]);

    release();
    const profiles = await pending;

    // ALL registrations report, including the one whose probe rejected.
    expect(profiles.map((profile) => profile.descriptor.adapterId).sort()).toEqual([
      "adapter.broken",
      "adapter.gated",
      "adapter.ready"
    ]);
    for (const profile of profiles) {
      expect(AgentHarnessProfileSchema.parse(profile)).toEqual(profile);
    }

    const byId = new Map(profiles.map((profile) => [profile.descriptor.adapterId, profile]));
    const broken = byId.get("adapter.broken");
    expect(broken?.availability.installed).toBe(false);
    expect(broken?.availability.authenticated).toBe(false);
    expect(broken?.availability.detail).toBeDefined();
    // Positive companions: the healthy probes reported their true facts.
    expect(byId.get("adapter.gated")?.availability.authenticated).toBe(true);
    expect(byId.get("adapter.ready")?.availability.authenticated).toBe(true);
  });

  it("rejects a harness declaring capabilities.permissions without exposing respondToPermission with agent_harness_capability_mismatch (rejects a registry that admits the adapter and only fails later, mid-session, at permission time)", () => {
    const registry = buildRegistry();
    const honest = buildRegistration("adapter.permissions", {
      capabilities: { permissions: true }
    });

    // createFakeAgentHarness refuses to construct a dishonest subject, so the honest fake's
    // surface is reshaped by object spread: same descriptor, responder dropped.
    const { respondToPermission: _dropped, ...withoutResponder } = honest.harness;
    const dishonest: AgentHarnessRegistration = { ...honest, harness: withoutResponder };

    expectRuntimeFailure(() => registry.register(dishonest), "agent_harness_capability_mismatch");
    expectRuntimeFailure(() => registry.get("adapter.permissions"), "agent_harness_not_registered");

    // Positive companion: the honest permissions-capable fake, responder intact, is admitted.
    registry.register(honest);
    expect(registry.get("adapter.permissions")).toBe(honest.harness);
  });

  it("rejects a harness exposing respondToPermission while declaring permissions:false with agent_harness_capability_mismatch (rejects a registry that lets an undeclared responder smuggle a permission surface past the descriptor)", () => {
    const registry = buildRegistry();
    const honest = buildRegistration("adapter.no-permissions", {
      capabilities: { permissions: false }
    });

    // Reshaped by object spread: a responder bolted onto a harness whose descriptor denies it.
    const smuggled: AgentHarnessPort & AgentPermissionResponderPort = {
      ...honest.harness,
      respondToPermission: async () => undefined
    };
    const dishonest: AgentHarnessRegistration = { ...honest, harness: smuggled };

    expectRuntimeFailure(() => registry.register(dishonest), "agent_harness_capability_mismatch");
    expectRuntimeFailure(
      () => registry.get("adapter.no-permissions"),
      "agent_harness_not_registered"
    );

    // Positive companion: the honest permissions-free fake, no responder, is admitted.
    registry.register(honest);
    expect(registry.get("adapter.no-permissions")).toBe(honest.harness);
  });
});
