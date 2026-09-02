/**
 * Text boundary: the single place provider text becomes event text.
 *
 * Per D-4, redaction is applied per-field after JSON parse, never over the byte stream.
 * This module applies `redactCompleteText` from runner-local to each extracted string field
 * after parse, and truncates to the contract's per-field maximum AFTER redaction.
 *
 * An empty field after redaction is dropped (returns undefined) rather than emitted as an
 * empty string that `SafeMetadataStringSchema.min(1)` would reject.
 */

import { redactCompleteText } from "@autostack/runner-local";

const DEFAULT_MAX_BYTES = 100_000; // reasonable default per-field cap

export interface SanitizeOptions {
  /** Maximum byte length for the field after redaction. */
  readonly maxBytes?: number;
  /** Sensitive values for the redactor (in addition to built-in patterns). */
  readonly sensitiveValues?: readonly string[];
}

/**
 * Sanitize a single text field from provider output.
 *
 * Returns the sanitized text, or `undefined` if the field is empty or whitespace-only
 * after redaction (so it can be dropped rather than emitted as an invalid empty string).
 */
export const sanitizeTextField = (
  value: string,
  options?: SanitizeOptions
): string | undefined => {
  if (value.length === 0 || value.trim().length === 0) {
    return undefined;
  }

  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const sensitiveValues = options?.sensitiveValues ?? [];

  // Redact with the complete-text redactor (D-4: per-field, after parse)
  const { value: redacted } = redactCompleteText(value, sensitiveValues);

  if (redacted.length === 0 || redacted.trim().length === 0) {
    return undefined;
  }

  // Truncate to byte limit AFTER redaction
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength > maxBytes) {
    // Truncate at a safe UTF-8 boundary
    const truncated = bytes.subarray(0, maxBytes);
    // Decode back, which handles partial multi-byte sequences gracefully
    return new TextDecoder("utf-8", { fatal: false }).decode(truncated) || undefined;
  }

  return redacted;
};
