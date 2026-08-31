import { describe, expect, it } from "vitest";

import { signGitHubPayload } from "../fixtures/webhooks/sign.js";
import { GitHubSignatureError, verifyGitHubSignature } from "../../src/webhook/signature.js";

const SECRET = "test-webhook-secret-value";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("verifyGitHubSignature", () => {
  it("accepts a signature computed over the exact raw bytes", () => {
    const rawBody = encode('{"action":"opened","issue":{"number":42}}');
    const signatureHeader = signGitHubPayload(rawBody, SECRET);

    expect(() => verifyGitHubSignature({ rawBody, signatureHeader, secret: SECRET })).not.toThrow();
  });

  // Rejects an implementation that re-serialises the parsed JSON before verifying instead of
  // hashing the exact received bytes. Signing the original bytes and then feeding a
  // re-`JSON.stringify`d (different key order, no whitespace) version of the *same logical
  // object* through verification must fail: only a raw-bytes comparison can distinguish them,
  // since a re-encode-and-verify implementation would treat both as identical and pass.
  it("rejects a body that was re-serialised after signing, even with identical logical content", () => {
    const original = encode(
      JSON.stringify({ action: "opened", issue: { number: 42, title: "x" } })
    );
    const signatureHeader = signGitHubPayload(original, SECRET);

    const reserialized = encode(
      JSON.stringify({ issue: { title: "x", number: 42 }, action: "opened" })
    );

    expect(() =>
      verifyGitHubSignature({ rawBody: reserialized, signatureHeader, secret: SECRET })
    ).toThrow(GitHubSignatureError);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const rawBody = encode("payload");
    const signatureHeader = signGitHubPayload(rawBody, "a-different-secret");

    expect(() => verifyGitHubSignature({ rawBody, signatureHeader, secret: SECRET })).toThrow(
      GitHubSignatureError
    );
  });

  // Rejects an implementation that omits the length pre-check before `crypto.timingSafeEqual`.
  // `timingSafeEqual` throws a native `RangeError` on unequal-length buffers, so an
  // implementation missing the pre-check would let a `RangeError` escape here instead of the
  // uniform `GitHubSignatureError` this module promises for every failure mode. Asserting
  // `toThrow(GitHubSignatureError)` (an instanceof check) is what catches that: a `RangeError`
  // is not an instance of `GitHubSignatureError`, so the assertion fails against the buggy
  // implementation and passes only against one with the pre-check in place.
  it("rejects a truncated signature as a clean GitHubSignatureError, not a RangeError", () => {
    const rawBody = encode("payload");
    const fullSignature = signGitHubPayload(rawBody, SECRET);
    const truncated = fullSignature.slice(0, "sha256=".length + 8);

    expect(() =>
      verifyGitHubSignature({ rawBody, signatureHeader: truncated, secret: SECRET })
    ).toThrow(GitHubSignatureError);
  });

  it("rejects a missing signature header", () => {
    expect(() =>
      verifyGitHubSignature({ rawBody: encode("payload"), signatureHeader: null, secret: SECRET })
    ).toThrow(GitHubSignatureError);
  });

  it("rejects an sha1= prefixed header", () => {
    const rawBody = encode("payload");
    const validHex = signGitHubPayload(rawBody, SECRET).slice("sha256=".length);

    expect(() =>
      verifyGitHubSignature({ rawBody, signatureHeader: `sha1=${validHex}`, secret: SECRET })
    ).toThrow(GitHubSignatureError);
  });

  it("rejects a non-hex signature body", () => {
    const rawBody = encode("payload");

    expect(() =>
      verifyGitHubSignature({
        rawBody,
        signatureHeader: `sha256=${"z".repeat(64)}`,
        secret: SECRET
      })
    ).toThrow(GitHubSignatureError);
  });

  it("rejects a well-formed signature computed over a different, non-empty body when the raw body is empty", () => {
    const signatureHeader = signGitHubPayload(encode("not-empty"), SECRET);

    expect(() =>
      verifyGitHubSignature({ rawBody: encode(""), signatureHeader, secret: SECRET })
    ).toThrow(GitHubSignatureError);
  });

  it("throws exactly one uniform message and no other property across every failure mode", () => {
    const rawBody = encode("payload");
    const wrongSecretHeader = signGitHubPayload(rawBody, "a-different-secret");
    const validHex = signGitHubPayload(rawBody, SECRET).slice("sha256=".length);

    const failureInputs: ReadonlyArray<{ rawBody: Uint8Array; signatureHeader: string | null }> = [
      { rawBody, signatureHeader: null },
      { rawBody, signatureHeader: `sha1=${validHex}` },
      { rawBody, signatureHeader: `sha256=${"z".repeat(64)}` },
      { rawBody, signatureHeader: wrongSecretHeader },
      { rawBody, signatureHeader: `sha256=${validHex.slice(0, 8)}` }
    ];

    const messages = failureInputs.map((input) => {
      let caught: unknown;
      try {
        verifyGitHubSignature({
          rawBody: input.rawBody,
          signatureHeader: input.signatureHeader,
          secret: SECRET
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitHubSignatureError);
      return (caught as GitHubSignatureError).message;
    });

    expect(new Set(messages).size).toBe(1);
  });

  it("never includes the secret in the thrown error", () => {
    const rawBody = encode("payload");
    let caught: unknown;
    try {
      verifyGitHubSignature({ rawBody, signatureHeader: null, secret: SECRET });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubSignatureError);
    const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
    expect(serialized.includes(SECRET)).toBe(false);
  });
});
