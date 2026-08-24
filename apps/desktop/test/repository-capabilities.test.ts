import { describe, expect, it } from "vitest";

import { RepositoryCapabilityRegistry } from "../src/main/repository-capabilities.js";

describe("RepositoryCapabilityRegistry", () => {
  it("returns only an opaque expiring id and basename while retaining the canonical path", async () => {
    const registry = new RepositoryCapabilityRegistry({ now: () => 1_000, ttlMs: 10_000 });
    const capability = await registry.register("/private/work/source", async (path) => path);

    expect(capability).toEqual({
      id: expect.stringMatching(/^repocap_[0-9a-f-]{36}$/),
      label: "source",
      expiresAt: "1970-01-01T00:00:11.000Z"
    });
    expect(JSON.stringify(capability)).not.toContain("/private/work");
    expect(registry.resolve(capability.id)).toBe("/private/work/source");
  });

  it("expires capabilities and clears every path on shutdown", async () => {
    let now = 1_000;
    const registry = new RepositoryCapabilityRegistry({ now: () => now, ttlMs: 50 });
    const first = await registry.register("/work/one", async (path) => path);
    now = 1_051;
    expect(() => registry.resolve(first.id)).toThrow("expired");
    const second = await registry.register("/work/two", async (path) => path);
    registry.clear();
    expect(() => registry.resolve(second.id)).toThrow("unknown");
  });
});
