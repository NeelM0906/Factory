import {
  containsSensitiveMaterial,
  type PipelineStage,
  type TriageTaskType
} from "@autostack/contracts";

import { SlackRequestError } from "../errors.js";

/**
 * The five things AutoStack posts into a Slack thread (spec section 4.3), modeled as an explicit
 * discriminated union rather than one generic "progress" shape (decision D7). Every variant is
 * derived from typed pipeline values S4 emits (`TriageReport`, `ClarificationRequest`,
 * `PipelineStage`, `DraftPullRequestResult`) - S5 owns the composer, S4 owns the data. No variant
 * has, or can be given, a field capable of carrying terminal output, a diff, hidden reasoning, or
 * a credential: the never-post list is unrepresentable, not merely unwritten.
 */
export type SlackMessageComposition =
  | {
      readonly kind: "task_summary";
      readonly summary: string; // <= 1000 chars, from TriageReport.rationale
      readonly taskType: TriageTaskType;
      readonly detectedRepository: string; // "owner/name", the section 4.3 "detected repository"
      readonly runUrl: string;
    }
  | {
      readonly kind: "clarifying_question";
      readonly question: string; // <= 1000 chars, from ClarificationRequest
      readonly clarificationRef: string;
      readonly runUrl: string;
    }
  | {
      readonly kind: "stage_progress";
      readonly stage: PipelineStage;
      readonly status: "started" | "succeeded" | "failed" | "waiting";
      readonly headline: string; // <= 280 chars
      readonly runUrl: string;
      readonly evidenceDigest: string;
    }
  | {
      readonly kind: "attention_request";
      readonly headline: string; // <= 280 chars - what the agent needs from the user
      readonly runUrl: string;
      readonly evidenceDigest: string;
    }
  | {
      readonly kind: "publication_result";
      readonly pullRequestUrl: string;
      readonly pullRequestNumber: number;
      readonly verificationHeadline: string; // <= 280 chars - the evidence summary
      readonly reviewVerdict: "approved";
      readonly runUrl: string;
      readonly evidenceDigest: string;
    };

const POSTABLE_BYTE_BUDGET = 3_000;
const FENCED_BLOCK_LINE_LIMIT = 10;

// Unified-diff signature (spec section 13.2): an explicit `--- a/`/`+++ b/` header, or a run of
// change lines long enough to be a real diff rather than a couple of markdown bullets.
const DIFF_HEADER_PATTERN = /\n--- a\/|\n\+\+\+ b\//;
const DIFF_CHANGE_LINE_COUNT_THRESHOLD = 20;

// A CSI-style ANSI escape sequence: the ESC control character (code point 27), built here via
// String.fromCharCode rather than a literal control byte in source, followed by a bracket,
// optional parameter digits/semicolons, and a terminating letter (for example a color code).
const ESCAPE_CONTROL_CHARACTER: string = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN: RegExp = new RegExp(`${ESCAPE_CONTROL_CHARACTER}\\[[0-9;]*[A-Za-z]`);
const FENCED_BLOCK_PATTERN = /```[\s\S]*?```/g;

const HIDDEN_REASONING_PATTERN = /<thinking>|<reasoning>/i;

const notPostable = (message: string): SlackRequestError =>
  new SlackRequestError(message, "not_postable", false);

const looksLikeDiff = (text: string): boolean => {
  if (DIFF_HEADER_PATTERN.test(text)) return true;
  const changeLineCount = text
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith("-")).length;
  return changeLineCount >= DIFF_CHANGE_LINE_COUNT_THRESHOLD;
};

const hasOversizedFencedBlock = (text: string): boolean => {
  const blocks = text.match(FENCED_BLOCK_PATTERN) ?? [];
  return blocks.some((block) => block.split("\n").length - 2 > FENCED_BLOCK_LINE_LIMIT);
};

const hasTerminalArtifacts = (text: string): boolean =>
  hasOversizedFencedBlock(text) || ANSI_ESCAPE_PATTERN.test(text) || text.includes("\r");

/**
 * The runtime half of the never-post gate (spec section 13.2), sitting under the type-level
 * narrowing of {@link SlackMessageComposition}. Rejects text carrying sensitive material, an
 * over-budget payload, a diff, terminal artefacts, or a hidden-reasoning marker.
 *
 * Never truncates: every rejection throws rather than shortening the text, because truncating
 * across a redaction boundary is how secrets leak.
 */
export const assertPostable = (text: string): void => {
  if (containsSensitiveMaterial(text)) {
    throw notPostable("Message text contains sensitive material and cannot be posted.");
  }
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > POSTABLE_BYTE_BUDGET) {
    throw notPostable(`Message text exceeds the ${POSTABLE_BYTE_BUDGET}-byte postable budget.`);
  }
  if (looksLikeDiff(text)) {
    throw notPostable("Message text resembles a diff and cannot be posted.");
  }
  if (hasTerminalArtifacts(text)) {
    throw notPostable("Message text contains terminal artefacts and cannot be posted.");
  }
  if (HIDDEN_REASONING_PATTERN.test(text)) {
    throw notPostable("Message text contains a hidden-reasoning marker and cannot be posted.");
  }
};
