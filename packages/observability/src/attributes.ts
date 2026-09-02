/**
 * Safe attribute handling for observability spans and metrics.
 *
 * Reuses `containsSensitiveMaterial` from `@autostack/contracts` to
 * enforce the same redaction rules in telemetry data that govern the
 * rest of the system. No credential material may appear in any span
 * attribute, metric label, or log record.
 */

import { containsSensitiveMaterial } from "@autostack/contracts";

const MAX_ATTRIBUTE_VALUE_LENGTH = 4096;

export type AttributeValue = string | number | boolean | readonly string[];

export type Attributes = Readonly<Record<string, AttributeValue>>;

function validateValue(key: string, value: unknown): AttributeValue {
  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    if (containsSensitiveMaterial(value)) {
      throw new TypeError(
        `Attribute "${key}" contains credential material. Redact the value before attaching it.`
      );
    }
    if (value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      return value.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH - 11) + "[truncated]";
    }
    return value;
  }

  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        throw new TypeError(`Attribute "${key}" array contains a non-string element.`);
      }
      if (containsSensitiveMaterial(item)) {
        throw new TypeError(
          `Attribute "${key}" array contains credential material. Redact the value before attaching it.`
        );
      }
      result.push(item);
    }
    return Object.freeze(result);
  }

  throw new TypeError(
    `Attribute "${key}" has an unsupported value type. Expected string, number, boolean, or string[].`
  );
}

/**
 * Validates and freezes a map of span/metric attributes. Throws if any
 * key or value contains credential material, or if a value cannot be
 * safely serialized.
 */
export function safeAttributes(input: Readonly<Record<string, unknown>>): Attributes {
  const result: Record<string, AttributeValue> = Object.create(null) as Record<
    string,
    AttributeValue
  >;

  for (const key of Object.keys(input)) {
    if (containsSensitiveMaterial(key)) {
      throw new TypeError(
        `Attribute key "${key}" contains credential material. Redact the key before attaching it.`
      );
    }
    result[key] = validateValue(key, input[key]);
  }

  return Object.freeze(result);
}
