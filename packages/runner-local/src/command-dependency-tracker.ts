import { createCommandExecutorError } from "./command-executor-error.js";
import { admitIntrinsicPromise, observeIntrinsicPromise } from "./command-guardian-bounds.js";

export const DEPENDENCY_TIMEOUT_MS = 2_000;
const MAXIMUM_RETAINED_DEPENDENCIES = 256;

/** Retains timed-out dependency authority until late cleanup is proven safe. */
export class CommandDependencyTracker {
  readonly #retained = new Set<Promise<void>>();
  readonly #cleanupRetained = new Set<Promise<void>>();
  readonly #maximumRetained: number;
  #cleanupHeartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(maximumRetained = MAXIMUM_RETAINED_DEPENDENCIES) {
    if (!Number.isSafeInteger(maximumRetained) || maximumRetained < 1) throw new TypeError();
    this.#maximumRetained = maximumRetained;
  }

  get unsettledCount(): number {
    return this.#retained.size + this.#cleanupRetained.size;
  }

  #ensureHeartbeat(): void {
    this.#cleanupHeartbeat ??= setInterval(() => undefined, 1_000);
    this.#cleanupHeartbeat.ref();
  }

  #clearHeartbeatIfSettled(): void {
    if (
      this.#retained.size !== 0 ||
      this.#cleanupRetained.size !== 0 ||
      this.#cleanupHeartbeat === undefined
    )
      return;
    clearInterval(this.#cleanupHeartbeat);
    this.#cleanupHeartbeat = undefined;
  }

  async wait<Value>(
    input: PromiseLike<Value> | Value,
    onLate?: (value: Value) => Promise<void> | void,
    timeoutMs = DEPENDENCY_TIMEOUT_MS
  ): Promise<Value> {
    if (this.#retained.size >= this.#maximumRetained) {
      throw createCommandExecutorError("unsafe_state");
    }
    let pending: Promise<Value>;
    try {
      pending = admitIntrinsicPromise<Value>(input);
    } catch {
      throw createCommandExecutorError("unsafe_state");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const observed = observeIntrinsicPromise<
      Value,
      { readonly completed: true; readonly value: Value },
      { readonly completed: false; readonly error: unknown }
    >(
      pending,
      (value) => ({ completed: true as const, value }),
      (error: unknown) => ({ completed: false as const, error })
    );
    const outcome = await Promise.race([observed, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if ("timedOut" in outcome) {
      this.#ensureHeartbeat();
      let cleanupSettledSafely = false;
      const retained = observeIntrinsicPromise<Value, void, void>(
        pending,
        async (value) => {
          await onLate?.(value);
          cleanupSettledSafely = true;
        },
        () => {
          cleanupSettledSafely = true;
        }
      )
        .catch((error: unknown) => {
          this.#ensureHeartbeat();
          throw error;
        })
        .finally(() => {
          if (cleanupSettledSafely) {
            this.#retained.delete(retained);
            this.#clearHeartbeatIfSettled();
          }
        });
      this.#retained.add(retained);
      void retained.catch(() => undefined);
      throw createCommandExecutorError("unsafe_state");
    }
    if (!outcome.completed) throw outcome.error;
    return outcome.value;
  }

  /** Internal cleanup is already bounded by admitted starts and cannot consume external capacity. */
  async waitForCleanup<Value>(input: PromiseLike<Value> | Value): Promise<Value> {
    let pending: Promise<Value>;
    try {
      pending = admitIntrinsicPromise<Value>(input);
    } catch {
      throw createCommandExecutorError("unsafe_state");
    }
    this.#ensureHeartbeat();
    let settledSafely = false;
    const retained = observeIntrinsicPromise<Value, void, void>(
      pending,
      () => {
        settledSafely = true;
      },
      (error: unknown) => {
        throw error;
      }
    ).finally(() => {
      if (settledSafely) {
        this.#cleanupRetained.delete(retained);
        this.#clearHeartbeatIfSettled();
      }
    });
    this.#cleanupRetained.add(retained);
    void retained.catch(() => undefined);
    return await pending;
  }
}
