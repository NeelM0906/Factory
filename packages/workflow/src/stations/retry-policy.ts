import type { WorkflowFailure } from "@autostack/contracts";
import type { LeasedWorkflowJob } from "@autostack/domain";

import { RetryableJobError } from "../errors.js";

const BASE_DELAY_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const SERVER_DELAY_CAP_MS = 300_000;
const MIN_DELAY_MS = 1;

/**
 * A `RetryableJobError` whose thrower attached a server-provided retry delay (spec §8.3), e.g. a
 * provider's `Retry-After` header. `RetryableJobError` itself carries no such field -- this
 * package does not modify `../errors.js` -- so the delay is read structurally.
 */
export interface RetryableJobErrorWithDelay extends RetryableJobError {
  readonly retryAfterMs: number;
}

const hasServerDelay = (error: RetryableJobError): error is RetryableJobErrorWithDelay => {
  const candidate = error as Partial<RetryableJobErrorWithDelay>;
  return (
    typeof candidate.retryAfterMs === "number" &&
    Number.isFinite(candidate.retryAfterMs) &&
    candidate.retryAfterMs >= 0
  );
};

/** Exponential backoff, base 1s, doubling per attempt, capped at 60s. */
const exponentialBackoffMs = (attempt: number): number =>
  Math.min(BACKOFF_CAP_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));

export interface CreateStageRetryAtOptions {
  readonly random: () => number;
}

export type StageRetryAt = (
  error: RetryableJobError,
  job: LeasedWorkflowJob,
  now: string
) => string;

/**
 * Builds `retryAt(error, job, now)`: a full-jitter exponential backoff schedule, base 1s doubling
 * per attempt and capped at 60s, drawing jitter from the injected `random` so schedules are
 * deterministic under test. A `RetryableJobError` carrying a server-provided `retryAfterMs` uses
 * `max(serverDelay, jitteredBackoff)`, capped at 300s. The result is always strictly after `now`.
 *
 * `now` is a parameter, not an injected clock, and that is deliberate. `LocalWorkflowExecutor`
 * captures one timestamp per cycle and passes it as the third argument
 * (`options.retryAt(error, leased, now())`). A factory-level clock would be a second source of
 * truth for the same instant: under a fake clock the two agree and tests pass, while under a real
 * clock they drift by the width of the cycle. Reading the executor's own timestamp keeps the
 * scheduled retry coherent with the cycle that scheduled it.
 */
export const createStageRetryAt = (options: CreateStageRetryAtOptions): StageRetryAt => {
  return (error, job, now) => {
    const cappedBackoffMs = exponentialBackoffMs(job.attempt);
    const jitteredBackoffMs = options.random() * cappedBackoffMs;
    const delayMs = hasServerDelay(error)
      ? Math.min(SERVER_DELAY_CAP_MS, Math.max(error.retryAfterMs, jitteredBackoffMs))
      : jitteredBackoffMs;
    const boundedDelayMs = Math.max(MIN_DELAY_MS, Math.round(delayMs));
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new TypeError("A retry schedule requires a valid timestamp.");
    return new Date(nowMs + boundedDelayMs).toISOString();
  };
};

/**
 * A deterministic failure (`retryable === false`) never auto-retries, regardless of attempts
 * remaining (spec §8.3). Otherwise, retry only while attempts remain.
 */
export const shouldRetry = (
  failure: WorkflowFailure,
  attempt: number,
  maxAttempts: number
): boolean => {
  if (!failure.retryable) return false;
  if (attempt >= maxAttempts) return false;
  return true;
};
