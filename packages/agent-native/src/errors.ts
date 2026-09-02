/**
 * The stable failure vocabulary of the native agent adapter. Every code here survives
 * `normalizeWorkflowFailureCode` unchanged (lowercase snake_case), so a failure raised in this
 * package can cross the workflow-failure boundary without renaming — the package's tests pin
 * that round-trip against the shared rule in `@autostack/contracts`.
 */

/**
 * A classified native failure as a value. `schemaPaths` appears on structured-output rejections
 * (joined Zod issue paths, never offending values); `cause`, when present, is installed as a
 * NON-ENUMERABLE own property so diagnostics can reach the original throwable while enumeration
 * and `JSON.stringify` never leak it.
 */
export interface NativeAgentFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly schemaPaths?: readonly string[];
  readonly cause?: unknown;
}

interface NativeAgentFailureEntry {
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * The complete native failure table. Messages are prose, distinct from their codes, and drawn
 * ONLY from here — no caller-supplied (or model-supplied) text can be smuggled into a surfaced
 * failure. Everything fails closed: none of these invite an automatic retry.
 */
export const NATIVE_AGENT_FAILURES = Object.freeze({
  malformed_model_output: Object.freeze({
    message: "The model response could not be admitted as structured output.",
    retryable: false
  }),
  model_output_unsafe: Object.freeze({
    message: "The model output carried credential-shaped material and was refused.",
    retryable: false
  }),
  native_agent_internal_error: Object.freeze({
    message: "The native agent harness failed internally while executing the invocation.",
    retryable: false
  }),
  native_context_unavailable: Object.freeze({
    message: "A context source the invocation requires could not be read.",
    retryable: false
  }),
  native_permission_denied: Object.freeze({
    message: "The workspace permission policy refused the requested operation.",
    retryable: false
  }),
  native_invocation_incomplete: Object.freeze({
    message: "The invocation request is missing required identity and cannot proceed.",
    retryable: false
  })
} satisfies Readonly<Record<string, NativeAgentFailureEntry>>);

export type NativeAgentFailureCode = keyof typeof NATIVE_AGENT_FAILURES;

/**
 * Stable native-agent failure as a throwable, mirroring agent-runtime's `AgentRuntimeError`
 * discipline: code, message, and retryable come ONLY from the frozen table above, and the
 * optional `cause` is installed by `Error` as a non-enumerable own property — reachable by
 * diagnostics that ask for it, invisible to `JSON.stringify` and enumeration.
 */
export class NativeAgentError extends Error {
  readonly code: NativeAgentFailureCode;
  readonly retryable: boolean;

  constructor(code: NativeAgentFailureCode, cause?: unknown) {
    const entry = NATIVE_AGENT_FAILURES[code];
    super(entry.message, cause === undefined ? undefined : { cause });
    this.name = "NativeAgentError";
    this.code = code;
    this.retryable = entry.retryable;
    Object.freeze(this);
  }
}
