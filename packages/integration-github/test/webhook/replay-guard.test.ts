import { describe, expect, it } from "vitest";

import { createDeliveryReplayGuard } from "../../src/webhook/replay-guard.js";

describe("createDeliveryReplayGuard", () => {
  it("reports false on first sight and true on every subsequent sight", () => {
    const guard = createDeliveryReplayGuard();

    expect(guard.seen("delivery-1")).toBe(false);
    expect(guard.seen("delivery-1")).toBe(true);
    expect(guard.seen("delivery-1")).toBe(true);
  });

  it("tracks distinct ids independently", () => {
    const guard = createDeliveryReplayGuard();

    expect(guard.seen("delivery-a")).toBe(false);
    expect(guard.seen("delivery-b")).toBe(false);
    expect(guard.seen("delivery-a")).toBe(true);
    expect(guard.seen("delivery-b")).toBe(true);
  });

  // Boundary companion for the capacity bound below: inserting exactly `capacity` ids must
  // evict nothing, so the very first one inserted is still remembered.
  it("evicts nothing at exactly capacity (boundary companion for capacity + 1 below)", () => {
    const guard = createDeliveryReplayGuard({ capacity: 3 });
    const ids = ["id-0", "id-1", "id-2"];

    for (const id of ids) guard.seen(id);

    expect(guard.seen("id-0")).toBe(true);
  });

  // Rejects two distinct wrong implementations at once:
  //   1. An unbounded structure (never evicts) -- would make "id-0" still seen == true.
  //   2. A structure that evicts most-recent-first instead of oldest-first -- would make
  //      "id-0" still seen == true (never evicted) AND "id-3" seen == false (evicted right
  //      after insertion instead of the true oldest entry).
  // Only a bounded, FIFO (oldest-first) eviction policy passes both assertions together.
  it("evicts the oldest id once capacity is exceeded, while a recent id is still remembered", () => {
    const guard = createDeliveryReplayGuard({ capacity: 3 });
    const ids = ["id-0", "id-1", "id-2", "id-3"]; // capacity + 1

    for (const id of ids) guard.seen(id);

    // The oldest id was evicted, so it now reports as unseen (a fresh sighting) again.
    expect(guard.seen("id-0")).toBe(false);
    // The most recently inserted id is still within capacity and is remembered.
    expect(guard.seen("id-3")).toBe(true);
  });

  it("uses the default capacity when none is given", () => {
    const guard = createDeliveryReplayGuard();

    for (let index = 0; index < 4096; index += 1) guard.seen(`delivery-${index}`);

    // Still within the default capacity: nothing evicted yet.
    expect(guard.seen("delivery-0")).toBe(true);

    // One more insertion pushes past the default capacity, evicting the oldest.
    guard.seen("delivery-4096");
    expect(guard.seen("delivery-0")).toBe(false);
  });
});
