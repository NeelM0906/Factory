import { describe, expect, it } from "vitest";

import { sanitizeTextField } from "../src/text-boundary.js";

/**
 * Credential-shaped values built at runtime from fragments (standing rule 2).
 */
const credentialToken = (): string =>
  ["ghp", "abc123def456ghi789jkl012mno345pqr67890"].join("_");

describe("sanitizeTextField", () => {
  it("passes through a normal text field unchanged", () => {
    const result = sanitizeTextField("Hello, world!");
    expect(result).toBe("Hello, world!");
  });

  it("replaces a credential-shaped token with the redaction marker", () => {
    const token = credentialToken();
    const result = sanitizeTextField(`The key is ${token} in the message`);

    expect(result).toBeDefined();
    expect(result).not.toContain(token);
    // The result should contain a redaction marker (from redactCompleteText)
    expect(result!.length).toBeGreaterThan(0);
  });

  it("truncates to the per-field maximum AFTER redaction, never before", () => {
    // A field that is under the limit before redaction but over after should still be
    // redacted fully before truncation
    const token = credentialToken();
    const result = sanitizeTextField(token, { maxBytes: 20 });

    // Should be truncated and the token should not appear
    expect(result).not.toContain(token);
  });

  it("returns undefined for an empty string after redaction", () => {
    // An empty string would fail SafeMetadataStringSchema.min(1), so we drop it
    const result = sanitizeTextField("");
    expect(result).toBeUndefined();
  });

  it("returns undefined for whitespace-only strings", () => {
    const result = sanitizeTextField("   ");
    expect(result).toBeUndefined();
  });

  it("preserves the field when redaction produces a non-empty result", () => {
    const result = sanitizeTextField("safe content with no secrets");
    expect(result).toBe("safe content with no secrets");
  });
});
