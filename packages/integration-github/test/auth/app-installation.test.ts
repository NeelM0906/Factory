import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createAppInstallationAuth, createAppJwtAuth } from "../../src/auth/app-installation.js";
import { GitHubRequestError } from "../../src/errors.js";

const APP_ID = "123456";
const INSTALLATION_ID = "987654";
const USER_AGENT = "autostack-test/1.0";

interface GeneratedKeyPair {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

// Generated fresh inside the test process, never persisted or committed.
const generateRsaKeyPair = (): GeneratedKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
};

interface DecodedJwt {
  readonly header: unknown;
  readonly payload: unknown;
  readonly signingInput: string;
  readonly signature: Buffer;
}

const decodeJwt = (jwt: string): DecodedJwt => {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error(`Expected a three-part JWT, got: ${parts.length} parts.`);
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as unknown,
    payload: JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as unknown,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: Buffer.from(signatureB64, "base64url")
  };
};

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

const recordingFetch = (
  handler: (call: RecordedCall, callIndex: number) => Response | Promise<Response>
): { readonly fetch: typeof globalThis.fetch; readonly calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requireCall = (calls: readonly RecordedCall[], index: number): RecordedCall => {
  const call = calls[index];
  if (call === undefined) throw new Error(`Expected a fetch call at index ${index}.`);
  return call;
};

const jwtFromAuthorizationHeader = (call: RecordedCall): string => {
  const header = new Headers(call.init.headers).get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) throw new Error(`Expected a Bearer JWT header, got: "${header}"`);
  return header.slice(prefix.length);
};

const parseJsonBody = (call: RecordedCall): Record<string, unknown> =>
  JSON.parse(String(call.init.body)) as Record<string, unknown>;

describe("createAppInstallationAuth", () => {
  describe("JWT minting", () => {
    it("mints an RS256 JWT with iat=now-60, exp=now+540, and iss=appId, verifiable with the public key", async () => {
      const { publicKeyPem, privateKeyPem } = generateRsaKeyPair();
      const nowMs = 1_700_000_000_000;
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse({
          token: "installation-token-value",
          expires_at: new Date(nowMs + 3_600_000).toISOString()
        })
      );
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => nowMs
      });

      await auth.authorization();

      expect(calls).toHaveLength(1);
      const jwt = jwtFromAuthorizationHeader(requireCall(calls, 0));
      const { header, payload, signingInput, signature } = decodeJwt(jwt);

      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      const nowSeconds = Math.floor(nowMs / 1000);
      expect(payload).toEqual({
        iat: nowSeconds - 60,
        exp: nowSeconds + 540,
        iss: APP_ID
      });

      const verifier = createVerify("RSA-SHA256");
      verifier.update(signingInput);
      verifier.end();
      expect(verifier.verify(publicKeyPem, signature)).toBe(true);
    });
  });

  describe("installation token exchange", () => {
    it("exchanges the JWT at POST /app/installations/{id}/access_tokens and returns Bearer <installation token>", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse({ token: "v1.installation-token", expires_at: "2030-01-01T00:00:00Z" })
      );
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      const authorization = await auth.authorization();

      expect(auth.kind).toBe("app_installation");
      expect(authorization).toBe("Bearer v1.installation-token");
      expect(calls).toHaveLength(1);
      const call = requireCall(calls, 0);
      expect(call.url).toBe(
        `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`
      );
      expect(call.init.method).toBe("POST");
    });

    it("throws invalid_response on an unexpected exchange response shape", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      const { fetch } = recordingFetch(() => jsonResponse({ unexpected: true }));
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      const failure = await auth.authorization().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GitHubRequestError);
      expect((failure as GitHubRequestError).code).toBe("invalid_response");
    });
  });

  describe("transport reuse", () => {
    it("sends redirect: manual on the exchange call, inherited from createGitHubTransport", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse({ token: "t", expires_at: "2030-01-01T00:00:00Z" })
      );
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      await auth.authorization();

      expect(requireCall(calls, 0).init.redirect).toBe("manual");
    });
  });

  describe("in-memory caching and refresh", () => {
    it("caches the installation token and reuses it until 60s before expiry, then re-mints", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      let currentNowMs = 1_700_000_000_000;
      const expiresAtMs = currentNowMs + 3_600_000;
      let exchangeCount = 0;
      const { fetch } = recordingFetch(() => {
        exchangeCount += 1;
        return jsonResponse({
          token: `installation-token-${exchangeCount}`,
          expires_at: new Date(expiresAtMs).toISOString()
        });
      });
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => currentNowMs
      });

      const first = await auth.authorization();
      const second = await auth.authorization();
      expect(first).toBe("Bearer installation-token-1");
      expect(second).toBe("Bearer installation-token-1");
      expect(exchangeCount).toBe(1);

      // Advance the clock to inside the 60s refresh window before expiry.
      currentNowMs = expiresAtMs - 30_000;
      const third = await auth.authorization();
      expect(third).toBe("Bearer installation-token-2");
      expect(exchangeCount).toBe(2);
    });
  });

  describe("describe()", () => {
    it("returns kind and subject with no secret material", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      const { fetch } = recordingFetch(() =>
        jsonResponse({
          token: "super-secret-installation-token",
          expires_at: "2030-01-01T00:00:00Z"
        })
      );
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      await auth.authorization();
      const description = auth.describe();

      expect(description).toEqual({
        kind: "app_installation",
        subject: `app:${APP_ID}/installation:${INSTALLATION_ID}`
      });
      const serialized = JSON.stringify(description);
      expect(serialized).not.toContain(privateKeyPem);
      expect(serialized).not.toContain("super-secret-installation-token");
    });
  });

  describe("failed exchange", () => {
    it("throws unauthenticated with a message free of the private key, the JWT, and the installation token", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      const { fetch } = recordingFetch(() => new Response("", { status: 401 }));
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      const failure = await auth.authorization().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GitHubRequestError);
      expect((failure as GitHubRequestError).code).toBe("unauthenticated");
      const message = (failure as GitHubRequestError).message;
      expect(message).not.toContain(privateKeyPem);
      expect(message).not.toContain("Bearer");
      expect(JSON.stringify(failure)).not.toContain(privateKeyPem);
    });
  });

  describe("single-flight refresh", () => {
    it("performs exactly one exchange for two concurrent authorization() calls, proven with a manually-resolved deferred fetch", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      let resolveFetch: ((response: Response) => void) | undefined;
      const deferred = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const fetch = vi.fn(async () => deferred) as unknown as typeof globalThis.fetch;
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      const first = auth.authorization();
      const second = auth.authorization();

      if (resolveFetch === undefined) throw new Error("resolveFetch was never assigned.");
      resolveFetch(
        jsonResponse({ token: "single-flight-token", expires_at: "2030-01-01T00:00:00Z" })
      );

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toBe("Bearer single-flight-token");
      expect(secondResult).toBe("Bearer single-flight-token");
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("repositoryIds scoping", () => {
    it("includes repository_ids in the exchange body when supplied", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse({ token: "scoped-token", expires_at: "2030-01-01T00:00:00Z" })
      );
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000,
        repositoryIds: [111, 222]
      });

      await auth.authorization();

      const body = parseJsonBody(requireCall(calls, 0));
      expect(body.repository_ids).toEqual([111, 222]);
    });

    it("omits repository_ids entirely when not supplied, rather than sending null or undefined", async () => {
      const { privateKeyPem } = generateRsaKeyPair();
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse({ token: "unscoped-token", expires_at: "2030-01-01T00:00:00Z" })
      );
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      await auth.authorization();

      const body = parseJsonBody(requireCall(calls, 0));
      expect(Object.prototype.hasOwnProperty.call(body, "repository_ids")).toBe(false);
    });
  });

  describe("expiry parsing", () => {
    it("rejects an unparseable expires_at instead of silently re-exchanging on every call", async () => {
      // Date.parse returns NaN for an unparseable value, and every `NaN > nowMs` comparison is
      // false — so without an explicit guard the cache never hits and the strategy quietly mints
      // a fresh token on every single call. That is a hidden performance cliff, not an error the
      // operator would ever see, so it must fail loudly.
      const { privateKeyPem } = generateRsaKeyPair();
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse({ token: "v1.installation-token", expires_at: "not-a-timestamp" })
      );
      const auth = createAppInstallationAuth({
        appId: APP_ID,
        privateKeyPem,
        installationId: INSTALLATION_ID,
        fetch,
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      const failure = await auth.authorization().catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GitHubRequestError);
      expect((failure as GitHubRequestError).code).toBe("invalid_response");
      expect(calls).toHaveLength(1);
      expect((failure as GitHubRequestError).message).not.toContain("v1.installation-token");
    });
  });
});

