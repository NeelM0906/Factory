import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CommandAuthorizationSchema,
  EnvironmentAuthorizationSchema,
  createId,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  digestVersionedValue,
  type RunnerStreamEvent,
  type StartCommandRequest
} from "@autostack/contracts";

import { ArtifactStore, type ArtifactWriteBoundary } from "../src/artifact-store.js";
import { admitArtifactStoreRecoveryRoot } from "../src/artifact-mutation-authority.js";
import type { ProcessTreeExitProof as PublicProcessTreeExitProof } from "../src/index.js";
import { CommandGuardian } from "../src/command-guardian.js";
import { admitBoundPtySpawnResult } from "../src/command-guardian-capability.js";
import { inspectCommandGuardianChildRuntime } from "../src/command-guardian-child-control.js";
import { CommandGuardianHostProtocolAdapter } from "../src/command-guardian-protocol.js";
import { CommandGuardianProtocolRuntime } from "../src/command-guardian-child-runtime.js";
import { admitRecoveryPublications } from "../src/command-recovery-admission.js";
import { CommandRegistry } from "../src/command-registry.js";
import { digestSpawnEnvelope } from "../src/command-spawn-envelope.js";
import { snapshotGuardianBootstrap } from "../src/command-spawn-envelope.js";
import { splitEventText } from "../src/command-guardian-output.js";
import { proveProcessTreeExit, terminateProcessTree } from "../src/command-guardian-process.js";
import { acquireCommandGuardianLease } from "../src/data-root-lock.js";
import { DataPathPolicy } from "../src/path-policy.js";
import {
  MAXIMUM_GUARDIAN_INPUT_BYTES,
  sealGuardianEnvelope,
  verifyGuardianEnvelope
} from "../src/pty.js";
import {
  ReplaySpool,
  type DurableRunnerFrame,
  type ReplaySpoolPublicationStage
} from "../src/replay-spool.js";
import {
  FakeAuthenticatedGuardianLauncher,
  FakeProcessTreeController,
  FakePtyFactory
} from "./fixtures/fake-pty.js";

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-command-guardian-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ids = {
  commandId: createId("command", "10000000-0000-4000-8000-000000000001"),
  workspaceId: createId("workspace", "10000000-0000-4000-8000-000000000002"),
  runId: createId("run", "10000000-0000-4000-8000-000000000003"),
  environmentId: createId("environment", "10000000-0000-4000-8000-000000000004"),
  artifactId: createId("artifact", "10000000-0000-4000-8000-000000000005"),
  environmentAuthorizationId: createId(
    "environmentAuthorization",
    "10000000-0000-4000-8000-000000000006"
  ),
  commandAuthorizationId: createId("commandAuthorization", "10000000-0000-4000-8000-000000000007"),
  credentialRefId: createId("credentialRef", "10000000-0000-4000-8000-000000000008"),
  approvalId: createId("approval", "10000000-0000-4000-8000-000000000009")
};

const hex64 = (character: string): string => character.repeat(64);
const digestText = (value: string): string => createHash("sha256").update(value).digest("hex");
const cancelControl = Object.freeze({
  type: "host.cancel" as const,
  reason: "user" as const,
  requestDigest: hex64("c"),
  decidedAt: "2026-08-21T12:00:04.000Z"
});

const invalidAuthenticatedHostPayloads: readonly unknown[] = [
  { type: "host.input", value: 42 },
  { type: "host.resize", columns: "120", rows: 40 },
  { type: "host.cancel", reason: "operator" },
  { type: "host.protocol_failure", reason: "suspect-output" },
  { type: "host.interrupt", detail: "untrusted" },
  { type: "host.event_ack", sequence: 0 },
  { type: "host.unknown" }
];

