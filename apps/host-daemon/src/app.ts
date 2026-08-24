import { createHash, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";
import { ZodError } from "zod";

import {
  CancelCommandResponseSchema,
  CommandAcceptedSchema,
  DisposeEnvironmentResponseSchema,
  HostArtifactContentResponseSchema,
  HostErrorSchema,
  HostHealthResponseSchema,
  HostRouteRequestSchema,
  ListEnvironmentsResponseSchema,
  PreparedEnvironmentSchema,
  RepositoryInspectionSchema,
  containsSensitiveMaterial,
  createHostCommandEventResponseAdmission,
  normalizeSafeJson,
  validateArtifactChunkResponse,
  type HostRouteRequest,
  type PrepareEnvironmentRequest,
  type PreparedEnvironment,
  type ReadCommandEventsRequest,
  type RunnerSubscriptionItem
} from "@autostack/contracts";
import type { RunnerProvider } from "@autostack/domain";
import { LocalRunnerProviderError } from "@autostack/runner-local";

import type { HostIngressState } from "./shutdown.js";

const MAX_BODY_BYTES = 32 * 1_024 * 1_024;
const MAX_AUTH_BYTES = 4_103;
const JSON_MEDIA_TYPE = /^application\/json(?:;\s*charset=utf-8)?$/i;
const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
} as const;

type HostStatus = 400 | 401 | 403 | 404 | 409 | 413 | 416 | 422 | 500 | 503;
type HostCode =
  | "unauthorized"
  | "invalid_request"
  | "request_too_large"
  | "not_found"
  | "idempotency_conflict"
  | "scope_mismatch"
  | "authorization_invalid"
  | "authorization_expired"
  | "unsupported_policy"
  | "environment_not_prepared"
  | "command_not_found"
  | "artifact_not_found"
  | "range_not_satisfiable"
  | "environment_active"
  | "internal_error";

class HostProblem extends Error {
  constructor(
    readonly status: HostStatus,
    readonly code: HostCode,
    message: string
  ) {
    super(message);
  }
}

export interface HostBearerAuthenticator {
  authenticate(header: string | undefined): boolean;
}

export const createHostBearerAuthenticator = (token: string): HostBearerAuthenticator => {
  const expected = createHash("sha256").update(token).digest();
  return {
    authenticate(header) {
      const bounded = header !== undefined && Buffer.byteLength(header) <= MAX_AUTH_BYTES;
      const match = bounded ? /^Bearer ([^\s,]+)$/.exec(header!) : null;
      const candidate = createHash("sha256")
        .update(match?.[1] ?? "")
        .digest();
      return timingSafeEqual(expected, candidate) && match !== null;
    }
  };
};

export type HostStructuredLogger = (record: {
  readonly event: "request.complete" | "request.error";
  readonly requestId: string;
  readonly status: number;
}) => void;

export interface HostAppDependencies {
  readonly runner: RunnerProvider;
  readonly ingress: HostIngressState;
  readonly auth: HostBearerAuthenticator;
  readonly prepareWithReplay: (
    request: PrepareEnvironmentRequest
  ) => Promise<{ readonly environment: PreparedEnvironment; readonly replayed: boolean }>;
  readonly terminalizeProtocolFailure: (request: ReadCommandEventsRequest) => Promise<void>;
  readonly requestId: () => string;
  readonly log: HostStructuredLogger;
  readonly isSensitive?: (serializedFrame: string) => boolean;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...COMMON_HEADERS, "Content-Type": "application/json" }
  });

const problemResponse = (problem: HostProblem, requestId: string): Response =>
  jsonResponse(
    HostErrorSchema.parse({
      error: { code: problem.code, message: problem.message },
      requestId
    }),
    problem.status
  );

