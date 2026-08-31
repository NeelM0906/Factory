import { createHmac, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  ApprovalIdSchema,
  IngressDeliverySchema,
  RunIdSchema,
  SlackApprovalActionSchema,
  type IngressDelivery,
  type SlackApprovalAction
} from "@autostack/contracts";

import { registerSlackIngress } from "../../src/ingress/slack.js";
import type { SlackIngressDependencies } from "../../src/ingress/types.js";

const NOW = "2026-08-20T12:00:00.000Z";
const TIMESTAMP_SECONDS = String(Math.floor(Date.parse(NOW) / 1000));
const SECRET = "slack-signing-secret";
const TOLERANCE_SECONDS = 300;

const computeSignature = (timestamp: string, rawBody: Uint8Array): string => {
  const prefix = new TextEncoder().encode(`v0:${timestamp}:`);
  const base = new Uint8Array(prefix.length + rawBody.length);
  base.set(prefix, 0);
  base.set(rawBody, prefix.length);
  return `v0=${createHmac("sha256", SECRET).update(base).digest("hex")}`;
};

// Implemented inline with node:crypto per the brief: apps/control-plane cannot depend on
// Slack's own adapter package. `nowMs` is injected per-verifier so the stale-timestamp test
// below can supply its own clock without any shared mutable state between tests.
const makeVerifySignature = (
  nowMs: () => number = () => Date.parse(NOW)
): SlackIngressDependencies["verifySignature"] => {
  return ({ rawBody, signatureHeader, timestampHeader }) => {
    if (signatureHeader === null || timestampHeader === null) throw new Error("missing signature");
    const expected = Buffer.from(computeSignature(timestampHeader, rawBody));
    const actual = Buffer.from(signatureHeader);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("signature mismatch");
    }
    const driftMs = nowMs() - Number(timestampHeader) * 1000;
    if (Math.abs(driftMs) > TOLERANCE_SECONDS * 1000) throw new Error("stale timestamp");
  };
};

class UnsupportedEventError extends Error {}

const SLACK_DELIVERY: IngressDelivery = IngressDeliverySchema.parse({
  schemaVersion: 1,
  provider: "slack",
  deliveryId: "delivery-1",
  deduplicationKey: "slack:team-1:chan-1:167.001",
  receivedAt: NOW,
  event: "app_mention",
  slackWorkspaceId: "team-1",
  channelId: "chan-1",
  threadTs: "167.001",
  messageTs: "167.001",
  userId: "user-1",
  text: "hello"
});

const MESSAGE_ACTION_DELIVERY: IngressDelivery = IngressDeliverySchema.parse({
  schemaVersion: 1,
  provider: "slack",
  deliveryId: "delivery-2",
  deduplicationKey: "slack:team-1:chan-1:167.002",
  receivedAt: NOW,
  event: "message_action",
  slackWorkspaceId: "team-1",
  channelId: "chan-1",
  threadTs: "167.002",
  messageTs: "167.002",
  userId: "user-1",
  text: "please help with this"
});

const APPROVAL_ACTION: SlackApprovalAction = SlackApprovalActionSchema.parse({
  schemaVersion: 1,
  bindingRef: "binding-1",
  slackWorkspaceId: "team-1",
  channelId: "chan-1",
  messageTs: "167.001",
  userId: "user-1",
  runId: RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000"),
  approvalId: ApprovalIdSchema.parse("apr_123e4567-e89b-42d3-a456-426614174001"),
  decision: "approved",
  evidenceDigest: "a".repeat(64),
  deliveryId: "action-1",
  deduplicationKey: "slack:action:team-1:apr_123e4567-e89b-42d3-a456-426614174001:167.001",
  triggeredAt: NOW
});

interface HarnessOptions {
  readonly isOpen?: () => boolean;
  readonly verifySignature?: SlackIngressDependencies["verifySignature"];
  readonly parseEventDelivery?: SlackIngressDependencies["parseEventDelivery"];
  readonly parseMessageAction?: SlackIngressDependencies["parseMessageAction"];
  readonly parseApprovalAction?: SlackIngressDependencies["parseApprovalAction"];
  readonly acceptImpl?: (delivery: IngressDelivery) => Promise<{ readonly replayed: boolean }>;
  readonly approvalImpl?: (action: SlackApprovalAction) => Promise<{ readonly replayed: boolean }>;
  readonly maximumBodyBytes?: number;
  readonly eventsPath?: string;
  readonly interactivityPath?: string;
}

