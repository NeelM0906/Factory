import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventIdSchema, WorkspaceIdSchema } from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";

import { IdempotencyConflictError, RunService } from "../src/run-service.js";

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

describe("RunService", () => {
  it("raises a typed conflict when a create-run key is reused for another command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autostack-run-service-"));
    temporaryDirectories.push(directory);
    let eventNumber = 1;
    const store = new SqliteDurableStore(
      openDatabase({ filePath: join(directory, "state.sqlite") }),
      {
        eventId: () =>
          EventIdSchema.parse(
            `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventNumber++).padStart(12, "0")}`
          ),
        leaseToken: () => "lease-token",
        now: () => NOW
      }
    );
    const service = new RunService({ store, workspaceId: WORKSPACE_ID, now: () => NOW });
    await service.create({ title: "Original command" }, "same-key");

    await expect(service.create({ title: "Different command" }, "same-key")).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    await store.close();
  });
});