const createGuardianRequest = async (sensitiveValues: readonly string[], timeoutSeconds = 10) => {
  const environment = sensitiveValues.map((_value, index) => ({
    kind: "credential_ref" as const,
    name: `TEST_SECRET_${index}`,
    credentialRefId: ids.credentialRefId
  }));
  const command = {
    executable: "tool",
    args: ["one", "two"],
    cwd: ".",
    environment,
    timeoutSeconds,
    terminal: { columns: 100, rows: 30 }
  };
  const environmentScope = {
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    environmentId: ids.environmentId,
    repositoryIdentity: `local-sha256:${hex64("a")}`,
    sourceCommit: "b".repeat(40),
    branch: "autostack/run-feature",
    cwdRoot: ".",
    resourceLimits: { cpu: 2, memoryMb: 1_024, durationSeconds: 60 },
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    allowedCredentialRefIds: sensitiveValues.length === 0 ? [] : [ids.credentialRefId]
  };
  const environmentAuthorizationBase = {
    id: ids.environmentAuthorizationId,
    approvalId: ids.approvalId,
    approvalEvidenceDigest: await digestExecutionScope(environmentScope),
    scope: environmentScope,
    createdAt: "2026-08-21T11:00:00.000Z",
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  const environmentAuthorization = EnvironmentAuthorizationSchema.parse({
    ...environmentAuthorizationBase,
    digest: await digestEnvironmentAuthorization({
      ...environmentAuthorizationBase,
      digest: hex64("0")
    })
  });
  const scope = {
    environmentAuthorizationId: ids.environmentAuthorizationId,
    environmentAuthorizationDigest: environmentAuthorization.digest,
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    environmentId: ids.environmentId,
    commandId: ids.commandId,
    action: "implement" as const,
    commandDigest: await digestCommandSpec(command),
    repositoryIdentity: `local-sha256:${hex64("a")}`,
    sourceCommit: "b".repeat(40),
    branch: "autostack/run-feature",
    cwdRoot: ".",
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    resourceLimits: { cpu: 2, memoryMb: 1_024, durationSeconds: 30 },
    allowedCredentialRefIds: sensitiveValues.length === 0 ? [] : [ids.credentialRefId]
  };
  const authorizationBase = {
    id: ids.commandAuthorizationId,
    approvalId: ids.approvalId,
    approvalEvidenceDigest: await digestCommandScope(scope),
    scope,
    createdAt: "2026-08-21T11:00:00.000Z",
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  const authorization = CommandAuthorizationSchema.parse({
    ...authorizationBase,
    digest: await digestCommandAuthorization({ ...authorizationBase, digest: hex64("0") })
  });
  const request: StartCommandRequest = {
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    environmentId: ids.environmentId,
    commandId: ids.commandId,
    command,
    environmentAuthorizationId: ids.environmentAuthorizationId,
    environmentAuthorizationDigest: environmentAuthorization.digest,
    authorization,
    idempotency: { key: "guardian-command" }
  };
  return Object.freeze({ request, environmentAuthorization });
};

const createGuardianFixture = async (
  sensitiveValues: readonly string[] = [],
  configure?: (fixture: {
    readonly pty: FakePtyFactory;
    readonly processTree: FakeProcessTreeController;
  }) => void,
  runtime: Readonly<{
    timeoutMs?: number;
    eofSettleMs?: number;
    transcriptBytes?: number;
    authenticated?: boolean;
    envelopeArgs?: readonly string[];
    identityValid?: boolean | (() => boolean);
    onPhase?: (phase: string) => Promise<void> | void;
    onFrame?: (frame: DurableRunnerFrame) => Promise<void> | void;
    hostEnqueueDelayMs?: number;
    cancellationGraceMs?: number;
    onGuardianPayload?: (payload: unknown) => void;
    acknowledgeFramesReentrantly?: boolean;
    monotonicNowMs?: () => number;
    failRunningPublication?: () => Promise<void>;
    failRejectedRunningAt?: ReplaySpoolPublicationStage;
    onSpoolPublication?: (
      relativePath: string,
      stage: ReplaySpoolPublicationStage
    ) => Promise<void> | void;
    onArtifactBoundary?: (boundary: ArtifactWriteBoundary) => Promise<void> | void;
  }> = {}
) => {
  const dataRoot = await makeRoot();
  const { request, environmentAuthorization } = await createGuardianRequest(
    sensitiveValues,
    runtime.timeoutMs === undefined ? 10 : runtime.timeoutMs / 1_000
  );
  const boundEnvelope = {
    executable: "/usr/bin/tool",
    args: ["one", "two"],
    cwd: "/private/worktree",
    environment: [
      { name: "PATH", value: "/usr/bin:/bin" },
      ...sensitiveValues.map((value, index) => ({ name: `TEST_SECRET_${index}`, value }))
    ],
    terminal: { columns: 100, rows: 30 }
  } as const;
  const registered = await ReplaySpool.register({
    dataRoot,
    ...(runtime.failRunningPublication === undefined &&
    runtime.failRejectedRunningAt === undefined &&
    runtime.onSpoolPublication === undefined
      ? {}
      : {
          publicationHook: async (relativePath: string, stage: ReplaySpoolPublicationStage) => {
            await runtime.onSpoolPublication?.(relativePath, stage);
            if (relativePath.endsWith("/04-running.json") && stage === "temp-created") {
              await runtime.failRunningPublication?.();
            }
            if (
              relativePath.endsWith("/04-running.json") &&
              stage === runtime.failRejectedRunningAt
            ) {
              throw new Error(`rejected running publication failed at ${stage}`);
            }
          }
        }),
    intent: {
      commandId: ids.commandId,
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      environmentAuthorizationId: ids.environmentAuthorizationId,
      commandAuthorizationId: ids.commandAuthorizationId,
      request,
      requestDigest: await digestVersionedValue("autostack.start-command-request", request),
      environmentIntentDigest: hex64("2"),
      environmentAuthorizationDigest: environmentAuthorization.digest,
      environmentAuthorization,
      commandAuthorizationDigest: request.authorization.digest,
      acceptedAt: "2026-08-21T12:00:00.000Z",
      executablePath: "/usr/bin/tool",
      executableIdentityDigest: hex64("5"),
      cwdRelativePath: ".",
      cwdIdentityDigest: hex64("6"),
      spawnEnvelopeDigest: digestSpawnEnvelope({
        request,
        envelope: boundEnvelope,
        executableIdentityDigest: hex64("5"),
        cwdIdentityDigest: hex64("6"),
        sensitiveValues
      }),
      transcriptArtifactId: ids.artifactId,
      artifactCreatedAt: "2026-08-21T12:00:00.000Z",
      guardianSessionBindingDigest: hex64("7"),
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: runtime.transcriptBytes ?? 1_048_576,
        cancellationGraceMs: runtime.cancellationGraceMs ?? 1,
        eofSettleMs: runtime.eofSettleMs ?? 1
      }
    }
  });
  const pty = new FakePtyFactory();
  const processTree = new FakeProcessTreeController();
  pty.processTreeAuthority = processTree;
  pty.identityDecision = runtime.identityValid ?? true;
  configure?.({ pty, processTree });
  const artifactStore = await ArtifactStore.create({
    dataRoot,
    ...(runtime.onArtifactBoundary === undefined ? {} : { onBoundary: runtime.onArtifactBoundary })
  });
  const events: RunnerStreamEvent[] = [];
  let instant = 1;
  const clockOrigin = Date.parse("2026-08-21T12:00:00.000Z");
  const guardianOptions = {
    dataRoot,
    spool: registered.spool,
    artifactStore,
    spawnAuthority: pty,
    envelope: {
      ...boundEnvelope,
      args: [...(runtime.envelopeArgs ?? boundEnvelope.args)]
    },
    sensitiveValues,
    timeoutMs: runtime.timeoutMs ?? 10_000,
    cancellationGraceMs: runtime.cancellationGraceMs ?? 1,
    eofSettleMs: runtime.eofSettleMs ?? 1,
    now: () => new Date(clockOrigin + instant++ * 1_000).toISOString(),
    monotonicNowMs:
      runtime.monotonicNowMs ??
      (() => {
        let now = 100;
        return () => now++;
      })(),
    observer: {
      onDurableFrame(frame: DurableRunnerFrame) {
        events.push(frame.event);
        return runtime.onFrame?.(frame);
      },
      onDurablePhase(phase: string) {
        return runtime.onPhase?.(phase);
      }
    }
  } as const;
  let authenticatedLauncher: FakeAuthenticatedGuardianLauncher | undefined;
  const session = runtime.authenticated
    ? await (authenticatedLauncher = new FakeAuthenticatedGuardianLauncher({
        artifactStore,
        spawnAuthority: pty,
        now: guardianOptions.now,
        monotonicNowMs: guardianOptions.monotonicNowMs,
        ...(runtime.hostEnqueueDelayMs === undefined
          ? {}
          : { hostEnqueueDelayMs: runtime.hostEnqueueDelayMs }),
        ...(runtime.onGuardianPayload === undefined
          ? {}
          : { onGuardianPayload: runtime.onGuardianPayload }),
        ...(runtime.acknowledgeFramesReentrantly === undefined
          ? {}
          : { acknowledgeFramesReentrantly: runtime.acknowledgeFramesReentrantly })
      })).launch(
        {
          dataRoot,
          commandId: ids.commandId,
          intentRelativePath: registered.intentRelativePath,
          envelope: guardianOptions.envelope,
          sensitiveValues,
          timeoutMs: guardianOptions.timeoutMs,
          cancellationGraceMs: guardianOptions.cancellationGraceMs,
          eofSettleMs: guardianOptions.eofSettleMs,
          executableIdentityDigest: hex64("5"),
          cwdIdentityDigest: hex64("6"),
          session: {
            sessionId: "authenticated-guardian",
            secret: Uint8Array.from({ length: 32 }, () => 7),
            bindingDigest: hex64("7")
          }
        },
        guardianOptions.observer
      )
    : await CommandGuardian.launch(guardianOptions);
  return {
    dataRoot,
    registered,
    pty,
    processTree,
    artifactStore,
    events,
    session,
    authenticatedLauncher
  };
};

const createHostBootstrap = (dataRoot: string, sessionId: string) => ({
  dataRoot,
  commandId: ids.commandId,
  intentRelativePath: `commands/${Buffer.from(ids.commandId).toString("hex")}/receipt/01-intent.json`,
  envelope: {
    executable: "/usr/bin/tool",
    args: [] as string[],
    cwd: "/private/worktree",
    environment: [] as const,
    terminal: { columns: 100, rows: 30 }
  },
  sensitiveValues: [] as const,
  timeoutMs: 1_000,
  cancellationGraceMs: 10,
  eofSettleMs: 10,
  executableIdentityDigest: hex64("5"),
  cwdIdentityDigest: hex64("6"),
  session: {
    sessionId,
    secret: Uint8Array.from({ length: 32 }, () => 7),
    bindingDigest: hex64("7")
  }
});

const sealGuardianForHost = (
  bootstrap: ReturnType<typeof createHostBootstrap>,
  sequence: number,
  payload: unknown
) =>
  sealGuardianEnvelope({
    sessionId: bootstrap.session.sessionId,
    secret: bootstrap.session.secret,
    direction: "guardian_to_host" as const,
    sequence,
    payload
  });

const createUntransferredChild = async (
  send: (payload: unknown, signal: AbortSignal) => Promise<void> | void
) => {
  const dataRoot = await makeRoot();
  const { request, environmentAuthorization } = await createGuardianRequest([]);
  const envelope = {
    executable: "/usr/bin/tool",
    args: ["one", "two"],
    cwd: "/private/worktree",
    environment: [{ name: "PATH", value: "/usr/bin:/bin" }],
    terminal: { columns: 100, rows: 30 }
  } as const;
  const registered = await ReplaySpool.register({
    dataRoot,
    intent: {
      commandId: ids.commandId,
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      environmentAuthorizationId: ids.environmentAuthorizationId,
      commandAuthorizationId: ids.commandAuthorizationId,
      request,
      requestDigest: await digestVersionedValue("autostack.start-command-request", request),
      environmentIntentDigest: hex64("2"),
      environmentAuthorizationDigest: environmentAuthorization.digest,
      environmentAuthorization,
      commandAuthorizationDigest: request.authorization.digest,
      acceptedAt: "2026-08-21T12:00:00.000Z",
      executablePath: "/usr/bin/tool",
      executableIdentityDigest: hex64("5"),
      cwdRelativePath: ".",
      cwdIdentityDigest: hex64("6"),
      spawnEnvelopeDigest: digestSpawnEnvelope({
        request,
        envelope,
        executableIdentityDigest: hex64("5"),
        cwdIdentityDigest: hex64("6"),
        sensitiveValues: []
      }),
      transcriptArtifactId: ids.artifactId,
      artifactCreatedAt: "2026-08-21T12:00:00.000Z",
      guardianSessionBindingDigest: hex64("7"),
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        cancellationGraceMs: 10,
        eofSettleMs: 10
      }
    }
  });
  const artifactStore = await ArtifactStore.create({ dataRoot });
  const pty = new FakePtyFactory();
  pty.processTreeAuthority = new FakeProcessTreeController();
  const bootstrap = {
    dataRoot,
    commandId: ids.commandId,
    intentRelativePath: registered.intentRelativePath,
    envelope,
    sensitiveValues: [],
    timeoutMs: 1_000,
    cancellationGraceMs: 10,
    eofSettleMs: 10,
    executableIdentityDigest: hex64("5"),
    cwdIdentityDigest: hex64("6"),
    session: {
      sessionId: "untransferred-child",
      secret: Uint8Array.from({ length: 32 }, () => 7),
      bindingDigest: hex64("7")
    }
  } as const;
  const runtime = await CommandGuardianProtocolRuntime.bootstrap({
    bootstrap,
    artifactStore,
    spawnAuthority: pty,
    now: () => "2026-08-21T12:00:01.000Z",
    monotonicNowMs: () => 100,
    createNonce: () => Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
    send: async (message, signal) => await send(message.payload, signal)
  });
  return { runtime, registered };
};

