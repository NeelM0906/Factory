import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  CommitRequestSchema,
  EventIdSchema,
  JobIdSchema,
  PendingDomainEventSchema,
  StreamRefSchema,
  StoredDomainEventSchema,
  WorkflowFailureSchema,
  WorkspaceIdSchema,
  assertSafeJson,
  type EventId,
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
  type ReadStreamRequest,
  type StoreHealth,
  type StreamAppend
} from "@autostack/domain";

import { type AutoStackDatabase } from "./database.js";
import { decodeCommitResult, decodeEventRow, decodeJobRow, encodeCommitResult } from "./codecs.js";

type Row = Readonly<Record<string, unknown>>;

type IdempotencyBinding =
  | { readonly kind: "commit" }
  | {
      readonly kind: "job_completion";
      readonly jobId: string;
      readonly leaseDigest: string;
      readonly requestDigest: string;
    };

interface IdempotencyRecord {
  readonly result: CommitResult;
  readonly binding: IdempotencyBinding;
}

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

  constructor(database: AutoStackDatabase, dependencies: SqliteDurableStoreDependencies) {
    this.#database = database;
    this.#connection = database.connection;
    this.#dependencies = dependencies;
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    assertSafeJson(request, this.#dependencies.sensitiveValues ?? []);
    const validated = CommitRequestSchema.parse(request);
    return this.#transaction(() => {
      const replay = this.#findIdempotency(validated.idempotency.scope, validated.idempotency.key);
      if (replay !== null) {
        if (replay.binding.kind !== "commit") {
          throw new TypeError("The idempotency key is bound to another operation.");
        }
        return replay.result;
      }

      const result = this.#applyCommit(validated.appends, validated.jobs);
      this.#saveIdempotency(validated.idempotency.scope, validated.idempotency.key, result, {
        kind: "commit"
      });
      return result;
    });
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
    const afterGlobalSequence = Math.max(0, request.afterGlobalSequence ?? 0);
    const limit = Math.min(500, Math.max(1, request.limit ?? 100));
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
    assertSafeJson(request, this.#dependencies.sensitiveValues ?? []);
    JobIdSchema.parse(request.jobId);
    if (request.leaseToken.trim() === "") throw new TypeError("leaseToken must be non-empty.");
    const output = CommitRequestSchema.parse({
      idempotency: request.idempotency,
      appends: request.appends,
      jobs: request.jobs
    });
    const leaseDigest = this.#digest(request.leaseToken);
    const requestDigest = this.#digest(
      JSON.stringify({ appends: output.appends, jobs: output.jobs })
    );
    return this.#transaction(() => {
      parseCanonicalTimestamp(request.now);
      const replay = this.#findIdempotency(output.idempotency.scope, output.idempotency.key);
      if (replay !== null) {
        if (
          replay.binding.kind !== "job_completion" ||
          replay.binding.jobId !== request.jobId ||
          replay.binding.leaseDigest !== leaseDigest
        ) {
          if (replay.binding.kind === "job_completion") {
            throw new LeaseConflictError(request.jobId);
          }
          throw new TypeError("The idempotency key is bound to another operation.");
        }
        if (replay.binding.requestDigest !== requestDigest) {
          throw new TypeError("The idempotency key is bound to another completion request.");
        }
        return replay.result;
      }
      const leased = this.#assertActiveLease(request.jobId, request.leaseToken, request.now);
      const workspaceId = this.#text(leased.workspace_id, "workspace_id");
      const runId = this.#text(leased.run_id, "run_id");
      for (const append of output.appends) {
        if (append.stream.kind === "run" && append.stream.id !== runId) {
          throw new TypeError("A completion append must match its leased run.");
        }
        if (append.events.some((event) => event.workspaceId !== workspaceId)) {
          throw new TypeError("A completion append must match its leased workspace.");
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
        .run(request.now, request.jobId, request.leaseToken);
      if (update.changes !== 1) throw new LeaseConflictError(request.jobId);
      this.#saveIdempotency(output.idempotency.scope, output.idempotency.key, result, {
        kind: "job_completion",
        jobId: request.jobId,
        leaseDigest,
        requestDigest
      });
      return result;
    });
  }

  async failJob(request: FailJobRequest): Promise<void> {
    assertSafeJson(request, this.#dependencies.sensitiveValues ?? []);
    JobIdSchema.parse(request.jobId);
    if (request.leaseToken.trim() === "") throw new TypeError("leaseToken must be non-empty.");
    const failure = WorkflowFailureSchema.parse(request.error);
    this.#transaction(() => {
      parseCanonicalTimestamp(request.now);
      if (request.nextAvailableAt !== undefined) {
        parseCanonicalTimestamp(request.nextAvailableAt);
      }
      const row = this.#assertActiveLease(request.jobId, request.leaseToken, request.now);
      const attempt = this.#integer(row.attempt, "attempt");
      const maxAttempts = this.#integer(row.max_attempts, "max_attempts");
      const retry =
        failure.retryable && request.nextAvailableAt !== undefined && attempt < maxAttempts;

      const update = this.#connection
        .prepare(
          `UPDATE workflow_jobs
           SET status = ?, available_at = ?, updated_at = ?, last_error_json = ?,
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL
           WHERE job_id = ? AND status = 'leased' AND lease_token = ?`
        )
        .run(
          retry ? "queued" : "failed",
          retry ? request.nextAvailableAt : this.#text(row.available_at, "available_at"),
          request.now,
          JSON.stringify(failure),
          request.jobId,
          request.leaseToken
        );
      if (update.changes !== 1) throw new LeaseConflictError(request.jobId);
    });
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

      append.events.forEach((candidate, index) => {
        const event = PendingDomainEventSchema.parse(candidate);
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

    for (const workflowJob of jobs) this.#insertJob(workflowJob);
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

  #findIdempotency(scope: string, key: string): IdempotencyRecord | null {
    if (scope.trim() === "" || key.trim() === "") {
      throw new TypeError("Idempotency scope and key must be non-empty.");
    }
    const row = this.#connection
      .prepare(
        `SELECT result_json, operation_kind, completion_job_id,
                completion_lease_digest, completion_request_digest
         FROM idempotency_records WHERE scope = ? AND key = ?`
      )
      .get(scope, key) as Row | undefined;
    if (row === undefined) return null;
    const result = decodeCommitResult(this.#text(row.result_json, "result_json"));
    const operationKind = this.#text(row.operation_kind, "operation_kind");
    if (operationKind === "commit") return { result, binding: { kind: "commit" } };
    if (operationKind !== "job_completion") {
      throw new TypeError("The stored idempotency operation kind is invalid.");
    }
    return {
      result,
      binding: {
        kind: "job_completion",
        jobId: this.#text(row.completion_job_id, "completion_job_id"),
        leaseDigest: this.#text(row.completion_lease_digest, "completion_lease_digest"),
        requestDigest: this.#text(row.completion_request_digest, "completion_request_digest")
      }
    };
  }

  #saveIdempotency(
    scope: string,
    key: string,
    result: CommitResult,
    binding: IdempotencyBinding
  ): void {
    this.#connection
      .prepare(
        `INSERT INTO idempotency_records (
           scope, key, result_json, created_at, operation_kind,
           completion_job_id, completion_lease_digest, completion_request_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        scope,
        key,
        encodeCommitResult(result),
        this.#dependencies.now(),
        binding.kind,
        binding.kind === "job_completion" ? binding.jobId : null,
        binding.kind === "job_completion" ? binding.leaseDigest : null,
        binding.kind === "job_completion" ? binding.requestDigest : null
      );
  }

  #digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
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
