/**
 * Webhook replay and signature failure security fixtures (spec section 17.5).
 *
 * Tests adversarial webhook scenarios: replay attacks, signature manipulation,
 * timing oracle prevention, and delivery deduplication under adversarial conditions.
 */
import { describe, expect, it } from "vitest";

import { signGitHubPayload } from "../fixtures/webhooks/sign.js";
import {
  GitHubSignatureError,
  verifyGitHubSignature
} from "../../src/webhook/signature.js";
import { createDeliveryReplayGuard } from "../../src/webhook/replay-guard.js";

const SECRET = "test-webhook-secret-value";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// 1. Signature manipulation attacks
// ---------------------------------------------------------------------------

describe("webhook security: signature manipulation", () => {
  it("rejects a signature with correct HMAC but wrong algorithm prefix", () => {
    const rawBody = encode('{"action":"opened"}');
    const validSig = signGitHubPayload(rawBody, SECRET);
    const hex = validSig.slice("sha256=".length);

    // Try various wrong prefixes
    for (const prefix of ["sha1=", "sha512=", "md5=", "hmac-sha256=", "SHA256=", ""]) {
      expect(() =>
        verifyGitHubSignature({ rawBody, signatureHeader: `${prefix}${hex}`, secret: SECRET })
      ).toThrow(GitHubSignatureError);
    }
  });

  it("rejects a signature with extra trailing bytes appended", () => {
    const rawBody = encode('{"action":"opened"}');
    const validSig = signGitHubPayload(rawBody, SECRET);

    expect(() =>
      verifyGitHubSignature({
        rawBody,
        signatureHeader: `${validSig}deadbeef`,
        secret: SECRET
      })
    ).toThrow(GitHubSignatureError);
  });

  it("rejects an empty string signature header", () => {
    const rawBody = encode('{"action":"opened"}');

    expect(() =>
      verifyGitHubSignature({ rawBody, signatureHeader: "", secret: SECRET })
    ).toThrow(GitHubSignatureError);
  });

  it("rejects uppercase hex in the signature", () => {
    const rawBody = encode('{"action":"opened"}');
    const validSig = signGitHubPayload(rawBody, SECRET);
    const upperSig = validSig.toUpperCase();

    // sha256= prefix is lowercase in the real protocol; if uppercased, it should fail
    expect(() =>
      verifyGitHubSignature({ rawBody, signatureHeader: upperSig, secret: SECRET })
    ).toThrow(GitHubSignatureError);
  });

  it("produces a uniform error message across all failure modes (no oracle)", () => {
    const rawBody = encode("test-body");
    const validHex = signGitHubPayload(rawBody, SECRET).slice("sha256=".length);

    const failureCases = [
      null, // missing
      "", // empty
      "sha1=" + validHex, // wrong algorithm
      "sha256=" + "z".repeat(64), // non-hex
      "sha256=" + validHex.slice(0, 8), // truncated
      signGitHubPayload(rawBody, "wrong-secret"), // wrong secret
      "sha256=" + validHex + "ff", // extended
      "sha256=" + validHex.split("").reverse().join("") // reversed
    ];

    const messages = new Set<string>();
    for (const sig of failureCases) {
      try {
        verifyGitHubSignature({ rawBody, signatureHeader: sig, secret: SECRET });
      } catch (error) {
        expect(error).toBeInstanceOf(GitHubSignatureError);
        messages.add((error as Error).message);
      }
    }

    // All failure modes produce the same message (no timing/oracle distinguishability)
    expect(messages.size).toBe(1);
  });

  it("never leaks the webhook secret in any error property", () => {
    const rawBody = encode("payload");
    const failures = [
      null,
      "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      signGitHubPayload(rawBody, "different-secret")
    ];

    for (const sig of failures) {
      try {
        verifyGitHubSignature({ rawBody, signatureHeader: sig, secret: SECRET });
      } catch (error) {
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error as object));
        expect(serialized).not.toContain(SECRET);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Replay attack scenarios
// ---------------------------------------------------------------------------

describe("webhook security: replay attacks", () => {
  it("blocks exact replay of the same delivery id", () => {
    const guard = createDeliveryReplayGuard();

    expect(guard.seen("delivery-abc-123")).toBe(false); // first time
    expect(guard.seen("delivery-abc-123")).toBe(true); // replay
    expect(guard.seen("delivery-abc-123")).toBe(true); // second replay
  });

  it("handles rapid-fire replays of many distinct ids without crashing", () => {
    const guard = createDeliveryReplayGuard({ capacity: 100 });

    for (let i = 0; i < 200; i++) {
      guard.seen(`rapid-fire-${i}`);
    }

    // Recent ids are remembered
    expect(guard.seen("rapid-fire-199")).toBe(true);
    // Oldest ids were evicted (FIFO)
    expect(guard.seen("rapid-fire-0")).toBe(false);
  });

  it("evicts oldest entries under capacity pressure (FIFO)", () => {
    const guard = createDeliveryReplayGuard({ capacity: 3 });

    // Insert three ids to fill capacity
    guard.seen("id-a");
    guard.seen("id-b");
    guard.seen("id-c");

    // Push past capacity: this evicts id-a (oldest insertion)
    guard.seen("id-d");

    // id-a was evicted (oldest), so it reports as unseen
    expect(guard.seen("id-a")).toBe(false);
    // id-d is still within capacity
    expect(guard.seen("id-d")).toBe(true);
  });

  it("treats empty-string delivery id as a valid key", () => {
    const guard = createDeliveryReplayGuard();

    expect(guard.seen("")).toBe(false);
    expect(guard.seen("")).toBe(true);
  });

  it("treats delivery ids that differ only in case as distinct", () => {
    const guard = createDeliveryReplayGuard();

    expect(guard.seen("Delivery-ABC")).toBe(false);
    expect(guard.seen("delivery-abc")).toBe(false);
    expect(guard.seen("DELIVERY-ABC")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Signature + replay combined scenario
// ---------------------------------------------------------------------------

describe("webhook security: combined signature and replay defence", () => {
  it("a valid signature on a replayed delivery id is still caught by the replay guard", () => {
    const guard = createDeliveryReplayGuard();
    const rawBody = encode('{"action":"opened","issue":{"number":1}}');
    const signature = signGitHubPayload(rawBody, SECRET);

    // First delivery: signature valid, not replayed
    expect(() =>
      verifyGitHubSignature({ rawBody, signatureHeader: signature, secret: SECRET })
    ).not.toThrow();
    expect(guard.seen("delivery-combo-1")).toBe(false);

    // Replay: signature still valid (same bytes, same secret), but replay guard catches it
    expect(() =>
      verifyGitHubSignature({ rawBody, signatureHeader: signature, secret: SECRET })
    ).not.toThrow();
    expect(guard.seen("delivery-combo-1")).toBe(true);
  });
});
