import { describe, expect, it } from "vitest";

import {
  createCorrelation,
  parseTraceparent,
  serializeTraceparent,
  withCorrelation,
  currentCorrelation,
  type CorrelationContext,
  type IdFactory
} from "../src/correlation.js";

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

describe("traceparent parsing and serialization", () => {
  it("round-trips a valid traceparent header", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const parsed = parseTraceparent(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe("00");
    expect(parsed!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parsed!.spanId).toBe("00f067aa0ba902b7");
    expect(parsed!.traceFlags).toBe(1);
    expect(serializeTraceparent(parsed!)).toBe(header);
  });

  it("rejects a header with the wrong version", () => {
    expect(parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
  });

  it("rejects a header with the wrong length", () => {
    expect(parseTraceparent("00-4bf92f3577b-00f067aa0ba902b7-01")).toBeNull();
  });

  it("rejects a header with an all-zero trace ID", () => {
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
  });

  it("rejects a header with an all-zero span ID", () => {
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull();
  });

  it("rejects a malformed header", () => {
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent("")).toBeNull();
  });
});

describe("correlation context", () => {
  it("creates a root correlation with a new trace ID", () => {
    const ctx = createCorrelation({ ids: deterministicIds });
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.parentSpanId).toBeUndefined();
  });

  it("creates a child that inherits the trace ID and records the parent span ID", () => {
    const parent = createCorrelation({ ids: deterministicIds });
    const child = createCorrelation({ parent, ids: deterministicIds });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).not.toBe(parent.spanId);
  });

  it("creates a child from a parsed traceparent", () => {
    const incoming = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const child = createCorrelation({ parent: incoming!, ids: deterministicIds });
    expect(child.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(child.parentSpanId).toBe("00f067aa0ba902b7");
  });
});

describe("withCorrelation", () => {
  it("makes the context available during execution", () => {
    const ctx = createCorrelation({ ids: deterministicIds });
    let captured: CorrelationContext | undefined;
    withCorrelation(ctx, () => {
      captured = currentCorrelation();
    });
    expect(captured).toBe(ctx);
  });

  it("restores the previous context after a normal return", () => {
    const outer = createCorrelation({ ids: deterministicIds });
    const inner = createCorrelation({ ids: deterministicIds });
    withCorrelation(outer, () => {
      expect(currentCorrelation()).toBe(outer);
      withCorrelation(inner, () => {
        expect(currentCorrelation()).toBe(inner);
      });
      expect(currentCorrelation()).toBe(outer);
    });
    expect(currentCorrelation()).toBeUndefined();
  });

  it("restores the previous context after a throw", () => {
    const ctx = createCorrelation({ ids: deterministicIds });
    try {
      withCorrelation(ctx, () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    expect(currentCorrelation()).toBeUndefined();
  });

  it("returns the value from the callback", () => {
    const ctx = createCorrelation({ ids: deterministicIds });
    const result = withCorrelation(ctx, () => 42);
    expect(result).toBe(42);
  });
});

describe("default ID factory", () => {
  it("creates a root correlation with random IDs when no factory is injected", () => {
    const ctx = createCorrelation();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.parentSpanId).toBeUndefined();
  });

  it("produces distinct IDs across calls", () => {
    const a = createCorrelation();
    const b = createCorrelation();
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
  });

  it("creates a child with the default span ID factory", () => {
    const parent = createCorrelation();
    const child = createCorrelation({ parent });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(child.spanId).not.toBe(parent.spanId);
  });
});
