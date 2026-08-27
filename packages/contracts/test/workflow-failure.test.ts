import { describe, expect, it } from "vitest";

import {
  WorkflowFailureCodeSchema,
  normalizeWorkflowFailureCode
} from "../src/workflow-failure.js";

describe("workflow failure code normalization", () => {
  it("passes an exact member of the alphabet through unchanged", () => {
    for (const code of ["rate_limited", "provider_error", "a", "a".repeat(64)]) {
      expect(normalizeWorkflowFailureCode(code)).toBe(code);
    }
  });

  it("rejects every code that would need a transformation to be accepted", () => {
    for (const code of [
      " rate_limited",
      "rate_limited ",
      "RATE_LIMITED",
      "provider.rate_limited",
      "provider-rate-limited",
      "-32601",
      "1_rate_limited",
      "",
      "a".repeat(65)
    ]) {
      expect(normalizeWorkflowFailureCode(code)).toBeUndefined();
    }
  });

  it("is stricter than the schema exactly where the schema trims", () => {
    // The schema itself accepts " rate_limited" — it trims first, and then the regex passes. The
    // helper must not inherit that: a code the pipeline stream never saw cannot be conjured by
    // whitespace, so acceptance is unchanged-acceptance, not parse-success.
    expect(WorkflowFailureCodeSchema.safeParse(" rate_limited")).toMatchObject({
      success: true,
      data: "rate_limited"
    });
    expect(normalizeWorkflowFailureCode(" rate_limited")).toBeUndefined();
  });

  it("returns a value the schema and the failure record both already accept", () => {
    const normalized = normalizeWorkflowFailureCode("provider_error");
    expect(normalized).toBeDefined();
    if (normalized === undefined) throw new TypeError("unreachable");
    expect(WorkflowFailureCodeSchema.parse(normalized)).toBe(normalized);
  });
});
