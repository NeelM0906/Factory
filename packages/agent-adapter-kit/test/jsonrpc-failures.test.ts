import { describe, expect, it } from "vitest";

import { normalizeWorkflowFailureCode } from "@autostack/contracts";

import { classifyJsonRpcError, type JsonRpcError } from "../src/jsonrpc-failures.js";

const makeError = (code: number, message?: string): JsonRpcError => ({
  code,
  message: message ?? "test error"
});

describe("classifyJsonRpcError", () => {
  describe("JSON-RPC standard codes", () => {
    it("maps -32700 (parse error) to provider_protocol_invalid", () => {
      const result = classifyJsonRpcError(makeError(-32700));
      expect(result.code).toBe("provider_protocol_invalid");
      expect(result.retryable).toBe(false);
    });

    it("maps -32600 (invalid request) to provider_protocol_invalid", () => {
      const result = classifyJsonRpcError(makeError(-32600));
      expect(result.code).toBe("provider_protocol_invalid");
      expect(result.retryable).toBe(false);
    });

    it("maps -32601 (method not found) to capability_unavailable", () => {
      const result = classifyJsonRpcError(makeError(-32601));
      expect(result.code).toBe("capability_unavailable");
      expect(result.retryable).toBe(false);
    });

    it("maps -32602 (invalid params) to provider_request_rejected", () => {
      const result = classifyJsonRpcError(makeError(-32602));
      expect(result.code).toBe("provider_request_rejected");
      expect(result.retryable).toBe(false);
    });

    it("maps -32603 (internal error) to provider_internal_error", () => {
      const result = classifyJsonRpcError(makeError(-32603));
      expect(result.code).toBe("provider_internal_error");
      expect(result.retryable).toBe(true);
    });
  });

  describe("server error range (-32000 to -32099)", () => {
    it("maps -32000 to provider_unavailable", () => {
      const result = classifyJsonRpcError(makeError(-32000));
      expect(result.code).toBe("provider_unavailable");
      expect(result.retryable).toBe(true);
    });

    it("maps -32099 to provider_unavailable", () => {
      const result = classifyJsonRpcError(makeError(-32099));
      expect(result.code).toBe("provider_unavailable");
      expect(result.retryable).toBe(true);
    });

    it("maps -32050 (middle of range) to provider_unavailable", () => {
      const result = classifyJsonRpcError(makeError(-32050));
      expect(result.code).toBe("provider_unavailable");
      expect(result.retryable).toBe(true);
    });
  });

  describe("any other numeric code falls through to provider_error", () => {
    it("maps 0 to provider_error", () => {
      const result = classifyJsonRpcError(makeError(0));
      expect(result.code).toBe("provider_error");
      expect(result.retryable).toBe(false);
    });

    it("maps -1 to provider_error", () => {
      const result = classifyJsonRpcError(makeError(-1));
      expect(result.code).toBe("provider_error");
      expect(result.retryable).toBe(false);
    });

    it("maps 42 to provider_error", () => {
      const result = classifyJsonRpcError(makeError(42));
      expect(result.code).toBe("provider_error");
      expect(result.retryable).toBe(false);
    });
  });

  describe("classification reads only error.code, never error.message", () => {
    it("two errors with identical codes but wildly different messages classify identically", () => {
      const a = classifyJsonRpcError(makeError(-32602, "missing parameter 'foo'"));
      const b = classifyJsonRpcError(makeError(-32602, "rate limited, please retry"));

      expect(a.code).toBe(b.code);
      expect(a.retryable).toBe(b.retryable);
    });

    it("an error whose message says 'rate limited, please retry' under -32602 is NOT retryable", () => {
      const result = classifyJsonRpcError(
        makeError(-32602, "rate limited, please retry")
      );
      expect(result.retryable).toBe(false);
    });
  });

  describe("the output is valid against WorkflowFailureCodeSchema for every code", () => {
    it("every classified code passes normalizeWorkflowFailureCode unchanged", () => {
      // Test a broad range of JSON-RPC error codes
      const codes = [
        -32700, -32600, -32601, -32602, -32603,
        -32000, -32001, -32050, -32098, -32099,
        0, -1, 1, 42, -100, 100, -32100, -31999, 999
      ];

      for (const code of codes) {
        const result = classifyJsonRpcError(makeError(code));
        const normalized = normalizeWorkflowFailureCode(result.code);
        expect(normalized).toBe(result.code);
      }
    });

    it("raw -32601 can never reach failed.code — it is always mapped", () => {
      const result = classifyJsonRpcError(makeError(-32601));
      expect(result.code).not.toBe("-32601");
      expect(result.code).toBe("capability_unavailable");
    });
  });
});
