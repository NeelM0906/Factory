import { ModelRoutingError, type ModelRoutingFailureCode } from "@autostack/contracts";

import { NATIVE_AGENT_FAILURES, type NativeAgentFailure } from "./errors.js";

/** One classification row: the workflow-facing code plus a prose message distinct from it. */
export interface ModelRoutingClassificationEntry {
  readonly code: string;
  readonly message: string;
}

/**
 * The frozen classification table, exhaustive over `MODEL_ROUTING_FAILURE_CODES` — the
 * `Record<ModelRoutingFailureCode, ...>` type makes a taxonomy code added upstream a compile
 * error here rather than a fall-through to a default, and the package's tests assert the same
 * exhaustiveness at runtime. The taxonomy codes are carried through UNCHANGED (`entry.code`
 * equals its key): the retry policy downstream branches on the same vocabulary the router
 * raised, with no renaming and no trimming of candidate codes anywhere on the path.
 */
export const MODEL_ROUTING_FAILURE_CLASSIFICATIONS: Readonly<
  Record<ModelRoutingFailureCode, ModelRoutingClassificationEntry>
> = Object.freeze({
  capability_unavailable: Object.freeze({
    code: "capability_unavailable",
    message: "No configured model route provides the capability the invocation requires."
  }),
  route_disabled: Object.freeze({
    code: "route_disabled",
    message: "The requested model route is administratively disabled."
  }),
  provider_error: Object.freeze({
    code: "provider_error",
    message: "The upstream model provider failed to serve the routed request."
  }),
  rate_limited: Object.freeze({
    code: "rate_limited",
    message: "The upstream model provider rate limited the routed request."
  }),
  budget_exceeded: Object.freeze({
    code: "budget_exceeded",
    message: "The invocation would exceed the configured model spend budget."
  })
});

/**
 * Builds the classified failure with the original throwable attached as a NON-ENUMERABLE own
 * `cause`: reachable by diagnostics, invisible to enumeration and `JSON.stringify`, so nothing
 * from the (untrusted) throwable can leak into serialized failure surfaces.
 */
const classified = (
  code: string,
  message: string,
  retryable: boolean,
  cause: unknown
): NativeAgentFailure => {
  const failure: NativeAgentFailure = { code, message, retryable };
  Object.defineProperty(failure, "cause", {
    value: cause,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return Object.freeze(failure);
};

/**
 * Classifies any throwable into a `NativeAgentFailure`.
 *
 * A genuine `ModelRoutingError` (instanceof — duck-typed forgeries do not qualify) maps through
 * the frozen table: the code is carried through unchanged, the message comes from the table,
 * and `retryable` is PRESERVED from the error itself, never re-derived from a local
 * code-to-boolean table — for `provider_error` the taxonomy leaves retryable caller-supplied,
 * so only the error knows the answer.
 *
 * Everything else — including objects forged to look like routing errors, whose codes are never
 * trimmed or normalized into acceptance — classifies as `native_agent_internal_error` with the
 * table's message; the throwable's own text never reaches the surfaced failure.
 */
export const classifyThrowable = (throwable: unknown): NativeAgentFailure => {
  if (throwable instanceof ModelRoutingError) {
    const entry = MODEL_ROUTING_FAILURE_CLASSIFICATIONS[throwable.code];
    return classified(entry.code, entry.message, throwable.retryable, throwable);
  }
  const entry = NATIVE_AGENT_FAILURES.native_agent_internal_error;
  return classified("native_agent_internal_error", entry.message, entry.retryable, throwable);
};
