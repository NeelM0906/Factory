/**
 * Tests for Codex failure classification.
 *
 * Codex app-server is JSON-RPC, so the kit's JSON-RPC table applies.
 * Additional classifications:
 * - ErrorNotification → provider_execution_error (retryable: true)
 * - Turn interruption → cancelled, not failed
 * - D-2: process loss after evidence → interrupted
 */

import { describe, expect, it } from "vitest";

import {
  classifyCodexFailure,
  type CodexFailureInput
} from "../src/codex-failures.js";

describe("codex-failures", () => {
  describe("JSON-RPC error codes", () => {
    it("maps -32600 (Invalid Request) to provider_protocol_invalid", () => {
      const result = classifyCodexFailure({
        kind: "jsonrpc_error",
        code: -32600,
        message: "Invalid request"
      });
      expect(result.code).toBe("provider_protocol_invalid");
      expect(result.retryable).toBe(false);
    });

    it("maps -32601 (Method Not Found) to capability_unavailable", () => {
      const result = classifyCodexFailure({
        kind: "jsonrpc_error",
        code: -32601,
        message: "Method not found"
      });
      expect(result.code).toBe("capability_unavailable");
      expect(result.retryable).toBe(false);
    });

    it("maps -32603 (Internal Error) to provider_internal_error", () => {
      const result = classifyCodexFailure({
        kind: "jsonrpc_error",
        code: -32603,
        message: "Internal error"
      });
      expect(result.code).toBe("provider_internal_error");
      expect(result.retryable).toBe(true);
    });

    it("maps server error range to provider_unavailable", () => {
      const result = classifyCodexFailure({
        kind: "jsonrpc_error",
        code: -32000,
        message: "Server error"
      });
      expect(result.code).toBe("provider_unavailable");
      expect(result.retryable).toBe(true);
    });
  });

  describe("ErrorNotification", () => {
    it("maps to provider_execution_error with retryable true", () => {
      const result = classifyCodexFailure({
        kind: "error_notification",
        message: "Turn failed"
      });
      expect(result.code).toBe("provider_execution_error");
      expect(result.retryable).toBe(true);
    });
  });

  describe("process loss (D-2)", () => {
    it("maps signal death with evidence to interrupted", () => {
      const result = classifyCodexFailure({
        kind: "process_lost",
        hasEvidence: true,
        exitCode: null,
        signal: "SIGKILL"
      });
      expect(result.code).toBe("interrupted");
    });

    it("maps signal death without evidence to harness_child_exited", () => {
      const result = classifyCodexFailure({
        kind: "process_lost",
        hasEvidence: false,
        exitCode: null,
        signal: "SIGKILL"
      });
      expect(result.code).toBe("harness_child_exited");
      expect(result.retryable).toBe(true);
    });

    it("maps non-zero exit without evidence to harness_child_exited", () => {
      const result = classifyCodexFailure({
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
    it("maps to provider_output_malformed", () => {
      const result = classifyCodexFailure({
        kind: "malformed_output"
      });
      expect(result.code).toBe("provider_output_malformed");
      expect(result.retryable).toBe(false);
    });
  });
});
