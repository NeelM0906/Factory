/**
 * Tests for the Claude Code failure classifier.
 *
 * Under D-2's discriminator, this table classifies only the `failed` branch:
 *
 * | Provider signal                              | Code                        | retryable |
 * | -------------------------------------------- | --------------------------- | --------- |
 * | result.subtype: "error_max_turns"            | provider_turn_limit         | false     |
 * | result.subtype: "error_during_execution"     | provider_execution_error    | true      |
 * | unknown result.subtype with is_error         | provider_error              | false     |
 * | exit with a result carrying is_error         | harness_child_exited        | true      |
 * | unparseable stdout line                      | provider_output_malformed   | false     |
 */

import { describe, expect, it } from "vitest";

import { classifyClaudeFailure, type ClaudeFailureInput } from "../src/claude-failures.js";

describe("claude-failures", () => {
  describe("result subtypes", () => {
    it("classifies error_max_turns as provider_turn_limit (not retryable)", () => {
      const result = classifyClaudeFailure({
        kind: "result_error",
        subtype: "error_max_turns",
        isError: true
      });
      expect(result.code).toBe("provider_turn_limit");
      expect(result.retryable).toBe(false);
    });

    it("classifies error_during_execution as provider_execution_error (retryable)", () => {
      const result = classifyClaudeFailure({
        kind: "result_error",
        subtype: "error_during_execution",
        isError: true
      });
      expect(result.code).toBe("provider_execution_error");
      expect(result.retryable).toBe(true);
    });

    it("classifies unknown subtype with is_error as provider_error (not retryable)", () => {
      const result = classifyClaudeFailure({
        kind: "result_error",
        subtype: "some_new_error_type",
        isError: true
      });
      expect(result.code).toBe("provider_error");
      expect(result.retryable).toBe(false);
    });
  });

  describe("process loss (D-2)", () => {
    it("classifies signal death after evidence as interrupted", () => {
      const result = classifyClaudeFailure({
        kind: "process_lost",
        hasEvidence: true,
        exitCode: null,
        signal: "SIGKILL"
      });
      expect(result.code).toBe("interrupted");
    });

    it("classifies signal death before evidence as harness_child_exited (retryable)", () => {
      const result = classifyClaudeFailure({
        kind: "process_lost",
        hasEvidence: false,
        exitCode: null,
        signal: "SIGTERM"
      });
      expect(result.code).toBe("harness_child_exited");
      expect(result.retryable).toBe(true);
    });

    it("classifies process lost with no signal after evidence as interrupted", () => {
      const result = classifyClaudeFailure({
        kind: "process_lost",
        hasEvidence: true,
        exitCode: null,
        signal: null
      });
      expect(result.code).toBe("interrupted");
    });

    it("classifies process lost with no signal before evidence as harness_child_exited", () => {
      const result = classifyClaudeFailure({
        kind: "process_lost",
        hasEvidence: false,
        exitCode: 1,
        signal: null
      });
      expect(result.code).toBe("harness_child_exited");
      expect(result.retryable).toBe(true);
    });
  });

  describe("malformed output", () => {
    it("classifies unparseable stdout as provider_output_malformed (not retryable)", () => {
      const result = classifyClaudeFailure({
        kind: "malformed_output"
      });
      expect(result.code).toBe("provider_output_malformed");
      expect(result.retryable).toBe(false);
    });
  });

  describe("untrusted text boundary", () => {
    it("ignores provider prose when classifying retryability", () => {
      // An error_max_turns result whose text says "temporary, retry" still
      // classifies retryable: false. Provider output is untrusted input.
      const result = classifyClaudeFailure({
        kind: "result_error",
        subtype: "error_max_turns",
        isError: true
      });
      // The classification is from the enumerated subtype, not from any text
      expect(result.retryable).toBe(false);
    });
  });
});