const mapLocalRunnerProblem = (error: LocalRunnerProviderError): HostProblem => {
  switch (error.code) {
    case "invalid_request":
    case "invalid_path":
      return new HostProblem(400, "invalid_request", "The host request is invalid.");
    case "conflict":
      return new HostProblem(
        409,
        "idempotency_conflict",
        "The request conflicts with existing state."
      );
    case "authorization_mismatch":
    case "terminal_evidence_invalid":
      return new HostProblem(403, "scope_mismatch", "The request is outside its authorized scope.");
    case "authorization_stale":
      return new HostProblem(403, "authorization_expired", "The authorization is not current.");
    case "missing_credential":
      return new HostProblem(
        403,
        "authorization_invalid",
        "Required authorization is unavailable."
      );
    case "unsupported_policy":
      return new HostProblem(
        422,
        "unsupported_policy",
        "The requested execution policy is unsupported."
      );
    case "environment_not_prepared":
      return new HostProblem(409, "environment_not_prepared", "The environment is not prepared.");
    case "command_not_found":
      return new HostProblem(404, "command_not_found", "The command is unavailable.");
    case "artifact_not_found":
      return new HostProblem(404, "artifact_not_found", "The artifact is unavailable.");
    case "active_command":
    case "active_run":
    case "dirty_worktree":
      return new HostProblem(409, "environment_active", "The environment cannot be disposed.");
    case "root_busy":
      return new HostProblem(503, "internal_error", "The host is temporarily unavailable.");
    case "closed":
    case "maintenance_required":
    case "unsafe_state":
      return new HostProblem(500, "internal_error", "The host request could not be completed.");
  }
};

const readJsonBody = async (request: Request): Promise<unknown> => {
  if (!JSON_MEDIA_TYPE.test(request.headers.get("content-type") ?? "")) {
    throw new HostProblem(400, "invalid_request", "A JSON request body is required.");
  }
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength))
      throw new HostProblem(400, "invalid_request", "Content length is invalid.");
    if (Number(rawLength) > MAX_BODY_BYTES)
      throw new HostProblem(413, "request_too_large", "The request body is too large.");
  }
  const reader = request.body?.getReader();
  if (reader === undefined)
    throw new HostProblem(400, "invalid_request", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HostProblem(413, "request_too_large", "The request body is too large.");
      }
      chunks.push(chunk.value);
    }
    const bytes = Buffer.concat(chunks, total);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text === "") throw new Error("empty");
    return normalizeSafeJson(JSON.parse(text));
  } catch (error) {
    if (error instanceof HostProblem) throw error;
    throw new HostProblem(400, "invalid_request", "The request body is invalid.");
  }
};

const exactQuery = (request: Request, allowed: readonly string[]): Record<string, string> => {
  const entries = [...new URL(request.url).searchParams.entries()];
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!allowed.includes(key) || result[key] !== undefined || value === "") {
      throw new HostProblem(400, "invalid_request", "The request query is invalid.");
    }
    result[key] = value;
  }
  return result;
};

const parseAfter = (value: string | undefined): number => {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new HostProblem(400, "invalid_request", "The event cursor is invalid.");
  }
  return Number(value);
};

const parseRange = (value: string | null): { start: number; end: number } => {
  const match = value === null ? null : /^bytes=(\d+)-(\d+)$/.exec(value);
  if (match === null)
    throw new HostProblem(416, "range_not_satisfiable", "The byte range is invalid.");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    end - start + 1 > 1_048_576
  ) {
    throw new HostProblem(416, "range_not_satisfiable", "The byte range is invalid.");
  }
  return { start, end };
};

const EVENT_QUERY_KEYS = [
  "workspaceId",
  "runId",
  "environmentAuthorizationId",
  "environmentAuthorizationDigest",
  "commandAuthorizationId",
  "commandAuthorizationDigest",
  "after"
] as const;
const ARTIFACT_QUERY_KEYS = [
  "workspaceId",
  "runId",
  "environmentId",
  "commandId",
  "environmentAuthorizationId",
  "environmentAuthorizationDigest",
  "commandAuthorizationId",
  "commandAuthorizationDigest"
] as const;

export const HOST_ROUTE_INVENTORY = [
  "GET /v1/health",
  "GET /v1/environments",
  "POST /v1/repositories/inspect",
  "POST /v1/environments",
  "POST /v1/environments/:environmentId/commands",
  "GET /v1/environments/:environmentId/commands/:commandId/events",
  "POST /v1/environments/:environmentId/commands/:commandId/cancel",
  "GET /v1/artifacts/:artifactId/content",
  "DELETE /v1/environments/:environmentId"
] as const;

