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

export function assertSafeJson(value: unknown, sensitiveValues: readonly string[] = []): void {
  const active = new WeakSet<object>();
  const visit = (candidate: unknown, path: string): void => {
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "string") {
      if (containsSensitiveMaterial(candidate, sensitiveValues)) {
        throw new TypeError(`Sensitive material is not allowed at ${path}.`);
      }
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        throw new TypeError(`A finite number is required at ${path}.`);
      return;
    }
    if (typeof candidate !== "object") {
      throw new TypeError(`A JSON-safe value is required at ${path}.`);
    }
    if (active.has(candidate)) throw new TypeError(`Cyclic JSON is not allowed at ${path}.`);
    const prototype = Object.getPrototypeOf(candidate) as object | null;
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`A plain JSON object is required at ${path}.`);
    }
    active.add(candidate);
    if (Array.isArray(candidate)) {
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key === "symbol") {
          throw new TypeError(`Symbol-keyed values are not allowed at ${path}.`);
        }
        if (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)) {
          throw new TypeError(`Non-JSON array properties are not allowed at ${path}.${key}.`);
        }
      }
      for (let index = 0; index < candidate.length; index += 1) {
        if (!Object.hasOwn(candidate, index)) {
          throw new TypeError(`Sparse arrays are not allowed at ${path}[${index}].`);
        }
        visit(candidate[index], `${path}[${index}]`);
      }
    } else {
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
        visit(descriptor.value, `${path}.${key}`);
      }
    }
    active.delete(candidate);
  };
  visit(value, "$");
}

export const SafeMetadataStringSchema = z
  .string()
  .min(1)
  .refine((value) => !containsSensitiveMaterial(value), "Raw credential material is forbidden.");
