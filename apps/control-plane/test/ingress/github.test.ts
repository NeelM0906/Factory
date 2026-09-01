import { createHmac, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { IngressDeliverySchema, type IngressDelivery } from "@autostack/contracts";

import { registerGitHubIngress } from "../../src/ingress/github.js";
import type { GitHubIngressDependencies } from "../../src/ingress/types.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SECRET = "github-webhook-secret";

// Implemented inline with node:crypto per the brief: apps/control-plane cannot depend on
// GitHub's own adapter package, so this stands in for the real adapter's verifier and gives the
// raw-body tests below something meaningful to prove (a byte-exact HMAC actually breaks on a
// single mutated byte, unlike a stub that always passes).
const sign = (rawBody: Uint8Array): string =>
  `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;

const verifySignature: GitHubIngressDependencies["verifySignature"] = ({
  rawBody,
  signatureHeader
}) => {
  if (signatureHeader === null) throw new Error("missing signature");
  const expected = Buffer.from(sign(rawBody));
  const actual = Buffer.from(signatureHeader);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("signature mismatch");
  }
};

class UnsupportedEventError extends Error {}

const VALID_DELIVERY: IngressDelivery = IngressDeliverySchema.parse({
  schemaVersion: 1,
  provider: "github",
  deliveryId: "delivery-1",
  deduplicationKey: "delivery-1",
  receivedAt: NOW,
  event: "issues.labeled",
  repository: { id: "repo-1", fullName: "octo/repo" },
  issue: { number: 1, title: "Bug report", body: "It broke.", authorId: "user-1" }
});

interface HarnessOptions {
  readonly isOpen?: () => boolean;
  readonly verifySignature?: GitHubIngressDependencies["verifySignature"];
  readonly parseDelivery?: GitHubIngressDependencies["parseDelivery"];
  readonly acceptImpl?: (delivery: IngressDelivery) => Promise<{ readonly replayed: boolean }>;
  readonly maximumBodyBytes?: number;
  readonly basePath?: string;
}

function makeHarness(options: HarnessOptions = {}) {
  const accept = vi.fn(options.acceptImpl ?? (async () => ({ replayed: false })));
  const deps: GitHubIngressDependencies = {
    ingress: { accept },
    verifySignature: options.verifySignature ?? verifySignature,
    parseDelivery: options.parseDelivery ?? (() => VALID_DELIVERY),
    isUnsupportedEvent: (error) => error instanceof UnsupportedEventError,
    now: () => NOW,
    isOpen: options.isOpen ?? (() => true),
    ...(options.maximumBodyBytes === undefined
      ? {}
      : { maximumBodyBytes: options.maximumBodyBytes }),
    ...(options.basePath === undefined ? {} : { basePath: options.basePath })
  };
  const app = new Hono();
  registerGitHubIngress(app, deps);
  return { app, accept };
}

const post = (
  app: Hono,
  body: string,
  headers: Record<string, string> = {},
  path = "/ingress/github"
) => {
  const rawBody = new TextEncoder().encode(body);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Hub-Signature-256": sign(rawBody),
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-1",
      ...headers
    },
    body
  });
};

describe("registerGitHubIngress", () => {
  it("accepts a validly-signed issues.labeled delivery exactly once", async () => {
    const { app, accept } = makeHarness();
    const response = await post(app, JSON.stringify({ action: "labeled" }));

    expect(response.status).toBe(202);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(VALID_DELIVERY);
  });

  describe("raw-body proof", () => {
    it("verifies over the bytes as received, unusual whitespace included", async () => {
      const { app, accept } = makeHarness();
      const body = '{\n  "action":   "labeled",\n  "issue": { "number": 1 }\n}\n';
      const response = await post(app, body);

      expect(response.status).toBe(202);
      expect(accept).toHaveBeenCalledTimes(1);
    });

    it("rejects when a single byte changes after signing (401, not a decorative pass)", async () => {
      // Signs the original body, then sends a body with one mutated character but keeps the
      // original signature header. If the route re-encoded the parsed object instead of
      // reusing the exact received bytes, this would pass regardless of the mutation -- that
      // is the wrong implementation this test exists to catch. The happy-path test above alone
      // cannot: it never proves the route rejects a byte it did not sign for.
      const { app, accept } = makeHarness();
      const original = JSON.stringify({ action: "labeled" });
      const signatureForOriginal = sign(new TextEncoder().encode(original));
      const mutated = original.replace("labeled", "labeleD");

      const response = await app.request("/ingress/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Hub-Signature-256": signatureForOriginal,
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "delivery-1"
        },
        body: mutated
      });

      expect(response.status).toBe(401);
      expect(accept).not.toHaveBeenCalled();
    });
  });

  it("rejects a missing or invalid signature with the shared ApiError shape and no accept call", async () => {
    const { app, accept } = makeHarness();
    const body = JSON.stringify({ action: "labeled" });

    const missing = await app.request("/ingress/github", {
      method: "POST",
      headers: { "content-type": "application/json", "X-GitHub-Event": "issues" },
      body
    });
    const bogus = await post(app, body, { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) });

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) }
    });
    expect(bogus.status).toBe(401);
    expect(accept).not.toHaveBeenCalled();
  });

  it("returns 200 with replayed:true when accept() reports a replay, doing no duplicate work", async () => {
    const { app, accept } = makeHarness({ acceptImpl: async () => ({ replayed: true }) });
    const response = await post(app, JSON.stringify({ action: "labeled" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ replayed: true });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("ignores an unsupported event with 202, never a 500, and never calls accept", async () => {
    const { app, accept } = makeHarness({
      parseDelivery: () => {
        throw new UnsupportedEventError("ping is not actionable");
      }
    });
    const response = await post(app, JSON.stringify({ zen: "ping" }), { "X-GitHub-Event": "ping" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ignored: true });
    expect(accept).not.toHaveBeenCalled();
  });

  describe("body size cap", () => {
    it("rejects a declared content-length over the cap before reading the body", async () => {
      const { app, accept } = makeHarness({ maximumBodyBytes: 10 });
      const response = await post(app, "x".repeat(1000));

      expect(response.status).toBe(413);
      expect(accept).not.toHaveBeenCalled();
    });

    it("stops reading a streamed body once the cap is exceeded, never draining the full stream", async () => {
      const CAP = 1024;
      const CHUNK = 4096;
      const AVAILABLE = 50 * 1024 * 1024; // far larger than the cap; must never be fully drained
      let bytesPulled = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (cancelled || bytesPulled >= AVAILABLE) {
            controller.close();
            return;
          }
          const size = Math.min(CHUNK, AVAILABLE - bytesPulled);
          controller.enqueue(new Uint8Array(size).fill(97));
          bytesPulled += size;
        },
        cancel() {
          cancelled = true;
        }
      });

      const { app, accept } = makeHarness({ maximumBodyBytes: CAP });
      const request = new Request("http://localhost/ingress/github", {
        method: "POST",
        headers: { "content-type": "application/json", "X-GitHub-Event": "issues" },
        body: stream,
        duplex: "half"
      } as RequestInit & { readonly duplex: "half" });

      const response = await app.request(request);

      expect(response.status).toBe(413);
      expect(accept).not.toHaveBeenCalled();
      // The cap is 1024 bytes read in 4096-byte pulls, so at most one pull past the cap is ever
      // buffered. A wrong implementation that reads to completion before checking the size would
      // pull the full 50 MiB; this bound catches that.
      expect(bytesPulled).toBeLessThanOrEqual(CAP + CHUNK);
      expect(cancelled).toBe(true);
    });
  });

  it("rejects malformed JSON after a valid signature with 400, not 500", async () => {
    const { app, accept } = makeHarness();
    const response = await post(app, "{ not valid json");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: expect.any(String) }
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("surfaces an accept() rejection as 503 without leaking internal detail", async () => {
    const { app } = makeHarness({
      acceptImpl: async () => {
        throw new Error("sqlite: disk I/O error at /var/secret/db.sqlite");
      }
    });
    const response = await post(app, JSON.stringify({ action: "labeled" }));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain("sqlite");
    expect(body).not.toContain("/var/secret");
    expect(JSON.parse(body)).toEqual({
      error: { code: "local_runner_unavailable", message: expect.any(String) }
    });
  });

  it("never echoes the payload back in any response", async () => {
    const { app } = makeHarness();
    const response = await post(
      app,
      JSON.stringify({ action: "labeled", secretField: "sh-not-here" })
    );
    const body = await response.text();

    expect(body).not.toContain("sh-not-here");
    expect(body).not.toContain("Bug report");
  });

  describe("outside the bearer wall", () => {
    it("succeeds with no Authorization header, given a valid signature", async () => {
      const { app } = makeHarness();
      const response = await post(app, JSON.stringify({ action: "labeled" }));
      expect(response.status).toBe(202);
    });

    it("succeeds with a bogus bearer token, given a valid signature", async () => {
      // Paired deliberately with the no-header case above: absent any bearer-auth wiring at
      // all, "no Authorization header succeeds" is true of every route and proves nothing on its
      // own. A *bogus but present* bearer token also succeeding is what rules out "someone
      // bolted a bearer check onto this route" as a passing wrong implementation.
      const { app } = makeHarness();
      const response = await post(app, JSON.stringify({ action: "labeled" }), {
        Authorization: "Bearer not-a-real-token"
      });
      expect(response.status).toBe(202);
    });

    it("is not registered under /v1", async () => {
      const { app } = makeHarness();
      const underV1 = await post(
        app,
        JSON.stringify({ action: "labeled" }),
        {},
        "/v1/ingress/github"
      );
      expect(underV1.status).toBe(404);
    });
  });

  describe("ingress closed", () => {
    it("returns 503 with zero accept calls when isOpen() is false", async () => {
      const { app, accept } = makeHarness({ isOpen: () => false });
      const response = await post(app, JSON.stringify({ action: "labeled" }));

      expect(response.status).toBe(503);
      // Asserting only the status would also pass a route that calls accept() and then
      // discards the result before answering 503 -- the call count is what actually pins
      // "never touches the port while closed".
      expect(accept).not.toHaveBeenCalled();
    });

    it("still verifies the signature first: a bad signature on a closed ingress is 401, not 503", async () => {
      const { app, accept } = makeHarness({ isOpen: () => false });
      const response = await post(app, JSON.stringify({ action: "labeled" }), {
        "X-Hub-Signature-256": "sha256=" + "0".repeat(64)
      });

      expect(response.status).toBe(401);
      expect(accept).not.toHaveBeenCalled();
    });
  });

  describe("base path as given", () => {
    it("serves at a custom basePath and not at the default", async () => {
      const { app } = makeHarness({ basePath: "/custom/hook" });
      const body = JSON.stringify({ action: "labeled" });

      const atCustomPath = await post(app, body, {}, "/custom/hook");
      const atDefaultPath = await post(app, body, {}, "/ingress/github");

      expect(atCustomPath.status).toBe(202);
      expect(atDefaultPath.status).toBe(404);
    });
  });
});
