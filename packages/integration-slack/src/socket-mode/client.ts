import { z } from "zod";

import { SlackRequestError } from "../errors.js";
import type { IngressQueue } from "./queue.js";
import type { SocketLike, WebSocketFactory } from "./transport.js";

/**
 * Socket Mode client (spec §13.2, decision D6). Every `events_api` (or otherwise ack-required)
 * envelope is acked on the socket the instant it arrives -- before any application processing --
 * and is then only ever handed to the caller-supplied `IngressQueue` for later `drain`. This
 * module never invokes an application handler itself: the queue is shared with the caller, who
 * calls `queue.drain(handler)` on their own schedule. That split is what makes "the ack is sent
 * before the handler runs, and the handler is invoked from `drain`, not from the socket callback"
 * true by construction rather than by timing luck.
 *
 * `webSocketFactory` is always injected (see `./transport.ts`'s `createGlobalWebSocketFactory`
 * for the production default), so the whole envelope state machine, dedup, reconnect/`disconnect`
 * handling, and ack ordering are exercised in tests against a scripted fake socket -- the same
 * code path production uses against a real connection.
 */
export interface SocketModeDependencies {
  readonly fetch: typeof globalThis.fetch;
  /** Returns the `xapp-…` app token. Never stored -- read fresh on every connection attempt. */
  readonly appToken: () => Promise<string>;
  readonly webSocketFactory: WebSocketFactory;
  readonly queue: IngressQueue;
  readonly now: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly maximumReconnectAttempts?: number;
}

export interface SocketModeClient {
  readonly connect: () => Promise<void>;
  readonly close: () => Promise<void>;
}

const APPS_CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open";
const DEFAULT_MAXIMUM_RECONNECT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

// Safe fallbacks used only when the caller omits `sleep`/`random`. Neither calls a forbidden
// timer or RNG primitive: the default sleep resolves without a real timer and the default random
// is a fixed midpoint. A caller that cares about real backoff timing supplies its own
// `sleep`/`random` (as the composition root does in production) -- this package's `src/` never
// calls `setTimeout` or `Math.random` itself.
const defaultSleep = async (): Promise<void> => {};
const defaultRandom = (): number => 0.5;

const AppsConnectionsOpenResponseSchema = z.union([
  z.object({ ok: z.literal(true), url: z.string().min(1) }),
  z.object({ ok: z.literal(false), error: z.string().optional() })
]);

// Not `.strict()`: real Socket Mode envelopes carry additional fields (`accepts_response_payload`,
// `retry_attempt`, ...) this client does not need. `.passthrough()` accepts them without failing.
const HelloEnvelopeSchema = z.object({ type: z.literal("hello") }).passthrough();
const DisconnectEnvelopeSchema = z
  .object({ type: z.literal("disconnect"), reason: z.string().min(1).optional() })
  .passthrough();
// Structural, not limited to `events_api`: any envelope Slack expects an ack for (events_api,
// interactive, slash_commands, ...) carries an `envelope_id`, and this client acks all of them
// the same way rather than hardcoding one type.
const AckableEnvelopeSchema = z
  .object({
    type: z.string().min(1),
    envelope_id: z.string().min(1),
    payload: z.unknown().optional()
  })
  .passthrough();

const computeBackoffMs = (attempt: number, random: () => number): number => {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return random() * ceiling;
};