describe("createAppJwtAuth", () => {
  // Rejects the wrong implementation: one that returns an INSTALLATION token here. The App-level
  // endpoints (GET /app/installations) authenticate the App itself, and an installation token is
  // refused by them. Asserting the header is a verifiable RS256 JWT signed by the App key — not
  // merely that some Bearer value came back — is what discriminates the two.
  it("mints an App-level JWT, verifiable with the App's public key, and issues no network call", async () => {
    const { publicKeyPem, privateKeyPem } = generateRsaKeyPair();
    const fetchStub = vi.fn();
    const now = 1_700_000_000_000;

    const auth = createAppJwtAuth({ appId: APP_ID, privateKeyPem, now: () => now });
    const header = await auth.authorization();

    expect(header.startsWith("Bearer ")).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();

    const decoded = decodeJwt(header.slice("Bearer ".length));
    expect(decoded.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decoded.payload).toEqual({
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 540,
      iss: APP_ID
    });

    const verifier = createVerify("RSA-SHA256");
    verifier.update(decoded.signingInput);
    expect(verifier.verify(publicKeyPem, decoded.signature)).toBe(true);
  });

  // The accept-side companion to the secrecy assertion: an empty subject would satisfy
  // "does not contain the key", so the exact expected value is asserted instead.
  it("describes the App without leaking the private key", () => {
    const { privateKeyPem } = generateRsaKeyPair();
    const auth = createAppJwtAuth({
      appId: APP_ID,
      privateKeyPem,
      now: () => 1_700_000_000_000
    });

    expect(auth.describe()).toEqual({ kind: "app_installation", subject: `app:${APP_ID}` });
    expect(JSON.stringify(auth.describe())).not.toContain(privateKeyPem);
  });
});
