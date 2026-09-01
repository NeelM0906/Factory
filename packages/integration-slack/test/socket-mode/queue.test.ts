import { describe, expect, it, vi } from "vitest";

import { SlackRequestError } from "../../src/errors.js";
import { createMemoryIngressQueue, type QueuedEnvelope } from "../../src/socket-mode/queue.js";

// This suite exercises only `IngressQueue.enqueue`/`IngressQueue.drain` -- the port's two
// methods -- and never reaches into `createMemoryIngressQueue`'s internals, asserts on a private
// array, or assumes synchronous completion. That is deliberate (decision D9): the SQLite-backed
// implementation lands in Wave 2 / I1, and this file is the store-agnostic proof that is meant to
// pass unmodified once `createMemoryIngressQueue` is swapped for that implementation.

const makeItem = (envelopeId: string, payload: unknown = { envelopeId }): QueuedEnvelope => ({
  envelopeId,
  payload,
  enqueuedAt: "2026-08-27T00:00:00.000Z"
});

describe("createMemoryIngressQueue", () => {
  it("preserves FIFO order across enqueue and drain", async () => {
    const queue = createMemoryIngressQueue();
    await queue.enqueue(makeItem("a"));
    await queue.enqueue(makeItem("b"));
    await queue.enqueue(makeItem("c"));

    const order: string[] = [];
    await queue.drain(async (item) => {
      order.push(item.envelopeId);
    });

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("resolves without invoking the handler when the queue is empty", async () => {
    const queue = createMemoryIngressQueue();
    const handler = vi.fn(async () => {});

    await queue.drain(handler);

    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves a failed item at the head for the next drain, never dropping it (at-least-once)", async () => {
    const queue = createMemoryIngressQueue();
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

    // "a" is redelivered (never dropped) and FIFO order is preserved across the retry.
    expect(processed).toEqual(["a", "b"]);
  });

  it("rejects new work with a provider_unavailable SlackRequestError once at capacity, instead of growing without limit", async () => {
    const queue = createMemoryIngressQueue({ capacity: 2 });
    await queue.enqueue(makeItem("a"));
    await queue.enqueue(makeItem("b"));

    await expect(queue.enqueue(makeItem("c"))).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true
    });
    await expect(queue.enqueue(makeItem("c"))).rejects.toBeInstanceOf(SlackRequestError);
  });

  it("treats a second concurrent drain as a no-op rather than double-processing", async () => {
    const queue = createMemoryIngressQueue();
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

    // The second drain must resolve immediately as a no-op -- it must not wait on the first.
    await secondDrain;
    expect(calls).toEqual(["first:a"]);

    releaseFirstHandler?.();
    await firstDrain;

    expect(calls).toEqual(["first:a"]);
  });

  it("removes a successfully processed item exactly once; it does not reappear on a later drain", async () => {
    const queue = createMemoryIngressQueue();
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
  });
});