function makeHarness(options: HarnessOptions = {}) {
  const accept = vi.fn(options.acceptImpl ?? (async () => ({ replayed: false })));
  const record = vi.fn(options.approvalImpl ?? (async () => ({ replayed: false })));
  const deps: SlackIngressDependencies = {
    ingress: { accept },
    approvals: { record },
    verifySignature: options.verifySignature ?? makeVerifySignature(),
    parseEventDelivery: options.parseEventDelivery ?? (() => SLACK_DELIVERY),
    parseMessageAction: options.parseMessageAction ?? (() => MESSAGE_ACTION_DELIVERY),
    parseApprovalAction: options.parseApprovalAction ?? (() => APPROVAL_ACTION),
    isUnsupportedEvent: (error) => error instanceof UnsupportedEventError,
    now: () => NOW,
    isOpen: options.isOpen ?? (() => true),
    ...(options.maximumBodyBytes === undefined
      ? {}
      : { maximumBodyBytes: options.maximumBodyBytes }),
    ...(options.eventsPath === undefined ? {} : { eventsPath: options.eventsPath }),
    ...(options.interactivityPath === undefined
      ? {}
      : { interactivityPath: options.interactivityPath })
  };
  const app = new Hono();
  registerSlackIngress(app, deps);
  return { app, accept, record };
}

const postJson = (
  app: Hono,
  body: string,
  headers: Record<string, string> = {},
  path = "/ingress/slack/events",
  timestamp = TIMESTAMP_SECONDS
) => {
  const rawBody = new TextEncoder().encode(body);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Slack-Signature": computeSignature(timestamp, rawBody),
      "X-Slack-Request-Timestamp": timestamp,
      ...headers
    },
    body
  });
};

const postForm = (
  app: Hono,
  payload: unknown,
  headers: Record<string, string> = {},
  path = "/ingress/slack/interactivity",
  timestamp = TIMESTAMP_SECONDS
) => {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const rawBody = new TextEncoder().encode(body);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Slack-Signature": computeSignature(timestamp, rawBody),
      "X-Slack-Request-Timestamp": timestamp,
      ...headers
    },
    body
  });
};

