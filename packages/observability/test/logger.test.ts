import { describe, expect, it, vi } from "vitest";

import {
  createLogger,
  type LogRecord,
  type LogSink,
  type LogSeverity
} from "../src/logger.js";
import { createCorrelation, withCorrelation, type IdFactory } from "../src/correlation.js";

const deterministicIds: IdFactory = {
  traceId: () => "a".repeat(32),
  spanId: () => "b".repeat(16)
};

const recordingSink = (): { readonly records: LogRecord[]; readonly sink: LogSink } => {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (record: LogRecord) => { records.push(record); }
  };
};

describe("structured logger", () => {
  it("records a log with severity and timestamp", () => {
    const { records, sink } = recordingSink();
    const logger = createLogger({ sink, now: () => 1_000_000 });
    logger.info("Hello, world");
    expect(records).toHaveLength(1);
    expect(records[0]?.severity).toBe("info");
    expect(records[0]?.message).toBe("Hello, world");
    expect(records[0]?.timestamp).toBe(1_000_000);
  });

  it("supports all severity levels", () => {
    const { records, sink } = recordingSink();
    const logger = createLogger({ sink, now: () => 1_000_000 });
    const levels: readonly LogSeverity[] = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      logger[level](`Log at ${level}`);
    }
    expect(records.map((r) => r.severity)).toEqual(levels);
  });

  it("carries trace and span IDs from the correlation context", () => {
    const { records, sink } = recordingSink();
    const logger = createLogger({ sink, now: () => 1_000_000 });
    const ctx = createCorrelation({ ids: deterministicIds });
    withCorrelation(ctx, () => {
      logger.info("correlated log");
    });
    expect(records[0]?.traceId).toBe("a".repeat(32));
    expect(records[0]?.spanId).toBe("b".repeat(16));
  });

  it("has no trace context when logged outside withCorrelation", () => {
    const { records, sink } = recordingSink();
    const logger = createLogger({ sink, now: () => 1_000_000 });
    logger.info("uncorrelated log");
    expect(records[0]?.traceId).toBeUndefined();
    expect(records[0]?.spanId).toBeUndefined();
  });

  it("records safe attributes on log records", () => {
    const { records, sink } = recordingSink();
    const logger = createLogger({ sink, now: () => 1_000_000 });
    logger.info("with attrs", { "http.method": "GET", "http.status": 200 });
    expect(records[0]?.attributes).toEqual({
      "http.method": "GET",
      "http.status": 200
    });
  });

  it("redacts a message containing credential material", () => {
    const { records, sink } = recordingSink();
    const logger = createLogger({ sink, now: () => 1_000_000 });
    const fakeToken = ["ghp", "a".repeat(36)].join("_");
    logger.info(`Token is ${fakeToken}`);
    expect(records[0]?.message).not.toContain(fakeToken);
    expect(records[0]?.redacted).toBe(true);
  });

  it("does not propagate a sink error", () => {
    const onDiagnostic = vi.fn();
    const throwingSink: LogSink = () => { throw new Error("sink boom"); };
    const logger = createLogger({
      sink: throwingSink,
      now: () => 1_000_000,
      onDiagnostic
    });
    expect(() => logger.info("safe log")).not.toThrow();
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
  });
});
