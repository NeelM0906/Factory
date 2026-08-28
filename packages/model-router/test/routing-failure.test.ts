import { describe, expect, it } from "vitest";

import { MODEL_ROUTING_FAILURE_CODES, ModelRoutingError } from "@autostack/contracts";

import {
  budgetExceeded,
  capabilityUnavailable,
  coveredCodes,
  providerError,
  rateLimited,
  routeDisabled
} from "../src/failure/routing-failure.js";

describe("routing failure builders", () => {
  it("raises a non-retryable error for every deterministic code", () => {
    for (const failure of [
      capabilityUnavailable({ required: ["tool_call"], absentPins: [] }),
      routeDisabled({ routeRef: "route:openai", required: ["text"] }),
      budgetExceeded({ routeRef: "route:openai", ceiling: "maxCostMicros" })
    ]) {
      expect(failure).toBeInstanceOf(ModelRoutingError);
      expect(failure.retryable).toBe(false);
    }
  });

  it("raises a retryable error for rate_limited", () => {
    const failure = rateLimited({ routeRef: "route:openai" });
    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("rate_limited");
  });

  it("names absent pins separately from missing capabilities", () => {
    const failure = capabilityUnavailable({
      required: [],
      absentPins: ["route:openai"]
    });
    expect(failure.message).toContain("route:openai");
  });

  it("builds an aggregate failure with no single attributable route", () => {
    const budget = budgetExceeded({ ceiling: "maxCostMicros" });
    const limited = rateLimited({});
    expect(budget.failure.routeRef).toBeUndefined();
    expect(limited.failure.routeRef).toBeUndefined();
  });

  it("lets providerError carry retryable in either direction", () => {
    const transient = providerError({ routeRef: "route:openai", statusCode: 503, retryable: true });
    const permanent = providerError({
      routeRef: "route:openai",
      statusCode: 400,
      retryable: false
    });

    expect(transient.retryable).toBe(true);
    expect(permanent.retryable).toBe(false);
    expect(transient.code).toBe("provider_error");
    expect(permanent.code).toBe("provider_error");
  });

  it("lets providerError omit a route ref and status code", () => {
    const failure = providerError({ retryable: true });
    expect(failure.failure.routeRef).toBeUndefined();
    expect(failure.retryable).toBe(true);
  });

  it("covers every declared taxonomy code", () => {
    expect(new Set(coveredCodes())).toEqual(new Set(MODEL_ROUTING_FAILURE_CODES));
  });
});
