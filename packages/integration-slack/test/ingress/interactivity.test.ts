import { IngressDeliverySchema, SlackApprovalActionSchema } from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import { SlackRequestError } from "../../src/errors.js";
import {
  parseSlackApprovalAction,
  parseSlackMessageAction
} from "../../src/ingress/interactivity.js";
import approveFixture from "../fixtures/slack/block_actions.approve.json";
import rejectFixture from "../fixtures/slack/block_actions.reject.json";
import tamperedFixture from "../fixtures/slack/block_actions.tampered.json";
import messageActionFixture from "../fixtures/slack/message_action.json";

const RECEIVED_AT = "2026-08-27T12:00:00.000Z";

const BINDING = {
  bindingRef: "slack-binding-eng-autostack",
  slackWorkspaceId: "T0AUTOSTACK1"
};

type JsonRecord = Record<string, unknown>;

const cloneActionPayload = (fixture: typeof approveFixture): JsonRecord =>
  structuredClone(fixture) as unknown as JsonRecord;

describe("parseSlackMessageAction", () => {
  it("maps a message shortcut to event: 'message_action' and parses under IngressDeliverySchema", () => {
    const delivery = parseSlackMessageAction(messageActionFixture, { receivedAt: RECEIVED_AT });

    expect(delivery.provider).toBe("slack");
    expect(delivery.event).toBe("message_action");
    expect(delivery.channelId).toBe(messageActionFixture.channel.id);
    expect(delivery.messageTs).toBe(messageActionFixture.message.ts);
    expect(() => IngressDeliverySchema.parse(delivery)).not.toThrow();
  });

  it("takes thread identity from the source message, falling back to the message's own ts", () => {
    const delivery = parseSlackMessageAction(messageActionFixture, { receivedAt: RECEIVED_AT });

    expect(delivery.threadTs).toBe(messageActionFixture.message.ts);
  });

  it("uses the source message's thread_ts when it is already a reply", () => {
    const threaded = cloneActionPayload(messageActionFixture as unknown as typeof approveFixture);
    (threaded.message as JsonRecord).thread_ts = "1699999999.000001";

    const delivery = parseSlackMessageAction(threaded, { receivedAt: RECEIVED_AT });

    expect(delivery.threadTs).toBe("1699999999.000001");
  });
});

