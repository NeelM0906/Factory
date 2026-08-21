import {
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  HealthResponseSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  type CreateRunRequest,
  type CreateRunResponse,
  type HealthResponse,
  type ListEventsResponse,
  type ListRunsResponse
} from "@autostack/contracts";

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

export interface AutoStackApiClient {
  health(signal?: AbortSignal): Promise<HealthResponse>;
  listRuns(cursor?: number, signal?: AbortSignal): Promise<ListRunsResponse>;
  listRunEvents(
    runId: string,
    afterGlobalSequence?: number,
    signal?: AbortSignal
  ): Promise<ListEventsResponse>;
  createRun(input: CreateRunRequest, signal?: AbortSignal): Promise<CreateRunResponse>;
}

export interface CreateApiClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly fetch?: typeof globalThis.fetch;
}

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

export function createApiClient(options: CreateApiClientOptions): AutoStackApiClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? globalThis.fetch;

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
    }
  };
}