export const createHostApp = (dependencies: HostAppDependencies): Hono => {
  const app = new Hono();
  app.use("*", async (context, next) => {
    if (context.req.path === "/v1" || context.req.path.startsWith("/v1/")) {
      const values = context.req.raw.headers.get("authorization");
      if (!dependencies.auth.authenticate(values ?? undefined)) {
        return problemResponse(
          new HostProblem(401, "unauthorized", "Authentication is required."),
          dependencies.requestId()
        );
      }
    }
    await next();
    context.res.headers.set("Cache-Control", "no-store");
    context.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  const route = <T extends HostRouteRequest>(candidate: unknown): T =>
    HostRouteRequestSchema.parse(candidate) as T;
  const requireWork = (): void => {
    if (!dependencies.ingress.acceptsProviderWork()) {
      throw new HostProblem(503, "internal_error", "The host is unavailable.");
    }
  };
  const requireMutation = (): void => {
    requireWork();
    if (!dependencies.ingress.acceptsMutation()) {
      throw new HostProblem(503, "internal_error", "The host is quiesced.");
    }
  };

  app.get("/v1/health", async () => {
    requireWork();
    const capabilities = await dependencies.runner.capabilities();
    return jsonResponse(
      HostHealthResponseSchema.parse({
        service: "autostack-host-daemon",
        version: "0.1.0",
        status: "ok",
        capabilities
      })
    );
  });
  app.get("/v1/environments", async () => {
    requireWork();
    return jsonResponse(
      ListEnvironmentsResponseSchema.parse({ items: await dependencies.runner.listEnvironments() })
    );
  });
  app.post("/v1/repositories/inspect", async (context) => {
    requireWork();
    const request = route<Extract<HostRouteRequest, { route: "POST /v1/repositories/inspect" }>>({
      route: "POST /v1/repositories/inspect",
      body: await readJsonBody(context.req.raw)
    });
    return jsonResponse(
      RepositoryInspectionSchema.parse(await dependencies.runner.inspectRepository(request.body))
    );
  });
  app.post("/v1/environments", async (context) => {
    requireMutation();
    const request = route<Extract<HostRouteRequest, { route: "POST /v1/environments" }>>({
      route: "POST /v1/environments",
      body: await readJsonBody(context.req.raw)
    });
    const result = await dependencies.prepareWithReplay(request.body);
    return jsonResponse(
      {
        environment: PreparedEnvironmentSchema.parse(result.environment),
        replayed: result.replayed
      },
      202
    );
  });
  app.post("/v1/environments/:environmentId/commands", async (context) => {
    requireMutation();
    const request = route<
      Extract<HostRouteRequest, { route: "POST /v1/environments/:environmentId/commands" }>
    >({
      route: "POST /v1/environments/:environmentId/commands",
      environmentId: context.req.param("environmentId"),
      body: await readJsonBody(context.req.raw)
    });
    return jsonResponse(
      CommandAcceptedSchema.parse(await dependencies.runner.startCommand(request.body)),
      202
    );
  });
  app.post("/v1/environments/:environmentId/commands/:commandId/cancel", async (context) => {
    requireWork();
    const request = route<
      Extract<
        HostRouteRequest,
        { route: "POST /v1/environments/:environmentId/commands/:commandId/cancel" }
      >
    >({
      route: "POST /v1/environments/:environmentId/commands/:commandId/cancel",
      environmentId: context.req.param("environmentId"),
      commandId: context.req.param("commandId"),
      body: await readJsonBody(context.req.raw)
    });
    return jsonResponse(
      CancelCommandResponseSchema.parse(await dependencies.runner.cancelCommand(request.body))
    );
  });
  app.delete("/v1/environments/:environmentId", async (context) => {
    requireWork();
    const request = route<
      Extract<HostRouteRequest, { route: "DELETE /v1/environments/:environmentId" }>
    >({
      route: "DELETE /v1/environments/:environmentId",
      environmentId: context.req.param("environmentId"),
      body: await readJsonBody(context.req.raw)
    });
    return jsonResponse(
      DisposeEnvironmentResponseSchema.parse(
        await dependencies.runner.disposeEnvironment(request.body)
      )
    );
  });

  app.get("/v1/environments/:environmentId/commands/:commandId/events", async (context) => {
    requireWork();
    const raw = exactQuery(context.req.raw, EVENT_QUERY_KEYS);
    const request = route<
      Extract<
        HostRouteRequest,
        { route: "GET /v1/environments/:environmentId/commands/:commandId/events" }
      >
    >({
      route: "GET /v1/environments/:environmentId/commands/:commandId/events",
      environmentId: context.req.param("environmentId"),
      commandId: context.req.param("commandId"),
      query: {
        ...raw,
        environmentId: context.req.param("environmentId"),
        commandId: context.req.param("commandId"),
        after: parseAfter(raw.after)
      }
    });
    const admission = createHostCommandEventResponseAdmission(request);
    const iterator = dependencies.runner.readCommandEvents(request.query)[Symbol.asyncIterator]();
    let prefetched: IteratorResult<RunnerSubscriptionItem> | undefined = await iterator.next();
    let returned = false;
    const close = async (): Promise<void> => {
      if (!returned) {
        returned = true;
        await iterator.return?.();
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = prefetched ?? (await iterator.next());
          prefetched = undefined;
          if (item.done) {
            controller.close();
            await close();
            return;
          }
          const frame = admission.admit({
            status: 200,
            mediaType: "application/x-ndjson",
            body: item.value
          });
          const serialized = JSON.stringify(frame);
          if (
            Buffer.byteLength(serialized) > 1_048_576 ||
            containsSensitiveMaterial(serialized) ||
            dependencies.isSensitive?.(serialized) === true
          ) {
            await Promise.resolve(dependencies.terminalizeProtocolFailure(request.query));
            controller.close();
            await close();
            return;
          }
          controller.enqueue(Buffer.from(`${serialized}\n`));
          if (admission.terminal) {
            controller.close();
            await close();
          }
        } catch {
          await Promise.resolve(dependencies.terminalizeProtocolFailure(request.query)).catch(
            () => undefined
          );
          controller.close();
          await close().catch(() => undefined);
        }
      },
      cancel: close
    });
    return new Response(stream, {
      status: 200,
      headers: { ...COMMON_HEADERS, "Content-Type": "application/x-ndjson" }
    });
  });

  app.get("/v1/artifacts/:artifactId/content", async (context) => {
    requireWork();
    const raw = exactQuery(context.req.raw, ARTIFACT_QUERY_KEYS);
    const range = parseRange(context.req.raw.headers.get("range"));
    const request = route<
      Extract<HostRouteRequest, { route: "GET /v1/artifacts/:artifactId/content" }>
    >({
      route: "GET /v1/artifacts/:artifactId/content",
      artifactId: context.req.param("artifactId"),
      query: { ...raw, range }
    });
    let offset = range.start;
    const chunks: Buffer[] = [];
    let artifact: Awaited<ReturnType<RunnerProvider["readArtifactChunk"]>>["artifact"] | undefined;
    const { range: _range, ...artifactAuthorization } = request.query;
    void _range;
    while (offset <= range.end) {
      const chunkRequest = {
        ...artifactAuthorization,
        artifactId: request.artifactId,
        offset,
        length: Math.min(1_048_576, range.end - offset + 1)
      };
      const chunk = await dependencies.runner.readArtifactChunk(chunkRequest);
      validateArtifactChunkResponse(chunkRequest, chunk);
      if (
        artifact !== undefined &&
        (artifact.digest !== chunk.artifact.digest || artifact.byteSize !== chunk.artifact.byteSize)
      ) {
        throw new HostProblem(500, "internal_error", "Artifact evidence changed during the read.");
      }
      artifact = chunk.artifact;
      const bytes = Buffer.from(chunk.bytes, "base64");
      if (bytes.length === 0 && !chunk.done)
        throw new HostProblem(500, "internal_error", "Artifact read made no progress.");
      chunks.push(bytes);
      offset = chunk.nextOffset;
      if (chunk.done || offset > range.end) break;
    }
    if (artifact === undefined || range.start >= artifact.byteSize) {
      throw new HostProblem(416, "range_not_satisfiable", "The byte range is invalid.");
    }
    const bytes = Buffer.concat(chunks).subarray(0, range.end - range.start + 1);
    const chunk = {
      artifact,
      offset: range.start,
      bytes: bytes.toString("base64"),
      nextOffset: range.start + bytes.length,
      done: range.start + bytes.length === artifact.byteSize
    };
    return jsonResponse(
      HostArtifactContentResponseSchema.parse({ contentType: artifact.mediaType, chunk }),
      206
    );
  });

  app.notFound(() =>
    problemResponse(
      new HostProblem(404, "not_found", "The requested host route was not found."),
      dependencies.requestId()
    )
  );
  app.onError((error) => {
    const problem =
      error instanceof HostProblem
        ? error
        : error instanceof ZodError
          ? new HostProblem(400, "invalid_request", "The request is invalid.")
          : error instanceof LocalRunnerProviderError
            ? mapLocalRunnerProblem(error)
            : new HostProblem(500, "internal_error", "The host request could not be completed.");
    const requestId = dependencies.requestId();
    dependencies.log({ event: "request.error", requestId, status: problem.status });
    return problemResponse(problem, requestId);
  });
  return app;
};
