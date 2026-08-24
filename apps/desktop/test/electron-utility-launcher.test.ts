import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("electron", () => ({ utilityProcess: { fork: mocks.fork } }));

import { createElectronUtilityLauncher } from "../src/main/electron-utility-launcher.js";

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 41;
  readonly messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  kill(): boolean {
    this.emit("exit", 0);
    return true;
  }
}

describe("Electron utility launcher", () => {
  beforeEach(() => mocks.fork.mockReset());

  it("keeps control-plane quiesce pending until the correlated lifecycle acknowledgement", async () => {
    const utility = new FakeUtilityProcess();
    mocks.fork.mockReturnValue(utility);
    const launch = createElectronUtilityLauncher({
      resolveRepository: () => "/repository",
      authorizeTerminalEvidence: async () => undefined
    });
    const child = await launch("control-plane", {});

    let settled = false;
    const quiescing = child.sendLifecycle("quiesce").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(utility.messages).toEqual([{ schemaVersion: 1, type: "quiesce" }]);

    utility.emit("message", { schemaVersion: 1, type: "lifecycle.ack", phase: "quiesce" });
    await quiescing;
    expect(settled).toBe(true);
  });
});
