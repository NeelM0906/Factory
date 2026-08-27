import { beforeAll, describe, expect, it } from "vitest";

import {
  ReadCommandEventsRequestSchema,
  type PrepareEnvironmentRequest,
  type StartCommandRequest
} from "@autostack/contracts";

import { CommandReconciliationSupervisor } from "../src/reconciliation-supervisor.js";
import { ControlPlaneShutdown } from "../src/shutdown.js";

import { localExecutionRequests } from "./fixtures/seed-approved-run.js";

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

  it("rejects a negative failure limit at construction rather than supervising unbounded retries", () => {
    const dependencies = {
      recovery: {
        listPendingCommandStarts: async () => [],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 })
      },
      host: { startCommand: async () => ({}) as never },
      reconciler: { reconcile: async () => "completed" as const }
    };

    expect(
      () => new CommandReconciliationSupervisor({ ...dependencies, maximumFailures: -1 })
    ).toThrow(/Reconciliation failure limit is invalid/);
    expect(
      () => new CommandReconciliationSupervisor({ ...dependencies, maximumFailures: 1.5 })
    ).toThrow(/Reconciliation failure limit is invalid/);
  });
});

describe("CommandReconciliationSupervisor preparation recovery", () => {
  let preparation: PrepareEnvironmentRequest;

  beforeAll(async () => {
    preparation = (await localExecutionRequests(700)).prepare;
  });

  it("replays an interrupted preparation against the host and records the prepared evidence", async () => {
    const operations: string[] = [];
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingPreparations: async () => [preparation],
        listPendingCommandStarts: async () => [],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 }),
        recordPrepared: async (request, result) => {
          expect(request).toEqual(preparation);
          operations.push(`recorded:${String((result as { replayed: boolean }).replayed)}`);
        }
      },
      host: {
        prepareEnvironment: async (request) => {
          expect(request).toEqual(preparation);
          operations.push("host-prepare");
          return { environment: {}, replayed: true } as never;
        },
        startCommand: async () => ({}) as never
      },
      reconciler: { reconcile: async () => "completed" },
      sleep: async () => undefined
    });

    await supervisor.recover();
    await supervisor.drain();
    expect(operations).toEqual(["host-prepare", "recorded:true"]);
  });

  it("retries a failing host preparation and succeeds within the failure budget", async () => {
    let attempts = 0;
    let recorded = 0;
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingPreparations: async () => [preparation],
        listPendingCommandStarts: async () => [],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 }),
        recordPrepared: async () => void (recorded += 1)
      },
      host: {
        prepareEnvironment: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("private host failure");
          return { environment: {}, replayed: false } as never;
        },
        startCommand: async () => ({}) as never
      },
      reconciler: { reconcile: async () => "completed" },
      sleep: async () => undefined
    });

    await supervisor.recover();
    await expect(supervisor.drain()).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(recorded).toBe(1);
  });

  it("fails the drain when a host without preparation support cannot replay the intent", async () => {
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingPreparations: async () => [preparation],
        listPendingCommandStarts: async () => [],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 })
      },
      host: { startCommand: async () => ({}) as never },
      reconciler: { reconcile: async () => "completed" },
      maximumFailures: 0,
      sleep: async () => undefined
    });

    await supervisor.recover();
    await expect(supervisor.drain()).rejects.toThrow("Reconciliation drain failed.");
  });

  it("rejects a durable preparation intent that does not parse as a prepare request", async () => {
    const supervisor = new CommandReconciliationSupervisor({
      recovery: {
        listPendingPreparations: async () => [
          { ...preparation, marker: "tampered" } as unknown as PrepareEnvironmentRequest
        ],
        listPendingCommandStarts: async () => [],
        resolveReconciliationEvents: async () =>
          ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 }),
        recordPrepared: async () => undefined
      },
      host: {
        prepareEnvironment: async () => ({ environment: {}, replayed: false }) as never,
        startCommand: async () => ({}) as never
      },
      reconciler: { reconcile: async () => "completed" },
      sleep: async () => undefined
    });

    await expect(supervisor.recover()).rejects.toThrow(/unrecognized_keys[\s\S]*marker/);
  });
});

describe("CommandReconciliationSupervisor supervision keys", () => {
  const base = {
    recovery: {
      listPendingCommandStarts: async () => [],
      resolveReconciliationEvents: async () =>
        ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 })
    },
    host: { startCommand: async () => ({}) as never },
    sleep: async () => undefined
  };

  it("shares one supervision task between two identical accepted starts", async () => {
    let attempts = 0;
    const supervisor = new CommandReconciliationSupervisor({
      ...base,
      reconciler: {
        reconcile: async () => {
          attempts += 1;
          return "completed";
        }
      }
    });

    const first = supervisor.trackAccepted(start);
    const second = supervisor.trackAccepted(start);
    expect(second).toBe(first);
    await supervisor.drain();
    expect(attempts).toBe(1);
  });

  it("fails the drain when the same command id is supervised under conflicting durable evidence", async () => {
    const supervisor = new CommandReconciliationSupervisor({
      ...base,
      reconciler: {
        reconcile: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return "completed";
        }
      }
    });

    void supervisor.trackAccepted(start);
    void supervisor.trackAccepted({ ...start, marker: "different evidence" } as never);

    await expect(supervisor.drain()).rejects.toThrow("Reconciliation drain failed.");
  });

  it("abandons an in-flight reconciliation that fails after stop was requested without recording a failure", async () => {
    let attempts = 0;
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const supervisor = new CommandReconciliationSupervisor({
      ...base,
      reconciler: {
        reconcile: async () => {
          attempts += 1;
          await inFlight;
          throw new Error("private evidence failure");
        }
      },
      maximumFailures: 0
    });

    void supervisor.trackAccepted(start);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopping = supervisor.stop();
    release();

    await expect(stopping).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    await expect(supervisor.drain()).resolves.toBeUndefined();
  });

  it("does not begin reconciling a command accepted after stop was requested", async () => {
    let attempts = 0;
    const supervisor = new CommandReconciliationSupervisor({
      ...base,
      reconciler: {
        reconcile: async () => {
          attempts += 1;
          return "completed";
        }
      }
    });

    await supervisor.stop();
    await supervisor.trackAccepted(start);
    expect(attempts).toBe(0);
  });

  it("returns the same stop promise for repeated shutdown requests", async () => {
    const supervisor = new CommandReconciliationSupervisor({
      ...base,
      reconciler: { reconcile: async () => "completed" }
    });

    const first = supervisor.stop();
    expect(supervisor.stop()).toBe(first);
    await first;
  });

  it("treats a repeated quiesce as a no-op and still drains cleanly", async () => {
    const supervisor = new CommandReconciliationSupervisor({
      ...base,
      reconciler: { reconcile: async () => "completed" }
    });

    supervisor.quiesce();
    supervisor.quiesce();
    await expect(supervisor.drain()).resolves.toBeUndefined();
    expect(supervisor.drain()).toBe(supervisor.drain());
  });
});
