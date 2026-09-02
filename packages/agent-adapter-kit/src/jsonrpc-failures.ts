/**
 * JSON-RPC error code → adapter failure code mapping.
 *
 * Shared by ACP and Codex app-server, since both are JSON-RPC 2.0. Classification reads
 * only `error.code`, never `error.message` — provider message text is untrusted input
 * (spec §14.1) and retryability is a policy branch, not a prose interpretation.
 */

import { classifyFailure, type ClassifiedFailure, type TaxonomyCode } from "./failure-taxonomy.js";

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Classify a JSON-RPC error into the adapter's failure taxonomy.
 *
 * | JSON-RPC `error.code`  | Adapter code                |
 * | ---------------------- | --------------------------- |
 * | `-32700`, `-32600`     | `provider_protocol_invalid` |
 * | `-32601`               | `capability_unavailable`    |
 * | `-32602`               | `provider_request_rejected` |
 * | `-32603`               | `provider_internal_error`   |
 * | `-32000`…`-32099`      | `provider_unavailable`      |
 * | any other numeric code | `provider_error`            |
 */
export const classifyJsonRpcError = (error: JsonRpcError): ClassifiedFailure => {
  const taxonomyCode = mapErrorCode(error.code);
  return classifyFailure(taxonomyCode);
};

const mapErrorCode = (code: number): TaxonomyCode => {
  switch (code) {
    case -32700:
    case -32600:
      return "provider_protocol_invalid";
    case -32601:
      return "capability_unavailable";
    case -32602:
      return "provider_request_rejected";
    case -32603:
      return "provider_internal_error";
    default:
      if (code >= -32099 && code <= -32000) {
        return "provider_unavailable";
      }
      return "provider_error";
  }
};
