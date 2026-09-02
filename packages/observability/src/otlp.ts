/**
 * Maps internal span records onto the OTLP `Span` message shape.
 *
 * This makes "OpenTelemetry-compatible" falsifiable: the conformance
 * test in `otlp-conformance.test.ts` asserts the exact key names
 * and value types against the `opentelemetry.proto.trace.v1.Span`
 * protobuf definition.
 */

import type { SpanKind, SpanRecord } from "./tracer.js";
import type { AttributeValue } from "./attributes.js";

const SPAN_KIND_MAP: Readonly<Record<SpanKind, string>> = {
  internal: "SPAN_KIND_INTERNAL",
  server: "SPAN_KIND_SERVER",
  client: "SPAN_KIND_CLIENT",
  producer: "SPAN_KIND_PRODUCER",
  consumer: "SPAN_KIND_CONSUMER"
};

const STATUS_CODE_MAP: Readonly<Record<string, string>> = {
  unset: "STATUS_CODE_UNSET",
  ok: "STATUS_CODE_OK",
  error: "STATUS_CODE_ERROR"
};

interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly intValue?: string;
  readonly boolValue?: boolean;
  readonly arrayValue?: { readonly values: readonly OtlpAnyValue[] };
}

interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

interface OtlpEvent {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly attributes: readonly OtlpKeyValue[];
}

interface OtlpStatus {
  readonly code: string;
  readonly message?: string;
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpKeyValue[];
  readonly events: readonly OtlpEvent[];
  readonly status: OtlpStatus;
}

function msToNanoString(ms: number): string {
  return String(BigInt(Math.round(ms)) * BigInt(1_000_000));
}

function toOtlpValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { intValue: String(value) };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item) => ({ stringValue: item }))
      }
    };
  }
  return { stringValue: String(value) };
}

function toOtlpAttributes(
  attributes: Readonly<Record<string, AttributeValue>>
): readonly OtlpKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toOtlpValue(value)
  }));
}

export function toOtlpSpan(span: SpanRecord): OtlpSpan {
  const status: OtlpStatus = {
    code: STATUS_CODE_MAP[span.status.code] ?? "STATUS_CODE_UNSET",
    ...(span.status.message !== undefined ? { message: span.status.message } : {})
  };

  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: SPAN_KIND_MAP[span.kind],
    startTimeUnixNano: msToNanoString(span.startedAt),
    endTimeUnixNano: msToNanoString(span.endedAt),
    attributes: toOtlpAttributes(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: msToNanoString(event.timestamp),
      attributes: toOtlpAttributes(event.attributes)
    })),
    status
  };
}
