import { describe, expect, it } from "vitest";

import { ReadCommandEventsRequestSchema, type StartCommandRequest } from "@autostack/contracts";

import { CommandReconciliationSupervisor } from "../src/reconciliation-supervisor.js";
import { ControlPlaneShutdown } from "../src/shutdown.js";

const ids = {
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000",
  environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
  commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
  environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
  environmentAuthorizationDigest: "a".repeat(64),
  commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
  commandAuthorizationDigest: "b".repeat(64)
} as const;
const start = {
  runId: ids.runId,
  environmentId: ids.environmentId,
  commandId: ids.commandId,
  marker: "exact durable start request"
} as unknown as StartCommandRequest;

describe("CommandReconciliationSupervisor", () => {
  it("replays a host-accepted durable start after restart and follows it to terminal", async () => {
    const operations: string[] = [];
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingCommandStarts: async () => [start],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 })
      },
      host: {
        startCommand: async (request) => {
          expect(request).toEqual(start);
          operations.push("host-replay");
          return {} as never;
        }
      },
      reconciler: {
        reconcile: async (request) => {
          operations.push(`events:${request.after}`);
          return "completed";
        }
      },
      sleep: async () => undefined
    });

    await supervisor.recover();
    await supervisor.drain();
    expect(operations).toEqual(["host-replay", "events:0"]);
  });

  it("resumes after an already-durable artifact and keeps retrying until completion", async () => {
    const cursors = [2, 2];
    let attempts = 0;
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingCommandStarts: async () => [start],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: cursors.shift() ?? 2 })
      },
      host: { startCommand: async () => ({}) as never },
      reconciler: {
        reconcile: async (request) => {
          expect(request.after).toBe(2);
          attempts += 1;
          return attempts === 1 ? "pending" : "completed";
        }
      },
      sleep: async () => undefined
    });

    await supervisor.recover();
    await supervisor.drain();
    expect(attempts).toBe(2);
  });

  it("does not finish shutdown drain until an active reconciler is terminal", async () => {
    let release!: () => void;
    const terminal = new Promise<void>((resolve) => {
      release = resolve;
    });
    let drained = false;
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingCommandStarts: async () => [],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 })
      },
      host: { startCommand: async () => ({}) as never },
      reconciler: {
        reconcile: async () => {
          await terminal;
          return "completed";
        }
      }
    });

    void supervisor.trackAccepted(start);
    const drain = supervisor.drain().then(() => void (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    expect(drained).toBe(true);
  });

  it("supervises a host-accepted command that races with quiesce without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const capture = (error: unknown): void => void unhandled.push(error);
    process.on("unhandledRejection", capture);
    let attempts = 0;
    try {
      const supervisor = new CommandReconciliationSupervisor({
        recovery: {
          listPendingCommandStarts: async () => [],
          resolveReconciliationEvents: async () =>
            ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 })
        },
        host: { startCommand: async () => ({}) as never },
        reconciler: {
          reconcile: async () => {
            attempts += 1;
            return "completed";
          }
        }
      });

      supervisor.quiesce();
      void supervisor.trackAccepted(start);
      await supervisor.drain();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(attempts).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", capture);
    }
  });

  it("retries an evidence-write failure without dropping the supervised command", async () => {
    let attempts = 0;
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingCommandStarts: async () => [],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: attempts })
      },
      host: { startCommand: async () => ({}) as never },
      reconciler: {
        reconcile: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("private evidence failure");
          return "completed";
        }
      },
      sleep: async () => undefined
    });

    void supervisor.trackAccepted(start);
    await expect(supervisor.drain()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("retains an exhausted failure and makes shutdown drain fail before persistence close", async () => {
    let persistenceClosed = false;
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingCommandStarts: async () => [],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 })
      },
      host: { startCommand: async () => ({}) as never },
      reconciler: {
        reconcile: async () => {
          throw new Error("private evidence failure");
        }
      },
      maximumFailures: 0,
      sleep: async () => undefined
    });
    const shutdown = new ControlPlaneShutdown({
      quiesceIngress: async () => supervisor.quiesce(),
      drainReconciliation: () => supervisor.drain(),
      closeListener: async () => undefined,
      closeExecutor: async () => undefined,
      closePersistence: async () => void (persistenceClosed = true)
    });

    void supervisor.trackAccepted(start);
    await expect(shutdown.close()).rejects.toThrow("Reconciliation drain failed.");
    expect(persistenceClosed).toBe(false);
  });
});