describe("parseSlackApprovalAction", () => {
  it("reads runId, approvalId, decision, and evidenceDigest from the button value and validates them", () => {
    const action = parseSlackApprovalAction(approveFixture, {
      bindingRef: BINDING,
      receivedAt: RECEIVED_AT
    });

    expect(action.decision).toBe("approved");
    expect(action.runId).toBe("run_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(action.approvalId).toBe("apr_11111111-2222-4333-8444-555555555555");
    expect(action.evidenceDigest).toBe(
      "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4"
    );
    expect(() => SlackApprovalActionSchema.parse(action)).not.toThrow();
  });

  it("maps the reject action id to decision: 'rejected'", () => {
    const action = parseSlackApprovalAction(rejectFixture, {
      bindingRef: BINDING,
      receivedAt: RECEIVED_AT
    });

    expect(action.decision).toBe("rejected");
    expect(() => SlackApprovalActionSchema.parse(action)).not.toThrow();
  });

  it("rejects a value whose runId does not match the branded RunId schema", () => {
    expect(() =>
      parseSlackApprovalAction(tamperedFixture, { bindingRef: BINDING, receivedAt: RECEIVED_AT })
    ).toThrow(SlackRequestError);
  });

  it("rejects a value whose approvalId does not match the branded ApprovalId schema", () => {
    const payload = cloneActionPayload(approveFixture);
    const actions = payload.actions as JsonRecord[];
    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("fixture must carry at least one action");
    firstAction.value = JSON.stringify({
      runId: "run_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      approvalId: "not-an-approval-id",
      evidenceDigest: "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4"
    });

    expect(() =>
      parseSlackApprovalAction(payload, { bindingRef: BINDING, receivedAt: RECEIVED_AT })
    ).toThrow(SlackRequestError);
  });

  it("rejects a value missing required fields (malformed shape)", () => {
    const payload = cloneActionPayload(approveFixture);
    const actions = payload.actions as JsonRecord[];
    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("fixture must carry at least one action");
    firstAction.value = JSON.stringify({ runId: "run_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });

    expect(() =>
      parseSlackApprovalAction(payload, { bindingRef: BINDING, receivedAt: RECEIVED_AT })
    ).toThrow(SlackRequestError);
  });

  it("rejects a value whose evidenceDigest is not 64 hex characters", () => {
    const payload = cloneActionPayload(approveFixture);
    const actions = payload.actions as JsonRecord[];
    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("fixture must carry at least one action");
    firstAction.value = JSON.stringify({
      runId: "run_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      approvalId: "apr_11111111-2222-4333-8444-555555555555",
      evidenceDigest: "not-a-hex-digest"
    });

    expect(() =>
      parseSlackApprovalAction(payload, { bindingRef: BINDING, receivedAt: RECEIVED_AT })
    ).toThrow(SlackRequestError);
  });

  it("throws on a tampered (non-JSON) value", () => {
    const payload = cloneActionPayload(approveFixture);
    const actions = payload.actions as JsonRecord[];
    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("fixture must carry at least one action");
    firstAction.value = "not-json-at-all";

    expect(() =>
      parseSlackApprovalAction(payload, { bindingRef: BINDING, receivedAt: RECEIVED_AT })
    ).toThrow(SlackRequestError);
  });

  it("throws on an absent value", () => {
    const payload = cloneActionPayload(approveFixture);
    const actions = payload.actions as JsonRecord[];
    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("fixture must carry at least one action");
    delete firstAction.value;

    expect(() =>
      parseSlackApprovalAction(payload, { bindingRef: BINDING, receivedAt: RECEIVED_AT })
    ).toThrow(SlackRequestError);
  });

  it("refuses a payload whose team.id disagrees with the supplied binding", () => {
    const payload = cloneActionPayload(approveFixture);
    (payload.team as JsonRecord).id = "T0SOMEOTHERTEAM";

    expect(() =>
      parseSlackApprovalAction(payload, { bindingRef: BINDING, receivedAt: RECEIVED_AT })
    ).toThrow(SlackRequestError);
  });

  it("computes the dedup key slack:action:{teamId}:{approvalId}:{messageTs}", () => {
    const action = parseSlackApprovalAction(approveFixture, {
      bindingRef: BINDING,
      receivedAt: RECEIVED_AT
    });

    expect(action.deduplicationKey).toBe(
      `slack:action:${approveFixture.team.id}:${action.approvalId}:${approveFixture.message.ts}`
    );
  });

  it("yields the same dedup key on a double-click (same button clicked twice)", () => {
    const first = parseSlackApprovalAction(approveFixture, {
      bindingRef: BINDING,
      receivedAt: RECEIVED_AT
    });
    const doubleClicked = cloneActionPayload(approveFixture);
    const actions = doubleClicked.actions as JsonRecord[];
    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("fixture must carry at least one action");
    firstAction.action_ts = "1700000300.999999"; // a fresh interaction timestamp, same click target
    const second = parseSlackApprovalAction(doubleClicked, {
      bindingRef: BINDING,
      receivedAt: RECEIVED_AT
    });

    expect(first.deliveryId).not.toBe(second.deliveryId);
    expect(first.deduplicationKey).toBe(second.deduplicationKey);
  });

  it("refuses a multi-action payload instead of deciding by array order", () => {
    // A crafted payload pairing an approve button with a reject button must not be resolved by
    // position. Slack sends exactly one action per button interaction, so more than one is
    // ambiguous — and an ambiguous approval decision has to fail closed, not pick index 0.
    const payload = cloneActionPayload(approveFixture);
    const actions = payload.actions as JsonRecord[];
    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("fixture must carry at least one action");
    const rejectAction = { ...firstAction, action_id: "autostack_reject" };
    payload.actions = [firstAction, rejectAction];

    expect(() =>
      parseSlackApprovalAction(payload, { bindingRef: BINDING, receivedAt: RECEIVED_AT })
    ).toThrow(SlackRequestError);
  });

  it("throws rather than defaulting to approve for an unknown action_id", () => {
    const payload = cloneActionPayload(approveFixture);
    const actions = payload.actions as JsonRecord[];
    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("fixture must carry at least one action");
    firstAction.action_id = "autostack_snooze";

    expect.assertions(2);
    try {
      parseSlackApprovalAction(payload, { bindingRef: BINDING, receivedAt: RECEIVED_AT });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      // Must not have silently resolved to an approval decision.
      expect((error as SlackRequestError).message).not.toContain("approved");
    }
  });
});
