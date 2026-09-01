import { describe, expect, it } from "vitest";

import { SlackRequestError } from "../../src/index.js";
import { assertPostable, type SlackMessageComposition } from "../../src/message/postable.js";

const RUN_URL = "https://runs.autostack.dev/run/abc123";

describe("assertPostable", () => {
  it("throws not_postable for text containing an API-key-shaped credential", () => {
    const text = `Rotate this token: ghp_${"A".repeat(24)}`;
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
    try {
      assertPostable(text);
      throw new Error("expected assertPostable to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("not_postable");
    }
  });

  it("throws not_postable for text over the 3000-byte budget, without truncating", () => {
    const text = "Status update. ".repeat(300);
    expect(text.length).toBeGreaterThan(3_000);
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
    try {
      assertPostable(text);
    } catch (error) {
      expect((error as SlackRequestError).code).toBe("not_postable");
      // Never truncated: the error carries no partial copy of the oversized text.
      expect((error as SlackRequestError).message).not.toContain(text);
    }
  });

  // Rejects the wrong implementation: an off-by-one budget check (`length >= 3000` instead of
  // `> 3000`). Every over-budget case above still passes against that defect, so only a text of
  // exactly the budget distinguishes them. Without this companion the threshold is unpinned.
  it("passes for text of exactly the 3000-byte budget", () => {
    const text = "s".repeat(3_000);
    expect(new TextEncoder().encode(text).byteLength).toBe(3_000);
    expect(() => assertPostable(text)).not.toThrow();
  });

  it("throws not_postable for text carrying a unified-diff header", () => {
    const text = "Applied a fix.\n--- a/src/index.ts\n+++ b/src/index.ts\n";
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
  });

  it("throws not_postable for text with 20 or more +/- prefixed lines", () => {
    const changeLines = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? `+added line ${index}` : `-removed line ${index}`
    );
    const text = ["Summary of changes:", ...changeLines].join("\n");
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
  });

  // Rejects the wrong implementation: a diff-line threshold of `>= 19` (or any lower bound), which
  // the 20-line case above cannot tell apart from the correct `>= 20`. A legitimate status message
  // may well carry a handful of +/- bullet lines, so the lower side of this boundary is the side
  // that would silently break real posts.
  it("passes for text with 19 +/- prefixed lines, just under the diff threshold", () => {
    const changeLines = Array.from({ length: 19 }, (_, index) =>
      index % 2 === 0 ? `+added line ${index}` : `-removed line ${index}`
    );
    const text = ["Summary of changes:", ...changeLines].join("\n");
    expect(() => assertPostable(text)).not.toThrow();
  });

  it("throws not_postable for a fenced block over 10 lines", () => {
    const codeLines = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    const text = `Here is the output:\n\`\`\`\n${codeLines}\n\`\`\``;
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
  });

  it("passes for a fenced block of 10 lines or fewer", () => {
    const codeLines = Array.from({ length: 5 }, (_, index) => `line ${index}`).join("\n");
    const text = `Here is a short snippet:\n\`\`\`\n${codeLines}\n\`\`\`\n<${RUN_URL}|View run>`;
    expect(() => assertPostable(text)).not.toThrow();
  });

  it("throws not_postable for text containing ANSI escape sequences", () => {
    const esc = String.fromCharCode(27);
    const text = `Build ${esc}[31mfailed${esc}[0m — see <${RUN_URL}|the run>`;
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
  });

  it("throws not_postable for text containing a carriage-return terminal artefact", () => {
    const text = "Progress: 10%\rProgress: 100%";
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
  });

  it("throws not_postable for text containing a <thinking> hidden-reasoning marker", () => {
    const text = "<thinking>The user probably wants X</thinking> Here is the update.";
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
  });

  it("throws not_postable for text containing a <reasoning> hidden-reasoning marker", () => {
    const text = "<reasoning>Considering options...</reasoning> Here is the update.";
    expect(() => assertPostable(text)).toThrow(SlackRequestError);
  });

  it("passes for a normal status line with a link", () => {
    const text = `Stage "verify" succeeded. <${RUN_URL}|View run>`;
    expect(() => assertPostable(text)).not.toThrow();
  });
});

// --- Type-level proof: the never-post list is unrepresentable, not merely unwritten -----------
//
// None of the five SlackMessageComposition variants accept a `logs`, `diff`, `reasoning`,
// `stderr`, or `terminalOutput` property. TypeScript's excess-property check on a fresh object
// literal assigned directly to the union type catches this at compile time (via `pnpm check`),
// so this file is never executed for these declarations — it only needs to type-check.

