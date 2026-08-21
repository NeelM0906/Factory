import type { DatabaseSync } from "node:sqlite";

import { type StoredDomainEvent } from "@autostack/contracts";
import { projectRunSummaries } from "@autostack/domain";

import { decodeEventRow } from "./codecs.js";

type Row = Readonly<Record<string, unknown>>;

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new TypeError(`${field} is not text.`);
  return value;
};

const insertSummary = (
  connection: DatabaseSync,
  workspaceId: string,
  summary: ReturnType<typeof projectRunSummaries>[number]
): void => {
  connection
    .prepare(
      `INSERT INTO run_summaries (
         run_id, workspace_id, work_item_id, title, source, status, current_stage,
         last_global_sequence, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      summary.runId,
      workspaceId,
      summary.workItemId,
      summary.title,
      summary.source,
      summary.status,
      summary.currentStage ?? null,
      summary.lastGlobalSequence,
      summary.createdAt,
      summary.updatedAt
    );
};

export const updateRunSummary = (connection: DatabaseSync, event: StoredDomainEvent): void => {
  if (event.type !== "run.created" && event.type !== "run.transitioned") return;
  const runId = event.type === "run.created" ? event.payload.run.id : event.payload.runId;
  const workItemId =
    event.type === "run.created"
      ? event.payload.run.workItemId
      : (() => {
          const row = connection
            .prepare("SELECT work_item_id FROM run_summaries WHERE run_id = ? AND workspace_id = ?")
            .get(runId, event.workspaceId) as Row | undefined;
          if (row === undefined) {
            throw new TypeError("A run transition requires an existing summary.");
          }
          return text(row.work_item_id, "work_item_id");
        })();
  const rows = connection
    .prepare(
      `SELECT * FROM events
       WHERE workspace_id = ? AND (
         (stream_kind = 'work_item' AND stream_id = ?) OR
         (stream_kind = 'run' AND stream_id = ?)
       ) ORDER BY global_sequence ASC`
    )
    .all(event.workspaceId, workItemId, runId) as Row[];
  const summary = projectRunSummaries(rows.map(decodeEventRow)).find(
    (candidate) => candidate.runId === runId
  );
  if (summary === undefined) throw new TypeError("A run summary requires its creation events.");

  if (event.type === "run.created") {
    insertSummary(connection, event.workspaceId, summary);
    return;
  }
  const update = connection
    .prepare(
      `UPDATE run_summaries SET status = ?, current_stage = ?, last_global_sequence = ?,
         updated_at = ? WHERE run_id = ? AND workspace_id = ?`
    )
    .run(
      summary.status,
      summary.currentStage ?? null,
      summary.lastGlobalSequence,
      summary.updatedAt,
      summary.runId,
      event.workspaceId
    );
  if (update.changes !== 1) throw new TypeError("A run transition requires an existing summary.");
};

export const backfillRunSummaries = (connection: DatabaseSync): void => {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const count = connection.prepare("SELECT COUNT(*) AS count FROM run_summaries").get() as {
      count: number;
    };
    if (count.count > 0) {
      connection.exec("COMMIT");
      return;
    }
    const eventsTable = connection
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'events'")
      .get();
    if (eventsTable === undefined) {
      connection.exec("COMMIT");
      return;
    }
    const rows = connection
      .prepare("SELECT * FROM events ORDER BY global_sequence ASC")
      .all() as Row[];
    if (rows.length === 0) {
      connection.exec("COMMIT");
      return;
    }
    const events = rows.map(decodeEventRow);
    const workspaceIds = new Set(events.map(({ workspaceId }) => workspaceId));
    for (const workspaceId of workspaceIds) {
      for (const summary of projectRunSummaries(
        events.filter((event) => event.workspaceId === workspaceId)
      )) {
        insertSummary(connection, workspaceId, summary);
      }
    }
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
};