describe("registerSlackIngress: /ingress/slack/events", () => {
  it("accepts a validly-signed event exactly once", async () => {
    const { app, accept } = makeHarness();
    const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }));

    expect(response.status).toBe(202);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(SLACK_DELIVERY);
  });

  it("answers url_verification with the challenge and never calls accept", async () => {
    const { app, accept } = makeHarness();
    const response = await postJson(
      app,
      JSON.stringify({ type: "url_verification", challenge: "abc123" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "abc123" });
    expect(accept).not.toHaveBeenCalled();
  });

  // Rejects the wrong implementation that echoes the challenge BEFORE verifying the signature
  // (merge-review MEDIUM-4). The code already orders these correctly, but nothing pinned it: the
  // happy-path test above sends a validly-signed challenge, so it passes either way. An unsigned
  // challenge is the only input that tells the two orderings apart. Without this, url_verification
  // would be an unauthenticated echo endpoint — anyone could bounce arbitrary strings off it, and
  // a regression reordering the checks would ship green.
  it("rejects an UNSIGNED url_verification with 401 rather than echoing the challenge", async () => {
    const { app, accept } = makeHarness();
    const response = await app.request("/ingress/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "abc123" })
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("abc123");
    expect(accept).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp as a replay, via an injected clock", async () => {
    // The request's own timestamp header is "now"; the verifier's clock is deliberately set ten
    // minutes ahead of it, past the five-minute tolerance. Only the injected clock changes here.
    const staleVerifier = makeVerifySignature(() => Date.parse(NOW) + 10 * 60_000);
    const { app, accept } = makeHarness({ verifySignature: staleVerifier });
    const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }));

    expect(response.status).toBe(401);
    expect(accept).not.toHaveBeenCalled();
  });

  it("ignores an unsupported event with 202, never a 500, and never calls accept", async () => {
    const { app, accept } = makeHarness({
      parseEventDelivery: () => {
        throw new UnsupportedEventError("bot_message");
      }
    });
    const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ignored: true });
    expect(accept).not.toHaveBeenCalled();
  });

  it("returns 200 with no duplicate work on a Slack retry redelivery reported as replayed", async () => {
    const { app, accept } = makeHarness({ acceptImpl: async () => ({ replayed: true }) });
    const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }), {
      "X-Slack-Retry-Num": "1",
      "X-Slack-Retry-Reason": "http_timeout"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ replayed: true });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing signature with the shared ApiError shape and no accept call", async () => {
    const { app, accept } = makeHarness();
    const response = await app.request("/ingress/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event_callback", event: {} })
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) }
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("rejects a declared content-length over the cap before reading the body", async () => {
    const { app, accept } = makeHarness({ maximumBodyBytes: 10 });
    const response = await postJson(app, "x".repeat(1000));

    expect(response.status).toBe(413);
    expect(accept).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON after a valid signature with 400, not 500", async () => {
    const { app, accept } = makeHarness();
    const response = await postJson(app, "{ not valid json");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: expect.any(String) }
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("acks without extra delay beyond the accept() call itself (a slow sink must not stall the response)", async () => {
    const DELAY_MS = 30;
    const { app } = makeHarness({
      acceptImpl: () =>
        new Promise((resolve) => setTimeout(() => resolve({ replayed: false }), DELAY_MS))
    });

    const started = Date.now();
    const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }));
    const elapsed = Date.now() - started;

    expect(response.status).toBe(202);
    // The route awaits exactly the one accept() call needed to decide replayed vs. accepted and
    // then answers immediately -- no further downstream work runs first. A generous bound (well
    // over DELAY_MS) avoids flakiness while still catching an implementation that serializes
    // extra work (a second call, an added sleep) before acking.
    expect(elapsed).toBeLessThan(DELAY_MS + 300);
  });

  describe("outside the bearer wall", () => {
    it("succeeds with no Authorization header, given a valid signature", async () => {
      const { app } = makeHarness();
      const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }));
      expect(response.status).toBe(202);
    });

    it("succeeds with a bogus bearer token, given a valid signature", async () => {
      // Paired with the no-header case: absent any bearer wiring, "no header succeeds" is true
      // of every route and proves nothing alone. A bogus but present bearer also succeeding is
      // what rules out "someone bolted a bearer check onto this route".
      const { app } = makeHarness();
      const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }), {
        Authorization: "Bearer not-a-real-token"
      });
      expect(response.status).toBe(202);
    });

    it("is not registered under /v1", async () => {
      const { app } = makeHarness();
      const underV1 = await postJson(
        app,
        JSON.stringify({ type: "event_callback", event: {} }),
        {},
        "/v1/ingress/slack/events"
      );
      expect(underV1.status).toBe(404);
    });
  });

  describe("ingress closed", () => {
    it("returns 503 with zero accept calls when isOpen() is false", async () => {
      const { app, accept } = makeHarness({ isOpen: () => false });
      const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }));

      expect(response.status).toBe(503);
      expect(accept).not.toHaveBeenCalled();
    });

    it("still verifies the signature first: a bad signature on a closed ingress is 401, not 503", async () => {
      const { app, accept } = makeHarness({ isOpen: () => false });
      const response = await postJson(app, JSON.stringify({ type: "event_callback", event: {} }), {
        "X-Slack-Signature": "v0=" + "0".repeat(64)
      });

      expect(response.status).toBe(401);
      expect(accept).not.toHaveBeenCalled();
    });
  });

  it("serves at a custom eventsPath and not at the default", async () => {
    const { app } = makeHarness({ eventsPath: "/custom/events" });
    const body = JSON.stringify({ type: "event_callback", event: {} });

    const atCustomPath = await postJson(app, body, {}, "/custom/events");
    const atDefaultPath = await postJson(app, body, {}, "/ingress/slack/events");

    expect(atCustomPath.status).toBe(202);
    expect(atDefaultPath.status).toBe(404);
  });
});

