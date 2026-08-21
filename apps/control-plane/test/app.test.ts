import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CreateRunResponseSchema,
  EventIdSchema,
  HealthResponseSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  PendingDomainEventSchema,
  RunIdSchema,
  WorkspaceIdSchema,
  createIdFactory
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import { createManualRun } from "@autostack/domain";

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

const makeHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-api-"));
  temporaryDirectories.push(directory);
  const database = openDatabase({ filePath: join(directory, "autostack.sqlite") });
  let eventNumber = 10;
  let entityNumber = 20;
  const nextUuid = () =>
    `123e4567-e89b-42d3-a456-${String(426614174000 + entityNumber++).padStart(12, "0")}`;
  const store = new SqliteDurableStore(database, {
    eventId: () =>
      EventIdSchema.parse(
        `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventNumber++).padStart(12, "0")}`
      ),
    leaseToken: () => "lease-token",
    now: () => NOW
  });
  const app = createApp({
    store,
    executor: { getStatus: () => "idle" },
    token: TOKEN,
    workspaceId: WORKSPACE_ID,
    ids: createIdFactory(nextUuid),
    now: () => NOW,
    correlationId: nextUuid
  });
  const authenticated = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...init.headers
      }
    });

  return { app, store, authenticated };
};

describe("control-plane health", () => {
  it("serves validated public health without sensitive paths", async () => {
    const { app, store } = await makeHarness();
    const response = await app.request("/v1/health");
    const health = HealthResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(health).toEqual({
      service: "autostack-control-plane",
      version: "0.1.0",
      status: "ok",
      storage: { status: "ok", journalMode: "wal", schemaVersion: 2 },
      executor: { status: "idle" }
    });
    expect(JSON.stringify(health)).not.toContain("sqlite");
    await store.close();
  });

  it("returns degraded health when storage is unavailable", async () => {
    const { app, store } = await makeHarness();
    await store.close();

    const response = await app.request("/v1/health");
    const health = HealthResponseSchema.parse(await response.json());

    expect(response.status).toBe(503);
    expect(health.status).toBe("degraded");
    expect(health.storage.status).toBe("degraded");
  });
});

