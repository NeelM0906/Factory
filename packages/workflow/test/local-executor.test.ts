import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  EventIdSchema,
  JobIdSchema,
  RunIdSchema,
  WorkspaceIdSchema,
  createIdFactory
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import { createManualRun, type NewWorkflowJob } from "@autostack/domain";

import {
  HandlerRegistry,
  LocalWorkflowExecutor,
  RetryableJobError,
  type SanitizedWorkflowError
} from "../src/index.js";

const NOW = "2026-08-20T12:00:00.000Z";
const LATER = "2026-08-20T12:00:01.000Z";
const temporaryDirectories: string[] = [];

const temporaryDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-executor-"));
  temporaryDirectories.push(directory);
  return join(directory, "autostack.sqlite");
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const workflowJob = (overrides: Partial<NewWorkflowJob> = {}): NewWorkflowJob => ({
  jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174000"),
  workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000"),
  runId: RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000"),
  stage: "triage",
  handler: "test.handler",
  payload: { task: "triage" },
  maxAttempts: 2,
  availableAt: NOW,
  createdAt: NOW,
  ...overrides
});

const harness = async (
  options: { now?: () => string; maxAttempts?: number; sensitiveValues?: readonly string[] } = {}
) => {
  const database = openDatabase({ filePath: await temporaryDatabasePath() });
  let eventNumber = 20;
  let leaseNumber = 0;
  const store = new SqliteDurableStore(database, {
    eventId: () =>
      EventIdSchema.parse(
        `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventNumber++).padStart(12, "0")}`
      ),
    leaseToken: () => `lease-${++leaseNumber}`,
    now: options.now ?? (() => NOW),
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues })
  });
  const registry = new HandlerRegistry();
  const seed = createManualRun(
    { title: "Executor test run" },
    {
      workspaceId: workflowJob().workspaceId,
      actor: { kind: "system", id: "test" },
      correlationId: "123e4567-e89b-42d3-a456-426614174000"
    },
    {
      now: () => NOW,
      ids: createIdFactory(() => "123e4567-e89b-42d3-a456-426614174000")
    }
  );
  await store.commit({
    idempotency: { scope: "test:seed", key: "run" },
    appends: seed.appends,
    jobs: []
  });
  const errors: Array<{ name: string; message: string; retryable: boolean }> = [];
  const executorOptions = {
    store,
    registry,
    workerId: "worker-1",
    now: options.now ?? (() => NOW),
    leaseDurationMs: 1_000,
    pollIntervalMs: 100,
    retryAt: () => LATER,
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
    reportError: (error: SanitizedWorkflowError) => {
      errors.push(error);
    }
  } as const;
  const executor = new LocalWorkflowExecutor(executorOptions);
  const enqueue = async (job = workflowJob({ maxAttempts: options.maxAttempts ?? 2 })) =>
    store.commit({
      idempotency: { scope: "test:enqueue", key: job.jobId },
      appends: [],
      jobs: [job]
    });

  return { database, store, registry, executor, executorOptions, errors, enqueue };
};