describe("registerSlackIngress: /ingress/slack/interactivity", () => {
  it("parses application/x-www-form-urlencoded payload= and routes block_actions to the approvals sink", async () => {
    const { app, record, accept } = makeHarness();
    const response = await postForm(app, { type: "block_actions" });

    expect(response.status).toBe(202);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(APPROVAL_ACTION);
    expect(accept).not.toHaveBeenCalled();
  });

  it("routes message_action to ingress.accept", async () => {
    const { app, record, accept } = makeHarness();
    const response = await postForm(app, { type: "message_action" });

    expect(response.status).toBe(202);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(MESSAGE_ACTION_DELIVERY);
    expect(record).not.toHaveBeenCalled();
  });

  it("ignores an interactivity type it does not recognize with 202, calling neither sink", async () => {
    const { app, record, accept } = makeHarness();
    const response = await postForm(app, { type: "view_submission" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ignored: true });
    expect(record).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it("verifies the signature before form-decoding payload=: a malformed form body with a bad signature is 401, not 400", async () => {
    // A wrong implementation that form-decodes first would find no "payload" field in this body,
    // fail to parse it, and answer 400 before ever checking the signature. The correct ordering
    // (decision D8: signature over the raw body before decoding) answers 401 regardless of
    // whether the body would have decoded into anything sensible.
    const { app, accept, record } = makeHarness();
    const response = await app.request("/ingress/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Signature": "v0=" + "0".repeat(64),
        "X-Slack-Request-Timestamp": TIMESTAMP_SECONDS
      },
      body: "this-is-not-a-payload-field-at-all"
    });

    expect(response.status).toBe(401);
    expect(accept).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects a well-signed form body with no payload field as 400 once signature does pass", async () => {
    const { app, accept, record } = makeHarness();
    const rawBody = new TextEncoder().encode("not-a-payload-field");
    const response = await app.request("/ingress/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Signature": computeSignature(TIMESTAMP_SECONDS, rawBody),
        "X-Slack-Request-Timestamp": TIMESTAMP_SECONDS
      },
      body: "not-a-payload-field"
    });

    expect(response.status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON in the payload field after a valid signature with 400, not 500", async () => {
    const { app } = makeHarness();
    const rawBody = new TextEncoder().encode("payload={not valid json");
    const response = await app.request("/ingress/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Signature": computeSignature(TIMESTAMP_SECONDS, rawBody),
        "X-Slack-Request-Timestamp": TIMESTAMP_SECONDS
      },
      body: "payload={not valid json"
    });

    expect(response.status).toBe(400);
  });

  it("rejects a declared content-length over the cap before reading the body", async () => {
    const { app, accept, record } = makeHarness({ maximumBodyBytes: 10 });
    const response = await postForm(app, { type: "message_action", padding: "x".repeat(1000) });

    expect(response.status).toBe(413);
    expect(accept).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("acks without extra delay beyond the approvals sink call itself (a slow sink must not stall the response)", async () => {
    const DELAY_MS = 30;
    const { app } = makeHarness({
      approvalImpl: () =>
        new Promise((resolve) => setTimeout(() => resolve({ replayed: false }), DELAY_MS))
    });

    const started = Date.now();
    const response = await postForm(app, { type: "block_actions" });
    const elapsed = Date.now() - started;

    expect(response.status).toBe(202);
    expect(elapsed).toBeLessThan(DELAY_MS + 300);
  });

  describe("outside the bearer wall", () => {
    it("succeeds with no Authorization header, given a valid signature", async () => {
      const { app } = makeHarness();
      const response = await postForm(app, { type: "message_action" });
      expect(response.status).toBe(202);
    });

    it("succeeds with a bogus bearer token, given a valid signature", async () => {
      const { app } = makeHarness();
      const response = await postForm(
        app,
        { type: "message_action" },
        {
          Authorization: "Bearer not-a-real-token"
        }
      );
      expect(response.status).toBe(202);
    });

    it("is not registered under /v1", async () => {
      const { app } = makeHarness();
      const underV1 = await postForm(
        app,
        { type: "message_action" },
        {},
        "/v1/ingress/slack/interactivity"
      );
      expect(underV1.status).toBe(404);
    });
  });

  describe("ingress closed", () => {
    it("returns 503 with zero sink calls when isOpen() is false", async () => {
      const { app, accept, record } = makeHarness({ isOpen: () => false });
      const response = await postForm(app, { type: "message_action" });

      expect(response.status).toBe(503);
      expect(accept).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it("still verifies the signature first: a bad signature on a closed ingress is 401, not 503", async () => {
      const { app, accept, record } = makeHarness({ isOpen: () => false });
      const response = await postForm(
        app,
        { type: "message_action" },
        {
          "X-Slack-Signature": "v0=" + "0".repeat(64)
        }
      );

      expect(response.status).toBe(401);
      expect(accept).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });
  });

  it("serves at a custom interactivityPath and not at the default", async () => {
    const { app } = makeHarness({ interactivityPath: "/custom/interactivity" });

    const atCustomPath = await postForm(
      app,
      { type: "message_action" },
      {},
      "/custom/interactivity"
    );
    const atDefaultPath = await postForm(
      app,
      { type: "message_action" },
      {},
      "/ingress/slack/interactivity"
    );

    expect(atCustomPath.status).toBe(202);
    expect(atDefaultPath.status).toBe(404);
  });
});
