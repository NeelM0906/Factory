import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  it("opens a file in WAL mode with foreign keys and schema version 1", async () => {
    const database = openDatabase({ filePath: await temporaryDatabasePath() });

    expect(database.health()).toEqual({
      status: "ok",
      journalMode: "wal",
      schemaVersion: 1
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

    expect(row.count).toBe(1);
    reopened.close();
  });

  it("rolls back every statement from a failed migration", async () => {
    const database = openDatabase({ filePath: await temporaryDatabasePath() });
    const invalidMigration: Migration = {
      version: 2,
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

    expect(version.version).toBe(1);
    expect(probe).toBeUndefined();
    database.close();
  });
});
