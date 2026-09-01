import { IngressDeliverySchema } from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import {
  SlackUnsupportedEventError,
  buildSlackDeliveryDeduplicationKey,
  parseSlackEventDelivery,
  parseSlackUrlVerificationChallenge
} from "../../src/ingress/event-delivery.js";
import appMentionFixture from "../fixtures/slack/app_mention.json";
import injectionFixture from "../fixtures/slack/app_mention.injection.json";
import channelJoinFixture from "../fixtures/slack/message.channel_join.json";
import botMessageFixture from "../fixtures/slack/message.bot.json";
import dmFixture from "../fixtures/slack/message.im.json";
import urlVerificationFixture from "../fixtures/slack/url_verification.json";

const RECEIVED_AT = "2026-08-27T12:00:00.000Z";

type EnvelopeFixture = { readonly event: Record<string, unknown> } & Record<string, unknown>;

// Deep-clones a fixture and applies an override to its nested `event` object, so individual
// tests can construct a variant payload without mutating the shared fixture import.
const withEventOverride = (fixture: unknown, override: Record<string, unknown>): unknown => {
  const cloned = structuredClone(fixture) as EnvelopeFixture;
  return { ...cloned, event: { ...cloned.event, ...override } };
};

describe("parseSlackEventDelivery", () => {
  it("maps an app_mention event to event: 'app_mention' and parses under IngressDeliverySchema", () => {
    const delivery = parseSlackEventDelivery({
      envelopePayload: appMentionFixture,
      receivedAt: RECEIVED_AT
    });

    expect(delivery.provider).toBe("slack");
    expect(delivery.event).toBe("app_mention");
    expect(() => IngressDeliverySchema.parse(delivery)).not.toThrow();
  });

  it("maps a DM message (channel_type: 'im') to event: 'message' and parses under IngressDeliverySchema", () => {
    const delivery = parseSlackEventDelivery({
      envelopePayload: dmFixture,
      receivedAt: RECEIVED_AT
    });

    expect(delivery.provider).toBe("slack");
    expect(delivery.event).toBe("message");
    expect(() => IngressDeliverySchema.parse(delivery)).not.toThrow();
  });

  it("falls back threadTs to messageTs for a top-level (un-threaded) message", () => {
    const delivery = parseSlackEventDelivery({
      envelopePayload: appMentionFixture,
      receivedAt: RECEIVED_AT
    });

    expect(delivery.threadTs).toBe(delivery.messageTs);
    expect(delivery.threadTs).toBe(appMentionFixture.event.ts);
  });

  it("keeps threadTs as the reply's thread_ts for an already-threaded message", () => {
    const threaded = withEventOverride(dmFixture, { thread_ts: "1699999999.000001" });

    const delivery = parseSlackEventDelivery({
      envelopePayload: threaded,
      receivedAt: RECEIVED_AT
    });

    expect(delivery.threadTs).toBe("1699999999.000001");
    expect(delivery.threadTs).not.toBe(delivery.messageTs);
  });

  it("computes the logical dedup key slack:{teamId}:{channelId}:{messageTs}", () => {
    const delivery = parseSlackEventDelivery({
      envelopePayload: appMentionFixture,
      receivedAt: RECEIVED_AT
    });

    expect(delivery.deduplicationKey).toBe(
      buildSlackDeliveryDeduplicationKey(
        appMentionFixture.team_id,
        appMentionFixture.event.channel,
        appMentionFixture.event.ts
      )
    );
    expect(delivery.deduplicationKey).toBe(
      `slack:${appMentionFixture.team_id}:${appMentionFixture.event.channel}:${appMentionFixture.event.ts}`
    );
  });

  it("yields the same dedup key when the same message is redelivered under a different deliveryId", () => {
    const redelivered = { ...structuredClone(appMentionFixture), event_id: "Ev0AUTOSTACKRETRY" };

    const first = parseSlackEventDelivery({
      envelopePayload: appMentionFixture,
      receivedAt: RECEIVED_AT
    });
    const retry = parseSlackEventDelivery({
      envelopePayload: redelivered,
      receivedAt: RECEIVED_AT
    });

    expect(first.deliveryId).not.toBe(retry.deliveryId);
    expect(first.deduplicationKey).toBe(retry.deduplicationKey);
    expect(retry.deduplicationKey).not.toContain(retry.deliveryId);
  });

  it("yields a different dedup key for a different channel", () => {
    const other = withEventOverride(appMentionFixture, { channel: "C0DIFFERENTCH" });

    const original = parseSlackEventDelivery({
      envelopePayload: appMentionFixture,
      receivedAt: RECEIVED_AT
    });
    const different = parseSlackEventDelivery({ envelopePayload: other, receivedAt: RECEIVED_AT });

    expect(different.deduplicationKey).not.toBe(original.deduplicationKey);
  });

  it("yields a different dedup key for a different message timestamp", () => {
    const other = withEventOverride(appMentionFixture, { ts: "1700000199.999999" });

    const original = parseSlackEventDelivery({
      envelopePayload: appMentionFixture,
      receivedAt: RECEIVED_AT
    });
    const different = parseSlackEventDelivery({ envelopePayload: other, receivedAt: RECEIVED_AT });

    expect(different.deduplicationKey).not.toBe(original.deduplicationKey);
  });

  it("yields a different dedup key for a different Slack workspace (team)", () => {
    const other = { ...structuredClone(appMentionFixture), team_id: "T0DIFFERENTTEAM" };

    const original = parseSlackEventDelivery({
      envelopePayload: appMentionFixture,
      receivedAt: RECEIVED_AT
    });
    const different = parseSlackEventDelivery({ envelopePayload: other, receivedAt: RECEIVED_AT });

    expect(different.deduplicationKey).not.toBe(original.deduplicationKey);
  });

  it("throws SlackUnsupportedEventError for a bot echo carrying bot_id", () => {
    expect(() =>
      parseSlackEventDelivery({ envelopePayload: botMessageFixture, receivedAt: RECEIVED_AT })
    ).toThrow(SlackUnsupportedEventError);
  });

  it("throws SlackUnsupportedEventError for a bot_message subtype even without bot_id", () => {
    const withoutBotId = withEventOverride(botMessageFixture, { bot_id: undefined });
    delete (withoutBotId as { event: { bot_id?: string } }).event.bot_id;

    expect(() =>
      parseSlackEventDelivery({ envelopePayload: withoutBotId, receivedAt: RECEIVED_AT })
    ).toThrow(SlackUnsupportedEventError);
  });

  it("throws SlackUnsupportedEventError for an ignorable subtype (channel_join)", () => {
    expect(() =>
      parseSlackEventDelivery({ envelopePayload: channelJoinFixture, receivedAt: RECEIVED_AT })
    ).toThrow(SlackUnsupportedEventError);
  });

  it("carries the injection fixture's text through verbatim, and it cannot express a permission or policy", () => {
    const delivery = parseSlackEventDelivery({
      envelopePayload: injectionFixture,
      receivedAt: RECEIVED_AT
    });

    expect(delivery.text).toBe(injectionFixture.event.text);
    // The instruction-shaped text is carried as inert data: it changes no other field. The
    // delivery's structural fields are derived only from envelope metadata (team/channel/ts),
    // never parsed out of the message body.
    expect(delivery.event).toBe("app_mention");
    expect(delivery.channelId).toBe(injectionFixture.event.channel);
    expect(delivery.userId).toBe(injectionFixture.event.user);
    expect(delivery.deduplicationKey).toBe(
      `slack:${injectionFixture.team_id}:${injectionFixture.event.channel}:${injectionFixture.event.ts}`
    );
    expect(() => IngressDeliverySchema.parse(delivery)).not.toThrow();
  });

  it("rejects oversized text via the contract's bound rather than truncating it", () => {
    const oversized = withEventOverride(appMentionFixture, { text: "x".repeat(100_001) });

    expect(() =>
      parseSlackEventDelivery({ envelopePayload: oversized, receivedAt: RECEIVED_AT })
    ).toThrow();
  });

  it("throws SlackUnsupportedEventError for an event type this module does not act on", () => {
    const reaction = withEventOverride(appMentionFixture, { type: "reaction_added" });

    expect(() =>
      parseSlackEventDelivery({ envelopePayload: reaction, receivedAt: RECEIVED_AT })
    ).toThrow(SlackUnsupportedEventError);
  });
});

describe("parseSlackUrlVerificationChallenge", () => {
  it("returns the challenge from a url_verification envelope", () => {
    const challenge = parseSlackUrlVerificationChallenge({
      envelopePayload: urlVerificationFixture
    });

    expect(challenge).toBe(urlVerificationFixture.challenge);
  });

  it("is rejected by parseSlackEventDelivery instead of being smuggled through as a delivery", () => {
    expect(() =>
      parseSlackEventDelivery({ envelopePayload: urlVerificationFixture, receivedAt: RECEIVED_AT })
    ).toThrow();
  });

  it("rejects a malformed url_verification envelope (missing challenge)", () => {
    const malformed = { ...structuredClone(urlVerificationFixture), challenge: "" };
    delete (malformed as { challenge?: string }).challenge;

    expect(() => parseSlackUrlVerificationChallenge({ envelopePayload: malformed })).toThrow();
  });
});
