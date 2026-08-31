import { SlackApprovalPromptSchema, createId } from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import { assertPostable } from "../../src/message/postable.js";
import {
  buildApprovalPromptBlocks,
  composeApprovalPrompt,
  type ComposeApprovalPromptInput
} from "../../src/message/approval-prompt.js";
import { parseSlackApprovalAction } from "../../src/ingress/interactivity.js";

const RUN_ID = createId("run", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const APPROVAL_ID = createId("approval", "11111111-2222-4333-8444-555555555555");
const RUN_URL = "https://runs.autostack.dev/run/abc123";
const EVIDENCE_DIGEST = "a1b2c3d4".repeat(8);

const BASE_INPUT: ComposeApprovalPromptInput = {
  bindingRef: "binding-eng-autostack",
  threadTs: "1700000300.000500",
  runId: RUN_ID,
  approvalId: APPROVAL_ID,
  kind: "publish",
  summary: "AutoStack is ready to publish the draft pull request. Approve?",
  evidenceDigest: EVIDENCE_DIGEST,
  runUrl: RUN_URL
};

const SLACK_WORKSPACE_ID = "T0AUTOSTACK1";
const RECEIVED_AT = "2026-08-27T12:00:00.000Z";

describe("composeApprovalPrompt", () => {
  it("parses under SlackApprovalPromptSchema", async () => {
    const prompt = await composeApprovalPrompt(BASE_INPUT);
    expect(() => SlackApprovalPromptSchema.parse(prompt)).not.toThrow();
    expect(prompt.bindingRef).toBe(BASE_INPUT.bindingRef);
    expect(prompt.threadTs).toBe(BASE_INPUT.threadTs);
    expect(prompt.runId).toBe(RUN_ID);
    expect(prompt.approvalId).toBe(APPROVAL_ID);
    expect(prompt.kind).toBe("publish");
    expect(prompt.evidenceDigest).toBe(EVIDENCE_DIGEST);
  });

  it("gates the summary through assertPostable", async () => {
    const prompt = await composeApprovalPrompt(BASE_INPUT);
    expect(() => assertPostable(prompt.summary)).not.toThrow();
    expect(prompt.summary).toContain(RUN_URL);
  });

  it("rejects a summary containing sensitive material", async () => {
    await expect(
      composeApprovalPrompt({
        ...BASE_INPUT,
        summary: `Approve? token: ghp_${"A".repeat(24)}`
      })
    ).rejects.toThrow();
  });

  it("never embeds a diff in the summary", async () => {
    await expect(
      composeApprovalPrompt({
        ...BASE_INPUT,
        summary: "Approve?\n--- a/src/index.ts\n+++ b/src/index.ts\n"
      })
    ).rejects.toThrow();
  });

  it("produces a stable idempotency key for a retry of the same prompt", async () => {
    const first = await composeApprovalPrompt(BASE_INPUT);
    const second = await composeApprovalPrompt(BASE_INPUT);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it("produces a different idempotency key for a different approvalId", async () => {
    const first = await composeApprovalPrompt(BASE_INPUT);
    const second = await composeApprovalPrompt({
      ...BASE_INPUT,
      approvalId: createId("approval", "22222222-2222-4333-8444-555555555555")
    });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});

describe("buildApprovalPromptBlocks / parseSlackApprovalAction round trip", () => {
  it("reproduces the exact approval identity through an approve button", async () => {
    const prompt = await composeApprovalPrompt(BASE_INPUT);
    const blocks = buildApprovalPromptBlocks(prompt);

    const actionsBlock = blocks.find(
      (block): block is Extract<(typeof blocks)[number], { type: "actions" }> =>
        block.type === "actions"
    );
    expect(actionsBlock).toBeDefined();
    const approveButton = actionsBlock?.elements.find(
      (element) => element.action_id === "autostack_approve"
    );
    expect(approveButton).toBeDefined();

    const payload = {
      type: "block_actions",
      team: { id: SLACK_WORKSPACE_ID },
      user: { id: "U0HUMANMORGAN" },
      channel: { id: "C0AUTOSTACKCH" },
      message: { ts: prompt.threadTs },
      actions: [
        {
          action_id: approveButton?.action_id,
          action_ts: "1700000300.500600",
          value: approveButton?.value
        }
      ]
    };

    const action = parseSlackApprovalAction(payload, {
      bindingRef: { bindingRef: prompt.bindingRef, slackWorkspaceId: SLACK_WORKSPACE_ID },
      receivedAt: RECEIVED_AT
    });

    expect(action.decision).toBe("approved");
    expect(action.runId).toBe(prompt.runId);
    expect(action.approvalId).toBe(prompt.approvalId);
    expect(action.evidenceDigest).toBe(prompt.evidenceDigest);
    expect(action.bindingRef).toBe(prompt.bindingRef);
  });

  it("reproduces the exact approval identity through a reject button", async () => {
    const prompt = await composeApprovalPrompt(BASE_INPUT);
    const blocks = buildApprovalPromptBlocks(prompt);

    const actionsBlock = blocks.find(
      (block): block is Extract<(typeof blocks)[number], { type: "actions" }> =>
        block.type === "actions"
    );
    const rejectButton = actionsBlock?.elements.find(
      (element) => element.action_id === "autostack_reject"
    );
    expect(rejectButton).toBeDefined();

    const payload = {
      type: "block_actions",
      team: { id: SLACK_WORKSPACE_ID },
      user: { id: "U0HUMANMORGAN" },
      channel: { id: "C0AUTOSTACKCH" },
      message: { ts: prompt.threadTs },
      actions: [
        {
          action_id: rejectButton?.action_id,
          action_ts: "1700000300.500700",
          value: rejectButton?.value
        }
      ]
    };

    const action = parseSlackApprovalAction(payload, {
      bindingRef: { bindingRef: prompt.bindingRef, slackWorkspaceId: SLACK_WORKSPACE_ID },
      receivedAt: RECEIVED_AT
    });

    expect(action.decision).toBe("rejected");
    expect(action.runId).toBe(prompt.runId);
    expect(action.approvalId).toBe(prompt.approvalId);
    expect(action.evidenceDigest).toBe(prompt.evidenceDigest);
  });

  it("never embeds the plan diff — the block only carries the summary and buttons", async () => {
    const prompt = await composeApprovalPrompt(BASE_INPUT);
    const blocks = buildApprovalPromptBlocks(prompt);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toMatch(/\n--- a\//);
    expect(serialized).not.toMatch(/\n\+\+\+ b\//);
  });
});
