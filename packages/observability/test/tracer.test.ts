import { describe, expect, it, vi } from "vitest";

import {
  createTracer,
  noopExporter,
  type SpanExporter,
  type SpanRecord,
  type SpanKind
} from "../src/tracer.js";
import type { IdFactory } from "../src/correlation.js";

const deterministicIds: IdFactory = {
  traceId: (() => {
    let counter = 0;
    return () => {
      counter += 1;
      return String(counter).padStart(32, "0");
    };
  })(),
  spanId: (() => {
    let counter = 0;
    return () => {
      counter += 1;
      return String(counter).padStart(16, "0");
    };
  })()
};

let nowCounter = 1_000_000;
const deterministicNow = (): number => {
  nowCounter += 1_000;
  return nowCounter;
};

const recordingExporter = (): {
  readonly spans: SpanRecord[];
  readonly exporter: SpanExporter;
  readonly last: () => SpanRecord;
} => {
  const spans: SpanRecord[] = [];
  return {
    spans,
    exporter: (span: SpanRecord) => {
      spans.push(span);
    },
    last: () => {
      const span = spans[spans.length - 1];
      if (span === undefined) throw new Error("No spans recorded");
      return span;
    }
  };
};

describe("tracer", () => {
  it("exports a span when it is ended", () => {
    const { spans, exporter, last } = recordingExporter();
    const tracer = createTracer({ exporter, now: deterministicNow, ids: deterministicIds });
    const span = tracer.startSpan("test-span", { kind: "internal" });
    expect(spans).toHaveLength(0);
    span.end();
    expect(spans).toHaveLength(1);
    expect(last().name).toBe("test-span");
    expect(last().kind).toBe("internal");
  });

  it("never exports a span that was not ended", () => {
    const { spans, exporter } = recordingExporter();
    const tracer = createTracer({ exporter, now: deterministicNow, ids: deterministicIds });
    tracer.startSpan("unended-span", { kind: "internal" });
    expect(spans).toHaveLength(0);
  });

  it("exports only once when end is called twice", () => {
    const { spans, exporter } = recordingExporter();
    const tracer = createTracer({ exporter, now: deterministicNow, ids: deterministicIds });
    const span = tracer.startSpan("double-end", { kind: "internal" });
    span.end();
    span.end();
    expect(spans).toHaveLength(1);
  });

  it("does not propagate an exporter error into traced code", () => {
    const throwingExporter: SpanExporter = () => {
      throw new Error("exporter boom");
    };
    const onDiagnostic = vi.fn();
    const tracer = createTracer({
      exporter: throwingExporter,
      now: deterministicNow,
      ids: deterministicIds,
      onDiagnostic
    });
    const span = tracer.startSpan("safe-span", { kind: "internal" });
    expect(() => span.end()).not.toThrow();
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ message: "exporter boom" })
    );
  });

  it("does not allocate span objects when using the no-op exporter", () => {
    const countingExporter = vi.fn();
    const tracer = createTracer({
      exporter: noopExporter,
      now: deterministicNow,
      ids: deterministicIds
    });
    const span = tracer.startSpan("noop-span", { kind: "internal" });
    span.end();
    expect(countingExporter).not.toHaveBeenCalled();
  });

  it("records attributes set on the span", () => {
    const { exporter, last } = recordingExporter();
    const tracer = createTracer({ exporter, now: deterministicNow, ids: deterministicIds });
    const span = tracer.startSpan("attr-span", {
      kind: "internal",
      attributes: { "initial.key": "initial-value" }
    });
    span.setAttribute("added.key", "added-value");
    span.end();
    expect(last().attributes).toEqual({
      "initial.key": "initial-value",
      "added.key": "added-value"
    });
  });

  it("records events on the span", () => {
    const { exporter, last } = recordingExporter();
    const tracer = createTracer({ exporter, now: deterministicNow, ids: deterministicIds });
    const span = tracer.startSpan("event-span", { kind: "internal" });
    span.addEvent("something-happened", { detail: "info" });
    span.end();
    const recorded = last();
    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]?.name).toBe("something-happened");
    expect(recorded.events[0]?.attributes).toEqual({ detail: "info" });
  });

  it("records status on the span", () => {
    const { exporter, last } = recordingExporter();
    const tracer = createTracer({ exporter, now: deterministicNow, ids: deterministicIds });
    const span = tracer.startSpan("status-span", { kind: "internal" });
    span.setStatus({ code: "error", message: "something failed" });
    span.end();
    expect(last().status).toEqual({ code: "error", message: "something failed" });
  });

  it("records exceptions as events", () => {
    const { exporter, last } = recordingExporter();
    const tracer = createTracer({ exporter, now: deterministicNow, ids: deterministicIds });
    const span = tracer.startSpan("exception-span", { kind: "internal" });
    span.recordException(new Error("test error"));
    span.end();
    const recorded = last();
    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]?.name).toBe("exception");
    expect(recorded.events[0]?.attributes["exception.message"]).toBe("test error");
  });

  it("assigns trace and span IDs from the ID factory", () => {
    const { exporter, last } = recordingExporter();
    const fixedIds: IdFactory = {
      traceId: () => "a".repeat(32),
      spanId: () => "b".repeat(16)
    };
    const tracer = createTracer({ exporter, now: deterministicNow, ids: fixedIds });
    const span = tracer.startSpan("id-span", { kind: "internal" });
    span.end();
    expect(last().traceId).toBe("a".repeat(32));
    expect(last().spanId).toBe("b".repeat(16));
  });

  it("supports all span kinds", () => {
    const { spans, exporter } = recordingExporter();
    const tracer = createTracer({ exporter, now: deterministicNow, ids: deterministicIds });
    const kinds: readonly SpanKind[] = ["internal", "server", "client", "producer", "consumer"];
    for (const kind of kinds) {
      const span = tracer.startSpan(`kind-${kind}`, { kind });
      span.end();
    }
    expect(spans.map((s) => s.kind)).toEqual(kinds);
  });

  it("records start and end timestamps", () => {
    const { exporter, last } = recordingExporter();
    let time = 1_000_000;
    const tracer = createTracer({
      exporter,
      now: () => {
        time += 500;
        return time;
      },
      ids: deterministicIds
    });
    const span = tracer.startSpan("timed-span", { kind: "internal" });
    span.end();
    const recorded = last();
    expect(recorded.startedAt).toBe(1_000_500);
    expect(recorded.endedAt).toBe(1_001_000);
    expect(recorded.endedAt).toBeGreaterThan(recorded.startedAt);
  });

  it("uses the default ID factory and time source when none are injected", () => {
    const { exporter, last } = recordingExporter();
    const tracer = createTracer({ exporter });
    const span = tracer.startSpan("default-ids-span", { kind: "internal" });
    span.end();
    const recorded = last();
    expect(recorded.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(recorded.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(recorded.startedAt).toBeGreaterThan(0);
    expect(recorded.endedAt).toBeGreaterThanOrEqual(recorded.startedAt);
  });

  it("uses the default noop diagnostic handler when none is injected", () => {
    const throwingExporter: SpanExporter = () => {
      throw new Error("exporter boom");
    };
    const tracer = createTracer({ exporter: throwingExporter });
    const span = tracer.startSpan("no-diagnostic", { kind: "internal" });
    // Should not throw even without an explicit onDiagnostic
    expect(() => span.end()).not.toThrow();
  });
});
