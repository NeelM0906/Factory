/**
 * Structured logger that inherits correlation context automatically.
 *
 * Every log record carries traceId and spanId when logged inside
 * `withCorrelation`. Messages containing credential material are
 * redacted and marked. A sink that throws does not propagate.
 */

import { containsSensitiveMaterial, redactSensitiveText } from "@autostack/contracts";

import { safeAttributes, type Attributes } from "./attributes.js";
import { currentCorrelation } from "./correlation.js";

export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  readonly severity: LogSeverity;
  readonly message: string;
  readonly timestamp: number;
  readonly traceId: string | undefined;
  readonly spanId: string | undefined;
  readonly attributes: Attributes;
  readonly redacted: boolean;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  readonly debug: (message: string, attributes?: Readonly<Record<string, unknown>>) => void;
  readonly info: (message: string, attributes?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, attributes?: Readonly<Record<string, unknown>>) => void;
  readonly error: (message: string, attributes?: Readonly<Record<string, unknown>>) => void;
}

export interface CreateLoggerOptions {
  readonly sink?: LogSink;
  readonly now?: () => number;
  readonly onDiagnostic?: (error: unknown) => void;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const sink = options.sink ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const onDiagnostic = options.onDiagnostic ?? (() => {});

  const log = (
    severity: LogSeverity,
    message: string,
    rawAttributes?: Readonly<Record<string, unknown>>
  ): void => {
    const correlation = currentCorrelation();
    const redacted = containsSensitiveMaterial(message);
    const safeMessage = redacted ? redactSensitiveText(message) : message;
    const attrs =
      rawAttributes !== undefined ? safeAttributes(rawAttributes) : Object.freeze({});

    const record: LogRecord = {
      severity,
      message: safeMessage,
      timestamp: now(),
      traceId: correlation?.traceId,
      spanId: correlation?.spanId,
      attributes: attrs,
      redacted
    };

    try {
      sink(record);
    } catch (error) {
      onDiagnostic(error);
    }
  };

  return {
    debug: (message, attributes) => log("debug", message, attributes),
    info: (message, attributes) => log("info", message, attributes),
    warn: (message, attributes) => log("warn", message, attributes),
    error: (message, attributes) => log("error", message, attributes)
  };
}
