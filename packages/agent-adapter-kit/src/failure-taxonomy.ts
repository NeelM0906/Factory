/**
 * Shared failure taxonomy for all agent adapters.
 *
 * Every code maps to exactly one `retryable` value, so classification never has to decide
 * twice. Spellings align with `MODEL_ROUTING_FAILURE_CODES` from `@autostack/contracts`
 * wherever the meaning coincides (finding 5).
 *
 * Every code is admitted unchanged by `normalizeWorkflowFailureCode` (D-13). No local regex
 * or bare `safeParse().success` is used — either would ship trim-then-accept.
 */

export type TaxonomyCode =
  | "rate_limited"
  | "capability_unavailable"
  | "provider_unavailable"
  | "provider_internal_error"
  | "provider_execution_error"
  | "provider_timeout"
  | "provider_error"
  | "provider_protocol_invalid"
  | "provider_request_rejected"
  | "provider_output_malformed"
  | "provider_turn_limit"
  | "provider_unauthenticated"
  | "harness_not_installed"
  | "harness_launch_denied"
  | "harness_launch_failed"
  | "harness_child_exited";

interface TaxonomyEntry {
  readonly retryable: boolean;
  readonly message: string;
}

export const FAILURE_TAXONOMY: Readonly<Record<TaxonomyCode, TaxonomyEntry>> = Object.freeze({
  rate_limited: {
    retryable: true,
    message: "The provider throttled the request."
  },
  capability_unavailable: {
    retryable: false,
    message: "The provider does not offer the requested operation."
  },
  provider_unavailable: {
    retryable: true,
    message: "The provider experienced a transient outage."
  },
  provider_internal_error: {
    retryable: true,
    message: "The provider reported an internal fault."
  },
  provider_execution_error: {
    retryable: true,
    message: "The agent run failed mid-execution."
  },
  provider_timeout: {
    retryable: true,
    message: "A runtime or progress bound was exceeded."
  },
  provider_error: {
    retryable: false,
    message: "An unclassified provider failure occurred."
  },
  provider_protocol_invalid: {
    retryable: false,
    message: "The provider violated its own protocol."
  },
  provider_request_rejected: {
    retryable: false,
    message: "The provider rejected the request as invalid."
  },
  provider_output_malformed: {
    retryable: false,
    message: "A provider frame could not be parsed or mapped."
  },
  provider_turn_limit: {
    retryable: false,
    message: "The provider stopped at a configured turn ceiling."
  },
  provider_unauthenticated: {
    retryable: false,
    message: "The provider has no usable credential."
  },
  harness_not_installed: {
    retryable: false,
    message: "The executable does not exist."
  },
  harness_launch_denied: {
    retryable: false,
    message: "The executable exists but cannot be executed."
  },
  harness_launch_failed: {
    retryable: true,
    message: "A transient spawn failure occurred."
  },
  harness_child_exited: {
    retryable: true,
    message: "The child exited carrying a provider error shape."
  }
});

export interface ClassifiedFailure {
  readonly code: TaxonomyCode;
  readonly retryable: boolean;
  readonly message: string;
}

/** Look up a code in the taxonomy and return its classification. */
export const classifyFailure = (code: TaxonomyCode): ClassifiedFailure => {
  const entry = FAILURE_TAXONOMY[code];
  return { code, retryable: entry.retryable, message: entry.message };
};
