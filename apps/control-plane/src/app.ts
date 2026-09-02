import { Hono } from "hono";
import { ZodError } from "zod";

import {
  ApiErrorSchema,
  ApprovalDecisionRequestSchema,
  ApprovalDecisionResponseSchema,
  CreateRunRequestSchema,
  HealthResponseSchema,
  ListApprovalsQuerySchema,
  ListApprovalsResponseSchema,
  LocalArtifactReadRequestSchema,
  LocalArtifactReadResponseSchema,
  LocalCancelRequestSchema,
  LocalCancelResponseSchema,
  LocalDisposeRequestSchema,
  LocalDisposeResponseSchema,
  LocalEventsRequestSchema,
  LocalInspectRequestSchema,
  LocalInspectResponseSchema,
  LocalListEnvironmentsResponseSchema,
  LocalPrepareRequestSchema,
  LocalPrepareResponseSchema,
  LocalStartRequestSchema,
  LocalStartResponseSchema,
  type WorkspaceId
} from "@autostack/contracts";
import {
  ApprovalDecisionConflictError,
  IneligibleApproverError,
  OptimisticConcurrencyError,
  StaleApprovalEvidenceError,
  type DurableStore
} from "@autostack/domain";
import type { ExecutorStatus } from "@autostack/workflow";

import { ApprovalNotFoundError, ApprovalService, CrossRunApprovalError } from "./approval-service.js";
import { createBearerAuth, createBearerAuthDigest } from "./auth.js";
import { LocalExecutionService, LocalRunnerUnavailableError } from "./local-execution-service.js";
import { IdempotencyConflictError, RunNotFoundError, RunService } from "./run-service.js";

export interface CreateAppDependencies {
  readonly store: DurableStore;
  readonly executor: { getStatus(): ExecutorStatus };
  readonly token?: string;
  readonly tokenDigest?: string;
  readonly workspaceId: WorkspaceId;
  readonly now: () => string;
  readonly mode?: "local" | "hosted";
  readonly localExecution?: LocalExecutionService;
  readonly ingress?: { readonly isOpen: () => boolean };
}

class HttpProblem extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 422 | 500 | 503;
  readonly code:
    | "unauthorized"
    | "invalid_request"
    | "request_too_large"
    | "missing_idempotency_key"
    | "run_not_found"
    | "idempotency_conflict"
    | "version_conflict"
    | "scope_mismatch"
    | "authorization_invalid"
    | "authorization_expired"
    | "unsupported_policy"
    | "local_runner_unavailable"
    | "internal_error";

  constructor(status: HttpProblem["status"], code: HttpProblem["code"], message: string) {
    super(message);
    this.name = "HttpProblem";
    this.status = status;
    this.code = code;
  }
}

const MAX_REQUEST_BYTES = 128 * 1_024;
const CURRENT_STORAGE_SCHEMA_VERSION = 4;

const readJsonBody = async (request: Request): Promise<unknown> => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_REQUEST_BYTES) {
    throw new HttpProblem(413, "request_too_large", "The request body is too large.");
  }
  const reader = request.body?.getReader();
  if (reader === undefined)
    throw new HttpProblem(400, "invalid_request", "A JSON body is required.");
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new HttpProblem(413, "request_too_large", "The request body is too large.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpProblem(400, "invalid_request", "The request body is invalid JSON.");
  }
};

