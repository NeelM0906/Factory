import { redactSensitiveText } from "@autostack/contracts";

export type GitHubFailureCode =
  | "rate_limited"
  | "provider_unavailable"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "invalid_response";

export interface GitHubFailureClassification {
  readonly code: GitHubFailureCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

/**
 * Pure classifier for spec §8.3: authorization, invalid-input, and policy failures never
 * auto-retry. `now` is injected so callers control the clock; nothing here reads `Date.now()`.
 */
export const classifyGitHubFailure = (
  status: number,
  headers: Headers,
  now: () => number
): GitHubFailureClassification => {
  const rateLimitExhausted = headers.get("x-ratelimit-remaining") === "0";
  if (status === 429 || (status === 403 && rateLimitExhausted)) {
    const retryAfterMs = resolveRetryAfterMs(headers, now);
    return retryAfterMs === undefined
      ? { code: "rate_limited", retryable: true }
      : { code: "rate_limited", retryable: true, retryAfterMs };
  }
  if (status === 403) return { code: "forbidden", retryable: false };
  if (status >= 500 && status <= 599) return { code: "provider_unavailable", retryable: true };
  if (status === 401) return { code: "unauthenticated", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 422) return { code: "invalid_request", retryable: false };
  // Fail closed on anything unlisted, per spec §8.3: an unrecognized failure never auto-retries.
  return { code: "invalid_request", retryable: false };
};

const resolveRetryAfterMs = (headers: Headers, now: () => number): number | undefined => {
  const delaysMs: number[] = [];

  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      delaysMs.push(retryAfterSeconds * 1000);
    }
  }

  const rateLimitReset = headers.get("x-ratelimit-reset");
  if (rateLimitReset !== null) {
    const rateLimitResetSeconds = Number(rateLimitReset);
    if (Number.isFinite(rateLimitResetSeconds)) {
      delaysMs.push(rateLimitResetSeconds * 1000 - now());
    }
  }

  if (delaysMs.length === 0) return undefined;
  return Math.max(0, Math.round(Math.max(...delaysMs)));
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

export interface GitHubRequestErrorOptions {
  readonly cause?: unknown;
  readonly sensitiveValues?: readonly string[];
}

/** A failed GitHub API call, classified by {@link classifyGitHubFailure}. */
export class GitHubRequestError extends Error {
  readonly status: number;
  readonly code: GitHubFailureCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    code: GitHubFailureCode,
    retryable: boolean,
    options: GitHubRequestErrorOptions = {}
  ) {
    super(redactSensitiveText(message, options.sensitiveValues ?? []));
    this.name = "GitHubRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    attachNonEnumerableCause(this, options.cause);
    Object.freeze(this);
  }
}

export interface GitHubBranchPolicyErrorOptions {
  readonly cause?: unknown;
  readonly sensitiveValues?: readonly string[];
}

/** Thrown when an operation targets a ref outside the `autostack/` branch policy. */
export class GitHubBranchPolicyError extends Error {
  readonly ref: string;
  readonly retryable = false;

  constructor(ref: string, options: GitHubBranchPolicyErrorOptions = {}) {
    const sensitiveValues = options.sensitiveValues ?? [];
    super(
      redactSensitiveText(
        `Ref "${ref}" is not permitted: AutoStack only operates on "autostack/"-prefixed branches.`,
        sensitiveValues
      )
    );
    this.name = "GitHubBranchPolicyError";
    this.ref = redactSensitiveText(ref, sensitiveValues);
    attachNonEnumerableCause(this, options.cause);
    Object.freeze(this);
  }
}
