/**
 * Claude Code failure classifier.
 *
 * Classifies only from enumerated, structured provider fields (`result.subtype`,
 * `result.is_error`, process exit status). Never from provider prose — provider
 * output is untrusted input (spec §14.1) and retryability is a policy branch.
 *
 * D-2: Interruption versus failure discriminator:
 * - Signal death (or lost with no provider error) after evidence → interrupted
 * - Signal death before evidence → failed with harness_child_exited
 * - Provider error shape → failed with per-subtype code
 */

export interface ClaudeFailureResultError {
  readonly kind: "result_error";
  readonly subtype: string;
  readonly isError: boolean;
}

export interface ClaudeFailureProcessLost {
  readonly kind: "process_lost";
  readonly hasEvidence: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface ClaudeFailureMalformed {
  readonly kind: "malformed_output";
}

export type ClaudeFailureInput =
  | ClaudeFailureResultError
  | ClaudeFailureProcessLost
  | ClaudeFailureMalformed;

export interface ClassifiedClaudeFailure {
  readonly code: string;
  readonly retryable?: boolean;
}

/**
 * Classification table for result.subtype values:
 *
 * | subtype                     | code                       | retryable |
 * | --------------------------- | -------------------------- | --------- |
 * | error_max_turns             | provider_turn_limit        | false     |
 * | error_during_execution      | provider_execution_error   | true      |
 * | (unknown with is_error)     | provider_error             | false     |
 */
const RESULT_SUBTYPE_MAP: Readonly<Record<string, ClassifiedClaudeFailure>> = {
  error_max_turns: { code: "provider_turn_limit", retryable: false },
  error_during_execution: { code: "provider_execution_error", retryable: true }
};

export const classifyClaudeFailure = (input: ClaudeFailureInput): ClassifiedClaudeFailure => {
  switch (input.kind) {
    case "result_error": {
      const mapped = RESULT_SUBTYPE_MAP[input.subtype];
      if (mapped != null) return mapped;
      return { code: "provider_error", retryable: false };
    }

    case "process_lost": {
      if (input.hasEvidence) {
        return { code: "interrupted" };
      }
      return { code: "harness_child_exited", retryable: true };
    }

    case "malformed_output":
      return { code: "provider_output_malformed", retryable: false };
  }
};
