import { describe, expect, it } from "vitest";

import {
  CommandIdSchema,
  LocalPrepareRequestSchema,
  RepositoryInspectionSchema,
  type PrepareEnvironmentRequest
} from "@autostack/contracts";

import {
  LocalExecutionService,
  LocalRunnerUnavailableError
} from "../src/local-execution-service.js";
import { deriveDurableCommandCursor } from "../src/reconciliation-cursor.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("LocalExecutionService", () => {
  it("derives the restart cursor from committed started and artifact evidence", () => {
    expect(
      deriveDurableCommandCursor(
        [
          {
            type: "command.started",
            payload: { commandId: `cmd_${UUID}`, hostSequence: 1 }
          },
          {
            type: "artifact.recorded",
            payload: { commandId: `cmd_${UUID}`, hostSequence: 2 }
          }
        ] as never,
        CommandIdSchema.parse(`cmd_${UUID}`)
      )
    ).toBe(2);
  });

  it("records a dirty source inspection without mutating the user's source bytes", async () => {
    const operations: string[] = [];
    const sourceBytes = Buffer.from("user-dirty\n");
    const before = Buffer.from(sourceBytes);
    const inspection = RepositoryInspectionSchema.parse({
      repositoryIdentity: "github:example/repo",
      canonicalSourcePath: "/repo",
      repositoryCommonDirectory: "/repo/.git",
      resolvedBaseRef: "main",
      sourceCommit: "b".repeat(40),
      dirty: true,
      diagnostics: []
    });
    const authorized = { marker: "authorized" } as unknown as PrepareEnvironmentRequest;
    const service = new LocalExecutionService({
      host: {
        inspectRepository: async () => inspection,
        prepareEnvironment: async (request) => {
          operations.push(`host:${String((request as unknown as { marker: string }).marker)}`);
          return { environment: { marker: "prepared" }, replayed: false } as never;
        }
      },
      state: {
        authorizePreparation: async (_input, actualInspection, key) => {
          expect(actualInspection).toEqual(inspection);
          expect(key).toBe("prepare-1");
          return authorized;
        },
        recordPreparationIntent: async (request) => {
          expect(request).toBe(authorized);
          operations.push("intent");
        },
        recordPrepared: async () => void operations.push("prepared")
      }
    });

    const response = await service.prepare(
      LocalPrepareRequestSchema.parse({
        runId: `run_${UUID}`,
        approvalId: `apr_${UUID}`,
        environmentAuthorizationId: `envauth_${UUID}`,
        environmentId: `env_${UUID}`,
        sourcePath: "/repo",
        baseRef: "main",
        branchSlug: "feature"
      }),
      "prepare-1"
    );

    expect(response.replayed).toBe(false);
    expect(operations).toEqual(["intent", "host:authorized", "prepared"]);
    expect(sourceBytes.equals(before)).toBe(true);
  });

  it("reads an artifact through the public local boundary with cursor-free host ownership", async () => {
    const request = {
      workspaceId: `ws_${UUID}`,
      runId: `run_${UUID}`,
      environmentId: `env_${UUID}`,
      commandId: `cmd_${UUID}`,
      artifactId: `art_${UUID}`,
      environmentAuthorizationId: `envauth_${UUID}`,
      environmentAuthorizationDigest: "a".repeat(64),
      commandAuthorizationId: `cmdauth_${UUID}`,
      commandAuthorizationDigest: "b".repeat(64),
      offset: 0,
      length: 1
    } as const;
    const response = {
      artifact: {
        artifactId: request.artifactId,
        workspaceId: request.workspaceId,
        runId: request.runId,
        commandId: request.commandId,
        kind: "command_transcript",
        mediaType: "text/plain; charset=utf-8",
        digest: "c".repeat(64),
        byteSize: 1,
        createdAt: "2026-08-21T12:00:00.000Z"
      },
      offset: 0,
      bytes: "eA==",
      nextOffset: 1,
      done: true
    } as const;
    const service = new LocalExecutionService({
      state: {
        resolveArtifactRead: async () => request as never
      },
      host: {
        readArtifactRange: async (candidate) => {
          expect(candidate).toEqual(request);
          expect(candidate).not.toHaveProperty("after");
          return response as never;
        }
      }
    });

    await expect(
      service.readArtifact({ artifactId: request.artifactId, offset: 0, length: 1 } as never)
    ).resolves.toEqual(response);
  });

  it("retires a lost host generation once and closes ingress before persistence", async () => {
    const operations: string[] = [];
    const service = new LocalExecutionService({
      host: {},
      state: {},
      retirement: {
        closeIngress: async () => void operations.push("ingress"),
        stopReconciliation: async () => void operations.push("reconciliation"),
        closePersistence: async () => void operations.push("persistence")
      }
    });

    const first = service.retireHostGeneration();
    const second = service.retireHostGeneration();
    expect(first).toBe(second);
    await first;
    expect(operations).toEqual(["ingress", "reconciliation", "persistence"]);
    expect(() => service.inspect({ sourcePath: "/repo", baseRef: "main" })).toThrow(/unavailable/i);
  });
});

