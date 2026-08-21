import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CreateRunResponseSchema,
  EventIdSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  WorkspaceIdSchema,
  createIdFactory
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";

import { createApp } from "../src/app.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const NOW = "2026-08-20T12:00:00.000Z";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("foundation restart durability", () => {
  it("preserves one run and exact idempotent replay across a store restart", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "autostack-foundation-flow-"));
    temporaryDirectories.push(dataDirectory);
    const filePath = join(dataDirectory, "autostack.sqlite");
    let sequence = 10;
    const uuid = () =>
      `123e4567-e89b-42d3-a456-${String(426614174000 + sequence++).padStart(12, "0")}`;

    const start = () => {
      const store = new SqliteDurableStore(openDatabase({ filePath }), {
        eventId: () => EventIdSchema.parse(`evt_${uuid()}`),
        leaseToken: uuid,
        now: () => NOW
      });
      const app = createApp({
        store,
        executor: { getStatus: () => "idle" },
        token: TOKEN,
        workspaceId: WORKSPACE_ID,
        ids: createIdFactory(uuid),
        now: () => NOW,
        correlationId: uuid
      });
      const request = (path: string, init: RequestInit = {}) =>
        app.request(path, {
          ...init,
          headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers }
        });
      return { store, request };
    };

    const createRequest: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "restart-command-1" },
      body: JSON.stringify({
        title: "Prove restart durability",
        description: "The same command must replay without duplicate state."
      })
    };

    const firstRuntime = start();
    const firstResponse = await firstRuntime.request("/v1/runs", createRequest);
    const first = CreateRunResponseSchema.parse(await firstResponse.json());
    const firstEventsResponse = await firstRuntime.request(`/v1/runs/${first.run.id}/events`);
    const firstEvents = ListEventsResponseSchema.parse(await firstEventsResponse.json());
    await firstRuntime.store.close();

    const restartedRuntime = start();
    const list = ListRunsResponseSchema.parse(
      await (await restartedRuntime.request("/v1/runs")).json()
    );
    const replayedEvents = ListEventsResponseSchema.parse(
      await (await restartedRuntime.request(`/v1/runs/${first.run.id}/events`)).json()
    );
    const replayResponse = await restartedRuntime.request("/v1/runs", createRequest);
    const replay = CreateRunResponseSchema.parse(await replayResponse.json());

    expect(firstResponse.status).toBe(201);
    expect(replayResponse.status).toBe(200);
    expect(list.items).toHaveLength(1);
    expect(replayedEvents.events).toEqual(firstEvents.events);
    expect(replay).toEqual({ ...first, replayed: true });

    const finalList = ListRunsResponseSchema.parse(
      await (await restartedRuntime.request("/v1/runs")).json()
    );
    const finalEvents = ListEventsResponseSchema.parse(
      await (await restartedRuntime.request(`/v1/runs/${first.run.id}/events`)).json()
    );
    expect(finalList.items).toHaveLength(1);
    expect(finalEvents.events).toHaveLength(firstEvents.events.length);
    await restartedRuntime.store.close();
  });
});
