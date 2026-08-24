import {
  HOST_ROUTE_CONTRACTS,
  HostRouteRequestSchema,
  StreamingSensitiveMaterialDetector,
  admitHostResponse,
  createHostCommandEventResponseAdmission,
  type CancelCommandRequest,
  type CancelCommandResponse,
  type CommandAccepted,
  type DisposeEnvironmentRequest,
  type DisposeEnvironmentResponse,
  type HostResponseBodyByRoute,
  type InspectRepositoryRequest,
  type ListEnvironmentsResponse,
  type PrepareEnvironmentRequest,
  type ReadArtifactChunkRequest,
  type ReadArtifactChunkResponse,
  type ReadCommandEventsRequest,
  type RepositoryInspection,
  type RunnerSubscriptionItem,
  type StartCommandRequest
} from "@autostack/contracts";

const DEFAULT_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_EVENT_BYTES = 1024 * 1024;
const DEFAULT_SAFE_ATTEMPTS = 3;

export class InvalidHostResponseError extends Error {
  constructor() {
    super("Invalid host response.");
    this.name = "InvalidHostResponseError";
  }
}

export interface HostDaemonClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly maximumJsonBytes?: number;
  readonly maximumEventFrameBytes?: number;
  readonly safeReadAttempts?: number;
}

export interface HostDaemonClient {
  health(options?: {
    readonly signal?: AbortSignal;
  }): Promise<HostResponseBodyByRoute["GET /v1/health"]>;
  listEnvironments(options?: { readonly signal?: AbortSignal }): Promise<ListEnvironmentsResponse>;
  inspectRepository(
    request: InspectRepositoryRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<RepositoryInspection>;
  prepareEnvironment(
    request: PrepareEnvironmentRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<HostResponseBodyByRoute["POST /v1/environments"]>;
  startCommand(
    request: StartCommandRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<CommandAccepted>;
  openCommandEvents(
    request: ReadCommandEventsRequest,
    options?: { readonly signal?: AbortSignal }
  ): AsyncIterable<RunnerSubscriptionItem>;
  cancelCommand(
    request: CancelCommandRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<CancelCommandResponse>;
  readArtifactRange(
    request: ReadArtifactChunkRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<ReadArtifactChunkResponse>;
  disposeEnvironment(
    request: DisposeEnvironmentRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<DisposeEnvironmentResponse>;
}

const positiveBound = (value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1)
    throw new TypeError("Invalid host client limit.");
  return resolved;
};

const validateOrigin = (candidate: string): string => {
  const url = new URL(candidate);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    !Number.isSafeInteger(Number(url.port)) ||
    Number(url.port) < 1 ||
    Number(url.port) > 65535 ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    candidate !== `http://127.0.0.1:${url.port}`
  ) {
    throw new TypeError("Host origin must be canonical numeric loopback.");
  }
  return candidate;
};

const validateToken = (candidate: string): string => {
  const bytes = Buffer.byteLength(candidate, "utf8");
  if (
    bytes < 32 ||
    bytes > 4096 ||
    /^(?:change-?me|example|placeholder)$/i.test(candidate) ||
    new Set(candidate).size < 4
  ) {
    throw new TypeError("Host token is invalid.");
  }
  return candidate;
};

const boundedJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new InvalidHostResponseError();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) throw new InvalidHostResponseError();
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    if (text === "") throw new InvalidHostResponseError();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof InvalidHostResponseError) throw error;
    throw new InvalidHostResponseError();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response is already terminal.
    }
    reader.releaseLock();
  }
};

const appendOwnership = (
  url: URL,
  request: Omit<ReadCommandEventsRequest, "after"> & { readonly after?: number }
): void => {
  for (const key of [
    "workspaceId",
    "runId",
    "environmentAuthorizationId",
    "environmentAuthorizationDigest",
    "commandAuthorizationId",
    "commandAuthorizationDigest"
  ] as const) {
    url.searchParams.set(key, request[key]);
  }
  if (request.after !== undefined) url.searchParams.set("after", String(request.after));
};

