import type { ModelRoutingError } from "@autostack/contracts";

import { providerError, rateLimited } from "./routing-failure.js";

const RETRYABLE_SERVER_STATUS_CODES = new Set([500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

interface ClassifyHttpResponseInput {
  readonly routeRef: string;
  readonly status: number;
  readonly headers: Headers;
  /** Never read for its content — present only so callers cannot accidentally leak it. */
  readonly body?: unknown;
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
 * HTTP status code — and never reads the response body or a header value, either of which could
 * carry a credential.
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
  if (RETRYABLE_SERVER_STATUS_CODES.has(status)) {
    return providerError({ routeRef, statusCode: status, retryable: true });
  }
  if (malformedBody === true) {
    return providerError({ routeRef, statusCode: status, retryable: true });
  }
  if (NON_RETRYABLE_STATUS_CODES.has(status)) {
    return providerError({ routeRef, statusCode: status, retryable: false });
  }
  // Any other status the taxonomy has not seen before is treated as a transient transport fault
  // rather than guessed at — a caller can retry and, if the fault repeats, escalate.
  return providerError({ routeRef, statusCode: status, retryable: true });
};
