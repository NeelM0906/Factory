import { createHash, timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

export function createBearerAuth(expectedToken: string): MiddlewareHandler {
  const expectedDigest = digest(expectedToken);

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
}
