import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("electron", () => ({ utilityProcess: { fork: mocks.fork } }));

import { createElectronUtilityLauncher } from "../src/main/electron-utility-launcher.js";

class FakeStream extends EventEmitter {
  encoding: string | undefined;

  setEncoding(encoding: string): this {
    this.encoding = encoding;
    return this;
  }
}

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 41;
  readonly messages: unknown[] = [];
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();

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

  it("forwards a utility child's streams as bounded redacted records", async () => {
    const utility = new FakeUtilityProcess();
    mocks.fork.mockReturnValue(utility);
    const written: string[] = [];
    const launch = createElectronUtilityLauncher({
      resolveRepository: () => "/repository",
      authorizeTerminalEvidence: async () => undefined,
      writeChildLog: (line) => written.push(line)
    });
    await launch("host", {});

    // The production fork must pipe, or there is nothing to read and the shipped app stays blind.
    expect(mocks.fork).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ stdio: "pipe" })
    );
    expect(utility.stdout.encoding).toBe("utf8");
    expect(utility.stderr.encoding).toBe("utf8");

    utility.stderr.emit("data", `host refused ghp_${"a".repeat(36)}\n`);
    utility.stdout.emit("data", "plain progress line\n");

    const records = written.map((line) => JSON.parse(line) as { service: string; line: string });
    expect(records.map((record) => record.service)).toEqual(["host", "host"]);
    expect(written.join("")).not.toContain("ghp_");
    expect(records[1]?.line).toBe("plain progress line");
  });

  it("flushes a child's unterminated final line when it exits", async () => {
    const utility = new FakeUtilityProcess();
    mocks.fork.mockReturnValue(utility);
    const written: string[] = [];
    const launch = createElectronUtilityLauncher({
      resolveRepository: () => "/repository",
      authorizeTerminalEvidence: async () => undefined,
      writeChildLog: (line) => written.push(line)
    });
    const child = await launch("control-plane", {});
    // The child rejects its eagerly created readiness promise on exit; observe it so the exit below
    // does not surface as an unhandled rejection. The supervisor always awaits this in production.
    const readiness = child.waitReady().catch(() => undefined);

    utility.stderr.emit("data", "died mid-sentence");
    expect(written).toEqual([]);
    utility.emit("exit", 1);
    await readiness;

    expect(JSON.parse(written[0] ?? "{}")).toMatchObject({
      service: "control-plane",
      line: "died mid-sentence"
    });
  });
});
