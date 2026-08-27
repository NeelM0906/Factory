import { createHmac, timingSafeEqual } from "node:crypto";

import { SlackRequestError } from "../errors.js";

export interface VerifySlackSignatureInput {
  readonly rawBody: Uint8Array;
  readonly timestampHeader: string | null;
  readonly signatureHeader: string | null;
  readonly signingSecret: string;
  readonly now: () => number;
  readonly toleranceSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_VERSION_PREFIX = "v0=";
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d+$/;

// Every rejection in this module uses one of exactly two fixed messages, no matter which
// individual check failed. This is deliberate: a distinguishable message per check would
// give an attacker an oracle for which part of the request to adjust next.
const SIGNATURE_INVALID_MESSAGE = "Slack request signature verification failed.";
const REPLAYED_MESSAGE = "Slack webhook request timestamp is outside the accepted window.";

const signatureInvalidError = (): SlackRequestError =>
  new SlackRequestError(SIGNATURE_INVALID_MESSAGE, "signature_invalid", false);

const replayedError = (): SlackRequestError =>
  new SlackRequestError(REPLAYED_MESSAGE, "replayed", false);

const computeExpectedSignatureHex = (
  timestampHeader: string,
  rawBody: Uint8Array,
  signingSecret: string
): string => {
  const prefix = new TextEncoder().encode(`v0:${timestampHeader}:`);
  const base = new Uint8Array(prefix.length + rawBody.length);
  base.set(prefix, 0);
  base.set(rawBody, prefix.length);
  return createHmac("sha256", signingSecret).update(base).digest("hex");
};

/**
 * Verifies a Slack request signature (spec §17.5) over the exact raw request bytes and
 * rejects requests outside the replay tolerance window. Throws a {@link SlackRequestError}
 * on any failure and never returns a boolean — an unverifiable request is a rejection,
 * never a downgrade to "accept it anyway".
 */
export const verifySlackSignature = (input: VerifySlackSignatureInput): void => {
  const { rawBody, timestampHeader, signatureHeader, signingSecret, now, toleranceSeconds } = input;

  if (timestampHeader === null || signatureHeader === null) throw signatureInvalidError();
  if (!signatureHeader.startsWith(SIGNATURE_VERSION_PREFIX)) throw signatureInvalidError();

  const providedHex = signatureHeader.slice(SIGNATURE_VERSION_PREFIX.length);
  if (!SIGNATURE_HEX_PATTERN.test(providedHex)) throw signatureInvalidError();

  const expectedHex = computeExpectedSignatureHex(timestampHeader, rawBody, signingSecret);
  const providedBuffer = Buffer.from(providedHex, "hex");
  const expectedBuffer = Buffer.from(expectedHex, "hex");

  // timingSafeEqual throws on unequal-length buffers; both are pre-checked to be exactly
  // 32 bytes by SIGNATURE_HEX_PATTERN and the fixed sha256 digest length, so this never throws.
  if (providedBuffer.length !== expectedBuffer.length) throw signatureInvalidError();
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) throw signatureInvalidError();

  if (!TIMESTAMP_PATTERN.test(timestampHeader)) throw signatureInvalidError();

  const toleranceMs = (toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  const timestampMs = Number(timestampHeader) * 1000;
  const driftMs = now() - timestampMs;

  if (driftMs > toleranceMs || driftMs < -toleranceMs) throw replayedError();
};
