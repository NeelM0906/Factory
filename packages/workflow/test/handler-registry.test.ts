import { describe, expect, it } from "vitest";
import { z } from "zod";

import { JobIdSchema, RunIdSchema, RunStageSchema, WorkspaceIdSchema } from "@autostack/contracts";

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
    registry.register(
      "test.echo",
      z.object({ message: z.string().min(1) }).strict(),
      async (input) => ({
        appends: [],
        jobs: [],
        output: input.message.toUpperCase()
      })
    );

    await expect(
      registry.execute("test.echo", { message: "hello" }, context)
    ).resolves.toMatchObject({
      output: "HELLO"
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
});
