import type { ModelRoutingError } from "@autostack/contracts";

import { providerError, rateLimited } from "./routing-failure.js";

/**
 * 4xx codes that describe the moment rather than the request — a client can retry these as-is.
 * 429 is handled separately as `rate_limited` before this set is consulted.
 */
const TRANSIENT_CLIENT_STATUS_CODES = new Set([408, 425]);

interface ClassifyHttpResponseInput {
  readonly routeRef: string;
  readonly status: number;
  readonly headers: Headers;
  readonly malformedBody?: boolean;
}

interface ClassifyNetworkErrorInput {
  readonly routeRef: string;
  readonly networkError: unknown;
}

export type ClassifyTransportResponseInput = ClassifyHttpResponseInput | ClassifyNetworkErrorInput;

const isNetworkErrorInput = (
  input: ClassifyTransportResponseInput
): input is ClassifyNetworkErrorInput => "networkError" in input;

/**
 * Maps a transport-level HTTP response or network failure to the routing failure taxonomy
 * (spec §14.1). Every branch composes its message from safe values only — the route ref and the
 * HTTP status code — and never reads a response body or a header value, either of which could
 * carry a credential. The classifier does not even accept a body: a value it cannot read is a
 * value it cannot leak.
 *
 * Retryability follows the contract's own doctrine (deterministic codes describe the request,
 * transient codes describe the moment): a 5xx is a provider fault and is always retryable; a 4xx
 * describes the request itself and is not retryable, except the small set of genuinely transient
 * 4xx statuses (408 Request Timeout, 425 Too Early — 429 is handled earlier as `rate_limited`). A
 * malformed response body only decides retryability when the status itself does not — a 2xx whose
 * payload failed to parse is a transient transport fault, but a non-2xx status (e.g. a 401 fronted
 * by a proxy's non-JSON error page) must not be masked into "retryable" by a junk body.
 */
export const classifyTransportResponse = (
  input: ClassifyTransportResponseInput
): ModelRoutingError => {
  if (isNetworkErrorInput(input)) {
    return providerError({ routeRef: input.routeRef, retryable: true });
  }

  const { routeRef, status, headers, malformedBody } = input;

  if (status === 429) {
    return rateLimited({ routeRef, statusCode: status });
  }
  if (status === 503 && headers.has("retry-after")) {
    return rateLimited({ routeRef, statusCode: status });
  }
  if (status >= 500) {
    return providerError({ routeRef, statusCode: status, retryable: true });
  }
  if (status >= 400) {
    return providerError({
      routeRef,
      statusCode: status,
      retryable: TRANSIENT_CLIENT_STATUS_CODES.has(status)
    });
  }
  if (malformedBody === true && status >= 200 && status < 300) {
    return providerError({ routeRef, statusCode: status, retryable: true });
  }
  // An unexpected 1xx/2xx/3xx reaching the classifier (with no malformed-body signal) is treated
  // as a transient transport fault rather than guessed at.
  return providerError({ routeRef, statusCode: status, retryable: true });
};
