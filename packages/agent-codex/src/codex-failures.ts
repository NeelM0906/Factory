/**
 * Codex failure classifier.
 *
 * Reuses the kit's JSON-RPC error code table for app-server errors.
 * Additional classifications:
 * - ErrorNotification → provider_execution_error (retryable: true)
 * - D-2: signal death (or lost with no provider error) after evidence → interrupted
 * - D-2: signal death before evidence → harness_child_exited
 * - Malformed output → provider_output_malformed
 */

import {
  classifyJsonRpcError,
  classifyFailure
} from "@autostack/agent-adapter-kit";

/**
 * Local result type that admits "interrupted" alongside TaxonomyCode.
 * Mirrors the Claude adapter's `ClassifiedClaudeFailure` approach —
 * "interrupted" is not a taxonomy code (it's a distinct event type),
 * so the harness checks `.code === "interrupted"` before building a
 * failed event.
 */
export interface ClassifiedCodexFailure {
  readonly code: string;
  readonly retryable?: boolean;
  readonly message?: string;
}

export interface CodexFailureJsonRpcError {
  readonly kind: "jsonrpc_error";
  readonly code: number;
  readonly message: string;
}

export interface CodexFailureErrorNotification {
  readonly kind: "error_notification";
  readonly message: string;
}

export interface CodexFailureProcessLost {
  readonly kind: "process_lost";
  readonly hasEvidence: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface CodexFailureMalformed {
  readonly kind: "malformed_output";
}

export type CodexFailureInput =
  | CodexFailureJsonRpcError
  | CodexFailureErrorNotification
  | CodexFailureProcessLost
  | CodexFailureMalformed;

export const classifyCodexFailure = (input: CodexFailureInput): ClassifiedCodexFailure => {
  switch (input.kind) {
    case "jsonrpc_error":
      return classifyJsonRpcError({ code: input.code, message: input.message });

    case "error_notification":
      return classifyFailure("provider_execution_error");

    case "process_lost": {
      if (input.hasEvidence) {
        return { code: "interrupted" };
      }
      return classifyFailure("harness_child_exited");
    }

    case "malformed_output":
      return classifyFailure("provider_output_malformed");
  }
};
