import { SlackProgressRequestSchema } from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import { assertPostable, type SlackMessageComposition } from "../../src/message/postable.js";
import { composeSlackMessage, type SlackMessageEnvelope } from "../../src/message/compose.js";

const RUN_URL = "https://runs.autostack.dev/run/abc123";
const ENVELOPE: SlackMessageEnvelope = {
  bindingRef: "binding-eng-autostack",
  threadTs: "1690000000.000100"
};

const EVIDENCE_DIGEST_A = "a".repeat(64);
const EVIDENCE_DIGEST_B = "b".repeat(64);

const taskSummary: SlackMessageComposition = {
  kind: "task_summary",
  summary: "The reported crash reproduces on a null pointer in the parser.",
  taskType: "bug",
  detectedRepository: "octocat/hello-world",
  runUrl: RUN_URL
};

const clarifyingQuestion: SlackMessageComposition = {
  kind: "clarifying_question",
  question: "Should this ship behind a feature flag?",
  clarificationRef: "clarify-001",
  runUrl: RUN_URL
};

const stageProgress: SlackMessageComposition = {
  kind: "stage_progress",
  stage: "verify",
  status: "started",
  headline: "Running the verification suite",
  runUrl: RUN_URL,
  evidenceDigest: EVIDENCE_DIGEST_A
};

const attentionRequest: SlackMessageComposition = {
  kind: "attention_request",
  headline: "Running the verification suite",
  runUrl: RUN_URL,
  evidenceDigest: EVIDENCE_DIGEST_A
};

const publicationResult: SlackMessageComposition = {
  kind: "publication_result",
  pullRequestUrl: "https://github.com/octocat/hello-world/pull/42",
  pullRequestNumber: 42,
  verificationHeadline: "All 3 required checks passed",
  reviewVerdict: "approved",
  runUrl: RUN_URL,
  evidenceDigest: EVIDENCE_DIGEST_A
};

describe("composeSlackMessage", () => {
  it("composes a task_summary message naming the detected repository and task type", async () => {
    const result = await composeSlackMessage(taskSummary, ENVELOPE);
    expect(() => SlackProgressRequestSchema.parse(result)).not.toThrow();
    expect(() => assertPostable(result.text)).not.toThrow();
    expect(result.text).toContain("octocat/hello-world");
    expect(result.text).toContain("bug");
    expect(result.text).toContain(RUN_URL);
    expect(result.bindingRef).toBe(ENVELOPE.bindingRef);
    expect(result.threadTs).toBe(ENVELOPE.threadTs);
  });

  it("composes a clarifying_question message carrying the clarification reference", async () => {
    const result = await composeSlackMessage(clarifyingQuestion, ENVELOPE);
    expect(() => SlackProgressRequestSchema.parse(result)).not.toThrow();
    expect(() => assertPostable(result.text)).not.toThrow();
    expect(result.text).toContain("clarify-001");
    expect(result.text).toContain("Should this ship behind a feature flag?");
    expect(result.text).toContain(RUN_URL);
  });

  it("composes a stage_progress message naming the stage and status", async () => {
    const result = await composeSlackMessage(stageProgress, ENVELOPE);
    expect(() => SlackProgressRequestSchema.parse(result)).not.toThrow();
    expect(() => assertPostable(result.text)).not.toThrow();
    expect(result.text).toContain("verify");
    expect(result.text).toContain("started");
    expect(result.text).toContain(RUN_URL);
    expect(result.evidenceDigest).toBe(EVIDENCE_DIGEST_A);
  });

  it("composes an attention_request message distinguishable from ordinary progress", async () => {
    const attention = await composeSlackMessage(attentionRequest, ENVELOPE);
    const progress = await composeSlackMessage(stageProgress, ENVELOPE);
    expect(() => SlackProgressRequestSchema.parse(attention)).not.toThrow();
    expect(() => assertPostable(attention.text)).not.toThrow();
    expect(attention.text).toContain("Attention");
    expect(progress.text).not.toContain("Attention");
    expect(attention.text).toContain(RUN_URL);
  });

  it("composes a publication_result message with the PR link and evidence summary, nothing diff-like", async () => {
    const result = await composeSlackMessage(publicationResult, ENVELOPE);
    expect(() => SlackProgressRequestSchema.parse(result)).not.toThrow();
    expect(() => assertPostable(result.text)).not.toThrow();
    expect(result.text).toContain("https://github.com/octocat/hello-world/pull/42");
    expect(result.text).toContain("All 3 required checks passed");
    expect(result.text).toContain(RUN_URL);
    expect(result.text).not.toMatch(/\n--- a\//);
    expect(result.text).not.toMatch(/\n\+\+\+ b\//);
  });

  it("produces a stable idempotency key for a retry of the same message", async () => {
    const first = await composeSlackMessage(stageProgress, ENVELOPE);
    const second = await composeSlackMessage(stageProgress, ENVELOPE);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it("produces a different idempotency key when the binding differs", async () => {
    const first = await composeSlackMessage(stageProgress, ENVELOPE);
    const second = await composeSlackMessage(stageProgress, {
      ...ENVELOPE,
      bindingRef: "binding-other-channel"
    });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("produces a different idempotency key when the thread differs", async () => {
    const first = await composeSlackMessage(stageProgress, ENVELOPE);
    const second = await composeSlackMessage(stageProgress, {
      ...ENVELOPE,
      threadTs: "1690000000.000200"
    });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("produces a different idempotency key for different message kinds in the same thread", async () => {
    const progress = await composeSlackMessage(stageProgress, ENVELOPE);
    const attention = await composeSlackMessage(attentionRequest, ENVELOPE);
    expect(progress.idempotencyKey).not.toBe(attention.idempotencyKey);
  });

  it("produces a different idempotency key for a different evidenceDigest on the same kind", async () => {
    const first = await composeSlackMessage(stageProgress, ENVELOPE);
    const second = await composeSlackMessage(
      { ...stageProgress, evidenceDigest: EVIDENCE_DIGEST_B },
      ENVELOPE
    );
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it("produces a different idempotency key for two genuinely different task_summary messages in the same thread", async () => {
    const first = await composeSlackMessage(taskSummary, ENVELOPE);
    const second = await composeSlackMessage(
      { ...taskSummary, summary: "A completely different reported issue." },
      ENVELOPE
    );
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});
