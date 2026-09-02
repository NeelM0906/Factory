/**
 * Minimal span tracer that records OpenTelemetry-compatible span shapes.
 *
 * No OTel runtime dependency — the shapes map onto OTLP fields, making
 * a real exporter a thin adapter in Wave 2.
 */

import { safeAttributes, type AttributeValue, type Attributes } from "./attributes.js";
import { currentCorrelation, type IdFactory } from "./correlation.js";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

export interface SpanStatus {
  readonly code: "unset" | "ok" | "error";
  readonly message?: string;
}

export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes: Attributes;
}

export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly attributes: Attributes;
  readonly events: readonly SpanEvent[];
  readonly status: SpanStatus;
}

export type SpanExporter = (span: SpanRecord) => void;

export interface StartSpanOptions {
  readonly kind: SpanKind;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly parentSpanId?: string;
}

export interface Span {
  readonly setAttribute: (key: string, value: AttributeValue) => void;
  readonly addEvent: (name: string, attributes?: Readonly<Record<string, unknown>>) => void;
  readonly setStatus: (status: SpanStatus) => void;
  readonly recordException: (error: Error) => void;
  readonly end: () => void;
}

export interface Tracer {
  readonly startSpan: (name: string, options: StartSpanOptions) => Span;
}

export const noopExporter: SpanExporter = () => {};

const defaultIds: IdFactory = {
  traceId: () => {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
  },
  spanId: () => {
    const array = new Uint8Array(8);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
  }
};

export interface CreateTracerOptions {
  readonly exporter?: SpanExporter;
  readonly now?: () => number;
  readonly ids?: IdFactory;
  readonly onDiagnostic?: (error: unknown) => void;
}

export function createTracer(options: CreateTracerOptions = {}): Tracer {
  const exporter = options.exporter ?? noopExporter;
  const now = options.now ?? (() => Date.now());
  const ids = options.ids ?? defaultIds;
  const onDiagnostic = options.onDiagnostic ?? (() => {});

  // If using the noop exporter, skip all allocation
  if (exporter === noopExporter) {
    const noopSpan: Span = {
      setAttribute: () => {},
      addEvent: () => {},
      setStatus: () => {},
      recordException: () => {},
      end: () => {}
    };
    return {
      startSpan: () => noopSpan
    };
  }

  return {
    startSpan(name: string, spanOptions: StartSpanOptions): Span {
      const correlation = currentCorrelation();
      const traceId = correlation?.traceId ?? ids.traceId();
      const spanId = ids.spanId();
      const startedAt = now();
      const attrs: Record<string, AttributeValue> = Object.create(null) as Record<
        string,
        AttributeValue
      >;
      const events: SpanEvent[] = [];
      let status: SpanStatus = { code: "unset" };
      let ended = false;

      // Copy initial attributes through the safety gate
      if (spanOptions.attributes !== undefined) {
        const safe = safeAttributes(spanOptions.attributes);
        for (const [k, v] of Object.entries(safe)) {
          attrs[k] = v;
        }
      }

      return {
        setAttribute(key: string, value: AttributeValue) {
          if (ended) return;
          const safe = safeAttributes({ [key]: value });
          for (const [k, v] of Object.entries(safe)) {
            attrs[k] = v;
          }
        },

        addEvent(eventName: string, eventAttributes?: Readonly<Record<string, unknown>>) {
          if (ended) return;
          events.push({
            name: eventName,
            timestamp: now(),
            attributes: eventAttributes !== undefined ? safeAttributes(eventAttributes) : Object.freeze({})
          });
        },

        setStatus(newStatus: SpanStatus) {
          if (ended) return;
          status = newStatus;
        },

        recordException(error: Error) {
          if (ended) return;
          events.push({
            name: "exception",
            timestamp: now(),
            attributes: Object.freeze({
              "exception.type": error.constructor.name,
              "exception.message": error.message,
              ...(error.stack !== undefined ? { "exception.stacktrace": error.stack } : {})
            })
          });
        },

        end() {
          if (ended) return;
          ended = true;
          const record: SpanRecord = {
            traceId,
            spanId,
            parentSpanId: spanOptions.parentSpanId,
            name,
            kind: spanOptions.kind,
            startedAt,
            endedAt: now(),
            attributes: Object.freeze({ ...attrs }),
            events: Object.freeze([...events]),
            status
          };
          try {
            exporter(record);
          } catch (error) {
            onDiagnostic(error);
          }
        }
      };
    }
  };
}
