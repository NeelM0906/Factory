/**
 * W3C Trace Context correlation propagation.
 *
 * Parses and serializes `traceparent` headers. Provides synchronous
 * context propagation via `withCorrelation` — no async hooks, no
 * ambient globals beyond the module-level stack variable.
 */

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

export interface TraceparentFields {
  readonly version: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

export interface CorrelationContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
}

export interface IdFactory {
  readonly traceId: () => string;
  readonly spanId: () => string;
}

const randomHex = (bytes: number): string => {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
};

const defaultIds: IdFactory = {
  traceId: () => randomHex(16),
  spanId: () => randomHex(8)
};

export function parseTraceparent(header: string): TraceparentFields | null {
  const match = TRACEPARENT_RE.exec(header);
  if (match === null) return null;

  const [, version, traceId, spanId, flagsHex] = match as unknown as [
    string,
    string,
    string,
    string,
    string
  ];

  // Reject version ff (invalid) per spec
  if (version === "ff") return null;

  // Reject all-zero IDs per spec
  if (traceId === ALL_ZERO_TRACE) return null;
  if (spanId === ALL_ZERO_SPAN) return null;

  return {
    version,
    traceId,
    spanId,
    traceFlags: parseInt(flagsHex, 16)
  };
}

export function serializeTraceparent(fields: TraceparentFields): string {
  const flags = fields.traceFlags.toString(16).padStart(2, "0");
  return `${fields.version}-${fields.traceId}-${fields.spanId}-${flags}`;
}

export interface CreateCorrelationOptions {
  readonly parent?: TraceparentFields | CorrelationContext;
  readonly ids?: IdFactory;
}

export function createCorrelation(options: CreateCorrelationOptions = {}): CorrelationContext {
  const ids = options.ids ?? defaultIds;
  const parent = options.parent;

  if (parent !== undefined) {
    return {
      traceId: parent.traceId,
      spanId: ids.spanId(),
      parentSpanId: parent.spanId
    };
  }

  return {
    traceId: ids.traceId(),
    spanId: ids.spanId(),
    parentSpanId: undefined
  };
}

// Synchronous context propagation — module-level stack variable.
let activeContext: CorrelationContext | undefined;

export function currentCorrelation(): CorrelationContext | undefined {
  return activeContext;
}

export function withCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  const previous = activeContext;
  activeContext = context;
  try {
    return fn();
  } finally {
    activeContext = previous;
  }
}
