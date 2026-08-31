import { describe, expect, it } from "vitest";

import { createMemoryIdempotencyStore } from "../src/idempotency.js";

describe("createMemoryIdempotencyStore", () => {
  it("resolves undefined for a key that was never set", async () => {
    const store = createMemoryIdempotencyStore();

    await expect(store.get("never-set")).resolves.toBeUndefined();
  });

  it("returns a previously set value for its key", async () => {
    const store = createMemoryIdempotencyStore();

    await store.set("key-1", { number: 7 });

    await expect(store.get("key-1")).resolves.toEqual({ number: 7 });
  });

  // Guard: rejects an implementation that lets a second `set` overwrite the recorded value (i.e.
  // "last write wins" instead of "first write wins"). D4's replay contract depends on the FIRST
  // recorded result staying stable forever, so a same-key `set` with a different value must be a
  // no-op. Setting the same key twice with two different values and asserting the first survives
  // is the only way to catch a last-write-wins implementation -- a single `set` per key would pass
  // under either semantics.
  it("keeps the first recorded value when the same key is set again with a different value", async () => {
    const store = createMemoryIdempotencyStore();

    await store.set("key-1", "first-value");
    await store.set("key-1", "second-value");

    await expect(store.get("key-1")).resolves.toBe("first-value");
  });

  it("keeps values under different operation-namespaced keys distinct, so a PR key and a comment key never collide", async () => {
    const store = createMemoryIdempotencyStore();

    await store.set("pull-request:run-1", { kind: "pull-request" });
    await store.set("comment:run-1", { kind: "comment" });

    await expect(store.get("pull-request:run-1")).resolves.toEqual({ kind: "pull-request" });
    await expect(store.get("comment:run-1")).resolves.toEqual({ kind: "comment" });
  });
});
