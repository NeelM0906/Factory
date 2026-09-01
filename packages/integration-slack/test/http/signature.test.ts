import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SlackRequestError } from "../../src/errors.js";
import { verifySlackSignature } from "../../src/http/signature.js";

const SIGNING_SECRET = "test-signing-secret-value";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const sign = (timestamp: string, rawBody: Uint8Array, secret: string = SIGNING_SECRET): string => {
  const prefix = encode(`v0:${timestamp}:`);
  const base = new Uint8Array(prefix.length + rawBody.length);
  base.set(prefix, 0);
  base.set(rawBody, prefix.length);
  const hex = createHmac("sha256", secret).update(base).digest("hex");
  return `v0=${hex}`;
};

const NOW_MS = 1_700_000_000_000;
const now = (): number => NOW_MS;
const nowSeconds = Math.floor(NOW_MS / 1000);

describe("verifySlackSignature", () => {
  it("accepts a valid signature computed over the exact raw bytes", () => {
    const rawBody = encode('{"type":"event_callback","team_id":"T123"}');
    const timestampHeader = String(nowSeconds);
    const signatureHeader = sign(timestampHeader, rawBody);

    expect(() =>
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader,
        signingSecret: SIGNING_SECRET,
        now
      })
    ).not.toThrow();
  });

  it("rejects a body that was re-serialised after signing, even with identical content", () => {
    const original = encode(JSON.stringify({ b: 1, a: 2 }));
    const timestampHeader = String(nowSeconds);
    const signatureHeader = sign(timestampHeader, original);

    // Same logical payload, different key order and whitespace -> different raw bytes.
    const reserialized = encode(JSON.stringify({ a: 2, b: 1 }));

    expect(() =>
      verifySlackSignature({
        rawBody: reserialized,
        timestampHeader,
        signatureHeader,
        signingSecret: SIGNING_SECRET,
        now
      })
    ).toThrow(SlackRequestError);
  });

  it("passes at exactly the tolerance boundary in the past", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds - 300);
    const signatureHeader = sign(timestampHeader, rawBody);

    expect(() =>
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader,
        signingSecret: SIGNING_SECRET,
        now,
        toleranceSeconds: 300
      })
    ).not.toThrow();
  });

  it("rejects one second beyond the tolerance boundary in the past as replayed", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds - 301);
    const signatureHeader = sign(timestampHeader, rawBody);

    expect.assertions(2);
    try {
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader,
        signingSecret: SIGNING_SECRET,
        now,
        toleranceSeconds: 300
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("replayed");
    }
  });

  it("passes at exactly the tolerance boundary in the future", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds + 300);
    const signatureHeader = sign(timestampHeader, rawBody);

    expect(() =>
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader,
        signingSecret: SIGNING_SECRET,
        now,
        toleranceSeconds: 300
      })
    ).not.toThrow();
  });

  it("rejects one second beyond the tolerance boundary in the future as replayed (clock skew)", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds + 301);
    const signatureHeader = sign(timestampHeader, rawBody);

    expect.assertions(2);
    try {
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader,
        signingSecret: SIGNING_SECRET,
        now,
        toleranceSeconds: 300
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("replayed");
    }
  });

  it("rejects a missing timestamp header as signature_invalid", () => {
    const rawBody = encode("payload");
    const signatureHeader = sign(String(nowSeconds), rawBody);

    expect.assertions(2);
    try {
      verifySlackSignature({
        rawBody,
        timestampHeader: null,
        signatureHeader,
        signingSecret: SIGNING_SECRET,
        now
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("signature_invalid");
    }
  });

  it("rejects a missing signature header as signature_invalid", () => {
    const rawBody = encode("payload");

    expect.assertions(2);
    try {
      verifySlackSignature({
        rawBody,
        timestampHeader: String(nowSeconds),
        signatureHeader: null,
        signingSecret: SIGNING_SECRET,
        now
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("signature_invalid");
    }
  });

  it("rejects a v1= prefixed signature as signature_invalid", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds);
    const validHex = sign(timestampHeader, rawBody).slice(3);

    expect.assertions(2);
    try {
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader: `v1=${validHex}`,
        signingSecret: SIGNING_SECRET,
        now
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("signature_invalid");
    }
  });

  it("rejects a non-hex signature body as signature_invalid", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds);

    expect.assertions(2);
    try {
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader: `v0=${"z".repeat(64)}`,
        signingSecret: SIGNING_SECRET,
        now
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("signature_invalid");
    }
  });

  it("rejects a signature computed with the wrong signing secret as signature_invalid", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds);
    const signatureHeader = sign(timestampHeader, rawBody, "a-different-signing-secret");

    expect.assertions(2);
    try {
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader,
        signingSecret: SIGNING_SECRET,
        now
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("signature_invalid");
    }
  });

  it("uses a length pre-check before crypto.timingSafeEqual, so a short signature fails cleanly", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds);

    expect.assertions(2);
    try {
      // Deliberately shorter than the 32-byte sha256 digest, which would make
      // Buffers of unequal length; timingSafeEqual throws on that, so
      // verifySlackSignature must pre-check length and turn it into a clean rejection.
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader: "v0=abc123",
        signingSecret: SIGNING_SECRET,
        now
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      expect((error as SlackRequestError).code).toBe("signature_invalid");
    }
  });

  it("produces the identical message for every signature failure mode, regardless of which check failed", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds);
    const validHex = sign(timestampHeader, rawBody).slice(3);

    const scenarios: Array<() => void> = [
      () =>
        verifySlackSignature({
          rawBody,
          timestampHeader: null,
          signatureHeader: `v0=${validHex}`,
          signingSecret: SIGNING_SECRET,
          now
        }),
      () =>
        verifySlackSignature({
          rawBody,
          timestampHeader,
          signatureHeader: null,
          signingSecret: SIGNING_SECRET,
          now
        }),
      () =>
        verifySlackSignature({
          rawBody,
          timestampHeader,
          signatureHeader: `v1=${validHex}`,
          signingSecret: SIGNING_SECRET,
          now
        }),
      () =>
        verifySlackSignature({
          rawBody,
          timestampHeader,
          signatureHeader: `v0=${"z".repeat(64)}`,
          signingSecret: SIGNING_SECRET,
          now
        }),
      () =>
        verifySlackSignature({
          rawBody,
          timestampHeader,
          signatureHeader: "v0=abc123",
          signingSecret: SIGNING_SECRET,
          now
        }),
      () =>
        verifySlackSignature({
          rawBody,
          timestampHeader,
          signatureHeader: sign(timestampHeader, rawBody, "wrong-secret"),
          signingSecret: SIGNING_SECRET,
          now
        })
    ];

    const messages = scenarios.map((scenario) => {
      try {
        scenario();
        throw new Error("expected scenario to throw a SlackRequestError");
      } catch (error) {
        expect(error).toBeInstanceOf(SlackRequestError);
        return (error as SlackRequestError).message;
      }
    });

    const [first, ...rest] = messages;
    for (const message of rest) {
      expect(message).toBe(first);
    }
  });

  it("never includes the signing secret in a thrown error", () => {
    const rawBody = encode("payload");
    const timestampHeader = String(nowSeconds);
    const secret = "a-very-secret-signing-value-12345";

    expect.assertions(2);
    try {
      verifySlackSignature({
        rawBody,
        timestampHeader,
        signatureHeader: `v0=${"0".repeat(64)}`,
        signingSecret: secret,
        now
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackRequestError);
      const serialized = `${(error as SlackRequestError).message}${JSON.stringify(error)}`;
      expect(serialized).not.toContain(secret);
    }
  });
});
