import { describe, expect, it } from "vitest";

import {
  createMeter,
  noopMeter,
  INSTRUMENT_REGISTRY,
  type CounterInstrument,
  type HistogramInstrument,
  type MetricRecord,
  type MetricSink
} from "../src/metrics.js";

const recordingSink = (): { readonly records: MetricRecord[]; readonly sink: MetricSink } => {
  const records: MetricRecord[] = [];
  return {
    records,
    sink: (record: MetricRecord) => { records.push(record); }
  };
};

describe("counter", () => {
  it("records a monotonic increment", () => {
    const { records, sink } = recordingSink();
    const meter = createMeter({ sink });
    const counter = meter.counter("test.counter");
    counter.add(1, { "service": "web" });
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("test.counter");
    expect(records[0]?.kind).toBe("counter");
    expect(records[0]?.value).toBe(1);
    expect(records[0]?.attributes).toEqual({ "service": "web" });
  });

  it("throws on a negative counter value", () => {
    const { sink } = recordingSink();
    const meter = createMeter({ sink });
    const counter = meter.counter("test.counter");
    expect(() => counter.add(-1)).toThrow(/negative/i);
  });
});

describe("up-down counter", () => {
  it("accepts both positive and negative values", () => {
    const { records, sink } = recordingSink();
    const meter = createMeter({ sink });
    const upDown = meter.upDownCounter("test.up_down");
    upDown.add(5);
    upDown.add(-3);
    expect(records).toHaveLength(2);
    expect(records[0]?.value).toBe(5);
    expect(records[1]?.value).toBe(-3);
  });
});

describe("histogram", () => {
  it("records a measurement", () => {
    const { records, sink } = recordingSink();
    const meter = createMeter({ sink });
    const histogram = meter.histogram("test.histogram");
    histogram.record(42.5, { "unit": "ms" });
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("histogram");
    expect(records[0]?.value).toBe(42.5);
  });
});

describe("attribute safety on metrics", () => {
  it("passes attributes through the safety gate", () => {
    const { sink } = recordingSink();
    const meter = createMeter({ sink });
    const counter = meter.counter("test.counter");
    const fakeToken = ["ghp", "a".repeat(36)].join("_");
    expect(() =>
      counter.add(1, { "token": fakeToken })
    ).toThrow(/redact/i);
  });
});

describe("noop meter", () => {
  it("records nothing", () => {
    const counter = noopMeter.counter("noop.counter");
    counter.add(1);
    // No assertion beyond not throwing — the noop meter discards everything
    const upDown = noopMeter.upDownCounter("noop.up_down");
    upDown.add(-1);
    const histogram = noopMeter.histogram("noop.histogram");
    histogram.record(42);
  });
});

describe("instrument registry", () => {
  const EXPECTED_INSTRUMENTS = [
    "autostack.run.count",
    "autostack.stage.latency",
    "autostack.queue.wait",
    "autostack.approval.wait",
    "autostack.stage.retries",
    "autostack.model.success_rate",
    "autostack.review.pass_rate",
    "autostack.intervention.rate",
    "autostack.tokens",
    "autostack.cost",
    "autostack.cost.per_pull_request",
    "autostack.runner.provision",
    "autostack.runner.cleanup_health"
  ] as const;

  it("registers every instrument from the spec", () => {
    for (const name of EXPECTED_INSTRUMENTS) {
      expect(INSTRUMENT_REGISTRY.has(name)).toBe(true);
    }
  });

  it("has exactly the expected number of instruments", () => {
    expect(INSTRUMENT_REGISTRY.size).toBe(EXPECTED_INSTRUMENTS.length);
  });
});
