/**
 * Line-delimited frame reader over raw child stdout bytes.
 *
 * This is the only place bytes become values. No redaction happens here (D-4): redaction
 * is applied per-field after JSON.parse, never over the byte stream. The reader's job is to
 * reassemble lines, enforce a byte cap, parse JSON, and expose counters for quiesce.
 *
 * Design constraints:
 * - A line over the byte cap is a classified `provider_output_malformed` failure, never
 *   unbounded buffering.
 * - Invalid JSON is the same classified failure, carrying no provider text.
 * - A trailing partial line at EOF is a classified failure, not a silently dropped frame.
 * - `observedBytes` and `emittedFrames` are part of the module's contract — Step 8's
 *   quiesce reads them.
 */

/** The default maximum bytes per line before the reader classifies the line as malformed. */
export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024; // 4 MiB

export type FrameReaderResult =
  | { readonly kind: "frame"; readonly value: unknown }
  | { readonly kind: "failure"; readonly code: "provider_output_malformed"; readonly reason: string };

export interface LineFrameReaderOptions {
  readonly maxLineBytes?: number;
}

export class LineFrameReader {
  readonly #maxLineBytes: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });

  /** Accumulated bytes of the current (incomplete) line. */
  #buffer: Uint8Array = new Uint8Array(0);
  #bufferUsed = 0;

  /** Whether the current line has exceeded the byte cap and should be discarded. */
  #overflowing = false;

  /** Monotonically increasing counters for quiesce. */
  #observedBytes = 0;
  #emittedFrames = 0;

  constructor(options?: LineFrameReaderOptions) {
    this.#maxLineBytes = options?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  get observedBytes(): number {
    return this.#observedBytes;
  }

  get emittedFrames(): number {
    return this.#emittedFrames;
  }

  /**
   * Feed raw bytes from the child's stdout. Returns zero or more results — frames or
   * classified failures — for every complete line found in this chunk.
   */
  feed(chunk: Uint8Array): FrameReaderResult[] {
    this.#observedBytes += chunk.byteLength;
    const results: FrameReaderResult[] = [];

    let offset = 0;
    while (offset < chunk.byteLength) {
      const newlineIndex = chunk.indexOf(0x0a, offset); // '\n'

      if (newlineIndex === -1) {
        // No newline in the remainder — accumulate into the buffer.
        this.#appendToBuffer(chunk.subarray(offset));
        break;
      }

      // We have a complete line (up to and including the newline).
      const lineEnd = newlineIndex; // exclusive of the newline itself
      const segment = chunk.subarray(offset, lineEnd);
      offset = newlineIndex + 1;

      if (this.#overflowing) {
        // This line already overflowed — emit the failure and reset.
        results.push({
          kind: "failure",
          code: "provider_output_malformed",
          reason: "A line exceeded the byte cap and was discarded."
        });
        this.#resetLine();
        continue;
      }

      // Combine buffer + segment into the full line bytes.
      const lineBytes = this.#combineWithBuffer(segment);
      this.#resetLine();

      // Strip trailing \r if present (for \r\n).
      const trimmedBytes =
        lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d
          ? lineBytes.subarray(0, lineBytes.length - 1)
          : lineBytes;

      // Skip empty lines — common in line-delimited protocols.
      if (trimmedBytes.length === 0) {
        continue;
      }

      // Check the byte cap on the final assembled line.
      if (trimmedBytes.byteLength > this.#maxLineBytes) {
        results.push({
          kind: "failure",
          code: "provider_output_malformed",
          reason: "A line exceeded the byte cap and was discarded."
        });
        continue;
      }

      // Decode and parse JSON.
      const text = this.#decoder.decode(trimmedBytes);
      results.push(this.#parseJson(text));
    }

    return results;
  }

  /**
   * Signal end-of-stream. If any bytes remain in the buffer, they are a trailing partial
   * line — a classified failure, never a silently dropped frame.
   */
  end(): FrameReaderResult[] {
    if (this.#bufferUsed === 0 && !this.#overflowing) {
      return [];
    }

    const result: FrameReaderResult = {
      kind: "failure",
      code: "provider_output_malformed",
      reason: this.#overflowing
        ? "A line exceeded the byte cap and was discarded."
        : "A trailing partial line was present at end of stream."
    };
    this.#resetLine();
    return [result];
  }

  #appendToBuffer(data: Uint8Array): void {
    const needed = this.#bufferUsed + data.byteLength;

    // Check overflow before buffering.
    if (needed > this.#maxLineBytes) {
      this.#overflowing = true;
      this.#bufferUsed = 0;
      return;
    }

    // Grow the buffer if necessary.
    if (needed > this.#buffer.byteLength) {
      const next = new Uint8Array(Math.max(needed, this.#buffer.byteLength * 2));
      next.set(this.#buffer.subarray(0, this.#bufferUsed));
      this.#buffer = next;
    }

    this.#buffer.set(data, this.#bufferUsed);
    this.#bufferUsed = needed;
  }

  #combineWithBuffer(segment: Uint8Array): Uint8Array {
    if (this.#bufferUsed === 0) {
      return segment;
    }

    const combined = new Uint8Array(this.#bufferUsed + segment.byteLength);
    combined.set(this.#buffer.subarray(0, this.#bufferUsed));
    combined.set(segment, this.#bufferUsed);
    return combined;
  }

  #resetLine(): void {
    this.#bufferUsed = 0;
    this.#overflowing = false;
  }

  #parseJson(text: string): FrameReaderResult {
    try {
      const value: unknown = JSON.parse(text);
      this.#emittedFrames++;
      return { kind: "frame", value };
    } catch {
      return {
        kind: "failure",
        code: "provider_output_malformed",
        reason: "A line contained invalid JSON."
      };
    }
  }
}
