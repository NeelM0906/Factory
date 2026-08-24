import { createHash, timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export function createBearerAuth(expectedToken: string): MiddlewareHandler {
  return createDigestBearerAuth(digest(expectedToken));
}

export function createBearerAuthDigest(expectedHexDigest: string): MiddlewareHandler {
  if (!/^[0-9a-f]{64}$/.test(expectedHexDigest)) throw new TypeError("Bearer digest is invalid.");
  return createDigestBearerAuth(Buffer.from(expectedHexDigest, "hex"));
}

const createDigestBearerAuth = (expectedDigest: Buffer): MiddlewareHandler => {
  return async (context, next) => {
    const authorization = context.req.header("Authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(authorization);
    const candidateDigest = digest(match?.[1] ?? "");
    if (match === null || !timingSafeEqual(expectedDigest, candidateDigest)) {
      return context.json(
        { error: { code: "unauthorized", message: "Authentication required." } },
        401
      );
    }
    await next();
  };
};
