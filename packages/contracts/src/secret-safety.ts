import { z } from "zod";

const KNOWN_CREDENTIAL_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|xai)-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/g
] as const;

const normalizedSecrets = (values: readonly string[]): readonly string[] =>
  values.filter((value) => value.length >= 8).sort((left, right) => right.length - left.length);

export const redactSensitiveText = (
  value: string,
  sensitiveValues: readonly string[] = []
): string => {
  let redacted = value;
  for (const secret of normalizedSecrets(sensitiveValues)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  for (const pattern of KNOWN_CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
};

export const containsSensitiveMaterial = (
  value: string,
  sensitiveValues: readonly string[] = []
): boolean => redactSensitiveText(value, sensitiveValues) !== value;

export type SafeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SafeJsonValue[]
  | Readonly<{ [key: string]: SafeJsonValue }>;

export function normalizeSafeJson(
  value: unknown,
  sensitiveValues: readonly string[] = []
): SafeJsonValue {
  const active = new WeakSet<object>();
  const visit = (candidate: unknown, path: string): SafeJsonValue => {
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      if (containsSensitiveMaterial(candidate, sensitiveValues)) {
        throw new TypeError(`Sensitive material is not allowed at ${path}.`);
      }
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        throw new TypeError(`A finite number is required at ${path}.`);
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new TypeError(`A JSON-safe value is required at ${path}.`);
    }
    if (active.has(candidate)) throw new TypeError(`Cyclic JSON is not allowed at ${path}.`);
    const prototype = Object.getPrototypeOf(candidate) as object | null;
    const isArray = Array.isArray(candidate);
    if (isArray && prototype !== Array.prototype) {
      throw new TypeError(`A plain JSON array prototype is required at ${path}.`);
    }
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`A plain JSON object is required at ${path}.`);
    }
    active.add(candidate);
    let snapshot: SafeJsonValue;
    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw new TypeError(`A safe array length is required at ${path}.`);
      }
      const length = lengthDescriptor.value;
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key === "symbol") {
          throw new TypeError(`Symbol-keyed values are not allowed at ${path}.`);
        }
        if (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)) {
          throw new TypeError(`Non-JSON array properties are not allowed at ${path}.${key}.`);
        }
      }
      const result: SafeJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (descriptor === undefined) {
          throw new TypeError(`Sparse arrays are not allowed at ${path}[${index}].`);
        }
        if (!("value" in descriptor)) {
          throw new TypeError(`JSON accessors are not allowed at ${path}[${index}].`);
        }
        if (descriptor.enumerable !== true) {
          throw new TypeError(`Every JSON array item must be enumerable at ${path}[${index}].`);
        }
        result.push(visit(descriptor.value, `${path}[${index}]`));
      }
      snapshot = Object.freeze(result);
    } else {
      const result: Record<string, SafeJsonValue> = Object.create(null) as Record<
        string,
        SafeJsonValue
      >;
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key === "symbol") {
          throw new TypeError(`Symbol-keyed values are not allowed at ${path}.`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor?.enumerable !== true) {
          throw new TypeError(`Every JSON property must be enumerable at ${path}.${key}.`);
        }
        if (!("value" in descriptor)) {
          throw new TypeError(`JSON accessors are not allowed at ${path}.${key}.`);
        }
        if (containsSensitiveMaterial(key, sensitiveValues)) {
          throw new TypeError(`Sensitive material is not allowed in an object key at ${path}.`);
        }
        result[key] = visit(descriptor.value, `${path}.${key}`);
      }
      snapshot = Object.freeze(result);
    }
    active.delete(candidate);
    return snapshot;
  };
  return visit(value, "$");
}

export function assertSafeJson(value: unknown, sensitiveValues: readonly string[] = []): void {
  normalizeSafeJson(value, sensitiveValues);
}

export const SafeMetadataStringSchema = z
  .string()
  .min(1)
  .refine((value) => !containsSensitiveMaterial(value), "Raw credential material is forbidden.");
