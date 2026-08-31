import { createHmac } from "node:crypto";

/**
 * Computes a GitHub `X-Hub-Signature-256` header value (spec §17.5) over the exact raw
 * bytes of a webhook request body. Test-only: real webhook secrets are never committed,
 * so every caller supplies its own constant test secret.
 */
export const signGitHubPayload = (rawBody: Uint8Array, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
