import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { serve as honoServe } from "@hono/node-server";

import { createIdFactory } from "@autostack/contracts";
import { openDatabase, SqliteDurableStore } from "@autostack/db";
import {
  HandlerRegistry,
  LocalWorkflowExecutor,
  type RetryableJobError
} from "@autostack/workflow";

import { createApp } from "./app.js";
import { loadConfig, loadOrCreateLocalWorkspaceId, type ControlPlaneConfig } from "./config.js";

type ServeImplementation = typeof honoServe;
type Server = ReturnType<ServeImplementation>;

export interface StartControlPlaneOptions {
  readonly config?: ControlPlaneConfig;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly serve?: ServeImplementation;
  readonly installSignalHandlers?: boolean;
  readonly log?: (line: string) => void;
}

export interface ControlPlaneRuntime {
  readonly app: ReturnType<typeof createApp>;
  readonly executor: LocalWorkflowExecutor;
  close(): Promise<void>;
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error?: Error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });

const retryAt = (error: RetryableJobError, attempt: number, now: string): string => {
  void error;
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.parse(now) + delayMs).toISOString();
};

export function startControlPlane(options: StartControlPlaneOptions = {}): ControlPlaneRuntime {
  const config = options.config ?? loadConfig(options.environment);
  const log = options.log ?? ((line: string) => console.log(line));
  const database = openDatabase({ filePath: join(config.dataDirectory, "autostack.sqlite") });
  const ids = createIdFactory();
  const now = () => new Date().toISOString();
  const workspaceId = loadOrCreateLocalWorkspaceId(config.dataDirectory, ids.workspace, now);
  const store = new SqliteDurableStore(database, {
    eventId: ids.event,
    leaseToken: randomUUID,
    now,
    sensitiveValues: [config.token]
  });
  const registry = new HandlerRegistry({ sensitiveValues: [config.token] });
  const executor = new LocalWorkflowExecutor({
    store,
    registry,
    workerId: `local-control-plane-${process.pid}`,
    now,
    leaseDurationMs: 30_000,
    pollIntervalMs: 1_000,
    sensitiveValues: [config.token],
    retryAt: (error, job, timestamp) => retryAt(error, job.attempt, timestamp),
    reportError: (error, job) => {
      log(
        JSON.stringify({
          level: "error",
          event: "workflow_error",
          error,
          ...(job === undefined ? {} : { jobId: job.jobId })
        })
      );
    }
  });
  const app = createApp({
    store,
    executor,
    token: config.token,
    workspaceId,
    ids,
    now,
    correlationId: randomUUID
  });

  executor.start();
  let server: Server;
  try {
    server = (options.serve ?? honoServe)({
      fetch: app.fetch,
      hostname: config.host,
      port: config.port
    });
  } catch (error) {
    void executor.stop();
    void store.close();
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const signalHandler = (): void => {
    void close().catch((error: unknown) => {
      log(
        JSON.stringify({
          level: "error",
          event: "shutdown_failed",
          message: error instanceof Error ? error.message : "Unknown shutdown error."
        })
      );
      process.exitCode = 1;
    });
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      for (const signal of signals) process.removeListener(signal, signalHandler);
      let serverError: unknown;
      try {
        await closeServer(server);
      } catch (error) {
        serverError = error;
      }
      await executor.stop();
      await store.close();
      if (serverError !== undefined) throw serverError;
    })();
    return closePromise;
  };

  if (options.installSignalHandlers ?? true) {
    for (const signal of signals) process.once(signal, signalHandler);
  }

  log(
    JSON.stringify({
      level: "info",
      event: "control_plane_started",
      host: config.host,
      port: config.port
    })
  );

  return { app, executor, close };
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    startControlPlane();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "control_plane_start_failed",
        message: error instanceof Error ? error.message : "Unknown startup error."
      })
    );
    process.exitCode = 1;
  }
}
