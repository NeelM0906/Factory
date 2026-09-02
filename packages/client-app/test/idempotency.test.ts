import { describe, expect, it } from "vitest";

import { createIdempotencyKeyFactory } from "../src/idempotency.js";

/** A deterministic, injectable UUID source for tests — never `crypto.randomUUID()` directly. */
function sequentialUuids(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
  };
}

describe("createIdempotencyKeyFactory (steer/cancel key factory only — D2)", () => {
  it("gives steer and cancel a fresh key each time", () => {
    const factory = createIdempotencyKeyFactory({ randomUUID: sequentialUuids() });
    expect(factory()).not.toBe(factory());
  });

  it("returns exactly what the injected randomUUID source produces", () => {
    const factory = createIdempotencyKeyFactory({ randomUUID: () => "fixed-injected-key" });
    expect(factory()).toBe("fixed-injected-key");
    expect(factory()).toBe("fixed-injected-key");
  });

  it("defaults to a real UUID v4 when no source is injected", () => {
    const factory = createIdempotencyKeyFactory();
    expect(factory()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
