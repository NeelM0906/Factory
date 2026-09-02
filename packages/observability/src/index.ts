export {
  createCorrelation,
  currentCorrelation,
  parseTraceparent,
  serializeTraceparent,
  withCorrelation,
  type CorrelationContext,
  type CreateCorrelationOptions,
  type IdFactory,
  type TraceparentFields
} from "./correlation.js";

export { safeAttributes, type AttributeValue, type Attributes } from "./attributes.js";

export {
  createTracer,
  noopExporter,
  type CreateTracerOptions,
  type Span,
  type SpanEvent,
  type SpanExporter,
  type SpanKind,
  type SpanRecord,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer
} from "./tracer.js";

export { toOtlpSpan, type OtlpSpan } from "./otlp.js";

export {
  createMeter,
  noopMeter,
  INSTRUMENT_REGISTRY,
  type CounterInstrument,
  type CreateMeterOptions,
  type HistogramInstrument,
  type Meter,
  type MetricKind,
  type MetricRecord,
  type MetricSink,
  type UpDownCounterInstrument
} from "./metrics.js";

export {
  createLogger,
  type CreateLoggerOptions,
  type LogRecord,
  type LogSeverity,
  type LogSink,
  type Logger
} from "./logger.js";