export const createHostDaemonClient = (options: HostDaemonClientOptions): HostDaemonClient => {
  const origin = validateOrigin(options.origin);
  const token = validateToken(options.token);
  const fetchImplementation = options.fetch;
  const maximumJsonBytes = positiveBound(options.maximumJsonBytes, DEFAULT_JSON_BYTES);
  const maximumEventFrameBytes = positiveBound(options.maximumEventFrameBytes, DEFAULT_EVENT_BYTES);
  const safeReadAttempts = positiveBound(options.safeReadAttempts, DEFAULT_SAFE_ATTEMPTS);
  const sleep = options.sleep ?? (async () => undefined);

  const send = async (
    requestCandidate: unknown,
    path: string,
    method: string,
    signal: AbortSignal | undefined,
    safe: boolean,
    extraHeaders?: HeadersInit
  ): Promise<unknown> => {
    const request = HostRouteRequestSchema.parse(requestCandidate);
    const body = "body" in request ? JSON.stringify(request.body) : undefined;
    const attempts = safe ? safeReadAttempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = signal === undefined ? new AbortController() : undefined;
      const activeSignal = signal ?? controller!.signal;
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...extraHeaders
        },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: activeSignal
      };
      if (body !== undefined) init.body = body;
      let response: Response;
      try {
        response = await fetchImplementation(`${origin}${path}`, init);
      } catch (error) {
        if (activeSignal.aborted) throw error;
        if (attempt < attempts) {
          await sleep(Math.min(25 * 2 ** (attempt - 1), 200), activeSignal);
          continue;
        }
        throw new InvalidHostResponseError();
      }
      const retryable = new Set([502, 503, 504]).has(response.status);
      if (retryable && attempt < attempts) {
        await response.body?.cancel();
        await sleep(Math.min(25 * 2 ** (attempt - 1), 200), activeSignal);
        continue;
      }
      try {
        const candidate = await boundedJson(response, maximumJsonBytes);
        return admitHostResponse(request, {
          status: response.status,
          mediaType: response.headers.get("content-type") ?? "",
          body: candidate
        });
      } catch {
        throw new InvalidHostResponseError();
      }
    }
    throw new InvalidHostResponseError();
  };

  return {
    health: async (callOptions) =>
      (await send(
        { route: "GET /v1/health" },
        "/v1/health",
        "GET",
        callOptions?.signal,
        true
      )) as HostResponseBodyByRoute["GET /v1/health"],
    listEnvironments: async (callOptions) =>
      (await send(
        { route: "GET /v1/environments" },
        "/v1/environments",
        "GET",
        callOptions?.signal,
        true
      )) as ListEnvironmentsResponse,
    inspectRepository: async (request, callOptions) =>
      (await send(
        { route: "POST /v1/repositories/inspect", body: request },
        "/v1/repositories/inspect",
        "POST",
        callOptions?.signal,
        true
      )) as RepositoryInspection,
    prepareEnvironment: async (request, callOptions) =>
      (await send(
        { route: "POST /v1/environments", body: request },
        "/v1/environments",
        "POST",
        callOptions?.signal,
        false
      )) as HostResponseBodyByRoute["POST /v1/environments"],
    startCommand: async (request, callOptions) =>
      (await send(
        {
          route: "POST /v1/environments/:environmentId/commands",
          environmentId: request.environmentId,
          body: request
        },
        `/v1/environments/${encodeURIComponent(request.environmentId)}/commands`,
        "POST",
        callOptions?.signal,
        false
      )) as CommandAccepted,
    async *openCommandEvents(requestCandidate, callOptions) {
      const request = HostRouteRequestSchema.parse({
        route: "GET /v1/environments/:environmentId/commands/:commandId/events",
        environmentId: requestCandidate.environmentId,
        commandId: requestCandidate.commandId,
        query: requestCandidate
      });
      if (request.route !== "GET /v1/environments/:environmentId/commands/:commandId/events") {
        throw new InvalidHostResponseError();
      }
      const url = new URL(
        `/v1/environments/${encodeURIComponent(request.environmentId)}/commands/${encodeURIComponent(request.commandId)}/events`,
        `${origin}/`
      );
      appendOwnership(url, request.query);
      const init: RequestInit = {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        credentials: "omit",
        cache: "no-store"
      };
      if (callOptions?.signal !== undefined) init.signal = callOptions.signal;
      const response = await fetchImplementation(url, init);
      if (
        response.status !== HOST_ROUTE_CONTRACTS[request.route].successStatus ||
        response.headers.get("content-type") !== HOST_ROUTE_CONTRACTS[request.route].mediaType
      ) {
        await response.body?.cancel();
        throw new InvalidHostResponseError();
      }
      const reader = response.body?.getReader();
      if (reader === undefined) throw new InvalidHostResponseError();
      const admission = createHostCommandEventResponseAdmission(request);
      let pending = new Uint8Array();
      let transportTerminal = false;
      try {
        while (true) {
          const result = await reader.read();
          if (!result.done) {
            const combined = new Uint8Array(pending.byteLength + result.value.byteLength);
            combined.set(pending);
            combined.set(result.value, pending.byteLength);
            pending = combined;
          }
          while (true) {
            const newline = pending.indexOf(10);
            if (newline < 0) break;
            if (transportTerminal || newline === 0 || newline + 1 > maximumEventFrameBytes) {
              throw new InvalidHostResponseError();
            }
            const frameBytes = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (frameBytes.at(-1) === 13) throw new InvalidHostResponseError();
            let frameText: string;
            try {
              frameText = new TextDecoder("utf-8", { fatal: true }).decode(frameBytes);
            } catch {
              throw new InvalidHostResponseError();
            }
            const detector = new StreamingSensitiveMaterialDetector([token]);
            detector.write(frameText);
            if (detector.finalize()) throw new InvalidHostResponseError();
            let parsed: unknown;
            try {
              parsed = JSON.parse(frameText) as unknown;
            } catch {
              throw new InvalidHostResponseError();
            }
            let item: RunnerSubscriptionItem;
            try {
              item = admission.admit({
                status: 200,
                mediaType: "application/x-ndjson",
                body: parsed
              });
            } catch {
              throw new InvalidHostResponseError();
            }
            transportTerminal = admission.terminal;
            yield item;
            if (transportTerminal) {
              if (pending.byteLength !== 0) throw new InvalidHostResponseError();
              return;
            }
          }
          if (pending.byteLength >= maximumEventFrameBytes) throw new InvalidHostResponseError();
          if (result.done) {
            if (pending.byteLength !== 0) throw new InvalidHostResponseError();
            return;
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // The response is already terminal.
        }
        reader.releaseLock();
      }
    },
    cancelCommand: async (request, callOptions) =>
      (await send(
        {
          route: "POST /v1/environments/:environmentId/commands/:commandId/cancel",
          environmentId: request.environmentId,
          commandId: request.commandId,
          body: request
        },
        `/v1/environments/${encodeURIComponent(request.environmentId)}/commands/${encodeURIComponent(request.commandId)}/cancel`,
        "POST",
        callOptions?.signal,
        false
      )) as CancelCommandResponse,
    readArtifactRange: async (request, callOptions) => {
      const range = { start: request.offset, end: request.offset + request.length - 1 };
      const query = {
        workspaceId: request.workspaceId,
        runId: request.runId,
        environmentId: request.environmentId,
        commandId: request.commandId,
        environmentAuthorizationId: request.environmentAuthorizationId,
        environmentAuthorizationDigest: request.environmentAuthorizationDigest,
        commandAuthorizationId: request.commandAuthorizationId,
        commandAuthorizationDigest: request.commandAuthorizationDigest,
        range
      };
      const url = new URL(
        `/v1/artifacts/${encodeURIComponent(request.artifactId)}/content`,
        `${origin}/`
      );
      appendOwnership(url, query);
      url.searchParams.set("environmentId", query.environmentId);
      url.searchParams.set("commandId", query.commandId);
      const body = (await send(
        { route: "GET /v1/artifacts/:artifactId/content", artifactId: request.artifactId, query },
        `${url.pathname}${url.search}`,
        "GET",
        callOptions?.signal,
        true,
        { Range: `bytes=${range.start}-${range.end}` }
      )) as HostResponseBodyByRoute["GET /v1/artifacts/:artifactId/content"];
      return body.chunk;
    },
    disposeEnvironment: async (request, callOptions) =>
      (await send(
        {
          route: "DELETE /v1/environments/:environmentId",
          environmentId: request.environmentId,
          body: request
        },
        `/v1/environments/${encodeURIComponent(request.environmentId)}`,
        "DELETE",
        callOptions?.signal,
        false
      )) as DisposeEnvironmentResponse
  };
};
