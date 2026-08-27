import { describe, expect, it } from "vitest";

import { ModelRoutingError } from "@autostack/contracts";

import { classifyTransportResponse } from "../src/failure/http-classification.js";

const headers = (init?: Record<string, string>): Headers => new Headers(init);

describe("classifyTransportResponse", () => {
  it("classifies 429 as rate_limited, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 429,
      headers: headers()
    });
    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure.code).toBe("rate_limited");
    expect(failure.retryable).toBe(true);
  });

  it("classifies 503 with retry-after as rate_limited, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 503,
      headers: headers({ "retry-after": "30" })
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
        headers: headers()
      });
      expect(failure.code).toBe("provider_error");
      expect(failure.retryable).toBe(true);
    }
  );

  it("classifies 529 (overloaded) as provider_error, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 529,
      headers: headers()
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(true);
  });

  it("classifies a network throw as provider_error, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      networkError: new TypeError("fetch failed")
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(true);
  });

  it("classifies a malformed body on a 2xx response as provider_error, retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 200,
      headers: headers(),
      malformedBody: true
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(true);
  });

  it("ignores malformedBody on a non-2xx response and lets the status decide", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 401,
      headers: headers(),
      malformedBody: true
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(false);
  });

  it.each([400, 401, 403, 404, 422])("classifies %d as provider_error, non-retryable", (status) => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status,
      headers: headers()
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(false);
  });

  it("classifies 402 (insufficient credits) as provider_error, non-retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 402,
      headers: headers()
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(false);
  });

  it("classifies an unrecognized 4xx as provider_error, non-retryable", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 418,
      headers: headers()
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(false);
  });

  it.each([408, 425])("classifies %d as provider_error, retryable (transient 4xx)", (status) => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status,
      headers: headers()
    });
    expect(failure.code).toBe("provider_error");
    expect(failure.retryable).toBe(true);
  });

  it("composes a message from safe values only, never a header value", () => {
    const failure = classifyTransportResponse({
      routeRef: "route:openai",
      status: 500,
      headers: headers({ "x-request-id": "leaked-header-value" })
    });
    expect(failure.message).toContain("route:openai");
    expect(failure.message).toContain("500");
    expect(failure.message).not.toContain("leaked-header-value");
  });
});
