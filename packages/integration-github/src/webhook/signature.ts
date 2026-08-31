import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyGitHubSignatureInput {
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string | null; // "sha256=<hex>", from X-Hub-Signature-256
  readonly secret: string;
}

const SIGNATURE_PREFIX = "sha256=";
// Deliberately not length-anchored (unlike a fixed `{64}` quantifier): a truncated signature
// must still pass this check and reach the length pre-check below, so that check -- not this
// regex -- is what rejects it. See the length-pre-check comment for why that distinction matters.
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]+$/;

// Every rejection in this module uses one fixed message, no matter which individual check
// failed. This is deliberate: a distinguishable message per check would give an attacker an
// oracle for which part of the request to adjust next (matches the convention in
// @autostack/integration-slack's src/http/signature.ts).
const SIGNATURE_INVALID_MESSAGE = "GitHub webhook signature verification failed.";

/** Thrown by {@link verifyGitHubSignature} on any verification failure; never carries the secret. */
export class GitHubSignatureError extends Error {
  constructor() {
    super(SIGNATURE_INVALID_MESSAGE);
    this.name = "GitHubSignatureError";
    Object.freeze(this);
  }
}

const signatureInvalidError = (): GitHubSignatureError => new GitHubSignatureError();

const computeExpectedSignatureHex = (rawBody: Uint8Array, secret: string): string =>
  createHmac("sha256", secret).update(rawBody).digest("hex");

/**
 * Verifies a GitHub webhook signature (spec §17.5) over the exact raw request bytes. Throws a
 * {@link GitHubSignatureError} on any failure and never returns a boolean -- an unverifiable
 * request is a rejection, never a downgrade to "accept it anyway". The caller must pass the
 * bytes as received, before any JSON parsing or re-encoding: GitHub signs the exact request
 * body, and re-serialising a parsed object (even with identical field values) produces
 * different bytes and therefore a different signature.
 */
export const verifyGitHubSignature = (input: VerifyGitHubSignatureInput): void => {
  const { rawBody, signatureHeader, secret } = input;

  if (signatureHeader === null) throw signatureInvalidError();
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) throw signatureInvalidError();

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!SIGNATURE_HEX_PATTERN.test(providedHex)) throw signatureInvalidError();

  const expectedHex = computeExpectedSignatureHex(rawBody, secret);
  const providedBuffer = Buffer.from(providedHex, "hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");

  // timingSafeEqual throws a RangeError on unequal-length buffers, so the length pre-check is
  // what turns a truncated/oversized signature into a clean GitHubSignatureError instead of an
  // uncaught RangeError escaping this function.
  //
  // NOT BEHAVIOURALLY TESTABLE — stated here so nobody mistakes the suite for proof of it.
  // Swapping `timingSafeEqual` for `===` produces identical accept/reject results on every
  // input, so no test in signature.test.ts can reject that wrong implementation; the difference
  // is only observable as timing, which a unit test cannot assert without being flaky. The
  // length pre-check above IS behaviourally pinned (a wrong implementation omitting it makes
  // timingSafeEqual throw a RangeError instead of returning a clean rejection, which the
  // truncated-signature test catches). Constant-time comparison itself is a code-review
  // invariant: preserve this call deliberately, because the tests will stay green if you break it.
  if (providedBuffer.length !== expectedBuffer.length) throw signatureInvalidError();
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) throw signatureInvalidError();
};
