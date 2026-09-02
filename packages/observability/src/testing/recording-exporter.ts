/**
 * A recording exporter that captures spans, logs, and metrics for
 * test assertions.
 */

import type { SpanExporter, SpanRecord } from "../tracer.js";
import type { LogRecord, LogSink } from "../logger.js";
import type { MetricRecord, MetricSink } from "../metrics.js";

export interface RecordingExporter {
  readonly spans: readonly SpanRecord[];
  readonly logs: readonly LogRecord[];
  readonly metrics: readonly MetricRecord[];
  readonly spanExporter: SpanExporter;
  readonly logSink: LogSink;
  readonly metricSink: MetricSink;
}

export function createRecordingExporter(): RecordingExporter {
  const spans: SpanRecord[] = [];
  const logs: LogRecord[] = [];
  const metrics: MetricRecord[] = [];

  return {
    spans,
    logs,
    metrics,
    spanExporter: (span: SpanRecord) => {
      spans.push(span);
    },
    logSink: (record: LogRecord) => {
      logs.push(record);
    },
    metricSink: (record: MetricRecord) => {
      metrics.push(record);
    }
  };
}
