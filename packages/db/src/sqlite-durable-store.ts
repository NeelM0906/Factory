import type { DatabaseSync } from "node:sqlite";

import {
  CommitRequestSchema,
  CompleteJobRequestSchema,
  EventIdSchema,
  FailJobRequestSchema,
  JobIdSchema,
  PendingDomainEventSchema,
  RunIdSchema,
  RunSummarySchema,
  StreamRefSchema,
  StoredDomainEventSchema,
  WorkspaceIdSchema,
  normalizeSafeJson,
  type EventId,
  type PendingDomainEvent,
  type StoredDomainEvent
} from "@autostack/contracts";
import {
  LeaseConflictError,
  OptimisticConcurrencyError,
  type CommitRequest,
  type CommitResult,
  type CompleteJobRequest,
  type DurableStore,
  type FailJobRequest,
  type HeartbeatRequest,
  type LeaseNextRequest,
  type LeasedWorkflowJob,
  type NewWorkflowJob,
  type ReadAllRequest,
  type ReadCommitResultRequest,
  type ListRunSummariesRequest,
  type ReadRunEventsRequest,
  type ReadStreamRequest,
  type RunExistsRequest,
  type StoreHealth,
  type StreamAppend
} from "@autostack/domain";

import { type AutoStackDatabase } from "./database.js";
import { decodeEventRow, decodeJobRow } from "./codecs.js";
import { digestCommitRequest, digestText, IdempotencyStore } from "./idempotency-store.js";
import { updateRunSummary } from "./run-summary-store.js";

type Row = Readonly<Record<string, unknown>>;

export interface SqliteDurableStoreDependencies {
  readonly eventId: () => EventId;
  readonly leaseToken: () => string;
  readonly now: () => string;
  readonly sensitiveValues?: readonly string[];
}

const parseCanonicalTimestamp = (isoTimestamp: string): number => {
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== isoTimestamp) {
    throw new TypeError("A canonical UTC timestamp is required.");
  }
  return timestamp;
};

const addMilliseconds = (isoTimestamp: string, milliseconds: number): string => {
  const timestamp = parseCanonicalTimestamp(isoTimestamp);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new TypeError("A positive lease duration is required.");
  }
  return new Date(timestamp + milliseconds).toISOString();
};

export class SqliteDurableStore implements DurableStore {
  readonly #database: AutoStackDatabase;
  readonly #connection: DatabaseSync;
  readonly #dependencies: SqliteDurableStoreDependencies;
  readonly #idempotency: IdempotencyStore;

