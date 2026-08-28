import { createSign } from "node:crypto";

import { z } from "zod";

import { createGitHubTransport } from "../client/transport.js";
import { GitHubRequestError } from "../errors.js";
import type { GitHubAuthDescription, GitHubAuthStrategy } from "./types.js";

// GitHub caps installation-app JWTs at 10 minutes. 540s (9 minutes) leaves margin, and the
// 60s issued-at skew tolerates modest clock drift between this process and GitHub's, per
// GitHub's own JWT-minting guidance.
const JWT_ISSUED_AT_SKEW_SECONDS = 60;
const JWT_EXPIRY_SECONDS = 540;

// Installation tokens are reused until this many milliseconds before their expires_at, then
// re-minted -- never right up to the deadline, so a request that starts just before expiry
// still completes with a token GitHub still honours.
const REFRESH_MARGIN_MS = 60_000;

const base64UrlEncode = (input: string | Buffer): string =>
  (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString("base64url");

/**
 * Mints a short-lived RS256 JWT identifying the GitHub App itself (not the installation), per
 * GitHub's app-authentication scheme. `node:crypto` only -- no `jsonwebtoken` dependency.
 */
const mintAppJwt = (appId: string, privateKeyPem: string, now: () => number): string => {
  const nowSeconds = Math.floor(now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - JWT_ISSUED_AT_SKEW_SECONDS,
    exp: nowSeconds + JWT_EXPIRY_SECONDS,
    iss: appId
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload)
  )}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64UrlEncode(signature)}`;
};

// Not `.strict()`: GitHub's real response also carries `permissions`, `repository_selection`,
// and similar fields this strategy does not need. Only the two fields it uses are validated.
const installationTokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1)
});

export interface CreateAppInstallationAuthOptions {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly installationId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly userAgent: string;
  /** Epoch milliseconds, matching {@link createGitHubTransport}'s clock convention. */
  readonly now: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** When supplied, scopes the minted installation token to just these repositories. */
  readonly repositoryIds?: readonly number[];
}

interface CachedInstallationToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * GitHub App installation-token auth. Mints a JWT (above) and exchanges it for an installation
 * access token through `createGitHubTransport`, so the exchange call inherits
 * `redirect: "manual"`, bounded response reads, backoff, and header hygiene like every other
 * GitHub call this package makes -- it is deliberately not a hand-rolled fetch.
 *
 * The installation token is cached in a closure variable only -- never on the returned object,
 * never in a module-level cache -- and reused until {@link REFRESH_MARGIN_MS} before its
 * `expires_at`. Concurrent `authorization()` calls during a refresh share a single in-flight
 * exchange promise, so a burst of callers never triggers more than one token exchange.
 */
export const createAppInstallationAuth = (
  options: CreateAppInstallationAuthOptions
): GitHubAuthStrategy => {
  const jwtTransport = createGitHubTransport({
    fetch: options.fetch,
    userAgent: options.userAgent,
    now: options.now,
    authorization: async () =>
      `Bearer ${mintAppJwt(options.appId, options.privateKeyPem, options.now)}`,
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {})
  });

  let cached: CachedInstallationToken | undefined;
  let inFlight: Promise<string> | undefined;

  const exchangeForInstallationToken = async (): Promise<string> => {
    const body: { repository_ids?: readonly number[] } = {};
    if (options.repositoryIds !== undefined) {
      body.repository_ids = options.repositoryIds;
    }
    const response = await jwtTransport.request({
      method: "POST",
      path: `/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
      body,
      schema: installationTokenResponseSchema
    });
    const expiresAtMs = Date.parse(response.expires_at);
    if (!Number.isFinite(expiresAtMs)) {
      // Without this, an unparseable expires_at yields NaN, every `NaN > nowMs` comparison is
      // false, and the strategy silently re-exchanges a token on every single call — a hidden
      // performance cliff that looks like nothing is wrong. Fail loudly instead.
      throw new GitHubRequestError(
        "GitHub installation token response carried an unparseable expiry.",
        200,
        "invalid_response",
        false
      );
    }
    cached = { token: response.token, expiresAtMs };
    return response.token;
  };

  const ensureInstallationToken = async (): Promise<string> => {
    const nowMs = options.now();
    if (cached !== undefined && cached.expiresAtMs - REFRESH_MARGIN_MS > nowMs) {
      return cached.token;
    }
    if (inFlight === undefined) {
      inFlight = exchangeForInstallationToken().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };

  const authorization = async (): Promise<string> => `Bearer ${await ensureInstallationToken()}`;

  const describe = (): GitHubAuthDescription => ({
    kind: "app_installation",
    subject: `app:${options.appId}/installation:${options.installationId}`
  });

  return { kind: "app_installation", authorization, describe };
};
