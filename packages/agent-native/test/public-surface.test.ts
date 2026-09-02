import { describe, expect, it } from "vitest";

import * as surface from "../src/index.js";

/**
 * Pins the curated runtime surface of `@autostack/agent-native` (plan Task 12). The wrong
 * implementations this rejects: an accidental export landing unnoticed (a convenience `export *`
 * over `native-session.ts`, `harness-config.ts`, or the prompts module) and an internal helper
 * leaking (session engine internals, repository-context plumbing, prompt-render utilities) —
 * either becomes a failing diff here instead of a review catch. Type-only exports do not exist
 * at runtime, so this list is exactly what `Object.keys` yields; every change to it is a
 * deliberate public-surface change, reviewed as one.
 */
const EXPECTED_RUNTIME_SURFACE: readonly string[] = [
  "MODEL_ROUTING_FAILURE_CLASSIFICATIONS",
  "NATIVE_AGENT_FAILURES",
  "NATIVE_AGENT_ROLES",
  "NATIVE_PROMPTS",
  "NATIVE_ROLE_CONFIGS",
  "NativeAgentError",
  "PLAN_ROLE_CONFIG",
  "PROMPT_DIGESTS",
  "PROMPT_SAMPLE_INPUTS",
  "REVIEW_ROLE_CONFIG",
  "TRIAGE_ROLE_CONFIG",
  "admitPlanEvidence",
  "admitReviewEvidence",
  "admitStructuredOutput",
  "admitTriageEvidence",
  "assembleContext",
  "classifyThrowable",
  "createNativeHarness",
  "digestPlanEvidence",
  "digestReviewEvidence",
  "digestTriageEvidence",
  "isPathInScope",
  "isReviewRoleDocuments"
];

describe("@autostack/agent-native public surface", () => {
  it("exports exactly the checked-in curated runtime surface (rejects an accidental export or a leaked internal helper)", () => {
    expect(Object.keys(surface).sort()).toEqual([...EXPECTED_RUNTIME_SURFACE].sort());
  });

  it("keeps the checked-in list itself sorted, so the diff of a surface change is canonical", () => {
    expect([...EXPECTED_RUNTIME_SURFACE].sort()).toEqual(EXPECTED_RUNTIME_SURFACE);
  });
});
