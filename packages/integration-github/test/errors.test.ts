import { describe, expect, it } from "vitest";

import {
  GitHubBranchPolicyError,
  GitHubRequestError,
  classifyGitHubFailure
} from "../src/index.js";

const headersOf = (entries: Record<string, string>): Headers => new Headers(entries);

describe("classifyGitHubFailure", () => {
  const now = (): number => 1_000_000_000_000;

  it("classifies 429 as rate_limited and retryable", () => {
    expect(classifyGitHubFailure(429, headersOf({}), now)).toEqual({
      code: "rate_limited",
      retryable: true
    });
  });

  it("classifies 403 with an exhausted rate limit as rate_limited and retryable", () => {
    const result = classifyGitHubFailure(403, headersOf({ "x-ratelimit-remaining": "0" }), now);
    expect(result.code).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("classifies 403 without rate-limit headers as forbidden and not retryable", () => {
    expect(classifyGitHubFailure(403, headersOf({}), now)).toEqual({
      code: "forbidden",
      retryable: false
    });
  });

  it("classifies 5xx as provider_unavailable and retryable", () => {
    expect(classifyGitHubFailure(500, headersOf({}), now)).toEqual({
      code: "provider_unavailable",
      retryable: true
    });
    expect(classifyGitHubFailure(503, headersOf({}), now)).toEqual({
      code: "provider_unavailable",
      retryable: true
    });
  });

  it("classifies 401 as unauthenticated and not retryable", () => {
    expect(classifyGitHubFailure(401, headersOf({}), now)).toEqual({
      code: "unauthenticated",
      retryable: false
    });
  });

  it("classifies 404 as not_found and not retryable", () => {
    expect(classifyGitHubFailure(404, headersOf({}), now)).toEqual({
      code: "not_found",
      retryable: false
    });
  });

  it("classifies 422 as invalid_request and not retryable", () => {
    expect(classifyGitHubFailure(422, headersOf({}), now)).toEqual({
      code: "invalid_request",
      retryable: false
    });
  });

  it("fails closed on an unmapped status rather than inviting a retry", () => {
    expect(classifyGitHubFailure(418, headersOf({}), now)).toEqual({
      code: "invalid_request",
      retryable: false
    });
  });

  it("ignores an unparseable Retry-After instead of scheduling a NaN delay", () => {
    const result = classifyGitHubFailure(429, headersOf({ "retry-after": "soon" }), now);
    expect(result.code).toBe("rate_limited");
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("never returns a negative delay for an already-elapsed rate-limit reset", () => {
    const fixedNow = 1_700_000_000_000;
    const elapsedReset = Math.floor(fixedNow / 1000) - 60;
    const result = classifyGitHubFailure(
      429,
      headersOf({ "x-ratelimit-reset": String(elapsedReset) }),
      () => fixedNow
    );
    expect(result.retryAfterMs).toBe(0);
  });

  it("honours Retry-After in seconds, converted to ms from the injected now()", () => {
    const fixedNow = 1_700_000_000_000;
    const result = classifyGitHubFailure(429, headersOf({ "retry-after": "30" }), () => fixedNow);
    expect(result.code).toBe("rate_limited");
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("honours x-ratelimit-reset as an epoch-seconds deadline", () => {
    const fixedNow = 1_700_000_000_000;
    const resetEpochSeconds = Math.floor(fixedNow / 1000) + 90;
    const result = classifyGitHubFailure(
      429,
      headersOf({ "x-ratelimit-reset": String(resetEpochSeconds) }),
      () => fixedNow
    );
    expect(result.code).toBe("rate_limited");
    expect(result.retryAfterMs).toBe(90_000);
  });

  it("prefers the larger of Retry-After and x-ratelimit-reset delays", () => {
    const fixedNow = 1_700_000_000_000;
    const largerReset = Math.floor(fixedNow / 1000) + 120;
    const withLargerReset = classifyGitHubFailure(
      429,
      headersOf({ "retry-after": "10", "x-ratelimit-reset": String(largerReset) }),
      () => fixedNow
    );
    expect(withLargerReset.retryAfterMs).toBe(120_000);

    const smallerReset = Math.floor(fixedNow / 1000) + 5;
    const withLargerRetryAfter = classifyGitHubFailure(
      429,
      headersOf({ "retry-after": "30", "x-ratelimit-reset": String(smallerReset) }),
      () => fixedNow
    );
    expect(withLargerRetryAfter.retryAfterMs).toBe(30_000);
  });
});

describe("GitHubRequestError", () => {
  it("carries status, code, and retryable", () => {
    const error = new GitHubRequestError("The request failed.", 500, "provider_unavailable", true);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GitHubRequestError");
    expect(error.status).toBe(500);
    expect(error.code).toBe("provider_unavailable");
    expect(error.retryable).toBe(true);
  });

  it("keeps an attached cause non-enumerable", () => {
    const cause = new Error("underlying transport failure detail");
    const error = new GitHubRequestError("The request failed.", 500, "provider_unavailable", true, {
      cause
    });
    expect(error.cause).toBe(cause);
    expect(Object.keys(error)).not.toContain("cause");
    const serialized = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(serialized, "cause")).toBe(false);
    expect(JSON.stringify(error)).not.toContain("underlying transport failure detail");
  });

  // The `not.toContain` assertions below are vacuous on their own: `redactSensitiveText` returns
  // "" from its own catch block, so a redactor that failed outright — or one replaced by
  // `() => ""` — satisfies "does not contain the secret" perfectly. That is the environment
  // supplying a default that passes the assertion. Each case therefore also asserts the message
  // SURVIVED: non-empty, and still carrying its non-sensitive text. Absent that companion these
  // tests would go on passing while every error message in the package was blank.
  it("redacts a declared sensitive value while preserving the rest of the message", () => {
    const secret = "super-secret-installation-value";
    const error = new GitHubRequestError(
      `Request failed: ${secret}`,
      401,
      "unauthenticated",
      false,
      { sensitiveValues: [secret] }
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("Request failed:");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("redacts a known GitHub credential shape while preserving the rest of the message", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwx0123";
    const error = new GitHubRequestError(
      `Request failed with header Authorization: Bearer ${token}`,
      401,
      "unauthenticated",
      false
    );
    expect(error.message).not.toContain(token);
    expect(error.message).toContain("Request failed with header");
    expect(error.message.length).toBeGreaterThan(0);
  });
});

describe("GitHubBranchPolicyError", () => {
  it("records the offending ref and is never retryable", () => {
    const error = new GitHubBranchPolicyError("feature/not-allowed");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GitHubBranchPolicyError");
    expect(error.ref).toBe("feature/not-allowed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("feature/not-allowed");
  });

  it("keeps an attached cause non-enumerable", () => {
    const cause = new Error("policy check detail");
    const error = new GitHubBranchPolicyError("feature/not-allowed", { cause });
    expect(error.cause).toBe(cause);
    expect(Object.keys(error)).not.toContain("cause");
    expect(JSON.stringify(error)).not.toContain("policy check detail");
  });
});
