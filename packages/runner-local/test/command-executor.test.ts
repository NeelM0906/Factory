import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
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
  type CommandAuthorization,
  type EnvironmentAuthorization,
  type StartCommandRequest
} from "@autostack/contracts";

import { ArtifactStore } from "../src/artifact-store.js";
import { CommandExecutor } from "../src/command-executor.js";
import { isForbiddenEnvironmentName } from "../src/command-environment-policy.js";
import { snapshotCommandExecutorOptions } from "../src/command-executor-options.js";
import { CommandActivityCoordinator } from "../src/command-activity.js";
import type { GuardianBootstrap } from "../src/command-executor-types.js";
import {
  CommandExecutorError,
  admitPositiveBoundedInteger,
  mapCommandRegistryError,
  safeCommandTimestamp
} from "../src/command-executor-error.js";
import { commandExecutorTestControl } from "../src/command-executor-control.js";
import {
  captureUnadmittedGuardianHostSession,
  closeUnadmittedActiveCommandLease,
  snapshotGuardianHostSession,
  snapshotPreparedEnvironmentResult
} from "../src/command-executor-admission.js";
import { CommandDependencyTracker } from "../src/command-dependency-tracker.js";
import { snapshotBytes } from "../src/command-guardian-bounds.js";
import {
  settleGuardianLifecycle,
  settleLateGuardianLaunch
} from "../src/command-executor-lifecycle.js";
import type { GuardianHostObserver, GuardianHostSession } from "../src/command-guardian.js";
import { CommandRegistry, CommandRegistryError } from "../src/command-registry.js";
import {
  materializeCommandEnvironment,
  createCommandPrivateBaseEnvironment,
  pinCommandCwd,
  snapshotCommandCredentials,
  snapshotGuardianSession,
  snapshotResolvedExecutable,
  snapshotTrustedBaseEnvironment,
  validateTrustedBaseEnvironmentPaths,
  validateCommandEnvironmentNames
} from "../src/command-runtime-preparation.js";
import { ReplaySpool } from "../src/replay-spool.js";
import { createFrame } from "../src/replay-spool-codec.js";
import { digestSpawnEnvelope } from "../src/command-spawn-envelope.js";
import {
  FakeAuthenticatedGuardianLauncher,
  FakeProcessTreeController,
  FakePtyFactory
} from "./fixtures/fake-pty.js";

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-command-executor-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ids = {
  workspaceId: createId("workspace", "20000000-0000-4000-8000-000000000001"),
  runId: createId("run", "20000000-0000-4000-8000-000000000002"),
  environmentId: createId("environment", "20000000-0000-4000-8000-000000000003"),
  commandId: createId("command", "20000000-0000-4000-8000-000000000004"),
  environmentAuthorizationId: createId(
    "environmentAuthorization",
    "20000000-0000-4000-8000-000000000005"
  ),
  commandAuthorizationId: createId("commandAuthorization", "20000000-0000-4000-8000-000000000006"),
  environmentApprovalId: createId("approval", "20000000-0000-4000-8000-000000000007"),
  commandApprovalId: createId("approval", "20000000-0000-4000-8000-000000000008"),
  credentialRefId: createId("credentialRef", "20000000-0000-4000-8000-000000000009"),
  artifactId: createId("artifact", "20000000-0000-4000-8000-000000000010")
};

const hex64 = (character: string): string => character.repeat(64);

interface AuthorizationFixture {
  readonly request: StartCommandRequest;
  readonly environmentAuthorization: EnvironmentAuthorization;
  readonly commandAuthorization: CommandAuthorization;
}

