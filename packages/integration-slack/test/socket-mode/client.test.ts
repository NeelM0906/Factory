import { describe, expect, it, vi } from "vitest";

import { SlackRequestError } from "../../src/errors.js";
import {
  createSocketModeClient,
  type SocketModeDependencies
} from "../../src/socket-mode/client.js";
import { createMemoryIngressQueue } from "../../src/socket-mode/queue.js";
import { createGlobalWebSocketFactory, type SocketLike } from "../../src/socket-mode/transport.js";

type ListenerType = "open" | "message" | "close" | "error";

/** A scripted fake socket the tests dispatch events on directly -- no real network involved. */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<ListenerType, Array<(event: unknown) => void>>();

  constructor(private readonly onSend?: (data: string) => void) {}

  send(data: string): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  addEventListener(type: ListenerType, listener: (event: never) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener as (event: unknown) => void);
    this.listeners.set(type, existing);
  }

  /**
   * Dispatches to every listener and awaits whatever they return.
   *
   * The awaiting matters for decision D9. The client acks synchronously before its first
   * `await`, but the *enqueue* it performs afterwards is asynchronous. If this helper discarded
   * the listener's promise, a following `queue.drain(...)` would only find the item because the
   * in-memory queue happens to settle within a microtask — and the same assertion would race
   * against I1's SQLite-backed queue, whose enqueue does real I/O. Awaiting here keeps the suite
   * genuinely store-agnostic: it depends on the enqueue having *completed*, not on how fast it
   * completes. A listener that returns nothing simply awaits `undefined`.
   */
  async dispatch(type: ListenerType, event: unknown = undefined): Promise<void> {
    const results = (this.listeners.get(type) ?? []).map((listener) => listener(event));
    await Promise.all(results);
  }
}

