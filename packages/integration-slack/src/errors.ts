import { redactSensitiveText } from "@autostack/contracts";

export type SlackFailureCode =
  | "unauthenticated"
  | "rate_limited"
  | "invalid_request"
  | "provider_unavailable"
  | "not_postable"
  | "signature_invalid"
  | "replayed";

export interface SlackFailureClassification {
  readonly code: SlackFailureCode;
  readonly retryable: boolean;
}

export interface SlackFailureClassificationInput {
  readonly status: number;
  readonly body?: { readonly ok: boolean; readonly error?: string };
}

const UNAUTHENTICATED_SLACK_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked"]);

/**
 * Pure classifier for Slack failures. Slack returns HTTP 200 with a body of
 * `{ ok: false, error: "..." }` for most API failures, so HTTP status alone is
 * never sufficient: the body envelope is checked first, and status is used
 * only when no `{ ok: false }` envelope is present.
 */
export const classifySlackFailure = (
  input: SlackFailureClassificationInput
): SlackFailureClassification => {
  const { status, body } = input;
  if (body?.ok === false) {
    if (body.error === "ratelimited") return { code: "rate_limited", retryable: true };
    if (body.error !== undefined && UNAUTHENTICATED_SLACK_ERRORS.has(body.error)) {
      return { code: "unauthenticated", retryable: false };
    }
    return { code: "invalid_request", retryable: false };
  }
  if (status >= 500 && status <= 599) return { code: "provider_unavailable", retryable: true };
  if (status === 429) return { code: "rate_limited", retryable: true };
  // Fail closed on anything unlisted: an unrecognized failure never auto-retries.
  return { code: "invalid_request", retryable: false };
};

const attachNonEnumerableCause = (error: Error, cause: unknown): void => {
  if (cause === undefined) return;
  Object.defineProperty(error, "cause", {
    value: cause,
    enumerable: false,
    writable: false,
    configurable: true
  });
};

export interface SlackRequestErrorOptions {
  readonly cause?: unknown;
  readonly sensitiveValues?: readonly string[];
}

/** A failed Slack API call or rejected inbound request, classified by {@link classifySlackFailure}. */
export class SlackRequestError extends Error {
  readonly code: SlackFailureCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: SlackFailureCode,
    retryable: boolean,
    options: SlackRequestErrorOptions = {}
  ) {
    super(redactSensitiveText(message, options.sensitiveValues ?? []));
    this.name = "SlackRequestError";
    this.code = code;
    this.retryable = retryable;
    attachNonEnumerableCause(this, options.cause);
    Object.freeze(this);
  }
}
