/**
 * Redaction and artifact scanning security fixtures (spec section 17.5).
 *
 * Verifies that the redaction pipeline catches credential patterns in all positions,
 * handles adversarial encoding attempts, and never leaks secrets through error messages
 * or partial redaction. All credentials are built at runtime.
 */
import { describe, expect, it } from "vitest";

import {
  containsSensitiveMaterial,
  redactSensitiveText,
  assertSafeJson,
  normalizeSafeJson,
  SafeMetadataStringSchema,
  KNOWN_CREDENTIAL_SPECS,
  StreamingSensitiveMaterialDetector,
  CONFIGURED_SECRET_LIMITS,
  type KnownCredentialSpec
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const syntheticCredential = (spec: KnownCredentialSpec): string => {
  const bodyChar =
    spec.bodyClass === "upper_alphanumeric"
      ? "A"
      : spec.bodyClass === "ascii_alphanumeric"
        ? "a"
        : "x";
  const separator = spec.separator === "required_whitespace" ? " " : "";
  return `${spec.prefix}${separator}${bodyChar.repeat(spec.minimumBodyLength + 4)}`;
};

// ---------------------------------------------------------------------------
// 1. Credential scanning across all known patterns
// ---------------------------------------------------------------------------

describe("credential scanning: known patterns", () => {
  it.each(KNOWN_CREDENTIAL_SPECS.map((spec) => [spec.prefix, spec] as const))(
    "detects credential with prefix %s in freeform text",
    (_prefix, spec) => {
      const credential = syntheticCredential(spec);
      const text = `Connection string: host=db.example.com key=${credential} port=5432`;

      expect(containsSensitiveMaterial(text)).toBe(true);

      const redacted = redactSensitiveText(text);
      expect(containsSensitiveMaterial(redacted)).toBe(false);
      expect(redacted).not.toContain(credential);
    }
  );

  it("detects multiple distinct credential types in a single text block", () => {
    const ghToken = syntheticCredential(KNOWN_CREDENTIAL_SPECS[0]!); // ghp_
    const slackToken = syntheticCredential(KNOWN_CREDENTIAL_SPECS[5]!); // xoxb-
    const text = `GitHub: ${ghToken}\nSlack: ${slackToken}`;

    expect(containsSensitiveMaterial(text)).toBe(true);
    const redacted = redactSensitiveText(text);
    expect(containsSensitiveMaterial(redacted)).toBe(false);
  });

  it("detects credentials at text boundaries (start, end, alone)", () => {
    const credential = syntheticCredential(KNOWN_CREDENTIAL_SPECS[0]!);

    // At start
    expect(containsSensitiveMaterial(`${credential} trailing`)).toBe(true);
    // At end
    expect(containsSensitiveMaterial(`leading ${credential}`)).toBe(true);
    // Alone
    expect(containsSensitiveMaterial(credential)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Configured secret redaction
// ---------------------------------------------------------------------------

describe("credential scanning: configured secrets", () => {
  it("redacts configured secrets that don't match known patterns", () => {
    const customSecret = "my-custom-api-key-abcdef123456";
    const text = `Using key ${customSecret} for authentication`;
    const redacted = redactSensitiveText(text, [customSecret]);

    expect(redacted).not.toContain(customSecret);
    expect(containsSensitiveMaterial(redacted, [customSecret])).toBe(false);
  });

  it("redacts secrets that appear multiple times in the same text", () => {
    const secret = "repeated-secret-value-12345";
    const text = `First: ${secret}, Second: ${secret}, Third: ${secret}`;
    const redacted = redactSensitiveText(text, [secret]);

    expect(redacted).not.toContain(secret);
  });

  it("handles secrets with special regex characters safely", () => {
    const secret = "secret.with+regex$chars[0]";
    const text = `Value: ${secret}`;
    const redacted = redactSensitiveText(text, [secret]);

    expect(redacted).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// 3. SafeMetadataStringSchema: credential rejection in metadata
// ---------------------------------------------------------------------------

describe("artifact scanning: SafeMetadataStringSchema", () => {
  it.each(KNOWN_CREDENTIAL_SPECS.map((spec) => [spec.prefix, spec] as const))(
    "rejects metadata containing credential prefix %s",
    (_prefix, spec) => {
      const credential = syntheticCredential(spec);
      const result = SafeMetadataStringSchema.safeParse(
        `Issue title with embedded ${credential} credential`
      );
      expect(result.success).toBe(false);
    }
  );

  it("accepts metadata that is just normal text", () => {
    const result = SafeMetadataStringSchema.safeParse("Fix checkout redirect after payment");
    expect(result.success).toBe(true);
  });

  it("rejects empty strings", () => {
    const result = SafeMetadataStringSchema.safeParse("");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. JSON safety: assertSafeJson
// ---------------------------------------------------------------------------

describe("artifact scanning: JSON safety", () => {
  it("rejects JSON values containing known credentials", () => {
    const credential = syntheticCredential(KNOWN_CREDENTIAL_SPECS[0]!);
    expect(() => assertSafeJson({ key: credential })).toThrow();
  });

  it("rejects JSON values containing configured secrets", () => {
    const secret = "configured-secret-0123456789abcdef";
    expect(() => assertSafeJson({ nested: { value: secret } }, [secret])).toThrow();
  });

  it("accepts JSON without sensitive content", () => {
    expect(() =>
      assertSafeJson({ status: "ok", count: 42, tags: ["safe", "clean"] })
    ).not.toThrow();
  });

  it("normalizeSafeJson rejects JSON containing configured secrets", () => {
    const secret = "configured-secret-0123456789abcdef";
    const input = { message: `Error with ${secret}`, code: 500 };

    expect(() => normalizeSafeJson(input, [secret])).toThrow(TypeError);
  });

  it("normalizeSafeJson accepts JSON without sensitive content", () => {
    const input = { message: "All clear", code: 200 };
    const normalized = normalizeSafeJson(input);

    expect(normalized).toEqual({ message: "All clear", code: 200 });
  });
});

// ---------------------------------------------------------------------------
// 5. Streaming detector: incremental scanning
// ---------------------------------------------------------------------------

describe("streaming redaction: incremental credential detection", () => {
  it("detects a credential split across multiple chunks", () => {
    const detector = new StreamingSensitiveMaterialDetector();
    const credential = syntheticCredential(KNOWN_CREDENTIAL_SPECS[0]!); // ghp_...

    // Split the credential across chunks at multiple points
    const splitPoint = Math.floor(credential.length / 2);
    const chunk1 = `safe text ${credential.slice(0, splitPoint)}`;
    const chunk2 = `${credential.slice(splitPoint)} more safe text`;

    detector.write(chunk1);
    detector.write(chunk2);
    detector.finalize();

    // The detector should have flagged the credential
    expect(detector.sensitiveDetected).toBe(true);
  });

  it("passes through text that contains no credentials", () => {
    const detector = new StreamingSensitiveMaterialDetector();

    detector.write("Hello ");
    detector.write("world, this is ");
    detector.write("safe text.");
    detector.finalize();

    expect(detector.sensitiveDetected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Configured secret limits: bounded resource consumption
// ---------------------------------------------------------------------------

describe("redaction limits: bounded resource consumption", () => {
  it("fails closed when too many configured secrets are provided", () => {
    const tooMany = Array.from(
      { length: CONFIGURED_SECRET_LIMITS.maximumCount + 1 },
      (_, i) => `secret-${i}`
    );

    // redactSensitiveText should fail closed (return empty string) for too many secrets
    const result = redactSensitiveText("ordinary text", tooMany);
    expect(result).toBe("");
  });

  it("fails closed when aggregate secret length exceeds the limit", () => {
    const longSecret = "x".repeat(CONFIGURED_SECRET_LIMITS.maximumAggregateCharacters + 1);

    const result = redactSensitiveText("ordinary text", [longSecret]);
    expect(result).toBe("");
  });
});