describe("CommandGuardian", () => {
  it.each([
    {
      name: "session",
      member: { write: null, resize() {} }
    },
    {
      name: "capture",
      member: { dispose: null }
    },
    {
      name: "extra accessor",
      member: undefined
    }
  ])(
    "retains process authority when the spawned $name member is malformed",
    async ({ name, member }) => {
      const processTree = new FakeProcessTreeController();
      let accessorReads = 0;
      const candidate = {
        status: "spawned",
        session: name === "session" ? member : { write() {}, resize() {} },
        processTree,
        capture: name === "capture" ? member : { dispose() {} }
      } as Record<string, unknown>;
      if (name === "extra accessor") {
        Object.defineProperty(candidate, "unexpected", {
          enumerable: true,
          get() {
            accessorReads += 1;
            throw new Error("unexpected spawned member getter reached");
          }
        });
      }
      const admitted = admitBoundPtySpawnResult(candidate);

      expect(admitted.status).toBe("uncertain");
      if (admitted.status !== "uncertain") throw new TypeError("expected uncertain authority");
      await admitted.processTree.signal("SIGTERM", new AbortController().signal);
      await expect(
        admitted.processTree.waitForExit(new AbortController().signal)
      ).resolves.toMatchObject({ processTreeTerminated: true });
      expect(processTree.calls.map((call) => call.type)).toEqual(["signal", "wait"]);
      expect(accessorReads).toBe(0);
    }
  );

  it("supervises a live process from a malformed spawned composite before releasing its lease", async () => {
    const fixture = await createGuardianFixture([], ({ pty }) => {
      const spawnBound = pty.spawnBound;
      pty.spawnBound = (input) => {
        const spawned = Reflect.apply(spawnBound, pty, [input]);
        if (spawned.status !== "spawned") return spawned;
        return {
          ...spawned,
          session: { write: null, resize() {} }
        } as never;
      };
    });

    await expect(fixture.session.closed).rejects.toMatchObject({ code: "unsafe_state" });
    await vi.waitFor(() => {
      expect(fixture.processTree.calls.map((call) => call.type)).toEqual(["signal", "wait"]);
    });
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.phases.map((phase) => phase.phase)).toEqual([
      "intent",
      "lease_transferred",
      "spawned"
    ]);
    expect(recovered.events).toEqual([]);
    const replacement = await acquireCommandGuardianLease(fixture.dataRoot, ids.commandId);
    replacement.close();
  });

  it("drops child bootstrap, environment, secret, redactor, and guardian references on settlement", async () => {
    const fixture = await createGuardianFixture(["child-secret"], undefined, {
      authenticated: true
    });
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await fixture.session.closed;
    await fixture.authenticatedLauncher!.waitForChildForTesting();

    expect(
      inspectCommandGuardianChildRuntime(fixture.authenticatedLauncher!.childRuntimeForTesting())
    ).toEqual({ transientCleared: true, guardianCleared: true });
  });

  it("rejects truthy non-proof process-tree exit results", async () => {
    const authority = Object.freeze({
      identityDigest: hex64("a"),
      async signal() {},
      async waitForExit() {
        return "yes";
      }
    });

    await expect(proveProcessTreeExit(authority as never, [])).resolves.toEqual({
      completed: false
    });
  });

  it("admits exact actual exit evidence independently of the requested cleanup signal", async () => {
    const requested: string[] = [];
    const authority = Object.freeze({
      identityDigest: hex64("a"),
      async signal(signal: string) {
        requested.push(signal);
      },
      async waitForExit() {
        return Object.freeze({
          identityDigest: hex64("a"),
          processTreeTerminated: true,
          exit: Object.freeze({ exitCode: null, signal: "SIGBUS" })
        });
      }
    });

    await expect(terminateProcessTree(authority as never, "SIGTERM", [])).resolves.toEqual({
      terminated: true,
      exit: { exitCode: null, signal: "SIGBUS" },
      proof: {
        identityDigest: hex64("a"),
        processTreeTerminated: true,
        exit: { exitCode: null, signal: "SIGBUS" }
      }
    });
    expect(requested).toEqual(["SIGTERM"]);
  });

  it("rejects proxy-backed process-tree proof without triggering traps", async () => {
    let traps = 0;
    const authority = Object.freeze({
      identityDigest: hex64("a"),
      async signal() {},
      async waitForExit() {
        return new Proxy(
          {
            identityDigest: hex64("a"),
            processTreeTerminated: true,
            exit: { exitCode: 0, signal: null }
          },
          {
            get(target, property, receiver) {
              if (property !== "then") traps += 1;
              return Reflect.get(target, property, receiver);
            }
          }
        );
      }
    });

    await expect(proveProcessTreeExit(authority as never, [])).resolves.toEqual({
      completed: false
    });
    expect(traps).toBe(0);
  });

  it("rejects a process-tree proof rebound to another immutable capability", async () => {
    const authority = Object.freeze({
      identityDigest: hex64("a"),
      async signal() {},
      async waitForExit() {
        return Object.freeze({
          identityDigest: hex64("b"),
          processTreeTerminated: true,
          exit: Object.freeze({ exitCode: 0, signal: null })
        });
      }
    });

    await expect(proveProcessTreeExit(authority as never, [])).resolves.toEqual({
      completed: false
    });
  });

  it("rejects process proof containing an exact configured sensitive value", async () => {
    const authority = Object.freeze({
      identityDigest: hex64("a"),
      async signal() {},
      async waitForExit() {
        return Object.freeze({
          identityDigest: hex64("a"),
          processTreeTerminated: true,
          exit: Object.freeze({ exitCode: null, signal: "SIGTERM" })
        });
      }
    });

    await expect(proveProcessTreeExit(authority as never, ["SIGTERM"])).resolves.toEqual({
      completed: false
    });
  });

  it("keeps the public process-tree exit proof contract available to Task 9", () => {
    const proof: PublicProcessTreeExitProof = Object.freeze({
      identityDigest: hex64("a"),
      processTreeTerminated: true,
      exit: Object.freeze({ exitCode: null, signal: "SIGBUS" })
    });

    expect(proof.exit.signal).toBe("SIGBUS");
  });

  it("exposes only the intentional guardian child runtime surface", async () => {
    const childRuntime = await import("@autostack/runner-local/guardian-child");

    expect(Object.keys(childRuntime)).toEqual([
      "CommandGuardianHostProtocolAdapter",
      "CommandGuardianProtocolRuntime"
    ]);
    expect(childRuntime.CommandGuardianProtocolRuntime).toBe(CommandGuardianProtocolRuntime);
  });

  it("authenticates direction-bound monotonically sequenced guardian messages", () => {
    const secret = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
    const envelope = sealGuardianEnvelope({
      sessionId: "guardian-session",
      secret,
      direction: "host_to_guardian",
      sequence: 1,
      payload: { type: "host.resize", columns: 100, rows: 30 }
    });

    expect(
      verifyGuardianEnvelope({
        envelope,
        secret,
        sessionId: "guardian-session",
        direction: "host_to_guardian",
        expectedSequence: 1
      })
    ).toEqual({ type: "host.resize", columns: 100, rows: 30 });
    for (const changed of [
      { direction: "guardian_to_host" as const, expectedSequence: 1 },
      { direction: "host_to_guardian" as const, expectedSequence: 2 }
    ]) {
      expect(() =>
        verifyGuardianEnvelope({
          envelope,
          secret,
          sessionId: "guardian-session",
          ...changed
        })
      ).toThrow("Guardian authentication failed.");
    }
    expect(() =>
      verifyGuardianEnvelope({
        envelope: { ...envelope, hmac: "0".repeat(64) },
        secret,
        sessionId: "guardian-session",
        direction: "host_to_guardian",
        expectedSequence: 1
      })
    ).toThrow("Guardian authentication failed.");
    expect(() =>
      verifyGuardianEnvelope({
        envelope: { ...envelope, unexpected: true } as typeof envelope,
        secret,
        sessionId: "guardian-session",
        direction: "host_to_guardian",
        expectedSequence: 1
      })
    ).toThrow("Guardian authentication failed.");
    expect(() =>
      sealGuardianEnvelope({
        sessionId: "guardian-session",
        secret,
        direction: "host_to_guardian",
        sequence: 2,
        payload: Object.defineProperty({}, "value", {
          enumerable: true,
          get() {
            throw new Error("attacker-controlled detail");
          }
        })
      })
    ).toThrow("Invalid guardian envelope input.");
    for (const invalid of [
      { sessionId: "", secret, direction: "host_to_guardian" as const, sequence: 1, payload: {} },
      {
        sessionId: "guardian-session",
        secret: secret.subarray(0, 31),
        direction: "host_to_guardian" as const,
        sequence: 1,
        payload: {}
      },
      {
        sessionId: "guardian-session",
        secret,
        direction: "host_to_guardian" as const,
        sequence: 0,
        payload: {}
      },
      {
        sessionId: "guardian-session",
        secret,
        direction: "host_to_guardian" as const,
        sequence: 2,
        payload: { value: "x".repeat(65_537) }
      }
    ]) {
      expect(() => sealGuardianEnvelope<unknown>(invalid)).toThrow(
        "Invalid guardian envelope input."
      );
    }
    for (const changed of [
      { envelope: { ...envelope, version: 2 as never }, secret },
      { envelope: { ...envelope, sessionId: "different-session" }, secret },
      { envelope: { ...envelope, payloadDigest: "bad" }, secret },
      { envelope: { ...envelope, payload: { changed: true } }, secret },
      { envelope, secret: secret.subarray(0, 31) }
    ]) {
      expect(() =>
        verifyGuardianEnvelope<unknown>({
          ...changed,
          sessionId: "guardian-session",
          direction: "host_to_guardian",
          expectedSequence: 1
        })
      ).toThrow("Guardian authentication failed.");
    }
  });

  it("rejects pre-transfer disconnect without correlated child release proof", async () => {
    const dataRoot = await makeRoot();
    let disconnects = 0;
    const adapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap: {
        dataRoot,
        commandId: ids.commandId,
        intentRelativePath: `commands/${Buffer.from(ids.commandId).toString("hex")}/receipt/01-intent.json`,
        envelope: {
          executable: "/usr/bin/tool",
          args: [],
          cwd: "/private/worktree",
          environment: [],
          terminal: { columns: 100, rows: 30 }
        },
        sensitiveValues: [],
        timeoutMs: 1_000,
        cancellationGraceMs: 10,
        eofSettleMs: 10,
        executableIdentityDigest: hex64("5"),
        cwdIdentityDigest: hex64("6"),
        session: {
          sessionId: "pre-transfer",
          secret: Uint8Array.from({ length: 32 }, () => 7),
          bindingDigest: hex64("7")
        }
      },
      observer: { onDurableFrame() {} },
      async send() {},
      async disconnect() {
        disconnects += 1;
      }
    });

    await adapter.session.disconnect();
    await expect(adapter.session.closed).rejects.toThrow();
    expect(disconnects).toBe(1);
  });

  it("never attests lease release for an uncorrelated inbound close before transfer", async () => {
    const dataRoot = await makeRoot();
    const adapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap: {
        dataRoot,
        commandId: ids.commandId,
        intentRelativePath: `commands/${Buffer.from(ids.commandId).toString("hex")}/receipt/01-intent.json`,
        envelope: {
          executable: "/usr/bin/tool",
          args: [],
          cwd: "/private/worktree",
          environment: [],
          terminal: { columns: 100, rows: 30 }
        },
        sensitiveValues: [],
        timeoutMs: 1_000,
        cancellationGraceMs: 10,
        eofSettleMs: 10,
        executableIdentityDigest: hex64("5"),
        cwdIdentityDigest: hex64("6"),
        session: {
          sessionId: "pre-transfer-close",
          secret: Uint8Array.from({ length: 32 }, () => 7),
          bindingDigest: hex64("7")
        }
      },
      observer: { onDurableFrame() {} },
      async send() {},
      async disconnect() {}
    });

    await adapter.transportClosed();
    await expect(adapter.session.closed).rejects.toThrow("Guardian host transport closed.");
  });

  it("accepts one exactly correlated pre-transfer guardian release before settling disconnect", async () => {
    const dataRoot = await makeRoot();
    const bootstrap = createHostBootstrap(dataRoot, "correlated-release");
    let adapter!: CommandGuardianHostProtocolAdapter;
    let disconnects = 0;
    adapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap,
      observer: { onDurableFrame() {} },
      async send() {},
      async disconnect() {
        disconnects += 1;
        await adapter.receive(
          sealGuardianForHost(bootstrap, 3, {
            type: "guardian.released",
            commandId: ids.commandId,
            releasedLease: true
          }) as never
        );
      }
    });
    await adapter.receive(
      sealGuardianForHost(bootstrap, 1, {
        type: "guardian.hello",
        commandId: ids.commandId,
        bindingDigest: hex64("7"),
        nonce: hex64("8")
      }) as never
    );
    await adapter.receive(
      sealGuardianForHost(bootstrap, 2, {
        type: "guardian.lease_acquired",
        commandId: ids.commandId,
        bindingDigest: hex64("7"),
        nonceDigest: digestText(hex64("8")),
        receiptDigest: hex64("1")
      }) as never
    );

    await adapter.session.disconnect();
    await expect(adapter.session.closed).resolves.toEqual({
      commandId: ids.commandId,
      releasedLease: true
    });
    expect(disconnects).toBe(1);
  });

  it("settles child release locally even when the pre-transfer release notification fails", async () => {
    const child = await createUntransferredChild((payload) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: unknown }).type === "guardian.released"
      ) {
        throw new TypeError("transport gone");
      }
    });
    await expect(child.runtime.disconnect()).resolves.toBeUndefined();
    await expect(child.runtime.closed).resolves.toEqual({
      commandId: ids.commandId,
      releasedLease: true
    });
  });

  it("bounds outbound host input and pending sends before transport enqueue", async () => {
    const dataRoot = await makeRoot();
    const bootstrap = createHostBootstrap(dataRoot, "bounded-outbound");
    let releaseSend!: () => void;
    let sent = 0;
    const blocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const adapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap,
      observer: { onDurableFrame() {} },
      async send() {
        sent += 1;
        if (sent > 1) await blocked;
      },
      async disconnect() {}
    });
    await adapter.receive(
      sealGuardianForHost(bootstrap, 1, {
        type: "guardian.hello",
        commandId: ids.commandId,
        bindingDigest: hex64("7"),
        nonce: hex64("8")
      }) as never
    );
    await adapter.receive(
      sealGuardianForHost(bootstrap, 2, {
        type: "guardian.lease_acquired",
        commandId: ids.commandId,
        bindingDigest: hex64("7"),
        nonceDigest: digestText(hex64("8")),
        receiptDigest: hex64("1")
      }) as never
    );
    await adapter.transferLease(hex64("1"));

    await expect(
      adapter.session.send({
        type: "host.input",
        value: "x".repeat(MAXIMUM_GUARDIAN_INPUT_BYTES + 1)
      })
    ).rejects.toThrow();
    expect(sent).toBe(1);

    const pending = Array.from({ length: 80 }, () =>
      adapter.session.send({ type: "host.input", value: "bounded" }).catch(() => undefined)
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      await Promise.race([
        adapter.session.closed.then(
          () => "closed",
          () => "closed"
        ),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100))
      ])
    ).toBe("closed");
    releaseSend();
    await Promise.all(pending);
  });

  it("single-flights saturation teardown across one hundred concurrent invalid receives", async () => {
    const bootstrap = createHostBootstrap(await makeRoot(), "saturated-receives");
    let disconnects = 0;
    let releaseDisconnect!: () => void;
    const blockedDisconnect = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const adapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap,
      observer: { onDurableFrame() {} },
      async send() {},
      async disconnect() {
        disconnects += 1;
        await blockedDisconnect;
      }
    });

    const receives = Array.from({ length: 100 }, () =>
      adapter.receive(Object.freeze({}) as never).catch(() => undefined)
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(disconnects).toBe(1);
    releaseDisconnect();
    await Promise.all(receives);
    await adapter.session.closed.catch(() => undefined);
  });

  it("disconnects and settles the host on an authenticated semantic failure", async () => {
    const dataRoot = await makeRoot();
    const bootstrap = createHostBootstrap(dataRoot, "semantic-failure");
    let disconnects = 0;
    const adapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap,
      observer: { onDurableFrame() {} },
      async send() {},
      async disconnect() {
        disconnects += 1;
      }
    });
    await expect(
      adapter.receive(
        sealGuardianForHost(bootstrap, 1, {
          type: "guardian.hello",
          commandId: ids.commandId,
          bindingDigest: "wrong",
          nonce: hex64("8")
        }) as never
      )
    ).rejects.toThrow();
    await expect(adapter.session.closed).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(disconnects).toBe(1);
  });

  it("drains reserved controls contiguously before authenticated protocol-failure teardown", async () => {
    const bootstrap = createHostBootstrap(await makeRoot(), "ordered-protocol-failure");
    const sent: unknown[] = [];
    let disconnects = 0;
    let releaseInput!: () => void;
    const inputBlocked = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    const adapter = CommandGuardianHostProtocolAdapter.create({
      bootstrap,
      observer: { onDurableFrame() {} },
      async send(envelope) {
        sent.push(envelope);
        const sequence = (envelope as { readonly sequence: number }).sequence;
        if (sequence === 2) await inputBlocked;
      },
      async disconnect() {
        disconnects += 1;
      }
    });
    await adapter.receive(
      sealGuardianForHost(bootstrap, 1, {
        type: "guardian.hello",
        commandId: ids.commandId,
        bindingDigest: hex64("7"),
        nonce: hex64("8")
      }) as never
    );
    await adapter.receive(
      sealGuardianForHost(bootstrap, 2, {
        type: "guardian.lease_acquired",
        commandId: ids.commandId,
        bindingDigest: hex64("7"),
        nonceDigest: digestText(hex64("8")),
        receiptDigest: hex64("1")
      }) as never
    );
    await adapter.transferLease(hex64("1"));

    const input = adapter.session.send({ type: "host.input", value: "first" });
    const resize = adapter.session.send({ type: "host.resize", columns: 120, rows: 40 });
    const duplicateHello = adapter.receive(
      sealGuardianForHost(bootstrap, 3, {
        type: "guardian.hello",
        commandId: ids.commandId,
        bindingDigest: hex64("7"),
        nonce: hex64("9")
      }) as never
    );
    await expect(duplicateHello).rejects.toThrow("Guardian host protocol failed.");
    releaseInput();
    await Promise.allSettled([input, resize]);
    await expect(adapter.session.closed).rejects.toThrow("Guardian host protocol failed.");

    expect(disconnects).toBe(1);
    const decoded = sent.map((envelope, index) =>
      verifyGuardianEnvelope({
        envelope: envelope as never,
        secret: bootstrap.session.secret,
        sessionId: bootstrap.session.sessionId,
        direction: "host_to_guardian",
        expectedSequence: index + 1
      })
    );
    expect(decoded).toEqual([
      { type: "host.lease_transfer", bindingDigest: hex64("7"), receiptDigest: hex64("1") },
      { type: "host.input", value: "first" },
      { type: "host.resize", columns: 120, rows: 40 },
      { type: "host.protocol_failure", reason: "protocol_failure" }
    ]);
  });

  it("spawns one exact shell-free envelope after durable launch evidence", async () => {
    let spawnAuthorizationObserved = false;
    let authorizationWasDurableAtSpawn = false;
    const fixture = await createGuardianFixture(
      [],
      ({ pty }) => {
        pty.identityDecision = () => {
          authorizationWasDurableAtSpawn = spawnAuthorizationObserved;
          return true;
        };
      },
      {
        onPhase(phase) {
          if (phase === "spawned") spawnAuthorizationObserved = true;
        }
      }
    );

    expect(fixture.pty.spawnRequests).toEqual([
      {
        executable: "/usr/bin/tool",
        args: ["one", "two"],
        cwd: "/private/worktree",
        environment: [{ name: "PATH", value: "/usr/bin:/bin" }],
        terminal: { columns: 100, rows: 30 }
      }
    ]);
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.phases.map((phase) => phase.phase)).toEqual([
      "intent",
      "lease_transferred",
      "spawned",
      "running"
    ]);
    expect(recovered.events[0]?.event.type).toBe("command.started");
    expect(authorizationWasDurableAtSpawn).toBe(true);

    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await fixture.session.closed;
  });

  it("normalizes a fractional monotonic duration before publishing terminal evidence", async () => {
    const readings = [100.25, 223.875];
    const fixture = await createGuardianFixture([], undefined, {
      monotonicNowMs: () => readings.shift() ?? 223.875
    });

    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await fixture.session.closed;

    expect(fixture.events.at(-1)).toMatchObject({
      type: "command.completed",
      durationMs: 123
    });
  });

  it("rejects a bootstrap envelope that is not bound to the durable request", async () => {
    let pty!: FakePtyFactory;
    await expect(
      createGuardianFixture(
        [],
        (fixture) => {
          pty = fixture.pty;
        },
        { envelopeArgs: ["tampered"] }
      )
    ).rejects.toThrow("Guardian bootstrap is invalid.");

    expect(pty.spawnRequests).toHaveLength(0);
  });

  it("rejects Proxy launch options without probing fallback lease descriptors", async () => {
    let descriptorReads = 0;
    const options = new Proxy(Object.create(null) as object, {
      getOwnPropertyDescriptor() {
        descriptorReads += 1;
        throw new Error("secret launch option descriptor detail");
      }
    });

    await expect(CommandGuardian.launch(options as never)).rejects.toThrow(
      "Guardian bootstrap is invalid."
    );
    expect(descriptorReads).toBe(0);
  });

  it("rejects a Proxy guardian secret without invoking its prototype trap", async () => {
    const dataRoot = await makeRoot();
    let prototypeReads = 0;
    const secret = new Proxy(new Uint8Array(32), {
      getPrototypeOf() {
        prototypeReads += 1;
        throw new Error("secret byte prototype detail");
      }
    });
    const bootstrap = createHostBootstrap(dataRoot, "proxy-secret");

    expect(() =>
      snapshotGuardianBootstrap({
        ...bootstrap,
        session: { ...bootstrap.session, secret }
      } as never)
    ).toThrow("Guardian bootstrap is invalid.");
    expect(prototypeReads).toBe(0);
  });

  it("revalidates executable and cwd identities in the guardian immediately before spawn", async () => {
    let pty!: FakePtyFactory;
    const fixture = await createGuardianFixture(
      [],
      (configured) => {
        pty = configured.pty;
      },
      { identityValid: false }
    );

    expect(pty.spawnRequests).toHaveLength(0);
    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
  });

  it.each<ReplaySpoolPublicationStage>([
    "temp-created",
    "file-synced",
    "temp-directory-synced",
    "canonical-linked",
    "canonical-directory-synced",
    "alias-unlinked",
    "alias-directory-synced"
  ])("releases a conclusively rejected spawn when running evidence fails at %s", async (stage) => {
    let processTree!: FakeProcessTreeController;
    const rootIndex = roots.length;
    await expect(
      createGuardianFixture(
        [],
        (configured) => {
          processTree = configured.processTree;
        },
        { identityValid: false, failRejectedRunningAt: stage }
      )
    ).rejects.toMatchObject({ code: "maintenance_required" });

    expect(processTree.calls).toEqual([]);
    const lease = await acquireCommandGuardianLease(roots[rootIndex]!, ids.commandId);
    lease.close();
  });

  it("revalidates identity after every durable pre-spawn await and before the sole spawn", async () => {
    let valid = true;
    let pty!: FakePtyFactory;
    const fixture = await createGuardianFixture(
      [],
      (configured) => {
        pty = configured.pty;
      },
      {
        identityValid: () => valid,
        onPhase(phase) {
          if (phase === "lease_transferred") valid = false;
        }
      }
    );
    expect(valid).toBe(false);
    expect(pty.spawnRequests).toHaveLength(0);
    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
  });

  it("binds cwd and executable identity inside the sole atomic spawn capability", async () => {
    const fixture = await createGuardianFixture([], ({ pty }) => {
      pty.actualExecutableIdentityDigest = hex64("9");
      pty.actualCwdIdentityDigest = hex64("6");
    });

    const spawnCount = fixture.pty.spawnRequests.length;
    if (spawnCount > 0) fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    expect(spawnCount).toBe(0);
  });

  it("captures output and exit installed before the native spawn can synchronously emit", async () => {
    let listenerCountInsideSpawn = -1;
    const fixture = await createGuardianFixture([], ({ pty }) => {
      pty.afterSpawn = (session) => {
        listenerCountInsideSpawn = session.listenerCount;
        session.emitData(Buffer.from("immediate output"));
        session.emitExit({ exitCode: 0, signal: null });
      };
    });

    if (listenerCountInsideSpawn === 0) {
      fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    }
    await fixture.session.closed;
    const recovered = await fixture.registered.spool.recover();
    expect(listenerCountInsideSpawn).toBe(3);
    expect(Buffer.concat(recovered.transcriptChunks.map((chunk) => chunk.bytes)).toString()).toBe(
      "immediate output"
    );
  });

  it("retains the initially descriptor-captured spawn method across handshake awaits", async () => {
    let originalCalls = 0;
    let swappedCalls = 0;
    let pty!: FakePtyFactory;
    const fixture = await createGuardianFixture(
      [],
      (configured) => {
        pty = configured.pty;
        const original = pty.spawnBound.bind(pty);
        Object.defineProperty(pty, "spawnBound", {
          configurable: true,
          enumerable: true,
          writable: true,
          value(input: Parameters<FakePtyFactory["spawnBound"]>[0]) {
            originalCalls += 1;
            return original(input);
          }
        });
      },
      {
        authenticated: true,
        onGuardianPayload(payload) {
          if (
            typeof payload === "object" &&
            payload !== null &&
            (payload as { type?: unknown }).type === "guardian.lease_acquired"
          ) {
            Object.defineProperty(pty, "spawnBound", {
              configurable: true,
              enumerable: true,
              writable: true,
              value() {
                swappedCalls += 1;
                return Object.freeze({ status: "rejected" as const });
              }
            });
          }
        }
      }
    );
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await fixture.session.closed;
    expect(originalCalls).toBe(1);
    expect(swappedCalls).toBe(0);
  });

  it("settles an exit captured during spawn only after durable running classification", async () => {
    let releaseStarted!: () => void;
    const startedBlocked = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const fixturePromise = createGuardianFixture(
      [],
      ({ pty }) => {
        pty.afterSpawn = (session) => session.emitExit({ exitCode: 0, signal: null });
      },
      {
        onFrame(frame) {
          return frame.event.type === "command.started" ? startedBlocked : undefined;
        }
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseStarted();
    const fixture = await fixturePromise;
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.phases.map((phase) => phase.phase)).toEqual([
      "intent",
      "lease_transferred",
      "spawned",
      "running",
      "finalizing",
      "terminal"
    ]);
    const running = recovered.phases.find((phase) => phase.phase === "running");
    expect(
      running !== undefined && "evidence" in running ? running.evidence : undefined
    ).toMatchObject({
      liveCapability: false,
      exitedBeforeRunning: true
    });
  });

  it("poisons live authority on malformed PTY exit evidence without persisting secrets", async () => {
    let signalReads = 0;
    const accessorFixture = await createGuardianFixture(["local-secret"]);
    expect(() =>
      accessorFixture.pty.session.emitRawExitForTesting(
        Object.defineProperties(Object.create(null), {
          exitCode: { enumerable: true, value: 0 },
          signal: {
            enumerable: true,
            get() {
              signalReads += 1;
              return "local-secret";
            }
          }
        }) as never
      )
    ).not.toThrow();
    await expect(accessorFixture.session.closed).rejects.toMatchObject({ code: "unsafe_state" });
    expect(signalReads).toBe(0);
    expect(JSON.stringify(await accessorFixture.registered.spool.recover())).not.toContain(
      "local-secret"
    );

    const secretFixture = await createGuardianFixture(["local-secret"]);
    secretFixture.pty.session.emitRawExitForTesting({ exitCode: null, signal: "local-secret" });
    await expect(secretFixture.session.closed).rejects.toMatchObject({ code: "unsafe_state" });
    const recovered = await secretFixture.registered.spool.recover();
    expect(JSON.stringify(recovered)).not.toContain("local-secret");
    expect(recovered.events.some((frame) => frame.event.type === "stream.error")).toBe(false);
  });

  it("terminalizes a conclusively rejected admitted spawn without claiming process authority", async () => {
    const fixture = await createGuardianFixture([], ({ pty }) => {
      pty.identityDecision = false;
    });

    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    expect((await fixture.registered.spool.recover()).phases.map((phase) => phase.phase)).toEqual([
      "intent",
      "lease_transferred",
      "spawned",
      "running",
      "finalizing",
      "terminal"
    ]);
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "stream.error",
      code: "protocol_failure",
      message: "The supervised PTY command failed safely."
    });
    expect(fixture.processTree.calls).toEqual([]);
  });

  it("defers malformed synchronous capture handling until live process authority is installed", async () => {
    const fixture = await createGuardianFixture([], ({ pty }) => {
      pty.afterSpawn = (session) => {
        session.emitRawForTesting(Buffer.alloc(2 * 1_048_576, 0x61));
        session.emitRawExitForTesting({ exitCode: null, signal: "NOT_A_SIGNAL" });
      };
    });

    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    expect(fixture.processTree.calls.some((call) => call.type === "signal")).toBe(true);
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "stream.error",
      code: "output_quarantined"
    });
  });

  it("redacts split UTF-8, ANSI, and configured-secret output before every durable sink", async () => {
    const fixture = await createGuardianFixture(["super-secret"]);
    const encoded = Buffer.from("héllo [31msuper-secret[0m");
    fixture.pty.session.emitData(encoded.subarray(0, 2));
    fixture.pty.session.emitData(encoded.subarray(2, 14));
    fixture.pty.session.emitData(encoded.subarray(14));
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });

    await fixture.session.closed;
    const recovered = await fixture.registered.spool.recover();
    const transcript = Buffer.concat(
      recovered.transcriptChunks.map((chunk) => chunk.bytes)
    ).toString();
    expect(transcript).toContain("héllo");
    expect(transcript).toContain("[REDACTED]");
    expect(transcript).not.toContain("super-secret");
    expect(JSON.stringify(recovered)).not.toContain("super-secret");
    expect(recovered.events.at(-1)?.event.type).toBe("command.completed");
  });

  it("forces the live process group after graceful cancellation and cleans listeners", async () => {
    const fixture = await createGuardianFixture();
    fixture.processTree.gracefulExit = false;

    await fixture.session.send(cancelControl);
    fixture.pty.session.emitExit({ exitCode: null, signal: "SIGKILL" });
    await fixture.session.closed;

    expect(fixture.processTree.calls.map((call) => call.signal).filter(Boolean)).toEqual([
      "SIGINT",
      "SIGKILL"
    ]);
    expect(fixture.pty.session.listenerCount).toBe(0);
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.cancelAck).toMatchObject({
      claimDigest: recovered.cancel?.claimDigest,
      signalDispatched: true
    });
    const terminal = fixture.events.at(-1);
    expect(terminal).toMatchObject({
      type: "command.completed",
      cancelled: true,
      interrupted: false
    });
  });

  it("uses one immutable process authority even when a mutable PGID getter is reused", async () => {
    const fixture = await createGuardianFixture([], ({ pty, processTree }) => {
      pty.session.processGroupIds = [41001, 99999, 41001, 99999];
      processTree.gracefulExit = false;
    });

    await fixture.session.send(cancelControl);
    await fixture.session.closed;
    expect(fixture.pty.session.processGroupReadCount).toBe(0);
  });

  it("rejects an accessor-backed process capability without invoking it", async () => {
    let reads = 0;
    await expect(
      createGuardianFixture([], ({ processTree }) => {
        Object.defineProperty(processTree, "identityDigest", {
          configurable: true,
          enumerable: true,
          get() {
            reads += 1;
            return hex64("a");
          }
        });
      })
    ).rejects.toMatchObject({ code: "unsafe_state" });
    expect(reads).toBe(0);
  });

  it("latches interruption before a signal can synchronously emit process exit", async () => {
    const fixture = await createGuardianFixture([], ({ pty, processTree }) => {
      processTree.onSignal = (signal) => {
        if (signal === "SIGTERM") pty.session.emitExit({ exitCode: 0, signal: null });
      };
      processTree.actualExit = Object.freeze({ exitCode: 0, signal: null });
    });

    await fixture.session.disconnect();
    await fixture.session.closed;
    expect(fixture.events.at(-1)).toMatchObject({
      type: "command.completed",
      interrupted: true,
      exitCode: 0,
      signal: null
    });
  });

  it("single-flights concurrent disconnect cleanup without overlapping process operations", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    const releases: Array<() => void> = [];
    const fixture = await createGuardianFixture([], ({ processTree }) => {
      processTree.signal = async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
      };
    });

    const first = fixture.session.disconnect();
    const second = fixture.session.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(maximumInFlight).toBe(1);
    for (const release of releases.splice(0)) release();
    await Promise.allSettled([first, second]);
    await fixture.session.closed.catch(() => undefined);
  });

  it("waits for a timed-out process operation before queued cleanup or retained retries", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    let calls = 0;
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fixture = await createGuardianFixture([], ({ processTree }) => {
      processTree.signal = async () => {
        calls += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        if (calls === 1) await first;
        inFlight -= 1;
      };
    });

    const interrupting = fixture.session.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 125));
    const quarantining = fixture.session.send({
      type: "host.protocol_failure",
      reason: "output_quarantined"
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(maximumInFlight).toBe(1);

    releaseFirst();
    await Promise.allSettled([interrupting, quarantining]);
    await fixture.session.closed.catch(() => undefined);
  });

  it("serializes startup-failure cleanup behind an in-flight timeout operation", async () => {
    let controller!: FakeProcessTreeController;
    let maximumInFlight = 0;
    let inFlight = 0;
    let releaseSignals!: () => void;
    const signalsBlocked = new Promise<void>((resolve) => {
      releaseSignals = resolve;
    });
    let rejectRunning!: (error: Error) => void;
    const runningPhase = new Promise<void>((_resolve, reject) => {
      rejectRunning = reject;
    });
    let observedRunning!: () => void;
    const runningObserved = new Promise<void>((resolve) => {
      observedRunning = resolve;
    });

    const creating = createGuardianFixture(
      [],
      ({ processTree }) => {
        controller = processTree;
        processTree.gracefulExit = false;
        const signal = processTree.signal.bind(processTree);
        processTree.signal = async (...args) => {
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          await signalsBlocked;
          await signal(...args);
          inFlight -= 1;
        };
      },
      {
        timeoutMs: 1_000,
        failRunningPublication: async () => {
          observedRunning();
          await runningPhase;
          throw new Error("running receipt failed");
        }
      }
    );
    void creating.catch(() => undefined);

    await runningObserved;
    await new Promise((resolve) => setTimeout(resolve, 1_075));
    rejectRunning(new Error("running receipt failed"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(maximumInFlight).toBe(1);
    releaseSignals();
    await expect(creating).rejects.toBeDefined();
    controller.actualExit = Object.freeze({ exitCode: 0, signal: null });
  }, 10_000);

  it("accepts graceful cancellation without escalating and latches one terminal cause", async () => {
    const graceful = await createGuardianFixture();
    await graceful.session.send(cancelControl);
    await graceful.session.closed;
    expect(graceful.processTree.calls.map((call) => call.signal).filter(Boolean)).toEqual([
      "SIGINT"
    ]);
    expect(graceful.events.at(-1)).toMatchObject({
      type: "command.completed",
      cancelled: true,
      interrupted: false
    });

    const raced = await createGuardianFixture([], ({ processTree }) => {
      processTree.actualExit = Object.freeze({ exitCode: 3, signal: null });
    });
    const cancelling = raced.session.send(cancelControl);
    raced.pty.session.emitExit({ exitCode: 3, signal: null });
    await cancelling;
    await raced.session.closed;
    expect(
      raced.events.filter(
        (event) => event.type === "command.completed" || event.type === "stream.error"
      )
    ).toHaveLength(1);
    expect(raced.events.at(-1)).toMatchObject({
      type: "command.completed",
      exitCode: 3,
      cancelled: true
    });
  });

  it("clears the exact graceful-cancel timer when process exit releases the wait early", async () => {
    const fixture = await createGuardianFixture([], undefined, { cancellationGraceMs: 500 });
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const graceHandles = new Set<ReturnType<typeof setTimeout>>();
    const clearedGraceHandles = new Set<ReturnType<typeof setTimeout>>();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const handle = originalSetTimeout(handler, timeout, ...args);
      if (timeout === 500) graceHandles.add(handle);
      return handle;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      handle: Parameters<typeof clearTimeout>[0]
    ) => {
      const timerHandle = handle as ReturnType<typeof setTimeout>;
      if (handle !== undefined && graceHandles.has(timerHandle)) {
        clearedGraceHandles.add(timerHandle);
      }
      return originalClearTimeout(handle);
    }) as typeof clearTimeout);
    fixture.processTree.onSignal = (signal) => {
      if (signal === "SIGINT") {
        originalSetTimeout(
          () => fixture.pty.session.emitExit({ exitCode: null, signal: "SIGINT" }),
          10
        );
      }
    };
    try {
      await fixture.session.send(cancelControl);
      await fixture.session.closed;
      expect(graceHandles.size).toBe(1);
      expect(clearedGraceHandles.size).toBe(1);
    } finally {
      vi.restoreAllMocks();
      for (const handle of graceHandles) originalClearTimeout(handle);
    }
  });

  it("gives host interruption priority over an in-progress acknowledged user cancel", async () => {
    const fixture = await createGuardianFixture(
      [],
      ({ processTree }) => {
        processTree.gracefulExit = false;
      },
      { cancellationGraceMs: 100 }
    );
    const cancelling = fixture.session.send(cancelControl);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const disconnecting = fixture.session.disconnect();
    await Promise.allSettled([cancelling, disconnecting]);
    await fixture.session.closed;
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.cancelAck?.claimDigest).toBe(recovered.cancel?.claimDigest);
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "command.completed",
      cancelled: false,
      interrupted: true
    });
  });

  it("publishes the cleanup signal that actually proved forced interruption", async () => {
    const fixture = await createGuardianFixture([], ({ processTree }) => {
      processTree.gracefulExit = false;
      processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGKILL" });
    });
    await fixture.session.disconnect();
    await fixture.session.closed;
    expect(fixture.events.at(-1)).toMatchObject({
      type: "command.completed",
      signal: "SIGKILL",
      interrupted: true
    });
  });

  it("retains authority when configured sensitive data appears in process proof", async () => {
    const fixture = await createGuardianFixture(["SIGTERM"], ({ processTree }) => {
      processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGTERM" });
    });

    try {
      await fixture.session.disconnect();
      await expect(fixture.session.closed).rejects.toMatchObject({ code: "unsafe_state" });
      const recovered = await fixture.registered.spool.recover();
      expect(JSON.stringify(recovered)).not.toContain("SIGTERM");
    } finally {
      fixture.processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGBUS" });
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  });

  it("requires the first immutable PTY exit callback to equal authoritative process proof", async () => {
    const mismatch = await createGuardianFixture([], ({ processTree }) => {
      processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGBUS" });
    });
    mismatch.pty.session.emitExit({ exitCode: null, signal: "SIGTERM" });
    await expect(mismatch.session.closed).rejects.toMatchObject({ code: "unsafe_state" });

    const conflict = await createGuardianFixture([], ({ processTree }) => {
      processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGBUS" });
    });
    conflict.pty.session.emitExit({ exitCode: null, signal: "SIGBUS" });
    conflict.pty.session.replayExitForTesting({ exitCode: null, signal: "SIGTERM" });
    await expect(conflict.session.closed).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("seals and disposes PTY exit ingress before the first finalizing write", async () => {
    let fixture!: Awaited<ReturnType<typeof createGuardianFixture>>;
    let listenerCountAtFinalizing = -1;
    fixture = await createGuardianFixture(
      [],
      ({ processTree }) => {
        processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGTERM" });
      },
      {
        onSpoolPublication(relativePath, stage) {
          if (relativePath.endsWith("/05-finalizing.json") && stage === "temp-created") {
            listenerCountAtFinalizing = fixture.pty.session.listenerCount;
            fixture.pty.session.replayExitForTesting({
              exitCode: "malformed",
              signal: null
            } as never);
          }
        }
      }
    );

    fixture.pty.session.emitExit({ exitCode: null, signal: "SIGTERM" });
    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    expect(listenerCountAtFinalizing).toBe(0);
    expect(fixture.events.at(-1)).toMatchObject({
      type: "command.completed",
      exitCode: null,
      signal: "SIGTERM"
    });
  });

  it("keeps sealed proof authoritative during terminal-frame publication", async () => {
    let fixture!: Awaited<ReturnType<typeof createGuardianFixture>>;
    let injected = false;
    let listenerCountAtTerminalFrame = -1;
    fixture = await createGuardianFixture(
      [],
      ({ processTree }) => {
        processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGTERM" });
      },
      {
        onSpoolPublication(relativePath, stage) {
          if (
            relativePath.endsWith("/events/000000000003.json") &&
            stage === "temp-created" &&
            !injected
          ) {
            injected = true;
            listenerCountAtTerminalFrame = fixture.pty.session.listenerCount;
            fixture.pty.session.replayExitForTesting({ exitCode: null, signal: "SIGBUS" });
          }
        }
      }
    );

    fixture.pty.session.emitExit({ exitCode: null, signal: "SIGTERM" });
    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    expect(injected).toBe(true);
    expect(listenerCountAtTerminalFrame).toBe(0);
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "command.completed",
      exitCode: null,
      signal: "SIGTERM"
    });
    const lease = await acquireCommandGuardianLease(fixture.dataRoot, ids.commandId);
    lease.close();
  });

  it("recovers a terminal-frame durability crash after exit ingress is sealed", async () => {
    let fixture!: Awaited<ReturnType<typeof createGuardianFixture>>;
    let crashed = false;
    let listenerCountAtCrash = -1;
    fixture = await createGuardianFixture(
      [],
      ({ processTree }) => {
        processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGTERM" });
      },
      {
        onSpoolPublication(relativePath, stage) {
          if (
            relativePath.endsWith("/events/000000000003.json") &&
            stage === "temp-created" &&
            !crashed
          ) {
            crashed = true;
            listenerCountAtCrash = fixture.pty.session.listenerCount;
            fixture.pty.session.replayExitForTesting({ exitCode: null, signal: "SIGBUS" });
            throw new Error("simulated terminal-frame durability crash");
          }
        }
      }
    );

    fixture.pty.session.emitExit({ exitCode: null, signal: "SIGTERM" });
    await expect(fixture.session.closed).rejects.toMatchObject({ code: "maintenance_required" });
    expect(crashed).toBe(true);
    expect(listenerCountAtCrash).toBe(0);
    const beforeRecovery = await fixture.registered.spool.recover();
    expect(beforeRecovery.events.some((frame) => frame.event.type === "command.completed")).toBe(
      false
    );
    const recoveryPaths = await DataPathPolicy.create(fixture.dataRoot);
    const recoveryArtifacts = await admitArtifactStoreRecoveryRoot(
      fixture.artifactStore,
      recoveryPaths.root
    );
    await expect(
      admitRecoveryPublications(recoveryPaths, ids.commandId, recoveryArtifacts)
    ).resolves.toBeUndefined();

    const restarted = await CommandRegistry.create({
      dataRoot: fixture.dataRoot,
      artifactStore: fixture.artifactStore
    });
    await expect(restarted.recoverAll()).resolves.toBeUndefined();
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "command.completed",
      exitCode: null,
      signal: "SIGTERM"
    });
    expect(recovered.phases.at(-1)?.phase).toBe("terminal");
  });

  it("retains unsafe authority when spawn throws without proving whether a child was created", async () => {
    const fixture = await createGuardianFixture([], ({ pty }) => {
      pty.createThenThrow = true;
    });

    await expect(fixture.session.closed).rejects.toMatchObject({ code: "unsafe_state" });
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.phases.at(-1)?.phase).toBe("spawned");
    expect(recovered.events).toEqual([]);
    await expect(
      acquireCommandGuardianLease(fixture.dataRoot, ids.commandId)
    ).rejects.toBeDefined();
    fixture.pty.uncertainDescendantsAbsent = true;
  });

  it("supports bounded input and resize, then drops bytes emitted after PTY EOF", async () => {
    const fixture = await createGuardianFixture();
    await fixture.session.send({ type: "host.input", value: "answer\n" });
    await fixture.session.send({ type: "host.resize", columns: 120, rows: 40 });
    fixture.pty.session.emitData(Buffer.from("before-eof"));
    fixture.pty.session.emitEof();
    fixture.pty.session.emitData(Buffer.from("after-eof"));

    await fixture.session.closed;
    const recovered = await fixture.registered.spool.recover();
    const transcript = Buffer.concat(
      recovered.transcriptChunks.map((chunk) => chunk.bytes)
    ).toString();
    expect(fixture.pty.session.writes).toEqual(["answer\n"]);
    expect(fixture.pty.session.resizes).toEqual([{ columns: 120, rows: 40 }]);
    expect(transcript).toContain("before-eof");
    expect(transcript).not.toContain("after-eof");
    expect(
      recovered.events.filter((frame) => frame.event.type === "command.completed")
    ).toHaveLength(1);
  });

  it("forces the process group on timeout without claiming user cancellation", async () => {
    const fixture = await createGuardianFixture(
      [],
      ({ processTree }) => {
        processTree.gracefulExit = false;
      },
      { timeoutMs: 1_000 }
    );

    await fixture.session.closed;
    expect(fixture.processTree.calls.map((call) => call.signal).filter(Boolean)).toEqual([
      "SIGINT",
      "SIGKILL"
    ]);
    expect(fixture.events.at(-1)).toMatchObject({
      type: "command.completed",
      cancelled: false,
      interrupted: false
    });
  });

  it("rejects malformed host controls and interrupts cleanly on IPC disconnect", async () => {
    const fixture = await createGuardianFixture();
    await expect(
      fixture.session.send({ type: "host.input", value: "x".repeat(65_537) })
    ).rejects.toThrow("Guardian input is invalid.");
    for (const control of [
      { type: "host.resize", columns: 19, rows: 30 },
      { type: "host.resize", columns: 100, rows: 301 },
      { type: "unknown" }
    ]) {
      await expect(fixture.session.send(control as never)).rejects.toThrow();
    }

    await fixture.session.disconnect();
    const outcome = await fixture.session.closed;
    expect(outcome.releasedLease).toBe(true);
    expect(fixture.events.at(-1)).toMatchObject({
      type: "command.completed",
      cancelled: false,
      interrupted: true
    });
    expect(fixture.pty.session.listenerCount).toBe(0);
    await expect(fixture.session.send({ type: "unknown" } as never)).resolves.toBeUndefined();
  });

  it("retains sticky guardian authority without terminal evidence when cleanup is unproven", async () => {
    const fixture = await createGuardianFixture([], ({ processTree }) => {
      processTree.gracefulExit = false;
      processTree.terminated = false;
    });
    fixture.pty.session.emitExit({ exitCode: 7, signal: null });

    await expect(fixture.session.closed).rejects.toMatchObject({ code: "unsafe_state" });
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.phases.at(-1)?.phase).toBe("running");
    expect(
      recovered.events.filter(
        (frame) => frame.event.type === "command.completed" || frame.event.type === "stream.error"
      )
    ).toHaveLength(0);
    await expect(
      acquireCommandGuardianLease(fixture.dataRoot, ids.commandId)
    ).rejects.toBeDefined();
    fixture.processTree.terminated = true;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const released = await acquireCommandGuardianLease(fixture.dataRoot, ids.commandId);
    released.close();
  });

  it("bounds never-settling finalization proof and retains retrying live authority", async () => {
    let unblock!: (
      value: Readonly<{
        identityDigest: string;
        processTreeTerminated: true;
        exit: Readonly<{ exitCode: 0; signal: null }>;
      }>
    ) => void;
    const blocked = new Promise<
      Readonly<{
        identityDigest: string;
        processTreeTerminated: true;
        exit: Readonly<{ exitCode: 0; signal: null }>;
      }>
    >((resolve) => {
      unblock = resolve;
    });
    const fixture = await createGuardianFixture([], ({ processTree }) => {
      processTree.waitForExit = async () => await blocked;
    });

    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    const result = await Promise.race([
      fixture.session.closed.then(
        () => "closed",
        () => "unsafe"
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 750))
    ]);
    expect(result).toBe("unsafe");
    const waitCallsBefore = fixture.processTree.calls.filter((call) => call.type === "wait").length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fixture.processTree.calls.filter((call) => call.type === "wait")).toHaveLength(
      waitCallsBefore
    );
    unblock(
      Object.freeze({
        identityDigest: hex64("a"),
        processTreeTerminated: true,
        exit: Object.freeze({ exitCode: 0, signal: null })
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
  });

  it("rejects capture installation before the atomic authority can spawn", async () => {
    let pty!: FakePtyFactory;
    let processTree!: FakeProcessTreeController;
    await expect(
      createGuardianFixture([], (fixture) => {
        pty = fixture.pty;
        processTree = fixture.processTree;
        pty.session.eofListenerFailure = new Error("listener detail");
      })
    ).rejects.toThrow();

    expect(pty.spawnRequests).toHaveLength(0);
    expect(processTree.calls).toHaveLength(0);
    expect(pty.session.listenerCount).toBe(0);
  });

  it("bounds raw PTY ingress synchronously and still publishes safe artifact terminal evidence", async () => {
    const fixture = await createGuardianFixture([], undefined, { transcriptBytes: 1_048_576 });
    const burst = Buffer.alloc(262_144, 0x61);
    for (let index = 0; index < 8; index += 1) fixture.pty.session.emitData(burst);
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.processTree.calls.some((call) => call.signal !== undefined)).toBe(true);
    await fixture.session.closed;
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.events.at(-2)?.event.type).toBe("artifact.created");
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "stream.error",
      code: "output_quarantined"
    });
    expect(recovered.phases.at(-1)?.phase).toBe("terminal");
  }, 15_000);

  it.each([1_048_576, 16 * 1_048_576])(
    "rejects a %i-byte single-frame pressure probe before durable output",
    async (byteSize) => {
      const fixture = await createGuardianFixture([], undefined, { transcriptBytes: 1_048_576 });
      fixture.pty.session.emitData(Buffer.alloc(byteSize, 0x62));

      await fixture.session.closed;
      const recovered = await fixture.registered.spool.recover();
      expect(recovered.transcriptByteSize).toBe(0);
      expect(recovered.events.at(-2)?.event.type).toBe("artifact.created");
      expect(recovered.events.at(-1)?.event).toMatchObject({
        type: "stream.error",
        code: "output_quarantined"
      });
      expect(recovered.phases.at(-1)?.phase).toBe("terminal");
    },
    15_000
  );

  it("segments a 70KB UTF-8 output frame and preserves terminal evidence", async () => {
    const fixture = await createGuardianFixture();
    fixture.pty.session.emitData(Buffer.from("é".repeat(35_000)));
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });

    await fixture.session.closed;
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.events.filter((frame) => frame.event.type === "terminal.output").length).toBe(
      2
    );
    expect(recovered.events.at(-2)?.event.type).toBe("artifact.created");
    expect(recovered.events.at(-1)?.event.type).toBe("command.completed");
    expect(recovered.phases.at(-1)?.phase).toBe("terminal");
  });

  it("terminalizes a host-detected output quarantine with fixed redacted evidence", async () => {
    const fixture = await createGuardianFixture();

    await fixture.session.send({
      type: "host.protocol_failure",
      reason: "output_quarantined"
    } as never);
    const outcome = await fixture.session.closed;
    const recovered = await fixture.registered.spool.recover();

    expect(outcome.releasedLease).toBe(true);
    expect(recovered.phases.map((phase) => phase.phase)).toEqual([
      "intent",
      "lease_transferred",
      "spawned",
      "running",
      "finalizing",
      "terminal"
    ]);
    expect(recovered.events.map((frame) => frame.event.type)).toEqual([
      "command.started",
      "artifact.created",
      "stream.error"
    ]);
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "stream.error",
      code: "output_quarantined",
      message: "The supervised PTY command output was quarantined."
    });
    expect(JSON.stringify(recovered)).not.toContain("suspect");
  });

  it("quarantines transcript-limit output without persisting the rejected bytes", async () => {
    const fixture = await createGuardianFixture([], undefined, { transcriptBytes: 4 });
    fixture.pty.session.emitData(Buffer.from("rejected output"));
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });

    const outcome = await fixture.session.closed;
    const recovered = await fixture.registered.spool.recover();

    expect(recovered.events.map((frame) => frame.event.type)).toEqual([
      "command.started",
      "artifact.created",
      "stream.error"
    ]);
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "stream.error",
      code: "output_quarantined"
    });
    expect(JSON.stringify(recovered)).not.toContain("rejected output");
    expect(outcome.releasedLease).toBe(true);
  });

  it("runs handshake, control, durable events, and terminal through authenticated fake IPC", async () => {
    const fixture = await createGuardianFixture([], undefined, { authenticated: true });
    const launcher = fixture.authenticatedLauncher!;

    expect(launcher.protocolTrace.slice(0, 4)).toEqual([
      "guardian.hello",
      "guardian.lease_acquired",
      "host.lease_transfer",
      "guardian.phase:lease_transferred"
    ]);
    await launcher.sendHostPayloadForTesting({ type: "host.event_ack", sequence: 1 });
    await fixture.session.send({ type: "host.resize", columns: 120, rows: 40 });
    await fixture.session.send({ type: "host.input", value: "answer\n" });
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await fixture.session.closed;

    expect(fixture.pty.session.writes).toEqual(["answer\n"]);
    expect(fixture.pty.session.resizes).toEqual([{ columns: 120, rows: 40 }]);
    expect(launcher.protocolTrace).toContain("guardian.event_committed:command.started");
    expect(launcher.protocolTrace.at(-1)).toBe("guardian.terminal");
  });

  it("authenticates output quarantine through fake IPC without transporting suspect bytes", async () => {
    const fixture = await createGuardianFixture([], undefined, { authenticated: true });

    await fixture.session.send({
      type: "host.protocol_failure",
      reason: "output_quarantined"
    } as never);
    await fixture.session.closed;

    const recovered = await fixture.registered.spool.recover();
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "stream.error",
      code: "output_quarantined",
      message: "The supervised PTY command output was quarantined."
    });
    expect(JSON.stringify(recovered)).not.toContain("suspect");
    expect(fixture.authenticatedLauncher!.protocolTrace.at(-1)).toBe("guardian.terminal");
  });

  it("waits for the exact authenticated durable cancel acknowledgement after enqueue", async () => {
    const fixture = await createGuardianFixture([], undefined, {
      authenticated: true,
      hostEnqueueDelayMs: 50
    });
    let settled = false;
    const cancelling = fixture.session.send(cancelControl).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const settledBeforeAck = settled;
    await cancelling;
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.cancelAck?.claimDigest).toBe(recovered.cancel?.claimDigest);
    await fixture.session.closed;
    expect(settledBeforeAck).toBe(false);
  });

  it("rejects future, duplicate, and gapped event acknowledgements", async () => {
    const fixture = await createGuardianFixture([], undefined, { authenticated: true });
    const launcher = fixture.authenticatedLauncher!;
    const futureRejected = await launcher
      .sendHostPayloadForTesting({ type: "host.event_ack", sequence: 2 })
      .then(
        () => false,
        () => true
      );
    const exactAccepted = await launcher
      .sendHostPayloadForTesting({ type: "host.event_ack", sequence: 1 })
      .then(
        () => true,
        () => false
      );
    const duplicateRejected = await launcher
      .sendHostPayloadForTesting({ type: "host.event_ack", sequence: 1 })
      .then(
        () => false,
        () => true
      );
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await fixture.session.closed;
    expect(futureRejected).toBe(true);
    expect(exactAccepted).toBe(true);
    expect(duplicateRejected).toBe(true);
  });

  it("reserves host ACK sequence synchronously so a concurrent duplicate cannot kill the peer", async () => {
    const fixture = await createGuardianFixture([], undefined, { authenticated: true });
    const launcher = fixture.authenticatedLauncher!;
    const outcomes = await Promise.allSettled([
      launcher.sendHostPayloadForTesting({ type: "host.event_ack", sequence: 1 }),
      launcher.sendHostPayloadForTesting({ type: "host.event_ack", sequence: 1 })
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    expect(fixture.events.at(-1)?.type).toBe("command.completed");
  });

  it("reserves child event sequence before observer delivery so a reentrant ACK is valid", async () => {
    const fixture = await createGuardianFixture([], undefined, {
      authenticated: true,
      acknowledgeFramesReentrantly: true
    });
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });

    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    expect(fixture.events.at(-1)?.type).toBe("command.completed");
  });

  it("preserves cancel, resize, input, and reentrant event-ACK wire order", async () => {
    const fixture = await createGuardianFixture(
      [],
      ({ processTree }) => {
        processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGINT" });
      },
      {
        authenticated: true,
        acknowledgeFramesReentrantly: true,
        hostEnqueueDelayMs: 25,
        cancellationGraceMs: 50
      }
    );

    const resizing = fixture.session.send({ type: "host.resize", columns: 132, rows: 44 });
    const input = fixture.session.send({ type: "host.input", value: "ordered\n" });
    const cancelling = fixture.session.send(cancelControl);
    fixture.pty.session.emitData(Buffer.from("ack-me"));

    await Promise.all([resizing, input, cancelling]);
    await expect(fixture.session.closed).resolves.toMatchObject({ releasedLease: true });
    expect(fixture.pty.session.resizes).toEqual([{ columns: 132, rows: 44 }]);
    expect(fixture.pty.session.writes).toEqual(["ordered\n"]);
    expect(fixture.authenticatedLauncher!.protocolTrace).toContain("guardian.cancel_ack");
  });

  it("terminalizes a live child when the authenticated host observer throws", async () => {
    const fixture = await createGuardianFixture([], undefined, {
      authenticated: true,
      onFrame() {
        throw new Error("host observer detail");
      }
    });
    await expect(fixture.session.closed).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const signalled = fixture.processTree.calls.some((call) => call.signal !== undefined);
    if (!signalled) fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    await fixture.authenticatedLauncher!.waitForChildForTesting();
    expect(signalled).toBe(true);
    const recovered = await fixture.registered.spool.recover();
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "stream.error",
      code: "protocol_failure"
    });
  });

  it.each(invalidAuthenticatedHostPayloads)(
    "fails closed on exact-shape-invalid authenticated host payload %j",
    async (payload) => {
      const fixture = await createGuardianFixture([], undefined, { authenticated: true });
      const launcher = fixture.authenticatedLauncher!;
      const envelope = launcher.sealHostPayloadForTesting(payload);

      await expect(launcher.deliverHostEnvelopeForTesting(envelope)).rejects.toThrow(
        "Guardian protocol failed."
      );
      await fixture.session.closed;
      expect(launcher.protocolTrace).toContain("guardian.protocol_failure");
      expect(
        fixture.events.filter(
          (event) => event.type === "command.completed" || event.type === "stream.error"
        )
      ).toHaveLength(1);
      expect(fixture.events.at(-1)).toMatchObject({
        type: "stream.error",
        code: "protocol_failure"
      });
    }
  );

  it("settles the host session when the inbound transport closes after transfer", async () => {
    const fixture = await createGuardianFixture([], undefined, { authenticated: true });
    await fixture.authenticatedLauncher!.transportClosedForTesting();
    const outcome = await Promise.race([
      fixture.session.closed.then(
        (value) => value,
        (error: unknown) => error
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 750))
    ]);
    expect(outcome).not.toBe("timeout");
  });

  it("rejects protocol JSON depth and a UTF-8 budget smaller than one code point", () => {
    let payload: unknown = "leaf";
    for (let index = 0; index < 80; index += 1) payload = { nested: payload };
    expect(() =>
      sealGuardianEnvelope({
        sessionId: "guardian-session",
        secret: new Uint8Array(32),
        direction: "host_to_guardian",
        sequence: 1,
        payload
      })
    ).toThrow("Invalid guardian envelope input.");
    expect(() => splitEventText("é", 1)).toThrow(TypeError);
    let accessorReads = 0;
    const accessorPayload = {} as Record<string, unknown>;
    Object.defineProperty(accessorPayload, "type", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "host.interrupt";
      }
    });
    expect(() =>
      sealGuardianEnvelope({
        sessionId: "guardian-session",
        secret: new Uint8Array(32),
        direction: "host_to_guardian",
        sequence: 1,
        payload: accessorPayload
      })
    ).toThrow("Invalid guardian envelope input.");
    expect(accessorReads).toBe(0);

    let envelopeReads = 0;
    const accessorEnvelope = {
      secret: new Uint8Array(32),
      direction: "host_to_guardian",
      sequence: 1,
      payload: { type: "host.interrupt" }
    } as Record<string, unknown>;
    Object.defineProperty(accessorEnvelope, "sessionId", {
      enumerable: true,
      get() {
        envelopeReads += 1;
        return "guardian-session";
      }
    });
    expect(() => sealGuardianEnvelope(accessorEnvelope as never)).toThrow(
      "Invalid guardian envelope input."
    );
    expect(envelopeReads).toBe(0);
  });

  it("rejects accessor-backed guardian bootstrap without invoking it", async () => {
    const dataRoot = await makeRoot();
    let reads = 0;
    const bootstrap = {
      commandId: ids.commandId,
      intentRelativePath: `commands/${Buffer.from(ids.commandId).toString("hex")}/receipt/01-intent.json`,
      envelope: {
        executable: "/usr/bin/tool",
        args: [],
        cwd: "/private/worktree",
        environment: [],
        terminal: { columns: 100, rows: 30 }
      },
      sensitiveValues: [],
      timeoutMs: 1_000,
      cancellationGraceMs: 10,
      eofSettleMs: 10,
      executableIdentityDigest: hex64("5"),
      cwdIdentityDigest: hex64("6"),
      session: {
        sessionId: "accessor-bootstrap",
        secret: new Uint8Array(32),
        bindingDigest: hex64("7")
      }
    } as Record<string, unknown>;
    Object.defineProperty(bootstrap, "dataRoot", {
      enumerable: true,
      get() {
        reads += 1;
        return dataRoot;
      }
    });
    expect(() =>
      CommandGuardianHostProtocolAdapter.create({
        bootstrap: bootstrap as never,
        observer: { onDurableFrame() {} },
        async send() {},
        async disconnect() {}
      })
    ).toThrow("Guardian host protocol is invalid.");
    expect(reads).toBe(0);
  });

  it("fails closed on duplicate authenticated lease transfer", async () => {
    const duplicate = await createGuardianFixture([], undefined, { authenticated: true });
    const launcher = duplicate.authenticatedLauncher!;
    const envelope = launcher.sealHostPayloadForTesting({
      type: "host.lease_transfer",
      bindingDigest: hex64("7"),
      receiptDigest: duplicate.registered.spool.intent.receiptDigest
    });
    await expect(launcher.deliverHostEnvelopeForTesting(envelope)).rejects.toThrow(
      "Guardian protocol failed."
    );
    await duplicate.session.closed;
  });

  it.each(["hmac", "replay", "direction", "sequence"] as const)(
    "fails closed on a %s authenticated fake IPC envelope",
    async (mutation) => {
      const fixture = await createGuardianFixture([], undefined, { authenticated: true });
      const launcher = fixture.authenticatedLauncher!;
      const envelope = launcher.sealHostControlForTesting({
        type: "host.input",
        value: "bounded input"
      });
      if (mutation === "replay") await launcher.deliverHostEnvelopeForTesting(envelope);
      const changed =
        mutation === "hmac"
          ? { ...envelope, hmac: "0".repeat(64) }
          : mutation === "direction"
            ? { ...envelope, direction: "guardian_to_host" as const }
            : mutation === "sequence"
              ? { ...envelope, sequence: envelope.sequence + 1 }
              : envelope;

      await expect(launcher.deliverHostEnvelopeForTesting(changed as never)).rejects.toThrow(
        "Guardian protocol failed."
      );
      await fixture.session.closed;
      expect(
        fixture.events.filter(
          (event) => event.type === "command.completed" || event.type === "stream.error"
        )
      ).toHaveLength(1);
    }
  );
});
