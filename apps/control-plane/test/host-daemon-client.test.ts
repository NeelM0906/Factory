import { describe, expect, it, vi } from "vitest";

import { CancelCommandRequestSchema, ReadCommandEventsRequestSchema } from "@autostack/contracts";

import { createHostDaemonClient } from "../src/host-daemon-client.js";

const TOKEN = "host-token-0123456789abcdef0123456789abcdef";
const IDS = {
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000",
  environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
  commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
  environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
  environmentAuthorizationDigest: "a".repeat(64),
  commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
  commandAuthorizationDigest: "b".repeat(64)
} as const;

const capabilities = {
  runnerId: "runner-local",
  version: "1.0.0",
  platform: { os: "darwin", architecture: "arm64" },
  pty: true,
  cancellation: true,
  filesystemDisclosure: "host_user",
  maximumBytes: { liveOutput: 1024, replay: 1024, transcript: 1024, artifact: 1024 },
  supportedNetworkPolicies: ["host"],
  enforcement: {
    cpu: "advisory",
    memory: "advisory",
    duration: "hard",
    autostackPathOperations: "hard",
    childFilesystem: "advisory",
    network: "unavailable"
  }
} as const;

describe("HostDaemonClient", () => {
  it.each([
    "http://localhost:4319",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "https://127.0.0.1:4319",
    "http://127.0.0.1:4319/path",
    "http://user@127.0.0.1:4319"
  ])("rejects noncanonical host origin %s before fetch", (origin) => {
    const fetch = vi.fn();
    expect(() => createHostDaemonClient({ origin, token: TOKEN, fetch })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("authenticates a fixed bounded health request without exposing a generic request", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store"
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      return Response.json(
        { service: "autostack-host-daemon", version: "1.0.0", status: "ok", capabilities },
        { headers: { "content-type": "application/json" } }
      );
    });
    const client = createHostDaemonClient({
      origin: "http://127.0.0.1:4319",
      token: TOKEN,
      fetch
    });

    await expect(client.health()).resolves.toMatchObject({ status: "ok" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(client)).not.toContain("request");
  });

  it("bounds JSON before parsing and never retries mutations", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ignored: "x".repeat(300) }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createHostDaemonClient({
      origin: "http://127.0.0.1:4319",
      token: TOKEN,
      fetch,
      maximumJsonBytes: 64,
      safeReadAttempts: 2,
      sleep: async () => undefined
    });

    await expect(
      client.cancelCommand(
        CancelCommandRequestSchema.parse({ ...IDS, idempotency: { key: "cancel-1" } })
      )
    ).rejects.toThrow(/invalid host response/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("admits strict ordered NDJSON and closes on a lag terminal", async () => {
    const frames = [
      {
        type: "runner.event",
        event: {
          type: "command.started",
          workspaceId: IDS.workspaceId,
          runId: IDS.runId,
          commandId: IDS.commandId,
          sequence: 1,
          occurredAt: "2026-08-21T12:00:00.000Z",
          pty: true
        }
      },
      { type: "subscription.lagged", lastDurableSequence: 1, resumeCursor: 1 }
    ];
    const bytes = new TextEncoder().encode(
      `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`
    );
    const requestedUrls: string[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 17));
            controller.enqueue(bytes.slice(17));
            controller.close();
          }
        }),
        { headers: { "content-type": "application/x-ndjson" } }
      );
    });
    const client = createHostDaemonClient({
      origin: "http://127.0.0.1:4319",
      token: TOKEN,
      fetch
    });

    const received = [];
    for await (const item of client.openCommandEvents(
      ReadCommandEventsRequestSchema.parse({ ...IDS, after: 0 })
    ))
      received.push(item);
    expect(received).toEqual(frames);
    expect(requestedUrls[0]).toContain("after=0");
  });

  it("rejects CRLF, unterminated, oversized, and token-bearing event frames", async () => {
    const invalidBodies = [
      "{}\r\n",
      "{}",
      `${"x".repeat(65)}\n`,
      `${JSON.stringify({ value: TOKEN })}\n`
    ];
    for (const body of invalidBodies) {
      const client = createHostDaemonClient({
        origin: "http://127.0.0.1:4319",
        token: TOKEN,
        maximumEventFrameBytes: 64,
        fetch: async () =>
          new Response(body, { headers: { "content-type": "application/x-ndjson" } })
      });
      const consume = async () => {
        for await (const _item of client.openCommandEvents(
          ReadCommandEventsRequestSchema.parse({ ...IDS, after: 0 })
        ))
          void _item;
      };
      await expect(consume()).rejects.toThrow(/invalid host response/i);
    }
  });
});
