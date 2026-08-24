import { describe, expect, it } from "vitest";

import { ControlPlaneShutdown } from "../src/shutdown.js";

describe("control-plane shutdown", () => {
  it("quiesces and drains before closing persistence exactly once", async () => {
    const operations: string[] = [];
    const shutdown = new ControlPlaneShutdown({
      quiesceIngress: async () => void operations.push("ingress"),
      drainReconciliation: async () => void operations.push("reconciliation"),
      closeListener: async () => void operations.push("listener"),
      closeExecutor: async () => void operations.push("executor"),
      closePersistence: async () => void operations.push("persistence")
    });
    await Promise.all([
      shutdown.handle({ schemaVersion: 1, type: "close" }),
      shutdown.handle({ schemaVersion: 1, type: "interrupt-and-drain" })
    ]);
    expect(operations).toEqual([
      "ingress",
      "reconciliation",
      "listener",
      "executor",
      "persistence"
    ]);
  });
});
