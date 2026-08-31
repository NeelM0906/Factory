import type { Context, Hono } from "hono";

import { BodyTooLargeError, readRawBody, type SlackIngressDependencies } from "./types.js";

const DEFAULT_EVENTS_PATH = "/ingress/slack/events";
const DEFAULT_INTERACTIVITY_PATH = "/ingress/slack/interactivity";
const DEFAULT_MAXIMUM_BODY_BYTES = 1024 * 1024;

type ErrorCode =
  "unauthorized" | "invalid_request" | "request_too_large" | "local_runner_unavailable";

const errorResponse = (
  context: Context,
  status: 401 | 400 | 413 | 503,
  code: ErrorCode,
  message: string
): Response => context.json({ error: { code, message } }, status);

const readStringField = (payload: unknown, field: string): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidate = (payload as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Verifies the signature over `rawBody`, then answers `503` (never a swallowed `202`) when
 * ingress is closed. Shared by both Slack routes below; kept as a helper rather than a third
 * exported route so both call sites stay in lockstep on ordering (decision D8: signature before
 * `isOpen`, so a closed ingress cannot become an unauthenticated-probe oracle).
 */
function verifyOpenOrRespond(
  context: Context,
  deps: SlackIngressDependencies,
  rawBody: Uint8Array
): Response | undefined {
  try {
    deps.verifySignature({
      rawBody,
      signatureHeader: context.req.header("X-Slack-Signature") ?? null,
      timestampHeader: context.req.header("X-Slack-Request-Timestamp") ?? null
    });
  } catch {
    return errorResponse(context, 401, "unauthorized", "The request signature is invalid.");
  }

  // Ingress closed means the local runner generation cannot accept work right now. This
  // deliberately answers 503, never a 202: Slack redelivers on a non-2xx response, so a 503 here
  // lets Slack's own retry machinery recover the event once ingress reopens. Answering 202 (or
  // 200) and then dropping the event would hand back a success receipt for something we never
  // actually accepted — a silently lost event with a passing status code. Do not "fix" this into
  // a 202; that is the wrong implementation this comment exists to rule out.
  if (!deps.isOpen()) {
    return errorResponse(
      context,
      503,
      "local_runner_unavailable",
      "Ingress is not currently accepting deliveries."
    );
  }

  return undefined;
}

/**
 * Registers `POST {eventsPath}` (default `/ingress/slack/events`) and
 * `POST {interactivityPath}` (default `/ingress/slack/interactivity`) on `app`. Mounting is the
 * caller's concern — this factory never touches `app.ts`, and neither route mounts under `/v1/*`:
 * webhooks authenticate by provider signature over the raw body, never by the bearer token that
 * guards the versioned API surface (decision D8).
 */
export function registerSlackIngress(app: Hono, deps: SlackIngressDependencies): void {
  const eventsPath = deps.eventsPath ?? DEFAULT_EVENTS_PATH;
  const interactivityPath = deps.interactivityPath ?? DEFAULT_INTERACTIVITY_PATH;
  const maximumBodyBytes = deps.maximumBodyBytes ?? DEFAULT_MAXIMUM_BODY_BYTES;

  app.post(eventsPath, async (context) => {
    let rawBody: Uint8Array;
    try {
      rawBody = await readRawBody(context.req.raw, maximumBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return errorResponse(context, 413, "request_too_large", "The request body is too large.");
      }
      throw error;
    }

    const rejection = verifyOpenOrRespond(context, deps, rawBody);
    if (rejection !== undefined) return rejection;

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    } catch {
      return errorResponse(context, 400, "invalid_request", "The request body is invalid JSON.");
    }

    // The url_verification handshake is a protocol-level echo Slack uses to prove the endpoint
    // owns the signing secret, not an ingress delivery — it never reaches `parseEventDelivery` or
    // `ingress.accept`, and it is answered directly from the top-level `type`/`challenge` fields
    // rather than through an injected adapter function, since there is no delivery-parsing
    // business logic involved.
    if (readStringField(payload, "type") === "url_verification") {
      const challenge = readStringField(payload, "challenge");
      if (challenge === undefined) {
        return errorResponse(context, 400, "invalid_request", "The challenge payload is invalid.");
      }
      return context.json({ challenge }, 200);
    }

    let delivery;
    try {
      delivery = deps.parseEventDelivery({ payload, receivedAt: deps.now() });
    } catch (error) {
      if (deps.isUnsupportedEvent(error)) return context.json({ ignored: true }, 202);
      return errorResponse(context, 400, "invalid_request", "The event payload is invalid.");
    }

    let result: { readonly replayed: boolean };
    try {
      result = await deps.ingress.accept(delivery);
    } catch {
      return errorResponse(
        context,
        503,
        "local_runner_unavailable",
        "The delivery could not be accepted."
      );
    }

    if (result.replayed) return context.json({ replayed: true }, 200);
    return context.json({ accepted: true }, 202);
  });

  app.post(interactivityPath, async (context) => {
    let rawBody: Uint8Array;
    try {
      rawBody = await readRawBody(context.req.raw, maximumBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return errorResponse(context, 413, "request_too_large", "The request body is too large.");
      }
      throw error;
    }

    // Signature verification runs over these raw bytes, before the body is form-decoded to pull
    // out `payload=`. Slack signs the exact bytes it sent; decoding first and re-verifying over a
    // reconstructed string would check a signature against data that was never actually signed.
    const rejection = verifyOpenOrRespond(context, deps, rawBody);
    if (rejection !== undefined) return rejection;

    const form = new URLSearchParams(new TextDecoder().decode(rawBody));
    const payloadField = form.get("payload");
    if (payloadField === null) {
      return errorResponse(context, 400, "invalid_request", "A payload field is required.");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadField) as unknown;
    } catch {
      return errorResponse(context, 400, "invalid_request", "The payload field is invalid JSON.");
    }

    const type = readStringField(payload, "type");
    const receivedAt = deps.now();

    if (type === "block_actions") {
      let action;
      try {
        action = deps.parseApprovalAction({ payload, receivedAt });
      } catch (error) {
        if (deps.isUnsupportedEvent(error)) return context.json({ ignored: true }, 202);
        return errorResponse(
          context,
          400,
          "invalid_request",
          "The interactivity payload is invalid."
        );
      }
      let result: { readonly replayed: boolean };
      try {
        result = await deps.approvals.record(action);
      } catch {
        return errorResponse(
          context,
          503,
          "local_runner_unavailable",
          "The approval action could not be accepted."
        );
      }
      if (result.replayed) return context.json({ replayed: true }, 200);
      return context.json({ accepted: true }, 202);
    }

    if (type === "message_action") {
      let delivery;
      try {
        delivery = deps.parseMessageAction({ payload, receivedAt });
      } catch (error) {
        if (deps.isUnsupportedEvent(error)) return context.json({ ignored: true }, 202);
        return errorResponse(
          context,
          400,
          "invalid_request",
          "The interactivity payload is invalid."
        );
      }
      let result: { readonly replayed: boolean };
      try {
        result = await deps.ingress.accept(delivery);
      } catch {
        return errorResponse(
          context,
          503,
          "local_runner_unavailable",
          "The delivery could not be accepted."
        );
      }
      if (result.replayed) return context.json({ replayed: true }, 200);
      return context.json({ accepted: true }, 202);
    }

    return context.json({ ignored: true }, 202);
  });
}
