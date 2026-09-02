import {
  AnswerClarificationRequestSchema,
  AnswerClarificationResponseSchema,
  ApprovalDecisionRequestSchema,
  ApprovalDecisionResponseSchema,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  type DesktopApiOperationMap,
  HealthResponseSchema,
  ListApprovalsResponseSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  RunIdSchema,
  SteerRunRequestSchema,
  SteerRunResponseSchema,
  type AnswerClarificationRequest,
  type AnswerClarificationResponse,
  type ApprovalDecisionRequest,
  type ApprovalDecisionResponse,
  type ApprovalSummary,
  type CancelRunRequest,
  type CancelRunResponse,
  type CreateRunRequest,
  type CreateRunResponse,
  type HealthResponse,
  type ListApprovalsResponse,
  type ListEventsResponse,
  type ListRunsResponse,
  type SteerRunRequest,
  type SteerRunResponse
} from "@autostack/contracts";

import {
  ApiConflictError,
  ApiOperationUnavailableError,
  ApiRequestValidationError
} from "./api-errors.js";
import { createIdempotencyKeyFactory } from "./idempotency.js";

export class ApiAuthenticationError extends Error {
  constructor() {
    super("Authentication is required.");
    this.name = "ApiAuthenticationError";
  }
}

export class ApiResponseError extends Error {
  constructor() {
    super("The AutoStack control plane returned an invalid or unavailable response.");
    this.name = "ApiResponseError";
  }
}

/** Query for `listApprovals`. Every field is optional; the server applies its own defaults. */
export interface ListApprovalsQueryInput {
  readonly status?: ApprovalSummary["status"] | "all";
  readonly limit?: number;
  readonly cursor?: number;
}

export interface AutoStackApiClient {
  health(signal?: AbortSignal): Promise<HealthResponse>;
  listRuns(cursor?: number, signal?: AbortSignal): Promise<ListRunsResponse>;
  listRunEvents(
    runId: string,
    afterGlobalSequence?: number,
    signal?: AbortSignal
  ): Promise<ListEventsResponse>;
  createRun(input: CreateRunRequest, signal?: AbortSignal): Promise<CreateRunResponse>;
  listApprovals(
    query?: ListApprovalsQueryInput,
    signal?: AbortSignal
  ): Promise<ListApprovalsResponse>;
  decideApproval(
    runId: string,
    approvalId: string,
    input: ApprovalDecisionRequest,
    signal?: AbortSignal
  ): Promise<ApprovalDecisionResponse>;
  steerRun(runId: string, input: SteerRunRequest, signal?: AbortSignal): Promise<SteerRunResponse>;
  cancelRun(
    runId: string,
    input: CancelRunRequest,
    signal?: AbortSignal
  ): Promise<CancelRunResponse>;
  answerClarification(
    runId: string,
    clarificationRef: string,
    input: AnswerClarificationRequest,
    signal?: AbortSignal
  ): Promise<AnswerClarificationResponse>;
}

export interface CreateApiClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly fetch?: typeof globalThis.fetch;
  /** Injected UUID source for the steer/cancel `Idempotency-Key` header. Defaults to a real one. */
  readonly createIdempotencyKey?: () => string;
}

export interface DesktopFactoryBridge {
  request<K extends keyof DesktopApiOperationMap>(
    input: DesktopApiOperationMap[K]["request"]
  ): Promise<DesktopApiOperationMap[K]["response"]>;
}

export interface CreateDesktopApiClientOptions {
  readonly bridge: DesktopFactoryBridge;
  readonly createIdempotencyKey?: () => string;
}

const assertNotAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
};

/**
 * Structural shape of a Zod object schema's `safeParse`, narrowed to what `parseRequestBody`
 * needs. This avoids importing `zod` directly into `@autostack/client-app`, which does not
 * declare it as a dependency; the request schemas imported from `@autostack/contracts` already
 * satisfy this shape.
 */
interface RequestSchema<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] };
      };
}

/**
 * Validates a request body locally, before any network call. On rejection this throws
 * `ApiRequestValidationError` naming the offending field — never the offending value, which may
 * itself be the credential material the schema rejected.
 */
