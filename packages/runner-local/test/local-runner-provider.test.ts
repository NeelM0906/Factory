import { describe, expect, it } from "vitest";

import {
  ArtifactDescriptorSchema,
  ReadArtifactChunkRequestSchema,
  RunnerCapabilitiesSchema,
  createId,
  type PreparedEnvironment,
  type RunnerSubscriptionItem
} from "@autostack/contracts";

import { LocalRunnerProviderError, localRunnerHostControl } from "../src/local-runner-provider.js";
import { createLocalRunnerProviderForTesting } from "../src/local-runner-provider-testing.js";
import * as productionExports from "../src/index.js";
import { rematerializeProviderError } from "../src/local-runner-provider-admission.js";
import { CommandExecutorError } from "../src/command-executor-error.js";

const ids = Object.freeze({
  workspaceId: createId("workspace", "60000000-0000-4000-8000-000000000001"),
  runId: createId("run", "60000000-0000-4000-8000-000000000002"),
  environmentId: createId("environment", "60000000-0000-4000-8000-000000000003"),
  commandId: createId("command", "60000000-0000-4000-8000-000000000004"),
  artifactId: createId("artifact", "60000000-0000-4000-8000-000000000005"),
  environmentAuthorizationId: createId(
    "environmentAuthorization",
    "60000000-0000-4000-8000-000000000006"
  ),
  commandAuthorizationId: createId("commandAuthorization", "60000000-0000-4000-8000-000000000007")
});

const hex = (value: string): string => value.repeat(64);

const artifact = ArtifactDescriptorSchema.parse({
  artifactId: ids.artifactId,
  workspaceId: ids.workspaceId,
  runId: ids.runId,
  commandId: ids.commandId,
  kind: "command_transcript",
  mediaType: "text/plain; charset=utf-8",
  digest: hex("a"),
  byteSize: 5,
  createdAt: "2026-08-21T12:00:00.000Z"
});

const artifactRequest = ReadArtifactChunkRequestSchema.parse({
  workspaceId: ids.workspaceId,
  runId: ids.runId,
  environmentId: ids.environmentId,
  commandId: ids.commandId,
  artifactId: ids.artifactId,
  environmentAuthorizationId: ids.environmentAuthorizationId,
  environmentAuthorizationDigest: hex("b"),
  commandAuthorizationId: ids.commandAuthorizationId,
  commandAuthorizationDigest: hex("c"),
  offset: 0,
  length: 5
});

const eventRequest = {
  workspaceId: ids.workspaceId,
  runId: ids.runId,
  environmentId: ids.environmentId,
  commandId: ids.commandId,
  environmentAuthorizationId: ids.environmentAuthorizationId,
  environmentAuthorizationDigest: hex("b"),
  commandAuthorizationId: ids.commandAuthorizationId,
  commandAuthorizationDigest: hex("c"),
  after: 0
} as const;

const makeProvider = (stream?: () => AsyncIterable<RunnerSubscriptionItem>) => {
  const calls: string[] = [];
  const provider = createLocalRunnerProviderForTesting({
    now: () => "2026-08-21T12:00:00.000Z",
    limits: {
      eventBytes: 65_536,
      replayBytes: 1_048_576,
      transcriptBytes: 2_097_152,
      artifactBytes: 4_194_304
    },
    inspector: {
      async inspectRepository() {
        throw new Error("unused");
      }
    },
    worktrees: {
      async prepareEnvironment() {
        throw new Error("unused");
      },
      async listEnvironments(): Promise<readonly PreparedEnvironment[]> {
        return [];
      },
      async disposeEnvironment() {
        throw new Error("unused");
      },
      async resumePendingDisposals() {
        calls.push("worktrees.resume");
      },
      async close() {
        calls.push("worktrees.close");
      }
    },
    executor: {
      async startCommand() {
        throw new Error("unused");
      },
      readCommandEvents(): AsyncIterable<RunnerSubscriptionItem> {
        if (stream === undefined) throw new Error("unused");
        return stream();
      },
      async cancelCommand() {
        throw new Error("unused");
      },
      async resolveOwnedArtifact() {
        calls.push("executor.authorize-artifact");
        return artifact;
      },
      async terminalizeProtocolFailure(request, reason) {
        calls.push(`executor.terminalize:${reason}`);
        return { commandId: request.commandId, replayed: false };
      },
      async quiesce() {
        calls.push("executor.quiesce");
      },
      async interruptAndDrain() {
        calls.push("executor.drain");
        return {
          interruptedCommandIds: [],
          releasedGuardianLeaseCount: 0,
          remainingGuardianLeaseCount: 0 as const
        };
      },
      async close() {
        calls.push("executor.close");
      }
    },
    artifacts: {
      async readArtifact() {
        calls.push("artifacts.read");
        return {
          descriptor: artifact,
          offset: 0,
          bytes: Buffer.from("hello"),
          nextOffset: 5,
          done: true
        };
      }
    }
  });
  return { provider, calls };
};

