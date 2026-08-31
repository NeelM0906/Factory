import {
  SlackProgressRequestSchema,
  digestVersionedValue,
  type SlackProgressRequest
} from "@autostack/contracts";

import { assertPostable, type SlackMessageComposition } from "./postable.js";

/**
 * Delivery coordinates for a composed message: which bound channel/thread it targets. These are
 * routing metadata the pipeline (S4) already knows — which thread to post into — not message
 * content, so they sit outside the {@link SlackMessageComposition} content union.
 */
export interface SlackMessageEnvelope {
  readonly bindingRef: string;
  readonly threadTs: string;
}

const SCHEMA_VERSION = 1 as const;

const renderRunLink = (runUrl: string): string => `<${runUrl}|View run>`;

const renderTaskSummary = (
  composition: Extract<SlackMessageComposition, { kind: "task_summary" }>
): string =>
  [
    `*Task detected:* ${composition.taskType} in \`${composition.detectedRepository}\``,
    composition.summary,
    renderRunLink(composition.runUrl)
  ].join("\n");

const renderClarifyingQuestion = (
  composition: Extract<SlackMessageComposition, { kind: "clarifying_question" }>
): string =>
  [
    `*Clarification needed* (ref: ${composition.clarificationRef})`,
    composition.question,
    renderRunLink(composition.runUrl)
  ].join("\n");

const renderStageProgress = (
  composition: Extract<SlackMessageComposition, { kind: "stage_progress" }>
): string =>
  [
    `*Stage ${composition.stage}:* ${composition.status}`,
    composition.headline,
    renderRunLink(composition.runUrl)
  ].join("\n");

const renderAttentionRequest = (
  composition: Extract<SlackMessageComposition, { kind: "attention_request" }>
): string =>
  [
    ":rotating_light: *Attention needed*",
    composition.headline,
    renderRunLink(composition.runUrl)
  ].join("\n");

const renderPublicationResult = (
  composition: Extract<SlackMessageComposition, { kind: "publication_result" }>
): string =>
  [
    `*Draft pull request #${composition.pullRequestNumber} ready* (${composition.reviewVerdict})`,
    composition.verificationHeadline,
    `<${composition.pullRequestUrl}|View pull request>`,
    renderRunLink(composition.runUrl)
  ].join("\n");

type ContentIdentity = Readonly<Record<string, string | number>>;

interface ComposedContent {
  readonly text: string;
  readonly identity: ContentIdentity;
  /** Present only when the composition already carries an upstream evidence digest. */
  readonly evidenceDigest?: string;
}

/**
 * Renders the message text and the fields that make this exact message unique within a thread.
 * Exhaustive over `kind` with no `default` (see `postable.ts`'s exhaustiveness proof): adding a
 * sixth variant without a matching case here is a compile error, not a silent gap.
 */
const contentFor = (composition: SlackMessageComposition): ComposedContent => {
  switch (composition.kind) {
    case "task_summary":
      return {
        text: renderTaskSummary(composition),
        identity: {
          summary: composition.summary,
          taskType: composition.taskType,
          detectedRepository: composition.detectedRepository,
          runUrl: composition.runUrl
        }
      };
    case "clarifying_question":
      return {
        text: renderClarifyingQuestion(composition),
        identity: {
          question: composition.question,
          clarificationRef: composition.clarificationRef,
          runUrl: composition.runUrl
        }
      };
    case "stage_progress":
      return {
        text: renderStageProgress(composition),
        identity: {
          stage: composition.stage,
          status: composition.status,
          headline: composition.headline,
          runUrl: composition.runUrl,
          evidenceDigest: composition.evidenceDigest
        },
        evidenceDigest: composition.evidenceDigest
      };
    case "attention_request":
      return {
        text: renderAttentionRequest(composition),
        identity: {
          headline: composition.headline,
          runUrl: composition.runUrl,
          evidenceDigest: composition.evidenceDigest
        },
        evidenceDigest: composition.evidenceDigest
      };
    case "publication_result":
      return {
        text: renderPublicationResult(composition),
        identity: {
          pullRequestUrl: composition.pullRequestUrl,
          pullRequestNumber: composition.pullRequestNumber,
          verificationHeadline: composition.verificationHeadline,
          reviewVerdict: composition.reviewVerdict,
          runUrl: composition.runUrl,
          evidenceDigest: composition.evidenceDigest
        },
        evidenceDigest: composition.evidenceDigest
      };
  }
};

/**
 * Builds a validated {@link SlackProgressRequest} from one of the five typed message kinds (spec
 * §4.3, decision D7). The rendered text always carries a deep link to the run and is gated by
 * {@link assertPostable} before anything else happens — an unpostable composition never reaches
 * the schema or the idempotency key.
 *
 * `task_summary` and `clarifying_question` carry no upstream evidence digest of their own, so
 * their `evidenceDigest` is a content digest of the composition itself; the other three variants
 * pass their own `evidenceDigest` straight through. Either way, the idempotency key is stable for
 * `(bindingRef, threadTs, kind, …variant identity…, evidenceDigest)`, so a retry of the exact same
 * message never double-posts while two genuinely different messages in the same thread never
 * collide.
 */
export const composeSlackMessage = async (
  composition: SlackMessageComposition,
  envelope: SlackMessageEnvelope
): Promise<SlackProgressRequest> => {
  const content = contentFor(composition);
  assertPostable(content.text);

  const evidenceDigest =
    content.evidenceDigest ??
    (await digestVersionedValue("autostack.slack-message-content", {
      kind: composition.kind,
      ...content.identity
    }));

  const idempotencyKey = await digestVersionedValue("autostack.slack-message-idempotency", {
    bindingRef: envelope.bindingRef,
    threadTs: envelope.threadTs,
    kind: composition.kind,
    ...content.identity,
    evidenceDigest
  });

  return SlackProgressRequestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    idempotencyKey,
    bindingRef: envelope.bindingRef,
    threadTs: envelope.threadTs,
    text: content.text,
    evidenceDigest
  });
};
