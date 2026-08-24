import { describe, expect, it } from "vitest";

import {
  CommandIdSchema,
  LocalPrepareRequestSchema,
  RepositoryInspectionSchema,
  type PrepareEnvironmentRequest
} from "@autostack/contracts";

import { LocalExecutionService } from "../src/local-execution-service.js";
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