describe("manual run API", () => {
  it("requires authentication for run data", async () => {
    const { app, store } = await makeHarness();
    const response = await app.request("/v1/runs");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Authentication required." }
    });
    await store.close();
  });

  it("authenticates unknown and future v1 routes except exactly health", async () => {
    const { app, store } = await makeHarness();

    expect((await app.request("/v1")).status).toBe(401);
    expect((await app.request("/v1/future-route")).status).toBe(401);
    expect((await app.request("/v1/health/extra")).status).toBe(401);
    expect((await app.request("/v1/health")).status).toBe(200);
    await store.close();
  });

  it("requires an idempotency key and a valid body", async () => {
    const { authenticated, store } = await makeHarness();
    const missingKey = await authenticated("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Create a run" })
    });
    const invalidBody = await authenticated("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "request-1" },
      body: JSON.stringify({ title: "   " })
    });

    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({
      error: { code: "missing_idempotency_key" }
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toMatchObject({ error: { code: "invalid_request" } });
    await store.close();
  });

  it("rejects a request body over the byte limit before JSON parsing", async () => {
    const { authenticated, store } = await makeHarness();
    const response = await authenticated("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "oversized" },
      body: JSON.stringify({ title: "Oversized", description: "x".repeat(140_000) })
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
    await store.close();
  });

  it("rejects malformed JSON, invalid event cursors, and unknown routes", async () => {
    const { authenticated, store } = await makeHarness();
    const malformedJson = await authenticated("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "request-1" },
      body: "{"
    });
    const invalidCursor = await authenticated(
      "/v1/runs/run_123e4567-e89b-42d3-a456-426614174099/events?after=-1"
    );
    const unknown = await authenticated("/v1/unknown");

    expect(malformedJson.status).toBe(400);
    expect(await malformedJson.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "run_not_found" } });
    await store.close();
  });

  it("creates once, replays exactly, lists, and reads ordered run events", async () => {
    const { authenticated, store } = await makeHarness();
    const request: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "request-1" },
      body: JSON.stringify({
        title: "Build the AutoStack foundation",
        description: "Create durable local state."
      })
    };

    const firstResponse = await authenticated("/v1/runs", request);
    const first = CreateRunResponseSchema.parse(await firstResponse.json());
    const replayResponse = await authenticated("/v1/runs", request);
    const replay = CreateRunResponseSchema.parse(await replayResponse.json());
    const listResponse = await authenticated("/v1/runs");
    const list = ListRunsResponseSchema.parse(await listResponse.json());
    const eventsResponse = await authenticated(`/v1/runs/${first.run.id}/events?after=0`);
    const events = ListEventsResponseSchema.parse(await eventsResponse.json());

    expect(firstResponse.status).toBe(201);
    expect(replayResponse.status).toBe(200);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      runId: first.run.id,
      title: "Build the AutoStack foundation",
      status: "queued"
    });
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({ type: "run.created", streamVersion: 1 });
    await store.close();
  });

  it("returns stable errors without stack traces", async () => {
    const { authenticated, store } = await makeHarness();
    const response = await authenticated(
      "/v1/runs/run_123e4567-e89b-42d3-a456-426614174099/events"
    );
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("run_not_found");
    expect(body).not.toContain("at ");
    await store.close();
  });

  it("returns run_not_found for every cursor and uses global event cursors", async () => {
    const { authenticated, store } = await makeHarness();
    const create = async (key: string, title: string) =>
      CreateRunResponseSchema.parse(
        await (
          await authenticated("/v1/runs", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": key },
            body: JSON.stringify({ title })
          })
        ).json()
      );
    const first = await create("cursor-1", "First run");
    await create("cursor-2", "Interleaved run");

    const events = ListEventsResponseSchema.parse(
      await (await authenticated(`/v1/runs/${first.run.id}/events?after=0`)).json()
    );
    expect(events.events.map((event) => event.globalSequence)).toEqual([2]);
    expect(events.nextSequence).toBe(4);
    const exhausted = ListEventsResponseSchema.parse(
      await (await authenticated(`/v1/runs/${first.run.id}/events?after=4`)).json()
    );
    expect(exhausted).toEqual({ events: [], nextSequence: 4 });

    const missing = await authenticated(
      "/v1/runs/run_123e4567-e89b-42d3-a456-426614174099/events?after=999"
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "run_not_found" } });
    await store.close();
  });

  it("does not expose a run that belongs to another workspace", async () => {
    const { authenticated, store } = await makeHarness();
    const foreign = createManualRun(
      { title: "Foreign workspace run" },
      {
        workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174099"),
        actor: { kind: "user", id: "foreign-user" },
        correlationId: "123e4567-e89b-42d3-a456-426614174099"
      },
      {
        now: () => NOW,
        ids: createIdFactory(() => "123e4567-e89b-42d3-a456-426614174099")
      }
    );
    await store.commit({
      idempotency: { scope: "test:foreign-run", key: "request" },
      appends: foreign.appends,
      jobs: []
    });

    const response = await authenticated(`/v1/runs/${foreign.run.id}/events?after=0`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "run_not_found" } });
    await store.close();
  });

  it("requires a current-workspace run creation event for existence", async () => {
    const { authenticated, store } = await makeHarness();
    const orphanRunId = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174097");
    await store.commit({
      idempotency: { scope: "test:orphan-run", key: "request" },
      appends: [
        {
          stream: { kind: "run", id: orphanRunId },
          expectedVersion: 0,
          events: [
            PendingDomainEventSchema.parse({
              workspaceId: WORKSPACE_ID,
              actor: { kind: "system", id: "autostack" },
              correlationId: "123e4567-e89b-42d3-a456-426614174097",
              occurredAt: NOW,
              type: "run.transitioned",
              payload: {
                runId: orphanRunId,
                from: "queued",
                to: "triaging",
                reason: "orphan transition"
              }
            })
          ]
        }
      ],
      jobs: []
    });

    const response = await authenticated(`/v1/runs/${orphanRunId}/events?after=0`);
    expect(response.status).toBe(404);
    await store.close();
  });

  it("projects every run after the event log exceeds one read page", async () => {
    const { authenticated, store } = await makeHarness();
    for (let index = 0; index < 251; index += 1) {
      const response = await authenticated("/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `page-${index}` },
        body: JSON.stringify({ title: `Run ${index}` })
      });
      expect(response.status).toBe(201);
    }

    const list = ListRunsResponseSchema.parse(await (await authenticated("/v1/runs")).json());
    expect(list.items).toHaveLength(251);
    expect(list.items[0]?.title).toBe("Run 250");
    await store.close();
  });
});
