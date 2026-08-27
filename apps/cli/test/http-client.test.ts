import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AutoStackHttpClient,
  CliAuthenticationError,
  ControlPlaneUnavailableError
} from "../src/http-client.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const BASE_URL = "http://127.0.0.1:4318";

const healthy = {
  service: "autostack-control-plane",
  version: "0.1.0",
  status: "ok",
  storage: { status: "ok", journalMode: "wal", schemaVersion: 1 },
  executor: { status: "idle" }
};

const inspection = {
  repositoryIdentity: "github:example/repo",
  canonicalSourcePath: "/repo",
  repositoryCommonDirectory: "/repo/.git",
  resolvedBaseRef: "main",
  sourceCommit: "b".repeat(40),
  dirty: false,
  diagnostics: []
};

const client = (fetch: typeof globalThis.fetch, baseUrl = BASE_URL) =>
  new AutoStackHttpClient({ baseUrl, token: TOKEN, fetch });

const respondWith = (response: Response | (() => Response)) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    typeof response === "function" ? response() : response
  );

const call = (fetch: ReturnType<typeof respondWith>, index = 0) => {
  const [url, init] = fetch.mock.calls[index] ?? [];
  return { url: String(url), init: init ?? {}, headers: new Headers(init?.headers) };
};

const ndjson = (body: string, init: ResponseInit = {}) =>
  new Response(body, { headers: { "content-type": "application/x-ndjson" }, ...init });

const terminalOutput = (sequence: number, text: string) => ({
  type: "runner.event",
  event: {
    type: "terminal.output",
    workspaceId: `ws_${UUID}`,
    runId: `run_${UUID}`,
    commandId: `cmd_${UUID}`,
    sequence,
    occurredAt: "2026-08-23T12:00:00.000Z",
    stream: "pty",
    text
  }
});

const eventsRequest = { environmentId: `env_${UUID}`, commandId: `cmd_${UUID}`, after: 0 } as never;

const drain = async (stream: AsyncIterable<unknown>): Promise<unknown[]> => {
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  return items;
};