describe("local workflow executor cycles", () => {
  it("returns idle when no work is runnable", async () => {
    const { executor, store } = await harness();

    await expect(executor.runOnce()).resolves.toBe("idle");
    await store.close();
  });

  it("executes and atomically completes one valid job", async () => {
    const { database, store, registry, executor, enqueue } = await harness();
    registry.register(
      "test.handler",
      z.object({ task: z.literal("triage") }).strict(),
      async () => ({
        appends: [],
        jobs: []
      })
    );
    await enqueue();

    await expect(executor.runOnce()).resolves.toBe("completed");
    expect(database.connection.prepare("SELECT status FROM workflow_jobs").get()).toEqual({
      status: "completed"
    });
    await store.close();
  });

  it("schedules retryable errors below the attempt limit", async () => {
    const { database, store, registry, executor, enqueue, errors } = await harness();
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      throw new RetryableJobError("provider unavailable");
    });
    await enqueue();

    await expect(executor.runOnce()).resolves.toBe("retried");
    expect(
      database.connection
        .prepare("SELECT status, available_at AS availableAt FROM workflow_jobs")
        .get()
    ).toEqual({ status: "queued", availableAt: LATER });
    expect(errors).toEqual([
      {
        code: "workflow_handler_failed",
        name: "RetryableJobError",
        message: "provider unavailable",
        retryable: true
      }
    ]);
    await store.close();
  });

  it("fails a non-retryable handler error without persisting its stack", async () => {
    const { database, store, registry, executor, enqueue, errors } = await harness({
      maxAttempts: 1
    });
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      throw new Error("unsafe failure");
    });
    await enqueue();

    await expect(executor.runOnce()).resolves.toBe("failed");
    const row = database.connection
      .prepare("SELECT status, last_error_json AS lastError FROM workflow_jobs")
      .get() as { status: string; lastError: string };
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.lastError)).toEqual({
      code: "workflow_handler_failed",
      name: "Error",
      message: "unsafe failure",
      retryable: false
    });
    expect(row.lastError).not.toContain("at ");
    expect(errors).toHaveLength(1);
    await store.close();
  });

  it("redacts configured and known credentials before persistence and reporting", async () => {
    const configuredSecret = "configured-secret-0123456789abcdef";
    const knownCredential = "ghp_0123456789abcdefghijklmnop";
    const { database, store, registry, executor, enqueue, errors } = await harness({
      maxAttempts: 1,
      sensitiveValues: [configuredSecret]
    });
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      throw new Error(`provider rejected ${configuredSecret} ${knownCredential}`);
    });
    await enqueue();

    await expect(executor.runOnce()).resolves.toBe("failed");
    const row = database.connection
      .prepare("SELECT last_error_json AS lastError FROM workflow_jobs")
      .get() as { lastError: string };
    const allOutput = JSON.stringify({ persisted: row.lastError, reported: errors });
    expect(allOutput).not.toContain(configuredSecret);
    expect(allOutput).not.toContain(knownCredential);
    expect(JSON.parse(row.lastError)).toMatchObject({
      code: "workflow_handler_failed",
      message: "provider rejected [REDACTED] [REDACTED]"
    });
    await store.close();
  });

  it("fails an unknown handler without executing user code", async () => {
    const { database, store, executor, enqueue, errors } = await harness({ maxAttempts: 1 });
    await enqueue(workflowJob({ handler: "missing.handler", maxAttempts: 1 }));

    await expect(executor.runOnce()).resolves.toBe("failed");
    expect(database.connection.prepare("SELECT status FROM workflow_jobs").get()).toEqual({
      status: "failed"
    });
    expect(errors[0]?.name).toBe("UnknownWorkflowHandlerError");
    await store.close();
  });

  it("sanitizes a non-error value thrown by a handler", async () => {
    const { store, registry, executor, enqueue, errors } = await harness({ maxAttempts: 1 });
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      throw "unsafe-string-error";
    });
    await enqueue();

    await expect(executor.runOnce()).resolves.toBe("failed");
    expect(errors).toEqual([
      {
        code: "workflow_handler_invalid_error",
        name: "UnknownWorkflowError",
        message: "Workflow handler failed with a non-error value.",
        retryable: false
      }
    ]);
    await store.close();
  });

  it("uses stable fallback fields for an Error with empty name and message", async () => {
    const { store, registry, executor, enqueue, errors } = await harness({ maxAttempts: 1 });
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      const error = new Error("");
      error.name = "";
      throw error;
    });
    await enqueue();

    await expect(executor.runOnce()).resolves.toBe("failed");
    expect(errors[0]).toMatchObject({ name: "Error", message: "Workflow handler failed." });
    await store.close();
  });

  it("rejects invalid poll and lease durations at construction", async () => {
    const { store, executorOptions } = await harness();

    expect(() => new LocalWorkflowExecutor({ ...executorOptions, leaseDurationMs: 0 })).toThrow(
      TypeError
    );
    expect(() => new LocalWorkflowExecutor({ ...executorOptions, pollIntervalMs: 1.5 })).toThrow(
      TypeError
    );
    await store.close();
  });
});

