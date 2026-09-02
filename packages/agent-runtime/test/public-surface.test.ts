import { describe, expect, it } from "vitest";

import * as surface from "../src/index.js";

/**
 * Pins the curated runtime surface of `@autostack/agent-runtime` (plan Task 12). The wrong
 * implementations this rejects: an accidental export landing unnoticed (a convenience `export *`,
 * or a new module wired into `src/index.ts` without a curation decision) and an internal helper
 * leaking (relay bookkeeping, transcript projection internals, registry probe plumbing) — either
 * becomes a failing diff here instead of a review catch. Type-only exports do not exist at
 * runtime, so this list is exactly what `Object.keys` yields; every change to it is a deliberate
 * public-surface change, reviewed as one.
 */
const EXPECTED_RUNTIME_SURFACE: readonly string[] = [
  "AGENT_RUNTIME_FAILURES",
  "AGENT_SESSION_TRANSCRIPT_DIGEST_DOMAIN",
  "AgentRuntimeError",
  "admitHarnessRegistration",
  "createAgentHarnessRegistry",
  "createAgentSessionSupervisor",
  "createSessionEventRelay",
  "describeHarnessAvailability",
  "digestSessionTranscript"
];

describe("@autostack/agent-runtime public surface", () => {
  it("exports exactly the checked-in curated runtime surface (rejects an accidental export or a leaked internal helper)", () => {
    expect(Object.keys(surface).sort()).toEqual([...EXPECTED_RUNTIME_SURFACE].sort());
  });

  it("keeps the checked-in list itself sorted, so the diff of a surface change is canonical", () => {
    expect([...EXPECTED_RUNTIME_SURFACE].sort()).toEqual(EXPECTED_RUNTIME_SURFACE);
  });
});
