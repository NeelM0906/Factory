import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CancelRunResponseSchema,
  CreateRunResponseSchema,
  EventIdSchema,
  JobIdSchema,
  PendingDomainEventSchema,
  RunIdSchema,
  SteerRunResponseSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import { transitionRun, type StreamAppend } from "@autostack/domain";

import { createApp } from "../src/app.js";

const NOW = "2026-08-20T12:00:00.000Z";
const TOKEN = "0123456789abcdef0123456789abcdef";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

let eventCounter = 10;
const makeHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-control-"));
  temporaryDirectories.push(directory);
  const database = openDatabase({ filePath: join(directory, "autostack.sqlite") });
  eventCounter = 10;
  const store = new SqliteDurableStore(database, {
    eventId: () =>
      EventIdSchema.parse(
        `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventCounter++).padStart(12, "0")}`
      ),
    leaseToken: () => "lease-token",
    now: () => NOW
  });
  const app = createApp({
    store,
    executor: { getStatus: () => "idle" },
    token: TOKEN,
    workspaceId: WORKSPACE_ID,
    now: () => NOW
  });
  const authenticated = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...init.headers
      }
    });

  /** Creates a run and returns its runId. */
  const createRun = async (
    title = "Fix the bug"
  ): Promise<{ runId: string; workItemId: string }> => {
    const response = await authenticated("/v1/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `run-${title}-${Date.now()}-${Math.random()}`
      },
      body: JSON.stringify({ title, description: `Description for ${title}` })
    });
    const body = CreateRunResponseSchema.parse(await response.json());
    return { runId: body.run.id, workItemId: body.workItem.id };
  };

  /**
   * Transitions a run to a non-terminal status by chaining transitions.
   * The run starts as "queued" after createRun, then follows the valid transitions.
   */
  const transitionTo = async (
    runId: string,
    targetStatus: string
  ): Promise<void> => {
    const transitionChain: Record<string, string[]> = {
      triaging: ["triaging"],
      planning: ["triaging", "planning"],
      implementing: ["triaging", "planning", "awaiting_plan_approval", "provisioning", "implementing"],
      cancelling: ["triaging", "cancelling"]
    };
    const steps = transitionChain[targetStatus];
    if (steps === undefined) throw new Error(`No transition chain for ${targetStatus}`);

    // Read current events to get the run object and version.
    const events = await store.readRunEvents({
      workspaceId: WORKSPACE_ID,
      runId: RunIdSchema.parse(runId)
    });
    let run = events.find((e) => e.type === "run.created")!.payload.run;
    if (run === undefined) throw new Error("Run not found in events");
    let version = events[events.length - 1]!.streamVersion;

    for (const step of steps) {
      // Apply transitions to run state.
      for (const e of events) {
        if (e.type === "run.transitioned") {
          run = transitionRun({
            run,
            to: e.payload.to,
            reason: e.payload.reason,
            ...(e.payload.resumeStatus === undefined
              ? {}
              : { resumeStatus: e.payload.resumeStatus }),
            actor: e.actor,
            correlationId: e.correlationId,
            occurredAt: e.occurredAt
          }).run;
        }
      }
      // Only transition if needed.
      if (run.status === step) continue;

      const result = transitionRun({
        run,
        to: step as any,
        reason: `Transition to ${step} for testing`,
        actor: { kind: "user", id: "local-user", displayName: "Local User" },
        correlationId: runId.slice(runId.indexOf("_") + 1),
        occurredAt: NOW
      });
      const append: StreamAppend = {
        stream: { kind: "run", id: runId },
        expectedVersion: version,
        events: result.events
      };
      const commitResult = await store.commit({
        idempotency: {
          scope: `test:transition:${WORKSPACE_ID}`,
          key: `${runId}:${step}:${Date.now()}-${Math.random()}`
        },
        appends: [append],
        jobs: []
      });
      version = commitResult.events[commitResult.events.length - 1]!.streamVersion;
      run = result.run;
    }
  };

  /**
   * Creates a leased job for a run (simulates an active station).
   */
  const createLeasedJob = async (runId: string): Promise<string> => {
    const jobId = JobIdSchema.parse(`job_${crypto.randomUUID()}`);
    // Queue a job via a stage.queued event.
    const stageQueuedEvent = PendingDomainEventSchema.parse({
      workspaceId: WORKSPACE_ID,
      actor: { kind: "system", id: "workflow", displayName: "Workflow" },
      correlationId: runId.slice(runId.indexOf("_") + 1),
      occurredAt: NOW,
      type: "stage.queued",
      payload: {
        runId: RunIdSchema.parse(runId),
        stage: "triage",
        jobId
      }
    });
    const events = await store.readRunEvents({
      workspaceId: WORKSPACE_ID,
      runId: RunIdSchema.parse(runId)
    });
    const version = events[events.length - 1]!.streamVersion;
    await store.commit({
      idempotency: {
        scope: `test:queue-job:${WORKSPACE_ID}`,
        key: `${runId}:${jobId}`
      },
      appends: [{
        stream: { kind: "run", id: runId },
        expectedVersion: version,
        events: [stageQueuedEvent]
      }],
      jobs: [{
        jobId,
        workspaceId: WORKSPACE_ID,
        runId: RunIdSchema.parse(runId),
        stage: "triage",
        handler: "pipeline.triage",
        payload: { workItemId: "wi_test", pipelineStage: "triage", attempt: 1, inputEvidenceDigests: [] },
        maxAttempts: 3,
        availableAt: NOW,
        createdAt: NOW
      }]
    });
    // Lease the job.
    const leased = await store.leaseNext({
      workerId: "test-worker",
      now: NOW,
      leaseDurationMs: 60_000
    });
    if (leased === null) throw new Error("Failed to lease job");
    return leased.jobId;
  };

  return { app, store, authenticated, createRun, transitionTo, createLeasedJob };
};