const createTrackedWebSocketFactory = (
  onSend?: (data: string) => void
): {
  readonly factory: SocketModeDependencies["webSocketFactory"];
  readonly sockets: FakeSocket[];
} => {
  const sockets: FakeSocket[] = [];
  const factory = (): SocketLike => {
    const socket = new FakeSocket(onSend);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

interface RecordedOpenCall {
  readonly url: string;
  readonly authorization: string | null;
}

const createOpenConnectionFetch = (
  responses: readonly unknown[]
): { readonly fetch: typeof globalThis.fetch; readonly calls: RecordedOpenCall[] } => {
  const calls: RecordedOpenCall[] = [];
  let index = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get("authorization") });
    const responseIndex = Math.min(index, responses.length - 1);
    index += 1;
    return jsonResponse(responses[responseIndex]);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

/** Flushes pending microtask/macrotask work (fetch resolution, .json() body reads, etc.). */
const flush = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const NOW_ISO = "2026-08-27T00:00:00.000Z";
const now = (): string => NOW_ISO;

const requireSocket = (sockets: readonly FakeSocket[], index: number): FakeSocket => {
  const socket = sockets[index];
  if (socket === undefined) throw new Error(`Expected a socket at index ${index}.`);
  return socket;
};

describe("createSocketModeClient", () => {
  it("POSTs apps.connections.open with the app token in the Authorization header and uses the returned url for the socket", async () => {
    const { factory, sockets } = createTrackedWebSocketFactory();
    const { fetch, calls } = createOpenConnectionFetch([
      { ok: true, url: "wss://example.test/socket-1" }
    ]);
    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-test-token-value",
      webSocketFactory: factory,
      queue: createMemoryIngressQueue(),
      now
    });

    await client.connect();

    expect(calls).toEqual([
      { url: APPS_CONNECTIONS_OPEN_URL, authorization: "Bearer xapp-test-token-value" }
    ]);
    expect(sockets).toHaveLength(1);
  });

  it("throws unauthenticated with no token in the message when apps.connections.open responds { ok: false }", async () => {
    const token = "xapp-super-secret-app-token-value";
    const { fetch } = createOpenConnectionFetch([{ ok: false, error: "invalid_auth" }]);
    const { factory } = createTrackedWebSocketFactory();
    const client = createSocketModeClient({
      fetch,
      appToken: async () => token,
      webSocketFactory: factory,
      queue: createMemoryIngressQueue(),
      now
    });

    expect.assertions(3);
    try {
      await client.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("unauthenticated");
      expect((error as SlackRequestError).message).not.toContain(token);
    }
  });

  it("acks an events_api envelope on the socket before the handler runs, with the handler invoked only from queue.drain", async () => {
    const sequence: string[] = [];
    const { factory, sockets } = createTrackedWebSocketFactory((data) =>
      sequence.push(`ack:${data}`)
    );
    const { fetch } = createOpenConnectionFetch([{ ok: true, url: "wss://example.test/socket-1" }]);
    const queue = createMemoryIngressQueue();
    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-token",
      webSocketFactory: factory,
      queue,
      now
    });

    await client.connect();
    const socket = requireSocket(sockets, 0);

    await socket.dispatch("message", {
      data: JSON.stringify({
        type: "events_api",
        envelope_id: "E1",
        payload: { kind: "event_callback" }
      })
    });

    // The ack must already be on the socket -- the handler must not have run yet.
    expect(sequence).toEqual([`ack:${JSON.stringify({ envelope_id: "E1" })}`]);

    await queue.drain(async (item) => {
      sequence.push(`handler:${item.envelopeId}`);
    });

    expect(sequence).toEqual([`ack:${JSON.stringify({ envelope_id: "E1" })}`, "handler:E1"]);
  });

  it("enqueues a re-delivered envelope_id only once but still acks the redelivery", async () => {
    const { factory, sockets } = createTrackedWebSocketFactory();
    const { fetch } = createOpenConnectionFetch([{ ok: true, url: "wss://example.test/socket-1" }]);
    const queue = createMemoryIngressQueue();
    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-token",
      webSocketFactory: factory,
      queue,
      now
    });

    await client.connect();
    const socket = requireSocket(sockets, 0);

    const firstDelivery = { type: "events_api", envelope_id: "E1", payload: { attempt: "first" } };
    const redelivery = { type: "events_api", envelope_id: "E1", payload: { attempt: "second" } };
    await socket.dispatch("message", { data: JSON.stringify(firstDelivery) });
    await socket.dispatch("message", { data: JSON.stringify(redelivery) });

    const ackMessage = JSON.stringify({ envelope_id: "E1" });
    expect(socket.sent).toEqual([ackMessage, ackMessage]);

    const processed: unknown[] = [];
    await queue.drain(async (item) => {
      processed.push(item.payload);
    });
    expect(processed).toEqual([{ attempt: "first" }]);
  });

  it("ignores a hello envelope: no ack, no enqueue", async () => {
    const { factory, sockets } = createTrackedWebSocketFactory();
    const { fetch } = createOpenConnectionFetch([{ ok: true, url: "wss://example.test/socket-1" }]);
    const queue = createMemoryIngressQueue();
    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-token",
      webSocketFactory: factory,
      queue,
      now
    });

    await client.connect();
    const socket = requireSocket(sockets, 0);
    await socket.dispatch("message", { data: JSON.stringify({ type: "hello" }) });

    expect(socket.sent).toEqual([]);
    const processed: unknown[] = [];
    await queue.drain(async (item) => {
      processed.push(item);
    });
    expect(processed).toEqual([]);
  });

  it("reconnects through a fresh apps.connections.open on a disconnect envelope, without losing queued items", async () => {
    const { factory, sockets } = createTrackedWebSocketFactory();
    const { fetch, calls } = createOpenConnectionFetch([
      { ok: true, url: "wss://example.test/socket-1" },
      { ok: true, url: "wss://example.test/socket-2" }
    ]);
    const queue = createMemoryIngressQueue();
    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-token",
      webSocketFactory: factory,
      queue,
      now
    });

    await client.connect();
    const firstSocket = requireSocket(sockets, 0);
    await queue.enqueue({
      envelopeId: "pre-existing",
      payload: { already: "queued" },
      enqueuedAt: NOW_ISO
    });

    await firstSocket.dispatch("message", {
      data: JSON.stringify({ type: "disconnect", reason: "refresh_requested" })
    });
    await flush();

    expect(calls).toHaveLength(2);
    expect(sockets).toHaveLength(2);
    expect(firstSocket.closeCalls).toBe(1);

    const processed: string[] = [];
    await queue.drain(async (item) => {
      processed.push(item.envelopeId);
    });
    expect(processed).toEqual(["pre-existing"]);
  });

  it("does not let a throwing handler prevent the ack, and leaves the item queued for a later drain", async () => {
    const { factory, sockets } = createTrackedWebSocketFactory();
    const { fetch } = createOpenConnectionFetch([{ ok: true, url: "wss://example.test/socket-1" }]);
    const queue = createMemoryIngressQueue();
    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-token",
      webSocketFactory: factory,
      queue,
      now
    });

    await client.connect();
    const socket = requireSocket(sockets, 0);
    await socket.dispatch("message", {
      data: JSON.stringify({ type: "events_api", envelope_id: "E1", payload: {} })
    });

    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "E1" })]);

    await expect(
      queue.drain(async () => {
        throw new Error("handler exploded");
      })
    ).rejects.toThrow("handler exploded");

    const processed: string[] = [];
    await queue.drain(async (item) => {
      processed.push(item.envelopeId);
    });
    expect(processed).toEqual(["E1"]);
  });

  it("fails closed on a malformed envelope: no ack, no crash, and the socket keeps working afterward", async () => {
    const { factory, sockets } = createTrackedWebSocketFactory();
    const { fetch } = createOpenConnectionFetch([{ ok: true, url: "wss://example.test/socket-1" }]);
    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-token",
      webSocketFactory: factory,
      queue: createMemoryIngressQueue(),
      now
    });

    await client.connect();
    const socket = requireSocket(sockets, 0);

    // `dispatch` is async, so a malformed envelope must be asserted as a *resolving* promise.
    // `.not.toThrow()` would pass vacuously here: a rejected promise is not a synchronous throw,
    // so the old form would have reported success even if the client blew up on bad input.
    await expect(socket.dispatch("message", { data: "not json" })).resolves.toBeUndefined();
    await expect(
      socket.dispatch("message", { data: JSON.stringify({ unexpected: "shape" }) })
    ).resolves.toBeUndefined();
    expect(socket.sent).toEqual([]);

    await socket.dispatch("message", {
      data: JSON.stringify({ type: "events_api", envelope_id: "E1", payload: {} })
    });
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "E1" })]);
  });

  it("bounds reconnect attempts at maximumReconnectAttempts using injected sleep/random backoff, then stops", async () => {
    const { factory, sockets } = createTrackedWebSocketFactory();
    let callCount = 0;
    const fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return jsonResponse({ ok: true, url: "wss://example.test/socket-1" });
      return jsonResponse({ ok: false, error: "internal_error" });
    }) as unknown as typeof globalThis.fetch;

    const sleepCalls: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
    };
    const random = (): number => 0.5;

    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-token",
      webSocketFactory: factory,
      queue: createMemoryIngressQueue(),
      now,
      sleep,
      random,
      maximumReconnectAttempts: 3
    });

    await client.connect();
    const firstSocket = requireSocket(sockets, 0);
    await firstSocket.dispatch("close");

    for (let tick = 0; tick < 6; tick += 1) await flush();

    expect(sleepCalls).toHaveLength(3);
    expect(callCount).toBe(4); // 1 initial connect + 3 failed reconnect attempts
    expect(sockets).toHaveLength(1); // every reconnect attempt failed at apps.connections.open
  });

  it("close() stops an in-flight reconnect loop and resolves without a further reconnect attempt", async () => {
    const { factory, sockets } = createTrackedWebSocketFactory();
    const fetch = vi.fn(async () =>
      jsonResponse({ ok: true, url: "wss://example.test/socket-1" })
    ) as unknown as typeof globalThis.fetch;

    let releaseSleep: (() => void) | undefined;
    const sleep = async (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });
    const random = (): number => 0.5;

    const client = createSocketModeClient({
      fetch,
      appToken: async () => "xapp-token",
      webSocketFactory: factory,
      queue: createMemoryIngressQueue(),
      now,
      sleep,
      random,
      maximumReconnectAttempts: 10
    });

    await client.connect();
    const firstSocket = requireSocket(sockets, 0);
    expect(fetch).toHaveBeenCalledTimes(1);

    await firstSocket.dispatch("close");
    await flush(); // the reconnect loop starts and blocks on the injected sleep

    await client.close();
    expect(firstSocket.closeCalls).toBe(1);

    releaseSleep?.();
    await flush();
    await flush();

    expect(fetch).toHaveBeenCalledTimes(1); // no reconnect attempt was made after close()
    expect(sockets).toHaveLength(1);
  });

  it("never includes the app token in an error, the returned client, or any thrown message", async () => {
    const token = "xapp-1-abcdefghijklmnopqrstuvwxyz0123456789";
    const { factory } = createTrackedWebSocketFactory();
    const { fetch } = createOpenConnectionFetch([{ ok: false, error: "invalid_auth" }]);
    const client = createSocketModeClient({
      fetch,
      appToken: async () => token,
      webSocketFactory: factory,
      queue: createMemoryIngressQueue(),
      now
    });

    expect(Object.keys(client)).toEqual(["connect", "close"]);

    expect.assertions(4);
    try {
      await client.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).message).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
    }
  });
});

const APPS_CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open";

describe("createGlobalWebSocketFactory", () => {
  it("defaults to globalThis.WebSocket when no constructor is injected", () => {
    expect(typeof createGlobalWebSocketFactory()).toBe("function");
  });

  it("adapts an injected WebSocket-like constructor into a WebSocketFactory", () => {
    const created: string[] = [];
    class FakeGlobalSocket implements SocketLike {
      constructor(url: string) {
        created.push(url);
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
    }

    const factory = createGlobalWebSocketFactory(FakeGlobalSocket);
    const socket = factory("wss://example.test/socket");

    expect(created).toEqual(["wss://example.test/socket"]);
    expect(socket).toBeInstanceOf(FakeGlobalSocket);
  });
});
