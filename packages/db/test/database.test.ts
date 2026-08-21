import { lstat, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase, type Migration } from "../src/index.js";

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
  it("opens a file in WAL mode with foreign keys and schema version 2", async () => {
    const database = openDatabase({ filePath: await temporaryDatabasePath() });

    expect(database.health()).toEqual({
      status: "ok",
      journalMode: "wal",
      schemaVersion: 2
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

    expect(row.count).toBe(2);
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
    expect(upgraded.health().schemaVersion).toBe(2);
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "operation_kind",
        "completion_job_id",
        "completion_lease_digest",
        "completion_request_digest"
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
      .run(3, "concurrent_test_migration", "2026-08-20T12:00:00.000Z");
    database.connection.exec("COMMIT");

    expect(await nextMessage()).toEqual({ status: "completed" });
    expect(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3")
        .get()
    ).toEqual({ count: 1 });
    await worker.terminate();
    database.close();
  });

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
      version: 3,
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

    expect(version.version).toBe(2);
    expect(probe).toBeUndefined();
    database.close();
  });
});
