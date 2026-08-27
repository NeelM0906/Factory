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

describe("CommandReconciler terminal evidence", () => {
  const streamOf = (items: readonly unknown[]) => ({
    openCommandEvents() {
      return (async function* () {
        for (const item of items) yield item as never;
      })();
    }
  });
  const sink = (overrides: Record<string, unknown> = {}) => ({
    recordStarted: async () => undefined,
    recordArtifact: async () => undefined,
    hasArtifact: async () => false,
    hasVerifiedTranscript: async () => false,
    recordCompletion: async () => undefined,
    ...overrides
  });
  const streamError = (code: "protocol_failure" | "guardian_lost") =>
    event({
      type: "stream.error",
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      commandId: ids.commandId,
      sequence: 5,
      occurredAt: "2026-08-21T12:00:05.000Z",
      code,
      message: "The guardian stream failed."
    });
  const completed = event({
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
  });
  const artifactCreated = event({
    type: "artifact.created",
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    commandId: ids.commandId,
    sequence: 2,
    occurredAt: "2026-08-21T12:00:02.000Z",
    artifact: transcript
  });

  it("rejects a negative reconnect limit at construction", () => {
    expect(
      () =>
        new CommandReconciler({
          host: streamOf([]),
          artifacts: { verifyFinalizedArtifact: async () => transcript },
          evidence: sink(),
          maximumReconnects: -1
        })
    ).toThrow(/Reconnect limit is invalid/);
  });

  it("shares one reconciliation between two identical concurrent requests", async () => {
    let opens = 0;
    const reconciler = new CommandReconciler({
      host: {
        openCommandEvents() {
          opens += 1;
          return (async function* () {
            yield completed as never;
          })();
        }
      },
      artifacts: { verifyFinalizedArtifact: async () => transcript },
      evidence: sink(),
      sleep: async () => undefined
    });

    const first = reconciler.reconcile(request);
    const second = reconciler.reconcile(request);
    expect(second).toBe(first);
    await expect(first).resolves.toBe("completed");
    expect(opens).toBe(1);
  });

  it("verifies the terminal transcript when it is not already durable evidence", async () => {
    const verified: string[] = [];
    const recorded: number[] = [];
    const reconciler = new CommandReconciler({
      host: streamOf([completed]),
      artifacts: {
        verifyFinalizedArtifact: async (descriptor: ArtifactDescriptor) => {
          verified.push(descriptor.artifactId);
          return descriptor;
        }
      },
      evidence: sink({
        recordArtifact: async (_descriptor: ArtifactDescriptor, hostSequence: number) =>
          void recorded.push(hostSequence)
      }),
      sleep: async () => undefined
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("completed");
    expect(verified).toEqual([transcript.artifactId]);
    expect(recorded).toEqual([0]);
  });

  it("skips re-verifying a terminal transcript that is already durable evidence", async () => {
    let verifications = 0;
    let artifactWrites = 0;
    const reconciler = new CommandReconciler({
      host: streamOf([completed]),
      artifacts: {
        verifyFinalizedArtifact: async (descriptor: ArtifactDescriptor) => {
          verifications += 1;
          return descriptor;
        }
      },
      evidence: sink({
        hasArtifact: async () => true,
        recordArtifact: async () => void (artifactWrites += 1)
      }),
      sleep: async () => undefined
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("completed");
    expect(verifications).toBe(0);
    expect(artifactWrites).toBe(0);
  });

  it("leaves a stream error pending when no transcript has been verified anywhere", async () => {
    let completions = 0;
    const reconciler = new CommandReconciler({
      host: streamOf([streamError("guardian_lost")]),
      artifacts: { verifyFinalizedArtifact: async () => transcript },
      evidence: sink({ recordCompletion: async () => void (completions += 1) }),
      sleep: async () => undefined
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("pending");
    expect(completions).toBe(0);
  });

  it("terminalizes a stream error once this stream has verified a transcript", async () => {
    let completions = 0;
    const reconciler = new CommandReconciler({
      host: streamOf([artifactCreated, streamError("protocol_failure")]),
      artifacts: { verifyFinalizedArtifact: async (d: ArtifactDescriptor) => d },
      evidence: sink({ recordCompletion: async () => void (completions += 1) }),
      sleep: async () => undefined
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("completed");
    expect(completions).toBe(1);
  });

  it("terminalizes a stream error when durable evidence already holds a verified transcript", async () => {
    let completions = 0;
    const reconciler = new CommandReconciler({
      host: streamOf([streamError("protocol_failure")]),
      artifacts: { verifyFinalizedArtifact: async () => transcript },
      evidence: sink({
        hasVerifiedTranscript: async () => true,
        recordCompletion: async () => void (completions += 1)
      }),
      sleep: async () => undefined
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("completed");
    expect(completions).toBe(1);
  });

  it("advances the cursor past a non-terminal output frame and resumes there after a disconnect", async () => {
    const connections: number[] = [];
    const output = event({
      type: "terminal.output",
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      commandId: ids.commandId,
      sequence: 4,
      occurredAt: "2026-08-21T12:00:04.000Z",
      stream: "pty",
      text: "verified"
    });
    const reconciler = new CommandReconciler({
      host: {
        openCommandEvents(candidate) {
          connections.push(candidate.after);
          return (async function* () {
            if (candidate.after === 0) yield output as never;
          })();
        }
      },
      artifacts: { verifyFinalizedArtifact: async () => transcript },
      evidence: sink(),
      maximumReconnects: 1,
      sleep: async () => undefined
    });

    await expect(reconciler.reconcile(request)).resolves.toBe("pending");
    expect(connections).toEqual([0, 4, 4]);
  });

  it("refuses a request that is not a valid command events request", () => {
    const reconciler = new CommandReconciler({
      host: streamOf([]),
      artifacts: { verifyFinalizedArtifact: async () => transcript },
      evidence: sink()
    });

    expect(() => reconciler.reconcile({ ...request, after: -1 } as never)).toThrow();
  });
});
