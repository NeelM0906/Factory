import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ArtifactDescriptorSchema,
  ReadCommandEventsRequestSchema,
  RunnerSubscriptionItemSchema,
  type ArtifactDescriptor,
  type RunnerStreamEvent
} from "@autostack/contracts";

import { CommandReconciler } from "../src/command-reconciler.js";

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
const request = ReadCommandEventsRequestSchema.parse({ ...ids, after: 0 });
const transcript = ArtifactDescriptorSchema.parse({
  artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
  workspaceId: ids.workspaceId,
  runId: ids.runId,
  commandId: ids.commandId,
  kind: "command_transcript",
  mediaType: "text/plain; charset=utf-8",
  digest: createHash("sha256").update("").digest("hex"),
  byteSize: 0,
  createdAt: "2026-08-21T12:00:02.000Z"
});
const event = (candidate: unknown) =>
  RunnerSubscriptionItemSchema.parse({ type: "runner.event", event: candidate });

describe("CommandReconciler", () => {
  it("reconnects after lag and records verified artifact before completion", async () => {
    const connections: number[] = [];
    const streams = [
      [
        event({
          type: "command.started",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 1,
          occurredAt: "2026-08-21T12:00:00.000Z",
          pty: true
        }),
        RunnerSubscriptionItemSchema.parse({
          type: "subscription.lagged",
          lastDurableSequence: 1,
          resumeCursor: 1
        })
      ],
      [
        event({
          type: "artifact.created",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 2,
          occurredAt: "2026-08-21T12:00:02.000Z",
          artifact: transcript
        }),
        event({
          type: "command.completed",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 3,
          occurredAt: "2026-08-21T12:00:03.000Z",
          exitCode: 0,
          signal: null,
          durationMs: 3,
          cancelled: false,
          interrupted: false,
          transcript
        })
      ]
    ];
    const operations: string[] = [];
    const recordedArtifacts = new Set<string>();
    const reconciler = new CommandReconciler({
      host: {
        openCommandEvents(candidate) {
          connections.push(candidate.after);
          const items = streams.shift() ?? [];
          return (async function* () {
            for (const item of items) yield item;
          })();
        }
      },
      artifacts: {
        verifyFinalizedArtifact: async (descriptor: ArtifactDescriptor) => {
          operations.push(`verified:${descriptor.artifactId}`);
          return descriptor;
        }
      },
      evidence: {
        recordStarted: async () => void operations.push("started"),
        recordArtifact: async (descriptor) => {
          recordedArtifacts.add(descriptor.artifactId);
          operations.push(`artifact:${descriptor.artifactId}`);
        },
        hasArtifact: async (artifactId) => recordedArtifacts.has(artifactId),
        hasVerifiedTranscript: async () => false,
        recordCompletion: async (_event: RunnerStreamEvent) => void operations.push("completed")
      }
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("completed");
    expect(connections).toEqual([0, 1]);
    expect(operations).toEqual([
      "started",
      `verified:${transcript.artifactId}`,
      `artifact:${transcript.artifactId}`,
      "completed"
    ]);
  });

  it("leaves a command pending after bounded transport exhaustion", async () => {
    let attempts = 0;
    const reconciler = new CommandReconciler({
      host: {
        openCommandEvents() {
          attempts += 1;
          return (async function* () {})();
        }
      },
      artifacts: { verifyFinalizedArtifact: async () => transcript },
      evidence: {
        recordStarted: async () => undefined,
        recordArtifact: async () => undefined,
        hasArtifact: async () => false,
        hasVerifiedTranscript: async () => false,
        recordCompletion: async () => undefined
      },
      maximumReconnects: 2,
      sleep: async () => undefined
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("pending");
    expect(attempts).toBe(3);
  });

  it("rejects a concurrent request that changes immutable command ownership", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconciler = new CommandReconciler({
      host: {
        openCommandEvents() {
          return (async function* () {
            await blocked;
          })();
        }
      },
      artifacts: { verifyFinalizedArtifact: async () => transcript },
      evidence: {
        recordStarted: async () => undefined,
        recordArtifact: async () => undefined,
        hasArtifact: async () => false,
        hasVerifiedTranscript: async () => false,
        recordCompletion: async () => undefined
      },
      maximumReconnects: 0
    });

    const first = reconciler.reconcile(request);
    const collision = reconciler.reconcile(
      ReadCommandEventsRequestSchema.parse({
        ...request,
        commandAuthorizationDigest: "c".repeat(64)
      })
    );
    expect(collision).not.toBe(first);
    await expect(collision).rejects.toThrow(/ownership differs/i);
    release();
    await first;
  });

  it("replays an event when its evidence commit fails instead of advancing the cursor", async () => {
    const connections: number[] = [];
    let writes = 0;
    const started = event({
      type: "command.started",
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      commandId: ids.commandId,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:00.000Z",
      pty: true
    });
    const reconciler = new CommandReconciler({
      host: {
        openCommandEvents(candidate) {
          connections.push(candidate.after);
          return (async function* () {
            if (candidate.after === 0) yield started;
          })();
        }
      },
      artifacts: { verifyFinalizedArtifact: async () => transcript },
      evidence: {
        recordStarted: async () => {
          writes += 1;
          if (writes === 1) throw new Error("injected evidence failure");
        },
        recordArtifact: async () => undefined,
        hasArtifact: async () => false,
        hasVerifiedTranscript: async () => false,
        recordCompletion: async () => undefined
      },
      maximumReconnects: 1,
      sleep: async () => undefined
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("pending");
    expect(connections).toEqual([0, 0, 1, 1]);
    expect(writes).toBe(2);
  });
});
