import { Hono } from "hono";
import { ZodError } from "zod";

import {
  ApiErrorSchema,
  CreateRunRequestSchema,
  HealthResponseSchema,
  type IdFactory,
  type WorkspaceId
} from "@autostack/contracts";
import { OptimisticConcurrencyError, type DurableStore } from "@autostack/domain";
import type { ExecutorStatus } from "@autostack/workflow";

import { createBearerAuth } from "./auth.js";
import { RunNotFoundError, RunService } from "./run-service.js";

export interface CreateAppDependencies {
  readonly store: DurableStore;
  readonly executor: { getStatus(): ExecutorStatus };
  readonly token: string;
  readonly workspaceId: WorkspaceId;
  readonly ids: Pick<IdFactory, "workItem" | "run">;
  readonly now: () => string;
  readonly correlationId: () => string;
}

class HttpProblem extends Error {
  readonly status: 400 | 401 | 404 | 409 | 500;
  readonly code:
    | "unauthorized"
    | "invalid_request"
    | "missing_idempotency_key"
    | "run_not_found"
    | "version_conflict"
    | "internal_error";

  constructor(status: HttpProblem["status"], code: HttpProblem["code"], message: string) {
    super(message);
    this.name = "HttpProblem";
    this.status = status;
    this.code = code;
  }
}

export function createApp(dependencies: CreateAppDependencies): Hono {
  const app = new Hono();
  const service = new RunService(dependencies);
  const auth = createBearerAuth(dependencies.token);

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
          storage: { status: "degraded", journalMode: "wal", schemaVersion: 1 },
          executor: { status: dependencies.executor.getStatus() }
        }),
        503
      );
    }
  });

  app.use("/v1/runs", auth);
  app.use("/v1/runs/*", auth);

  app.post("/v1/runs", async (context) => {
    const idempotencyKey = context.req.header("Idempotency-Key")?.trim();
    if (idempotencyKey === undefined || idempotencyKey === "" || idempotencyKey.length > 200) {
      throw new HttpProblem(
        400,
        "missing_idempotency_key",
        "A valid Idempotency-Key header is required."
      );
    }
    let rawBody: unknown;
    try {
      rawBody = await context.req.json();
    } catch {
      throw new HttpProblem(400, "invalid_request", "The request body is invalid JSON.");
    }
    const body = CreateRunRequestSchema.parse(rawBody);
    const response = await service.create(body, idempotencyKey);
    return context.json(response, response.replayed ? 200 : 201);
  });

  app.get("/v1/runs", async (context) => context.json(await service.list()));

  app.get("/v1/runs/:runId/events", async (context) => {
    const rawAfter = context.req.query("after") ?? "0";
    const after = Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new HttpProblem(400, "invalid_request", "after must be a non-negative integer.");
    }
    return context.json(await service.events(context.req.param("runId"), after));
  });

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
          : error instanceof RunNotFoundError
            ? new HttpProblem(404, "run_not_found", "The requested run was not found.")
            : error instanceof OptimisticConcurrencyError
              ? new HttpProblem(
                  409,
                  "version_conflict",
                  "The run changed before the command completed."
                )
              : new HttpProblem(500, "internal_error", "The request could not be completed.");

    return context.json(
      ApiErrorSchema.parse({ error: { code: problem.code, message: problem.message } }),
      problem.status
    );
  });

  return app;
}
