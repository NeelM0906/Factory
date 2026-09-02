/**
 * Per-session sequence allocator for normalized events.
 *
 * Sequence numbers are positive, strictly increasing, allocated per AutoStack session, and
 * **survive the stream ending** so that a resume() can continue above the last number.
 *
 * Nothing is emitted after a lifecycle terminal (completed/failed/cancelled). `interrupted`
 * is not a terminal — it ends the stream but allows resume (D-2).
 */

export class EventSequencer {
  #counter = 0;
  #terminal = false;

  /** Allocate the next sequence number. Throws if a lifecycle terminal has been marked. */
  next(): number {
    if (this.#terminal) {
      throw new Error("Cannot allocate a sequence number after a lifecycle terminal event.");
    }
    this.#counter++;
    return this.#counter;
  }

  /** The last allocated sequence number, or 0 if none has been allocated. */
  get lastAllocated(): number {
    return this.#counter;
  }

  /** Mark that a lifecycle terminal event (completed/failed/cancelled) has been emitted. */
  markTerminal(): void {
    this.#terminal = true;
  }

  /** Mark that an interrupted event has been emitted. This ends the stream but is NOT terminal. */
  markInterrupted(): void {
    // interrupted is not terminal — it ends the current stream but allows resume.
    // No special state change needed; the stream is ended externally.
  }

  /** Signal that the current event stream has ended. Does not affect the counter. */
  endStream(): void {
    // The counter survives — resume() continues above it.
  }

  /** Reset the sequencer for a brand-new session (not a resume). */
  reset(): void {
    this.#counter = 0;
    this.#terminal = false;
  }
}