const TASK_SUMMARY_BASE = {
  kind: "task_summary" as const,
  summary: "Investigate a failing test",
  taskType: "bug" as const,
  detectedRepository: "octocat/hello-world",
  runUrl: RUN_URL
};

const CLARIFYING_QUESTION_BASE = {
  kind: "clarifying_question" as const,
  question: "Which environment should this target?",
  clarificationRef: "clarify-001",
  runUrl: RUN_URL
};

const STAGE_PROGRESS_BASE = {
  kind: "stage_progress" as const,
  stage: "verify" as const,
  status: "started" as const,
  headline: "Running the verification suite",
  runUrl: RUN_URL,
  evidenceDigest: "a".repeat(64)
};

const ATTENTION_REQUEST_BASE = {
  kind: "attention_request" as const,
  headline: "Needs a decision on the target branch",
  runUrl: RUN_URL,
  evidenceDigest: "a".repeat(64)
};

const PUBLICATION_RESULT_BASE = {
  kind: "publication_result" as const,
  pullRequestUrl: "https://github.com/octocat/hello-world/pull/1",
  pullRequestNumber: 1,
  verificationHeadline: "All required checks passed",
  reviewVerdict: "approved" as const,
  runUrl: RUN_URL,
  evidenceDigest: "a".repeat(64)
};

// task_summary
const _taskSummaryLogs: SlackMessageComposition = {
  ...TASK_SUMMARY_BASE,
  // @ts-expect-error - task_summary must not accept a logs field
  logs: "leaked terminal output"
};
const _taskSummaryDiff: SlackMessageComposition = {
  ...TASK_SUMMARY_BASE,
  // @ts-expect-error - task_summary must not accept a diff field
  diff: "--- a/x\n+++ b/x"
};
const _taskSummaryReasoning: SlackMessageComposition = {
  ...TASK_SUMMARY_BASE,
  // @ts-expect-error - task_summary must not accept a reasoning field
  reasoning: "hidden chain of thought"
};
const _taskSummaryStderr: SlackMessageComposition = {
  ...TASK_SUMMARY_BASE,
  // @ts-expect-error - task_summary must not accept a stderr field
  stderr: "TypeError: boom"
};
const _taskSummaryTerminalOutput: SlackMessageComposition = {
  ...TASK_SUMMARY_BASE,
  // @ts-expect-error - task_summary must not accept a terminalOutput field
  terminalOutput: "$ pnpm test"
};

// clarifying_question
const _clarifyingQuestionLogs: SlackMessageComposition = {
  ...CLARIFYING_QUESTION_BASE,
  // @ts-expect-error - clarifying_question must not accept a logs field
  logs: "leaked terminal output"
};
const _clarifyingQuestionDiff: SlackMessageComposition = {
  ...CLARIFYING_QUESTION_BASE,
  // @ts-expect-error - clarifying_question must not accept a diff field
  diff: "--- a/x\n+++ b/x"
};
const _clarifyingQuestionReasoning: SlackMessageComposition = {
  ...CLARIFYING_QUESTION_BASE,
  // @ts-expect-error - clarifying_question must not accept a reasoning field
  reasoning: "hidden chain of thought"
};
const _clarifyingQuestionStderr: SlackMessageComposition = {
  ...CLARIFYING_QUESTION_BASE,
  // @ts-expect-error - clarifying_question must not accept a stderr field
  stderr: "TypeError: boom"
};
const _clarifyingQuestionTerminalOutput: SlackMessageComposition = {
  ...CLARIFYING_QUESTION_BASE,
  // @ts-expect-error - clarifying_question must not accept a terminalOutput field
  terminalOutput: "$ pnpm test"
};

// stage_progress
const _stageProgressLogs: SlackMessageComposition = {
  ...STAGE_PROGRESS_BASE,
  // @ts-expect-error - stage_progress must not accept a logs field
  logs: "leaked terminal output"
};
const _stageProgressDiff: SlackMessageComposition = {
  ...STAGE_PROGRESS_BASE,
  // @ts-expect-error - stage_progress must not accept a diff field
  diff: "--- a/x\n+++ b/x"
};
const _stageProgressReasoning: SlackMessageComposition = {
  ...STAGE_PROGRESS_BASE,
  // @ts-expect-error - stage_progress must not accept a reasoning field
  reasoning: "hidden chain of thought"
};
const _stageProgressStderr: SlackMessageComposition = {
  ...STAGE_PROGRESS_BASE,
  // @ts-expect-error - stage_progress must not accept a stderr field
  stderr: "TypeError: boom"
};
const _stageProgressTerminalOutput: SlackMessageComposition = {
  ...STAGE_PROGRESS_BASE,
  // @ts-expect-error - stage_progress must not accept a terminalOutput field
  terminalOutput: "$ pnpm test"
};

