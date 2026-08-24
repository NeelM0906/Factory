import { createHash } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodePtySpawnAuthority } from "../src/guardian/native-pty.js";

const roots: string[] = [];
const identity = async (path: string): Promise<string> => {
  const canonical = await realpath(path);
  const metadata = await stat(path);
  return createHash("sha256")
    .update(`${canonical}\0${metadata.dev.toString()}\0${metadata.ino.toString()}`)
    .digest("hex");
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Electron ABI node-pty adapter", () => {
  it("installs byte capture, preserves explicit argv/env, and returns exact terminal proof", async () => {
    const root = join(process.cwd(), `.pty-adapter-test-${crypto.randomUUID()}`);
    roots.push(root);
    const home = join(root, "home");
    const temporary = join(root, "tmp");
    const cwd = join(root, "cwd");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { recursive: true, mode: 0o700 }),
      mkdir(cwd, { recursive: true, mode: 0o700 })
    ]);
    const executable = join(root, "tool");
    await writeFile(executable, "tool", { mode: 0o700 });
    let onData: ((value: string) => void) | undefined;
    let onExit: ((value: { exitCode: number; signal?: number }) => void) | undefined;
    const spawn = vi.fn(() => ({
      pid: 8123,
      write: vi.fn(),
      resize: vi.fn(),
      onData: (listener: (value: string) => void) => {
        onData = listener;
        return { dispose: vi.fn() };
      },
      onExit: (listener: (value: { exitCode: number; signal?: number }) => void) => {
        onExit = listener;
        return { dispose: vi.fn() };
      }
    }));
    const chunks: Uint8Array[] = [];
    const exits: unknown[] = [];
    const authority = createNodePtySpawnAuthority({ spawn } as never, { signalGroup: vi.fn() });
    const result = authority.spawnBound({
      request: {
        executable,
        args: ["--literal", "$(never-a-shell)"],
        cwd,
        environment: [
          { name: "HOME", value: home },
          { name: "TMPDIR", value: temporary },
          { name: "LANG", value: "C.UTF-8" }
        ],
        terminal: { columns: 80, rows: 24 }
      },
      expectedExecutableIdentityDigest: await identity(executable),
      expectedCwdIdentityDigest: await identity(cwd),
      privateEnvironment: { home, temporary },
      capture: {
        onData: (chunk) => chunks.push(chunk),
        onEof: vi.fn(),
        onExit: (exit) => exits.push(exit)
      }
    });
    expect(result.status).toBe("spawned");
    expect(spawn).toHaveBeenCalledWith(executable, ["--literal", "$(never-a-shell)"], {
      cwd,
      env: { HOME: home, TMPDIR: temporary, LANG: "C.UTF-8" },
      cols: 80,
      rows: 24,
      encoding: null
    });
    onData?.("\u00ff\u0000A");
    expect(Buffer.from(chunks[0] ?? [])).toEqual(Buffer.from([255, 0, 65]));
    onExit?.({ exitCode: 0 });
    await expect(
      result.status === "spawned" && result.processTree.waitForExit(new AbortController().signal)
    ).resolves.toMatchObject({
      processTreeTerminated: true,
      exit: { exitCode: 0, signal: null }
    });
  });

  it("fails closed when a quick process disappears before node-pty reports exit", async () => {
    const root = join(process.cwd(), `.pty-adapter-test-${crypto.randomUUID()}`);
    roots.push(root);
    const home = join(root, "home");
    const temporary = join(root, "tmp");
    const cwd = join(root, "cwd");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { recursive: true, mode: 0o700 }),
      mkdir(cwd, { recursive: true, mode: 0o700 })
    ]);
    const executable = join(root, "tool");
    await writeFile(executable, "tool", { mode: 0o700 });
    const exits: unknown[] = [];
    const authority = createNodePtySpawnAuthority(
      {
        spawn: () => ({
          pid: 8124,
          write: vi.fn(),
          resize: vi.fn(),
          onData: () => ({ dispose: vi.fn() }),
          onExit: () => ({ dispose: vi.fn() })
        })
      } as never,
      { signalGroup: vi.fn(), processGroupExists: () => false }
    );
    const result = authority.spawnBound({
      request: {
        executable,
        args: [],
        cwd,
        environment: [
          { name: "HOME", value: home },
          { name: "TMPDIR", value: temporary }
        ],
        terminal: { columns: 80, rows: 24 }
      },
      expectedExecutableIdentityDigest: await identity(executable),
      expectedCwdIdentityDigest: await identity(cwd),
      privateEnvironment: { home, temporary },
      capture: { onData: vi.fn(), onEof: vi.fn(), onExit: (exit) => exits.push(exit) }
    });

    expect(result.status).toBe("spawned");
    await expect(
      result.status === "spawned" && result.processTree.waitForExit(new AbortController().signal)
    ).resolves.toMatchObject({
      processTreeTerminated: true,
      exit: { exitCode: null, signal: "PROCESS_EXIT_UNOBSERVED" }
    });
    expect(exits).toEqual([{ exitCode: null, signal: "PROCESS_EXIT_UNOBSERVED" }]);
  });

  it("keeps monitoring until a delayed process-group disappearance is proven", async () => {
    const root = join(process.cwd(), `.pty-adapter-test-${crypto.randomUUID()}`);
    roots.push(root);
    const home = join(root, "home");
    const temporary = join(root, "tmp");
    const cwd = join(root, "cwd");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(temporary, { recursive: true, mode: 0o700 }),
      mkdir(cwd, { recursive: true, mode: 0o700 })
    ]);
    const executable = join(root, "tool");
    await writeFile(executable, "tool", { mode: 0o700 });
    let livenessChecks = 0;
    const authority = createNodePtySpawnAuthority(
      {
        spawn: () => ({
          pid: 8125,
          write: vi.fn(),
          resize: vi.fn(),
          onData: () => ({ dispose: vi.fn() }),
          onExit: () => ({ dispose: vi.fn() })
        })
      } as never,
      {
        signalGroup: vi.fn(),
        processGroupExists: () => ++livenessChecks <= 10
      }
    );
    const result = authority.spawnBound({
      request: {
        executable,
        args: [],
        cwd,
        environment: [
          { name: "HOME", value: home },
          { name: "TMPDIR", value: temporary }
        ],
        terminal: { columns: 80, rows: 24 }
      },
      expectedExecutableIdentityDigest: await identity(executable),
      expectedCwdIdentityDigest: await identity(cwd),
      privateEnvironment: { home, temporary },
      capture: { onData: vi.fn(), onEof: vi.fn(), onExit: vi.fn() }
    });

    await expect(
      result.status === "spawned" && result.processTree.waitForExit(new AbortController().signal)
    ).resolves.toMatchObject({
      processTreeTerminated: true,
      exit: { exitCode: null, signal: "PROCESS_EXIT_UNOBSERVED" }
    });
    expect(livenessChecks).toBe(11);
  });
});
