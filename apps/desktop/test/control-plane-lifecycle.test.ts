import { describe, expect, it } from "vitest";

import { applyControlPlaneLifecycle } from "../src/utility/control-plane-lifecycle.js";

describe("control-plane utility lifecycle", () => {
  it("awaits quiesce and reconciliation drain before publishing drained and closing", async () => {
    const events: string[] = [];
    const runtime = {
      quiesce: async () => void events.push("runtime:quiesced"),
      drain: async () => void events.push("runtime:drained"),
      retireHostGeneration: async () => void events.push("runtime:retired"),
      close: async () => void events.push("runtime:closed")
    };
    const writer = {
      postMessage: (message: unknown) => events.push(`parent:${(message as { type: string }).type}`)
    };
    const state = { drained: false };

    await applyControlPlaneLifecycle(runtime, writer, state, { schemaVersion: 1, type: "quiesce" });
    await applyControlPlaneLifecycle(runtime, writer, state, {
      schemaVersion: 1,
      type: "interrupt-and-drain"
    });
    await applyControlPlaneLifecycle(runtime, writer, state, { schemaVersion: 1, type: "close" });

    expect(events).toEqual([
      "runtime:quiesced",
      "parent:lifecycle.ack",
      "runtime:drained",
      "parent:drained",
      "runtime:closed"
    ]);
  });
});
