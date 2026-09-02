/**
 * SQLite-backed IngressQueue (Task 4a, Wave 2 / I1).
 *
 * Implements the `IngressQueue` port defined in `@autostack/integration-slack` with durable
 * SQLite storage. FIFO order is maintained by `rowid`. At-least-once delivery: a failed handler
 * leaves the item as `pending` for the next drain. A second concurrent `drain` is a no-op.
 */

import type { DatabaseSync } from "node:sqlite";

export interface QueuedEnvelope {
  readonly envelopeId: string;
  readonly payload: unknown;
  readonly enqueuedAt: string;
}

export interface IngressQueue {
  enqueue(item: QueuedEnvelope): Promise<void>;
  drain(handler: (item: QueuedEnvelope) => Promise<void>): Promise<void>;
}

export interface SqliteIngressQueueOptions {
  readonly capacity?: number;
}

export class IngressQueueAtCapacityError extends Error {
  readonly code = "provider_unavailable" as const;
  readonly retryable = true;

  constructor() {
    super("Ingress queue is at capacity and cannot accept new work.");
    this.name = "IngressQueueAtCapacityError";
  }
}

export function createSqliteIngressQueue(
  connection: DatabaseSync,
  options: SqliteIngressQueueOptions = {}
): IngressQueue {
  let draining = false;

  const insertStatement = connection.prepare(
    "INSERT INTO ingress_queue (envelope_id, payload_json, enqueued_at) VALUES (?, ?, ?)"
  );
  const countPendingStatement = connection.prepare(
    "SELECT COUNT(*) AS cnt FROM ingress_queue WHERE status = 'pending'"
  );
  const selectPendingStatement = connection.prepare(
    "SELECT rowid, envelope_id, payload_json, enqueued_at FROM ingress_queue WHERE status = 'pending' ORDER BY rowid ASC LIMIT 1"
  );
  const deleteStatement = connection.prepare(
    "DELETE FROM ingress_queue WHERE rowid = ?"
  );

  return {
    enqueue: async (item: QueuedEnvelope): Promise<void> => {
      if (options.capacity !== undefined) {
        const row = countPendingStatement.get() as { cnt: number };
        if (row.cnt >= options.capacity) {
          throw new IngressQueueAtCapacityError();
        }
      }
      insertStatement.run(
        item.envelopeId,
        JSON.stringify(item.payload),
        item.enqueuedAt
      );
    },

    drain: async (handler: (item: QueuedEnvelope) => Promise<void>): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (true) {
          const row = selectPendingStatement.get() as
            | { rowid: number; envelope_id: string; payload_json: string; enqueued_at: string }
            | undefined;
          if (row === undefined) break;
          const item: QueuedEnvelope = {
            envelopeId: row.envelope_id,
            payload: JSON.parse(row.payload_json) as unknown,
            enqueuedAt: row.enqueued_at
          };
          await handler(item);
          deleteStatement.run(row.rowid);
        }
      } finally {
        draining = false;
      }
    }
  };
}