const createAuthorizationFixture = async (
  lastArgument = "two",
  commandEnvironment: StartCommandRequest["command"]["environment"] = [
    { kind: "literal" as const, name: "AUTOSTACK_MODE", value: "test" },
    {
      kind: "credential_ref" as const,
      name: "GITHUB_TOKEN",
      credentialRefId: ids.credentialRefId
    }
  ],
  timeoutSeconds = 10,
  executable = "tool",
  cwd = "."
): Promise<AuthorizationFixture> => {
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
    allowedCredentialRefIds: [ids.credentialRefId]
  };
  const environmentEnvelope = {
    id: ids.environmentAuthorizationId,
    approvalId: ids.environmentApprovalId,
    approvalEvidenceDigest: await digestExecutionScope(environmentScope),
    scope: environmentScope,
    createdAt: "2026-08-21T11:00:00.000Z",
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  const environmentAuthorization = EnvironmentAuthorizationSchema.parse({
    ...environmentEnvelope,
    digest: await digestEnvironmentAuthorization({ ...environmentEnvelope, digest: hex64("0") })
  });
  const command = {
    executable,
    args: ["one", lastArgument],
    cwd,
    environment: commandEnvironment,
    timeoutSeconds,
    terminal: { columns: 100, rows: 30 }
  };
  const commandScope = {
    environmentAuthorizationId: environmentAuthorization.id,
    environmentAuthorizationDigest: environmentAuthorization.digest,
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    environmentId: ids.environmentId,
    commandId: ids.commandId,
    action: "implement" as const,
    commandDigest: await digestCommandSpec(command),
    repositoryIdentity: environmentScope.repositoryIdentity,
    sourceCommit: environmentScope.sourceCommit,
    branch: environmentScope.branch,
    cwdRoot: ".",
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    resourceLimits: { cpu: 2, memoryMb: 1_024, durationSeconds: 30 },
    allowedCredentialRefIds: [ids.credentialRefId]
  };
  const commandEnvelope = {
    id: ids.commandAuthorizationId,
    approvalId: ids.commandApprovalId,
    approvalEvidenceDigest: await digestCommandScope(commandScope),
    scope: commandScope,
    createdAt: "2026-08-21T11:00:00.000Z",
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  const commandAuthorization = CommandAuthorizationSchema.parse({
    ...commandEnvelope,
    digest: await digestCommandAuthorization({ ...commandEnvelope, digest: hex64("0") })
  });
  const request = {
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    environmentId: ids.environmentId,
    commandId: ids.commandId,
    command,
    environmentAuthorizationId: environmentAuthorization.id,
    environmentAuthorizationDigest: environmentAuthorization.digest,
    authorization: commandAuthorization,
    idempotency: { key: "command-attempt" }
  };
  return { request, environmentAuthorization, commandAuthorization };
};

describe("CommandExecutor ordering and idempotency", () => {
  it("preserves the branded artifact recovery capability through option snapshotting", async () => {
    const dataRoot = await makeRoot();
    const managedPath = join(dataRoot, "managed");
    const homePath = join(dataRoot, "runtime/home");
    const temporaryPath = join(dataRoot, "runtime/tmp");
    await mkdir(managedPath, { mode: 0o700 });
    const fixture = await createAuthorizationFixture("two", []);
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const trustedBaseEnvironment = [
      { name: "PATH", value: "/usr/bin:/bin" },
      { name: "HOME", value: homePath },
      { name: "TMPDIR", value: temporaryPath },
      { name: "LANG", value: "C" },
      { name: "LC_ALL", value: "C" },
      { name: "TERM", value: "xterm-256color" }
    ] as const;
    const envelope = {
      executable: "/usr/bin/tool",
      args: ["one", "two"],
      cwd: managedPath,
      environment: trustedBaseEnvironment,
      terminal: { columns: 100, rows: 30 }
    } as const;
    const registry = await CommandRegistry.create({ dataRoot, artifactStore });
    await registry.registerIntent({
      commandId: ids.commandId,
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      request: fixture.request,
      requestDigest: await digestVersionedValue("autostack.start-command-request", fixture.request),
      environmentIntentDigest: hex64("d"),
      environmentAuthorizationId: fixture.environmentAuthorization.id,
      environmentAuthorizationDigest: fixture.environmentAuthorization.digest,
      environmentAuthorization: fixture.environmentAuthorization,
      commandAuthorizationId: fixture.commandAuthorization.id,
      commandAuthorizationDigest: fixture.commandAuthorization.digest,
      acceptedAt: "2026-08-21T12:00:00.000Z",
      executablePath: envelope.executable,
      executableIdentityDigest: hex64("e"),
      cwdRelativePath: ".",
      cwdIdentityDigest: hex64("c"),
      spawnEnvelopeDigest: digestSpawnEnvelope({
        request: fixture.request,
        envelope,
        executableIdentityDigest: hex64("e"),
        cwdIdentityDigest: hex64("c"),
        sensitiveValues: []
      }),
      transcriptArtifactId: ids.artifactId,
      artifactCreatedAt: "2026-08-21T12:00:00.000Z",
      guardianSessionBindingDigest: hex64("f"),
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1
      }
    });

    const executor = await CommandExecutor.create({
      dataRoot,
      worktrees: {
        async resolvePreparedEnvironment() {
          throw new TypeError();
        }
      },
      artifactStore,
      activity: {
        async reserveCommand() {
          throw new TypeError();
        },
        async acquireEnvironmentQuiescence() {
          throw new TypeError();
        },
        closeAdmission() {}
      },
      guardianLauncher: {
        async launch() {
          throw new TypeError();
        }
      },
      async resolveCredentials() {
        return [];
      },
      executableResolver: {
        async resolve() {
          throw new TypeError();
        }
      },
      trustedBaseEnvironment,
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "restart-recovery",
        secret: new Uint8Array(32),
        bindingDigest: hex64("f")
      })
    });

    const recovered = await (
      await ReplaySpool.open({ dataRoot, commandId: ids.commandId })
    ).recover();
    expect(recovered.phases.at(-1)?.phase).toBe("terminal");
    expect(recovered.events.at(-1)?.event.type).toBe("stream.error");
    await executor.interruptAndDrain();
  });

  it("deeply rejects a proxy-backed prepared environment without triggering traps", () => {
    let traps = 0;
    const environment = new Proxy(
      { state: "prepared" },
      {
        ownKeys(target) {
          traps += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, property) {
          traps += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
      }
    );

    expect(() =>
      snapshotPreparedEnvironmentResult({
        environment,
        managedPath: "/private/worktree",
        intentDigest: hex64("d")
      })
    ).toThrow();
    expect(traps).toBe(0);
  });

  it("attaches a rejection observer to the admitted close promise immediately", async () => {
    const observed: unknown[] = [];
    const onUnhandled = (error: unknown) => observed.push(error);
    process.on("unhandledRejection", onUnhandled);
    const source = Promise.reject(new Error("late observer detail"));
    void source.catch(() => undefined);
    const session = snapshotGuardianHostSession({
      sessionId: "immediate-closed-observer",
      async send() {},
      async disconnect() {},
      closed: source
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observed).toEqual([]);
      await expect(session.closed).rejects.toBeDefined();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("uses intrinsic native-Promise settlement without reading an own then accessor", async () => {
    let thenReads = 0;
    const closed = Promise.resolve({ commandId: ids.commandId, releasedLease: true });
    Object.defineProperty(closed, "then", {
      configurable: true,
      get() {
        thenReads += 1;
        throw new Error("own then accessor reached");
      }
    });

    const session = snapshotGuardianHostSession(
      {
        sessionId: "intrinsic-promise",
        async send() {},
        async disconnect() {},
        closed
      },
      ids.commandId
    );

    await expect(session.closed).resolves.toEqual({
      commandId: ids.commandId,
      releasedLease: true
    });
    expect(thenReads).toBe(0);
  });

  it("rejects a guardian close Promise with hostile constructor state before reading it", async () => {
    let constructorReads = 0;
    let disconnects = 0;
    const closed = Promise.resolve({ commandId: ids.commandId, releasedLease: true });
    Object.defineProperty(closed, "constructor", {
      configurable: true,
      get() {
        constructorReads += 1;
        throw new Error("secret Promise constructor detail");
      }
    });
    const raw = {
      sessionId: "hostile-constructor",
      async send() {},
      async disconnect() {
        disconnects += 1;
      },
      closed
    };
    const retained = captureUnadmittedGuardianHostSession(raw);

    expect(() => snapshotGuardianHostSession(raw, ids.commandId)).toThrow(TypeError);
    await retained.disconnect();
    expect({ constructorReads, disconnects }).toEqual({ constructorReads: 0, disconnects: 1 });
  });

  it("rejects hostile native-Promise species in dependency tracking without reading it", async () => {
    let speciesReads = 0;
    const pending = Promise.resolve("settled");
    const hostileConstructor = {};
    Object.defineProperty(hostileConstructor, Symbol.species, {
      get() {
        speciesReads += 1;
        throw new Error("secret Promise species detail");
      }
    });
    Object.defineProperty(pending, "constructor", {
      configurable: true,
      value: hostileConstructor
    });

    await expect(new CommandDependencyTracker().wait(pending, undefined, 5)).rejects.toEqual(
      new CommandExecutorError("unsafe_state")
    );
    expect(speciesReads).toBe(0);
  });

  it("copies genuine Uint8Array bytes without reading own view accessors", () => {
    let accessorReads = 0;
    const source = Uint8Array.from([1, 2, 3, 4]);
    for (const name of ["byteLength", "byteOffset", "buffer"] as const) {
      Object.defineProperty(source, name, {
        configurable: true,
        get() {
          accessorReads += 1;
          throw new Error(`own ${name} accessor reached`);
        }
      });
    }

    expect(snapshotBytes(source, { maximumBytes: 4, exactBytes: 4 })).toEqual(
      Uint8Array.from([1, 2, 3, 4])
    );
    expect(accessorReads).toBe(0);
  });

  it("rejects truthy and proxy guardian close outcomes after asynchronous settlement", async () => {
    for (const outcome of [
      Object.freeze({ commandId: ids.commandId, releasedLease: "yes" }),
      new Proxy(
        { commandId: ids.commandId, releasedLease: true },
        {
          get(target, property, receiver) {
            return Reflect.get(target, property, receiver);
          }
        }
      )
    ]) {
      const session = snapshotGuardianHostSession({
        sessionId: "guardian-close-admission",
        async send() {},
        async disconnect() {},
        closed: Promise.resolve(outcome)
      } as never);

      await expect(session.closed).rejects.toThrow("Guardian close outcome is invalid.");
    }
  });

  it("starts ref'ed supervision immediately for a never-settling dependency timeout", async () => {
    const tracker = new CommandDependencyTracker();
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

    await expect(tracker.wait(pending, undefined, 5)).rejects.toEqual(
      new CommandExecutorError("unsafe_state")
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retained = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    expect(retained).toBeGreaterThan(before);
    expect(tracker.unsettledCount).toBe(1);

    release("settled");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(tracker.unsettledCount).toBe(0);
  });

  it("closes a malformed late activity lease and clears retained supervision", async () => {
    const tracker = new CommandDependencyTracker();
    let closes = 0;
    const late = new Promise<unknown>((resolve) => {
      setTimeout(
        () =>
          resolve({
            environmentId: createId("environment", "20000000-0000-4000-8000-000000000099"),
            commandId: ids.commandId,
            async close() {
              closes += 1;
            }
          }),
        10
      );
    });

    await expect(
      tracker.wait(
        late,
        async (lease) =>
          await closeUnadmittedActiveCommandLease(lease, ids.environmentId, ids.commandId),
        5
      )
    ).rejects.toEqual(new CommandExecutorError("unsafe_state"));
    await vi.waitFor(() => expect(tracker.unsettledCount).toBe(0));
    expect(closes).toBe(1);
  });

  it("caps retained timed-out dependencies before touching another dependency", async () => {
    const tracker = new CommandDependencyTracker(1);
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    await expect(tracker.wait(first, undefined, 5)).rejects.toEqual(
      new CommandExecutorError("unsafe_state")
    );
    let thenReads = 0;
    const hostile = Object.defineProperty({}, "then", {
      get() {
        thenReads += 1;
        return undefined;
      }
    });
    await expect(tracker.wait(hostile as never, undefined, 5)).rejects.toEqual(
      new CommandExecutorError("unsafe_state")
    );
    expect(thenReads).toBe(0);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("converges a valid guardian closure that settles after the lifecycle deadline", async () => {
    const tracker = new CommandDependencyTracker();
    const activity = new CommandActivityCoordinator();
    const lease = await activity.reserveCommand(ids.environmentId, ids.commandId);
    let resolveClosed!: (value: unknown) => void;
    const closed = new Promise<unknown>((resolve) => {
      resolveClosed = resolve;
    });
    const marked: string[] = [];
    let removed = 0;
    const lifecycle = settleGuardianLifecycle({
      commandId: ids.commandId,
      session: {
        sessionId: "late-guardian-close",
        async send() {},
        async disconnect() {},
        closed
      } as never,
      lease,
      dependencies: tracker,
      timeoutMs: 5,
      markSessionClosed: async (commandId) => {
        marked.push(commandId);
      },
      onClosed: () => {
        removed += 1;
      }
    });

    await expect(lifecycle).rejects.toEqual(new CommandExecutorError("unsafe_state"));
    resolveClosed({
      commandId: ids.commandId,
      releasedLease: true,
      terminalFrame: createFrame(
        ids.commandId,
        {
          type: "stream.error",
          workspaceId: ids.workspaceId,
          runId: ids.runId,
          commandId: ids.commandId,
          sequence: 1,
          occurredAt: "2026-08-21T12:00:00.000Z",
          code: "guardian_lost",
          message: "Guardian supervision was lost."
        },
        null
      )
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(marked).toEqual([ids.commandId]);
    expect(removed).toBe(1);
    expect(tracker.unsettledCount).toBe(0);
    await expect(activity.reserveCommand(ids.environmentId, ids.commandId)).resolves.toBeDefined();
  });

  it.each([
    { name: "disconnect rejection", disconnectRejects: true, closeDelayMs: 0 },
    { name: "nested lifecycle deadline", disconnectRejects: false, closeDelayMs: 20 }
  ])(
    "keeps late guardian cleanup independent of the external dependency cap after $name",
    async ({ disconnectRejects, closeDelayMs }) => {
      const tracker = new CommandDependencyTracker(1);
      const activity = new CommandActivityCoordinator();
      const lease = await activity.reserveCommand(ids.environmentId, ids.commandId);
      const retainedLeases = new Set([lease]);
      const retainedSessions = new Set<GuardianHostSession>();
      const registrySessions = new Set<string>();
      let resolveLaunch!: (session: unknown) => void;
      const launch = new Promise<unknown>((resolve) => {
        resolveLaunch = resolve;
      });
      let resolveClosed!: (outcome: unknown) => void;
      const closed = new Promise<unknown>((resolve) => {
        resolveClosed = resolve;
      });
      let disconnects = 0;
      const session = Object.freeze({
        sessionId: "capacity-one-late-guardian",
        async send() {},
        async disconnect() {
          disconnects += 1;
          if (disconnectRejects) throw new TypeError("diagnostic disconnect failed");
        },
        closed
      });
      const waiting = tracker.wait(
        launch,
        async (lateSession) =>
          await settleLateGuardianLaunch({
            commandId: ids.commandId,
            lateSession,
            lease,
            dependencies: tracker,
            timeoutMs: 5,
            registry: {
              async attachSession(commandId) {
                registrySessions.add(commandId);
              },
              async markSessionClosed(commandId) {
                registrySessions.delete(commandId);
              }
            },
            retainedLeases,
            retainedSessions
          }),
        5
      );

      await expect(waiting).rejects.toEqual(new CommandExecutorError("unsafe_state"));
      resolveLaunch(session);
      for (let attempt = 0; attempt < 20 && disconnects === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, closeDelayMs));
      resolveClosed({
        commandId: ids.commandId,
        releasedLease: true,
        terminalFrame: createFrame(
          ids.commandId,
          {
            type: "stream.error",
            workspaceId: ids.workspaceId,
            runId: ids.runId,
            commandId: ids.commandId,
            sequence: 1,
            occurredAt: "2026-08-21T12:00:00.000Z",
            code: "guardian_lost",
            message: "Guardian supervision was lost."
          },
          null
        )
      });
      for (let attempt = 0; attempt < 50 && tracker.unsettledCount !== 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }

      expect(disconnects).toBe(1);
      expect(tracker.unsettledCount).toBe(0);
      expect(registrySessions).toEqual(new Set());
      expect(retainedLeases).toEqual(new Set());
      expect(retainedSessions).toEqual(new Set());
      const replacement = await activity.reserveCommand(ids.environmentId, ids.commandId);
      await replacement.close();
    }
  );

  it("disconnects and retains raw late-launch authority when session admission fails", async () => {
    const tracker = new CommandDependencyTracker();
    const activity = new CommandActivityCoordinator();
    const lease = await activity.reserveCommand(ids.environmentId, ids.commandId);
    const retainedLeases = new Set<Awaited<ReturnType<typeof activity.reserveCommand>>>();
    const retainedSessions = new Set<GuardianHostSession>();
    let disconnects = 0;
    let bindReads = 0;
    const disconnect = async () => {
      disconnects += 1;
    };
    Object.defineProperty(disconnect, "bind", {
      configurable: true,
      get() {
        bindReads += 1;
        throw new Error("disconnect.bind accessor reached");
      }
    });
    const malformed = {
      get sessionId() {
        throw new Error("session accessor reached");
      },
      async send() {},
      disconnect,
      closed: new Promise(() => undefined)
    };

    await expect(
      settleLateGuardianLaunch({
        commandId: ids.commandId,
        lateSession: malformed,
        lease,
        dependencies: tracker,
        timeoutMs: 5,
        registry: {
          async attachSession() {},
          async markSessionClosed() {}
        },
        retainedLeases,
        retainedSessions
      })
    ).rejects.toBeDefined();

    expect(bindReads).toBe(0);
    expect(disconnects).toBe(1);
    expect(retainedLeases).toEqual(new Set([lease]));
    expect(retainedSessions.size).toBe(1);
    await lease.close();
    retainedLeases.clear();
    retainedSessions.clear();
  });

  it("retains immediate raw guardian authority without reading disconnect.bind", async () => {
    const dataRoot = await makeRoot();
    const managedPath = join(dataRoot, "managed");
    await mkdir(managedPath, { mode: 0o700 });
    const fixture = await createAuthorizationFixture();
    const activity = new CommandActivityCoordinator();
    let disconnects = 0;
    let bindReads = 0;
    const disconnect = async () => {
      disconnects += 1;
    };
    Object.defineProperty(disconnect, "bind", {
      configurable: true,
      get() {
        bindReads += 1;
        throw new Error("disconnect.bind accessor reached");
      }
    });
    const executor = await CommandExecutor.create({
      dataRoot,
      artifactStore: await ArtifactStore.create({ dataRoot }),
      worktrees: {
        async resolvePreparedEnvironment() {
          return {
            environment: {
              environmentId: ids.environmentId,
              workspaceId: ids.workspaceId,
              runId: ids.runId,
              repositoryIdentity: `local-sha256:${hex64("a")}`,
              sourceCommit: "b".repeat(40),
              branch: "autostack/run-feature",
              authorization: fixture.environmentAuthorization,
              state: "prepared" as const,
              preparedAt: "2026-08-21T11:30:00.000Z"
            },
            managedPath,
            intentDigest: hex64("d")
          };
        }
      },
      activity,
      executableResolver: {
        async resolve() {
          return {
            canonicalPath: "/usr/bin/tool",
            identityDigest: hex64("e"),
            async revalidate() {
              return true;
            }
          };
        }
      },
      async resolveCredentials() {
        return [{ credentialRefId: ids.credentialRefId, value: "bounded-secret" }];
      },
      guardianLauncher: {
        async launch() {
          return {
            get sessionId(): string {
              throw new Error("session accessor reached");
            },
            async send() {},
            disconnect,
            closed: new Promise(() => undefined)
          };
        }
      },
      trustedBaseEnvironment: [
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "HOME", value: `${dataRoot}/runtime/home` },
        { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TERM", value: "xterm-256color" }
      ],
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "hostile-bind-session",
        secret: Uint8Array.from({ length: 32 }, () => 7),
        bindingDigest: hex64("f")
      })
    });

    await expect(executor.startCommand(fixture.request)).rejects.toEqual(
      new CommandExecutorError("maintenance_required")
    );
    expect({
      bindReads,
      disconnects,
      supervision: commandExecutorTestControl(executor).supervisionCounts()
    }).toEqual({
      bindReads: 0,
      disconnects: 1,
      supervision: {
        dependencies: 0,
        activityLeases: 1,
        guardianSessions: 1,
        registrySessions: 0
      }
    });
  });

  it("normalizes clocks, bounds, and dependency failures to static executor errors", () => {
    expect(safeCommandTimestamp(() => "2026-08-21T12:00:00Z")).toBe("2026-08-21T12:00:00.000Z");
    for (const clock of [
      () => "invalid",
      () => {
        throw new Error("sensitive clock detail");
      }
    ]) {
      expect(() => safeCommandTimestamp(clock)).toThrow(new CommandExecutorError("unsafe_state"));
    }
    expect(admitPositiveBoundedInteger(1, 2)).toBe(1);
    for (const value of [0, 3, 1.5]) {
      expect(() => admitPositiveBoundedInteger(value, 2)).toThrow(TypeError);
    }
    expect(mapCommandRegistryError(new CommandRegistryError("command_not_found"))).toEqual(
      new CommandExecutorError("unsafe_state")
    );
    expect(mapCommandRegistryError(new Error("sensitive dependency detail"))).toEqual(
      new CommandExecutorError("unsafe_state")
    );
    const forged = new CommandExecutorError("command_conflict");
    const rematerialized = mapCommandRegistryError(forged);
    expect(rematerialized).not.toBe(forged);
    expect(rematerialized).toEqual(new CommandExecutorError("unsafe_state"));
    const forgedRegistry = new CommandRegistryError("command_conflict");
    expect(mapCommandRegistryError(forgedRegistry)).toEqual(
      new CommandExecutorError("unsafe_state")
    );
    expect(mapCommandRegistryError(forgedRegistry)).not.toBe(
      mapCommandRegistryError(forgedRegistry)
    );
    let prototypeReads = 0;
    const rejectingProxy = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        prototypeReads += 1;
        throw new Error("secret rejecting proxy detail");
      }
    });
    expect(mapCommandRegistryError(rejectingProxy)).toEqual(
      new CommandExecutorError("unsafe_state")
    );
    expect(prototypeReads).toBe(0);
  });

  it("fails static on hostile or aggregate-excessive credential results", () => {
    const secondCredentialRefId = createId("credentialRef", "20000000-0000-4000-8000-000000000011");
    const hostile = {
      [Symbol.iterator]() {
        throw new Error("attacker-controlled credential detail");
      }
    };
    expect(() => snapshotCommandCredentials(hostile as never, [ids.credentialRefId])).toThrow(
      new CommandExecutorError("execution_unavailable")
    );
    let returned = 0;
    const unbounded = {
      [Symbol.iterator]() {
        return {
          next() {
            return {
              done: false as const,
              value: { credentialRefId: ids.credentialRefId, value: "bounded" }
            };
          },
          return() {
            returned += 1;
            return Promise.reject(new Error("credential cleanup detail"));
          }
        };
      }
    };
    expect(() => snapshotCommandCredentials(unbounded as never, [ids.credentialRefId])).toThrow(
      new CommandExecutorError("execution_unavailable")
    );
    expect(returned).toBe(1);
    let iteratorReads = 0;
    const accessorIterable = Object.defineProperty({}, Symbol.iterator, {
      enumerable: false,
      get() {
        iteratorReads += 1;
        return function* () {
          yield { credentialRefId: ids.credentialRefId, value: "secret" };
        };
      }
    });
    expect(() =>
      snapshotCommandCredentials(accessorIterable as never, [ids.credentialRefId])
    ).toThrow(new CommandExecutorError("execution_unavailable"));
    expect(iteratorReads).toBe(0);
    let credentialReads = 0;
    const accessorCredential = Object.defineProperties(
      {},
      {
        credentialRefId: {
          enumerable: true,
          get() {
            credentialReads += 1;
            return ids.credentialRefId;
          }
        },
        value: {
          enumerable: true,
          get() {
            credentialReads += 1;
            return "secret";
          }
        }
      }
    );
    expect(() =>
      snapshotCommandCredentials([accessorCredential] as never, [ids.credentialRefId])
    ).toThrow(new CommandExecutorError("execution_unavailable"));
    expect(credentialReads).toBe(0);
    expect(() =>
      snapshotCommandCredentials(
        [
          { credentialRefId: ids.credentialRefId, value: "a".repeat(600_000) },
          { credentialRefId: secondCredentialRefId, value: "b".repeat(600_000) }
        ],
        [ids.credentialRefId, secondCredentialRefId]
      )
    ).toThrow(new CommandExecutorError("execution_unavailable"));
    for (const malformed of [
      [],
      [
        { credentialRefId: ids.credentialRefId, value: "first" },
        { credentialRefId: ids.credentialRefId, value: "duplicate" }
      ],
      [{ credentialRefId: secondCredentialRefId, value: "unexpected" }],
      [{ credentialRefId: ids.credentialRefId, value: "" }],
      [{ credentialRefId: ids.credentialRefId, value: "unsafe\0secret" }]
    ]) {
      expect(() => snapshotCommandCredentials(malformed, [ids.credentialRefId])).toThrow(
        new CommandExecutorError("execution_unavailable")
      );
    }
  });

  it("admits only the exact private, secret-free baseline environment with bounded iteration", async () => {
    const dataRoot = "/private/autostack-data";
    const baseline = [
      { name: "PATH", value: "/usr/bin:/bin" },
      { name: "HOME", value: `${dataRoot}/runtime/home` },
      { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
      { name: "LANG", value: "C" },
      { name: "LC_ALL", value: "C" },
      { name: "TERM", value: "xterm-256color" }
    ] as const;
    expect(snapshotTrustedBaseEnvironment(dataRoot, baseline)).toEqual(baseline);
    for (const malformed of [
      baseline.slice(0, -1),
      [...baseline, { name: "GITHUB_TOKEN", value: "secret" }],
      baseline.map((entry) =>
        entry.name === "HOME" ? { ...entry, value: "/Users/operator" } : entry
      ),
      baseline.map((entry) =>
        entry.name === "PATH" ? { ...entry, value: "relative:/bin" } : entry
      ),
      baseline.map((entry) =>
        entry.name === "TERM" ? { ...entry, value: "attacker-terminal" } : entry
      )
    ]) {
      expect(() => snapshotTrustedBaseEnvironment(dataRoot, malformed)).toThrow(
        new CommandExecutorError("invalid_request")
      );
    }

    let returned = 0;
    const unbounded = {
      [Symbol.iterator]() {
        let index = 0;
        return {
          next() {
            return { done: false as const, value: baseline[index++ % baseline.length] };
          },
          return() {
            returned += 1;
            return Promise.reject(new Error("cleanup detail"));
          }
        };
      }
    };
    expect(() => snapshotTrustedBaseEnvironment(dataRoot, unbounded as never)).toThrow(
      new CommandExecutorError("invalid_request")
    );
    expect(returned).toBe(1);
    let baselineIteratorReads = 0;
    const accessorIterable = Object.defineProperty({}, Symbol.iterator, {
      get() {
        baselineIteratorReads += 1;
        return () => baseline[Symbol.iterator]();
      }
    });
    expect(() => snapshotTrustedBaseEnvironment(dataRoot, accessorIterable as never)).toThrow(
      new CommandExecutorError("invalid_request")
    );
    expect(baselineIteratorReads).toBe(0);

    const reads = new Map<string, number>();
    const accessorBaseline = baseline.map((entry) => {
      const record: Record<string, unknown> = {};
      for (const key of ["name", "value"] as const) {
        Object.defineProperty(record, key, {
          enumerable: true,
          get() {
            reads.set(`${entry.name}:${key}`, (reads.get(`${entry.name}:${key}`) ?? 0) + 1);
            return entry[key];
          }
        });
      }
      return record;
    });
    expect(() => snapshotTrustedBaseEnvironment(dataRoot, accessorBaseline as never)).toThrow(
      new CommandExecutorError("invalid_request")
    );
    expect([...reads.values()]).toEqual([]);

    const realRoot = await makeRoot();
    const home = join(realRoot, "runtime", "home");
    const temporary = join(realRoot, "runtime", "tmp");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const runtimeModule = await import("../src/command-runtime-preparation.js");
    const validatePaths = (
      runtimeModule as unknown as {
        validateTrustedBaseEnvironmentPaths(
          root: string,
          environment: readonly { readonly name: string; readonly value: string }[]
        ): Promise<void>;
      }
    ).validateTrustedBaseEnvironmentPaths;
    const realBaseline = baseline.map((entry) =>
      entry.name === "HOME"
        ? { ...entry, value: home }
        : entry.name === "TMPDIR"
          ? { ...entry, value: temporary }
          : entry
    );
    await expect(validatePaths(realRoot, realBaseline)).resolves.toBeUndefined();
    await chmod(home, 0o755);
    await expect(validatePaths(realRoot, realBaseline)).rejects.toEqual(
      new CommandExecutorError("invalid_request")
    );
    await chmod(home, 0o700);
    await rm(temporary, { recursive: true });
    await symlink(home, temporary);
    await expect(validatePaths(realRoot, realBaseline)).rejects.toEqual(
      new CommandExecutorError("invalid_request")
    );

    const staleCommand = createId("command", "20000000-0000-4000-8000-000000000099");
    const staleComponent = Buffer.from(staleCommand, "utf8").toString("hex");
    const staleRuntime = join(realRoot, "runtime", "commands", staleComponent);
    await mkdir(staleRuntime, { recursive: true, mode: 0o700 });
    await symlink(home, join(staleRuntime, "home"));
    await mkdir(join(staleRuntime, "tmp"), { mode: 0o700 });
    await expect(
      createCommandPrivateBaseEnvironment(realRoot, staleCommand, realBaseline)
    ).rejects.toEqual(new CommandExecutorError("execution_unavailable"));
  });

  it("rejects malformed executable, guardian-session, and missing-secret capabilities", async () => {
    const fixture = await createAuthorizationFixture();
    for (const executable of [
      { canonicalPath: "relative/tool", identityDigest: hex64("a"), revalidate: async () => true },
      { canonicalPath: "/usr/bin/tool", identityDigest: "bad", revalidate: async () => true },
      { canonicalPath: "/usr/bin/tool", identityDigest: hex64("a"), revalidate: null }
    ]) {
      expect(() => snapshotResolvedExecutable(executable as never)).toThrow(
        new CommandExecutorError("execution_unavailable")
      );
    }
    for (const session of [
      { sessionId: "", bindingDigest: hex64("a"), secret: new Uint8Array(32) },
      { sessionId: "session", bindingDigest: "bad", secret: new Uint8Array(32) },
      { sessionId: "session", bindingDigest: hex64("a"), secret: new Uint8Array(31) }
    ]) {
      expect(() => snapshotGuardianSession(session)).toThrow(
        new CommandExecutorError("execution_unavailable")
      );
    }
    expect(() => materializeCommandEnvironment([], fixture.request, new Map())).toThrow(
      new CommandExecutorError("execution_unavailable")
    );
    let executableReads = 0;
    const accessorExecutable = Object.defineProperty({}, "canonicalPath", {
      enumerable: true,
      get() {
        executableReads += 1;
        return "/usr/bin/tool";
      }
    });
    expect(() => snapshotResolvedExecutable(accessorExecutable as never)).toThrow(
      new CommandExecutorError("execution_unavailable")
    );
    expect(executableReads).toBe(0);
    let sessionReads = 0;
    const accessorSession = Object.defineProperty({}, "sessionId", {
      enumerable: true,
      get() {
        sessionReads += 1;
        return "session";
      }
    });
    expect(() => snapshotGuardianSession(accessorSession as never)).toThrow(
      new CommandExecutorError("execution_unavailable")
    );
    expect(sessionReads).toBe(0);
  });

  it("does not follow a runtime ancestor symlink while creating trusted base paths", async () => {
    const dataRoot = await makeRoot();
    const external = await makeRoot();
    await symlink(external, join(dataRoot, "runtime"));
    const baseline = [
      { name: "PATH", value: "/usr/bin:/bin" },
      { name: "HOME", value: join(dataRoot, "runtime", "home") },
      { name: "TMPDIR", value: join(dataRoot, "runtime", "tmp") },
      { name: "LANG", value: "C" },
      { name: "LC_ALL", value: "C" },
      { name: "TERM", value: "xterm-256color" }
    ] as const;

    await expect(validateTrustedBaseEnvironmentPaths(dataRoot, baseline)).rejects.toEqual(
      new CommandExecutorError("invalid_request")
    );
    expect(await readdir(external)).toEqual([]);
  });

  it("does not follow a command-runtime ancestor symlink while creating private paths", async () => {
    const dataRoot = await makeRoot();
    const external = await makeRoot();
    await mkdir(join(dataRoot, "runtime"), { mode: 0o700 });
    await symlink(external, join(dataRoot, "runtime", "commands"));
    const baseline = [
      { name: "PATH", value: "/usr/bin:/bin" },
      { name: "HOME", value: join(dataRoot, "runtime", "home") },
      { name: "TMPDIR", value: join(dataRoot, "runtime", "tmp") },
      { name: "LANG", value: "C" },
      { name: "LC_ALL", value: "C" },
      { name: "TERM", value: "xterm-256color" }
    ] as const;

    await expect(
      createCommandPrivateBaseEnvironment(dataRoot, ids.commandId, baseline)
    ).rejects.toEqual(new CommandExecutorError("execution_unavailable"));
    expect(await readdir(external)).toEqual([]);
  });

  it("derives the guardian binding without persisting the raw session secret encoding", () => {
    const secret = Uint8Array.from({ length: 32 }, () => 0xab);
    const rawSecretHex = Buffer.from(secret).toString("hex");

    const session = snapshotGuardianSession({
      sessionId: "derived-binding",
      secret,
      bindingDigest: rawSecretHex
    });

    expect(session.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(session.bindingDigest).not.toBe(rawSecretHex);
    expect(JSON.stringify(session)).not.toContain(rawSecretHex);
  });

  it("pins a real cwd inode and rejects symlinked or replaced paths", async () => {
    const root = await makeRoot();
    const nested = join(root, "nested");
    const linked = join(root, "linked");
    await mkdir(nested, { mode: 0o700 });
    await symlink(nested, linked);

    await expect(pinCommandCwd(root, "linked")).rejects.toEqual(
      new CommandExecutorError("environment_conflict")
    );
    const pinned = await pinCommandCwd(root, "nested");
    expect(await pinned.revalidate()).toBe(true);
    await rename(nested, join(root, "moved"));
    await mkdir(nested, { mode: 0o700 });
    expect(await pinned.revalidate()).toBe(false);
    await rm(nested, { recursive: true });
    expect(await pinned.revalidate()).toBe(false);
  });

  it("rejects command attempts to replace the trusted base environment", async () => {
    const fixture = await createAuthorizationFixture("two", [
      { kind: "literal", name: "PATH", value: "/attacker/bin" }
    ]);
    expect(() =>
      validateCommandEnvironmentNames([{ name: "PATH", value: "/usr/bin:/bin" }], fixture.request)
    ).toThrow(new CommandExecutorError("invalid_request"));
  });

  it("fails static on malformed options and hostile request accessors", async () => {
    await expect(CommandExecutor.create(null as never)).rejects.toEqual(
      new CommandExecutorError("invalid_request")
    );
    await expect(CommandExecutor.create({ dataRoot: "relative" } as never)).rejects.toEqual(
      new CommandExecutorError("invalid_request")
    );
    let optionReads = 0;
    const accessorOptions = {} as Record<string, unknown>;
    Object.defineProperty(accessorOptions, "dataRoot", {
      enumerable: true,
      get() {
        optionReads += 1;
        return "/private/autostack";
      }
    });
    await expect(CommandExecutor.create(accessorOptions as never)).rejects.toEqual(
      new CommandExecutorError("invalid_request")
    );
    expect(optionReads).toBe(0);
    const fixture = await createAuthorizationFixture();
    const hostile = Object.defineProperty({ ...fixture.request }, "command", {
      enumerable: true,
      get() {
        throw new Error("attacker-controlled request detail");
      }
    });
    await expect(CommandExecutor.validateRequest(hostile as never)).rejects.toEqual(
      new CommandExecutorError("invalid_request")
    );

    let requestProxyTraps = 0;
    const requestProxy = new Proxy(fixture.request, {
      ownKeys() {
        requestProxyTraps += 1;
        return [];
      }
    });
    await expect(CommandExecutor.validateRequest(requestProxy)).rejects.toEqual(
      new CommandExecutorError("invalid_request")
    );
    expect(requestProxyTraps).toBe(0);

    const dataRoot = await makeRoot();
    const baseline = [
      new Proxy(
        { name: "PATH", value: "/usr/bin:/bin" },
        {
          ownKeys() {
            requestProxyTraps += 1;
            return [];
          }
        }
      ),
      { name: "HOME", value: `${dataRoot}/runtime/home` },
      { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
      { name: "LANG", value: "C" },
      { name: "LC_ALL", value: "C" },
      { name: "TERM", value: "xterm-256color" }
    ];
    expect(() => snapshotTrustedBaseEnvironment(dataRoot, baseline)).toThrow(
      new CommandExecutorError("invalid_request")
    );
    expect(requestProxyTraps).toBe(0);

    const artifactStore = await ArtifactStore.create({ dataRoot });
    let artifactProxyTraps = 0;
    const artifactPrototype = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        artifactProxyTraps += 1;
        return ArtifactStore.prototype;
      }
    });
    const artifactProxy = Object.create(artifactPrototype) as ArtifactStore;
    expect(() =>
      snapshotCommandExecutorOptions({
        dataRoot,
        worktrees: {
          async resolvePreparedEnvironment() {
            throw new TypeError();
          }
        },
        artifactStore: artifactProxy,
        activity: {
          async reserveCommand() {
            throw new TypeError();
          },
          async acquireEnvironmentQuiescence() {
            throw new TypeError();
          },
          closeAdmission() {}
        },
        guardianLauncher: {
          async launch() {
            throw new TypeError();
          }
        },
        async resolveCredentials() {
          return [];
        },
        executableResolver: {
          async resolve() {
            throw new TypeError();
          }
        },
        trustedBaseEnvironment: [
          { name: "PATH", value: "/usr/bin:/bin" },
          { name: "HOME", value: `${dataRoot}/runtime/home` },
          { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
          { name: "LANG", value: "C" },
          { name: "LC_ALL", value: "C" },
          { name: "TERM", value: "xterm-256color" }
        ],
        limits: {
          eventBytes: 65_536,
          replayBytes: 1_048_576,
          transcriptBytes: 1_048_576,
          artifactBytes: 1_048_576,
          cancellationGraceMs: 1,
          eofSettleMs: 1,
          subscriberQueueFrames: 64,
          subscriberQueueBytes: 1_048_576
        },
        now: () => "2026-08-21T12:00:00.000Z",
        monotonicNowMs: () => 100,
        createArtifactId: () => ids.artifactId,
        createGuardianSession: () => ({
          sessionId: "proxy-artifact",
          secret: new Uint8Array(32),
          bindingDigest: hex64("f")
        })
      } as never)
    ).toThrow(new CommandExecutorError("invalid_request"));
    expect(artifactProxyTraps).toBe(0);
  });

  it("caps pre-registry starts before dependencies and quiesce waits admitted starts", async () => {
    const dataRoot = await makeRoot();
    const managedPath = join(dataRoot, "managed");
    await mkdir(managedPath, { mode: 0o700 });
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const activity = new CommandActivityCoordinator();
    const pty = new FakePtyFactory();
    const processTree = new FakeProcessTreeController();
    const preparedAdmission = await createAuthorizationFixture();
    let releaseWorktree!: () => void;
    const worktreeGate = new Promise<void>((resolve) => {
      releaseWorktree = resolve;
    });
    let resolveReserved!: () => void;
    let reserveCalls = 0;
    const reserved = new Promise<void>((resolve) => {
      resolveReserved = resolve;
    });
    const executor = await CommandExecutor.create({
      dataRoot,
      worktrees: {
        async resolvePreparedEnvironment() {
          await worktreeGate;
          return {
            environment: {
              environmentId: ids.environmentId,
              workspaceId: ids.workspaceId,
              runId: ids.runId,
              repositoryIdentity: `local-sha256:${hex64("a")}`,
              sourceCommit: "b".repeat(40),
              branch: "autostack/run-feature",
              authorization: preparedAdmission.environmentAuthorization,
              state: "prepared" as const,
              preparedAt: "2026-08-21T11:30:00.000Z"
            },
            managedPath,
            intentDigest: hex64("d")
          };
        }
      },
      artifactStore,
      activity: {
        async reserveCommand(environmentId, commandId) {
          reserveCalls += 1;
          resolveReserved();
          return await activity.reserveCommand(environmentId, commandId);
        },
        acquireEnvironmentQuiescence: (environmentId) =>
          activity.acquireEnvironmentQuiescence(environmentId),
        closeAdmission: () => activity.closeAdmission()
      },
      guardianLauncher: {
        async launch(bootstrap, observer) {
          return await new FakeAuthenticatedGuardianLauncher({
            artifactStore,
            spawnAuthority: Object.assign(pty, { processTreeAuthority: processTree }),
            now: () => "2026-08-21T12:00:01.000Z",
            monotonicNowMs: () => 100
          }).launch(bootstrap, observer);
        }
      },
      async resolveCredentials() {
        return [{ credentialRefId: ids.credentialRefId, value: "bounded-secret" }];
      },
      executableResolver: {
        async resolve() {
          return {
            canonicalPath: "/usr/bin/tool",
            identityDigest: hex64("e"),
            async revalidate() {
              return true;
            }
          };
        }
      },
      trustedBaseEnvironment: [
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "HOME", value: `${dataRoot}/runtime/home` },
        { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TERM", value: "xterm-256color" }
      ],
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "pending-guardian",
        secret: Uint8Array.from({ length: 32 }, () => 3),
        bindingDigest: hex64("f")
      })
    });
    const starting = executor.startCommand(preparedAdmission.request);
    await reserved;
    const queued = Array.from({ length: 255 }, () =>
      executor.startCommand(preparedAdmission.request)
    );
    const overflow = executor.startCommand(preparedAdmission.request);
    const overflowEarly = await Promise.race([
      overflow.then(
        () => "fulfilled" as const,
        () => "rejected" as const
      ),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50))
    ]);
    expect(reserveCalls).toBe(1);
    let quiesced = false;
    const quiescing = executor.quiesce().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    releaseWorktree();
    await Promise.allSettled([starting, ...queued, overflow]);
    await quiescing;
    expect(overflowEarly).toBe("rejected");
    expect(commandExecutorTestControl(executor).activeGuardianCount()).toBe(1);
    await expect(executor.startCommand(preparedAdmission.request)).rejects.toEqual(
      new CommandExecutorError("closed")
    );
    await expect(executor.interruptAndDrain()).resolves.toMatchObject({
      remainingGuardianLeaseCount: 0
    });
  }, 15_000);

  it("keeps a late failed activity-reservation cleanup sticky and drain-visible", async () => {
    const dataRoot = await makeRoot();
    const managedPath = join(dataRoot, "managed");
    await mkdir(managedPath, { mode: 0o700 });
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const admission = await createAuthorizationFixture();
    const executor = await CommandExecutor.create({
      dataRoot,
      worktrees: {
        async resolvePreparedEnvironment() {
          throw new TypeError("must not reach worktree resolution");
        }
      },
      artifactStore,
      activity: {
        async reserveCommand(environmentId, commandId) {
          await new Promise((resolve) => setTimeout(resolve, 2_050));
          return {
            environmentId,
            commandId,
            async close() {
              throw new TypeError("uncertain late lease cleanup");
            }
          };
        },
        async acquireEnvironmentQuiescence() {
          throw new TypeError();
        },
        closeAdmission() {}
      },
      guardianLauncher: {
        async launch() {
          throw new TypeError();
        }
      },
      async resolveCredentials() {
        return [];
      },
      executableResolver: {
        async resolve() {
          throw new TypeError();
        }
      },
      trustedBaseEnvironment: [
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "HOME", value: `${dataRoot}/runtime/home` },
        { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TERM", value: "xterm-256color" }
      ],
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "late-activity",
        secret: new Uint8Array(32),
        bindingDigest: hex64("f")
      })
    });

    await expect(executor.startCommand(admission.request)).rejects.toEqual(
      new CommandExecutorError("unsafe_state")
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(executor.interruptAndDrain()).rejects.toEqual(
      new CommandExecutorError("maintenance_required")
    );
  }, 5_000);

  it("converges a fully admitted guardian session returned after launcher timeout", async () => {
    const dataRoot = await makeRoot();
    const managedPath = join(dataRoot, "managed");
    await mkdir(managedPath, { mode: 0o700 });
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const activity = new CommandActivityCoordinator();
    const pty = new FakePtyFactory();
    const processTree = new FakeProcessTreeController();
    processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGTERM" });
    pty.processTreeAuthority = processTree;
    const admission = await createAuthorizationFixture("two", undefined, 2);
    let guardianInstant = 1;
    let lateLauncher: FakeAuthenticatedGuardianLauncher | undefined;
    const executor = await CommandExecutor.create({
      dataRoot,
      worktrees: {
        async resolvePreparedEnvironment() {
          return {
            environment: {
              environmentId: ids.environmentId,
              workspaceId: ids.workspaceId,
              runId: ids.runId,
              repositoryIdentity: `local-sha256:${hex64("a")}`,
              sourceCommit: "b".repeat(40),
              branch: "autostack/run-feature",
              authorization: admission.environmentAuthorization,
              state: "prepared" as const,
              preparedAt: "2026-08-21T11:30:00.000Z"
            },
            managedPath,
            intentDigest: hex64("d")
          };
        }
      },
      artifactStore,
      activity,
      guardianLauncher: {
        async launch(bootstrap, observer) {
          await new Promise((resolve) => setTimeout(resolve, 2_050));
          lateLauncher = new FakeAuthenticatedGuardianLauncher({
            artifactStore,
            spawnAuthority: pty,
            now: () => `2026-08-21T12:00:0${guardianInstant++}.000Z`,
            monotonicNowMs: () => 100
          });
          return await lateLauncher.launch(bootstrap, observer);
        }
      },
      async resolveCredentials() {
        return [{ credentialRefId: ids.credentialRefId, value: "late-secret" }];
      },
      executableResolver: {
        async resolve() {
          return {
            canonicalPath: "/usr/bin/tool",
            identityDigest: hex64("e"),
            async revalidate() {
              return true;
            }
          };
        }
      },
      trustedBaseEnvironment: [
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "HOME", value: `${dataRoot}/runtime/home` },
        { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TERM", value: "xterm-256color" }
      ],
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "late-guardian-session",
        secret: Uint8Array.from({ length: 32 }, () => 3),
        bindingDigest: hex64("f")
      })
    });

    await expect(executor.startCommand(admission.request)).rejects.toEqual(
      new CommandExecutorError("maintenance_required")
    );
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const counts = commandExecutorTestControl(executor).supervisionCounts();
      if (
        counts.dependencies === 0 &&
        counts.activityLeases === 0 &&
        counts.guardianSessions === 0 &&
        counts.registrySessions === 0
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect({
      ...commandExecutorTestControl(executor).supervisionCounts(),
      trace: lateLauncher?.protocolTrace
    }).toEqual({
      dependencies: 0,
      activityLeases: 0,
      guardianSessions: 0,
      registrySessions: 0,
      trace: [
        "guardian.hello",
        "guardian.lease_acquired",
        "host.lease_transfer",
        "guardian.phase:lease_transferred",
        "guardian.phase:spawned",
        "guardian.event_committed:command.started",
        "guardian.phase:running",
        "guardian.phase:finalizing",
        "guardian.event_committed:artifact.created",
        "guardian.event_committed:command.completed",
        "guardian.phase:terminal",
        "guardian.terminal"
      ]
    });
    await expect(executor.interruptAndDrain()).resolves.toMatchObject({
      remainingGuardianLeaseCount: 0
    });
  }, 10_000);

  it("closes an immediate activity lease whose identity fails admission", async () => {
    const dataRoot = await makeRoot();
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const fixture = await createAuthorizationFixture();
    let closes = 0;
    let rejectReservation = false;
    let rejectionPrototypeReads = 0;
    const rejectingReservation = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        rejectionPrototypeReads += 1;
        throw new Error("secret reservation rejection detail");
      }
    });
    const executor = await CommandExecutor.create({
      dataRoot,
      worktrees: {
        async resolvePreparedEnvironment() {
          throw new TypeError("must not reach worktree resolution");
        }
      },
      artifactStore,
      activity: {
        async reserveCommand(_environmentId, commandId) {
          if (rejectReservation) throw rejectingReservation;
          return {
            environmentId: createId("environment", "20000000-0000-4000-8000-000000000099"),
            commandId,
            async close() {
              closes += 1;
            }
          };
        },
        async acquireEnvironmentQuiescence() {
          return undefined;
        },
        closeAdmission() {}
      },
      guardianLauncher: {
        async launch() {
          throw new TypeError("must not launch");
        }
      },
      async resolveCredentials() {
        return [];
      },
      executableResolver: {
        async resolve() {
          throw new TypeError("must not resolve executable");
        }
      },
      trustedBaseEnvironment: [
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "HOME", value: `${dataRoot}/runtime/home` },
        { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TERM", value: "xterm-256color" }
      ],
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "wrong-activity-identity",
        secret: new Uint8Array(32),
        bindingDigest: hex64("f")
      })
    });

    await expect(executor.startCommand(fixture.request)).rejects.toEqual(
      new CommandExecutorError("unsafe_state")
    );
    expect(closes).toBe(1);
    await expect(
      access(join(dataRoot, "commands", Buffer.from(ids.commandId).toString("hex")))
    ).rejects.toBeDefined();
    rejectReservation = true;
    await expect(executor.startCommand(fixture.request)).rejects.toEqual(
      new CommandExecutorError("unsafe_state")
    );
    expect(rejectionPrototypeReads).toBe(0);
  });

  it("reserves before worktree lookup, publishes intent before launch, and replays without secrets", async () => {
    const dataRoot = await makeRoot();
    const managedPath = join(dataRoot, "managed");
    await mkdir(managedPath, { mode: 0o700 });
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const activity = new CommandActivityCoordinator();
    const pty = new FakePtyFactory();
    const processTree = new FakeProcessTreeController();
    const trace: string[] = [];
    let credentialCalls = 0;
    let launchCalls = 0;
    let capturedBootstrap: GuardianBootstrap | undefined;
    let releaseLaunch!: () => void;
    let enterLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const launchEntered = new Promise<void>((resolve) => {
      enterLaunch = resolve;
    });
    const preparedAdmission = await createAuthorizationFixture();
    const executor = await CommandExecutor.create({
      dataRoot,
      worktrees: {
        async resolvePreparedEnvironment() {
          trace.push("worktree");
          return {
            environment: {
              environmentId: ids.environmentId,
              workspaceId: ids.workspaceId,
              runId: ids.runId,
              repositoryIdentity: `local-sha256:${hex64("a")}`,
              sourceCommit: "b".repeat(40),
              branch: "autostack/run-feature",
              authorization: preparedAdmission.environmentAuthorization,
              state: "prepared",
              preparedAt: "2026-08-21T11:30:00.000Z"
            },
            managedPath,
            intentDigest: hex64("d")
          };
        }
      },
      artifactStore,
      activity: {
        async reserveCommand(environmentId, commandId) {
          trace.push("reserve");
          return await activity.reserveCommand(environmentId, commandId);
        },
        acquireEnvironmentQuiescence: (environmentId) =>
          activity.acquireEnvironmentQuiescence(environmentId),
        closeAdmission: () => activity.closeAdmission()
      },
      guardianLauncher: {
        async launch(bootstrap: GuardianBootstrap, observer: GuardianHostObserver) {
          launchCalls += 1;
          capturedBootstrap = bootstrap;
          await access(join(dataRoot, bootstrap.intentRelativePath));
          trace.push("launch");
          enterLaunch();
          await launchGate;
          let guardianInstant = 1;
          return await new FakeAuthenticatedGuardianLauncher({
            artifactStore,
            spawnAuthority: Object.assign(pty, { processTreeAuthority: processTree }),
            now: () => `2026-08-21T12:00:0${guardianInstant++}.000Z`,
            monotonicNowMs: () => 100
          }).launch(bootstrap, observer);
        }
      },
      async resolveCredentials() {
        trace.push("credentials");
        credentialCalls += 1;
        return [{ credentialRefId: ids.credentialRefId, value: "super-secret" }];
      },
      executableResolver: {
        async resolve(request) {
          trace.push("executable");
          expect(request.environment).toEqual([{ name: "PATH", value: "/usr/bin:/bin" }]);
          return {
            canonicalPath: "/usr/bin/tool",
            identityDigest: hex64("e"),
            async revalidate() {
              return true;
            }
          };
        }
      },
      trustedBaseEnvironment: [
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "HOME", value: `${dataRoot}/runtime/home` },
        { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TERM", value: "xterm-256color" }
      ],
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "guardian-session",
        secret: Uint8Array.from({ length: 32 }, () => 1),
        bindingDigest: hex64("f")
      })
    });
    const fixture = preparedAdmission;
    const cancellation = {
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      commandId: ids.commandId,
      environmentAuthorizationId: fixture.environmentAuthorization.id,
      environmentAuthorizationDigest: fixture.environmentAuthorization.digest,
      commandAuthorizationId: fixture.commandAuthorization.id,
      commandAuthorizationDigest: fixture.commandAuthorization.digest,
      idempotency: { key: "cancel-attempt" }
    };
    const starts = Promise.all([
      executor.startCommand(fixture.request),
      executor.startCommand(fixture.request)
    ]);
    await launchEntered;
    const pendingCancellation = executor.cancelCommand(cancellation);
    void pendingCancellation.catch(() => undefined);
    await Promise.resolve();
    releaseLaunch();
    const concurrentStarts = await starts;
    expect(concurrentStarts).toEqual([
      expect.objectContaining({ commandId: ids.commandId, replayed: false }),
      expect.objectContaining({ commandId: ids.commandId, replayed: true })
    ]);
    expect(trace).toEqual(["reserve", "worktree", "executable", "credentials", "launch"]);
    expect(credentialCalls).toBe(1);
    expect(launchCalls).toBe(1);
    const commandComponent = Buffer.from(ids.commandId, "utf8").toString("hex");
    expect(capturedBootstrap?.envelope.environment).toEqual([
      { name: "PATH", value: "/usr/bin:/bin" },
      { name: "HOME", value: `${dataRoot}/runtime/commands/${commandComponent}/home` },
      { name: "TMPDIR", value: `${dataRoot}/runtime/commands/${commandComponent}/tmp` },
      { name: "LANG", value: "C" },
      { name: "LC_ALL", value: "C" },
      { name: "TERM", value: "xterm-256color" },
      { name: "AUTOSTACK_MODE", value: "test" },
      { name: "GITHUB_TOKEN", value: "super-secret" }
    ]);

    expect(await pendingCancellation).toEqual({
      commandId: ids.commandId,
      cancelled: true,
      replayed: false
    });
    expect(await executor.cancelCommand(cancellation)).toEqual({
      commandId: ids.commandId,
      cancelled: true,
      replayed: true
    });
    await expect(
      executor.cancelCommand({ ...cancellation, idempotency: { key: "conflicting-cancel" } })
    ).rejects.toEqual(new CommandExecutorError("command_conflict"));
    expect(await executor.startCommand(fixture.request)).toMatchObject({
      commandId: ids.commandId,
      replayed: true
    });
    expect(credentialCalls).toBe(1);
    expect(launchCalls).toBe(1);
    const recovered = await (
      await ReplaySpool.open({ dataRoot, commandId: ids.commandId })
    ).recover();
    expect(JSON.stringify(recovered)).not.toContain("super-secret");
    const rawGuardianSecretHex = "01".repeat(32);
    expect(recovered.intent.guardianSessionBindingDigest).not.toBe(rawGuardianSecretHex);
    expect(JSON.stringify(recovered)).not.toContain(rawGuardianSecretHex);
    const protocolFailureRequest = {
      workspaceId: ids.workspaceId,
      runId: ids.runId,
      environmentId: ids.environmentId,
      commandId: ids.commandId,
      environmentAuthorizationId: fixture.environmentAuthorization.id,
      environmentAuthorizationDigest: fixture.environmentAuthorization.digest,
      commandAuthorizationId: fixture.commandAuthorization.id,
      commandAuthorizationDigest: fixture.commandAuthorization.digest,
      after: 0
    } as const;
    await expect(
      executor.terminalizeProtocolFailure(protocolFailureRequest, "output_quarantined")
    ).rejects.toEqual(new CommandExecutorError("command_conflict"));
    expect(
      (await (await ReplaySpool.open({ dataRoot, commandId: ids.commandId })).recover()).events
    ).toHaveLength(recovered.events.length);
    await expect(
      executor.terminalizeProtocolFailure(
        { ...protocolFailureRequest, workspaceId: ids.workspaceId.replace("2", "3") as never },
        "output_quarantined"
      )
    ).rejects.toEqual(new CommandExecutorError("invalid_request"));
    await expect(
      executor.resolveOwnedArtifact({
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        environmentId: ids.environmentId,
        commandId: ids.commandId,
        artifactId: ids.artifactId,
        environmentAuthorizationId: fixture.environmentAuthorization.id,
        environmentAuthorizationDigest: fixture.environmentAuthorization.digest,
        commandAuthorizationId: fixture.commandAuthorization.id,
        commandAuthorizationDigest: fixture.commandAuthorization.digest,
        offset: 0,
        length: 1
      })
    ).resolves.toMatchObject({ artifactId: ids.artifactId, commandId: ids.commandId });

    await expect(
      executor.startCommand((await createAuthorizationFixture("changed")).request)
    ).rejects.toEqual(new CommandExecutorError("command_conflict"));
    expect(credentialCalls).toBe(1);
    expect(launchCalls).toBe(1);
    expect(await executor.interruptAndDrain()).toEqual({
      interruptedCommandIds: [],
      releasedGuardianLeaseCount: 0,
      remainingGuardianLeaseCount: 0
    });
    await executor.close();
  });

  it.each([
    { name: "argument", lastArgument: "prefix-cucumber-suffix" },
    {
      name: "literal environment",
      environment: [
        { kind: "literal" as const, name: "AUTOSTACK_MODE", value: "prefix-cucumber-suffix" },
        {
          kind: "credential_ref" as const,
          name: "GITHUB_TOKEN",
          credentialRefId: ids.credentialRefId
        }
      ]
    },
    { name: "requested executable", executable: "cucumber-tool" },
    { name: "resolved executable path", resolvedExecutable: "/usr/bin/cucumber-tool" },
    { name: "working-directory path", cwd: "cucumber" }
  ])("rejects resolved-secret overlap in $name before durable command state", async (variant) => {
    const dataRoot = await makeRoot();
    const managedPath = join(dataRoot, "managed");
    await mkdir(managedPath, { mode: 0o700 });
    if (variant.cwd !== undefined) await mkdir(join(managedPath, variant.cwd), { mode: 0o700 });
    const fixture = await createAuthorizationFixture(
      variant.lastArgument,
      variant.environment,
      10,
      variant.executable,
      variant.cwd
    );
    const activity = new CommandActivityCoordinator();
    let launchCalls = 0;
    let credentialCalls = 0;
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const executor = await CommandExecutor.create({
      dataRoot,
      artifactStore,
      worktrees: {
        async resolvePreparedEnvironment() {
          return {
            environment: {
              environmentId: ids.environmentId,
              workspaceId: ids.workspaceId,
              runId: ids.runId,
              repositoryIdentity: `local-sha256:${hex64("a")}`,
              sourceCommit: "b".repeat(40),
              branch: "autostack/run-feature",
              authorization: fixture.environmentAuthorization,
              state: "prepared" as const,
              preparedAt: "2026-08-21T11:30:00.000Z"
            },
            managedPath,
            intentDigest: hex64("d")
          };
        }
      },
      activity,
      executableResolver: {
        async resolve() {
          return {
            canonicalPath: variant.resolvedExecutable ?? "/usr/bin/tool",
            identityDigest: hex64("e"),
            async revalidate() {
              return true;
            }
          };
        }
      },
      async resolveCredentials() {
        credentialCalls += 1;
        return [{ credentialRefId: ids.credentialRefId, value: "cucumber" }];
      },
      guardianLauncher: {
        async launch() {
          launchCalls += 1;
          throw new Error("guardian launch must remain unreachable");
        }
      },
      trustedBaseEnvironment: [
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "HOME", value: `${dataRoot}/runtime/home` },
        { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TERM", value: "xterm-256color" }
      ],
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "secret-overlap-session",
        secret: Uint8Array.from({ length: 32 }, () => 7),
        bindingDigest: hex64("f")
      })
    });
    let captured: unknown;
    try {
      await executor.startCommand(fixture.request);
    } catch (error) {
      captured = error;
    }
    const commandComponent = Buffer.from(ids.commandId, "utf8").toString("hex");

    expect(captured).toEqual(new CommandExecutorError("invalid_request"));
    expect(JSON.stringify(captured)).not.toContain("cucumber");
    expect(credentialCalls).toBe(1);
    expect(launchCalls).toBe(0);
    await expect(access(join(dataRoot, "commands", commandComponent))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(
      access(join(dataRoot, "runtime", "commands", commandComponent))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(artifactStore.findArtifact(ids.artifactId)).resolves.toBeUndefined();
    expect(commandExecutorTestControl(executor).supervisionCounts()).toEqual({
      dependencies: 0,
      activityLeases: 0,
      guardianSessions: 0,
      registrySessions: 0
    });
    await expect(executor.interruptAndDrain()).resolves.toMatchObject({
      remainingGuardianLeaseCount: 0
    });
    await executor.close();
  });

  it.each(["executable", "credentials", "revalidation", "metadata", "intent"] as const)(
    "leaves no unjournaled runtime topology after a %s pre-intent failure",
    async (failure) => {
      const dataRoot = await makeRoot();
      const managedPath = join(dataRoot, "managed");
      await mkdir(managedPath, { mode: 0o700 });
      const fixture = await createAuthorizationFixture();
      const activity = new CommandActivityCoordinator();
      const artifactStore = await ArtifactStore.create({ dataRoot });
      const executor = await CommandExecutor.create({
        dataRoot,
        artifactStore,
        worktrees: {
          async resolvePreparedEnvironment() {
            return {
              environment: {
                environmentId: ids.environmentId,
                workspaceId: ids.workspaceId,
                runId: ids.runId,
                repositoryIdentity: `local-sha256:${hex64("a")}`,
                sourceCommit: "b".repeat(40),
                branch: "autostack/run-feature",
                authorization: fixture.environmentAuthorization,
                state: "prepared" as const,
                preparedAt: "2026-08-21T11:30:00.000Z"
              },
              managedPath,
              intentDigest: hex64("d")
            };
          }
        },
        activity,
        executableResolver: {
          async resolve() {
            if (failure === "executable") throw new Error("resolver failed");
            return {
              canonicalPath: "/usr/bin/tool",
              identityDigest: hex64("e"),
              async revalidate() {
                return failure !== "revalidation";
              }
            };
          }
        },
        async resolveCredentials() {
          if (failure === "credentials") throw new Error("credential resolution failed");
          return [{ credentialRefId: ids.credentialRefId, value: "bounded-secret" }];
        },
        guardianLauncher: {
          async launch() {
            throw new Error("guardian launch must remain unreachable");
          }
        },
        trustedBaseEnvironment: [
          { name: "PATH", value: "/usr/bin:/bin" },
          { name: "HOME", value: `${dataRoot}/runtime/home` },
          { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
          { name: "LANG", value: "C" },
          { name: "LC_ALL", value: "C" },
          { name: "TERM", value: "xterm-256color" }
        ],
        limits: {
          eventBytes: 65_536,
          replayBytes: 1_048_576,
          transcriptBytes: 1_048_576,
          artifactBytes: 1_048_576,
          cancellationGraceMs: 1,
          eofSettleMs: 1,
          subscriberQueueFrames: 64,
          subscriberQueueBytes: 1_048_576
        },
        now: () => "2026-08-21T12:00:00.000Z",
        monotonicNowMs: () => 100,
        createArtifactId: () => {
          if (failure === "metadata") throw new Error("metadata failed");
          return ids.artifactId;
        },
        createGuardianSession: () => ({
          sessionId: "pre-intent-failure",
          secret: Uint8Array.from({ length: 32 }, () => 7),
          bindingDigest: hex64("f")
        })
      });

      const commandComponent = Buffer.from(ids.commandId, "utf8").toString("hex");
      if (failure === "intent") {
        const receiptRoot = join(dataRoot, "commands", commandComponent, "receipt");
        await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
        await writeFile(join(receiptRoot, "01-intent.json"), "{}", { mode: 0o600 });
      }

      await expect(executor.startCommand(fixture.request)).rejects.toBeInstanceOf(
        CommandExecutorError
      );
      await expect(
        access(join(dataRoot, "runtime", "commands", commandComponent))
      ).rejects.toMatchObject({ code: "ENOENT" });
      if (failure !== "intent") {
        await expect(access(join(dataRoot, "commands", commandComponent))).rejects.toMatchObject({
          code: "ENOENT"
        });
      }
      expect(commandExecutorTestControl(executor).supervisionCounts()).toMatchObject({
        activityLeases: 0,
        guardianSessions: 0
      });
      await executor.close();
    }
  );

  it("rejects dangerous loader variables before any execution side effect", async () => {
    for (const name of [
      "LD_PRELOAD",
      "PYTHONSTARTUP",
      "JAVA_TOOL_OPTIONS",
      "_JAVA_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "LUA_INIT",
      "LUA_INIT_5_4",
      "PHPRC",
      "PHP_INI_SCAN_DIR",
      "GIT_SSH_COMMAND",
      "GIT_SSH",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_EXEC_PATH",
      "GIT_PAGER",
      "PAGER",
      "GIT_EDITOR",
      "GIT_SEQUENCE_EDITOR",
      "GIT_EXTERNAL_DIFF",
      "VISUAL",
      "EDITOR",
      "LESSOPEN",
      "LESSCLOSE",
      "RUSTC_WRAPPER",
      "RUSTC_WORKSPACE_WRAPPER",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "RUSTDOC",
      "RUSTDOC_WRAPPER",
      "CARGO_BUILD_RUSTDOC",
      "CARGO_BUILD_RUSTDOC_WRAPPER",
      "RUSTFLAGS",
      "CARGO_ENCODED_RUSTFLAGS",
      "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER",
      "CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER",
      "CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS",
      "GOROOT",
      "GOTOOLDIR",
      "GOTOOLCHAIN",
      "GOFLAGS",
      "GCCGO",
      "GCC_EXEC_PREFIX",
      "COMPILER_PATH",
      "AR",
      "AS",
      "LD",
      "PKG_CONFIG",
      "NPM_CONFIG_SCRIPT_SHELL",
      "BUNDLE_GEMFILE",
      "CC",
      "CXX",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0"
    ]) {
      const unsafe = await createAuthorizationFixture("two", [
        { kind: "literal", name, value: "/tmp/untrusted-loader" }
      ]);
      await expect(CommandExecutor.validateRequest(unsafe.request)).rejects.toEqual(
        new CommandExecutorError("invalid_request")
      );
    }
    expect(isForbiddenEnvironmentName("npm_config_script_shell")).toBe(true);
    expect(isForbiddenEnvironmentName("AUTOSTACK_MODE")).toBe(false);
  });

  it("rejects toolchain helpers before activity reservation or dependency work", async () => {
    const selectors = ["RUSTC", "GOCACHEPROG", "GOAUTH"] as const;
    const unsafe = await createAuthorizationFixture(
      "two",
      selectors.map((name) => ({ kind: "literal" as const, name, value: "/tmp/untrusted-tool" }))
    );
    const dataRoot = await makeRoot();
    const managedPath = join(dataRoot, "managed");
    await mkdir(managedPath, { mode: 0o700 });
    const activity = new CommandActivityCoordinator();
    const effects = {
      activity: 0,
      worktree: 0,
      executable: 0,
      credentials: 0,
      launch: 0
    };
    const executor = await CommandExecutor.create({
      dataRoot,
      artifactStore: await ArtifactStore.create({ dataRoot }),
      worktrees: {
        async resolvePreparedEnvironment() {
          effects.worktree += 1;
          return {
            environment: {
              environmentId: ids.environmentId,
              workspaceId: ids.workspaceId,
              runId: ids.runId,
              repositoryIdentity: `local-sha256:${hex64("a")}`,
              sourceCommit: "b".repeat(40),
              branch: "autostack/run-feature",
              authorization: unsafe.environmentAuthorization,
              state: "prepared" as const,
              preparedAt: "2026-08-21T11:30:00.000Z"
            },
            managedPath,
            intentDigest: hex64("d")
          };
        }
      },
      activity: {
        async reserveCommand(environmentId, commandId) {
          effects.activity += 1;
          return await activity.reserveCommand(environmentId, commandId);
        },
        acquireEnvironmentQuiescence: (environmentId) =>
          activity.acquireEnvironmentQuiescence(environmentId),
        closeAdmission: () => activity.closeAdmission()
      },
      executableResolver: {
        async resolve() {
          effects.executable += 1;
          throw new Error("toolchain helper reached executable resolution");
        }
      },
      async resolveCredentials() {
        effects.credentials += 1;
        return [];
      },
      guardianLauncher: {
        async launch() {
          effects.launch += 1;
          throw new Error("toolchain helper reached guardian launch");
        }
      },
      trustedBaseEnvironment: [
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "HOME", value: `${dataRoot}/runtime/home` },
        { name: "TMPDIR", value: `${dataRoot}/runtime/tmp` },
        { name: "LANG", value: "C" },
        { name: "LC_ALL", value: "C" },
        { name: "TERM", value: "xterm-256color" }
      ],
      limits: {
        eventBytes: 65_536,
        replayBytes: 1_048_576,
        transcriptBytes: 1_048_576,
        artifactBytes: 1_048_576,
        cancellationGraceMs: 1,
        eofSettleMs: 1,
        subscriberQueueFrames: 64,
        subscriberQueueBytes: 1_048_576
      },
      now: () => "2026-08-21T12:00:00.000Z",
      monotonicNowMs: () => 100,
      createArtifactId: () => ids.artifactId,
      createGuardianSession: () => ({
        sessionId: "forbidden-toolchain-helper",
        secret: Uint8Array.from({ length: 32 }, () => 5),
        bindingDigest: hex64("f")
      })
    });
    let outcome = "fulfilled";
    try {
      await executor.startCommand(unsafe.request);
    } catch (error) {
      outcome = error instanceof CommandExecutorError ? error.code : "foreign_error";
    }
    await executor.close();

    expect({
      forbidden: selectors.filter((name) => isForbiddenEnvironmentName(name)),
      outcome,
      effects
    }).toEqual({
      forbidden: [...selectors],
      outcome: "invalid_request",
      effects: { activity: 0, worktree: 0, executable: 0, credentials: 0, launch: 0 }
    });
  });

  it("keeps test inspection off the normally exported executor class", () => {
    expect("retainedRequestForTesting" in CommandExecutor.prototype).toBe(false);
    expect("activeGuardianCountForTesting" in CommandExecutor.prototype).toBe(false);
    expect("retainedRequest" in CommandRegistry.prototype).toBe(false);
    expect("activeGuardianCount" in CommandRegistry.prototype).toBe(false);
  });
});
