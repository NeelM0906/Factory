import { describe, expect, it } from "vitest";

import { WorkspaceIdSchema, createIdFactory, type Actor } from "@autostack/contracts";

import { createManualRun } from "../src/create-run.js";

const NOW = "2026-08-20T12:00:00.000Z";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174001";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174002";
const ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };

const dependencies = {
  now: () => NOW,
  ids: createIdFactory(() => UUID)
};

describe("manual run creation", () => {
  it("creates a normalized work item and queued run in separate streams", () => {
    const decision = createManualRun(
      {
        title: "  Build the durable core  ",
        description: "Persist state before side effects.",
        acceptanceContext: ["Survives restart"]
      },
      {
        workspaceId: WorkspaceIdSchema.parse(WORKSPACE_ID),
        actor: ACTOR,
        correlationId: CORRELATION_ID
      },
      dependencies
    );

    expect(decision.workItem).toMatchObject({
      id: `wi_${UUID}`,
      title: "Build the durable core",
      source: { kind: "manual", client: "api" }
    });
    expect(decision.run).toMatchObject({
      id: `run_${UUID}`,
      workItemId: `wi_${UUID}`,
      status: "queued",
      workflowVersion: "foundation.v1"
    });
    expect(decision.appends).toHaveLength(2);
    expect(decision.appends.map(({ stream }) => stream.kind)).toEqual(["work_item", "run"]);
    expect(decision.appends.map(({ expectedVersion }) => expectedVersion)).toEqual([0, 0]);
    expect(
      decision.appends.flatMap(({ events }) => events.map(({ correlationId }) => correlationId))
    ).toEqual([CORRELATION_ID, CORRELATION_ID]);
    expect(decision.jobs).toEqual([]);
  });

  it("rejects a title containing only whitespace", () => {
    expect(() =>
      createManualRun(
        { title: "   " },
        {
          workspaceId: WorkspaceIdSchema.parse(WORKSPACE_ID),
          actor: ACTOR,
          correlationId: CORRELATION_ID
        },
        dependencies
      )
    ).toThrow();
  });
});
