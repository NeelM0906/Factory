import { describe, expect, it } from "vitest";

import { ModelRoutingError } from "@autostack/contracts";

import { classifyTransportResponse } from "../src/failure/http-classification.js";

const headers = (init?: Record<string, string>): Headers => new Headers(init);

describe("classifyTransportResponse", () => {
  it("classifies 429 as rate_limited, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 429,
      headers: headers(),
      body: "sensitive-body-should-not-leak"
    });
    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure.code).toBe("rate_limited");
    expect(failure.retryable).toBe(true);
  });

  it("classifies 503 with retry-after as rate_limited, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 503,
      headers: headers({ "retry-after": "30" }),
      body: "sensitive-body-should-not-leak"
    });
    expect(failure.code).toBe("rate_limited");
    expect(failure.retryable).toBe(true);
  });

  it.each([500, 502, 503, 504])(
    "classifies %d without retry-after as provider_error, retryable",
    (status) => {
      const failure = classifyTransportResponse({
        routeRef: "route:openai",
        status,
        headers: headers(),
        body: "sensitive-body-should-not-leak"
      });
      expect(failure.code).toBe("provider_error");
      expect(failure.retryable).toBe(true);
    }
  );

  it("classifies a network throw as provider_error, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      networkError: new TypeError("fetch failed")
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(true);
  });

  it("classifies a malformed body as provider_error, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 200,
      headers: headers(),
      body: "sensitive-body-should-not-leak",
      malformedBody: true
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("classifies %d as provider_error, non-retryable", (status) => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status,
      headers: headers(),
      body: "sensitive-body-should-not-leak"
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(false);
  });

  it("classifies an unrecognized status as provider_error, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 418,
      headers: headers(),
      body: "sensitive-body-should-not-leak"
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(true);
  });

  it("composes a message from safe values only, never body or header values", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 500,
      headers: headers({ "x-request-id": "leaked-header-value" }),
      body: "leaked-body-value"
    });
    expect(failure.message).toContain("route:openai");
    expect(failure.message).toContain("500");
    expect(failure.message).not.toContain("leaked-body-value");
    expect(failure.message).not.toContain("leaked-header-value");
  });
});
