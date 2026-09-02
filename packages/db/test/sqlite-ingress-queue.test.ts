/**
 * SQLite-backed IngressQueue tests (Task 4a).
 *
 * These tests mirror the store-agnostic suite in integration-slack/test/socket-mode/queue.test.ts,
 * validating the same FIFO, at-least-once, capacity, and reentrancy semantics against the
 * durable SQLite implementation.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/database.js";
import {
  createSqliteIngressQueue,
  IngressQueueAtCapacityError,
  type QueuedEnvelope
} from "../src/sqlite-ingress-queue.js";

const NOW = "2026-08-27T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const makeDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-queue-"));
  temporaryDirectories.push(directory);
  return openDatabase({ filePath: join(directory, "autostack.sqlite") });
};

const makeItem = (envelopeId: string, payload: unknown = { envelopeId }): QueuedEnvelope => ({
  envelopeId,
  payload,
  enqueuedAt: NOW
});

describe("createSqliteIngressQueue", () => {
  it("preserves FIFO order across enqueue and drain", async () => {
    const db = await makeDatabase();
    const queue = createSqliteIngressQueue(db.connection);
    await queue.enqueue(makeItem("a"));
    await queue.enqueue(makeItem("b"));
    await queue.enqueue(makeItem("c"));

    const order: string[] = [];
    await queue.drain(async (item) => {
      order.push(item.envelopeId);
    });

    expect(order).toEqual(["a", "b", "c"]);
    db.close();
  });

  it("resolves without invoking the handler when the queue is empty", async () => {
    const db = await makeDatabase();
    const queue = createSqliteIngressQueue(db.connection);
    const handler = vi.fn(async () => {});

    await queue.drain(handler);

    expect(handler).not.toHaveBeenCalled();
    db.close();
  });

  it("leaves a failed item at the head for the next drain (at-least-once)", async () => {
    const db = await makeDatabase();
    const queue = createSqliteIngressQueue(db.connection);
    await queue.enqueue(makeItem("a"));
    await queue.enqueue(makeItem("b"));

    await expect(
      queue.drain(async (item) => {
        if (item.envelopeId === "a") throw new Error("handler exploded on the first item");
      })
    ).rejects.toThrow("handler exploded on the first item");

    const processed: string[] = [];
    await queue.drain(async (item) => {
      processed.push(item.envelopeId);
    });

    // "a" is redelivered (never dropped) and FIFO order is preserved.
    expect(processed).toEqual(["a", "b"]);
    db.close();
  });

  it("rejects new work with IngressQueueAtCapacityError once at capacity", async () => {
    const db = await makeDatabase();
    const queue = createSqliteIngressQueue(db.connection, { capacity: 2 });
    await queue.enqueue(makeItem("a"));
    await queue.enqueue(makeItem("b"));

    await expect(queue.enqueue(makeItem("c"))).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true
    });
    await expect(queue.enqueue(makeItem("c"))).rejects.toBeInstanceOf(
      IngressQueueAtCapacityError
    );
    db.close();
  });

  it("treats a second concurrent drain as a no-op", async () => {
    const db = await makeDatabase();
    const queue = createSqliteIngressQueue(db.connection);
    await queue.enqueue(makeItem("a"));

    let releaseFirstHandler: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstHandler = resolve;
    });
    const calls: string[] = [];

    const firstDrain = queue.drain(async (item) => {
      calls.push(`first:${item.envelopeId}`);
      await gate;
    });
    const secondDrain = queue.drain(async (item) => {
      calls.push(`second:${item.envelopeId}`);
    });

    // The second drain must resolve immediately as a no-op.
    await secondDrain;
    expect(calls).toEqual(["first:a"]);

    releaseFirstHandler?.();
    await firstDrain;

    expect(calls).toEqual(["first:a"]);
    db.close();
  });

  it("removes a processed item exactly once — no reappearance on later drain", async () => {
    const db = await makeDatabase();
    const queue = createSqliteIngressQueue(db.connection);
    await queue.enqueue(makeItem("a"));

    const firstCalls: string[] = [];
    await queue.drain(async (item) => {
      firstCalls.push(item.envelopeId);
    });

    const secondCalls: string[] = [];
    await queue.drain(async (item) => {
      secondCalls.push(item.envelopeId);
    });

    expect(firstCalls).toEqual(["a"]);
    expect(secondCalls).toEqual([]);
    db.close();
  });

  it("survives across a fresh queue instance on the same database (durability)", async () => {
    const db = await makeDatabase();
    const queue1 = createSqliteIngressQueue(db.connection);
    await queue1.enqueue(makeItem("durable-a"));
    await queue1.enqueue(makeItem("durable-b"));

    // Create a second queue instance on the same connection.
    const queue2 = createSqliteIngressQueue(db.connection);

    const processed: string[] = [];
    await queue2.drain(async (item) => {
      processed.push(item.envelopeId);
    });

    expect(processed).toEqual(["durable-a", "durable-b"]);
    db.close();
  });

  it("preserves the full payload round-trip through JSON serialization", async () => {
    const db = await makeDatabase();
    const queue = createSqliteIngressQueue(db.connection);
    const complexPayload = {
      nested: { array: [1, "two", null], flag: true },
      text: "Hello, world!"
    };
    await queue.enqueue(makeItem("payload-test", complexPayload));

    let received: unknown;
    await queue.drain(async (item) => {
      received = item.payload;
    });

    expect(received).toEqual(complexPayload);
    db.close();
  });
});
