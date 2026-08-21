import {
  JobIdSchema,
  RunIdSchema,
  RunStageSchema,
  StoredDomainEventSchema,
  WorkspaceIdSchema,
  type StoredDomainEvent
} from "@autostack/contracts";
import type { CommitResult, LeasedWorkflowJob } from "@autostack/domain";

export class CorruptStoreRecordError extends Error {
  readonly table: string;
  readonly recordId: string;

  constructor(table: string, recordId: string) {
    super(`Stored ${table} record ${recordId} is invalid.`);
    this.name = "CorruptStoreRecordError";
    this.table = table;
    this.recordId = recordId;
  }
}

type Row = Readonly<Record<string, unknown>>;

const stringField = (row: Row, field: string): string => {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} is not text.`);
  return value;
};

const integerField = (row: Row, field: string): number => {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} is not a safe integer.`);
  }
  return value;
};

const nullableStringField = (row: Row, field: string): string | undefined => {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} is not nullable text.`);
  return value;
};

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const jsonRecord = (text: string): Readonly<Record<string, unknown>> => {
  const value = parseJson(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("JSON payload is not an object.");
  }
  return value as Readonly<Record<string, unknown>>;
};

export const decodeEventRow = (row: Row): StoredDomainEvent => {
  const recordId = typeof row.event_id === "string" ? row.event_id : "unknown";
  try {
    return StoredDomainEventSchema.parse({
      eventId: stringField(row, "event_id"),
      workspaceId: stringField(row, "workspace_id"),
      stream: {
        kind: stringField(row, "stream_kind"),
        id: stringField(row, "stream_id")
      },
      streamVersion: integerField(row, "stream_version"),
      globalSequence: integerField(row, "global_sequence"),
      schemaVersion: integerField(row, "schema_version"),
      occurredAt: stringField(row, "occurred_at"),
      actor: parseJson(stringField(row, "actor_json")),
      correlationId: stringField(row, "correlation_id"),
      ...(nullableStringField(row, "causation_id") === undefined
        ? {}
        : { causationId: nullableStringField(row, "causation_id") }),
      type: stringField(row, "event_type"),
      payload: parseJson(stringField(row, "payload_json"))
    });
  } catch {
    throw new CorruptStoreRecordError("events", recordId);
  }
};

export const decodeJobRow = (row: Row): LeasedWorkflowJob => {
  const recordId = typeof row.job_id === "string" ? row.job_id : "unknown";
  try {
    return {
      jobId: JobIdSchema.parse(stringField(row, "job_id")),
      workspaceId: WorkspaceIdSchema.parse(stringField(row, "workspace_id")),
      runId: RunIdSchema.parse(stringField(row, "run_id")),
      stage: RunStageSchema.parse(stringField(row, "stage")),
      handler: stringField(row, "handler"),
      payload: jsonRecord(stringField(row, "payload_json")),
      attempt: integerField(row, "attempt"),
      maxAttempts: integerField(row, "max_attempts"),
      availableAt: stringField(row, "available_at"),
      createdAt: stringField(row, "created_at"),
      leaseOwner: stringField(row, "lease_owner"),
      leaseToken: stringField(row, "lease_token"),
      leaseExpiresAt: stringField(row, "lease_expires_at")
    };
  } catch {
    throw new CorruptStoreRecordError("workflow_jobs", recordId);
  }
};

export const decodeCommitResult = (text: string): CommitResult => {
  try {
    const value = parseJson(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    const record = value as Readonly<Record<string, unknown>>;
    if (!Array.isArray(record.events) || !Array.isArray(record.jobIds)) throw new TypeError();
    return {
      events: record.events.map((event) => StoredDomainEventSchema.parse(event)),
      jobIds: record.jobIds.map((jobId) => JobIdSchema.parse(jobId)),
      replayed: true
    };
  } catch {
    throw new CorruptStoreRecordError("idempotency_records", "result");
  }
};

export const encodeCommitResult = (result: CommitResult): string => JSON.stringify(result);