  constructor(database: AutoStackDatabase, dependencies: SqliteDurableStoreDependencies) {
    this.#database = database;
    this.#connection = database.connection;
    this.#dependencies = dependencies;
    this.#idempotency = new IdempotencyStore(this.#connection, dependencies.now);
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    const snapshot = normalizeSafeJson(request, this.#dependencies.sensitiveValues ?? []);
    const validated = CommitRequestSchema.parse(snapshot);
    const requestDigest = digestCommitRequest(validated);
    return this.#transaction(() => {
      const replay = this.#idempotency.find(validated.idempotency.scope, validated.idempotency.key);
      if (replay !== null) {
        if (replay.binding.kind !== "commit") {
          throw new TypeError("The idempotency key is bound to another operation.");
        }
        if (replay.binding.requestDigest === undefined) {
          throw new TypeError("Opaque legacy idempotency records cannot be generically replayed.");
        } else if (replay.binding.requestDigest !== requestDigest) {
          throw new TypeError("The idempotency key is bound to another commit request.");
        }
        return replay.result;
      }

      const result = this.#applyCommit(validated.appends, validated.jobs);
      this.#idempotency.save(validated.idempotency.scope, validated.idempotency.key, result, {
        kind: "commit",
        requestDigest
      });
      return result;
    });
  }

  async readCommitResult(request: ReadCommitResultRequest): Promise<CommitResult | null> {
    const replay = this.#idempotency.find(request.scope, request.key);
    if (replay === null) return null;
    if (replay.binding.kind !== "commit") {
      throw new TypeError("The idempotency key is bound to another operation.");
    }
    return { ...replay.result, replayed: true };
  }

  async readStream(request: ReadStreamRequest): Promise<readonly StoredDomainEvent[]> {
    const stream = StreamRefSchema.parse(request.stream);
    if (
      request.afterVersion !== undefined &&
      (!Number.isSafeInteger(request.afterVersion) || request.afterVersion < 0)
    ) {
      throw new TypeError("afterVersion must be a non-negative safe integer.");
    }
    const afterVersion = Math.max(0, request.afterVersion ?? 0);
    const rows = this.#connection
      .prepare(
        `SELECT * FROM events
         WHERE stream_kind = ? AND stream_id = ? AND stream_version > ?
         ORDER BY stream_version ASC`
      )
      .all(stream.kind, stream.id, afterVersion) as Row[];
    return rows.map(decodeEventRow);
  }

  async readAll(request: ReadAllRequest): Promise<readonly StoredDomainEvent[]> {
    if (
      request.afterGlobalSequence !== undefined &&
      (!Number.isSafeInteger(request.afterGlobalSequence) || request.afterGlobalSequence < 0)
    ) {
      throw new TypeError("afterGlobalSequence must be a non-negative safe integer.");
    }
    if (request.workspaceId !== undefined) WorkspaceIdSchema.parse(request.workspaceId);
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit <= 0)
    ) {
      throw new TypeError("limit must be a positive safe integer.");
    }
    const afterGlobalSequence = Math.max(0, request.afterGlobalSequence ?? 0);
    const limit = Math.min(500, request.limit ?? 100);
    const rows =
      request.workspaceId === undefined
        ? (this.#connection
            .prepare(
              `SELECT * FROM events
               WHERE global_sequence > ?
               ORDER BY global_sequence ASC
               LIMIT ?`
            )
            .all(afterGlobalSequence, limit) as Row[])
        : (this.#connection
            .prepare(
              `SELECT * FROM events
               WHERE global_sequence > ? AND workspace_id = ?
               ORDER BY global_sequence ASC
               LIMIT ?`
            )
            .all(afterGlobalSequence, request.workspaceId, limit) as Row[]);
    return rows.map(decodeEventRow);
  }

  async runExists(request: RunExistsRequest): Promise<boolean> {
    WorkspaceIdSchema.parse(request.workspaceId);
    RunIdSchema.parse(request.runId);
    return this.#runExists(request.workspaceId, request.runId);
  }

  async readRunEvents(request: ReadRunEventsRequest): Promise<readonly StoredDomainEvent[]> {
    WorkspaceIdSchema.parse(request.workspaceId);
    RunIdSchema.parse(request.runId);
    if (
      request.afterGlobalSequence !== undefined &&
      (!Number.isSafeInteger(request.afterGlobalSequence) || request.afterGlobalSequence < 0)
    ) {
      throw new TypeError("afterGlobalSequence must be a non-negative safe integer.");
    }
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit <= 0)
    ) {
      throw new TypeError("limit must be a positive safe integer.");
    }
    const rows = this.#connection
      .prepare(
        `SELECT * FROM events
         WHERE workspace_id = ? AND stream_kind = 'run' AND stream_id = ?
           AND global_sequence > ?
         ORDER BY global_sequence ASC LIMIT ?`
      )
      .all(
        request.workspaceId,
        request.runId,
        request.afterGlobalSequence ?? 0,
        Math.min(100, request.limit ?? 100)
      ) as Row[];
    return rows.map(decodeEventRow);
  }

  async listRunSummaries(request: ListRunSummariesRequest) {
    WorkspaceIdSchema.parse(request.workspaceId);
    if (
      request.beforeGlobalSequence !== undefined &&
      (!Number.isSafeInteger(request.beforeGlobalSequence) || request.beforeGlobalSequence <= 0)
    ) {
      throw new TypeError("beforeGlobalSequence must be a positive safe integer.");
    }
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit <= 0)
    ) {
      throw new TypeError("limit must be a positive safe integer.");
    }
    const limit = Math.min(100, request.limit ?? 100);
    const rows = (
      request.beforeGlobalSequence === undefined
        ? this.#connection
            .prepare(
              `SELECT * FROM run_summaries WHERE workspace_id = ?
             ORDER BY last_global_sequence DESC LIMIT ?`
            )
            .all(request.workspaceId, limit + 1)
        : this.#connection
            .prepare(
              `SELECT * FROM run_summaries
             WHERE workspace_id = ? AND last_global_sequence < ?
             ORDER BY last_global_sequence DESC LIMIT ?`
            )
            .all(request.workspaceId, request.beforeGlobalSequence, limit + 1)
    ) as Row[];
    const items = rows.slice(0, limit).map((row) =>
      RunSummarySchema.parse({
        runId: this.#text(row.run_id, "run_id"),
        workItemId: this.#text(row.work_item_id, "work_item_id"),
        title: this.#text(row.title, "title"),
        source: this.#text(row.source, "source"),
        status: this.#text(row.status, "status"),
        ...(row.current_stage === null
          ? {}
          : { currentStage: this.#text(row.current_stage, "current_stage") }),
        lastGlobalSequence: this.#integer(row.last_global_sequence, "last_global_sequence"),
        createdAt: this.#text(row.created_at, "created_at"),
        updatedAt: this.#text(row.updated_at, "updated_at")
      })
    );
    const nextCursor = rows.length > limit ? items.at(-1)?.lastGlobalSequence : undefined;
    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async leaseNext(request: LeaseNextRequest): Promise<LeasedWorkflowJob | null> {
    if (request.workerId.trim() === "" || request.workerId.length > 200) {
      throw new TypeError("workerId must be non-empty and at most 200 characters.");
    }
    parseCanonicalTimestamp(request.now);
    return this.#transaction(() => {
      const leaseExpiresAt = addMilliseconds(request.now, request.leaseDurationMs);

      while (true) {
        const candidate = this.#connection
          .prepare(
            `SELECT * FROM workflow_jobs
             WHERE (status = 'queued' AND available_at <= ?)
                OR (status = 'leased' AND lease_expires_at <= ?)
             ORDER BY available_at ASC, created_at ASC, job_id ASC
             LIMIT 1`
          )
          .get(request.now, request.now) as Row | undefined;
        if (candidate === undefined) return null;

        const attempt = this.#integer(candidate.attempt, "attempt") + 1;
        const maxAttempts = this.#integer(candidate.max_attempts, "max_attempts");
        const jobId = this.#text(candidate.job_id, "job_id");
        if (attempt > maxAttempts) {
          this.#connection
            .prepare(
              `UPDATE workflow_jobs
               SET status = 'failed', last_error_json = ?, updated_at = ?,
                   lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
               WHERE job_id = ?`
            )
            .run(
              JSON.stringify({
                code: "workflow_lease_exhausted",
                name: "LeaseExpiredError",
                message: "The workflow job exhausted its lease attempts.",
                retryable: false
              }),
              request.now,
              jobId
            );
          continue;
        }

        const leaseToken = this.#uniqueLeaseToken();
        this.#connection
          .prepare(
            `UPDATE workflow_jobs
             SET status = 'leased', attempt = ?, lease_owner = ?, lease_token = ?,
                 lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
             WHERE job_id = ?`
          )
          .run(
            attempt,
            request.workerId,
            leaseToken,
            leaseExpiresAt,
            request.now,
            request.now,
            jobId
          );
        const leased = this.#connection
          .prepare("SELECT * FROM workflow_jobs WHERE job_id = ?")
          .get(jobId) as Row;
        return decodeJobRow(leased);
      }
    });
  }

  async heartbeat(request: HeartbeatRequest): Promise<void> {
    JobIdSchema.parse(request.jobId);
    if (request.leaseToken.trim() === "") throw new TypeError("leaseToken must be non-empty.");
    parseCanonicalTimestamp(request.now);
    const leaseExpiresAt = addMilliseconds(request.now, request.leaseDurationMs);
    const result = this.#connection
      .prepare(
        `UPDATE workflow_jobs
         SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE job_id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?`
      )
      .run(
        leaseExpiresAt,
        request.now,
        request.now,
        request.jobId,
        request.leaseToken,
        request.now
      );
    if (result.changes !== 1) throw new LeaseConflictError(request.jobId);
  }

  async completeJob(request: CompleteJobRequest): Promise<CommitResult> {
    const snapshot = CompleteJobRequestSchema.parse(
      normalizeSafeJson(request, this.#dependencies.sensitiveValues ?? [])
    );
    const output = CommitRequestSchema.parse({
      idempotency: snapshot.idempotency,
      appends: snapshot.appends,
      jobs: snapshot.jobs
    });
    const leaseDigest = digestText(snapshot.leaseToken);
    const requestDigest = digestCommitRequest({ ...output, idempotency: output.idempotency });
    return this.#transaction(() => {
      parseCanonicalTimestamp(snapshot.now);
      const replay = this.#idempotency.find(output.idempotency.scope, output.idempotency.key);
      if (replay !== null) {
        if (
          replay.binding.kind !== "job_completion" ||
          replay.binding.jobId !== snapshot.jobId ||
          replay.binding.leaseDigest !== leaseDigest
        ) {
          if (replay.binding.kind === "job_completion") {
            throw new LeaseConflictError(snapshot.jobId);
          }
          throw new TypeError("The idempotency key is bound to another operation.");
        }
        if (replay.binding.requestDigest !== requestDigest) {
          throw new TypeError("The idempotency key is bound to another completion request.");
        }
        return replay.result;
      }
      const leased = this.#assertActiveLease(snapshot.jobId, snapshot.leaseToken, snapshot.now);
      const workspaceId = this.#text(leased.workspace_id, "workspace_id");
      const runId = this.#text(leased.run_id, "run_id");
      for (const append of output.appends) {
        if (append.stream.kind === "run" && append.stream.id !== runId) {
          throw new TypeError("A completion append must match its leased run.");
        }
        if (append.events.some((event) => event.workspaceId !== workspaceId)) {
          throw new TypeError("A completion append must match its leased workspace.");
        }
        for (const event of append.events) {
          if (
            (event.type === "stage.queued" ||
              event.type === "stage.leased" ||
              event.type === "stage.succeeded" ||
              event.type === "stage.failed") &&
            (append.stream.kind !== "run" ||
              append.stream.id !== runId ||
              event.payload.runId !== runId ||
              event.payload.jobId !== snapshot.jobId ||
              event.payload.stage !== this.#text(leased.stage, "stage"))
          ) {
            throw new TypeError("Stage evidence must match its leased run, job, and stage.");
          }
        }
      }
      for (const child of output.jobs) {
        if (child.workspaceId !== workspaceId || child.runId !== runId) {
          throw new TypeError("A child workflow job must match its leased workspace and run.");
        }
      }
      const result = this.#applyCommit(output.appends, output.jobs);
      const update = this.#connection
        .prepare(
          `UPDATE workflow_jobs
           SET status = 'completed', updated_at = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, heartbeat_at = NULL
           WHERE job_id = ? AND status = 'leased' AND lease_token = ?`
        )
        .run(snapshot.now, snapshot.jobId, snapshot.leaseToken);
      if (update.changes !== 1) throw new LeaseConflictError(snapshot.jobId);
      this.#idempotency.save(output.idempotency.scope, output.idempotency.key, result, {
        kind: "job_completion",
        jobId: snapshot.jobId,
        leaseDigest,
        requestDigest
      });
      return result;
    });
  }

  async failJob(request: FailJobRequest): Promise<void> {
    const snapshot = FailJobRequestSchema.parse(
      normalizeSafeJson(request, this.#dependencies.sensitiveValues ?? [])
    );
    const failure = snapshot.error;
    this.#transaction(() => {
      parseCanonicalTimestamp(snapshot.now);
      if (snapshot.nextAvailableAt !== undefined) {
        parseCanonicalTimestamp(snapshot.nextAvailableAt);
      }
      const row = this.#assertActiveLease(snapshot.jobId, snapshot.leaseToken, snapshot.now);
      const attempt = this.#integer(row.attempt, "attempt");
      const maxAttempts = this.#integer(row.max_attempts, "max_attempts");
      let retry = false;
      let availableAt = this.#text(row.available_at, "available_at");
      if (failure.retryable && snapshot.nextAvailableAt !== undefined && attempt < maxAttempts) {
        retry = true;
        availableAt = snapshot.nextAvailableAt;
      }

      const update = this.#connection
        .prepare(
          `UPDATE workflow_jobs
           SET status = ?, available_at = ?, updated_at = ?, last_error_json = ?,
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL
           WHERE job_id = ? AND status = 'leased' AND lease_token = ?`
        )
        .run(
          retry ? "queued" : "failed",
          availableAt,
          snapshot.now,
          JSON.stringify(failure),
          snapshot.jobId,
          snapshot.leaseToken
        );
      if (update.changes !== 1) throw new LeaseConflictError(snapshot.jobId);
    });
  }

  async hasLeasedJobForRun(request: RunExistsRequest): Promise<boolean> {
    const row = this.#connection
      .prepare(
        `SELECT 1 AS found FROM workflow_jobs
         WHERE run_id = ? AND workspace_id = ? AND status = 'leased'
         LIMIT 1`
      )
      .get(request.runId, request.workspaceId) as { found: number } | undefined;
    return row !== undefined;
  }

  async health(): Promise<StoreHealth> {
    return this.#database.health();
  }

  async close(): Promise<void> {
    this.#database.close();
  }

  #applyCommit(appends: readonly StreamAppend[], jobs: readonly NewWorkflowJob[]): CommitResult {
    const streamKeys = new Set<string>();
    const storedEvents: StoredDomainEvent[] = [];

    for (const append of appends) {
      const key = `${append.stream.kind}:${append.stream.id}`;
      if (streamKeys.has(key))
        throw new TypeError(`Stream ${key} appears more than once in a commit.`);
      streamKeys.add(key);
      if (!Number.isSafeInteger(append.expectedVersion) || append.expectedVersion < 0) {
        throw new TypeError("expectedVersion must be a non-negative safe integer.");
      }

      const currentVersion = this.#currentVersion(append.stream.kind, append.stream.id);
      if (currentVersion !== append.expectedVersion) {
        throw new OptimisticConcurrencyError(
          append.stream.id,
          append.expectedVersion,
          currentVersion
        );
      }

      const eventWorkspace = append.events[0]?.workspaceId;
      if (eventWorkspace === undefined) throw new TypeError("A stream append requires an event.");
      const establishedWorkspace = this.#streamWorkspace(append.stream.kind, append.stream.id);
      if (establishedWorkspace !== undefined && establishedWorkspace !== eventWorkspace) {
        throw new TypeError("A stream append must match its immutable workspace owner.");
      }
      if (append.events.some((event) => event.workspaceId !== eventWorkspace)) {
        throw new TypeError("Every event in a stream append must share one workspace owner.");
      }
      if (currentVersion === 0) {
        const creation = append.events[0];
        const validCreation =
          (append.stream.kind === "run" && creation?.type === "run.created") ||
          (append.stream.kind === "work_item" && creation?.type === "work_item.created");
        if (!validCreation) {
          throw new TypeError("A new stream must begin with its creation event.");
        }
      }

      append.events.forEach((candidate, index) => {
        const event = PendingDomainEventSchema.parse(candidate);
        const isCreation = event.type === "work_item.created" || event.type === "run.created";
        if (isCreation && (currentVersion !== 0 || index !== 0)) {
          throw new TypeError("A creation event is only valid at stream version one.");
        }
        const eventId = EventIdSchema.parse(this.#dependencies.eventId());
        const streamVersion = append.expectedVersion + index + 1;
        const insert = this.#connection
          .prepare(
            `INSERT INTO events (
               event_id, workspace_id, stream_kind, stream_id, stream_version,
               event_type, schema_version, occurred_at, actor_json,
               correlation_id, causation_id, payload_json
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
          )
          .run(
            eventId,
            event.workspaceId,
            append.stream.kind,
            append.stream.id,
            streamVersion,
            event.type,
            event.occurredAt,
            JSON.stringify(event.actor),
            event.correlationId,
            event.causationId ?? null,
            JSON.stringify(event.payload)
          );
        const globalSequence = Number(insert.lastInsertRowid);
        if (!Number.isSafeInteger(globalSequence) || globalSequence <= 0) {
          throw new RangeError("SQLite returned an invalid event sequence.");
        }
        storedEvents.push(
          StoredDomainEventSchema.parse({
            ...event,
            eventId,
            stream: append.stream,
            streamVersion,
            globalSequence,
            schemaVersion: 1
          })
        );
      });
    }

    for (const event of storedEvents) updateRunSummary(this.#connection, event);

    for (const workflowJob of jobs) {
      if (!this.#runExists(workflowJob.workspaceId, workflowJob.runId)) {
        throw new TypeError("A workflow job must reference an existing run in its workspace.");
      }
      this.#insertJob(workflowJob);
    }
    return { events: storedEvents, jobIds: jobs.map(({ jobId }) => jobId), replayed: false };
  }

  #insertJob(job: NewWorkflowJob): void {
    if (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts <= 0) {
      throw new TypeError("maxAttempts must be a positive safe integer.");
    }
    parseCanonicalTimestamp(job.availableAt);
    parseCanonicalTimestamp(job.createdAt);
    this.#connection
      .prepare(
        `INSERT INTO workflow_jobs (
           job_id, workspace_id, run_id, stage, handler, payload_json, status,
           attempt, max_attempts, available_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`
      )
      .run(
        job.jobId,
        job.workspaceId,
        job.runId,
        job.stage,
        job.handler,
        JSON.stringify(job.payload),
        job.maxAttempts,
        job.availableAt,
        job.createdAt,
        job.createdAt
      );
  }

  #uniqueLeaseToken(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.#dependencies.leaseToken();
      if (candidate.trim() === "" || candidate.length > 500) continue;
      const collision = this.#connection
        .prepare("SELECT 1 AS found FROM workflow_jobs WHERE status = 'leased' AND lease_token = ?")
        .get(candidate);
      if (collision === undefined) return candidate;
    }
    throw new Error("Unable to allocate a unique workflow lease token.");
  }

  #currentVersion(streamKind: string, streamId: string): number {
    const row = this.#connection
      .prepare(
        `SELECT COALESCE(MAX(stream_version), 0) AS version
         FROM events WHERE stream_kind = ? AND stream_id = ?`
      )
      .get(streamKind, streamId) as Row;
    return this.#integer(row.version, "version");
  }

  #streamWorkspace(streamKind: string, streamId: string): string | undefined {
    const rows = this.#connection
      .prepare(
        `SELECT DISTINCT workspace_id AS workspaceId FROM events
         WHERE stream_kind = ? AND stream_id = ? LIMIT 2`
      )
      .all(streamKind, streamId) as Row[];
    if (rows.length > 1) throw new TypeError("A stream has ambiguous workspace ownership.");
    return rows[0] === undefined ? undefined : this.#text(rows[0].workspaceId, "workspaceId");
  }

  #runExists(workspaceId: string, runId: string): boolean {
    return (
      this.#connection
        .prepare(
          `SELECT 1 AS found FROM events
           WHERE workspace_id = ? AND stream_kind = 'run' AND stream_id = ?
             AND event_type = 'run.created'
           LIMIT 1`
        )
        .get(workspaceId, runId) !== undefined
    );
  }

  #assertActiveLease(jobId: string, leaseToken: string, now: string): Row {
    const row = this.#connection
      .prepare(
        `SELECT * FROM workflow_jobs
         WHERE job_id = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?`
      )
      .get(jobId, leaseToken, now) as Row | undefined;
    if (row === undefined) throw new LeaseConflictError(jobId);
    return row;
  }

  #transaction<T>(operation: () => T): T {
    this.#connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.#connection.exec("ROLLBACK");
      throw error;
    }
  }

  #text(value: unknown, field: string): string {
    if (typeof value !== "string") throw new TypeError(`${field} is not text.`);
    return value;
  }

  #integer(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new TypeError(`${field} is not a safe integer.`);
    }
    return value;
  }
}
