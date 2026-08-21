import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_event_and_workflow_store",
    statements: [
      `CREATE TABLE events (
        global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        stream_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL CHECK (stream_version > 0),
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        payload_json TEXT NOT NULL,
        UNIQUE (stream_kind, stream_id, stream_version)
      )`,
      `CREATE INDEX events_global_replay_idx
        ON events (global_sequence)`,
      `CREATE INDEX events_workspace_run_idx
        ON events (workspace_id, stream_kind, stream_id, global_sequence)`,
      `CREATE TABLE idempotency_records (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      ) WITHOUT ROWID`,
      `CREATE TABLE workflow_jobs (
        job_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        handler TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX workflow_jobs_runnable_idx
        ON workflow_jobs (status, available_at, created_at)`,
      `CREATE INDEX workflow_jobs_expired_lease_idx
        ON workflow_jobs (status, lease_expires_at)`
    ]
  }
] as const;

const ensureMigrationTable = (connection: DatabaseSync): void => {
  connection.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )`);
};

export function applyMigrations(
  connection: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString()
): void {
  ensureMigrationTable(connection);
  const appliedRows = connection.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map(({ version }) => version));

  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (applied.has(migration.version)) continue;
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new TypeError(`Migration version ${migration.version} is invalid.`);
    }

    connection.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) connection.exec(statement);
      connection
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, now());
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  }
}
