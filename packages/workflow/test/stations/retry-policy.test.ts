import { describe, expect, it } from "vitest";

import type { WorkflowFailure } from "@autostack/contracts";
import { JobIdSchema, RunIdSchema, RunStageSchema, WorkspaceIdSchema } from "@autostack/contracts";
import type { LeasedWorkflowJob } from "@autostack/domain";

import { RetryableJobError } from "../../src/errors.js";
import {
  createStageRetryAt,
  shouldRetry,
  type RetryableJobErrorWithDelay
} from "../../src/stations/retry-policy.js";

const NOW = "2026-08-27T00:00:00.000Z";

const leasedJob = (attempt: number, maxAttempts = 5): LeasedWorkflowJob => ({
  jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174000"),
  workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000"),
  runId: RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000"),
  stage: RunStageSchema.parse("triage"),
  handler: "test.handler",
  payload: {},
  maxAttempts,
  availableAt: NOW,
  createdAt: NOW,
  attempt,
  leaseOwner: "worker-1",
  leaseToken: "lease-1",
  leaseExpiresAt: NOW
});

const withServerDelay = (message: string, retryAfterMs: number): RetryableJobErrorWithDelay =>
  Object.assign(new RetryableJobError(message), { retryAfterMs });

describe("createStageRetryAt", () => {
  it("computes base-1s backoff scaled by full jitter from the injected random", () => {
    const retryAt = createStageRetryAt({ random: () => 0.25 });
    // attempt 1 -> backoff min(60000, 1000*2^0)=1000ms -> jitter 0.25*1000=250ms
    const result = retryAt(new RetryableJobError("boom"), leasedJob(1), NOW);
    expect(result).toBe("2026-08-27T00:00:00.250Z");
  });

  it("doubles the backoff per attempt before jitter", () => {
    const retryAt = createStageRetryAt({ random: () => 0.5 });
    // attempt 3 -> backoff min(60000, 1000*2^2)=4000ms -> jitter 0.5*4000=2000ms
    const result = retryAt(new RetryableJobError("boom"), leasedJob(3), NOW);
    expect(result).toBe("2026-08-27T00:00:02.000Z");
  });

  it("caps the exponential backoff at 60 seconds", () => {
    const retryAt = createStageRetryAt({ random: () => 1 });
    // attempt 10 -> raw backoff 512000ms capped to 60000ms -> jitter 1*60000=60000ms
    const result = retryAt(new RetryableJobError("boom"), leasedJob(10), NOW);
    expect(result).toBe("2026-08-27T00:01:00.000Z");
  });

  it("floors the delay at 1ms so the result is strictly after now even when random() is 0", () => {
    const retryAt = createStageRetryAt({ random: () => 0 });
    const result = retryAt(new RetryableJobError("boom"), leasedJob(1), NOW);
    expect(result).toBe("2026-08-27T00:00:00.001Z");
    expect(Date.parse(result)).toBeGreaterThan(Date.parse(NOW));
  });

  it("uses max(serverDelay, backoff) when a RetryableJobError carries retryAfterMs", () => {
    const retryAt = createStageRetryAt({ random: () => 0.5 });
    // attempt 1 -> jittered backoff 500ms; server delay 120000ms wins
    const error = withServerDelay("server says wait", 120_000);
    const result = retryAt(error, leasedJob(1), NOW);
    expect(result).toBe("2026-08-27T00:02:00.000Z");
  });

  it("prefers the jittered backoff over a smaller server delay", () => {
    const retryAt = createStageRetryAt({ random: () => 0.5 });
    // attempt 6 -> backoff min(60000,1000*2^5)=32000ms -> jitter 0.5*32000=16000ms beats 10ms
    const error = withServerDelay("server says wait", 10);
    const result = retryAt(error, leasedJob(6), NOW);
    expect(result).toBe("2026-08-27T00:00:16.000Z");
  });

  it("caps the server-provided delay at 300 seconds", () => {
    const retryAt = createStageRetryAt({ random: () => 0.5 });
    const error = withServerDelay("server says wait", 400_000);
    const result = retryAt(error, leasedJob(1), NOW);
    expect(result).toBe("2026-08-27T00:05:00.000Z");
  });

  it("returns a normalized ISO-8601 string", () => {
    const retryAt = createStageRetryAt({ random: () => 0.5 });
    const result = retryAt(new RetryableJobError("boom"), leasedJob(1), NOW);
    expect(new Date(result).toISOString()).toBe(result);
  });

  // `LocalWorkflowExecutor` captures one timestamp per cycle and passes it as the third argument.
  // Scheduling from a factory-level clock instead would agree with a fake clock in tests and drift
  // by the width of the cycle in production, so the base instant must come from the caller.
  it("schedules from the timestamp it is given, not from a captured clock", () => {
    const retryAt = createStageRetryAt({ random: () => 0.5 });
    const later = "2026-08-27T01:00:00.000Z";
    const fromNow = retryAt(new RetryableJobError("boom"), leasedJob(1), NOW);
    const fromLater = retryAt(new RetryableJobError("boom"), leasedJob(1), later);
    expect(Date.parse(fromLater) - Date.parse(fromNow)).toBe(Date.parse(later) - Date.parse(NOW));
  });

  it("rejects an unparseable timestamp instead of scheduling from NaN", () => {
    const retryAt = createStageRetryAt({ random: () => 0.5 });
    expect(() => retryAt(new RetryableJobError("boom"), leasedJob(1), "not-a-timestamp")).toThrow(
      TypeError
    );
  });
});

describe("shouldRetry", () => {
  const failure = (retryable: boolean): WorkflowFailure => ({
    code: "agent_error",
    name: "Test",
    message: "boom",
    retryable
  });

  it("never retries a deterministic failure, regardless of attempts remaining", () => {
    expect(shouldRetry(failure(false), 1, 100)).toBe(false);
  });

  it("does not retry once attempts are exhausted", () => {
    expect(shouldRetry(failure(true), 5, 5)).toBe(false);
  });

  it("does not retry past the attempt ceiling", () => {
    expect(shouldRetry(failure(true), 6, 5)).toBe(false);
  });

  it("retries a retryable failure with attempts remaining", () => {
    expect(shouldRetry(failure(true), 1, 5)).toBe(true);
  });
});
