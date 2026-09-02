import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnswerClarificationResponseSchema,
  CreateRunResponseSchema,
  EventIdSchema,
  JobIdSchema,
  PendingDomainEventSchema,
  RunIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  createIdFactory
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
  const directory = await mkdtemp(join(tmpdir(), "autostack-clarification-"));
  temporaryDirectories.push(directory);
  const database = openDatabase({ filePath: join(directory, "autostack.sqlite") });
  eventCounter = 10;
  const ids = createIdFactory();
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
    now: () => NOW,
    ids: { job: ids.job }
  });
  const authenticated = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...init.headers
      }
    });

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
   * Transitions a run to needs_clarification by chaining:
   * queued -> triaging, seeding a clarification.requested event,
   * then triaging -> needs_clarification.
   */
  const seedClarification = async (
    runId: string,
    workItemId: string,
    clarificationRef = "clrf-001"
  ): Promise<{ clarificationRef: string; evidenceDigest: string }> => {
    const parsedRunId = RunIdSchema.parse(runId);
    const parsedWorkItemId = WorkItemIdSchema.parse(workItemId);
    const actor = { kind: "user" as const, id: "local-user", displayName: "Local User" };
    const correlationId = runId.slice(runId.indexOf("_") + 1);

    // Read current state.
    let events = await store.readRunEvents({ workspaceId: WORKSPACE_ID, runId: parsedRunId });
    let run = events.find((e) => e.type === "run.created")!.payload.run;
    let version = events[events.length - 1]!.streamVersion;

    // Transition queued -> triaging.
    const toTriaging = transitionRun({
      run,
      to: "triaging",
      reason: "Begin triage",
      actor,
      correlationId,
      occurredAt: NOW
    });
    const triagingCommit = await store.commit({
      idempotency: {
        scope: `test:transition:${WORKSPACE_ID}`,
        key: `${runId}:triaging:${Date.now()}-${Math.random()}`
      },
      appends: [{
        stream: { kind: "run", id: runId },
        expectedVersion: version,
        events: toTriaging.events
      }],
      jobs: []
    });
    version = triagingCommit.events[triagingCommit.events.length - 1]!.streamVersion;
    run = toTriaging.run;

    // Seed a clarification.requested event.
    const evidenceDigest = createHash("sha256")
      .update(`test-evidence:${clarificationRef}`)
      .digest("hex");
    const clarificationEvent = PendingDomainEventSchema.parse({
      workspaceId: WORKSPACE_ID,
      actor,
      correlationId,
      occurredAt: NOW,
      type: "clarification.requested",
      payload: {
        runId: parsedRunId,
        request: {
          schemaVersion: 1,
          workspaceId: WORKSPACE_ID,
          workItemId: parsedWorkItemId,
          runId: parsedRunId,
          clarificationRef,
          stage: "triage",
          question: "What framework should we use?",
          evidenceDigest,
          requestedAt: NOW
        }
      }
    });
    const clrfCommit = await store.commit({
      idempotency: {
        scope: `test:clarification:${WORKSPACE_ID}`,
        key: `${runId}:${clarificationRef}:${Date.now()}-${Math.random()}`
      },
      appends: [{
        stream: { kind: "run", id: runId },
        expectedVersion: version,
        events: [clarificationEvent]
      }],
      jobs: []
    });
    version = clrfCommit.events[clrfCommit.events.length - 1]!.streamVersion;

    // Transition triaging -> needs_clarification.
    const toNeedsClarification = transitionRun({
      run,
      to: "needs_clarification",
      reason: "A clarifying question was raised",
      actor,
      correlationId,
      occurredAt: NOW
    });
    await store.commit({
      idempotency: {
        scope: `test:transition:${WORKSPACE_ID}`,
        key: `${runId}:needs_clarification:${Date.now()}-${Math.random()}`
      },
      appends: [{
        stream: { kind: "run", id: runId },
        expectedVersion: version,
        events: toNeedsClarification.events
      }],
      jobs: []
    });

    return { clarificationRef, evidenceDigest };
  };

  return { app, store, authenticated, createRun, seedClarification };
};

// ---------------------------------------------------------------------------
// Clarification answer route
// ---------------------------------------------------------------------------

describe("POST /v1/runs/:runId/clarifications/:clarificationRef/answer", () => {
  it("requires authentication", async () => {
    const { app } = await makeHarness();
    const response = await app.request(
      "/v1/runs/run_00000000-0000-4000-a000-000000000001/clarifications/clrf-001/answer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "Use React", origin: "api" })
      }
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 for a non-existent run", async () => {
    const { authenticated } = await makeHarness();
    const response = await authenticated(
      "/v1/runs/run_00000000-0000-4000-a000-000000000001/clarifications/clrf-001/answer",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "Use React", origin: "api" })
      }
    );
    expect(response.status).toBe(404);
  });

  it("answers a pending clarification and returns 200", async () => {
    const { authenticated, createRun, seedClarification } = await makeHarness();
    const { runId, workItemId } = await createRun("Clarification test");
    const { clarificationRef } = await seedClarification(runId, workItemId);

    const response = await authenticated(
      `/v1/runs/${runId}/clarifications/${clarificationRef}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "Use React", origin: "api" })
      }
    );

    expect(response.status).toBe(200);
    const body = AnswerClarificationResponseSchema.parse(await response.json());
    expect(body.runId).toBe(runId);
    expect(body.clarificationRef).toBe(clarificationRef);
    expect(body.replayed).toBe(false);
    expect(typeof body.answeredAt).toBe("string");
  });

  it("replays the same answer idempotently", async () => {
    const { authenticated, createRun, seedClarification } = await makeHarness();
    const { runId, workItemId } = await createRun("Idempotent test");
    const { clarificationRef } = await seedClarification(runId, workItemId);

    // First answer.
    const first = await authenticated(
      `/v1/runs/${runId}/clarifications/${clarificationRef}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "Use React", origin: "api" })
      }
    );
    expect(first.status).toBe(200);
    const firstBody = AnswerClarificationResponseSchema.parse(await first.json());
    expect(firstBody.replayed).toBe(false);

    // Second identical answer is a replay.
    const second = await authenticated(
      `/v1/runs/${runId}/clarifications/${clarificationRef}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "Use React", origin: "api" })
      }
    );
    expect(second.status).toBe(200);
    const secondBody = AnswerClarificationResponseSchema.parse(await second.json());
    expect(secondBody.replayed).toBe(true);
  });

  it("rejects an answer with an empty string", async () => {
    const { authenticated, createRun, seedClarification } = await makeHarness();
    const { runId, workItemId } = await createRun("Empty answer test");
    const { clarificationRef } = await seedClarification(runId, workItemId);

    const response = await authenticated(
      `/v1/runs/${runId}/clarifications/${clarificationRef}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "", origin: "api" })
      }
    );
    expect(response.status).toBe(400);
  });
});
