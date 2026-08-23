import type { SafeJsonValue } from "@autostack/contracts";
import { types as utilTypes } from "node:util";

export const GUARDIAN_OPERATION_TIMEOUT_MS = 100;
export const GUARDIAN_OBSERVER_TIMEOUT_MS = 2_000;
export const MAXIMUM_PROTOCOL_DEPTH = 32;
export const MAXIMUM_PROTOCOL_KEYS = 2_048;
export const MAXIMUM_PENDING_PROTOCOL_MESSAGES = 64;

const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Reflect.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength"
)?.get;
const typedArrayByteOffset = Reflect.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset"
)?.get;
const typedArrayBuffer = Reflect.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const arrayBufferByteLength = Reflect.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength"
)?.get;
const typedArraySet = Uint8Array.prototype.set;
const intrinsicPromisePrototype = Promise.prototype;
const intrinsicPromiseThen = Promise.prototype.then;

export class ByteSnapshotLimitError extends TypeError {
  constructor() {
    super("Guardian binary input exceeds its byte limit.");
    byteSnapshotLimitErrors.add(this);
  }
}

const byteSnapshotLimitErrors = new WeakSet<ByteSnapshotLimitError>();

export const isByteSnapshotLimitError = (error: unknown): error is ByteSnapshotLimitError =>
  typeof error === "object" &&
  error !== null &&
  byteSnapshotLimitErrors.has(error as ByteSnapshotLimitError);

export const admitIntrinsicPromise = <Value>(input: unknown): Promise<Value> => {
  if (
    !utilTypes.isPromise(input) ||
    utilTypes.isProxy(input) ||
    Reflect.getPrototypeOf(input) !== intrinsicPromisePrototype ||
    Reflect.getOwnPropertyDescriptor(input, "constructor") !== undefined
  ) {
    throw new TypeError("Guardian Promise authority is invalid.");
  }
  return input as Promise<Value>;
};

export const observeIntrinsicPromise = <Value, Fulfilled, Rejected>(
  input: unknown,
  onFulfilled: (value: Value) => Fulfilled | PromiseLike<Fulfilled>,
  onRejected: (reason: unknown) => Rejected | PromiseLike<Rejected>
): Promise<Fulfilled | Rejected> => {
  const admitted = admitIntrinsicPromise<Value>(input);
  return Reflect.apply(intrinsicPromiseThen, admitted, [onFulfilled, onRejected]) as Promise<
    Fulfilled | Rejected
  >;
};

export const settleBounded = async <Value>(
  operation: PromiseLike<Value> | Value,
  timeoutMs = GUARDIAN_OPERATION_TIMEOUT_MS
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TypeError("Guardian operation timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export type GuardianAbortableOutcome<Value> =
  | Readonly<{ readonly status: "completed"; readonly value: Value }>
  | Readonly<{ readonly status: "failed" }>
  | Readonly<{ readonly status: "timed_out"; readonly settled: Promise<void> }>;

export const runAbortableGuardianOperation = async <Value>(
  operation: (signal: AbortSignal) => PromiseLike<Value> | Value,
  timeoutMs = GUARDIAN_OPERATION_TIMEOUT_MS
): Promise<GuardianAbortableOutcome<Value>> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve()
    .then(async () => await operation(controller.signal))
    .then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const })
    );
  const timeout = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  const outcome = await Promise.race([pending, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if ("timedOut" in outcome) {
    return Object.freeze({ status: "timed_out", settled: pending.then(() => undefined) });
  }
  return outcome.ok
    ? Object.freeze({ status: "completed", value: outcome.value })
    : Object.freeze({ status: "failed" });
};

export const snapshotDataRecord = (
  input: unknown,
  maximumKeys = 128
): Readonly<Record<string, unknown>> => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    utilTypes.isProxy(input)
  ) {
    throw new TypeError("Guardian data record is invalid.");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Guardian data record is invalid.");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("Guardian data record is invalid.");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
};

