import { ModelRoutingError, type ModelRoutingFailureCode } from "@autostack/contracts";

/**
 * Builders for the routing failure taxonomy (`@autostack/contracts` `MODEL_ROUTING_FAILURE_CODES`).
 * Retryability is not a parameter for the four codes the contract's `ModelRoutingFailureSchema`
 * refinement constrains — `capability_unavailable`, `route_disabled`, and `budget_exceeded` are
 * always `false`, `rate_limited` is always `true` — so a builder can never construct a value the
 * refinement rejects. `providerError` is the one code whose retryability depends on the transport
 * fault observed, so it is the one builder that takes `retryable` as an argument.
 *
 * Operator text is composed only from safe values already validated elsewhere in the pipeline:
 * route refs, capability names, and HTTP status codes. It never carries a response body, header
 * value, or URL, any of which could carry a credential (spec §14.1).
 */

interface CapabilityUnavailableInput {
  readonly required: readonly string[];
  readonly absentPins: readonly string[];
}

export const capabilityUnavailable = (input: CapabilityUnavailableInput): ModelRoutingError => {
  const parts: string[] = [];
  if (input.required.length > 0) {
    parts.push(`missing required capabilities: ${input.required.join(", ")}`);
  }
  if (input.absentPins.length > 0) {
    parts.push(`pinned model absent from catalog for routes: ${input.absentPins.join(", ")}`);
  }
  const message =
    parts.length > 0
      ? `No route satisfies the required capabilities (${parts.join("; ")}).`
      : "No route satisfies the required capabilities.";
  return new ModelRoutingError({
    schemaVersion: 1,
    code: "capability_unavailable",
    message,
    retryable: false
  });
};

interface RouteDisabledInput {
  readonly routeRef: string;
  readonly required: readonly string[];
}

export const routeDisabled = (input: RouteDisabledInput): ModelRoutingError =>
  new ModelRoutingError({
    schemaVersion: 1,
    code: "route_disabled",
    message: `Route ${input.routeRef} declares the required capabilities (${input.required.join(", ")}) but is disabled.`,
    retryable: false,
    routeRef: input.routeRef
  });

interface BudgetExceededInput {
  readonly routeRef?: string;
  readonly ceiling: "maxCostMicros" | "maxInputTokens" | "maxOutputTokens";
}

export const budgetExceeded = (input: BudgetExceededInput): ModelRoutingError =>
  new ModelRoutingError({
    schemaVersion: 1,
    code: "budget_exceeded",
    message:
      input.routeRef === undefined
        ? `No route satisfies the policy ceiling ${input.ceiling}.`
        : `Route ${input.routeRef} exceeds the policy ceiling ${input.ceiling}.`,
    retryable: false,
    ...(input.routeRef === undefined ? {} : { routeRef: input.routeRef })
  });

interface RateLimitedInput {
  readonly routeRef?: string;
  readonly statusCode?: number;
}

export const rateLimited = (input: RateLimitedInput): ModelRoutingError =>
  new ModelRoutingError({
    schemaVersion: 1,
    code: "rate_limited",
    message:
      input.statusCode === undefined
        ? `Route${input.routeRef === undefined ? "" : ` ${input.routeRef}`} was rate limited.`
        : `Route${input.routeRef === undefined ? "" : ` ${input.routeRef}`} was rate limited (HTTP ${input.statusCode}).`,
    retryable: true,
    ...(input.routeRef === undefined ? {} : { routeRef: input.routeRef })
  });

interface ProviderErrorInput {
  readonly routeRef?: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
}

export const providerError = (input: ProviderErrorInput): ModelRoutingError =>
  new ModelRoutingError({
    schemaVersion: 1,
    code: "provider_error",
    message:
      input.statusCode === undefined
        ? `Route${input.routeRef === undefined ? "" : ` ${input.routeRef}`} returned a provider error.`
        : `Route${input.routeRef === undefined ? "" : ` ${input.routeRef}`} returned a provider error (HTTP ${input.statusCode}).`,
    retryable: input.retryable,
    ...(input.routeRef === undefined ? {} : { routeRef: input.routeRef })
  });

/**
 * One builder per taxonomy member, keyed by the code it produces. `coveredCodes()` is derived from
 * this table's own keys, so a taxonomy member added to `MODEL_ROUTING_FAILURE_CODES` without a
 * corresponding builder here fails the "covers every declared taxonomy code" test rather than
 * silently narrowing the failure surface S3 can raise.
 */
const BUILDER_TABLE: Record<ModelRoutingFailureCode, unknown> = {
  capability_unavailable: capabilityUnavailable,
  route_disabled: routeDisabled,
  budget_exceeded: budgetExceeded,
  rate_limited: rateLimited,
  provider_error: providerError
};

export const coveredCodes = (): ModelRoutingFailureCode[] =>
  Object.keys(BUILDER_TABLE) as ModelRoutingFailureCode[];
