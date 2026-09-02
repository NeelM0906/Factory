/**
 * Metrics instruments with OTel-compatible semantics.
 *
 * Every attribute set goes through the same safeAttributes gate used
 * by spans. The instrument registry defines the complete set from the
 * spec; a test iterates it to prevent silent drift.
 */

import { safeAttributes, type Attributes } from "./attributes.js";

export type MetricKind = "counter" | "up_down_counter" | "histogram";

export interface MetricRecord {
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly attributes: Attributes;
  readonly timestamp: number;
}

export type MetricSink = (record: MetricRecord) => void;

export interface CounterInstrument {
  readonly add: (value: number, attributes?: Readonly<Record<string, unknown>>) => void;
}

export interface UpDownCounterInstrument {
  readonly add: (value: number, attributes?: Readonly<Record<string, unknown>>) => void;
}

export interface HistogramInstrument {
  readonly record: (value: number, attributes?: Readonly<Record<string, unknown>>) => void;
}

export interface Meter {
  readonly counter: (name: string) => CounterInstrument;
  readonly upDownCounter: (name: string) => UpDownCounterInstrument;
  readonly histogram: (name: string) => HistogramInstrument;
}

export interface CreateMeterOptions {
  readonly sink?: MetricSink;
  readonly now?: () => number;
}

export function createMeter(options: CreateMeterOptions = {}): Meter {
  const sink = options.sink ?? (() => {});
  const now = options.now ?? (() => Date.now());

  return {
    counter(name: string): CounterInstrument {
      return {
        add(value: number, attributes?: Readonly<Record<string, unknown>>) {
          if (value < 0) {
            throw new TypeError(
              `Counter "${name}" received a negative value (${value}). Use upDownCounter for decrements.`
            );
          }
          sink({
            name,
            kind: "counter",
            value,
            attributes: attributes !== undefined ? safeAttributes(attributes) : Object.freeze({}),
            timestamp: now()
          });
        }
      };
    },

    upDownCounter(name: string): UpDownCounterInstrument {
      return {
        add(value: number, attributes?: Readonly<Record<string, unknown>>) {
          sink({
            name,
            kind: "up_down_counter",
            value,
            attributes: attributes !== undefined ? safeAttributes(attributes) : Object.freeze({}),
            timestamp: now()
          });
        }
      };
    },

    histogram(name: string): HistogramInstrument {
      return {
        record(value: number, attributes?: Readonly<Record<string, unknown>>) {
          sink({
            name,
            kind: "histogram",
            value,
            attributes: attributes !== undefined ? safeAttributes(attributes) : Object.freeze({}),
            timestamp: now()
          });
        }
      };
    }
  };
}

const noopInstrument = {
  add: () => {},
  record: () => {}
};

export const noopMeter: Meter = {
  counter: () => noopInstrument,
  upDownCounter: () => noopInstrument,
  histogram: () => noopInstrument
};

/**
 * The complete instrument registry from spec section 16.1.
 * Format: name -> kind
 */
export const INSTRUMENT_REGISTRY: ReadonlyMap<string, MetricKind> = new Map<string, MetricKind>([
  ["autostack.run.count", "counter"],
  ["autostack.stage.latency", "histogram"],
  ["autostack.queue.wait", "histogram"],
  ["autostack.approval.wait", "histogram"],
  ["autostack.stage.retries", "counter"],
  ["autostack.model.success_rate", "histogram"],
  ["autostack.review.pass_rate", "histogram"],
  ["autostack.intervention.rate", "histogram"],
  ["autostack.tokens", "counter"],
  ["autostack.cost", "counter"],
  ["autostack.cost.per_pull_request", "histogram"],
  ["autostack.runner.provision", "counter"],
  ["autostack.runner.cleanup_health", "histogram"]
]);
