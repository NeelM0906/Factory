import { IngressDeliverySchema, type IngressDelivery } from "@autostack/contracts";
import { z } from "zod";

import { SlackRequestError } from "../errors.js";

/** The Slack member of the `IngressDelivery` discriminated union. */
export type SlackIngressDelivery = Extract<IngressDelivery, { readonly provider: "slack" }>;

export type SlackUnsupportedEventReason = "bot_message" | "ignorable_subtype" | "unsupported_type";

/**
 * Thrown when an inbound Slack event must be silently ignored rather than turned into an
 * `IngressDelivery` — a bot echoing its own message, a channel-membership subtype, or an event
 * type AutoStack does not act on. This is deliberately a plain `Error`, not a `SlackRequestError`
 * variant: it is not a request failure, it is a routing decision. The ingress route (Task 15)
 * catches it and answers `200 ignored`, never a `500` — Slack's retry semantics treat a `5xx` as
 * "try again", and retrying an event we intentionally ignore would just make AutoStack reply to
 * itself in a loop.
 */
export class SlackUnsupportedEventError extends Error {
  readonly reason: SlackUnsupportedEventReason;

  constructor(reason: SlackUnsupportedEventReason) {
    super(`Slack event is unsupported and safely ignored (${reason}).`);
    this.name = "SlackUnsupportedEventError";
    this.reason = reason;
    Object.freeze(this);
  }
}

// Slack message subtypes that carry no user-authored content AutoStack should react to.
// `bot_message` is handled separately (SlackUnsupportedEventReason "bot_message") so the two
// causes of ignoring an event stay distinguishable to a caller that wants to log why.
const IGNORABLE_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "message_changed",
  "message_deleted",
  "channel_topic",
  "channel_purpose",
  "channel_name"
]);

const SUPPORTED_EVENT_TYPES = new Set(["app_mention", "message"]);

const SlackInnerEventSchema = z.object({
  type: z.string().min(1),
  subtype: z.string().min(1).optional(),
  bot_id: z.string().min(1).optional(),
  channel: z.string().min(1),
  channel_type: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  text: z.string().optional()
});

const SlackEventCallbackEnvelopeSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().min(1),
  event_id: z.string().min(1),
  event: SlackInnerEventSchema
});

const SlackUrlVerificationEnvelopeSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1)
});

const malformedEnvelopeError = (cause?: unknown): SlackRequestError =>
  new SlackRequestError("Slack event envelope is malformed.", "invalid_request", false, { cause });

/**
 * Builds the logical dedup key shared by every non-approval ingress delivery. Deliberately
 * excludes `deliveryId`: Slack assigns a fresh delivery identity on every retry, so folding it in
 * would defeat deduplication entirely — the key must identify the *message*, not the delivery
 * attempt.
 */
export const buildSlackDeliveryDeduplicationKey = (
  teamId: string,
  channelId: string,
  messageTs: string
): string => `slack:${teamId}:${channelId}:${messageTs}`;

export interface ParseSlackEventDeliveryInput {
  readonly envelopePayload: unknown;
  readonly receivedAt: string;
}

/**
 * Maps a Slack Events API `event_callback` envelope onto the `IngressDelivery` contract (spec
 * §4.3 mention/DM intake). Bot echoes and ignorable subtypes are rejected as unsupported so
 * AutoStack never reacts to its own messages. A `url_verification` envelope is rejected here —
 * call {@link parseSlackUrlVerificationChallenge} for that instead of smuggling a challenge
 * through the delivery shape.
 */
export const parseSlackEventDelivery = (
  input: ParseSlackEventDeliveryInput
): SlackIngressDelivery => {
  const { envelopePayload, receivedAt } = input;

  if (SlackUrlVerificationEnvelopeSchema.safeParse(envelopePayload).success) {
    throw new SlackRequestError(
      "Slack url_verification envelopes are not ingress deliveries.",
      "invalid_request",
      false
    );
  }

  const parsedEnvelope = SlackEventCallbackEnvelopeSchema.safeParse(envelopePayload);
  if (!parsedEnvelope.success) throw malformedEnvelopeError(parsedEnvelope.error);

  const { team_id: teamId, event_id: deliveryId, event } = parsedEnvelope.data;

  if (event.bot_id !== undefined || event.subtype === "bot_message") {
    throw new SlackUnsupportedEventError("bot_message");
  }
  if (event.subtype !== undefined && IGNORABLE_SUBTYPES.has(event.subtype)) {
    throw new SlackUnsupportedEventError("ignorable_subtype");
  }
  if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
    throw new SlackUnsupportedEventError("unsupported_type");
  }
  if (event.user === undefined) throw malformedEnvelopeError();

  const candidate = {
    schemaVersion: 1 as const,
    provider: "slack" as const,
    deliveryId,
    deduplicationKey: buildSlackDeliveryDeduplicationKey(teamId, event.channel, event.ts),
    receivedAt,
    event: event.type as "app_mention" | "message",
    slackWorkspaceId: teamId,
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    messageTs: event.ts,
    userId: event.user,
    text: event.text ?? ""
  };

  const delivery = IngressDeliverySchema.parse(candidate);
  if (delivery.provider !== "slack") throw malformedEnvelopeError();
  return delivery;
};

export interface ParseSlackUrlVerificationChallengeInput {
  readonly envelopePayload: unknown;
}

/** Handles Slack's `url_verification` handshake — a challenge echo, never an ingress delivery. */
export const parseSlackUrlVerificationChallenge = (
  input: ParseSlackUrlVerificationChallengeInput
): string => {
  const parsed = SlackUrlVerificationEnvelopeSchema.safeParse(input.envelopePayload);
  if (!parsed.success) throw malformedEnvelopeError(parsed.error);
  return parsed.data.challenge;
};
