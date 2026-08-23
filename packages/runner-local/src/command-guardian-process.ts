import type {
  BoundProcessTreeAuthority,
  Disposable,
  ProcessTreeExitProof,
  PtyExit
} from "./pty.js";

import { GUARDIAN_OPERATION_TIMEOUT_MS } from "./command-guardian-bounds.js";
import { admitProcessTreeExitProof } from "./command-guardian-capability.js";

type AbortableOutcome<Value> =
  | Readonly<{ readonly status: "completed"; readonly value: Value }>
  | Readonly<{ readonly status: "failed" }>
  | Readonly<{ readonly status: "timed_out"; readonly settled: Promise<void> }>;

const invokeAbortable = async <Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  timeoutMs = GUARDIAN_OPERATION_TIMEOUT_MS
): Promise<AbortableOutcome<Value>> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve()
    .then(async () => await operation(controller.signal))
    .then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const })
    );
  const timeout = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  const winner = await Promise.race([pending, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if ("timedOut" in winner) {
    return Object.freeze({ status: "timed_out", settled: pending.then(() => undefined) });
  }
  return winner.ok
    ? Object.freeze({ status: "completed", value: winner.value })
    : Object.freeze({ status: "failed" });
};

export interface ProcessOperationResult<Value> {
  readonly completed: boolean;
  readonly value?: Value;
  readonly retryAfter?: Promise<void>;
}

export const dispatchProcessSignal = async (
  authority: BoundProcessTreeAuthority,
  signal: "SIGINT" | "SIGTERM" | "SIGKILL"
): Promise<ProcessOperationResult<void>> => {
  const outcome = await invokeAbortable((abortSignal) => authority.signal(signal, abortSignal));
  if (outcome.status === "completed") return Object.freeze({ completed: true });
  if (outcome.status === "timed_out") {
    return Object.freeze({ completed: false, retryAfter: outcome.settled });
  }
  return Object.freeze({ completed: false });
};

export const proveProcessTreeExit = async (
  authority: BoundProcessTreeAuthority,
  sensitiveValues: readonly string[]
): Promise<ProcessOperationResult<ProcessTreeExitProof>> => {
  const outcome = await invokeAbortable((abortSignal) => authority.waitForExit(abortSignal));
  if (outcome.status === "completed") {
    try {
      return Object.freeze({
        completed: true,
        value: admitProcessTreeExitProof(outcome.value, authority.identityDigest, sensitiveValues)
      });
    } catch {
      return Object.freeze({ completed: false });
    }
  }
  if (outcome.status === "timed_out") {
    return Object.freeze({ completed: false, retryAfter: outcome.settled });
  }
  return Object.freeze({ completed: false });
};

export interface ProcessCleanupResult {
  readonly terminated: boolean;
  readonly retryAfter?: Promise<void>;
  readonly exit?: PtyExit;
  readonly proof?: ProcessTreeExitProof;
}

/** Operates only on the immutable process-tree capability returned by the atomic spawn. */
export const terminateProcessTree = async (
  authority: BoundProcessTreeAuthority | undefined,
  initialSignal: "SIGINT" | "SIGTERM",
  sensitiveValues: readonly string[]
): Promise<ProcessCleanupResult> => {
  if (authority === undefined) return Object.freeze({ terminated: false });
  const signal = await dispatchProcessSignal(authority, initialSignal);
  if (signal.retryAfter !== undefined) {
    return Object.freeze({
      terminated: false,
      retryAfter: signal.retryAfter
    });
  }
  if (!signal.completed) return Object.freeze({ terminated: false });
  const graceful = await proveProcessTreeExit(authority, sensitiveValues);
  if (graceful.retryAfter !== undefined) {
    return Object.freeze({
      terminated: false,
      retryAfter: graceful.retryAfter
    });
  }
  if (graceful.completed && graceful.value?.processTreeTerminated === true) {
    return Object.freeze({ terminated: true, exit: graceful.value.exit, proof: graceful.value });
  }
  const forcedSignal = await dispatchProcessSignal(authority, "SIGKILL");
  if (forcedSignal.retryAfter !== undefined) {
    return Object.freeze({
      terminated: false,
      retryAfter: forcedSignal.retryAfter
    });
  }
  if (!forcedSignal.completed) return Object.freeze({ terminated: false });
  const forced = await proveProcessTreeExit(authority, sensitiveValues);
  if (forced.retryAfter !== undefined) {
    return Object.freeze({
      terminated: false,
      retryAfter: forced.retryAfter
    });
  }
  if (forced.completed && forced.value?.processTreeTerminated === true) {
    return Object.freeze({ terminated: true, exit: forced.value.exit, proof: forced.value });
  }
  return Object.freeze({ terminated: false });
};

export interface RetainedCleanupSupervisor {
  readonly closed: Promise<void>;
}

export class GuardianProcessOperationQueue {
  #tail: Promise<void> = Promise.resolve();
  #settlementBarrier: Promise<void> | undefined;

  run<Value>(operation: () => Promise<Value>): Promise<Value> {
    const running = this.#tail.then(() => {
      const barrier = this.#settlementBarrier;
      return barrier === undefined ? operation() : barrier.then(operation);
    });
    this.#tail = running.then(
      () => undefined,
      () => undefined
    );
    return running;
  }

  blockUntil(settled: Promise<void>): void {
    const admitted = Promise.resolve(settled).then(
      () => undefined,
      () => undefined
    );
    const barrier = Promise.all([this.#settlementBarrier ?? Promise.resolve(), admitted]).then(
      () => undefined
    );
    this.#settlementBarrier = barrier;
    void barrier.finally(() => {
      if (this.#settlementBarrier === barrier) this.#settlementBarrier = undefined;
    });
  }
}

export class GuardianCancellationGrace {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #resolve: (() => void) | undefined;

  async wait(timeoutMs: number): Promise<void> {
    try {
      await new Promise<void>((resolve) => {
        this.#resolve = resolve;
        this.#timer = setTimeout(resolve, timeoutMs);
      });
    } finally {
      this.dispose();
    }
  }

  release(): void {
    this.#resolve?.();
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#resolve = undefined;
  }
}

export const disposeGuardianTransientResources = (
  input: Readonly<{
    readonly timers: readonly (ReturnType<typeof setTimeout> | undefined)[];
    readonly disposables: readonly Disposable[];
    readonly releaseGrace?: () => void;
  }>
): void => {
  for (const timer of input.timers) {
    if (timer !== undefined) clearTimeout(timer);
  }
  input.releaseGrace?.();
  for (const disposable of input.disposables) {
    try {
      disposable.dispose();
    } catch {
      // Process-tree proof, not listener cleanup, controls authority release.
    }
  }
};

/** Keeps a ref'ed supervisor alive and never overlaps an unresolved process-tree operation. */
export const retainCleanupSupervisor = (
  authority: BoundProcessTreeAuthority,
  onProven: () => void,
  operations: GuardianProcessOperationQueue,
  sensitiveValues: readonly string[],
  retryAfter?: Promise<void>
): RetainedCleanupSupervisor => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let settled = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const schedule = (): void => {
    timer = setTimeout(() => void retry(), 100);
    timer.ref();
  };
  const retry = async (): Promise<void> => {
    if (settled) return;
    const result = await operations.run(
      async () => await terminateProcessTree(authority, "SIGTERM", sensitiveValues)
    );
    if (result.terminated) {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      onProven();
      resolveClosed();
      return;
    }
    if (result.retryAfter !== undefined) {
      operations.blockUntil(result.retryAfter);
      heartbeat ??= setInterval(() => undefined, 1_000);
      heartbeat.ref();
      await result.retryAfter;
      if (!settled) schedule();
      return;
    }
    schedule();
  };
  if (retryAfter === undefined) {
    void retry().catch(schedule);
  } else {
    heartbeat = setInterval(() => undefined, 1_000);
    heartbeat.ref();
    void retryAfter.then(retry, schedule);
  }
  return Object.freeze({ closed });
};
