import {
  CONFIGURED_SECRET_LIMITS,
  selectSensitiveRedactionMarker,
  StreamingSensitiveMaterialDetector
} from "@autostack/contracts";

import {
  StatefulSecretSanitizer,
  StreamingTerminalNormalizer,
  renderRedactions
} from "./secret-stream.js";

const REDACTION = "[REDACTED]";
const DEFAULT_WITHHELD_CHARACTERS = 1_024;
const MAX_WITHHELD_CHARACTERS = 8_192;

class RedactionConfigurationError extends RangeError {
  constructor() {
    super("The redaction configuration is invalid.");
    this.name = "RedactionConfigurationError";
  }
}

const snapshotSensitiveValues = (source: readonly string[] | undefined): readonly string[] => {
  if (source === undefined) return [];
  const values: string[] = [];
  let aggregateCharacters = 0;
  const append = (value: unknown): void => {
    if (typeof value !== "string") throw new RedactionConfigurationError();
    values.push(value);
    aggregateCharacters += value.length;
    if (
      values.length > CONFIGURED_SECRET_LIMITS.maximumCount ||
      aggregateCharacters > CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters
    ) {
      throw new RedactionConfigurationError();
    }
  };
  if (Array.isArray(source)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > CONFIGURED_SECRET_LIMITS.maximumCount
    ) {
      throw new RedactionConfigurationError();
    }
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new RedactionConfigurationError();
      }
      append(descriptor.value);
    }
    return values;
  }
  const iteratorMethod = Reflect.get(source, Symbol.iterator) as unknown;
  if (typeof iteratorMethod !== "function") throw new RedactionConfigurationError();
  const iterator = Reflect.apply(iteratorMethod, source, []) as Iterator<string>;
  if (typeof iterator !== "object" || iterator === null) throw new RedactionConfigurationError();
  let completed = false;
  try {
    while (true) {
      const nextMethod = Reflect.get(iterator, "next") as unknown;
      if (typeof nextMethod !== "function") throw new RedactionConfigurationError();
      const result = Reflect.apply(nextMethod, iterator, []) as IteratorResult<unknown>;
      if (typeof result !== "object" || result === null) throw new RedactionConfigurationError();
      if (Reflect.get(result, "done") === true) {
        completed = true;
        break;
      }
      append(Reflect.get(result, "value"));
    }
  } finally {
    if (!completed) {
      try {
        const returnMethod = Reflect.get(iterator, "return") as unknown;
        if (typeof returnMethod === "function") {
          const cleanup = Reflect.apply(returnMethod, iterator, []) as unknown;
          void Promise.resolve(cleanup).catch(() => undefined);
        }
      } catch {
        // Cleanup is best effort and must not replace the static admission error.
      }
    }
  }
  return values;
};

export interface StreamingSecretRedactorOptions {
  readonly sensitiveValues?: readonly string[];
  readonly withheldCharacters?: number;
}

/**
 * Stateful terminal-text redaction. Raw decoded bytes and a control-normalized
 * detection view are scanned independently before rendered output is released.
 */