export const captureGuardianMethod = (
  input: unknown,
  name: string,
  optional = false
): ((...args: never[]) => unknown) | undefined => {
  if (typeof input !== "object" || input === null || utilTypes.isProxy(input))
    throw new TypeError();
  let current: object | null = input;
  while (current !== null) {
    if (utilTypes.isProxy(current)) throw new TypeError();
    const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") throw new TypeError();
      const method = descriptor.value as (...args: never[]) => unknown;
      return (...args: never[]) => Reflect.apply(method, input, args);
    }
    current = Reflect.getPrototypeOf(current);
  }
  if (optional) return undefined;
  throw new TypeError();
};

export const snapshotBytes = (
  input: unknown,
  options: Readonly<{ readonly maximumBytes: number; readonly exactBytes?: number }>
): Uint8Array => {
  try {
    if (!utilTypes.isUint8Array(input) || utilTypes.isProxy(input)) {
      throw new TypeError();
    }
    if (
      typedArrayByteLength === undefined ||
      typedArrayByteOffset === undefined ||
      typedArrayBuffer === undefined ||
      arrayBufferByteLength === undefined
    ) {
      throw new TypeError();
    }
    const byteLength = Reflect.apply(typedArrayByteLength, input, []) as unknown;
    const byteOffset = Reflect.apply(typedArrayByteOffset, input, []) as unknown;
    const buffer = Reflect.apply(typedArrayBuffer, input, []) as unknown;
    const bufferByteLength = utilTypes.isArrayBuffer(buffer)
      ? (Reflect.apply(arrayBufferByteLength, buffer, []) as unknown)
      : undefined;
    if (
      !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < 0 ||
      (options.exactBytes !== undefined && byteLength !== options.exactBytes) ||
      !Number.isSafeInteger(byteOffset) ||
      (byteOffset as number) < 0 ||
      !utilTypes.isArrayBuffer(buffer) ||
      !Number.isSafeInteger(bufferByteLength) ||
      (byteOffset as number) + (byteLength as number) > (bufferByteLength as number)
    ) {
      throw new TypeError();
    }
    if ((byteLength as number) > options.maximumBytes) throw new ByteSnapshotLimitError();
    const snapshot = new Uint8Array(byteLength as number);
    Reflect.apply(typedArraySet, snapshot, [
      new Uint8Array(buffer as ArrayBuffer, byteOffset as number, byteLength as number)
    ]);
    return snapshot;
  } catch (error) {
    if (isByteSnapshotLimitError(error)) throw error;
    throw new TypeError("Guardian binary input is invalid.");
  }
};

export const snapshotSafeJson = (input: unknown, maximumBytes: number): SafeJsonValue => {
  let keys = 0;
  let encodedBytes = 0;
  const account = (value: string): void => {
    encodedBytes += Buffer.byteLength(value);
    if (encodedBytes > maximumBytes) throw new TypeError();
  };
  const visit = (value: unknown, depth: number): SafeJsonValue => {
    if (depth > MAXIMUM_PROTOCOL_DEPTH) throw new TypeError();
    if (value === null || typeof value === "boolean") {
      account(value === null ? "null" : String(value));
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError();
      account(JSON.stringify(value));
      return value;
    }
    if (typeof value === "string") {
      account(JSON.stringify(value));
      return value;
    }
    if (typeof value !== "object") throw new TypeError();
    if (utilTypes.isProxy(value)) throw new TypeError();
    if (Array.isArray(value)) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      const length =
        lengthDescriptor !== undefined && "value" in lengthDescriptor
          ? (lengthDescriptor.value as unknown)
          : undefined;
      if (!Number.isSafeInteger(length) || (length as number) > MAXIMUM_PROTOCOL_KEYS - keys) {
        throw new TypeError();
      }
      keys += length as number;
      account("[]" + ",".repeat(Math.max(0, (length as number) - 1)));
      const result: SafeJsonValue[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new TypeError();
        }
        result.push(visit(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string") ||
      ownKeys.length > MAXIMUM_PROTOCOL_KEYS - keys
    ) {
      throw new TypeError();
    }
    keys += ownKeys.length;
    account("{}" + ",".repeat(Math.max(0, ownKeys.length - 1)));
    const result: Record<string, SafeJsonValue> = Object.create(null) as Record<
      string,
      SafeJsonValue
    >;
    for (const key of ownKeys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new TypeError();
      }
      account(JSON.stringify(key) + ":");
      result[key] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  };
  try {
    return visit(input, 0);
  } catch {
    throw new TypeError("Guardian JSON input is invalid.");
  }
};
