import { describe, expect, it } from "vitest";

import { classifyAcpFailure, type AcpFailureInput } from "../src/acp-failures.js";

describe("classifyAcpFailure", () => {
  describe("JSON-RPC error codes (reuses the kit's table)", () => {
    it("maps -32601 to capability_unavailable", () => {
      const result = classifyAcpFailure({
        kind: "jsonrpc_error",
        error: { code: -32601, message: "Method not found" }
      });
      expect(result.code).toBe("capability_unavailable");
    });

    it("maps -32603 to provider_internal_error", () => {
      const result = classifyAcpFailure({
        kind: "jsonrpc_error",
        error: { code: -32603, message: "Internal error" }
      });
      expect(result.code).toBe("provider_internal_error");
      expect(result.retryable).toBe(true);
    });
  });

  describe("ACP-specific cases", () => {
    it("maps auth-required error to provider_unauthenticated", () => {
      const result = classifyAcpFailure({
        kind: "auth_required"
      });
      expect(result.code).toBe("provider_unauthenticated");
      expect(result.retryable).toBe(false);
    });

    it("maps session/cancel acknowledgement to cancelled (not failed)", () => {
      const result = classifyAcpFailure({
        kind: "cancelled"
      });
      expect(result.code).toBe("cancelled");
    });
  });

  describe("D-2 discriminator: process loss", () => {
    it("SIGKILL after emitting evidence yields interrupted", () => {
      const result = classifyAcpFailure({
        kind: "process_lost",
        hasEvidence: true,
        exitCode: null,
        signal: "SIGKILL"
      });
      expect(result.code).toBe("interrupted");
    });

    it("death before any event yields harness_child_exited", () => {
      const result = classifyAcpFailure({
        kind: "process_lost",
        hasEvidence: false,
        exitCode: null,
        signal: "SIGKILL"
      });
      expect(result.code).toBe("harness_child_exited");
      expect(result.retryable).toBe(true);
    });

    it("non-zero exit after a JSON-RPC error frame yields failed", () => {
      const result = classifyAcpFailure({
        kind: "jsonrpc_error",
        error: { code: -32603, message: "Internal error" }
      });
      expect(result.code).toBe("provider_internal_error");
    });
  });
});
