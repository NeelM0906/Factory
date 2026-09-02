/**
 * Tests for the Codex JSON-RPC client.
 *
 * Verifies request/response correlation, concurrent in-flight requests,
 * notification routing, unknown response handling, and close() rejection.
 *
 * WIRE SHAPE: Codex app-server responses carry NO `jsonrpc` member.
 * Responses are {id, result} and notifications are {method, params, emittedAtMs}.
 */

import { describe, expect, it } from "vitest";

import {
  CodexJsonRpcClient,
  type CodexNotification
} from "../src/codex-jsonrpc.js";

/** A simple writable sink that collects lines. */
const createSink = () => {
  const lines: string[] = [];
  const write = async (data: string): Promise<void> => {
    lines.push(data);
  };
  return { lines, write };
};

describe("codex-jsonrpc", () => {
  describe("request/response correlation", () => {
    it("resolves a request when a matching response arrives", async () => {
      const sink = createSink();
      const client = new CodexJsonRpcClient(sink.write);

      const pending = client.request("initialize", {});

      // Parse the outbound request to get the id
      const sent = JSON.parse(sink.lines[0]!);
      expect(sent.jsonrpc).toBe("2.0");
      expect(sent.method).toBe("initialize");
      expect(typeof sent.id).toBe("number");

      // Feed the response (Codex shape: no jsonrpc member)
      client.handleFrame({ id: sent.id, result: { ready: true } });

      const result = await pending;
      expect(result).toEqual({ ready: true });
    });

    it("rejects a request when an error response arrives", async () => {
      const sink = createSink();
      const client = new CodexJsonRpcClient(sink.write);

      const pending = client.request("thread/start", {});
      const sent = JSON.parse(sink.lines[0]!);

      client.handleFrame({
        id: sent.id,
        error: { code: -32600, message: "Invalid request" }
      });

      await expect(pending).rejects.toThrow(/Invalid request/);
    });
  });

  describe("concurrent in-flight requests", () => {
    it("resolves each request to the correct response", async () => {
      const sink = createSink();
      const client = new CodexJsonRpcClient(sink.write);

      const p1 = client.request("initialize", {});
      const p2 = client.request("thread/start", { prompt: "hello" });

      const sent1 = JSON.parse(sink.lines[0]!);
      const sent2 = JSON.parse(sink.lines[1]!);

      // Respond in reverse order
      client.handleFrame({ id: sent2.id, result: { thread: "t1" } });
      client.handleFrame({ id: sent1.id, result: { ready: true } });

      expect(await p1).toEqual({ ready: true });
      expect(await p2).toEqual({ thread: "t1" });
    });
  });

  describe("notification routing", () => {
    it("routes notifications to the handler without a response", () => {
      const sink = createSink();
      const notifications: CodexNotification[] = [];
      const client = new CodexJsonRpcClient(sink.write, (n) => notifications.push(n));

      client.handleFrame({
        method: "item/started",
        params: { item: { type: "agentMessage" } },
        emittedAtMs: 123456
      });

      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.method).toBe("item/started");
    });
  });

  describe("unknown response handling", () => {
    it("ignores a response to an unknown id without throwing", () => {
      const sink = createSink();
      const client = new CodexJsonRpcClient(sink.write);

      // Should not throw
      expect(() => {
        client.handleFrame({ id: 999, result: { spurious: true } });
      }).not.toThrow();
    });
  });

  describe("close()", () => {
    it("rejects every in-flight request", async () => {
      const sink = createSink();
      const client = new CodexJsonRpcClient(sink.write);

      const p1 = client.request("initialize", {});
      const p2 = client.request("thread/start", {});

      client.close();

      await expect(p1).rejects.toThrow(/closed/);
      await expect(p2).rejects.toThrow(/closed/);
    });

    it("rejects subsequent requests", async () => {
      const sink = createSink();
      const client = new CodexJsonRpcClient(sink.write);

      client.close();

      await expect(
        client.request("initialize", {})
      ).rejects.toThrow(/closed/);
    });
  });
});
