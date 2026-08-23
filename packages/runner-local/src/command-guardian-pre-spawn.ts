import { admitPtyExit } from "./command-guardian-capability.js";
import { snapshotBytes } from "./command-guardian-bounds.js";
import { MAXIMUM_QUEUED_RAW_BYTES, MAXIMUM_QUEUED_RAW_FRAMES } from "./command-guardian-output.js";
import type { PtyCapture, PtyExit } from "./pty.js";

export type PreSpawnCaptureFailure = "protocol_failure" | "output_quarantined";

export interface PreSpawnCaptureSnapshot {
  readonly chunks: readonly Uint8Array[];
  readonly eofObserved: boolean;
  readonly exit?: PtyExit;
  readonly exitConflict: boolean;
  readonly failure?: PreSpawnCaptureFailure;
}

/**
 * Bounds synchronous native callbacks without dispatching process operations before the atomic
 * spawn has returned its immutable process-tree capability.
 */
export class GuardianPreSpawnCapture {
  readonly capture: PtyCapture;
  readonly #sensitiveValues: readonly string[];
  readonly #chunks: Uint8Array[] = [];
  #bytes = 0;
  #eofObserved = false;
  #exit: PtyExit | undefined;
  #failure: PreSpawnCaptureFailure | undefined;
  #exitConflict = false;
  #drained = false;
  #active: PtyCapture | undefined;

  constructor(sensitiveValues: readonly string[]) {
    this.#sensitiveValues = sensitiveValues;
    this.capture = Object.freeze({
      onData: (chunk: Uint8Array) => this.#captureData(chunk),
      onEof: () => {
        if (this.#active !== undefined) {
          this.#active.onEof();
          return;
        }
        this.#eofObserved = true;
      },
      onExit: (exit: PtyExit) => this.#captureExit(exit)
    });
  }

  #captureData(chunk: Uint8Array): void {
    if (this.#active !== undefined) {
      this.#active.onData(chunk);
      return;
    }
    if (this.#drained || this.#failure !== undefined) return;
    try {
      const immutable = snapshotBytes(chunk, { maximumBytes: MAXIMUM_QUEUED_RAW_BYTES });
      if (
        this.#chunks.length >= MAXIMUM_QUEUED_RAW_FRAMES ||
        this.#bytes + immutable.byteLength > MAXIMUM_QUEUED_RAW_BYTES
      ) {
        throw new TypeError();
      }
      this.#bytes += immutable.byteLength;
      this.#chunks.push(immutable);
    } catch {
      this.#failure = "output_quarantined";
      this.#chunks.splice(0);
      this.#bytes = 0;
    }
  }

  #captureExit(exit: PtyExit): void {
    if (this.#active !== undefined) {
      this.#active.onExit(exit);
      return;
    }
    if (this.#drained) return;
    try {
      const admitted = admitPtyExit(exit, this.#sensitiveValues);
      if (this.#exit !== undefined) {
        if (this.#exit.exitCode !== admitted.exitCode || this.#exit.signal !== admitted.signal) {
          this.#exitConflict = true;
          this.#failure = "protocol_failure";
        }
        return;
      }
      this.#exit = admitted;
    } catch {
      if (this.#failure !== "output_quarantined") this.#failure = "protocol_failure";
    }
  }

  activate(capture: PtyCapture): PreSpawnCaptureSnapshot {
    const snapshot = this.drain();
    this.#active = capture;
    return snapshot;
  }

  drain(): PreSpawnCaptureSnapshot {
    if (this.#drained) throw new TypeError("Guardian pre-spawn capture was already drained.");
    this.#drained = true;
    return Object.freeze({
      chunks: Object.freeze(this.#chunks.splice(0)),
      eofObserved: this.#eofObserved,
      exitConflict: this.#exitConflict,
      ...(this.#exit === undefined ? {} : { exit: this.#exit }),
      ...(this.#failure === undefined ? {} : { failure: this.#failure })
    });
  }
}
