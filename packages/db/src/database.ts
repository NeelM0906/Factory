import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
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

const containsPath = (base: string, candidate: string): boolean => {
  const pathFromBase = relative(base, candidate);
  return (
    pathFromBase === "" ||
    (!isAbsolute(pathFromBase) && pathFromBase !== ".." && !pathFromBase.startsWith(`..${sep}`))
  );
};

const assertNoSymlinkComponents = (stateDirectory: string): void => {
  const trustedBoundary = [resolve(process.cwd()), resolve(tmpdir()), resolve(homedir())]
    .filter((candidate) => containsPath(candidate, stateDirectory))
    .sort((left, right) => right.length - left.length)[0];
  let current = trustedBoundary ?? parse(stateDirectory).root;
  const pathFromBoundary = relative(current, stateDirectory);
  for (const component of pathFromBoundary.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new TypeError("The database state path must not contain a symbolic link.");
    }
  }
};

export function openDatabase(options: OpenDatabaseOptions): AutoStackDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
    throw new RangeError("busyTimeoutMs must be an integer between 0 and 60000.");
  }

  const filePath = resolve(options.filePath);
  const stateDirectory = dirname(filePath);
  assertNoSymlinkComponents(stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(stateDirectory);
  chmodSync(stateDirectory, 0o700);
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new TypeError("The database file must not be a symbolic link.");
  }
  const connection = new DatabaseSync(filePath);

  try {
    chmodSync(filePath, 0o600);
    connection.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    connection.exec("PRAGMA foreign_keys = ON");
    connection.exec("PRAGMA journal_mode = WAL");
    for (const sidecar of [`${filePath}-wal`, `${filePath}-shm`]) {
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
    applyMigrations(connection);
    return new AutoStackDatabase(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}
