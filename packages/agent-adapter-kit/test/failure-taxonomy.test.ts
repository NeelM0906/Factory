import { describe, expect, it } from "vitest";

import { normalizeWorkflowFailureCode } from "@autostack/contracts";

import {
  FAILURE_TAXONOMY,
  classifyFailure,
  type TaxonomyCode
} from "../src/failure-taxonomy.js";

describe("failure taxonomy", () => {
  it("every code is admitted unchanged by normalizeWorkflowFailureCode (D-13)", () => {
    for (const code of Object.keys(FAILURE_TAXONOMY) as TaxonomyCode[]) {
      const normalized = normalizeWorkflowFailureCode(code);
      expect(normalized).toBe(code);
    }
  });

  it("every code has exactly one retryable value", () => {
    const seen = new Map<string, boolean>();
    for (const [code, entry] of Object.entries(FAILURE_TAXONOMY)) {
      expect(seen.has(code)).toBe(false);
      seen.set(code, entry.retryable);
    }
  });

  it("no code equals any message in the message table", () => {
    const codes = new Set(Object.keys(FAILURE_TAXONOMY));
    for (const entry of Object.values(FAILURE_TAXONOMY)) {
      expect(codes.has(entry.message)).toBe(false);
    }
  });

  describe("classifyFailure returns the expected taxonomy entry", () => {
    const expectedRetryable: Record<string, boolean> = {
      rate_limited: true,
      capability_unavailable: false,
      provider_unavailable: true,
      provider_internal_error: true,
      provider_execution_error: true,
      provider_timeout: true,
      provider_error: false,
      provider_protocol_invalid: false,
      provider_request_rejected: false,
      provider_output_malformed: false,
      provider_turn_limit: false,
      provider_unauthenticated: false,
      harness_not_installed: false,
      harness_launch_denied: false,
      harness_launch_failed: true,
      harness_child_exited: true
    };

    it("classifies every code with the expected retryable value", () => {
      for (const [code, retryable] of Object.entries(expectedRetryable)) {
        const result = classifyFailure(code as TaxonomyCode);
        expect(result.retryable).toBe(retryable);
        expect(result.code).toBe(code);
      }
    });
  });

  it("raw provider codes that look like our codes but with whitespace are refused", () => {
    expect(normalizeWorkflowFailureCode(" rate_limited")).toBeUndefined();
    expect(normalizeWorkflowFailureCode("rate_limited ")).toBeUndefined();
    expect(normalizeWorkflowFailureCode(" rate_limited ")).toBeUndefined();
  });

  it("raw provider codes with wrong casing are refused", () => {
    expect(normalizeWorkflowFailureCode("Rate_Limited")).toBeUndefined();
    expect(normalizeWorkflowFailureCode("RATE_LIMITED")).toBeUndefined();
  });

  it("raw JSON-RPC error codes (numbers as strings) are refused", () => {
    expect(normalizeWorkflowFailureCode("-32601")).toBeUndefined();
    expect(normalizeWorkflowFailureCode("-32700")).toBeUndefined();
  });

  it("provider-namespaced codes are refused", () => {
    expect(normalizeWorkflowFailureCode("provider.rate_limited")).toBeUndefined();
  });
});
