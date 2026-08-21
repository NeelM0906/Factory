import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  JobIdSchema,
  PendingDomainEventSchema,
  RunIdSchema,
  RunStageSchema,
  WorkspaceIdSchema
} from "@autostack/contracts";

import {
  HandlerRegistry,
  UnknownWorkflowHandlerError,
  type WorkflowHandlerContext
} from "../src/index.js";

const context: WorkflowHandlerContext = {
  job: {
    jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174000"),
    workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000"),
    runId: RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000"),
    stage: RunStageSchema.parse("triage"),
    handler: "test.echo",
    payload: { message: "hello" },
    maxAttempts: 2,
    availableAt: "2026-08-20T12:00:00.000Z",
    createdAt: "2026-08-20T12:00:00.000Z",
    attempt: 1,
    leaseOwner: "worker-1",
    leaseToken: "lease-1",
    leaseExpiresAt: "2026-08-20T12:01:00.000Z"
  },
  signal: new AbortController().signal
};

describe("workflow handler registry", () => {
  it("validates payloads before invoking a typed handler", async () => {
    const registry = new HandlerRegistry();
    registry.register("test.echo", z.object({ message: z.string().min(1) }).strict(), async () => ({
      appends: [],
      jobs: []
    }));

    await expect(registry.execute("test.echo", { message: "hello" }, context)).resolves.toEqual({
      appends: [],
      jobs: []
    });
  });

  it("rejects invalid payload before the handler can cause a side effect", async () => {
    const registry = new HandlerRegistry();
    let invocations = 0;
    registry.register("test.echo", z.object({ message: z.string().min(1) }).strict(), async () => {
      invocations += 1;
      return { appends: [], jobs: [] };
    });

    await expect(registry.execute("test.echo", { message: 42 }, context)).rejects.toThrow();
    expect(invocations).toBe(0);
  });

  it("rejects duplicate registrations", () => {
    const registry = new HandlerRegistry();
    const schema = z.object({});
    const handler = async () => ({ appends: [], jobs: [] });
    registry.register("test.echo", schema, handler);

    expect(() => registry.register("test.echo", schema, handler)).toThrow(/already registered/i);
  });

  it("rejects an unknown handler name", async () => {
    const registry = new HandlerRegistry();

    await expect(registry.execute("missing", {}, context)).rejects.toBeInstanceOf(
      UnknownWorkflowHandlerError
    );
  });

  it("rejects a malformed or secret-bearing handler result before persistence", async () => {
    const registry = new HandlerRegistry();
    registry.register(
      "test.invalid",
      z.object({}).strict(),
      async () =>
        ({
          appends: [],
          jobs: [{ value: "ghp_0123456789abcdefghijklmnop" }]
        }) as never
    );

    await expect(registry.execute("test.invalid", {}, context)).rejects.toThrow();
  });

  it("rejects child jobs that escape the parent workspace or run", async () => {
    const registry = new HandlerRegistry();
    registry.register("test.child", z.object({}).strict(), async () => ({
      appends: [],
      jobs: [
        {
          jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174099"),
          workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174099"),
          runId: context.job.runId,
          stage: "plan",
          handler: "test.plan",
          payload: {},
          maxAttempts: 2,
          availableAt: context.job.availableAt,
          createdAt: context.job.createdAt
        }
      ]
    }));

    await expect(registry.execute("test.child", {}, context)).rejects.toThrow(/workspace and run/i);
  });

  it.each([
    [
      "workspace",
      WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174099"),
      context.job.runId
    ],
    ["run", context.job.workspaceId, RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174099")]
  ])("rejects output appends outside the leased %s", async (_boundary, workspaceId, runId) => {
    const registry = new HandlerRegistry();
    registry.register("test.append", z.object({}).strict(), async () => ({
      appends: [
        {
          stream: { kind: "run", id: runId },
          expectedVersion: 0,
          events: [
            PendingDomainEventSchema.parse({
              workspaceId,
              actor: { kind: "system", id: "autostack" },
              correlationId: "123e4567-e89b-42d3-a456-426614174001",
              occurredAt: context.job.createdAt,
              type: "run.transitioned",
              payload: {
                runId,
                from: "queued",
                to: "triaging",
                reason: "triage started"
              }
            })
          ]
        }
      ],
      jobs: []
    }));

    await expect(registry.execute("test.append", {}, context)).rejects.toThrow(
      /leased workspace|leased run/i
    );
  });

  it("rejects a child job with a different run in the same workspace", async () => {
    const registry = new HandlerRegistry();
    registry.register("test.child-run", z.object({}).strict(), async () => ({
      appends: [],
      jobs: [
        {
          jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174098"),
          workspaceId: context.job.workspaceId,
          runId: RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174099"),
          stage: "plan",
          handler: "test.plan",
          payload: {},
          maxAttempts: 2,
          availableAt: context.job.availableAt,
          createdAt: context.job.createdAt
        }
      ]
    }));

    await expect(registry.execute("test.child-run", {}, context)).rejects.toThrow(
      /workspace and run/i
    );
  });

  it("rejects a configured secret in a handler result", async () => {
    const secret = "configured-secret-0123456789abcdef";
    const registry = new HandlerRegistry({ sensitiveValues: [secret] });
    registry.register("test.secret", z.object({}).strict(), async () => ({
      appends: [],
      jobs: [
        {
          jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174099"),
          workspaceId: context.job.workspaceId,
          runId: context.job.runId,
          stage: "plan",
          handler: "test.plan",
          payload: { secret },
          maxAttempts: 2,
          availableAt: context.job.availableAt,
          createdAt: context.job.createdAt
        }
      ]
    }));

    await expect(registry.execute("test.secret", {}, context)).rejects.toThrow(/sensitive/i);
  });

  it("validates and scans one immutable handler-result snapshot", async () => {
    const secret = "configured-secret-0123456789abcdef";
    const payload = new Proxy(
      { task: "safe" },
      {
        getOwnPropertyDescriptor: (_target, property) =>
          property === "task"
            ? { configurable: true, enumerable: true, writable: true, value: "safe" }
            : undefined,
        get: (_target, property) => (property === "task" ? secret : undefined),
        ownKeys: () => ["task"]
      }
    );
    const registry = new HandlerRegistry({ sensitiveValues: [secret] });
    registry.register("test.snapshot", z.object({}).strict(), async () => ({
      appends: [],
      jobs: [
        {
          jobId: JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174099"),
          workspaceId: context.job.workspaceId,
          runId: context.job.runId,
          stage: "plan",
          handler: "test.plan",
          payload,
          maxAttempts: 2,
          availableAt: context.job.availableAt,
          createdAt: context.job.createdAt
        }
      ]
    }));

    await expect(registry.execute("test.snapshot", {}, context)).resolves.toMatchObject({
      jobs: [{ payload: { task: "safe" } }]
    });
  });

  it.each([
    ["foreign job", "job_123e4567-e89b-42d3-a456-426614174099", "triage", context.job.runId],
    ["foreign stage", context.job.jobId, "plan", context.job.runId],
    [
      "foreign run",
      context.job.jobId,
      "triage",
      RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174099")
    ]
  ])("rejects stage evidence for a %s", async (_label, jobId, stage, runId) => {
    const registry = new HandlerRegistry();
    registry.register("test.evidence", z.object({}).strict(), async () => ({
      appends: [
        {
          stream: { kind: "run", id: runId },
          expectedVersion: 1,
          events: [
            PendingDomainEventSchema.parse({
              workspaceId: context.job.workspaceId,
              actor: { kind: "system", id: "autostack" },
              correlationId: "123e4567-e89b-42d3-a456-426614174001",
              occurredAt: context.job.createdAt,
              type: "stage.succeeded",
              payload: { runId, stage, jobId }
            })
          ]
        }
      ],
      jobs: []
    }));

    await expect(registry.execute("test.evidence", {}, context)).rejects.toThrow(
      /leased run|leased job|stage/i
    );
  });
});