// attention_request
const _attentionRequestLogs: SlackMessageComposition = {
  ...ATTENTION_REQUEST_BASE,
  // @ts-expect-error - attention_request must not accept a logs field
  logs: "leaked terminal output"
};
const _attentionRequestDiff: SlackMessageComposition = {
  ...ATTENTION_REQUEST_BASE,
  // @ts-expect-error - attention_request must not accept a diff field
  diff: "--- a/x\n+++ b/x"
};
const _attentionRequestReasoning: SlackMessageComposition = {
  ...ATTENTION_REQUEST_BASE,
  // @ts-expect-error - attention_request must not accept a reasoning field
  reasoning: "hidden chain of thought"
};
const _attentionRequestStderr: SlackMessageComposition = {
  ...ATTENTION_REQUEST_BASE,
  // @ts-expect-error - attention_request must not accept a stderr field
  stderr: "TypeError: boom"
};
const _attentionRequestTerminalOutput: SlackMessageComposition = {
  ...ATTENTION_REQUEST_BASE,
  // @ts-expect-error - attention_request must not accept a terminalOutput field
  terminalOutput: "$ pnpm test"
};

// publication_result
const _publicationResultLogs: SlackMessageComposition = {
  ...PUBLICATION_RESULT_BASE,
  // @ts-expect-error - publication_result must not accept a logs field
  logs: "leaked terminal output"
};
const _publicationResultDiff: SlackMessageComposition = {
  ...PUBLICATION_RESULT_BASE,
  // @ts-expect-error - publication_result must not accept a diff field
  diff: "--- a/x\n+++ b/x"
};
const _publicationResultReasoning: SlackMessageComposition = {
  ...PUBLICATION_RESULT_BASE,
  // @ts-expect-error - publication_result must not accept a reasoning field
  reasoning: "hidden chain of thought"
};
const _publicationResultStderr: SlackMessageComposition = {
  ...PUBLICATION_RESULT_BASE,
  // @ts-expect-error - publication_result must not accept a stderr field
  stderr: "TypeError: boom"
};
const _publicationResultTerminalOutput: SlackMessageComposition = {
  ...PUBLICATION_RESULT_BASE,
  // @ts-expect-error - publication_result must not accept a terminalOutput field
  terminalOutput: "$ pnpm test"
};

// --- Exhaustiveness: a switch over `kind` with no `default` must compile ----------------------
//
// If a sixth variant is ever added to SlackMessageComposition without a matching case here, this
// function stops compiling ("not all code paths return a value") — a type error instead of a
// silent gap in the composer.
const describeCompositionKind = (composition: SlackMessageComposition): string => {
  switch (composition.kind) {
    case "task_summary":
      return "task_summary";
    case "clarifying_question":
      return "clarifying_question";
    case "stage_progress":
      return "stage_progress";
    case "attention_request":
      return "attention_request";
    case "publication_result":
      return "publication_result";
  }
};

describe("SlackMessageComposition exhaustiveness", () => {
  it("compiles a switch over kind with no default (see describeCompositionKind above)", () => {
    const composition: SlackMessageComposition = {
      kind: "task_summary",
      summary: "x",
      taskType: "bug",
      detectedRepository: "o/r",
      runUrl: RUN_URL
    };
    expect(describeCompositionKind(composition)).toBe("task_summary");
  });
});

// Keep the never-post proof declarations referenced so nothing here is dead code.
void [
  _taskSummaryLogs,
  _taskSummaryDiff,
  _taskSummaryReasoning,
  _taskSummaryStderr,
  _taskSummaryTerminalOutput,
  _clarifyingQuestionLogs,
  _clarifyingQuestionDiff,
  _clarifyingQuestionReasoning,
  _clarifyingQuestionStderr,
  _clarifyingQuestionTerminalOutput,
  _stageProgressLogs,
  _stageProgressDiff,
  _stageProgressReasoning,
  _stageProgressStderr,
  _stageProgressTerminalOutput,
  _attentionRequestLogs,
  _attentionRequestDiff,
  _attentionRequestReasoning,
  _attentionRequestStderr,
  _attentionRequestTerminalOutput,
  _publicationResultLogs,
  _publicationResultDiff,
  _publicationResultReasoning,
  _publicationResultStderr,
  _publicationResultTerminalOutput
];
