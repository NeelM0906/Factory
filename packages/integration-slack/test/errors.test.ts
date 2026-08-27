import { describe, expect, it } from "vitest";

import { SlackRequestError, classifySlackFailure } from "../src/index.js";

describe("classifySlackFailure", () => {
  it("classifies an HTTP 200 response with { ok: false, error: 'ratelimited' } as rate_limited and retryable", () => {
    // Slack signals rate limiting inside a 200 response body, not via HTTP status.
    expect(
      classifySlackFailure({ status: 200, body: { ok: false, error: "ratelimited" } })
    ).toEqual({
      code: "rate_limited",
      retryable: true
    });
  });

  it("classifies { ok: false, error: 'invalid_auth' } as unauthenticated and not retryable", () => {
    expect(
      classifySlackFailure({ status: 200, body: { ok: false, error: "invalid_auth" } })
    ).toEqual({
      code: "unauthenticated",
      retryable: false
    });
  });

  it("classifies { ok: false, error: 'not_authed' } as unauthenticated and not retryable", () => {
    expect(classifySlackFailure({ status: 200, body: { ok: false, error: "not_authed" } })).toEqual(
      {
        code: "unauthenticated",
        retryable: false
      }
    );
  });

  it("classifies { ok: false, error: 'token_revoked' } as unauthenticated and not retryable", () => {
    expect(
      classifySlackFailure({ status: 200, body: { ok: false, error: "token_revoked" } })
    ).toEqual({
      code: "unauthenticated",
      retryable: false
    });
  });

  it("classifies any other { ok: false, error } as invalid_request and not retryable", () => {
    expect(
      classifySlackFailure({ status: 200, body: { ok: false, error: "channel_not_found" } })
    ).toEqual({
      code: "invalid_request",
      retryable: false
    });
  });

  it("classifies { ok: false } with no error field as invalid_request and not retryable", () => {
    expect(classifySlackFailure({ status: 200, body: { ok: false } })).toEqual({
      code: "invalid_request",
      retryable: false
    });
  });

  it("classifies a 5xx status with no body as provider_unavailable and retryable", () => {
    expect(classifySlackFailure({ status: 503 })).toEqual({
      code: "provider_unavailable",
      retryable: true
    });
  });

  it("classifies a 429 status with no body as rate_limited and retryable", () => {
    expect(classifySlackFailure({ status: 429 })).toEqual({
      code: "rate_limited",
      retryable: true
    });
  });

  it("fails closed on an unmapped status with no body", () => {
    expect(classifySlackFailure({ status: 418 })).toEqual({
      code: "invalid_request",
      retryable: false
    });
  });
});

describe("SlackRequestError", () => {
  it("carries code and retryable", () => {
    const error = new SlackRequestError("The request failed.", "provider_unavailable", true);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SlackRequestError");
    expect(error.code).toBe("provider_unavailable");
    expect(error.retryable).toBe(true);
  });

  it("keeps an attached cause non-enumerable", () => {
    const cause = new Error("underlying transport failure detail");
    const error = new SlackRequestError("The request failed.", "provider_unavailable", true, {
      cause
    });
    expect(error.cause).toBe(cause);
    expect(Object.keys(error)).not.toContain("cause");
    const serialized = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(serialized, "cause")).toBe(false);
    expect(JSON.stringify(error)).not.toContain("underlying transport failure detail");
  });

  it("redacts a declared sensitive value out of the message", () => {
    const secret = "super-secret-signing-value";
    const error = new SlackRequestError(`Request failed: ${secret}`, "unauthenticated", false, {
      sensitiveValues: [secret]
    });
    expect(error.message).not.toContain(secret);
  });

  it("redacts a known Slack bot token shape even when not declared", () => {
    const token = ["xoxb", "0123456789", "abcdefghijklmnop"].join("-");
    const error = new SlackRequestError(
      `Request failed with header Authorization: Bearer ${token}`,
      "unauthenticated",
      false
    );
    expect(error.message).not.toContain(token);
  });
});