const openConnection = async (deps: SocketModeDependencies): Promise<string> => {
  const token = await deps.appToken();

  let response: Response;
  try {
    response = await deps.fetch(APPS_CONNECTIONS_OPEN_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
  } catch (cause) {
    throw new SlackRequestError(
      "Slack apps.connections.open request failed to send.",
      "provider_unavailable",
      true,
      { cause, sensitiveValues: [token] }
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new SlackRequestError(
      "Slack apps.connections.open returned an unparseable response.",
      "invalid_request",
      false,
      { cause, sensitiveValues: [token] }
    );
  }

  const parsed = AppsConnectionsOpenResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.ok !== true) {
    throw new SlackRequestError(
      "Slack apps.connections.open was rejected.",
      "unauthenticated",
      false,
      { sensitiveValues: [token] }
    );
  }
  return parsed.data.url;
};

export const createSocketModeClient = (deps: SocketModeDependencies): SocketModeClient => {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? defaultRandom;
  const maximumReconnectAttempts =
    deps.maximumReconnectAttempts ?? DEFAULT_MAXIMUM_RECONNECT_ATTEMPTS;

  // Envelope-id dedup for the client's lifetime: a Slack redelivery must still be acked but must
  // never be enqueued twice.
  const seenEnvelopeIds = new Set<string>();
  let currentSocket: SocketLike | undefined;
  let closing = false;
  let reconnecting = false;

  const handleMessage = (socket: SocketLike, event: { readonly data: string }): void => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(event.data);
    } catch {
      return; // Fail closed: an unparseable envelope is never acked-and-dropped silently.
    }

    if (HelloEnvelopeSchema.safeParse(parsedJson).success) return; // Ignored: no ack, no enqueue.

    const disconnect = DisconnectEnvelopeSchema.safeParse(parsedJson);
    if (disconnect.success) {
      void handleDisconnect(socket);
      return;
    }

    const ackable = AckableEnvelopeSchema.safeParse(parsedJson);
    if (!ackable.success) return; // Fail closed: not a recognizable ack-required envelope.

    const { envelope_id: envelopeId } = ackable.data;
    // Ack first, always -- this is the entire point (spec §13.2). `send` is synchronous, so the
    // ack is on the wire before any `await` below ever runs, regardless of how slow enqueueing or
    // a later `drain` handler turns out to be.
    socket.send(JSON.stringify({ envelope_id: envelopeId }));

    if (seenEnvelopeIds.has(envelopeId)) return; // Already queued once; still acked above.
    seenEnvelopeIds.add(envelopeId);

    const payload = ackable.data.payload ?? ackable.data;
    void deps.queue.enqueue({ envelopeId, payload, enqueuedAt: deps.now() }).catch(() => {
      // Never actually queued (e.g. the queue is at capacity): let a future redelivery try again.
      seenEnvelopeIds.delete(envelopeId);
    });
  };

  const establishConnection = async (): Promise<SocketLike> => {
    const url = await openConnection(deps);
    const socket = deps.webSocketFactory(url);
    socket.addEventListener("message", (event: { readonly data: string }) => {
      handleMessage(socket, event);
    });
    socket.addEventListener("close", () => {
      handleClose(socket);
    });
    currentSocket = socket;
    return socket;
  };

  // A `disconnect` envelope is a directed request to open a fresh connection now, not a dropped
  // connection to back off and retry -- so it bypasses `attemptReconnect`'s backoff entirely and
  // falls back to it only if the immediate refresh itself fails.
  const handleDisconnect = async (staleSocket: SocketLike): Promise<void> => {
    if (closing) return;
    try {
      await establishConnection();
      staleSocket.close();
    } catch {
      void attemptReconnect();
    }
  };

  const handleClose = (socket: SocketLike): void => {
    if (closing) return;
    if (socket !== currentSocket) return; // A stale socket already superseded by a reconnect.
    void attemptReconnect();
  };

  const attemptReconnect = async (): Promise<void> => {
    if (reconnecting) return;
    reconnecting = true;
    try {
      let attempts = 0;
      while (!closing && attempts < maximumReconnectAttempts) {
        attempts += 1;
        await sleep(computeBackoffMs(attempts, random));
        if (closing) return;
        try {
          await establishConnection();
          return;
        } catch {
          // Keep retrying until maximumReconnectAttempts is spent.
        }
      }
    } finally {
      reconnecting = false;
    }
  };

  return {
    connect: async (): Promise<void> => {
      closing = false;
      await establishConnection();
    },
    close: async (): Promise<void> => {
      closing = true;
      currentSocket?.close();
    }
  };
};
