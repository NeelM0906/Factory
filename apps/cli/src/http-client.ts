import {
  HealthResponseSchema,
  LocalArtifactReadResponseSchema,
  LocalCancelResponseSchema,
  LocalDisposeResponseSchema,
  LocalEventFrameSchema,
  LocalInspectResponseSchema,
  LocalListEnvironmentsResponseSchema,
  LocalPrepareResponseSchema,
  LocalStartResponseSchema,
  ListRunsResponseSchema,
  type LocalArtifactReadRequest,
  type LocalCancelRequest,
  type LocalDisposeRequest,
  type LocalEventsRequest,
  type LocalInspectRequest,
  type LocalPrepareRequest,
  type LocalStartRequest,
  type HealthResponse,
  type ListRunsResponse
} from "@autostack/contracts";

export class CliAuthenticationError extends Error {
  constructor() {
    super("Authentication failed.");
    this.name = "CliAuthenticationError";
  }
}

export class ControlPlaneUnavailableError extends Error {
  constructor() {
    super("Control plane unavailable.");
    this.name = "ControlPlaneUnavailableError";
  }
}

export interface AutoStackHttpClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
}

export class AutoStackHttpClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AutoStackHttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch;
  }

  async health(): Promise<HealthResponse> {
    const response = await this.#request("/v1/health", false);
    if (response.status !== 200 && response.status !== 503) {
      throw new ControlPlaneUnavailableError();
    }
    return this.#decode(response, HealthResponseSchema);
  }

  async listRuns(): Promise<ListRunsResponse> {
    const response = await this.#request("/v1/runs", true);
    if (response.status === 401) throw new CliAuthenticationError();
    if (!response.ok) throw new ControlPlaneUnavailableError();
    return this.#decode(response, ListRunsResponseSchema);
  }

  async localInspect(request: LocalInspectRequest) {
    return this.#localJson(
      "/v1/local/repositories/inspect",
      "POST",
      request,
      LocalInspectResponseSchema
    );
  }

  async localList() {
    return this.#localJson(
      "/v1/local/environments",
      "GET",
      undefined,
      LocalListEnvironmentsResponseSchema
    );
  }

  async localPrepare(request: LocalPrepareRequest, idempotencyKey: string) {
    return this.#localJson(
      "/v1/local/environments",
      "POST",
      request,
      LocalPrepareResponseSchema,
      idempotencyKey
    );
  }

  async localStart(request: LocalStartRequest, idempotencyKey: string) {
    return this.#localJson(
      `/v1/local/environments/${encodeURIComponent(request.environmentId)}/commands`,
      "POST",
      request,
      LocalStartResponseSchema,
      idempotencyKey
    );
  }

  async *localEvents(request: LocalEventsRequest) {
    const response = await this.#request(
      `/v1/local/environments/${encodeURIComponent(request.environmentId)}/commands/${encodeURIComponent(request.commandId)}/events?after=${request.after}`,
      true
    );
    if (!response.ok || response.headers.get("content-type") !== "application/x-ndjson")
      throw new ControlPlaneUnavailableError();
    const reader = response.body?.getReader();
    if (reader === undefined) throw new ControlPlaneUnavailableError();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        if (pending.length > 1_048_576) throw new ControlPlaneUnavailableError();
        while (pending.includes("\n")) {
          const newline = pending.indexOf("\n");
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line === "" || line.endsWith("\r")) throw new ControlPlaneUnavailableError();
          yield LocalEventFrameSchema.parse(JSON.parse(line) as unknown);
        }
      }
      pending += decoder.decode();
      if (pending !== "") throw new ControlPlaneUnavailableError();
    } catch {
      throw new ControlPlaneUnavailableError();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async localCancel(request: LocalCancelRequest) {
    return this.#localJson(
      `/v1/local/environments/${encodeURIComponent(request.environmentId)}/commands/${encodeURIComponent(request.commandId)}/cancel`,
      "POST",
      request,
      LocalCancelResponseSchema
    );
  }

  async localArtifact(request: LocalArtifactReadRequest) {
    return this.#localJson(
      `/v1/local/artifacts/${encodeURIComponent(request.artifactId)}/content?offset=${request.offset}&length=${request.length}`,
      "GET",
      undefined,
      LocalArtifactReadResponseSchema
    );
  }

  async localDispose(request: LocalDisposeRequest) {
    return this.#localJson(
      `/v1/local/environments/${encodeURIComponent(request.environmentId)}`,
      "DELETE",
      request,
      LocalDisposeResponseSchema
    );
  }

  async #request(path: string, authenticated: boolean, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.#fetch(
        `${this.#baseUrl}${path}`,
        authenticated
          ? {
              ...init,
              headers: { Authorization: `Bearer ${this.#token}`, ...init.headers }
            }
          : init
      );
    } catch {
      throw new ControlPlaneUnavailableError();
    }
  }

  async #localJson<T>(
    path: string,
    method: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    idempotencyKey?: string
  ): Promise<T> {
    const response = await this.#request(path, true, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (response.status === 401) throw new CliAuthenticationError();
    if (!response.ok) throw new ControlPlaneUnavailableError();
    return this.#decode(response, schema);
  }

  async #decode<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ControlPlaneUnavailableError();
    }
  }
}
