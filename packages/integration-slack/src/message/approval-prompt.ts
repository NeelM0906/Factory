import {
  SlackApprovalPromptSchema,
  digestVersionedValue,
  type ApprovalId,
  type Approval,
  type RunId,
  type SlackApprovalPrompt
} from "@autostack/contracts";

import { assertPostable } from "./postable.js";

/** `SlackApprovalPromptSchema.shape.kind` mirrors `ApprovalSchema.shape.kind` (spec §4.3). */
type ApprovalKind = Approval["kind"];

const SCHEMA_VERSION = 1 as const;

const APPROVE_ACTION_ID = "autostack_approve";
const REJECT_ACTION_ID = "autostack_reject";

/**
 * Everything needed to compose an approval prompt for a bound Slack thread. Carries only a
 * summary and a link — there is no field capable of carrying the plan diff.
 */
export interface ComposeApprovalPromptInput {
  readonly bindingRef: string;
  readonly threadTs: string;
  readonly runId: RunId;
  readonly approvalId: ApprovalId;
  readonly kind: ApprovalKind;
  readonly summary: string;
  readonly evidenceDigest: string;
  readonly runUrl: string;
}

const renderRunLink = (runUrl: string): string => `<${runUrl}|View run>`;

/**
 * Builds a validated {@link SlackApprovalPrompt} (spec §4.3 publication approval). The summary is
 * gated through {@link assertPostable} together with the run link, so an unpostable summary (a
 * diff, terminal output, hidden reasoning, or a credential) never reaches the schema.
 */
export const composeApprovalPrompt = async (
  input: ComposeApprovalPromptInput
): Promise<SlackApprovalPrompt> => {
  const summary = `${input.summary}\n${renderRunLink(input.runUrl)}`;
  assertPostable(summary);

  const idempotencyKey = await digestVersionedValue("autostack.slack-approval-prompt-idempotency", {
    bindingRef: input.bindingRef,
    threadTs: input.threadTs,
    runId: input.runId,
    approvalId: input.approvalId,
    kind: input.kind,
    evidenceDigest: input.evidenceDigest
  });

  return SlackApprovalPromptSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    idempotencyKey,
    bindingRef: input.bindingRef,
    threadTs: input.threadTs,
    runId: input.runId,
    approvalId: input.approvalId,
    kind: input.kind,
    summary,
    evidenceDigest: input.evidenceDigest
  });
};

// --- Slack Block Kit rendering ------------------------------------------------------------------
//
// A minimal, locally-scoped subset of Block Kit — just enough to render a summary section and an
// approve/reject actions block. This is presentation only; it is never part of the contracts
// schema, and it carries nothing beyond what SlackApprovalPrompt already validated.

export interface SlackBlockText {
  readonly type: "plain_text" | "mrkdwn";
  readonly text: string;
}

export interface SlackSectionBlock {
  readonly type: "section";
  readonly text: SlackBlockText;
}

export interface SlackButtonElement {
  readonly type: "button";
  readonly action_id: string;
  readonly text: SlackBlockText;
  readonly value: string;
  readonly style: "primary" | "danger";
}

export interface SlackActionsBlock {
  readonly type: "actions";
  readonly elements: readonly SlackButtonElement[];
}

export type SlackBlock = SlackSectionBlock | SlackActionsBlock;

/**
 * Renders the approve/reject buttons for a composed prompt. Both buttons carry the same `value`:
 * a JSON object of exactly `runId`, `approvalId`, and `evidenceDigest` — the identity that
 * `parseSlackApprovalAction` (spec §4.3 / §13.2) parses back out, so the prompt and the resulting
 * action are two halves of one contract.
 */
export const buildApprovalPromptBlocks = (prompt: SlackApprovalPrompt): readonly SlackBlock[] => {
  const value = JSON.stringify({
    runId: prompt.runId,
    approvalId: prompt.approvalId,
    evidenceDigest: prompt.evidenceDigest
  });

  return [
    { type: "section", text: { type: "mrkdwn", text: prompt.summary } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: APPROVE_ACTION_ID,
          text: { type: "plain_text", text: "Approve" },
          value,
          style: "primary"
        },
        {
          type: "button",
          action_id: REJECT_ACTION_ID,
          text: { type: "plain_text", text: "Reject" },
          value,
          style: "danger"
        }
      ]
    }
  ];
};