describe("LocalRunnerProvider", () => {
  it("reports only the local host-user capabilities actually enforced", async () => {
    const { provider } = makeProvider();
    expect(RunnerCapabilitiesSchema.parse(await provider.capabilities())).toEqual({
      runnerId: "autostack-local",
      version: "0.1.0",
      platform: { os: "darwin", architecture: "arm64" },
      pty: true,
      cancellation: true,
      filesystemDisclosure: "host_user",
      maximumBytes: {
        liveOutput: 65_536,
        replay: 1_048_576,
        transcript: 2_097_152,
        artifact: 4_194_304
      },
      supportedNetworkPolicies: ["host"],
      enforcement: {
        cpu: "advisory",
        memory: "advisory",
        duration: "hard",
        autostackPathOperations: "hard",
        childFilesystem: "advisory",
        network: "unavailable"
      }
    });
  });

  it("authenticates an artifact receipt before reading and emits canonical base64", async () => {
    const { provider, calls } = makeProvider();
    await expect(provider.readArtifactChunk(artifactRequest)).resolves.toEqual({
      artifact,
      offset: 0,
      bytes: "aGVsbG8=",
      nextOffset: 5,
      done: true
    });
    expect(calls).toEqual(["executor.authorize-artifact", "artifacts.read"]);
  });

  it("runs lifecycle phases monotonically and closes commands before the root lock", async () => {
    const { provider, calls } = makeProvider();
    await Promise.all([provider.quiesce(), provider.quiesce()]);
    await provider.interruptAndDrain();
    await Promise.all([provider.close(), provider.close()]);
    expect(calls).toEqual([
      "executor.quiesce",
      "executor.drain",
      "executor.close",
      "worktrees.close"
    ]);
    await expect(provider.capabilities()).rejects.toMatchObject({ code: "closed" });
  });

  it("exposes only the two host-control operations", async () => {
    const { provider, calls } = makeProvider();
    const control = localRunnerHostControl(provider);
    expect(Object.keys(control).sort()).toEqual([
      "prepareEnvironmentWithReplay",
      "terminalizeProtocolFailure"
    ]);
    await control.terminalizeProtocolFailure(
      {
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        commandId: ids.commandId,
        environmentAuthorizationId: ids.environmentAuthorizationId,
        environmentAuthorizationDigest: hex("b"),
        commandAuthorizationId: ids.commandAuthorizationId,
        commandAuthorizationDigest: hex("c"),
        after: 0
      },
      "output_quarantined"
    );
    expect(calls).toContain("executor.terminalize:output_quarantined");
  });

  it("rematerializes stable frozen errors without caller provenance", () => {
    const error = new LocalRunnerProviderError("attacker" as never, new Error("secret"));
    expect(error).toMatchObject({ name: "LocalRunnerProviderError", code: "unsafe_state" });
    expect(error.message).not.toContain("secret");
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("preserves missing credentials and stale authorization without misclassifying capacity", () => {
    expect(
      rematerializeProviderError(new CommandExecutorError("missing_credential"))
    ).toMatchObject({ code: "missing_credential" });
    expect(
      rematerializeProviderError(new CommandExecutorError("authorization_stale"))
    ).toMatchObject({ code: "authorization_stale" });
    expect(
      rematerializeProviderError(new CommandExecutorError("execution_unavailable"))
    ).toMatchObject({ code: "unsafe_state" });
  });

  it("rematerializes every stream iterator failure without leaking executor errors", async () => {
    const executorErrors = {
      next: new CommandExecutorError("command_not_found"),
      return: new CommandExecutorError("closed"),
      throw: new CommandExecutorError("maintenance_required")
    };
    const { provider } = makeProvider(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw executorErrors.next;
          },
          async return() {
            throw executorErrors.return;
          },
          async throw() {
            throw executorErrors.throw;
          }
        };
      }
    }));
    const iterator = provider.readCommandEvents(eventRequest)[Symbol.asyncIterator]();
    for (const [operation, code] of [
      [() => iterator.next(), "command_not_found"],
      [() => iterator.return!(undefined), "closed"],
      [() => iterator.throw!(new Error("caller")), "maintenance_required"]
    ] as const) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LocalRunnerProviderError);
      expect(error).toMatchObject({ code });
      expect(Object.values(executorErrors)).not.toContain(error);
    }
  });

  it("keeps testing construction out of the exact production export surface", () => {
    expect(Object.getOwnPropertyNames(productionExports.LocalRunnerProvider).sort()).toEqual([
      "create",
      "length",
      "name",
      "prototype"
    ]);
    expect(
      Object.keys(productionExports)
        .filter((key) => key.startsWith("LocalRunner") || key === "localRunnerHostControl")
        .sort()
    ).toEqual(["LocalRunnerProvider", "LocalRunnerProviderError", "localRunnerHostControl"]);
    expect("createLocalRunnerProviderForTesting" in productionExports).toBe(false);
  });
});
