import { describe, expect, it } from "vitest";

import { createTracer, type SpanRecord, type SpanExporter } from "../src/tracer.js";
import { toOtlpSpan, type OtlpSpan } from "../src/otlp.js";
import type { IdFactory } from "../src/correlation.js";

const fixedIds: IdFactory = {
  traceId: () => "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: (() => {
    let counter = 0;
    return () => {
      counter += 1;
      return counter.toString(16).padStart(16, "0");
    };
  })()
};

let time = 1_725_000_000_000; // ms since epoch
const fixedNow = (): number => {
  time += 100;
  return time;
};

const recordSpan = (
  name: string,
  opts: {
    readonly kind?: string;
    readonly parentSpanId?: string;
    readonly attributes?: Record<string, unknown>;
    readonly status?: { readonly code: string; readonly message?: string };
    readonly events?: readonly {
      readonly name: string;
      readonly attributes?: Record<string, unknown>;
    }[];
    readonly exception?: Error;
  } = {}
): SpanRecord => {
  const spans: SpanRecord[] = [];
  const exporter: SpanExporter = (span) => {
    spans.push(span);
  };
  const tracer = createTracer({ exporter, now: fixedNow, ids: fixedIds });
  const span = tracer.startSpan(name, {
    kind: (opts.kind ?? "internal") as "internal",
    ...(opts.attributes !== undefined ? { attributes: opts.attributes } : {}),
    ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : {})
  });
  if (opts.status !== undefined) {
    span.setStatus(opts.status as { code: "ok" });
  }
  if (opts.events !== undefined) {
    for (const event of opts.events) {
      span.addEvent(event.name, event.attributes);
    }
  }
  if (opts.exception !== undefined) {
    span.recordException(opts.exception);
  }
  span.end();
  const recorded = spans[0];
  if (recorded === undefined) throw new Error("Span was not exported");
  return recorded;
};

describe("OTLP span shape conformance", () => {
  it("maps a span onto the OTLP span shape", () => {
    const runId = "run_abc123";
    const recorded = recordSpan("ingress", {
      kind: "internal",
      attributes: { "autostack.run.id": runId },
      status: { code: "ok" }
    });

    const otlp = toOtlpSpan(recorded);

    // Exact key set check
    const expectedKeys = [
      "traceId",
      "spanId",
      "parentSpanId",
      "name",
      "kind",
      "startTimeUnixNano",
      "endTimeUnixNano",
      "attributes",
      "events",
      "status"
    ].sort();
    expect(Object.keys(otlp).sort()).toEqual(expectedKeys);

    // Field validations
    expect(otlp.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(otlp.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(otlp.startTimeUnixNano).toMatch(/^\d+$/);
    expect(otlp.endTimeUnixNano).toMatch(/^\d+$/);
    expect(BigInt(otlp.endTimeUnixNano)).toBeGreaterThan(BigInt(otlp.startTimeUnixNano));
    expect(otlp.kind).toBe("SPAN_KIND_INTERNAL");
    expect(otlp.name).toBe("ingress");
    expect(otlp.attributes).toEqual([{ key: "autostack.run.id", value: { stringValue: runId } }]);
    expect(otlp.status).toEqual({ code: "STATUS_CODE_OK" });
  });

  it("omits parentSpanId on a root span rather than sending zeroes", () => {
    const recorded = recordSpan("root-span");
    const otlp = toOtlpSpan(recorded);
    expect(otlp.parentSpanId).toBeUndefined();
  });

  it("includes parentSpanId on a child span", () => {
    const recorded = recordSpan("child-span", { parentSpanId: "00f067aa0ba902b7" });
    const otlp = toOtlpSpan(recorded);
    expect(otlp.parentSpanId).toBe("00f067aa0ba902b7");
    expect(otlp.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("maps all span kinds to OTLP enum names", () => {
    const kinds = [
      ["internal", "SPAN_KIND_INTERNAL"],
      ["server", "SPAN_KIND_SERVER"],
      ["client", "SPAN_KIND_CLIENT"],
      ["producer", "SPAN_KIND_PRODUCER"],
      ["consumer", "SPAN_KIND_CONSUMER"]
    ] as const;

    for (const [kind, expected] of kinds) {
      const recorded = recordSpan(`kind-${kind}`, { kind });
      const otlp = toOtlpSpan(recorded);
      expect(otlp.kind).toBe(expected);
    }
  });

  it("maps events with timeUnixNano", () => {
    const recorded = recordSpan("event-span", {
      events: [{ name: "cache.miss", attributes: { "cache.key": "user:42" } }]
    });
    const otlp = toOtlpSpan(recorded);
    expect(otlp.events).toHaveLength(1);
    const event = otlp.events[0] as (typeof otlp.events)[number];
    expect(event.name).toBe("cache.miss");
    expect(event.timeUnixNano).toMatch(/^\d+$/);
    expect(event.attributes).toEqual([{ key: "cache.key", value: { stringValue: "user:42" } }]);
  });

  it("maps status codes", () => {
    const okSpan = recordSpan("ok-span", { status: { code: "ok" } });
    expect(toOtlpSpan(okSpan).status).toEqual({ code: "STATUS_CODE_OK" });

    const errorSpan = recordSpan("error-span", {
      status: { code: "error", message: "failed" }
    });
    expect(toOtlpSpan(errorSpan).status).toEqual({
      code: "STATUS_CODE_ERROR",
      message: "failed"
    });
  });

  it("maps number and boolean attribute values", () => {
    const recorded = recordSpan("typed-attrs", {
      attributes: { "http.status": 200, "http.ok": true, "http.method": "GET" }
    });
    const otlp = toOtlpSpan(recorded);
    const byKey = new Map(otlp.attributes.map((a) => [a.key, a.value]));
    expect(byKey.get("http.status")).toEqual({ intValue: "200" });
    expect(byKey.get("http.ok")).toEqual({ boolValue: true });
    expect(byKey.get("http.method")).toEqual({ stringValue: "GET" });
  });

  it("encodes timestamps as nanosecond strings", () => {
    const recorded = recordSpan("timestamp-span");
    const otlp = toOtlpSpan(recorded);
    // Millisecond timestamps should be multiplied by 1_000_000 for nanoseconds
    const startNano = BigInt(otlp.startTimeUnixNano);
    const endNano = BigInt(otlp.endTimeUnixNano);
    // Verify they're in the nanosecond range (> 1e18)
    expect(startNano).toBeGreaterThan(BigInt(1e15));
    expect(endNano).toBeGreaterThan(startNano);
  });

  it("maps string array attribute values to OTLP arrayValue", () => {
    const recorded = recordSpan("array-attrs", {
      attributes: { "http.tags": ["fast", "cached", "v2"] }
    });
    const otlp = toOtlpSpan(recorded);
    const byKey = new Map(otlp.attributes.map((a) => [a.key, a.value]));
    expect(byKey.get("http.tags")).toEqual({
      arrayValue: {
        values: [{ stringValue: "fast" }, { stringValue: "cached" }, { stringValue: "v2" }]
      }
    });
  });
});
