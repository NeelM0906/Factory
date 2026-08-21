import { describe, expect, it } from "vitest";

import { RunSchema, type Actor, type Run, type RunStatus } from "@autostack/contracts";

import { InvalidRunTransitionError, transitionRun } from "../src/run-machine.js";

const NOW = "2026-08-20T12:00:00.000Z";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const ACTOR: Actor = { kind: "system", id: "autostack" };

const queuedRun = (): Run =>
  RunSchema.parse({
    schemaVersion: 1,
    id: "run_123e4567-e89b-42d3-a456-426614174000",
    workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
    workItemId: "wi_123e4567-e89b-42d3-a456-426614174000",
    workflowVersion: "foundation.v1",
    status: "queued",
    createdAt: NOW,
    updatedAt: NOW
  });

const move = (run: Run, to: RunStatus, resumeStatus?: RunStatus) =>
  transitionRun({
    run,
    to,
    reason: `move to ${to}`,
    ...(resumeStatus === undefined ? {} : { resumeStatus }),
    actor: ACTOR,
    correlationId: CORRELATION_ID,
    occurredAt: NOW
  });

describe("run state machine", () => {
  it("follows the complete issue-to-draft-PR state path", () => {
    const path: RunStatus[] = [
      "triaging",
      "planning",
      "awaiting_plan_approval",
      "provisioning",
      "implementing",
      "verifying",
      "reviewing",
      "awaiting_publish_approval",
      "publishing",
      "completed"
    ];

    const result = path.reduce((run, status) => move(run, status).run, queuedRun());

    expect(result.status).toBe("completed");
    expect(result.completedAt).toBe(NOW);
    expect(result.currentStage).toBeUndefined();
  });

  it("supports a clarification round trip only through triage", () => {
    const triaging = move(queuedRun(), "triaging").run;
    const clarification = move(triaging, "needs_clarification").run;

    expect(move(clarification, "triaging").run.status).toBe("triaging");
    expect(() => move(clarification, "planning")).toThrow(InvalidRunTransitionError);
  });

  it("records and enforces a waiting resume state", () => {
    const triaging = move(queuedRun(), "triaging").run;
    const waiting = move(triaging, "waiting_for_user", "triaging").run;

    expect(waiting.resumeStatus).toBe("triaging");
    expect(move(waiting, "triaging").run.resumeStatus).toBeUndefined();
    expect(() => move(waiting, "planning")).toThrow(InvalidRunTransitionError);
  });

  it("records and enforces a scheduled retry state", () => {
    const planning = move(move(queuedRun(), "triaging").run, "planning").run;
    const retry = move(planning, "retry_scheduled", "planning").run;

    expect(move(retry, "planning").run.status).toBe("planning");
    expect(() => move(retry, "triaging")).toThrow(InvalidRunTransitionError);
  });

  it("requires a resume status when entering a resumable state", () => {
    expect(() => move(queuedRun(), "waiting_for_user")).toThrow(InvalidRunTransitionError);
  });

  it("requires cancellation to pass through cancelling", () => {
    expect(() => move(queuedRun(), "cancelled")).toThrow(InvalidRunTransitionError);

    const cancelling = move(queuedRun(), "cancelling").run;
    expect(move(cancelling, "cancelled").run.status).toBe("cancelled");
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "rejects transitions from terminal state %s",
    (terminal) => {
      const run = RunSchema.parse({ ...queuedRun(), status: terminal, completedAt: NOW });
      expect(() => move(run, "triaging")).toThrow(InvalidRunTransitionError);
    }
  );

  it("emits a validated transition event", () => {
    const decision = move(queuedRun(), "triaging");

    expect(decision.events).toEqual([
      {
        workspaceId: queuedRun().workspaceId,
        actor: ACTOR,
        correlationId: CORRELATION_ID,
        occurredAt: NOW,
        type: "run.transitioned",
        payload: {
          runId: queuedRun().id,
          from: "queued",
          to: "triaging",
          reason: "move to triaging"
        }
      }
    ]);
  });
});