export class StreamingSecretRedactor {
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });
  readonly #normalizer = new StreamingTerminalNormalizer();
  readonly #detector: StreamingSensitiveMaterialDetector;
  readonly #visibleSanitizer: StatefulSecretSanitizer;
  readonly #redactionMarker: string;
  #decoderHasStreamingBytes = false;
  #finalized = false;

  constructor(options: StreamingSecretRedactorOptions = {}) {
    try {
      const sensitiveValuesOption = options.sensitiveValues;
      const withheldCharactersOption = options.withheldCharacters;
      const sensitiveValues = snapshotSensitiveValues(sensitiveValuesOption);
      const longestSensitiveValue = sensitiveValues.reduce(
        (longest, value) => Math.max(longest, [...value].length),
        0
      );
      const requested = withheldCharactersOption ?? DEFAULT_WITHHELD_CHARACTERS;
      const withheldCharacters = Math.max(requested, longestSensitiveValue + 64);
      if (
        !Number.isSafeInteger(withheldCharacters) ||
        withheldCharacters < 64 ||
        withheldCharacters > MAX_WITHHELD_CHARACTERS
      ) {
        throw new RedactionConfigurationError();
      }
      this.#redactionMarker = selectSensitiveRedactionMarker(sensitiveValues);
      this.#detector = new StreamingSensitiveMaterialDetector(sensitiveValues);
      this.#visibleSanitizer = new StatefulSecretSanitizer(sensitiveValues, withheldCharacters);
    } catch {
      throw new RedactionConfigurationError();
    }
  }

  get sensitiveDetected(): boolean {
    return this.#detector.sensitiveDetected || this.#visibleSanitizer.sensitiveDetected;
  }

  write(chunk: string | Uint8Array): string {
    if (this.#finalized) throw new Error("The streaming redactor is already finalized.");
    let decoded: string;
    if (typeof chunk === "string") {
      decoded = (this.#decoderHasStreamingBytes ? this.#decoder.decode() : "") + chunk;
      this.#decoderHasStreamingBytes = false;
    } else {
      decoded = this.#decoder.decode(chunk, { stream: true });
      this.#decoderHasStreamingBytes = true;
    }
    this.#detector.write(decoded);
    return renderRedactions(
      this.#visibleSanitizer.write(this.#normalizer.write(decoded)),
      this.#redactionMarker
    );
  }

  finalize(): string {
    if (this.#finalized) return "";
    this.#finalized = true;
    const decoded = this.#decoderHasStreamingBytes ? this.#decoder.decode() : "";
    this.#decoderHasStreamingBytes = false;
    this.#detector.write(decoded);
    void this.#detector.finalize();
    const rendered = this.#normalizer.write(decoded) + this.#normalizer.finalize();
    const result = this.#visibleSanitizer.write(rendered) + this.#visibleSanitizer.finalize();
    return renderRedactions(result, this.#redactionMarker);
  }
}

export class StreamingSensitiveScanner {
  readonly #redactor: StreamingSecretRedactor;

  constructor(sensitiveValues: readonly string[] = []) {
    this.#redactor = new StreamingSecretRedactor({ sensitiveValues });
  }

  write(chunk: string | Uint8Array): void {
    void this.#redactor.write(chunk);
  }

  finalize(): boolean {
    void this.#redactor.finalize();
    return this.#redactor.sensitiveDetected;
  }
}

export interface TranscriptTruncation {
  readonly target: "live" | "replay";
  readonly byteLimit: number;
}

export interface TranscriptWriteResult {
  readonly durable: Buffer;
  readonly liveOutput: readonly string[];
  readonly replayOutput: readonly string[];
  readonly truncations: readonly TranscriptTruncation[];
}

export interface RedactedTranscriptOptions extends StreamingSecretRedactorOptions {
  readonly durableByteLimit: number;
  readonly liveByteLimit: number;
  readonly replayByteLimit: number;
}

export class TranscriptLimitError extends Error {
  readonly code = "transcript_too_large";

  constructor() {
    super("The durable redacted transcript exceeded its configured byte limit.");
    this.name = "TranscriptLimitError";
  }
}

class TranscriptProcessingError extends Error {
  constructor() {
    super("The redacted transcript could not process the supplied output.");
    this.name = "TranscriptProcessingError";
  }
}

const TRANSCRIPT_LIMIT_FAILURE = Symbol("transcript_limit_failure");
type TranscriptFailure = "limit" | "processing";

const assertByteLimit = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
};

const utf8Prefix = (value: string, maximumBytes: number): string => {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
};

export class RedactedTranscript {
  readonly #redactor: StreamingSecretRedactor;
  readonly #durableByteLimit: number;
  readonly #liveByteLimit: number;
  readonly #replayByteLimit: number;
  #durableBytes = 0;
  #liveBytes = 0;
  #replayBytes = 0;
  #liveTruncated = false;
  #replayTruncated = false;
  #finalized = false;
  #terminalFailure: TranscriptFailure | undefined;

  constructor(options: RedactedTranscriptOptions) {
    try {
      const durableByteLimit = options.durableByteLimit;
      const liveByteLimit = options.liveByteLimit;
      const replayByteLimit = options.replayByteLimit;
      const sensitiveValuesOption = options.sensitiveValues;
      const withheldCharacters = options.withheldCharacters;
      const sensitiveValues = snapshotSensitiveValues(sensitiveValuesOption);
      assertByteLimit(durableByteLimit, "durableByteLimit");
      assertByteLimit(liveByteLimit, "liveByteLimit");
      assertByteLimit(replayByteLimit, "replayByteLimit");
      this.#durableByteLimit = durableByteLimit;
      this.#liveByteLimit = liveByteLimit;
      this.#replayByteLimit = replayByteLimit;
      this.#redactor = new StreamingSecretRedactor({
        sensitiveValues,
        ...(withheldCharacters === undefined ? {} : { withheldCharacters })
      });
    } catch {
      throw new RedactionConfigurationError();
    }
  }

  write(chunk: string | Uint8Array): TranscriptWriteResult {
    this.#throwIfFailed();
    if (this.#finalized) throw new Error("The redacted transcript is already finalized.");
    try {
      return this.#accept(this.#redactor.write(chunk));
    } catch (error) {
      return this.#poison(error);
    }
  }

  finalize(): TranscriptWriteResult {
    this.#throwIfFailed();
    if (this.#finalized) {
      return { durable: Buffer.alloc(0), liveOutput: [], replayOutput: [], truncations: [] };
    }
    try {
      const result = this.#accept(this.#redactor.finalize());
      this.#finalized = true;
      return result;
    } catch (error) {
      return this.#poison(error);
    }
  }

  #throwIfFailed(): void {
    if (this.#terminalFailure === "limit") throw new TranscriptLimitError();
    if (this.#terminalFailure === "processing") throw new TranscriptProcessingError();
  }

  #poison(error: unknown): never {
    this.#terminalFailure = error === TRANSCRIPT_LIMIT_FAILURE ? "limit" : "processing";
    this.#throwIfFailed();
    throw new TranscriptProcessingError();
  }

  #accept(value: string): TranscriptWriteResult {
    const durable = Buffer.from(value);
    if (this.#durableBytes + durable.byteLength > this.#durableByteLimit) {
      throw TRANSCRIPT_LIMIT_FAILURE;
    }
    this.#durableBytes += durable.byteLength;
    const truncations: TranscriptTruncation[] = [];
    const liveOutput = this.#boundedOutput(
      value,
      this.#liveByteLimit,
      this.#liveBytes,
      this.#liveTruncated
    );
    this.#liveBytes += Buffer.byteLength(liveOutput);
    if (!this.#liveTruncated && Buffer.byteLength(liveOutput) < durable.byteLength) {
      this.#liveTruncated = true;
      truncations.push({ target: "live", byteLimit: this.#liveByteLimit });
    }
    const replayOutput = this.#boundedOutput(
      value,
      this.#replayByteLimit,
      this.#replayBytes,
      this.#replayTruncated
    );
    this.#replayBytes += Buffer.byteLength(replayOutput);
    if (!this.#replayTruncated && Buffer.byteLength(replayOutput) < durable.byteLength) {
      this.#replayTruncated = true;
      truncations.push({ target: "replay", byteLimit: this.#replayByteLimit });
    }
    return {
      durable,
      liveOutput: liveOutput.length === 0 ? [] : [liveOutput],
      replayOutput: replayOutput.length === 0 ? [] : [replayOutput],
      truncations
    };
  }

  #boundedOutput(value: string, limit: number, used: number, truncated: boolean): string {
    if (truncated) return "";
    return utf8Prefix(value, Math.max(0, limit - used));
  }
}

export const redactCompleteText = (
  value: string | Uint8Array,
  sensitiveValues: readonly string[] = []
): { readonly value: string; readonly sensitiveDetected: boolean } => {
  const redactor = new StreamingSecretRedactor({ sensitiveValues });
  const output = redactor.write(value) + redactor.finalize();
  return { value: output, sensitiveDetected: redactor.sensitiveDetected };
};

export { REDACTION as REDACTION_MARKER };
