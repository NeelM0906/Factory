import { ZodError } from "zod";

import {
  ModelRoutingError,
  WorkflowFailureSchema,
  normalizeWorkflowFailureCode,
  redactSensitiveText,
  type WorkflowFailure
} from "@autostack/contracts";
import {
  ApprovalDecisionConflictError,
  IneligibleApproverError,
  InvalidRunTransitionError,
  LeaseConflictError,
  OptimisticConcurrencyError,
  StaleApprovalEvidenceError
} from "@autostack/domain";

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_NAME_LENGTH = 160;

/**
 * Host and transport failures are deliberately absent from this taxonomy. `packages/workflow`
 * depends only on `@autostack/contracts`, `@autostack/domain`, and `zod` -- it cannot import
 * `InvalidHostResponseError` from `apps/control-plane` without violating the no-cross-
 * implementation-imports rule. A host/transport failure instead reaches this function already
 * wrapped as a `ModelRoutingError` (typically with code `provider_error`), because the model
 * router adapter maps host/transport failures to a routing failure code before a station ever
 * observes them. Classification therefore happens structurally, through the `ModelRoutingError`
 * branch below, not through an `instanceof` check on an app-level class.
 */

/** The shape of an agent harness's normalized `"failed"` lifecycle event (spec §9.1). */
interface AgentSessionFailureLike {
  readonly type: "failed";
  readonly code: string;
  readonly retryable: boolean;
  readonly message?: string;
}

const isAgentSessionFailure = (error: unknown): error is AgentSessionFailureLike => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<AgentSessionFailureLike>;
  return (
    candidate.type === "failed" &&
    typeof candidate.code === "string" &&
    typeof candidate.retryable === "boolean"
  );
};

/** Redacts, defaults, and bounds arbitrary text before it is allowed into a `WorkflowFailure`. */
const safeText = (candidate: string | undefined, fallback: string, maxLength: number): string => {
  const redacted = redactSensitiveText(candidate ?? "").trim();
  return (redacted.length > 0 ? redacted : fallback).slice(0, maxLength);
};

const messageOf = (error: unknown, fallback: string): string =>
  safeText(error instanceof Error ? error.message : undefined, fallback, MAX_MESSAGE_LENGTH);

const nameOf = (error: unknown, fallback: string): string =>
  safeText(error instanceof Error ? error.name : undefined, fallback, MAX_NAME_LENGTH);

const build = (input: {
  code: string;
  name: string;
  message: string;
  retryable: boolean;
}): WorkflowFailure => WorkflowFailureSchema.parse(input);

/**
 * Classifies a thrown or reported stage failure into the workflow failure taxonomy (spec §8.3).
 * A flat sequence of checks ending in an unknown fallback -- no registry, no dispatch table.
 */
export const classifyStageFailure = (error: unknown): WorkflowFailure => {
  if (error instanceof ModelRoutingError) {
    return build({
      code: error.code,
      name: nameOf(error, "ModelRoutingError"),
      message: messageOf(error, "The model router reported a failure."),
      retryable: error.retryable
    });
  }

  if (isAgentSessionFailure(error)) {
    const message = safeText(
      error.message,
      "The agent session reported a failure.",
      MAX_MESSAGE_LENGTH
    );
    // Unchanged-acceptance is the shared contracts rule (`normalizeWorkflowFailureCode`); the
    // fallback below — `agent_error` and forcing `retryable: false` — is this consumer's own
    // decision, which is why the tests covering it live here and not in contracts.
    const normalized = normalizeWorkflowFailureCode(error.code);
    if (normalized === undefined) {
      return build({ code: "agent_error", name: "AgentSessionFailure", message, retryable: false });
    }
    return build({
      code: normalized,
      name: "AgentSessionFailure",
      message,
      retryable: error.retryable
    });
  }

  if (error instanceof LeaseConflictError) {
    return build({
      code: "lease_conflict",
      name: nameOf(error, "LeaseConflictError"),
      message: messageOf(error, "A workflow job lease conflict occurred."),
      retryable: true
    });
  }

  if (error instanceof OptimisticConcurrencyError) {
    return build({
      code: "version_conflict",
      name: nameOf(error, "OptimisticConcurrencyError"),
      message: messageOf(error, "A stream version conflict occurred."),
      retryable: true
    });
  }

  if (error instanceof StaleApprovalEvidenceError) {
    return build({
      code: "stale_approval_evidence",
      name: nameOf(error, "StaleApprovalEvidenceError"),
      message: messageOf(error, "The approval evidence is stale."),
      retryable: false
    });
  }

  if (error instanceof IneligibleApproverError) {
    return build({
      code: "ineligible_approver",
      name: nameOf(error, "IneligibleApproverError"),
      message: messageOf(error, "The approver is not eligible to decide this approval."),
      retryable: false
    });
  }

  if (error instanceof ApprovalDecisionConflictError) {
    return build({
      code: "approval_decision_conflict",
      name: nameOf(error, "ApprovalDecisionConflictError"),
      message: messageOf(error, "The approval already has a different decision."),
      retryable: false
    });
  }

  if (error instanceof InvalidRunTransitionError) {
    return build({
      code: "invalid_run_transition",
      name: nameOf(error, "InvalidRunTransitionError"),
      message: messageOf(error, "The run transition is invalid."),
      retryable: false
    });
  }

  if (error instanceof ZodError) {
    return build({
      code: "invalid_input",
      name: nameOf(error, "ZodError"),
      message: messageOf(error, "The input failed schema validation."),
      retryable: false
    });
  }

  return build({
    code: "unknown_error",
    name: "UnknownError",
    message: "An unrecognized failure occurred.",
    retryable: false
  });
};
