import { redactSensitiveText, type WorkflowFailure } from "@autostack/contracts";
import type { DurableStore, LeasedWorkflowJob } from "@autostack/domain";

import { RetryableJobError } from "./errors.js";
import { HandlerRegistry } from "./handler-registry.js";

export type ExecutorStatus = "stopped" | "idle" | "working";
export type RunCycleResult = "idle" | "completed" | "retried" | "failed" | "interrupted";

export type SanitizedWorkflowError = WorkflowFailure;

export interface LocalWorkflowExecutorOptions {
  readonly store: DurableStore;
  readonly registry: HandlerRegistry;
  readonly workerId: string;
  readonly now: () => string;
  readonly leaseDurationMs: number;
  readonly pollIntervalMs: number;
  readonly retryAt: (error: RetryableJobError, job: LeasedWorkflowJob, now: string) => string;
  readonly sensitiveValues?: readonly string[];
  readonly reportError?: (
    error: SanitizedWorkflowError,
    job?: LeasedWorkflowJob
  ) => void | Promise<void>;
}

export interface StopExecutorOptions {
  readonly abortCurrent?: boolean;
}

const sanitizeError = (
  error: unknown,
  sensitiveValues: readonly string[]
): SanitizedWorkflowError => {
  const retryable = error instanceof RetryableJobError;
  if (error instanceof Error) {
    return {
      code: "workflow_handler_failed",
      name: redactSensitiveText(error.name || "Error", sensitiveValues).slice(0, 160),
      message: redactSensitiveText(
        error.message || "Workflow handler failed.",
        sensitiveValues
      ).slice(0, 2_000),
      retryable
    };
  }
  return {
    code: "workflow_handler_invalid_error",
    name: "UnknownWorkflowError",
    message: "Workflow handler failed with a non-error value.",
    retryable: false
  };
};

export class LocalWorkflowExecutor {
  readonly #options: LocalWorkflowExecutorOptions;
  #status: ExecutorStatus = "stopped";
  #running = false;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #currentAbort: AbortController | undefined;
  #currentCycle: Promise<RunCycleResult> | undefined;

  constructor(options: LocalWorkflowExecutorOptions) {
    if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
      throw new TypeError("leaseDurationMs must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
      throw new TypeError("pollIntervalMs must be a positive safe integer.");
    }
    this.#options = options;
  }

  getStatus(): ExecutorStatus {
    return this.#status;
  }

  runOnce(): Promise<RunCycleResult> {
    if (this.#currentCycle !== undefined) return this.#currentCycle;

    const cycle = this.#executeCycle();
    const tracked = cycle.finally(() => {
      if (this.#currentCycle === tracked) this.#currentCycle = undefined;
    });
    this.#currentCycle = tracked;
    return tracked;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#status = "idle";
    this.#schedulePoll(0);
  }

  async stop(options: StopExecutorOptions = {}): Promise<void> {
    this.#running = false;
    if (this.#pollTimer !== undefined) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (options.abortCurrent ?? true) this.#currentAbort?.abort();
    if (this.#currentCycle !== undefined) await this.#currentCycle;
    this.#status = "stopped";
  }

  async #executeCycle(): Promise<RunCycleResult> {
    this.#status = "working";
    let leased: LeasedWorkflowJob | null = null;
    try {
      leased = await this.#options.store.leaseNext({
        workerId: this.#options.workerId,
        now: this.#options.now(),
        leaseDurationMs: this.#options.leaseDurationMs
      });
      if (leased === null) return "idle";

      const abort = new AbortController();
      this.#currentAbort = abort;
      this.#scheduleHeartbeat(leased, abort);

      try {
        const result = await this.#options.registry.execute(leased.handler, leased.payload, {
          job: leased,
          signal: abort.signal
        });
        await this.#options.store.completeJob({
          jobId: leased.jobId,
          leaseToken: leased.leaseToken,
          now: this.#options.now(),
          idempotency: {
            scope: "executor:complete",
            key: `${leased.jobId}:${leased.attempt}`
          },
          appends: result.appends,
          jobs: result.jobs
        });
        return "completed";
      } catch (error) {
        if (abort.signal.aborted && !this.#running) return "interrupted";
        const sanitized = sanitizeError(error, this.#options.sensitiveValues ?? []);
        await this.#report(sanitized, leased);
        const retryable = error instanceof RetryableJobError;
        const now = this.#options.now();
        const nextAvailableAt = retryable ? this.#options.retryAt(error, leased, now) : undefined;
        await this.#options.store.failJob({
          jobId: leased.jobId,
          leaseToken: leased.leaseToken,
          now,
          error: sanitized,
          ...(nextAvailableAt === undefined ? {} : { nextAvailableAt })
        });
        return retryable && leased.attempt < leased.maxAttempts ? "retried" : "failed";
      } finally {
        this.#clearHeartbeat();
        if (this.#currentAbort === abort) this.#currentAbort = undefined;
      }
    } finally {
      this.#status = this.#running ? "idle" : "stopped";
    }
  }

  #scheduleHeartbeat(job: LeasedWorkflowJob, abort: AbortController): void {
    const interval = Math.max(1, Math.floor(this.#options.leaseDurationMs / 2));
    const heartbeat = async (): Promise<void> => {
      if (abort.signal.aborted) return;
      try {
        await this.#options.store.heartbeat({
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          now: this.#options.now(),
          leaseDurationMs: this.#options.leaseDurationMs
        });
      } catch (error) {
        await this.#report(sanitizeError(error, this.#options.sensitiveValues ?? []), job);
        abort.abort();
        return;
      }
      if (!abort.signal.aborted) {
        this.#heartbeatTimer = setTimeout(() => void heartbeat(), interval);
      }
    };
    this.#heartbeatTimer = setTimeout(() => void heartbeat(), interval);
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer === undefined) return;
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #schedulePoll(delay: number): void {
    this.#pollTimer = setTimeout(() => void this.#poll(), delay);
  }

  async #poll(): Promise<void> {
    this.#pollTimer = undefined;
    try {
      await this.runOnce();
    } catch (error) {
      await this.#report(sanitizeError(error, this.#options.sensitiveValues ?? []));
    }
    if (this.#running) this.#schedulePoll(this.#options.pollIntervalMs);
  }

  async #report(error: SanitizedWorkflowError, job?: LeasedWorkflowJob): Promise<void> {
    if (this.#options.reportError === undefined) return;
    try {
      await this.#options.reportError(error, job);
    } catch {
      // Error reporting must not change durable workflow state.
    }
  }
}
