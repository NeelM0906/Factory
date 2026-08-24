import { describe, expect, it, vi } from "vitest";

import { DesktopCommandStreamRequestSchema } from "@autostack/contracts";

import { createDesktopBridge } from "../src/preload/bridge.js";

describe("desktop preload bridge", () => {
  it("exposes only the five named capabilities and validates returned runtime state", async () => {
    const bridge = createDesktopBridge({
      invoke: vi.fn(async (channel) =>
        channel === "autostack:runtime-status" ? { status: "ready" } : { repository: null }
      ),
      on: vi.fn(),
      off: vi.fn()
    });
    expect(Object.keys(bridge).sort()).toEqual([
      "pickRepository",
      "request",
      "runtimeStatus",
      "subscribeCommand",
      "subscribeRuntimeStatus"
    ]);
    await expect(bridge.runtimeStatus()).resolves.toEqual({ status: "ready" });
    expect(JSON.stringify(bridge)).not.toContain("ipcRenderer");
  });

  it("registers listeners before command cursor delivery and detaches without cancellation", () => {
    const order: string[] = [];
    const on = vi.fn(() => order.push("listener"));
    const invoke = vi.fn(async () => {
      order.push("invoke");
      return undefined;
    });
    const off = vi.fn();
    const bridge = createDesktopBridge({ invoke, on, off });
    const listener = vi.fn();
    const request = DesktopCommandStreamRequestSchema.parse({
      operation: "local.events",
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
      commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
      after: 0
    });
    const unsubscribe = bridge.subscribeCommand(request, listener);
    expect(order).toEqual(["listener", "invoke"]);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("autostack:cancel", expect.anything());
  });
});