describe("AutoStackHttpClient health and runs", () => {
  it("reads health without an Authorization header and strips a trailing slash from the base URL", async () => {
    const fetch = respondWith(Response.json(healthy));

    expect(await client(fetch, `${BASE_URL}/`).health()).toMatchObject({ status: "ok" });
    expect(call(fetch).url).toBe(`${BASE_URL}/v1/health`);
    expect(call(fetch).headers.has("Authorization")).toBe(false);
  });

  it("accepts a 503 health response as a readable degraded report", async () => {
    const degraded = { ...healthy, status: "degraded" };
    const fetch = respondWith(Response.json(degraded, { status: 503 }));

    expect(await client(fetch).health()).toMatchObject({ status: "degraded" });
  });

  it("rejects any other health status as unavailable before decoding the body", async () => {
    const fetch = respondWith(Response.json(healthy, { status: 500 }));

    await expect(client(fetch).health()).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });

  it("rejects a health body the contract refuses", async () => {
    const fetch = respondWith(Response.json({ service: "autostack-control-plane" }));

    await expect(client(fetch).health()).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });

  it("sends the bearer token when listing runs", async () => {
    const fetch = respondWith(Response.json({ items: [] }));

    expect(await client(fetch).listRuns()).toEqual({ items: [] });
    expect(call(fetch).url).toBe(`${BASE_URL}/v1/runs`);
    expect(call(fetch).headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("distinguishes a rejected token from an unavailable control plane", async () => {
    const unauthorized = respondWith(Response.json({}, { status: 401 }));
    const broken = respondWith(Response.json({}, { status: 500 }));

    await expect(client(unauthorized).listRuns()).rejects.toBeInstanceOf(CliAuthenticationError);
    await expect(client(broken).listRuns()).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });

  it("maps a transport failure to unavailable without leaking the token", async () => {
    const fetch = vi.fn(async () => Promise.reject(new Error(`offline ${TOKEN}`)));

    const error = await client(fetch)
      .health()
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ControlPlaneUnavailableError);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe("AutoStackHttpClient local JSON routes", () => {
  it("posts an inspect request as authenticated JSON", async () => {
    const fetch = respondWith(Response.json(inspection));

    expect(
      await client(fetch).localInspect({ sourcePath: "/repo", baseRef: "main" } as never)
    ).toMatchObject({ repositoryIdentity: "github:example/repo" });
    const sent = call(fetch);
    expect(sent.url).toBe(`${BASE_URL}/v1/local/repositories/inspect`);
    expect(sent.init.method).toBe("POST");
    expect(sent.headers.get("Content-Type")).toBe("application/json");
    expect(sent.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(sent.init.body))).toEqual({ sourcePath: "/repo", baseRef: "main" });
  });

  it("lists environments with a GET that carries no body and no content type", async () => {
    const fetch = respondWith(Response.json({ items: [] }));

    expect(await client(fetch).localList()).toEqual({ items: [] });
    const sent = call(fetch);
    expect(sent.url).toBe(`${BASE_URL}/v1/local/environments`);
    expect(sent.init.method).toBe("GET");
    expect(sent.init.body).toBeUndefined();
    expect(sent.headers.has("Content-Type")).toBe(false);
  });

  it("carries the idempotency key on prepare and start, and only there", async () => {
    const prepare = respondWith(Response.json({}, { status: 500 }));
    const start = respondWith(
      Response.json({
        commandId: `cmd_${UUID}`,
        acceptedAt: "2026-08-23T12:00:00.000Z",
        replayed: false
      })
    );
    const cancel = respondWith(
      Response.json({ commandId: `cmd_${UUID}`, cancelled: true, replayed: false })
    );

    await expect(
      client(prepare).localPrepare({ environmentId: `env_${UUID}` } as never, "prepare-1")
    ).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
    expect(call(prepare).headers.get("Idempotency-Key")).toBe("prepare-1");

    await client(start).localStart({ environmentId: `env_${UUID}` } as never, "exec-1");
    expect(call(start).url).toBe(`${BASE_URL}/v1/local/environments/env_${UUID}/commands`);
    expect(call(start).headers.get("Idempotency-Key")).toBe("exec-1");

    await client(cancel).localCancel({
      environmentId: `env_${UUID}`,
      commandId: `cmd_${UUID}`
    } as never);
    expect(call(cancel).url).toBe(
      `${BASE_URL}/v1/local/environments/env_${UUID}/commands/cmd_${UUID}/cancel`
    );
    expect(call(cancel).headers.has("Idempotency-Key")).toBe(false);
  });

  it("percent-encodes identifiers into the artifact and dispose paths", async () => {
    const bytes = Buffer.from("hello");
    const artifactFetch = respondWith(
      Response.json({
        artifact: {
          artifactId: `art_${UUID}`,
          workspaceId: `ws_${UUID}`,
          runId: `run_${UUID}`,
          commandId: `cmd_${UUID}`,
          kind: "command_output",
          mediaType: "text/plain; charset=utf-8",
          digest: createHash("sha256").update(bytes).digest("hex"),
          byteSize: bytes.byteLength,
          createdAt: "2026-08-23T12:00:00.000Z"
        },
        offset: 0,
        bytes: bytes.toString("base64"),
        nextOffset: bytes.byteLength,
        done: true
      })
    );
    const disposeFetch = respondWith(
      Response.json({ environmentId: `env_${UUID}`, disposed: true, replayed: false })
    );

    expect(
      await client(artifactFetch).localArtifact({
        artifactId: "art/../secret",
        offset: 0,
        length: 1_048_576
      } as never)
    ).toMatchObject({ done: true });
    expect(call(artifactFetch).url).toBe(
      `${BASE_URL}/v1/local/artifacts/art%2F..%2Fsecret/content?offset=0&length=1048576`
    );
    expect(call(artifactFetch).init.method).toBe("GET");

    await client(disposeFetch).localDispose({ environmentId: `env_${UUID}` } as never);
    expect(call(disposeFetch).url).toBe(`${BASE_URL}/v1/local/environments/env_${UUID}`);
    expect(call(disposeFetch).init.method).toBe("DELETE");
  });

  it("maps 401 on a local route to an authentication error and a bad body to unavailable", async () => {
    const unauthorized = respondWith(Response.json({}, { status: 401 }));
    const garbled = respondWith(new Response("not-json"));

    await expect(
      client(unauthorized).localInspect({ sourcePath: "/repo", baseRef: "main" } as never)
    ).rejects.toBeInstanceOf(CliAuthenticationError);
    await expect(
      client(garbled).localInspect({ sourcePath: "/repo", baseRef: "main" } as never)
    ).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });
});

describe("AutoStackHttpClient local event stream", () => {
  it("yields one contract-valid frame per newline-delimited line", async () => {
    const fetch = respondWith(() =>
      ndjson(
        `${JSON.stringify(terminalOutput(1, "first"))}\n${JSON.stringify(terminalOutput(2, "second"))}\n`
      )
    );

    const items = await drain(client(fetch).localEvents(eventsRequest));

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ type: "runner.event", event: { text: "second" } });
    expect(call(fetch).url).toBe(
      `${BASE_URL}/v1/local/environments/env_${UUID}/commands/cmd_${UUID}/events?after=0`
    );
    expect(call(fetch).headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("releases the response reader when the consumer stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(terminalOutput(1, "a"))}\n`));
      },
      cancel() {
        cancelled = true;
      }
    });
    const fetch = respondWith(
      new Response(stream, { headers: { "content-type": "application/x-ndjson" } })
    );

    for await (const item of client(fetch).localEvents(eventsRequest)) {
      expect(item).toMatchObject({ type: "runner.event" });
      break;
    }

    expect(cancelled).toBe(true);
  });

  it.each([
    ["a non-OK status", () => ndjson("", { status: 500 })],
    ["a non-NDJSON content type", () => Response.json({ type: "runner.event" })],
    [
      "a response with no body",
      () => new Response(null, { headers: { "content-type": "application/x-ndjson" } })
    ]
  ])("refuses %s before reading any frame", async (_label, response) => {
    const fetch = respondWith(response);

    await expect(drain(client(fetch).localEvents(eventsRequest))).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError
    );
  });

  it.each([
    ["a blank line", "\n"],
    ["a carriage-return terminated line", `${JSON.stringify(terminalOutput(1, "a"))}\r\n`],
    ["a line the frame contract refuses", '{"type":"runner.event"}\n'],
    ["a line that is not JSON", "not-json\n"],
    ["a trailing line with no newline", JSON.stringify(terminalOutput(1, "a"))],
    ["an unterminated line beyond the buffer ceiling", "a".repeat(1_048_577)]
  ])("refuses %s", async (_label, body) => {
    const fetch = respondWith(() => ndjson(body));

    await expect(drain(client(fetch).localEvents(eventsRequest))).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError
    );
  });

  it("refuses a stream whose bytes are not valid UTF-8", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xfe, 0x0a]));
        controller.close();
      }
    });
    const fetch = respondWith(
      new Response(stream, { headers: { "content-type": "application/x-ndjson" } })
    );

    await expect(drain(client(fetch).localEvents(eventsRequest))).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError
    );
  });
});