// ---------------------------------------------------------------------------
// Steer route
// ---------------------------------------------------------------------------

describe("steer route (POST /v1/runs/:runId/steer)", () => {
  it("requires authentication", async () => {
    const { app, store } = await makeHarness();
    const response = await app.request(
      "/v1/runs/run_123e4567-e89b-42d3-a456-426614174099/steer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "steer-auth-test"
        },
        body: JSON.stringify({ instruction: "Focus on performance" })
      }
    );
    expect(response.status).toBe(401);
    await store.close();
  });

  it("requires Idempotency-Key", async () => {
    const { authenticated, store, createRun } = await makeHarness();
    const { runId } = await createRun("Steer target");
    const response = await authenticated(`/v1/runs/${runId}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "Focus on performance" })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "missing_idempotency_key" }
    });
    await store.close();
  });

  it("returns 404 for unknown run", async () => {
    const { authenticated, store } = await makeHarness();
    const response = await authenticated(
      "/v1/runs/run_00000000-0000-4000-8000-000000000000/steer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "steer-404-test"
        },
        body: JSON.stringify({ instruction: "Focus on performance" })
      }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "run_not_found" } });
    await store.close();
  });

  it("returns 409 for a terminal run", async () => {
    const { authenticated, store, createRun, transitionTo } = await makeHarness();
    const { runId } = await createRun("Terminal target");
    // Move to a status then complete it via direct event emission.
    await transitionTo(runId, "triaging");
    // Transition to failed (terminal).
    const events = await store.readRunEvents({
      workspaceId: WORKSPACE_ID,
      runId: RunIdSchema.parse(runId)
    });
    let run = events.find((e) => e.type === "run.created")!.payload.run;
    for (const e of events) {
      if (e.type === "run.transitioned") {
        run = transitionRun({
          run,
          to: e.payload.to,
          reason: e.payload.reason,
          actor: e.actor,
          correlationId: e.correlationId,
          occurredAt: e.occurredAt
        }).run;
      }
    }
    const failResult = transitionRun({
      run,
      to: "failed",
      reason: "test failure",
      actor: { kind: "user", id: "local-user", displayName: "Local User" },
      correlationId: runId.slice(runId.indexOf("_") + 1),
      occurredAt: NOW
    });
    const version = events[events.length - 1]!.streamVersion;
    await store.commit({
      idempotency: {
        scope: `test:fail:${WORKSPACE_ID}`,
        key: `${runId}:fail`
      },
      appends: [{
        stream: { kind: "run", id: runId },
        expectedVersion: version,
        events: failResult.events
      }],
      jobs: []
    });

    const response = await authenticated(`/v1/runs/${runId}/steer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "steer-terminal-test"
      },
      body: JSON.stringify({ instruction: "Focus on performance" })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "version_conflict" }
    });
    await store.close();
  });

  it("commits run.steered and returns accepted", async () => {
    const { authenticated, store, createRun, transitionTo } = await makeHarness();
    const { runId } = await createRun("Steer me");
    await transitionTo(runId, "triaging");

    const response = await authenticated(`/v1/runs/${runId}/steer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "steer-happy-test"
      },
      body: JSON.stringify({ instruction: "Focus on performance" })
    });
    expect(response.status).toBe(200);
    const body = SteerRunResponseSchema.parse(await response.json());
    expect(body.runId).toBe(runId);
    expect(body.accepted).toBe(true);
    await store.close();
  });

  it("replays the same steer with identical Idempotency-Key", async () => {
    const { authenticated, store, createRun, transitionTo } = await makeHarness();
    const { runId } = await createRun("Steer replay");
    await transitionTo(runId, "triaging");

    const request: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "steer-replay-test"
      },
      body: JSON.stringify({ instruction: "Focus on performance" })
    };

    const first = await authenticated(`/v1/runs/${runId}/steer`, request);
    const firstBody = SteerRunResponseSchema.parse(await first.json());
    expect(firstBody.accepted).toBe(true);

    // Second call with same key should be replayed.
    const second = await authenticated(`/v1/runs/${runId}/steer`, request);
    expect(second.status).toBe(200);
    const secondBody = SteerRunResponseSchema.parse(await second.json());
    expect(secondBody.accepted).toBe(true);
    expect(secondBody.acceptedAt).toBe(firstBody.acceptedAt);
    await store.close();
  });

  it("returns 400 for malformed body", async () => {
    const { authenticated, store, createRun } = await makeHarness();
    const { runId } = await createRun("Steer bad body");
    const response = await authenticated(`/v1/runs/${runId}/steer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "steer-bad-body-test"
      },
      body: "{invalid"
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    await store.close();
  });

  it("returns 413 for oversized body", async () => {
    const { authenticated, store, createRun } = await makeHarness();
    const { runId } = await createRun("Steer large body");
    const response = await authenticated(`/v1/runs/${runId}/steer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "200000",
        "Idempotency-Key": "steer-oversized-test"
      },
      body: JSON.stringify({ instruction: "x".repeat(180_000) })
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Cancel route
// ---------------------------------------------------------------------------

describe("cancel route (POST /v1/runs/:runId/cancel)", () => {
  it("requires authentication", async () => {
    const { app, store } = await makeHarness();
    const response = await app.request(
      "/v1/runs/run_123e4567-e89b-42d3-a456-426614174099/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "cancel-auth-test"
        },
        body: JSON.stringify({ reason: "User changed mind" })
      }
    );
    expect(response.status).toBe(401);
    await store.close();
  });

  it("requires Idempotency-Key", async () => {
    const { authenticated, store, createRun } = await makeHarness();
    const { runId } = await createRun("Cancel no key");
    const response = await authenticated(`/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "User changed mind" })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "missing_idempotency_key" }
    });
    await store.close();
  });

  it("returns 404 for unknown run", async () => {
    const { authenticated, store } = await makeHarness();
    const response = await authenticated(
      "/v1/runs/run_00000000-0000-4000-8000-000000000000/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "cancel-404-test"
        },
        body: JSON.stringify({ reason: "User changed mind" })
      }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "run_not_found" } });
    await store.close();
  });

  it("with no job leased, commits cancelling AND cancelled together", async () => {
    const { authenticated, store, createRun, transitionTo } = await makeHarness();
    const { runId } = await createRun("Cancel no job");
    await transitionTo(runId, "triaging");

    const response = await authenticated(`/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "cancel-no-job-test"
      },
      body: JSON.stringify({ reason: "User changed mind" })
    });
    expect(response.status).toBe(200);
    const body = CancelRunResponseSchema.parse(await response.json());
    expect(body.runId).toBe(runId);
    expect(body.status).toBe("cancelled");

    // Verify both events were committed.
    const events = await store.readRunEvents({
      workspaceId: WORKSPACE_ID,
      runId: RunIdSchema.parse(runId)
    });
    const transitions = events.filter((e) => e.type === "run.transitioned");
    const cancellingEvent = transitions.find(
      (e) => e.type === "run.transitioned" && e.payload.to === "cancelling"
    );
    const cancelledEvent = transitions.find(
      (e) => e.type === "run.transitioned" && e.payload.to === "cancelled"
    );
    expect(cancellingEvent).toBeDefined();
    expect(cancelledEvent).toBeDefined();
    await store.close();
  });

  it("with a job leased, commits only cancelling", async () => {
    const { authenticated, store, createRun, transitionTo, createLeasedJob } =
      await makeHarness();
    const { runId } = await createRun("Cancel with job");
    await transitionTo(runId, "triaging");
    await createLeasedJob(runId);

    const response = await authenticated(`/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "cancel-with-job-test"
      },
      body: JSON.stringify({ reason: "User changed mind" })
    });
    expect(response.status).toBe(200);
    const body = CancelRunResponseSchema.parse(await response.json());
    expect(body.runId).toBe(runId);
    expect(body.status).toBe("cancelling");

    // Verify only cancelling was committed, not cancelled.
    const events = await store.readRunEvents({
      workspaceId: WORKSPACE_ID,
      runId: RunIdSchema.parse(runId)
    });
    const transitions = events.filter((e) => e.type === "run.transitioned");
    const cancellingEvent = transitions.find(
      (e) => e.type === "run.transitioned" && e.payload.to === "cancelling"
    );
    const cancelledEvent = transitions.find(
      (e) => e.type === "run.transitioned" && e.payload.to === "cancelled"
    );
    expect(cancellingEvent).toBeDefined();
    expect(cancelledEvent).toBeUndefined();
    await store.close();
  });

  it("returns 409 when cancelling a completed run", async () => {
    const { authenticated, store, createRun, transitionTo } = await makeHarness();
    const { runId } = await createRun("Cancel completed");
    // Move to publishing, then completed.
    await transitionTo(runId, "triaging");
    const events = await store.readRunEvents({
      workspaceId: WORKSPACE_ID,
      runId: RunIdSchema.parse(runId)
    });
    let run = events.find((e) => e.type === "run.created")!.payload.run;
    for (const e of events) {
      if (e.type === "run.transitioned") {
        run = transitionRun({
          run,
          to: e.payload.to,
          reason: e.payload.reason,
          actor: e.actor,
          correlationId: e.correlationId,
          occurredAt: e.occurredAt
        }).run;
      }
    }
    // Transition through the chain to completed.
    const chain = ["planning", "awaiting_plan_approval", "provisioning", "implementing", "verifying", "reviewing", "awaiting_publish_approval", "publishing", "completed"];
    let version = events[events.length - 1]!.streamVersion;
    for (const step of chain) {
      const result = transitionRun({
        run,
        to: step as any,
        reason: `Transition to ${step}`,
        actor: { kind: "user", id: "local-user", displayName: "Local User" },
        correlationId: runId.slice(runId.indexOf("_") + 1),
        occurredAt: NOW
      });
      const commitResult = await store.commit({
        idempotency: {
          scope: `test:complete:${WORKSPACE_ID}`,
          key: `${runId}:${step}:${Date.now()}-${Math.random()}`
        },
        appends: [{
          stream: { kind: "run", id: runId },
          expectedVersion: version,
          events: result.events
        }],
        jobs: []
      });
      version = commitResult.events[commitResult.events.length - 1]!.streamVersion;
      run = result.run;
    }

    const response = await authenticated(`/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "cancel-completed-test"
      },
      body: JSON.stringify({ reason: "Changed mind" })
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "version_conflict" } });
    await store.close();
  });

  it("replays the same cancel with identical Idempotency-Key", async () => {
    const { authenticated, store, createRun, transitionTo } = await makeHarness();
    const { runId } = await createRun("Cancel replay");
    await transitionTo(runId, "triaging");

    const request: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "cancel-replay-test"
      },
      body: JSON.stringify({ reason: "User changed mind" })
    };

    const first = await authenticated(`/v1/runs/${runId}/cancel`, request);
    const firstBody = CancelRunResponseSchema.parse(await first.json());
    expect(firstBody.status).toBe("cancelled");

    // Second call with same key should be replayed.
    const second = await authenticated(`/v1/runs/${runId}/cancel`, request);
    expect(second.status).toBe(200);
    const secondBody = CancelRunResponseSchema.parse(await second.json());
    expect(secondBody.status).toBe("cancelled");
    expect(secondBody.requestedAt).toBe(firstBody.requestedAt);
    await store.close();
  });

  it("errors never contain a stack trace or the bearer token", async () => {
    const { authenticated, store, createRun } = await makeHarness();
    const { runId } = await createRun("Cancel error test");
    const response = await authenticated(`/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "cancel-error-test"
      },
      body: "{invalid"
    });
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("at ");
    expect(text).not.toContain(TOKEN);
    await store.close();
  });
});
