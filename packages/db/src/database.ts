import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { StoreHealth } from "@autostack/domain";

import { applyMigrations } from "./migrations.js";

export interface OpenDatabaseOptions {
  readonly filePath: string;
  readonly busyTimeoutMs?: number;
}

export class AutoStackDatabase {
  readonly connection: DatabaseSync;
  #closed = false;

  constructor(connection: DatabaseSync) {
    this.connection = connection;
  }

  health(): StoreHealth {
    const journal = this.connection.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    const version = this.connection
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };

    return {
      status:
        journal.journal_mode.toLowerCase() === "wal" && version.version > 0 ? "ok" : "degraded",
      journalMode: "wal",
      schemaVersion: version.version
    };
  }

  close(): void {
    if (this.#closed) return;
    this.connection.close();
    this.#closed = true;
  }
}

export function openDatabase(options: OpenDatabaseOptions): AutoStackDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
    throw new RangeError("busyTimeoutMs must be an integer between 0 and 60000.");
  }

  const filePath = resolve(options.filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  const connection = new DatabaseSync(filePath);

  try {
    connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    connection.exec("PRAGMA foreign_keys = ON");
    connection.exec("PRAGMA journal_mode = WAL");
    applyMigrations(connection);
    return new AutoStackDatabase(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}
