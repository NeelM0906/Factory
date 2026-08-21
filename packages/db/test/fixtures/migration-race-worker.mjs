import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { applyMigrations } from "../../src/migrations.ts";

const migration = {
  version: 5,
  name: "concurrent_test_migration",
  statements: ["CREATE TABLE concurrent_migration_probe (id TEXT PRIMARY KEY)"]
};

const connection = new DatabaseSync(workerData.filePath);
connection.exec("PRAGMA busy_timeout = 5000");
connection.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
)`);
parentPort.postMessage({ status: "ready" });

parentPort.once("message", () => {
  parentPort.postMessage({ status: "attempting" });
  try {
    applyMigrations(connection, [migration], () => "2026-08-20T12:00:01.000Z");
    parentPort.postMessage({ status: "completed" });
  } catch (error) {
    parentPort.postMessage({
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown migration error."
    });
  } finally {
    connection.close();
  }
});
