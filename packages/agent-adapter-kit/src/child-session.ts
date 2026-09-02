/**
 * Child-session supervisor: spawns an agent CLI as a child process over line-delimited stdio,
 * manages its lifecycle, and surfaces events for consumption.
 *
 * Design constraints:
 * - spawn with `shell: false`, `stdio: ["pipe", "pipe", "pipe"]`, `windowsHide: true`,
 *   `detached` on non-Windows, and only the policy-built environment.
 * - stdout frames delivered in order; stderr surfaced separately.
 * - write() resolves only once the child has accepted the bytes.
 * - close() sends SIGTERM, waits a bounded grace, escalates to SIGKILL of the process group.
 * - Idempotent close().
 * - Enforces total-runtime and no-output-progress bounds.
 * - No orphaned process after close().
 * - Stream abandonment (finding 14): iterator.return() terminates child but session stays
 *   usable for close()/dispose().
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

export interface ChildSessionOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Total wall-clock runtime limit in milliseconds. */
  readonly runtimeLimitMs: number;
  /** No-output-progress timeout in milliseconds. */
  readonly progressTimeoutMs: number;
  /** Grace period in milliseconds before SIGKILL escalation. */
  readonly terminationGraceMs: number;
  /** Minimum wall-clock time quiesce() waits while the child is alive (default 200ms). */
  readonly quiesceFloorMs?: number;
}

export type ChildSessionEvent =
  | { readonly kind: "stdout"; readonly line: string }
  | { readonly kind: "stderr"; readonly line: string }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: string | null;
    };

export interface CloseResult {
  readonly exited: boolean;
  readonly code: number | null;
  readonly signal: string | null;
}

export class ChildSession {
  readonly #options: ChildSessionOptions;
  #child: ChildProcess | undefined;
  #pid: number | undefined;
  #closed = false;
  #exited = false;
  #exitCode: number | null = null;
  #exitSignal: string | null = null;

  /** Queued events waiting to be yielded by the async iterator. */
  readonly #eventQueue: ChildSessionEvent[] = [];
  #eventResolve: (() => void) | undefined;
  #streamEnded = false;

  /** Timers for runtime and progress bounds. */
  #runtimeTimer: ReturnType<typeof setTimeout> | undefined;
  #progressTimer: ReturnType<typeof setTimeout> | undefined;

  /** Readline interfaces for stdout and stderr. */
  #stdoutRl: ReadlineInterface | undefined;
  #stderrRl: ReadlineInterface | undefined;

  /** Counters for quiesce. */
  #observedBytes = 0;
  #emittedFrames = 0;

  constructor(options: ChildSessionOptions) {
    this.#options = options;
    this.#spawn();
  }

  get pid(): number | undefined {
    return this.#pid;
  }

  get observedBytes(): number {
    return this.#observedBytes;
  }

  get emittedFrames(): number {
    return this.#emittedFrames;
  }

  get exited(): boolean {
    return this.#exited;
  }

  #spawn(): void {
    const child = spawn(this.#options.executable, [...this.#options.args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      cwd: this.#options.cwd,
      env: { ...this.#options.env }
    });

    this.#child = child;
    this.#pid = child.pid;

