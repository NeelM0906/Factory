import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../src/api-client.js";

describe("web client entry", () => {
  it("keeps the reusable browser transport available through the web package", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        service: "autostack-control-plane",
        version: "0.1.0",
        status: "ok",
        storage: { status: "ok", journalMode: "wal", schemaVersion: 1 },
        executor: { status: "idle" }
      })
    );
    const client = createApiClient({ baseUrl: "", getToken: () => null, fetch });

    await expect(client.health()).resolves.toMatchObject({ status: "ok" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
