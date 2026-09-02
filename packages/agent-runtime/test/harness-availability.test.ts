import { describe, expect, it } from "vitest";

import {
  AgentHarnessDescriptorSchema,
  AgentHarnessProfileSchema,
  type AgentHarnessDescriptor,
  type AgentHarnessProfile
} from "@autostack/contracts";

import {
  describeHarnessAvailability,
  type AgentHarnessAvailabilityFacts,
  type DescribeHarnessAvailabilityOptions
} from "../src/harness-availability.js";

const CHECKED_AT = "2026-08-31T12:00:00.000Z";
const clock = (): string => CHECKED_AT;

/**
 * The probe budget is INJECTED: a factory whose promise resolves when the budget elapses. The
 * availability layer races the probe against it, so a test controls "the budget elapsed" without
 * ever sleeping.
 */
const neverExpires = (): Promise<void> => new Promise<void>(() => undefined);
const alreadyExpired = (): Promise<void> => Promise.resolve();

const buildDescriptor = (
  overrides: Partial<AgentHarnessDescriptor["capabilities"]> = {}
): AgentHarnessDescriptor =>
  AgentHarnessDescriptorSchema.parse({
    schemaVersion: 1,
    adapterId: "adapter.availability",
    kind: "native",
    displayName: "Availability Test Harness",
    capabilities: {
      resume: true,
      steering: true,
      permissions: true,
      structuredPlans: true,
      ...overrides
    }
  });

const emptySelection: AgentHarnessProfile["selection"] = {
  modelSelection: true,
  reasoningSelection: false,
  permissionModes: []
};

const describeWith = (
  overrides: Partial<DescribeHarnessAvailabilityOptions>
): Promise<AgentHarnessProfile> =>
  describeHarnessAvailability({
    descriptor: buildDescriptor(),
    selection: emptySelection,
    probe: async (): Promise<AgentHarnessAvailabilityFacts> => ({
      installed: true,
      authenticated: true
    }),
    now: clock,
    probeTimeout: neverExpires,
    ...overrides
  });

describe("describeHarnessAvailability", () => {
  it("turns an installed+authenticated probe into a schema-valid profile stamped by the injected clock", async () => {
    const profile = await describeWith({});

    expect(profile.availability.installed).toBe(true);
    expect(profile.availability.authenticated).toBe(true);
    // The injected clock is the only time source for checkedAt.
    expect(profile.availability.checkedAt).toBe(CHECKED_AT);
    // The constructed profile is the parsed contract shape, not an unvalidated object.
    expect(AgentHarnessProfileSchema.parse(profile)).toEqual(profile);
  });

  it("fails closed on the impossible installed:false + authenticated:true instead of throwing (rejects an implementation that feeds the probe's facts straight into the schema, letting one lying adapter brick the whole workbench listing)", async () => {
    const profile = await describeWith({
      probe: async (): Promise<AgentHarnessAvailabilityFacts> => ({
        installed: false,
        authenticated: true
      })
    });

    // Fail closed: never authenticated-while-not-installed, and never an exception.
    expect(profile.availability.installed).toBe(false);
    expect(profile.availability.authenticated).toBe(false);
    // The detail names the contradiction the probe reported.
    expect(profile.availability.detail).toBeDefined();
    expect(profile.availability.detail).toMatch(/installed/i);
    expect(profile.availability.detail).toMatch(/authenticat/i);
    // Positive companion: what came out is still a schema-valid profile.
    expect(AgentHarnessProfileSchema.parse(profile)).toEqual(profile);
  });

  it("fails closed when the probe throws and redacts the error text before it reaches detail (rejects an implementation that copies a CLI probe's stderr, tokens and all, into the profile)", async () => {
    // Pattern-breaking fixture: the credential shape is assembled at runtime so no scannable
    // secret literal ever appears in source.
    const rawKey = `AKIA${"A".repeat(16)}`;
    const profile = await describeWith({
      probe: async (): Promise<AgentHarnessAvailabilityFacts> => {
        throw new Error(`credential check wrote ${rawKey} to stderr`);
      }
    });

    expect(profile.availability.installed).toBe(false);
    expect(profile.availability.authenticated).toBe(false);
    const detail = profile.availability.detail;
    expect(detail).toBeDefined();
    if (detail === undefined) throw new Error("Expected a detail on a failed probe.");
    // Negative: the raw credential never survives into the profile...
    expect(detail.includes(rawKey)).toBe(false);
    // ...positive companion: the detail still says something, and names a probe failure.
    expect(detail.length).toBeGreaterThan(0);
    expect(detail).toMatch(/probe/i);
    // SafeMetadataStringSchema on detail is enforced by the full parse.
    expect(AgentHarnessProfileSchema.parse(profile)).toEqual(profile);
  });

  it("fails closed when the probe outlives its injected budget, without any real sleeping (rejects an implementation that awaits the probe unconditionally and hangs the listing on one stuck CLI)", async () => {
    const profile = await describeWith({
      // A probe that never settles...
      probe: (): Promise<AgentHarnessAvailabilityFacts> =>
        new Promise<AgentHarnessAvailabilityFacts>(() => undefined),
      // ...raced against a budget that has already elapsed. No timers anywhere.
      probeTimeout: alreadyExpired
    });

    expect(profile.availability.installed).toBe(false);
    expect(profile.availability.authenticated).toBe(false);
    expect(profile.availability.detail).toBeDefined();
    expect(profile.availability.detail).toMatch(/timed out|timeout/i);
    expect(AgentHarnessProfileSchema.parse(profile)).toEqual(profile);
  });

  it("erases declared permission modes for a descriptor without permission support (rejects an implementation that passes the caller's selection through verbatim and turns a config mistake into a schema explosion)", async () => {
    const declaredModes: AgentHarnessProfile["selection"] = {
      modelSelection: true,
      reasoningSelection: false,
      permissionModes: ["mode.default"]
    };

    const stripped = await describeWith({
      descriptor: buildDescriptor({ permissions: false }),
      selection: declaredModes
    });
    // The schema refuses modes-without-capability; the availability layer must be unable to
    // construct that shape, so the modes are gone.
    expect(stripped.selection.permissionModes).toEqual([]);
    expect(AgentHarnessProfileSchema.parse(stripped)).toEqual(stripped);

    // Positive companion: with the capability declared, the same selection survives intact.
    const kept = await describeWith({
      descriptor: buildDescriptor({ permissions: true }),
      selection: declaredModes
    });
    expect(kept.selection.permissionModes).toEqual(["mode.default"]);
    expect(AgentHarnessProfileSchema.parse(kept)).toEqual(kept);
  });
});