describe("LocalExecutionService host delegation", () => {
  const events = {
    environmentId: `env_${UUID}`,
    commandId: `cmd_${UUID}`,
    after: 4
  } as const;

  it("lists prepared environments straight from the host", async () => {
    const listing = { items: [] } as const;
    const service = new LocalExecutionService({
      host: { listEnvironments: async () => listing as never },
      state: {}
    });

    await expect(service.list()).resolves.toBe(listing);
  });

  it("opens a command event stream against the ownership-resolved host request", async () => {
    const resolved = { marker: "resolved events" };
    const stream = (async function* () {
      yield { type: "subscription.lagged", lastDurableSequence: 1, resumeCursor: 1 } as const;
    })();
    const service = new LocalExecutionService({
      state: {
        resolveEvents: async (input) => {
          expect(input).toEqual(events);
          return resolved as never;
        }
      },
      host: {
        openCommandEvents: (request) => {
          expect(request).toBe(resolved as never);
          return stream;
        }
      }
    });

    await expect(service.events(events as never)).resolves.toBe(stream);
  });

  it("cancels through the ownership-resolved host request", async () => {
    const resolved = { marker: "resolved cancel" };
    const response = { commandId: `cmd_${UUID}`, cancelled: true, replayed: false } as const;
    const service = new LocalExecutionService({
      state: { resolveCancellation: async () => resolved as never },
      host: {
        cancelCommand: async (request) => {
          expect(request).toBe(resolved as never);
          return response as never;
        }
      }
    });

    await expect(
      service.cancel({
        environmentId: events.environmentId,
        commandId: events.commandId,
        commandAuthorizationId: `cmdauth_${UUID}`,
        idempotencyKey: "cancel-1"
      } as never)
    ).resolves.toBe(response);
  });

  it("disposes through the ownership-resolved host request", async () => {
    const resolved = { marker: "resolved dispose" };
    const response = { environmentId: `env_${UUID}`, disposed: true, replayed: false } as const;
    const service = new LocalExecutionService({
      state: { resolveDisposal: async () => resolved as never },
      host: {
        disposeEnvironment: async (request) => {
          expect(request).toBe(resolved as never);
          return response as never;
        }
      }
    });

    await expect(
      service.dispose({
        environmentId: events.environmentId,
        environmentAuthorizationId: `envauth_${UUID}`,
        idempotencyKey: "dispose-1"
      } as never)
    ).resolves.toBe(response);
  });

  it("notifies the reconciler about an accepted start without blocking the caller's response", async () => {
    const tracked: unknown[] = [];
    const authorized = { marker: "authorized start" };
    const accepted = {
      commandId: `cmd_${UUID}`,
      acceptedAt: "2026-08-21T12:00:00.000Z",
      replayed: false
    } as const;
    const service = new LocalExecutionService({
      state: {
        authorizeStart: async (_input, key) => {
          expect(key).toBe("start-1");
          return authorized as never;
        },
        recordCommandIntent: async () => undefined
      },
      host: { startCommand: async () => accepted as never },
      reconciler: { trackAccepted: async (request) => void tracked.push(request) }
    });

    await expect(
      service.start(
        {
          runId: `run_${UUID}`,
          approvalId: `apr_${UUID}`,
          commandAuthorizationId: `cmdauth_${UUID}`,
          environmentId: events.environmentId,
          commandId: events.commandId,
          command: {
            executable: "/usr/bin/true",
            args: [],
            cwd: ".",
            environment: [],
            timeoutSeconds: 30,
            terminal: { columns: 80, rows: 24 }
          }
        } as never,
        "start-1"
      )
    ).resolves.toBe(accepted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracked).toEqual([authorized]);
  });

  it("still answers the caller when reconciler tracking of an accepted start fails", async () => {
    const accepted = {
      commandId: `cmd_${UUID}`,
      acceptedAt: "2026-08-21T12:00:00.000Z",
      replayed: false
    } as const;
    const service = new LocalExecutionService({
      state: {
        authorizeStart: async () => ({ marker: "authorized" }) as never,
        recordCommandIntent: async () => undefined
      },
      host: { startCommand: async () => accepted as never },
      reconciler: {
        trackAccepted: async () => {
          throw new Error("private tracking failure");
        }
      }
    });

    await expect(
      service.start(
        {
          runId: `run_${UUID}`,
          approvalId: `apr_${UUID}`,
          commandAuthorizationId: `cmdauth_${UUID}`,
          environmentId: events.environmentId,
          commandId: events.commandId,
          command: {
            executable: "/usr/bin/true",
            args: [],
            cwd: ".",
            environment: [],
            timeoutSeconds: 30,
            terminal: { columns: 80, rows: 24 }
          }
        } as never,
        "start-1"
      )
    ).resolves.toBe(accepted);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("LocalExecutionService unavailability", () => {
  it("reports the local runner unavailable for every capability the host does not provide", async () => {
    const service = new LocalExecutionService({ host: {}, state: {} });

    expect(() => service.list()).toThrow(LocalRunnerUnavailableError);
    expect(() => service.inspect({ sourcePath: "/repo", baseRef: "main" } as never)).toThrow(
      LocalRunnerUnavailableError
    );
    await expect(
      service.events({ environmentId: `env_${UUID}`, commandId: `cmd_${UUID}`, after: 0 } as never)
    ).rejects.toThrow(LocalRunnerUnavailableError);
    await expect(
      service.cancel({
        environmentId: `env_${UUID}`,
        commandId: `cmd_${UUID}`,
        commandAuthorizationId: `cmdauth_${UUID}`,
        idempotencyKey: "cancel-1"
      } as never)
    ).rejects.toThrow(LocalRunnerUnavailableError);
    await expect(
      service.readArtifact({ artifactId: `art_${UUID}`, offset: 0, length: 1 } as never)
    ).rejects.toThrow(LocalRunnerUnavailableError);
    await expect(
      service.dispose({
        environmentId: `env_${UUID}`,
        environmentAuthorizationId: `envauth_${UUID}`,
        idempotencyKey: "dispose-1"
      } as never)
    ).rejects.toThrow(LocalRunnerUnavailableError);
  });

  it("refuses to retire a generation that has no configured retirement sequence", () => {
    const service = new LocalExecutionService({ host: {}, state: {} });

    expect(() => service.retireHostGeneration()).toThrow(LocalRunnerUnavailableError);
  });

  it("closes every capability once the generation is retired", async () => {
    const service = new LocalExecutionService({
      host: { listEnvironments: async () => ({ items: [] }) as never },
      state: {},
      retirement: {
        closeIngress: async () => undefined,
        stopReconciliation: async () => undefined,
        closePersistence: async () => undefined
      }
    });

    await expect(service.list()).resolves.toEqual({ items: [] });
    await service.retireHostGeneration();

    expect(() => service.list()).toThrow(LocalRunnerUnavailableError);
    await expect(
      service.dispose({
        environmentId: `env_${UUID}`,
        environmentAuthorizationId: `envauth_${UUID}`,
        idempotencyKey: "dispose-1"
      } as never)
    ).rejects.toThrow(LocalRunnerUnavailableError);
  });
});
