import { describe, expect, it } from "vitest";

import {
  CorruptStoreRecordError,
  decodeCommitResult,
  decodeEventRow,
  decodeJobRow
} from "../src/codecs.js";

const NOW = "2026-08-20T12:00:00.000Z";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174000";
const WORK_ITEM_ID = "wi_123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "run_123e4567-e89b-42d3-a456-426614174000";

const eventRow = {
  event_id: "evt_123e4567-e89b-42d3-a456-426614174010",
  workspace_id: WORKSPACE_ID,
  stream_kind: "run",
  stream_id: RUN_ID,
  stream_version: 1,
  global_sequence: 1,
  schema_version: 1,
  occurred_at: NOW,
  actor_json: JSON.stringify({ kind: "system", id: "autostack" }),
  correlation_id: "123e4567-e89b-42d3-a456-426614174001",
  causation_id: null,
  event_type: "run.created",
  payload_json: JSON.stringify({
    run: {
      schemaVersion: 1,
      id: RUN_ID,
      workspaceId: WORKSPACE_ID,
      workItemId: WORK_ITEM_ID,
      workflowVersion: "foundation.v1",
      status: "queued",
      createdAt: NOW,
      updatedAt: NOW
    }
  })
} as const;

const jobRow = {
  job_id: "job_123e4567-e89b-42d3-a456-426614174000",
  workspace_id: WORKSPACE_ID,
  run_id: RUN_ID,
  stage: "triage",
  handler: "test.triage",
  payload_json: JSON.stringify({ task: "triage" }),
  attempt: 1,
  max_attempts: 2,
  available_at: NOW,
  created_at: NOW,
  lease_owner: "worker-1",
  lease_token: "lease-1",
  lease_expires_at: "2026-08-20T12:01:00.000Z"
} as const;

describe("SQLite row codecs", () => {
  it("decodes nullable and populated event causation IDs", () => {
    expect(decodeEventRow(eventRow).causationId).toBeUndefined();
    expect(
      decodeEventRow({
        ...eventRow,
        causation_id: "evt_123e4567-e89b-42d3-a456-426614174011"
      }).causationId
    ).toBe("evt_123e4567-e89b-42d3-a456-426614174011");
  });

  it("reports the stable event ID without exposing corrupt payload data", () => {
    expect(() => decodeEventRow({ ...eventRow, actor_json: "not-json" })).toThrow(
      new CorruptStoreRecordError("events", eventRow.event_id)
    );
    expect(() => decodeEventRow({ ...eventRow, event_id: 42 })).toThrow(
      new CorruptStoreRecordError("events", "unknown")
    );
  });

  it("decodes a leased job and rejects a non-object job payload", () => {
    expect(decodeJobRow(jobRow)).toMatchObject({
      jobId: jobRow.job_id,
      payload: { task: "triage" },
      attempt: 1
    });
    expect(() => decodeJobRow({ ...jobRow, payload_json: "[]" })).toThrow(CorruptStoreRecordError);
  });

  it("rejects malformed idempotency results", () => {
    expect(() => decodeCommitResult("not-json")).toThrow(CorruptStoreRecordError);
    expect(() => decodeCommitResult("{}")).toThrow(CorruptStoreRecordError);
  });
});