describe("local workflow executor lifecycle", () => {
  it("starts idempotently and can stop before its first poll", async () => {
    vi.useFakeTimers();
    const { store, executor } = await harness();

    executor.start();
    executor.start();
    expect(executor.getStatus()).toBe("idle");
    await executor.stop();

    expect(executor.getStatus()).toBe("stopped");
    await store.close();
  });

  it("heartbeats a long-running handler before half the lease elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const now = () => new Date().toISOString();
    const { database, store, registry, executor, enqueue } = await harness({ now });
    let finish: (() => void) | undefined;
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { appends: [], jobs: [] };
    });
    await enqueue();

    const cycle = executor.runOnce();
    await vi.advanceTimersByTimeAsync(600);
    const row = database.connection
      .prepare(
        "SELECT heartbeat_at AS heartbeatAt, lease_expires_at AS leaseExpiresAt FROM workflow_jobs"
      )
      .get();

    expect(row).toEqual({
      heartbeatAt: "2026-08-20T12:00:00.500Z",
      leaseExpiresAt: "2026-08-20T12:00:01.500Z"
    });
    if (finish === undefined) throw new Error("Expected the handler to be running.");
    finish();
    await cycle;
    await store.close();
  });

  it("does not overlap poll cycles and stops after the active handler settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const now = () => new Date().toISOString();
    const { store, registry, executor, enqueue } = await harness({ now });
    let invocations = 0;
    let finish: (() => void) | undefined;
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      invocations += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { appends: [], jobs: [] };
    });
    await enqueue();

    executor.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(invocations).toBe(1);
    const stopping = executor.stop({ abortCurrent: false });
    if (finish === undefined) throw new Error("Expected the handler to be running.");
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(500);

    expect(invocations).toBe(1);
    expect(executor.getStatus()).toBe("stopped");
    await store.close();
  });

  it("returns the same active cycle instead of invoking a handler twice", async () => {
    const { store, registry, executor, enqueue } = await harness();
    let invocations = 0;
    let finish: (() => void) | undefined;
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      invocations += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { appends: [], jobs: [] };
    });
    await enqueue();

    const first = executor.runOnce();
    const second = executor.runOnce();
    expect(second).toBe(first);
    if (finish === undefined) await Promise.resolve();
    if (finish === undefined) throw new Error("Expected the handler to be running.");
    finish();

    await expect(first).resolves.toBe("completed");
    await expect(second).resolves.toBe("completed");
    expect(invocations).toBe(1);
    await store.close();
  });

  it("aborts the active handler on stop and leaves its lease recoverable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const now = () => new Date().toISOString();
    const { database, store, registry, executor, enqueue, errors } = await harness({ now });
    registry.register(
      "test.handler",
      z.object({ task: z.string() }),
      async (_input, { signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Stopped", "AbortError")),
            { once: true }
          );
        });
        return { appends: [], jobs: [] };
      }
    );
    await enqueue();

    executor.start();
    await vi.advanceTimersByTimeAsync(0);
    await executor.stop();

    expect(executor.getStatus()).toBe("stopped");
    expect(database.connection.prepare("SELECT status FROM workflow_jobs").get()).toEqual({
      status: "leased"
    });
    expect(errors).toEqual([]);
    await store.close();
  });

  it("keeps durable completion independent from a failing error reporter", async () => {
    const { store, registry, executorOptions, enqueue } = await harness({ maxAttempts: 1 });
    registry.register("test.handler", z.object({ task: z.string() }), async () => {
      throw new Error("handler failed");
    });
    const executor = new LocalWorkflowExecutor({
      ...executorOptions,
      reportError: () => {
        throw new Error("reporter failed");
      }
    });
    await enqueue();

    await expect(executor.runOnce()).resolves.toBe("failed");
    await store.close();
  });
});
