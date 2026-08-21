import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer as createNetServer } from "node:net";

import { type ServerType, serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventIdSchema, WorkspaceIdSchema, createIdFactory } from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import { createManualRun } from "@autostack/domain";
import { LocalWorkflowExecutor } from "@autostack/workflow";

import { loadOrCreateLocalWorkspaceId } from "../src/config.js";
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
  it("creates an atomic private identity for an empty installation", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const expected = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");

    expect(
      loadOrCreateLocalWorkspaceId(
        dataDirectory,
        () => expected,
        () => "2026-08-20T12:00:00.000Z",
        []
      )
    ).toBe(expected);
    expect(statSync(join(dataDirectory, "installation.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dataDirectory)).toEqual(["installation.json"]);
  });

  it("recovers one legacy workspace, fails closed on ambiguity, and leaves no partial identity", () => {
    const recoveredDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    const ambiguousDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(recoveredDirectory, ambiguousDirectory);
    const recovered = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
    const foreign = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174002");
    const generator = vi.fn(() => foreign);

    expect(
      loadOrCreateLocalWorkspaceId(
        recoveredDirectory,
        generator,
        () => "2026-08-20T12:00:00.000Z",
        [recovered]
      )
    ).toBe(recovered);
    expect(generator).not.toHaveBeenCalled();
    expect(() =>
      loadOrCreateLocalWorkspaceId(
        ambiguousDirectory,
        generator,
        () => "2026-08-20T12:00:00.000Z",
        [recovered, foreign]
      )
    ).toThrow(/multiple|ambiguous/i);
    expect(readdirSync(ambiguousDirectory)).toEqual([]);
  });

  it("fails closed when an existing installation identity disagrees with durable ownership", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const installed = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
    const durable = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174002");
    loadOrCreateLocalWorkspaceId(
      dataDirectory,
      () => installed,
      () => "2026-08-20T12:00:00.000Z"
    );

    expect(() =>
      loadOrCreateLocalWorkspaceId(
        dataDirectory,
        () => durable,
        () => "2026-08-20T12:00:00.000Z",
        [durable]
      )
    ).toThrow(/identity|workspace|ownership|match/i);
    expect(() =>
      loadOrCreateLocalWorkspaceId(
        dataDirectory,
        () => durable,
        () => "2026-08-20T12:00:00.000Z",
        [installed, durable]
      )
    ).toThrow(/multiple|ambiguous/i);
  });

  it("rejects a symlinked installation identity without following it", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const workspaceId = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
    const target = join(dataDirectory, "identity-target.json");
    writeFileSync(
      target,
      `${JSON.stringify({ schemaVersion: 1, workspaceId, createdAt: "2026-08-20T12:00:00.000Z" })}\n`,
      { mode: 0o600 }
    );
    symlinkSync(target, join(dataDirectory, "installation.json"));

    expect(() =>
      loadOrCreateLocalWorkspaceId(
        dataDirectory,
        () => workspaceId,
        () => "2026-08-20T12:00:00.000Z"
      )
    ).toThrow(/symbolic link|regular file|identity/i);
  });

  it("rejects a non-regular installation identity", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const workspaceId = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
    mkdirSync(join(dataDirectory, "installation.json"));

    expect(() =>
      loadOrCreateLocalWorkspaceId(
        dataDirectory,
        () => workspaceId,
        () => "2026-08-20T12:00:00.000Z"
      )
    ).toThrow(/regular file|identity/i);
  });

  it("publishes identity crash-safely and accepts the winner of a racing initializer", () => {
    const crashDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    const raceDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(crashDirectory, raceDirectory);
    const generated = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
    const winner = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174002");

    expect(() =>
      loadOrCreateLocalWorkspaceId(
        crashDirectory,
        () => generated,
        () => "2026-08-20T12:00:00.000Z",
        [],
        {
          beforePublish: () => {
            throw new Error("simulated crash");
          }
        }
      )
    ).toThrow("simulated crash");
    expect(readdirSync(crashDirectory)).toEqual([]);

    expect(
      loadOrCreateLocalWorkspaceId(
        raceDirectory,
        () => generated,
        () => "2026-08-20T12:00:00.000Z",
        [],
        {
          beforePublish: () => {
            writeFileSync(
              join(raceDirectory, "installation.json"),
              `${JSON.stringify({ schemaVersion: 1, workspaceId: winner, createdAt: "2026-08-20T12:00:00.000Z" })}\n`,
              { mode: 0o600 }
            );
          }
        }
      )
    ).toBe(winner);
    expect(readdirSync(raceDirectory)).toEqual(["installation.json"]);
  });

  it("opens durable storage, serves the composed app, and closes exactly once", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const server = { close } as unknown as ServerType;
    const serveImplementation = vi.fn(() => server) as unknown as typeof serve;

    const runtime = await startControlPlane({
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

    const runtime = await startControlPlane({
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

  it("keeps workspace identity and idempotency stable across API token rotation", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const server = {
      close: (callback?: (error?: Error) => void) => callback?.()
    } as unknown as ServerType;
    const serveImplementation = vi.fn(() => server) as unknown as typeof serve;
    const firstToken = TOKEN;
    const secondToken = "fedcba9876543210fedcba9876543210";
    const first = await startControlPlane({
      config: { dataDirectory, token: firstToken, host: "127.0.0.1", port: 4318 },
      serve: serveImplementation,
      installSignalHandlers: false,
      log: vi.fn()
    });
    const createRequest = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firstToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "token-rotation"
      },
      body: JSON.stringify({ title: "Survive token rotation" })
    };
    const created = await first.app.request("/v1/runs", createRequest);
    expect(created.status).toBe(201);
    await first.close();

    const second = await startControlPlane({
      config: { dataDirectory, token: secondToken, host: "127.0.0.1", port: 4318 },
      serve: serveImplementation,
      installSignalHandlers: false,
      log: vi.fn()
    });
    const list = await second.app.request("/v1/runs", {
      headers: { Authorization: `Bearer ${secondToken}` }
    });
    expect((await list.json()) as { items: unknown[] }).toMatchObject({ items: [{}] });
    const replay = await second.app.request("/v1/runs", {
      ...createRequest,
      headers: { ...createRequest.headers, Authorization: `Bearer ${secondToken}` }
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });

    const installationPath = join(dataDirectory, "installation.json");
    expect(JSON.parse(readFileSync(installationPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      workspaceId: expect.stringMatching(/^ws_/)
    });
    expect(statSync(installationPath).mode & 0o777).toBe(0o600);
    await second.close();
  });

  it("recovers a pre-identity database workspace and exposes its existing runs", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const workspaceId = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174077");
    const decision = createManualRun(
      { title: "Legacy run" },
      {
        workspaceId,
        actor: { kind: "user", id: "legacy-user" },
        correlationId: "123e4567-e89b-42d3-a456-426614174077"
      },
      {
        now: () => "2026-08-20T12:00:00.000Z",
        ids: createIdFactory(() => "123e4567-e89b-42d3-a456-426614174077")
      }
    );
    const database = openDatabase({ filePath: join(dataDirectory, "autostack.sqlite") });
    let event = 70;
    const store = new SqliteDurableStore(database, {
      eventId: () =>
        EventIdSchema.parse(
          `evt_123e4567-e89b-42d3-a456-${String(426614174000 + event++).padStart(12, "0")}`
        ),
      leaseToken: () => "legacy-lease",
      now: () => "2026-08-20T12:00:00.000Z"
    });
    await store.commit({
      idempotency: { scope: "legacy", key: "run" },
      appends: decision.appends,
      jobs: []
    });
    await store.close();
    const server = {
      close: (callback?: (error?: Error) => void) => callback?.()
    } as unknown as ServerType;
    const runtime = await startControlPlane({
      config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
      serve: vi.fn(() => server) as unknown as typeof serve,
      installSignalHandlers: false,
      log: vi.fn()
    });

    const response = await runtime.app.request("/v1/runs", {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    expect(await response.json()).toMatchObject({ items: [{ title: "Legacy run" }] });
    expect(
      JSON.parse(readFileSync(join(dataDirectory, "installation.json"), "utf8"))
    ).toMatchObject({
      workspaceId
    });
    await runtime.close();
  });

  it("closes an opened database when identity initialization fails", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    writeFileSync(join(dataDirectory, "installation.json"), "not-json", { mode: 0o600 });
    const opened = openDatabase({ filePath: join(dataDirectory, "autostack.sqlite") });
    const close = vi.spyOn(opened, "close");

    await expect(
      startControlPlane({
        config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
        openDatabase: () => opened,
        installSignalHandlers: false,
        log: vi.fn()
      })
    ).rejects.toThrow(/identity/i);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => opened.connection.prepare("SELECT 1").get()).toThrow();
  });

  it("closes an opened database when legacy workspace recovery is ambiguous", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const opened = openDatabase({ filePath: join(dataDirectory, "autostack.sqlite") });
    opened.connection.exec(`
      INSERT INTO events (
        event_id, workspace_id, stream_kind, stream_id, stream_version, event_type,
        schema_version, occurred_at, actor_json, correlation_id, payload_json
      ) VALUES
        ('evt_123e4567-e89b-42d3-a456-426614174081', 'ws_123e4567-e89b-42d3-a456-426614174081', 'run', 'run_123e4567-e89b-42d3-a456-426614174081', 1, 'run.created', 1, '2026-08-20T12:00:00.000Z', '{}', '123e4567-e89b-42d3-a456-426614174081', '{}'),
        ('evt_123e4567-e89b-42d3-a456-426614174082', 'ws_123e4567-e89b-42d3-a456-426614174082', 'run', 'run_123e4567-e89b-42d3-a456-426614174082', 1, 'run.created', 1, '2026-08-20T12:00:00.000Z', '{}', '123e4567-e89b-42d3-a456-426614174082', '{}')
    `);
    const close = vi.spyOn(opened, "close");

    await expect(
      startControlPlane({
        config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
        openDatabase: () => opened,
        installSignalHandlers: false,
        log: vi.fn()
      })
    ).rejects.toThrow(/multiple|ambiguous/i);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects the configured API token before it can enter durable run data", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const server = {
      close: (callback?: (error?: Error) => void) => callback?.()
    } as unknown as ServerType;
    const runtime = await startControlPlane({
      config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
      serve: vi.fn(() => server) as unknown as typeof serve,
      installSignalHandlers: false,
      log: vi.fn()
    });

    const response = await runtime.app.request("/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "secret-payload"
      },
      body: JSON.stringify({ title: `Never persist ${TOKEN}` })
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(TOKEN);
    const list = await runtime.app.request("/v1/runs", {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    expect(await list.json()).toEqual({ items: [] });
    await runtime.close();
  });

  it("closes storage and the executor when server startup fails", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const serveImplementation = vi.fn(() => {
      throw new Error("listen failed");
    }) as unknown as typeof serve;

    await expect(
      startControlPlane({
        config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
        serve: serveImplementation,
        installSignalHandlers: false,
        log: vi.fn()
      })
    ).rejects.toThrow("listen failed");
  });

  it("closes the listener and database after a post-listen startup failure", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const opened = openDatabase({ filePath: join(dataDirectory, "autostack.sqlite") });
    const databaseClose = vi.spyOn(opened, "close");
    const serverClose = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const server = { close: serverClose } as unknown as ServerType;

    await expect(
      startControlPlane({
        config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
        openDatabase: () => opened,
        serve: vi.fn(() => server) as unknown as typeof serve,
        installSignalHandlers: false,
        log: () => {
          throw new Error("logger failed");
        }
      })
    ).rejects.toThrow("logger failed");
    expect(serverClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(databaseClose).toHaveBeenCalledTimes(1));
    expect(() => opened.connection.prepare("SELECT 1").get()).toThrow();
  });

  it("keeps cleanup failures from escaping a post-listen startup failure", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const opened = openDatabase({ filePath: join(dataDirectory, "autostack.sqlite") });
    const closeDatabase = opened.close.bind(opened);
    const databaseClose = vi.spyOn(opened, "close").mockImplementation(() => {
      closeDatabase();
      throw new Error("database cleanup failed");
    });
    const server = {
      close: (callback?: (error?: Error) => void) =>
        callback?.(new Error("listener cleanup failed"))
    } as unknown as ServerType;
    const unhandled: unknown[] = [];
    const captureUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", captureUnhandled);
    try {
      await expect(
        startControlPlane({
          config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
          openDatabase: () => opened,
          serve: vi.fn(() => server) as unknown as typeof serve,
          installSignalHandlers: false,
          log: () => {
            throw new Error("original startup failure");
          }
        })
      ).rejects.toThrow("original startup failure");
      await vi.waitFor(() => expect(databaseClose).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", captureUnhandled);
    }
  });

  it("still stops the executor and storage when listener shutdown fails", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const server = {
      close: (callback?: (error?: Error) => void) => callback?.(new Error("close failed"))
    } as unknown as ServerType;
    const runtime = await startControlPlane({
      config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
      serve: vi.fn(() => server) as unknown as typeof serve,
      installSignalHandlers: false,
      log: vi.fn()
    });

    await expect(runtime.close()).rejects.toThrow("close failed");
    expect(runtime.executor.getStatus()).toBe("stopped");
  });

  it("closes storage even when executor shutdown rejects", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const opened = openDatabase({ filePath: join(dataDirectory, "autostack.sqlite") });
    const databaseClose = vi.spyOn(opened, "close");
    const server = {
      close: (callback?: (error?: Error) => void) => callback?.()
    } as unknown as ServerType;
    const runtime = await startControlPlane({
      config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
      openDatabase: () => opened,
      serve: vi.fn(() => server) as unknown as typeof serve,
      installSignalHandlers: false,
      log: vi.fn()
    });
    vi.spyOn(runtime.executor, "stop").mockRejectedValue(new Error("executor stop failed"));

    await expect(runtime.close()).rejects.toThrow("executor stop failed");
    expect(databaseClose).toHaveBeenCalledTimes(1);
    expect(() => opened.connection.prepare("SELECT 1").get()).toThrow();
  });

  it("rejects an asynchronous listener error before starting successfully", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const emitter = new EventEmitter() as EventEmitter & {
      close(callback?: (error?: Error) => void): void;
    };
    emitter.close = (callback) => callback?.();
    const log = vi.fn();
    const startExecutor = vi.spyOn(LocalWorkflowExecutor.prototype, "start");
    const starting = startControlPlane({
      config: { dataDirectory, token: TOKEN, host: "127.0.0.1", port: 4318 },
      serve: vi.fn(() => {
        queueMicrotask(() => emitter.emit("error", new Error("EADDRINUSE")));
        return emitter as unknown as ServerType;
      }) as unknown as typeof serve,
      installSignalHandlers: false,
      log
    });

    await expect(starting).rejects.toThrow("EADDRINUSE");
    expect(startExecutor).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("control_plane_started"));
  });

  it("rejects a real address collision and releases the opened database", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "autostack-control-plane-"));
    temporaryDirectories.push(dataDirectory);
    const occupied = createNetServer();
    await new Promise<void>((resolveListening, rejectListening) => {
      occupied.once("error", rejectListening);
      occupied.listen(0, "127.0.0.1", resolveListening);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected an assigned TCP port.");
    }
    const log = vi.fn();
    try {
      await expect(
        startControlPlane({
          config: {
            dataDirectory,
            token: TOKEN,
            host: "127.0.0.1",
            port: address.port
          },
          installSignalHandlers: false,
          log
        })
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("control_plane_started"));

      const reopened = openDatabase({ filePath: join(dataDirectory, "autostack.sqlite") });
      reopened.close();
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        occupied.close((error) => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
      });
    }
  });
});
