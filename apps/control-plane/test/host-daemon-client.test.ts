import { describe, expect, it, vi } from "vitest";

import { CancelCommandRequestSchema, ReadCommandEventsRequestSchema } from "@autostack/contracts";

import { createHostDaemonClient } from "../src/host-daemon-client.js";

import {
  localExecutionRequests,
  preparedEnvironmentFor
} from "./fixtures/seed-approved-run.js";

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

  it("rejects an event stream that arrives with the wrong media type and drains its body", async () => {
    let cancelled = false;
    const client = createHostDaemonClient({
      origin: "http://127.0.0.1:4319",
      token: TOKEN,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{}\n"));
            },
            cancel() {
              cancelled = true;
            }
          }),
          { headers: { "content-type": "application/json" } }
        )
    });

    const consume = async () => {
      for await (const _item of client.openCommandEvents(
        ReadCommandEventsRequestSchema.parse({ ...IDS, after: 0 })
      ))
        void _item;
    };

    await expect(consume()).rejects.toThrow(/invalid host response/i);
    expect(cancelled).toBe(true);
  });
});

describe("HostDaemonClient construction limits", () => {
  const fetch: typeof globalThis.fetch = async () => new Response("{}");

  it.each([
    ["maximumJsonBytes", 0],
    ["maximumEventFrameBytes", -1],
    ["safeReadAttempts", 1.5]
  ])("rejects a non-positive-integer %s limit", (key, value) => {
    expect(() =>
      createHostDaemonClient({
        origin: "http://127.0.0.1:4319",
        token: TOKEN,
        fetch,
        [key]: value
      } as never)
    ).toThrow(/Invalid host client limit/);
  });

  it.each(["short", "change-me", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"])(
    "rejects a low-entropy or placeholder host token %s",
    (token) => {
      expect(() =>
        createHostDaemonClient({ origin: "http://127.0.0.1:4319", token, fetch })
      ).toThrow(/Host token is invalid/);
    }
  );
});

describe("HostDaemonClient routed calls", () => {
  const client = (fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) =>
    createHostDaemonClient({
      origin: "http://127.0.0.1:4319",
      token: TOKEN,
      fetch,
      sleep: async () => undefined,
      ...overrides
    });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });

  it("lists environments over an authenticated safe GET", async () => {
    const paths: string[] = [];
    const listing = { items: [] };

    await expect(
      client(async (input) => {
        paths.push(String(input));
        return json(listing);
      }).listEnvironments()
    ).resolves.toEqual(listing);
    expect(paths).toEqual(["http://127.0.0.1:4319/v1/environments"]);
  });

  it("inspects a repository over an authenticated POST carrying the request body", async () => {
    let sentBody: unknown;
    const inspection = {
      repositoryIdentity: "local-sha256:" + "d".repeat(64),
      canonicalSourcePath: "/repo",
      repositoryCommonDirectory: "/repo/.git",
      resolvedBaseRef: "main",
      sourceCommit: "b".repeat(40),
      dirty: false,
      diagnostics: []
    };

    await expect(
      client(async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as unknown;
        return json(inspection);
      }).inspectRepository({ sourcePath: "/repo", baseRef: "main" } as never)
    ).resolves.toEqual(inspection);
    expect(sentBody).toEqual({ sourcePath: "/repo", baseRef: "main" });
  });

  it("prepares an environment and admits only a response bound to the requested identity", async () => {
    const { prepare, identity } = await localExecutionRequests(800);
    const environment = preparedEnvironmentFor(identity).environment;

    await expect(
      client(async () => json({ environment, replayed: false }, 202)).prepareEnvironment(prepare)
    ).resolves.toEqual({ environment, replayed: false });
  });

  it("refuses a prepared-environment response describing a different environment", async () => {
    const { prepare, identity } = await localExecutionRequests(801);
    const other = (await localExecutionRequests(802)).identity;
    const environment = preparedEnvironmentFor(other).environment;
    void identity;

    await expect(
      client(async () => json({ environment, replayed: false }, 202)).prepareEnvironment(prepare)
    ).rejects.toThrow(/invalid host response/i);
  });

  it("never retries a start command, even against a retryable host status", async () => {
    const { start } = await localExecutionRequests(803);
    let attempts = 0;

    await expect(
      client(async () => {
        attempts += 1;
        return json({ error: "unavailable" }, 503);
      }).startCommand(start)
    ).rejects.toThrow(/invalid host response/i);
    expect(attempts).toBe(1);
  });

  it("accepts a started command whose acceptance names the requested command", async () => {
    const { start } = await localExecutionRequests(804);
    const accepted = {
      commandId: start.commandId,
      acceptedAt: "2026-08-21T12:00:00.000Z",
      replayed: false
    };

    await expect(
      client(async () => json(accepted, 202)).startCommand(start)
    ).resolves.toEqual(accepted);
  });

  it("requests an artifact range with a byte Range header and unwraps the chunk", async () => {
    const artifact = {
      artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
      workspaceId: IDS.workspaceId,
      runId: IDS.runId,
      commandId: IDS.commandId,
      kind: "command_transcript",
      mediaType: "text/plain; charset=utf-8",
      digest: "c".repeat(64),
      byteSize: 1,
      createdAt: "2026-08-21T12:00:00.000Z"
    };
    const chunk = { artifact, offset: 0, bytes: "eA==", nextOffset: 1, done: true };
    let rangeHeader: string | null = null;
    let requestedUrl = "";

    await expect(
      client(async (input, init) => {
        requestedUrl = String(input);
        rangeHeader = new Headers(init?.headers).get("range");
        return json({ contentType: artifact.mediaType, chunk }, 206);
      }).readArtifactRange({
        ...IDS,
        artifactId: artifact.artifactId,
        offset: 0,
        length: 16
      } as never)
    ).resolves.toEqual(chunk);
    expect(rangeHeader).toBe("bytes=0-15");
    expect(requestedUrl).toContain(`environmentId=${IDS.environmentId}`);
    expect(requestedUrl).toContain(`commandId=${IDS.commandId}`);
  });

  it("disposes an environment over an authenticated DELETE", async () => {
    const response = { environmentId: IDS.environmentId, disposed: true, replayed: false };
    let method: string | undefined;

    await expect(
      client(async (_input, init) => {
        method = init?.method;
        return json(response);
      }).disposeEnvironment({
        workspaceId: IDS.workspaceId,
        runId: IDS.runId,
        environmentId: IDS.environmentId,
        environmentAuthorizationId: IDS.environmentAuthorizationId,
        environmentAuthorizationDigest: IDS.environmentAuthorizationDigest,
        terminalRunEvidence: {
          status: "completed",
          terminalEventSequence: 4,
          terminalEventDigest: "e".repeat(64)
        },
        idempotency: { key: "dispose-1" }
      } as never)
    ).resolves.toEqual(response);
    expect(method).toBe("DELETE");
  });

  it("retries a safe read past a transport failure and returns the eventual body", async () => {
    let attempts = 0;

    await expect(
      client(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("private transport failure");
        return json({ items: [] });
      }).listEnvironments()
    ).resolves.toEqual({ items: [] });
    expect(attempts).toBe(3);
  });

  it("retries a safe read past a retryable host status and returns the eventual body", async () => {
    let attempts = 0;

    await expect(
      client(async () => {
        attempts += 1;
        return attempts === 1 ? json({ error: "unavailable" }, 503) : json({ items: [] });
      }).listEnvironments()
    ).resolves.toEqual({ items: [] });
    expect(attempts).toBe(2);
  });

  it("exhausts the safe-read budget and reports an invalid host response", async () => {
    let attempts = 0;

    await expect(
      client(
        async () => {
          attempts += 1;
          throw new Error("private transport failure");
        },
        { safeReadAttempts: 2 }
      ).listEnvironments()
    ).rejects.toThrow(/invalid host response/i);
    expect(attempts).toBe(2);
  });

  it("propagates a caller abort instead of retrying the safe read", async () => {
    const controller = new AbortController();
    let attempts = 0;

    await expect(
      client(async () => {
        attempts += 1;
        controller.abort();
        throw new Error("aborted by caller");
      }).listEnvironments({ signal: controller.signal })
    ).rejects.toThrow(/aborted by caller/);
    expect(attempts).toBe(1);
  });

  it("reports an empty host body as an invalid response rather than parsing it", async () => {
    await expect(
      client(async () => new Response("", { headers: { "content-type": "application/json" } }))
        .listEnvironments()
    ).rejects.toThrow(/invalid host response/i);
  });
});
