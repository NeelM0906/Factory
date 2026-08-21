import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ServerType, serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startControlPlane } from "../src/server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("control-plane server composition", () => {
  it("opens durable storage, serves the composed app, and closes exactly once", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const server = { close } as unknown as ServerType;
    const serveImplementation = vi.fn(() => server) as unknown as typeof serve;

    const runtime = startControlPlane({
      config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
      serve: serveImplementation,
      installSignalHandlers: false,
      log: vi.fn()
    });

    expect(existsSync(join(dataDirectory, "autostack.sqlite"))).toBe(true);
    expect(serveImplementation).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "127.0.0.1", port: 4318 })
    );

    const health = await runtime.app.request("/v1/health");
    expect(health.status).toBe(200);
    expect(runtime.executor.getStatus()).toBe("idle");

    await runtime.close();
    await runtime.close();

    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.executor.getStatus()).toBe("stopped");
  });

  it("loads environment configuration without logging credentials", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const server = {
      close: (callback?: (error?: Error) => void) => callback?.()
    } as unknown as ServerType;
    const serveImplementation = vi.fn(() => server) as unknown as typeof serve;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const runtime = startControlPlane({
      environment: {
        AUTOSTACK_DATA_DIR: dataDirectory,
        AUTOSTACK_LOCAL_API_TOKEN: TOKEN,
        AUTOSTACK_PORT: "4320"
      },
      serve: serveImplementation,
      installSignalHandlers: false
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("control_plane_started"));
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    await runtime.close();
  });

  it("closes storage and the executor when server startup fails", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const serveImplementation = vi.fn(() => {
      throw new Error("listen failed");
    }) as unknown as typeof serve;

    expect(() =>
      startControlPlane({
        config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
        serve: serveImplementation,
        installSignalHandlers: false,
        log: vi.fn()
      })
    ).toThrow("listen failed");
  });

  it("still stops the executor and storage when listener shutdown fails", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const server = {
      close: (callback?: (error?: Error) => void) => callback?.(new Error("close failed"))
    } as unknown as ServerType;
    const runtime = startControlPlane({
      config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
      serve: vi.fn(() => server) as unknown as typeof serve,
      installSignalHandlers: false,
      log: vi.fn()
    });

    await expect(runtime.close()).rejects.toThrow("close failed");
    expect(runtime.executor.getStatus()).toBe("stopped");
  });
});
