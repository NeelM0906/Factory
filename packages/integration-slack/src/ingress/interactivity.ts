import {
  ApprovalIdSchema,
  IngressDeliverySchema,
  RunIdSchema,
  SlackApprovalActionSchema,
  type SlackApprovalAction
} from "@autostack/contracts";
import { z } from "zod";

import { SlackRequestError } from "../errors.js";
import { buildSlackDeliveryDeduplicationKey, type SlackIngressDelivery } from "./event-delivery.js";

const malformedPayloadError = (message: string, cause?: unknown): SlackRequestError =>
  new SlackRequestError(message, "invalid_request", false, { cause });

// --- Message shortcut (spec §4.3's third intake path) ---------------------------------------

const SlackMessageActionPayloadSchema = z.object({
  type: z.literal("message_action"),
  action_ts: z.string().min(1),
  team: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1) }),
  channel: z.object({ id: z.string().min(1) }),
  message: z.object({
    ts: z.string().min(1),
    thread_ts: z.string().min(1).optional(),
    text: z.string().optional()
  })
});

export interface ParseSlackMessageActionInput {
  readonly receivedAt: string;
}

/**
 * Maps a Slack "message shortcut" interaction — invoking AutoStack on an existing thread (spec
 * §4.3) — onto the `IngressDelivery` contract. Thread identity is taken from the source message,
 * falling back to its own timestamp when the message is not yet a reply.
 */
export const parseSlackMessageAction = (
  payload: unknown,
  input: ParseSlackMessageActionInput
): SlackIngressDelivery => {
  const parsed = SlackMessageActionPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw malformedPayloadError("Slack message action payload is malformed.", parsed.error);
  }

  const { action_ts: deliveryId, team, user, channel, message } = parsed.data;

  const candidate = {
    schemaVersion: 1 as const,
    provider: "slack" as const,
    deliveryId,
    deduplicationKey: buildSlackDeliveryDeduplicationKey(team.id, channel.id, message.ts),
    receivedAt: input.receivedAt,
    event: "message_action" as const,
    slackWorkspaceId: team.id,
    channelId: channel.id,
    threadTs: message.thread_ts ?? message.ts,
    messageTs: message.ts,
    userId: user.id,
    text: message.text ?? ""
  };

  const delivery = IngressDeliverySchema.parse(candidate);
  if (delivery.provider !== "slack") {
    throw malformedPayloadError("Slack message action did not resolve to a Slack delivery.");
  }
  return delivery;
};

// --- Approval actions (publication approval, spec §4.3 / §13.2) -----------------------------

const SlackBlockActionSchema = z.object({
  action_id: z.string().min(1),
  action_ts: z.string().min(1),
  value: z.string().min(1).optional()
});

const SlackBlockActionsPayloadSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string().min(1) }),
  user: z.object({ id: z.string().min(1) }),
  channel: z.object({ id: z.string().min(1) }),
  message: z.object({ ts: z.string().min(1) }),
  actions: z.array(SlackBlockActionSchema).min(1)
});

const SlackApprovalButtonValueSchema = z.object({
  runId: z.string().min(1),
  approvalId: z.string().min(1),
  evidenceDigest: z.string().min(1)
});

const EVIDENCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

const APPROVE_ACTION_ID = "autostack_approve";
const REJECT_ACTION_ID = "autostack_reject";

/**
 * Maps a Slack `action_id` to an approval decision. Fails closed: any `action_id` this module
 * does not explicitly recognize throws rather than defaulting to an approval, so a spoofed or
 * unrecognized button can never approve or reject work by accident.
 */
const decisionForActionId = (actionId: string): "approved" | "rejected" => {
  if (actionId === APPROVE_ACTION_ID) return "approved";
  if (actionId === REJECT_ACTION_ID) return "rejected";
  throw malformedPayloadError(
    `Slack action_id "${actionId}" is not a recognized approval decision.`
  );
};

export interface SlackApprovalActionBinding {
  readonly bindingRef: string;
  readonly slackWorkspaceId: string;
}

export interface ParseSlackApprovalActionInput {
  readonly bindingRef: SlackApprovalActionBinding;
  readonly receivedAt: string;
}

/**
 * Maps a Slack `block_actions` approve/reject interaction onto `SlackApprovalActionSchema` (spec
 * §4.3 publication approval). The button's `value` is attacker-influenceable — it is parsed and
 * then validated against the branded `RunId`/`ApprovalId` schemas and the 64-hex evidence digest
 * before anything downstream can trust it; a tampered or absent value is rejected. The caller is
 * expected to have already resolved the channel binding (D10, fail-closed); a payload whose
 * `team.id` disagrees with that resolved binding is refused rather than merged or defaulted
 * (spec §13.2: validate workspace and user binding before creating or mutating work).
 */
export const parseSlackApprovalAction = (
  payload: unknown,
  input: ParseSlackApprovalActionInput
): SlackApprovalAction => {
  const parsed = SlackBlockActionsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw malformedPayloadError("Slack block_actions payload is malformed.", parsed.error);
  }

  const { team, user, channel, message, actions } = parsed.data;

  if (team.id !== input.bindingRef.slackWorkspaceId) {
    throw malformedPayloadError("Slack action team does not match the resolved channel binding.");
  }

  // Exactly one action, never "the first of several". Slack sends a single action per button
  // interaction, so a payload carrying more than one is not something we should resolve by
  // position — a crafted payload pairing an approve with a reject would otherwise be decided by
  // array order. An ambiguous decision is refused, not silently disambiguated.
  if (actions.length !== 1) {
    throw malformedPayloadError(
      "Slack block_actions payload must carry exactly one approval action."
    );
  }
  const [action] = actions;
  if (action === undefined)
    throw malformedPayloadError("Slack block_actions payload has no actions.");

  const decision = decisionForActionId(action.action_id);

  if (action.value === undefined) {
    throw malformedPayloadError("Slack approval action value is missing.");
  }

  let rawValue: unknown;
  try {
    rawValue = JSON.parse(action.value);
  } catch (cause) {
    throw malformedPayloadError("Slack approval action value is not valid JSON.", cause);
  }

  const parsedValue = SlackApprovalButtonValueSchema.safeParse(rawValue);
  if (!parsedValue.success) {
    throw malformedPayloadError("Slack approval action value is malformed.", parsedValue.error);
  }

  const runId = RunIdSchema.safeParse(parsedValue.data.runId);
  if (!runId.success) throw malformedPayloadError("Slack approval action runId is invalid.");

  const approvalId = ApprovalIdSchema.safeParse(parsedValue.data.approvalId);
  if (!approvalId.success) {
    throw malformedPayloadError("Slack approval action approvalId is invalid.");
  }

  if (!EVIDENCE_DIGEST_PATTERN.test(parsedValue.data.evidenceDigest)) {
    throw malformedPayloadError("Slack approval action evidenceDigest is invalid.");
  }

  const candidate = {
    schemaVersion: 1 as const,
    bindingRef: input.bindingRef.bindingRef,
    slackWorkspaceId: team.id,
    channelId: channel.id,
    messageTs: message.ts,
    userId: user.id,
    runId: runId.data,
    approvalId: approvalId.data,
    decision,
    evidenceDigest: parsedValue.data.evidenceDigest,
    deliveryId: action.action_ts,
    deduplicationKey: `slack:action:${team.id}:${approvalId.data}:${message.ts}`,
    triggeredAt: input.receivedAt
  };

  return SlackApprovalActionSchema.parse(candidate);
};
