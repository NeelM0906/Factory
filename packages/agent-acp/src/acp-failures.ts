/**
 * ACP failure classification.
 *
 * Composes the kit's JSON-RPC table with ACP-specific cases: auth-required,
 * session/cancel acknowledgement, and the D-2 process-loss discriminator.
 */

import {
  classifyJsonRpcError,
  classifyFailure,
  type ClassifiedFailure,
  type JsonRpcError
} from "@autostack/agent-adapter-kit";

export type AcpFailureInput =
  | { readonly kind: "jsonrpc_error"; readonly error: JsonRpcError }
  | { readonly kind: "auth_required" }
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "process_lost";
      readonly hasEvidence: boolean;
      readonly exitCode: number | null;
      readonly signal: string | null;
    };

export interface AcpClassifiedFailure {
  readonly code: string;
  readonly retryable?: boolean;
}

/**
 * Classify an ACP failure into the adapter's failure taxonomy.
 */
export const classifyAcpFailure = (input: AcpFailureInput): AcpClassifiedFailure => {
  switch (input.kind) {
    case "jsonrpc_error":
      return classifyJsonRpcError(input.error);

    case "auth_required":
      return classifyFailure("provider_unauthenticated");

    case "cancelled":
      return { code: "cancelled" };

    case "process_lost":
      if (input.hasEvidence) {
        // D-2: terminated by signal or lost with no provider error frame, but has
        // prior evidence-bearing events → interrupted (no lifecycle terminal)
        return { code: "interrupted" };
      }
      // No prior evidence → failed terminal with harness code
      return classifyFailure("harness_child_exited");
  }
};
