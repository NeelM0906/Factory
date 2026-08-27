import { lstat, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceIdSchema, createIdFactory, type PendingDomainEvent } from "@autostack/contracts";
import { createManualRun } from "@autostack/domain";

import { MIGRATIONS, applyMigrations, openDatabase, type Migration } from "../src/index.js";

const temporaryDirectories: string[] = [];

const temporaryDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-db-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "autostack.sqlite");
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("AutoStack SQLite database", () => {
  it("opens a file in WAL mode with foreign keys and schema version 4", async () => {
    const database = openDatabase({ filePath: await temporaryDatabasePath() });

    expect(database.health()).toEqual({
      status: "ok",
      journalMode: "wal",
      schemaVersion: 4
    });
    expect(database.connection.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

    database.close();
  });

  it("creates the complete event and workflow schema", async () => {
    const database = openDatabase({ filePath: await temporaryDatabasePath() });
    const rows = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(rows.map(({ name }) => name)).toEqual([
      "events",
      "idempotency_records",
      "run_summaries",
      "schema_migrations",
      "sqlite_sequence",
      "workflow_jobs"
    ]);

    database.close();
  });

  it("does not duplicate a migration when reopening the same file", async () => {
    const filePath = await temporaryDatabasePath();
    openDatabase({ filePath }).close();
    const reopened = openDatabase({ filePath });
    const row = reopened.connection
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };

    expect(row.count).toBe(4);
    reopened.close();
  });

  it("upgrades a database created with the original version-one idempotency table", async () => {
    const filePath = await temporaryDatabasePath();
    await mkdir(join(filePath, ".."), { recursive: true });
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE idempotency_records (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      ) WITHOUT ROWID;
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'initial_event_and_workflow_store', '2026-08-20T12:00:00.000Z');
    `);
    legacy.close();

    const upgraded = openDatabase({ filePath });
    const columns = upgraded.connection
      .prepare("PRAGMA table_info(idempotency_records)")
      .all() as Array<{ name: string }>;
    expect(upgraded.health().schemaVersion).toBe(4);
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "operation_kind",
        "completion_job_id",
        "completion_lease_digest",
        "completion_request_digest",
        "commit_request_digest"
      ])
    );
    upgraded.close();
  });

  it("rechecks applied migrations after waiting for a competing writer", async () => {
    const filePath = await temporaryDatabasePath();
    const database = openDatabase({ filePath });
    const worker = new Worker(new URL("./fixtures/migration-race-worker.mjs", import.meta.url), {
      workerData: { filePath }
    });
    const nextMessage = () =>
      new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
        worker.once("message", resolveMessage);
        worker.once("error", rejectMessage);
      });

    expect(await nextMessage()).toEqual({ status: "ready" });
    database.connection.exec("BEGIN IMMEDIATE");
    const attempting = nextMessage();
    worker.postMessage({ start: true });
    expect(await attempting).toEqual({ status: "attempting" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    database.connection.exec("CREATE TABLE concurrent_migration_probe (id TEXT PRIMARY KEY)");
    database.connection
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(5, "concurrent_test_migration", "2026-08-20T12:00:00.000Z");
    database.connection.exec("COMMIT");

    expect(await nextMessage()).toEqual({ status: "completed" });
    expect(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 5")
        .get()
    ).toEqual({ count: 1 });
    await worker.terminate();
    database.close();
  });

  // Worker-bootstrap bound: this case spawns two `--import tsx` worker threads that each transpile
  // and open the real SQLite file, and measures well under 1s on an unconstrained dev machine. It
  // reached 4925ms of the 5s default in CI run 33109728652 — `pnpm test:coverage` on a 2-vCPU runner
  // with V8 coverage instrumentation while every workspace package tests in parallel leaves worker
  // startup no margin. Applied per case so the package-wide default keeps protecting every other
  // test.
  it(
    "serializes run-summary backfill across concurrent legacy-database opens",
    { timeout: 15_000 },
    async () => {
      const filePath = await temporaryDatabasePath();
      await mkdir(join(filePath, ".."), { recursive: true });
      const legacy = new DatabaseSync(filePath);
      applyMigrations(legacy, MIGRATIONS.slice(0, 3));
      const decision = createManualRun(
        { title: "Concurrent legacy run" },
        {
          workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000"),
          actor: { kind: "user", id: "legacy-user" },
          correlationId: "123e4567-e89b-42d3-a456-426614174000"
        },
        {
          now: () => "2026-08-20T12:00:00.000Z",
          ids: createIdFactory(() => "123e4567-e89b-42d3-a456-426614174000")
        }
      );
      const insert = legacy.prepare(
        `INSERT INTO events (
         event_id, workspace_id, stream_kind, stream_id, stream_version, event_type,
         schema_version, occurred_at, actor_json, correlation_id, causation_id, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
      );
      let eventNumber = 1;
      for (const append of decision.appends) {
        for (const event of append.events as readonly PendingDomainEvent[]) {
          insert.run(
            `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventNumber++).padStart(12, "0")}`,
            event.workspaceId,
            append.stream.kind,
            append.stream.id,
            1,
            event.type,
            event.occurredAt,
            JSON.stringify(event.actor),
            event.correlationId,
            event.causationId ?? null,
            JSON.stringify(event.payload)
          );
        }
      }
      legacy.close();

      const workers = Array.from(
        { length: 2 },
        () =>
          new Worker(new URL("./fixtures/projection-backfill-worker.mjs", import.meta.url), {
            workerData: { filePath },
            execArgv: ["--import", "tsx"]
          })
      );
      const nextMessage = (worker: Worker) =>
        new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
          worker.once("message", resolveMessage);
          worker.once("error", rejectMessage);
        });
      await Promise.all(workers.map((worker) => nextMessage(worker)));
      const completions = workers.map((worker) => nextMessage(worker));
      for (const worker of workers) worker.postMessage({ start: true });

      expect(await Promise.all(completions)).toEqual([
        { status: "completed", count: 1 },
        { status: "completed", count: 1 }
      ]);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  );

  it("creates private state directories and database files", async () => {
    const filePath = await temporaryDatabasePath();
    const database = openDatabase({ filePath });

    expect((await stat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${filePath}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${filePath}-shm`)).mode & 0o777).toBe(0o600);
    database.close();
  });

  it("rejects symlinked state directories and database files", async () => {
    const root = await mkdtemp(join(tmpdir(), "autostack-db-links-"));
    temporaryDirectories.push(root);
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    const realFile = join(root, "real.sqlite");
    openDatabase({ filePath: realFile }).close();
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory, "dir");
    await symlink(realFile, join(root, "linked.sqlite"), "file");

    expect(() => openDatabase({ filePath: join(linkedDirectory, "state.sqlite") })).toThrow(
      /symbolic link/i
    );
    expect(() => openDatabase({ filePath: join(root, "linked.sqlite") })).toThrow(/symbolic link/i);
    expect((await lstat(linkedDirectory)).isSymbolicLink()).toBe(true);
  });

  it("rejects a state path containing an intermediate symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "autostack-db-intermediate-link-"));
    temporaryDirectories.push(root);
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    await mkdir(join(realDirectory, "nested"), { recursive: true });
    await symlink(realDirectory, linkedDirectory, "dir");

    expect(() => {
      const database = openDatabase({
        filePath: join(linkedDirectory, "nested", "autostack.sqlite")
      });
      database.close();
    }).toThrow(/symbolic link/i);
  });

  it("rolls back every statement from a failed migration", async () => {
    const database = openDatabase({ filePath: await temporaryDatabasePath() });
    const invalidMigration: Migration = {
      version: 5,
      name: "invalid_test_migration",
      statements: ["CREATE TABLE migration_probe (id TEXT PRIMARY KEY)", "THIS IS NOT VALID SQL"]
    };

    expect(() =>
      applyMigrations(database.connection, [invalidMigration], () => "2026-08-20T12:00:00.000Z")
    ).toThrow();

    const version = database.connection
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    const probe = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe'")
      .get();

    expect(version.version).toBe(4);
    expect(probe).toBeUndefined();
    database.close();
  });
});
