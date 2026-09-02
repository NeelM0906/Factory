import type { WorkflowFailureCode } from "@autostack/contracts";

interface AgentRuntimeFailureEntry {
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * The complete agent-runtime failure table. Every key is a `WorkflowFailureCode` (lowercase
 * snake_case, verified by the package's tests against `WorkflowFailureCodeSchema`), so a failure
 * raised here can cross the workflow-failure boundary without renaming.
 */
export const AGENT_RUNTIME_FAILURES = Object.freeze({
  agent_session_already_terminal: {
    message: "The agent session stream has already delivered a lifecycle terminal.",
    retryable: false
  },
  agent_session_interrupted: {
    message: "The agent session stream was interrupted and accepts no further events.",
    retryable: false
  },
  agent_session_stream_overflow: {
    message: "The agent session stream buffer is full and refuses to drop evidence.",
    retryable: false
  },
  agent_session_disposed: {
    message: "The agent session relay has been disposed.",
    retryable: false
  },
  agent_event_invalid: {
    message: "The adapter emitted an event that does not parse as an agent session stream event.",
    retryable: false
  },
  agent_session_already_supervised: {
    message: "This agent session is already under supervision.",
    retryable: false
  },
  agent_harness_already_registered: {
    message: "An agent harness is already registered under this adapter id.",
    retryable: false
  },
  agent_harness_not_registered: {
    message: "No agent harness is registered under the requested adapter id.",
    retryable: false
  },
  agent_harness_capability_mismatch: {
    message: "The agent harness permission surface contradicts its declared capabilities.",
    retryable: false
  },
  agent_harness_probe_failed: {
    message: "The agent harness availability probe failed.",
    retryable: true
  }
} satisfies Readonly<Record<string, AgentRuntimeFailureEntry>>);

export type AgentRuntimeFailureCode = keyof typeof AGENT_RUNTIME_FAILURES;

/**
 * Stable agent-runtime failure. The code and message come ONLY from the frozen table above, never
 * from the caller, so no provenance can be smuggled into the surfaced failure. The `cause` is
 * installed by `Error` as a non-enumerable own property: reachable by diagnostics that ask for it,
 * invisible to `JSON.stringify` and enumeration.
 */
export class AgentRuntimeError extends Error {
  readonly code: WorkflowFailureCode;
  readonly retryable: boolean;

  constructor(code: AgentRuntimeFailureCode, cause?: unknown) {
    const entry = AGENT_RUNTIME_FAILURES[code];
    super(entry.message, cause === undefined ? undefined : { cause });
    this.name = "AgentRuntimeError";
    this.code = code;
    this.retryable = entry.retryable;
    Object.freeze(this);
  }
}