const parseRequestBody = <T>(schema: RequestSchema<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const firstIssue = result.error.issues[0];
  const field =
    firstIssue !== undefined && firstIssue.path.length > 0
      ? firstIssue.path.map(String).join(".")
      : "request";
  throw new ApiRequestValidationError(field);
};

export function createDesktopApiClient(options: CreateDesktopApiClientOptions): AutoStackApiClient {
  const createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
  return {
    async health(signal) {
      assertNotAborted(signal);
      return await options.bridge.request<"factory.health">({ operation: "factory.health" });
    },
    async listRuns(cursor, signal) {
      assertNotAborted(signal);
      return await options.bridge.request<"factory.runs.list">({
        operation: "factory.runs.list",
        ...(cursor === undefined ? {} : { cursor })
      });
    },
    async listRunEvents(runId, afterGlobalSequence = 0, signal) {
      assertNotAborted(signal);
      return await options.bridge.request<"factory.runs.events">({
        operation: "factory.runs.events",
        runId: RunIdSchema.parse(runId),
        after: afterGlobalSequence
      });
    },
    async createRun(input, signal) {
      assertNotAborted(signal);
      return await options.bridge.request<"factory.runs.create">({
        operation: "factory.runs.create",
        request: CreateRunRequestSchema.parse(input),
        idempotencyKey: createIdempotencyKey()
      });
    },
    // D1: the operation now exists in `DesktopApiOperationMap`, but the main-process dispatch arm
    // that services it is Wave 2 work — the contract landed ahead of its handler.
    // No fake data, no silent no-op, no cast to smuggle an unmodelled operation through
    // `bridge.request`: this throws before the bridge is ever touched.
    async listApprovals(_query, signal) {
      assertNotAborted(signal);
      throw new ApiOperationUnavailableError("factory.approvals.list");
    },
    // D1, as above — no `factory.approvals.*` member yet.
    async decideApproval(_runId, _approvalId, _input, signal) {
      assertNotAborted(signal);
      throw new ApiOperationUnavailableError("factory.approvals.decide");
    },
    // D1, as above — no `factory.runs.steer` member yet.
    async steerRun(_runId, _input, signal) {
      assertNotAborted(signal);
      throw new ApiOperationUnavailableError("factory.runs.steer");
    },
    // D1, as above — no `factory.runs.cancel` member yet.
    async cancelRun(_runId, _input, signal) {
      assertNotAborted(signal);
      throw new ApiOperationUnavailableError("factory.runs.cancel");
    },
    // D1, as above — no `factory.runs.answer` member yet.
    async answerClarification(_runId, _clarificationRef, _input, signal) {
      assertNotAborted(signal);
      throw new ApiOperationUnavailableError("factory.runs.answer");
    }
  };
}

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export function createApiClient(options: CreateApiClientOptions): AutoStackApiClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const createIdempotencyKey = options.createIdempotencyKey ?? createIdempotencyKeyFactory();

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImplementation(`${baseUrl}${path}`, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiResponseError();
    }
  };

  const authenticatedHeaders = (): Headers => {
    const token = options.getToken();
    if (token === null || token.length === 0) throw new ApiAuthenticationError();
    return new Headers({ Authorization: `Bearer ${token}` });
  };

  const decode = async <T>(
    response: Response,
    schema: { parse(value: unknown): T }
  ): Promise<T> => {
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ApiResponseError();
    }
  };

  return {
    async health(signal) {
      const response = await request("/v1/health", {
        ...(signal === undefined ? {} : { signal })
      });
      if (response.status !== 200 && response.status !== 503) throw new ApiResponseError();
      return decode(response, HealthResponseSchema);
    },

    async listRuns(cursor, signal) {
      const response = await request(
        cursor === undefined ? "/v1/runs" : `/v1/runs?cursor=${encodeURIComponent(String(cursor))}`,
        {
          headers: authenticatedHeaders(),
          ...(signal === undefined ? {} : { signal })
        }
      );
      if (response.status === 401) throw new ApiAuthenticationError();
      if (!response.ok) throw new ApiResponseError();
      return decode(response, ListRunsResponseSchema);
    },

    async listRunEvents(runId, afterGlobalSequence = 0, signal) {
      const response = await request(
        `/v1/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(
          String(afterGlobalSequence)
        )}`,
        {
          headers: authenticatedHeaders(),
          ...(signal === undefined ? {} : { signal })
        }
      );
      if (response.status === 401) throw new ApiAuthenticationError();
      if (!response.ok) throw new ApiResponseError();
      return decode(response, ListEventsResponseSchema);
    },

    async createRun(input, signal) {
      const headers = authenticatedHeaders();
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", globalThis.crypto.randomUUID());
      const response = await request("/v1/runs", {
        method: "POST",
        headers,
        body: JSON.stringify(CreateRunRequestSchema.parse(input)),
        ...(signal === undefined ? {} : { signal })
      });
      if (response.status === 401) throw new ApiAuthenticationError();
      if (!response.ok) throw new ApiResponseError();
      return decode(response, CreateRunResponseSchema);
    },

    async listApprovals(query, signal) {
      assertNotAborted(signal);
      const params = new URLSearchParams();
      if (query?.status !== undefined) params.set("status", query.status);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      if (query?.cursor !== undefined) params.set("cursor", String(query.cursor));
      const queryString = params.toString();
      const response = await request(
        `/v1/approvals${queryString.length > 0 ? `?${queryString}` : ""}`,
        {
          headers: authenticatedHeaders(),
          ...(signal === undefined ? {} : { signal })
        }
      );
      if (response.status === 401) throw new ApiAuthenticationError();
      if (response.status === 409) throw new ApiConflictError();
      if (!response.ok) throw new ApiResponseError();
      return decode(response, ListApprovalsResponseSchema);
    },

    async decideApproval(runId, approvalId, input, signal) {
      assertNotAborted(signal);
      const body = parseRequestBody(ApprovalDecisionRequestSchema, input);
      const headers = authenticatedHeaders();
      headers.set("Content-Type", "application/json");
      // D2: the server derives its own idempotency key from
      // `${approvalId}:${decision}:${evidenceDigest}` and ignores any client-supplied header.
      // Sending one would imply a contract that does not exist, so this route sends no
      // `Idempotency-Key` header at all.
      const response = await request(
        `/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal })
        }
      );
      if (response.status === 401) throw new ApiAuthenticationError();
      // Both `version_conflict` (a stale evidenceDigest) and `idempotency_conflict` (a
      // conflicting decision) surface identically here — D2 rules them indistinguishable to the
      // client, so this deliberately does not branch on `error.code`.
      if (response.status === 409) throw new ApiConflictError();
      if (!response.ok) throw new ApiResponseError();
      return decode(response, ApprovalDecisionResponseSchema);
    },

    async steerRun(runId, input, signal) {
      assertNotAborted(signal);
      const body = parseRequestBody(SteerRunRequestSchema, input);
      const headers = authenticatedHeaders();
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", createIdempotencyKey());
      const response = await request(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal })
      });
      if (response.status === 401) throw new ApiAuthenticationError();
      if (response.status === 409) throw new ApiConflictError();
      if (!response.ok) throw new ApiResponseError();
      return decode(response, SteerRunResponseSchema);
    },

    async cancelRun(runId, input, signal) {
      assertNotAborted(signal);
      const body = parseRequestBody(CancelRunRequestSchema, input);
      const headers = authenticatedHeaders();
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", createIdempotencyKey());
      const response = await request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal })
      });
      if (response.status === 401) throw new ApiAuthenticationError();
      if (response.status === 409) throw new ApiConflictError();
      if (!response.ok) throw new ApiResponseError();
      return decode(response, CancelRunResponseSchema);
    },

    async answerClarification(runId, clarificationRef, input, signal) {
      assertNotAborted(signal);
      const body = parseRequestBody(AnswerClarificationRequestSchema, input);
      const headers = authenticatedHeaders();
      headers.set("Content-Type", "application/json");
      // Idempotency is server-derived from the clarification ref and answer content, and
      // `actorId` comes from authenticated context — mirroring D2's approval-decision pattern, so
      // this sends neither an `Idempotency-Key` header nor an `actorId` field.
      const response = await request(
        `/v1/runs/${encodeURIComponent(runId)}/clarifications/${encodeURIComponent(clarificationRef)}/answer`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal })
        }
      );
      if (response.status === 401) throw new ApiAuthenticationError();
      if (response.status === 409) throw new ApiConflictError();
      if (!response.ok) throw new ApiResponseError();
      return decode(response, AnswerClarificationResponseSchema);
    }
  };
}