export function createApp(dependencies: CreateAppDependencies): Hono {
  const mode = dependencies.mode ?? "hosted";
  if ((dependencies.token === undefined) === (dependencies.tokenDigest === undefined))
    throw new TypeError("Exactly one bearer token authority is required.");
  if ((mode === "local") !== (dependencies.localExecution !== undefined)) {
    throw new TypeError("Local mode and local execution service must be configured together.");
  }
  const app = new Hono();
  const service = new RunService(dependencies);
  const approvalService = new ApprovalService(dependencies);
  const auth =
    dependencies.token === undefined
      ? createBearerAuthDigest(dependencies.tokenDigest!)
      : createBearerAuth(dependencies.token);

  app.use("/v1/*", async (context, next) => {
    if (context.req.path === "/v1/health") return next();
    return auth(context, next);
  });
  app.use("/v1/*", async (context, next) => {
    if (context.req.path !== "/v1/health" && dependencies.ingress?.isOpen() === false)
      throw new HttpProblem(
        503,
        "local_runner_unavailable",
        "The local runner generation is unavailable."
      );
    return next();
  });

  app.get("/v1/health", async (context) => {
    try {
      const storage = await dependencies.store.health();
      const response = HealthResponseSchema.parse({
        service: "autostack-control-plane",
        version: "0.1.0",
        status: storage.status === "ok" ? "ok" : "degraded",
        storage,
        executor: { status: dependencies.executor.getStatus() }
      });
      return context.json(response, response.status === "ok" ? 200 : 503);
    } catch {
      return context.json(
        HealthResponseSchema.parse({
          service: "autostack-control-plane",
          version: "0.1.0",
          status: "degraded",
          storage: {
            status: "degraded",
            journalMode: "wal",
            schemaVersion: CURRENT_STORAGE_SCHEMA_VERSION
          },
          executor: { status: dependencies.executor.getStatus() }
        }),
        503
      );
    }
  });

  app.post("/v1/runs", async (context) => {
    const idempotencyKey = context.req.header("Idempotency-Key")?.trim();
    if (idempotencyKey === undefined || idempotencyKey === "" || idempotencyKey.length > 200) {
      throw new HttpProblem(
        400,
        "missing_idempotency_key",
        "A valid Idempotency-Key header is required."
      );
    }
    const rawBody = await readJsonBody(context.req.raw);
    const body = CreateRunRequestSchema.parse(rawBody);
    const response = await service.create(body, idempotencyKey);
    return context.json(response, response.replayed ? 200 : 201);
  });

  app.get("/v1/runs", async (context) => {
    const rawCursor = context.req.query("cursor");
    const cursor = rawCursor === undefined ? undefined : Number(rawCursor);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor <= 0)) {
      throw new HttpProblem(400, "invalid_request", "cursor must be a positive integer.");
    }
    return context.json(await service.list(cursor));
  });

  app.get("/v1/runs/:runId/events", async (context) => {
    const rawAfter = context.req.query("after") ?? "0";
    const after = Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new HttpProblem(400, "invalid_request", "after must be a non-negative integer.");
    }
    return context.json(await service.events(context.req.param("runId"), after));
  });

  app.get("/v1/approvals", async (context) => {
    const query = ListApprovalsQuerySchema.parse({
      status: context.req.query("status"),
      limit: context.req.query("limit"),
      cursor: context.req.query("cursor")
    });
    return context.json(ListApprovalsResponseSchema.parse(await approvalService.list(query)));
  });

  app.post("/v1/runs/:runId/approvals/:approvalId/decision", async (context) => {
    const rawBody = await readJsonBody(context.req.raw);
    const body = ApprovalDecisionRequestSchema.parse(rawBody);
    const response = await approvalService.decide(
      context.req.param("runId"),
      context.req.param("approvalId"),
      body
    );
    return context.json(ApprovalDecisionResponseSchema.parse(response), response.replayed ? 200 : 200);
  });

  if (mode === "local") {
    const local = dependencies.localExecution!;
    const idempotencyKey = (context: { req: { header(name: string): string | undefined } }) => {
      const key = context.req.header("Idempotency-Key")?.trim();
      if (key === undefined || key === "" || key.length > 128)
        throw new HttpProblem(
          400,
          "missing_idempotency_key",
          "A valid Idempotency-Key header is required."
        );
      return key;
    };
    app.post("/v1/local/repositories/inspect", async (context) =>
      context.json(
        LocalInspectResponseSchema.parse(
          await local.inspect(LocalInspectRequestSchema.parse(await readJsonBody(context.req.raw)))
        )
      )
    );
    app.get("/v1/local/environments", async (context) =>
      context.json(LocalListEnvironmentsResponseSchema.parse(await local.list()))
    );
    app.post("/v1/local/environments", async (context) => {
      const result = await local.prepare(
        LocalPrepareRequestSchema.parse(await readJsonBody(context.req.raw)),
        idempotencyKey(context)
      );
      return context.json(LocalPrepareResponseSchema.parse(result), result.replayed ? 200 : 202);
    });
    app.post("/v1/local/environments/:environmentId/commands", async (context) => {
      const body = LocalStartRequestSchema.parse(await readJsonBody(context.req.raw));
      if (body.environmentId !== context.req.param("environmentId"))
        throw new HttpProblem(400, "invalid_request", "Route and body identities differ.");
      const result = await local.start(body, idempotencyKey(context));
      return context.json(LocalStartResponseSchema.parse(result), result.replayed ? 200 : 202);
    });
    app.get("/v1/local/environments/:environmentId/commands/:commandId/events", async (context) => {
      const request = LocalEventsRequestSchema.parse({
        environmentId: context.req.param("environmentId"),
        commandId: context.req.param("commandId"),
        after: Number(context.req.query("after") ?? "0")
      });
      const iterator = await local.events(request);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const item of iterator)
              controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        }
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" }
      });
    });
    app.post(
      "/v1/local/environments/:environmentId/commands/:commandId/cancel",
      async (context) => {
        const body = LocalCancelRequestSchema.parse(await readJsonBody(context.req.raw));
        if (
          body.environmentId !== context.req.param("environmentId") ||
          body.commandId !== context.req.param("commandId")
        )
          throw new HttpProblem(400, "invalid_request", "Route and body identities differ.");
        return context.json(LocalCancelResponseSchema.parse(await local.cancel(body)));
      }
    );
    app.get("/v1/local/artifacts/:artifactId/content", async (context) => {
      const result = await local.readArtifact(
        LocalArtifactReadRequestSchema.parse({
          artifactId: context.req.param("artifactId"),
          offset: Number(context.req.query("offset") ?? "0"),
          length: Number(context.req.query("length") ?? "1048576")
        })
      );
      return context.json(LocalArtifactReadResponseSchema.parse(result));
    });
    app.delete("/v1/local/environments/:environmentId", async (context) => {
      const body = LocalDisposeRequestSchema.parse(await readJsonBody(context.req.raw));
      if (body.environmentId !== context.req.param("environmentId"))
        throw new HttpProblem(400, "invalid_request", "Route and body identities differ.");
      return context.json(LocalDisposeResponseSchema.parse(await local.dispose(body)));
    });
  }

  app.notFound((context) =>
    context.json(
      ApiErrorSchema.parse({
        error: { code: "run_not_found", message: "The requested resource was not found." }
      }),
      404
    )
  );

  app.onError((error, context) => {
    const problem =
      error instanceof HttpProblem
        ? error
        : error instanceof ZodError
          ? new HttpProblem(400, "invalid_request", "The request is invalid.")
          : error instanceof IdempotencyConflictError
            ? new HttpProblem(
                409,
                "idempotency_conflict",
                "The idempotency key is already bound to another request."
              )
            : error instanceof RunNotFoundError
              ? new HttpProblem(404, "run_not_found", "The requested run was not found.")
              : error instanceof OptimisticConcurrencyError
                ? new HttpProblem(
                    409,
                    "version_conflict",
                    "The run changed before the command completed."
                  )
                : error instanceof LocalRunnerUnavailableError
                  ? new HttpProblem(
                      503,
                      "local_runner_unavailable",
                      "The local runner is unavailable."
                    )
                  : error instanceof StaleApprovalEvidenceError
                    ? new HttpProblem(
                        409,
                        "version_conflict",
                        "The approval evidence has changed."
                      )
                    : error instanceof IneligibleApproverError
                      ? new HttpProblem(
                          403,
                          "scope_mismatch",
                          "The actor is not eligible to decide this approval."
                        )
                      : error instanceof ApprovalDecisionConflictError
                        ? new HttpProblem(
                            409,
                            "idempotency_conflict",
                            "The approval already has a different decision."
                          )
                        : error instanceof ApprovalNotFoundError || error instanceof CrossRunApprovalError
                          ? new HttpProblem(
                              404,
                              "run_not_found",
                              "The requested approval was not found."
                            )
                          : new HttpProblem(500, "internal_error", "The request could not be completed.");

    return context.json(
      ApiErrorSchema.parse({ error: { code: problem.code, message: problem.message } }),
      problem.status
    );
  });

  return app;
}