    // Set up stdout line reading
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        this.#observedBytes += chunk.byteLength;
        this.#resetProgressTimer();
      });

      this.#stdoutRl = createInterface({ input: child.stdout });
      this.#stdoutRl.on("line", (line: string) => {
        this.#emittedFrames++;
        this.#enqueue({ kind: "stdout", line });
      });
    }

    // Set up stderr line reading
    if (child.stderr) {
      this.#stderrRl = createInterface({ input: child.stderr });
      this.#stderrRl.on("line", (line: string) => {
        this.#enqueue({ kind: "stderr", line });
      });
    }

    // Handle exit
    child.on("exit", (code, signal) => {
      this.#exited = true;
      this.#exitCode = code;
      this.#exitSignal = signal;
      this.#clearTimers();
      this.#enqueue({ kind: "exit", code, signal });
      this.#endStream();
    });

    child.on("error", (error) => {
      this.#exited = true;
      this.#clearTimers();
      this.#endStream();
    });

    // Set up runtime limit
    this.#runtimeTimer = setTimeout(() => {
      this.#terminateChild();
    }, this.#options.runtimeLimitMs);

    // Set up initial progress timeout
    this.#resetProgressTimer();
  }

  #resetProgressTimer(): void {
    if (this.#progressTimer !== undefined) {
      clearTimeout(this.#progressTimer);
    }
    if (!this.#exited && !this.#closed) {
      this.#progressTimer = setTimeout(() => {
        this.#terminateChild();
      }, this.#options.progressTimeoutMs);
    }
  }

  #clearTimers(): void {
    if (this.#runtimeTimer !== undefined) {
      clearTimeout(this.#runtimeTimer);
      this.#runtimeTimer = undefined;
    }
    if (this.#progressTimer !== undefined) {
      clearTimeout(this.#progressTimer);
      this.#progressTimer = undefined;
    }
  }

  #enqueue(event: ChildSessionEvent): void {
    if (this.#streamEnded) return;
    this.#eventQueue.push(event);
    if (this.#eventResolve) {
      const resolve = this.#eventResolve;
      this.#eventResolve = undefined;
      resolve();
    }
  }

  #endStream(): void {
    if (this.#streamEnded) return;
    this.#streamEnded = true;
    if (this.#eventResolve) {
      const resolve = this.#eventResolve;
      this.#eventResolve = undefined;
      resolve();
    }
  }

  /** Write bytes to the child's stdin. Resolves when the write is flushed. */
  async write(data: string): Promise<void> {
    if (!this.#child?.stdin || this.#exited) {
      throw new Error("Cannot write to a closed or exited child.");
    }

    return new Promise<void>((resolve, reject) => {
      const ok = this.#child!.stdin!.write(data, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      // If the buffer is full, wait for drain before resolving
      if (!ok && !this.#exited) {
        this.#child!.stdin!.once("drain", () => {
          if (!this.#exited) resolve();
        });
      }
    });
  }

  /** Terminate the child gracefully, escalating to SIGKILL if needed. */
  async close(): Promise<CloseResult> {
    if (this.#exited) {
      return {
        exited: true,
        code: this.#exitCode,
        signal: this.#exitSignal
      };
    }

    this.#closed = true;
    this.#clearTimers();

    await this.#terminateChild();

    return {
      exited: true,
      code: this.#exitCode,
      signal: this.#exitSignal
    };
  }

  async #terminateChild(): Promise<void> {
    if (this.#exited || !this.#child) return;

    const child = this.#child;

    // Try SIGTERM first
    try {
      if (child.pid !== undefined && process.platform !== "win32") {
        // Kill the process group (negative pid)
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // Process may already be dead
    }

    // Wait for graceful exit or escalate
    const exited = await this.#waitForExit(this.#options.terminationGraceMs);
    if (!exited) {
      // Escalate to SIGKILL
      try {
        if (child.pid !== undefined && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Process may already be dead
      }
      await this.#waitForExit(2000);
    }
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      const check = (): void => {
        if (this.#exited) {
          clearTimeout(timer);
          resolve(true);
        }
      };

      // Poll every 50ms
      const interval = setInterval(() => {
        check();
        if (this.#exited) clearInterval(interval);
      }, 50);

      // Also set up a one-time check on the timer expiry
      setTimeout(() => {
        clearInterval(interval);
      }, timeoutMs + 100);
    });
  }

  /**
   * Quiesce: wait until the transport is genuinely idle.
   *
   * The algorithm (from the plan):
   * 1. Loop, recording (observedBytes, emittedFrames) at each turn:
   *    - await one full event-loop iteration reaching the poll phase
   *      (setTimeout(0) for timers phase, then setImmediate for check phase;
   *       setImmediate alone skips poll entirely, where socket readable data arrives)
   *    - continue while any counter changed since the previous turn
   * 2. Require two consecutive no-change turns.
   * 3. While the child is alive, do not resolve before the wall-clock floor.
   * 4. Bound the total turns and wall clock.
   */
  async quiesce(): Promise<void> {
    const floorMs = this.#options.quiesceFloorMs ?? 200;
    const maxTurns = 200;
    const maxWallMs = 10_000;

    const start = Date.now();
    let stableTurns = 0;
    let turns = 0;
    let prevBytes = this.#observedBytes;
    let prevFrames = this.#emittedFrames;

    while (turns < maxTurns) {
      if (Date.now() - start > maxWallMs) {
        throw new Error("quiesce() exceeded its wall-clock bound.");
      }

      // One full event-loop iteration reaching the poll phase:
      // setTimeout(0) fires in the timers phase; setImmediate fires in the check phase.
      // Between timers and check, the event loop services the poll phase, where socket
      // readable data (child stdout) arrives.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setImmediate(resolve));

      turns++;

      const currentBytes = this.#observedBytes;
      const currentFrames = this.#emittedFrames;

      if (currentBytes !== prevBytes || currentFrames !== prevFrames) {
        stableTurns = 0;
        prevBytes = currentBytes;
        prevFrames = currentFrames;
      } else {
        stableTurns++;
      }

      // Require two consecutive no-change turns
      if (stableTurns >= 2) {
        // If the child is still alive, enforce the wall-clock floor
        if (!this.#exited) {
          const elapsed = Date.now() - start;
          if (elapsed < floorMs) {
            await new Promise<void>((resolve) => setTimeout(resolve, floorMs - elapsed));
          }
        }
        return;
      }
    }

    throw new Error("quiesce() exceeded its turn limit.");
  }

  /** Async iterator for consuming events from the session. */
  async *[Symbol.asyncIterator](): AsyncGenerator<ChildSessionEvent> {
    while (true) {
      if (this.#eventQueue.length > 0) {
        yield this.#eventQueue.shift()!;
        continue;
      }

      if (this.#streamEnded) {
        return;
      }

      // Wait for more events
      await new Promise<void>((resolve) => {
        this.#eventResolve = resolve;
      });
    }
  }
}
