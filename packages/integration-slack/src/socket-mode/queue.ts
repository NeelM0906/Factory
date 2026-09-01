import { SlackRequestError } from "../errors.js";

/**
 * `IngressQueue` is a **port** (decision D9). This module owns the port plus an in-memory
 * implementation used by tests and, until Wave 2 / I1 lands, as the only available runtime
 * implementation. The durable, SQLite-backed implementation lives on `@autostack/db` and is a
 * named Wave 2 / I1 composition deliverable -- spec §13.2's "processed from the durable ingress
 * queue" is fully satisfied only once I1 lands it. Nobody should mistake the in-memory queue
 * below for that durable story.
 *
 * Every test in `test/socket-mode/queue.test.ts` exercises only `enqueue`/`drain` -- the port's
 * two methods -- never `createMemoryIngressQueue`'s internal array, and never a synchronous-
 * completion assumption. That is the point: the identical suite proves the same semantics again
 * once I1's implementation replaces the one below.
 */
export interface QueuedEnvelope {
  readonly envelopeId: string;
  readonly payload: unknown;
  readonly enqueuedAt: string;
}

export interface IngressQueue {
  enqueue(item: QueuedEnvelope): Promise<void>;
  drain(handler: (item: QueuedEnvelope) => Promise<void>): Promise<void>;
}

export interface CreateMemoryIngressQueueOptions {
  readonly capacity?: number;
}

const QUEUE_AT_CAPACITY_MESSAGE = "Ingress queue is at capacity and cannot accept new work.";

/**
 * In-memory `IngressQueue`. FIFO and at-least-once: a handler failure leaves the failed item --
 * and everything still behind it -- queued, and `drain` stops rather than skipping ahead so order
 * is preserved for the retry. A second `drain` call while one is already in flight is a no-op, so
 * the same item is never handed to two handlers concurrently.
 */
export const createMemoryIngressQueue = (
  options: CreateMemoryIngressQueueOptions = {}
): IngressQueue => {
  const items: QueuedEnvelope[] = [];
  let draining = false;

  return {
    enqueue: async (item: QueuedEnvelope): Promise<void> => {
      if (options.capacity !== undefined && items.length >= options.capacity) {
        throw new SlackRequestError(QUEUE_AT_CAPACITY_MESSAGE, "provider_unavailable", true);
      }
      items.push(item);
    },
    drain: async (handler: (item: QueuedEnvelope) => Promise<void>): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (items.length > 0) {
          const head = items[0];
          if (head === undefined) break;
          await handler(head);
          items.shift();
        }
      } finally {
        draining = false;
      }
    }
  };
};
