import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
  type StartCommandRequest
} from "@autostack/contracts";

import { CommandActivityCoordinator } from "../src/command-activity.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { admitArtifactStoreRecoveryRoot } from "../src/artifact-mutation-authority.js";
import { CommandGuardian } from "../src/command-guardian.js";
import { admitRecoveryPublications } from "../src/command-recovery-admission.js";
import { CommandRegistry, CommandRegistryError } from "../src/command-registry.js";
import { isTrustedCommandRegistryError } from "../src/command-registry-types.js";
import { isExactUnusedScaffolding } from "../src/command-registry-scaffolding.js";
import { validateRecoveredCommand } from "../src/command-recovery-validation.js";
import { digestSpawnEnvelope } from "../src/command-spawn-envelope.js";
import { acquireCommandGuardianLease } from "../src/data-root-lock.js";
import { DataPathPolicy } from "../src/path-policy.js";
import { ReplaySpool } from "../src/replay-spool.js";
import { createFrame } from "../src/replay-spool-codec.js";
import { healReceiptPublications } from "../src/replay-spool-publication-recovery.js";
import { FakeProcessTreeController, FakePtyFactory } from "./fixtures/fake-pty.js";

const ENVIRONMENT_ID = createId("environment", "00000000-0000-4000-8000-000000000001");
const COMMAND_ID = createId("command", "00000000-0000-4000-8000-000000000002");
const OTHER_COMMAND_ID = createId("command", "00000000-0000-4000-8000-000000000102");
const WORKSPACE_ID = createId("workspace", "00000000-0000-4000-8000-000000000003");
const OTHER_WORKSPACE_ID = createId("workspace", "00000000-0000-4000-8000-000000000103");
const RUN_ID = createId("run", "00000000-0000-4000-8000-000000000004");
const ARTIFACT_ID = createId("artifact", "00000000-0000-4000-8000-000000000005");
const ENVIRONMENT_AUTHORIZATION_ID = createId(
  "environmentAuthorization",
  "00000000-0000-4000-8000-000000000006"
);
const COMMAND_AUTHORIZATION_ID = createId(
  "commandAuthorization",
  "00000000-0000-4000-8000-000000000007"
);
const APPROVAL_ID = createId("approval", "00000000-0000-4000-8000-000000000008");
const hex64 = (character: string): string => character.repeat(64);
const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-command-registry-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const command = {
  executable: "true",
  args: [] as string[],
  cwd: ".",
  environment: [] as const,
  timeoutSeconds: 10,
  terminal: { columns: 100, rows: 30 }
};
const environmentScope = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  environmentId: ENVIRONMENT_ID,
  repositoryIdentity: `local-sha256:${hex64("a")}`,
  sourceCommit: "b".repeat(40),
  branch: "autostack/run-feature",
  cwdRoot: ".",
  resourceLimits: { cpu: 2, memoryMb: 1_024, durationSeconds: 60 },
  networkPolicy: "host" as const,
  filesystemDisclosure: "host_user" as const,
  allowedCredentialRefIds: []
};
const environmentAuthorizationBase = {
  id: ENVIRONMENT_AUTHORIZATION_ID,
  approvalId: APPROVAL_ID,
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
const commandScope = {
  environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
  environmentAuthorizationDigest: environmentAuthorization.digest,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  environmentId: ENVIRONMENT_ID,
  commandId: COMMAND_ID,
  action: "implement" as const,
  commandDigest: await digestCommandSpec(command),
  repositoryIdentity: `local-sha256:${hex64("a")}`,
  sourceCommit: "b".repeat(40),
  branch: "autostack/run-feature",
  cwdRoot: ".",
  networkPolicy: "host" as const,
  filesystemDisclosure: "host_user" as const,
  resourceLimits: { cpu: 2, memoryMb: 1_024, durationSeconds: 30 },
  allowedCredentialRefIds: []
};
const commandAuthorizationBase = {
  id: COMMAND_AUTHORIZATION_ID,
  approvalId: APPROVAL_ID,
  approvalEvidenceDigest: await digestCommandScope(commandScope),
  scope: commandScope,
  createdAt: "2026-08-21T11:00:00.000Z",
  expiresAt: "2026-08-21T13:00:00.000Z"
};
const commandAuthorization = CommandAuthorizationSchema.parse({
  ...commandAuthorizationBase,
  digest: await digestCommandAuthorization({ ...commandAuthorizationBase, digest: hex64("0") })
});
const startRequest = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  environmentId: ENVIRONMENT_ID,
  commandId: COMMAND_ID,
  command,
  environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
  environmentAuthorizationDigest: environmentAuthorization.digest,
  authorization: commandAuthorization,
  idempotency: { key: "registry-command" }
};
const spawnEnvelope = {
  executable: "/usr/bin/true",
  args: [] as string[],
  cwd: "/private/worktree",
  environment: [{ name: "PATH", value: "/usr/bin:/bin" }],
  terminal: { columns: 100, rows: 30 }
} as const;
const intent = {
  commandId: COMMAND_ID,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  environmentId: ENVIRONMENT_ID,
  request: startRequest,
  requestDigest: await digestVersionedValue("autostack.start-command-request", startRequest),
  environmentIntentDigest: hex64("2"),
  environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
  environmentAuthorizationDigest: environmentAuthorization.digest,
  environmentAuthorization,
  commandAuthorizationId: COMMAND_AUTHORIZATION_ID,
  commandAuthorizationDigest: commandAuthorization.digest,
  acceptedAt: "2026-08-21T12:00:00.000Z",
  executablePath: "/usr/bin/true",
  executableIdentityDigest: hex64("5"),
  cwdRelativePath: ".",
  cwdIdentityDigest: hex64("6"),
  spawnEnvelopeDigest: digestSpawnEnvelope({
    request: startRequest as unknown as StartCommandRequest,
    envelope: spawnEnvelope,
    executableIdentityDigest: hex64("5"),
    cwdIdentityDigest: hex64("6"),
    sensitiveValues: []
  }),
  transcriptArtifactId: ARTIFACT_ID,
  artifactCreatedAt: "2026-08-21T12:00:00.000Z",
  guardianSessionBindingDigest: hex64("7"),
  limits: {
    eventBytes: 65_536,
    replayBytes: 1_048_576,
    transcriptBytes: 1_048_576,
    cancellationGraceMs: 1,
    eofSettleMs: 1
  }
} as const;

const readRequest = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  environmentId: ENVIRONMENT_ID,
  commandId: COMMAND_ID,
  environmentAuthorizationId: ENVIRONMENT_AUTHORIZATION_ID,
  environmentAuthorizationDigest: environmentAuthorization.digest,
  commandAuthorizationId: COMMAND_AUTHORIZATION_ID,
  commandAuthorizationDigest: commandAuthorization.digest,
  after: 0
} as const;

const launchRegisteredGuardian = async (
  dataRoot: string,
  spool: ReplaySpool,
  artifactStore: ArtifactStore,
  configure?: (pty: FakePtyFactory, processTree: FakeProcessTreeController) => void
) => {
  const pty = new FakePtyFactory();
  const processTree = new FakeProcessTreeController();
  pty.processTreeAuthority = processTree;
  configure?.(pty, processTree);
  let instant = 1;
  const origin = Date.parse("2026-08-21T12:00:00.000Z");
  const session = await CommandGuardian.launch({
    dataRoot,
    spool,
    artifactStore,
    spawnAuthority: pty,
    envelope: spawnEnvelope,
    sensitiveValues: [],
    timeoutMs: 10_000,
    cancellationGraceMs: 1,
    eofSettleMs: 1,
    now: () => new Date(origin + instant++ * 1_000).toISOString(),
    monotonicNowMs: (() => {
      let value = 100;
      return () => value++;
    })(),
    observer: Object.freeze({
      onDurableFrame() {},
      onDurablePhase() {}
    })
  });
  return { pty, processTree, session };
};

describe("CommandActivityCoordinator", () => {
  it("rejects an unowned Proxy error without invoking prototype reflection", () => {
    let prototypeReads = 0;
    const rejection = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        prototypeReads += 1;
        throw new Error("secret registry rejection detail");
      }
    });

    expect(isTrustedCommandRegistryError(rejection)).toBe(false);
    expect(prototypeReads).toBe(0);
  });

  it("blocks disposal quiescence from the moment command admission is reserved", async () => {
    const activity = new CommandActivityCoordinator();
    const reservation = await activity.reserveCommand(ENVIRONMENT_ID, COMMAND_ID);

    expect(await activity.acquireEnvironmentQuiescence(ENVIRONMENT_ID)).toBeUndefined();

    await reservation.close();
    const quiescence = await activity.acquireEnvironmentQuiescence(ENVIRONMENT_ID);
    expect(quiescence).toBeDefined();
    await quiescence?.close();
  });

  it("prevents a start from entering while disposal owns quiescence", async () => {
    const activity = new CommandActivityCoordinator();
    const quiescence = await activity.acquireEnvironmentQuiescence(ENVIRONMENT_ID);

    await expect(activity.reserveCommand(ENVIRONMENT_ID, COMMAND_ID)).rejects.toMatchObject({
      code: "environment_quiescing"
    });

    await quiescence?.close();
    const reservation = await activity.reserveCommand(ENVIRONMENT_ID, COMMAND_ID);
    await reservation.close();
  });

  it("rejects a second command and permanently closes new admission on request", async () => {
    const activity = new CommandActivityCoordinator();
    const reservation = await activity.reserveCommand(ENVIRONMENT_ID, COMMAND_ID);
    await expect(activity.reserveCommand(ENVIRONMENT_ID, COMMAND_ID)).rejects.toMatchObject({
      code: "environment_active"
    });
    await reservation.close();
    await reservation.close();
    activity.closeAdmission();
    await expect(activity.reserveCommand(ENVIRONMENT_ID, COMMAND_ID)).rejects.toMatchObject({
      code: "closed"
    });
  });
});

describe("CommandRegistry", () => {
  it("ignores a verified unused guardian lease when no command intent exists", async () => {
    const dataRoot = await makeRoot();
    const paths = await DataPathPolicy.create(dataRoot);
    const component = Buffer.from(COMMAND_ID, "utf8").toString("hex");
    await paths.ensureDirectory("commands");
    await paths.ensureDirectory(`commands/${component}`);
    const lease = await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    lease.close();

    const registry = await CommandRegistry.create({ dataRoot });
    await expect(registry.recoverAll()).resolves.toBeUndefined();
    expect(registry.receipt(COMMAND_ID)).toBeUndefined();
  });

  it("rejects malformed registry bounds before filesystem state is created", async () => {
    for (const options of [
      { dataRoot: "relative" },
      { dataRoot: "/private/tmp/autostack-invalid-registry", subscriberQueueFrames: 0 },
      { dataRoot: "/private/tmp/autostack-invalid-registry", subscriberQueueBytes: 0 },
      { dataRoot: "/private/tmp/autostack-invalid-registry", maximumCommands: 0 },
      { dataRoot: "/private/tmp/autostack-invalid-registry", maximumSubscribers: 0 }
    ]) {
      await expect(CommandRegistry.create(options)).rejects.toEqual(
        new CommandRegistryError("invalid_request")
      );
    }
  });

  it("caps commands and subscribers before retaining additional state", async () => {
    const registry = await CommandRegistry.create({
      dataRoot: await makeRoot(),
      maximumCommands: 1,
      maximumCommandSubscribers: 1,
      maximumSubscribers: 1
    });
    const registered = await registry.registerIntent(intent);
    await expect(
      registry.registerIntent({ ...intent, commandId: OTHER_COMMAND_ID })
    ).rejects.toEqual(new CommandRegistryError("capacity_exceeded"));
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    await registry.observeDurableFrame(COMMAND_ID, started);
    const first = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    expect((await first.next()).done).toBe(false);
    const second = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toEqual(new CommandRegistryError("capacity_exceeded"));
    await first.return?.();
  });

  it("admits an intent once before applying command capacity", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot, maximumCommands: 1 });
    await registry.registerIntent(intent);
    let commandIdReads = 0;
    const togglingIntent = { ...intent } as Record<string, unknown>;
    Object.defineProperty(togglingIntent, "commandId", {
      enumerable: true,
      get: () => {
        commandIdReads += 1;
        return commandIdReads === 1 ? COMMAND_ID : OTHER_COMMAND_ID;
      }
    });

    await expect(registry.registerIntent(togglingIntent as never)).rejects.toEqual(
      new CommandRegistryError("unsafe_state")
    );
    expect(commandIdReads).toBe(0);
    const otherComponent = Buffer.from(OTHER_COMMAND_ID, "utf8").toString("hex");
    await expect(access(join(dataRoot, "commands", otherComponent))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects a proxied intent without executing traps or creating command state", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot, maximumCommands: 1 });
    await registry.registerIntent(intent);
    let traps = 0;
    const proxied = new Proxy(
      { ...intent, commandId: OTHER_COMMAND_ID },
      {
        getPrototypeOf() {
          traps += 1;
          throw new Error("intent prototype trap");
        },
        ownKeys() {
          traps += 1;
          throw new Error("intent ownKeys trap");
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error("intent descriptor trap");
        }
      }
    );

    await expect(registry.registerIntent(proxied as never)).rejects.toEqual(
      new CommandRegistryError("unsafe_state")
    );
    expect(traps).toBe(0);
    const otherComponent = Buffer.from(OTHER_COMMAND_ID, "utf8").toString("hex");
    await expect(access(join(dataRoot, "commands", otherComponent))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("authenticates the complete supplied durable frame against canonical spool bytes", async () => {
    const registry = await CommandRegistry.create({ dataRoot: await makeRoot() });
    const registered = await registry.registerIntent(intent);
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    const rebound = {
      ...started,
      event: { ...started.event, occurredAt: "2026-08-21T12:00:09.000Z" }
    };

    await expect(registry.observeDurableFrame(COMMAND_ID, rebound as never)).rejects.toEqual(
      new CommandRegistryError("maintenance_required")
    );
  });

  it("replays a snapshot then follows committed frames without a registration gap", async () => {
    const registry = await CommandRegistry.create({ dataRoot: await makeRoot() });
    const registered = await registry.registerIntent(intent);
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    await registry.observeDurableFrame(COMMAND_ID, started);

    const iterator = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "runner.event", event: started.event });

    const terminal = await registered.spool.appendEvent({
      type: "stream.error",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 2,
      occurredAt: "2026-08-21T12:00:02.000Z",
      code: "protocol_failure",
      message: "The command failed safely."
    });
    await registry.observeDurableFrame(COMMAND_ID, terminal);
    expect((await iterator.next()).value).toEqual({ type: "runner.event", event: terminal.event });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("prevents one subscriber from mutating another subscriber's nested event evidence", async () => {
    const registry = await CommandRegistry.create({ dataRoot: await makeRoot() });
    const registered = await registry.registerIntent(intent);
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    await registry.observeDurableFrame(COMMAND_ID, started);
    const first = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    const second = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    await Promise.all([first.next(), second.next()]);

    const artifact = {
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      kind: "command_transcript" as const,
      mediaType: "text/plain; charset=utf-8",
      digest: hex64("8"),
      byteSize: 12,
      createdAt: intent.artifactCreatedAt
    };
    const created = await registered.spool.appendEvent({
      type: "artifact.created",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 2,
      occurredAt: "2026-08-21T12:00:02.000Z",
      artifact
    });
    await registry.observeDurableFrame(COMMAND_ID, created);
    const [firstCreated, secondCreated] = await Promise.all([first.next(), second.next()]);
    if (
      firstCreated.value?.type !== "runner.event" ||
      firstCreated.value.event.type !== "artifact.created" ||
      secondCreated.value?.type !== "runner.event" ||
      secondCreated.value.event.type !== "artifact.created"
    ) {
      throw new TypeError();
    }
    Reflect.set(firstCreated.value.event.artifact, "digest", hex64("9"));
    expect(secondCreated.value.event.artifact.digest).toBe(hex64("8"));
    expect(Object.isFrozen(firstCreated.value.event.artifact)).toBe(true);
    await first.return?.();
    await second.return?.();
  });

  it("permanently closes return-before-first-next and rejects concurrent next calls", async () => {
    const registry = await CommandRegistry.create({ dataRoot: await makeRoot() });
    const registered = await registry.registerIntent(intent);
    const returned = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    await expect(returned.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(returned.next()).resolves.toEqual({ done: true, value: undefined });

    const concurrent = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    const first = concurrent.next();
    await Promise.resolve();
    const second = concurrent.next();
    const secondResult = await Promise.race([
      second.then(
        () => "resolved",
        () => "rejected"
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100))
    ]);
    expect(secondResult).toBe("rejected");
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    await registry.observeDurableFrame(COMMAND_ID, started);
    await first;
    await concurrent.return?.();
  });

  it("expires an abandoned initialized subscription and restores bounded capacity", async () => {
    const registry = await CommandRegistry.create({
      dataRoot: await makeRoot(),
      maximumCommandSubscribers: 1,
      maximumSubscribers: 1,
      subscriberIdleMs: 20
    });
    await registry.registerIntent(intent);
    const abandoned = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    const pending = abandoned.next();
    await new Promise((resolve) => setTimeout(resolve, 40));

    const replacement = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    const replacementNext = replacement.next();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await replacement.return?.();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(replacementNext).resolves.toEqual({ done: true, value: undefined });
  });

  it("synchronizes close with pending subscriber initialization before registration", async () => {
    const registry = await CommandRegistry.create({ dataRoot: await makeRoot() });
    const registered = await registry.registerIntent(intent);
    let releaseHead!: () => void;
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const originalHead = registered.spool.head.bind(registered.spool);
    Object.defineProperty(registered.spool, "head", {
      configurable: true,
      value: async () => {
        await headGate;
        return await originalHead();
      }
    });
    const subscription = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    const pendingNext = subscription.next();
    await Promise.resolve();
    const closing = registry.close();
    releaseHead();
    await closing;
    expect(
      await Promise.race([
        pendingNext,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100))
      ])
    ).toEqual({ done: true, value: undefined });
  });

  it("reclaims an abandoned initialized subscription after its bounded idle window", async () => {
    const registry = await CommandRegistry.create({
      dataRoot: await makeRoot(),
      maximumSubscribers: 1,
      subscriberIdleMs: 20
    } as never);
    const registered = await registry.registerIntent(intent);
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    await registry.observeDurableFrame(COMMAND_ID, started);
    const abandoned = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    await expect(abandoned.next()).resolves.toMatchObject({ done: false });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const replacement = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    await expect(replacement.next()).resolves.toMatchObject({ done: false });
    await replacement.return?.();
  });

  it("classifies exact pre-intent scaffolding as unused instead of permanent maintenance", async () => {
    const dataRoot = await makeRoot();
    const paths = await DataPathPolicy.create(dataRoot);
    const component = Buffer.from(COMMAND_ID, "utf8").toString("hex");
    for (const directory of [
      `commands/${component}`,
      `commands/${component}/receipt`,
      `commands/${component}/control`,
      `commands/${component}/spool`,
      `commands/${component}/spool/events`,
      `commands/${component}/spool/transcript`
    ]) {
      await paths.ensureDirectory(directory);
    }
    const registry = await CommandRegistry.create({ dataRoot });

    await expect(registry.recoverAll()).resolves.toBeUndefined();
    expect(registry.receipt(COMMAND_ID)).toBeUndefined();
  });

  it("does not create a missing directory while inspecting unused scaffolding", async () => {
    const dataRoot = await makeRoot();
    const paths = await DataPathPolicy.create(dataRoot);
    const component = Buffer.from(COMMAND_ID, "utf8").toString("hex");
    const commandRoot = `commands/${component}`;
    for (const directory of [
      commandRoot,
      `${commandRoot}/receipt`,
      `${commandRoot}/control`,
      `${commandRoot}/spool`,
      `${commandRoot}/spool/events`,
      `${commandRoot}/spool/transcript`
    ]) {
      await paths.ensureDirectory(directory);
    }
    const commandEntries = (await paths.listExistingDirectory(commandRoot, 3))!;
    await rm(join(dataRoot, commandRoot, "receipt"), { recursive: true });

    await expect(isExactUnusedScaffolding(paths, component, commandEntries)).resolves.toBe(false);
    await expect(stat(join(dataRoot, commandRoot, "receipt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("disconnects only a lagging subscriber at its last delivered durable cursor", async () => {
    const registry = await CommandRegistry.create({
      dataRoot: await makeRoot(),
      subscriberQueueFrames: 1,
      subscriberQueueBytes: 1_024
    });
    const registered = await registry.registerIntent(intent);
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    await registry.observeDurableFrame(COMMAND_ID, started);
    const iterator = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    await iterator.next();
    for (const [sequence, text] of [
      [2, "one"],
      [3, "two"]
    ] as const) {
      const frame = await registered.spool.appendEvent({
        type: "terminal.output",
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        commandId: COMMAND_ID,
        sequence,
        occurredAt: `2026-08-21T12:00:0${sequence}.000Z`,
        stream: "pty",
        text
      });
      await registry.observeDurableFrame(COMMAND_ID, frame);
    }

    expect((await iterator.next()).value).toEqual({
      type: "subscription.lagged",
      lastDurableSequence: 1,
      resumeCursor: 1
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("classifies an orphan-ambiguous running receipt as maintenance-required", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    const registered = await registry.registerIntent(intent);
    await registered.spool.recordPhase("lease_transferred", {
      recordedAt: "2026-08-21T12:00:01.000Z",
      evidence: {
        guardianSessionBindingDigest: intent.guardianSessionBindingDigest,
        guardianNonceDigest: null,
        leaseTransferred: true
      }
    });
    await registered.spool.recordPhase("spawned", {
      recordedAt: "2026-08-21T12:00:02.000Z",
      evidence: { launch: true }
    });
    await registered.spool.recordPhase("running", {
      recordedAt: "2026-08-21T12:00:03.000Z",
      evidence: { liveCapability: true }
    });

    const restarted = await CommandRegistry.create({ dataRoot });
    await expect(restarted.recoverAll()).rejects.toEqual(
      new CommandRegistryError("maintenance_required")
    );
  });

  it("recovers the exact successful, rejected, and ambiguous evidence produced by guardians", async () => {
    const successfulRoot = await makeRoot();
    const successfulArtifacts = await ArtifactStore.create({ dataRoot: successfulRoot });
    const successfulRegistry = await CommandRegistry.create({
      dataRoot: successfulRoot,
      artifactStore: successfulArtifacts
    });
    const successfulRegistration = await successfulRegistry.registerIntent(intent);
    const successful = await launchRegisteredGuardian(
      successfulRoot,
      successfulRegistration.spool,
      successfulArtifacts,
      (_pty, processTree) => {
        processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGBUS" });
      }
    );
    await successful.session.disconnect();
    await successful.session.closed;
    const successfulRecovered = await successfulRegistration.spool.recover();
    await expect(validateRecoveredCommand(successfulRecovered)).resolves.toBeUndefined();
    await expect(
      (
        await CommandRegistry.create({
          dataRoot: successfulRoot,
          artifactStore: successfulArtifacts
        })
      ).recoverAll()
    ).resolves.toBeUndefined();

    const finalizingIndex = successfulRecovered.phases.findIndex(
      (receipt) => receipt.phase === "finalizing"
    );
    const finalizing = successfulRecovered.phases[finalizingIndex]!;
    if (
      finalizing.phase !== "finalizing" ||
      typeof finalizing.evidence !== "object" ||
      finalizing.evidence === null ||
      Array.isArray(finalizing.evidence)
    )
      throw new TypeError("finalizing receipt missing");
    await expect(
      validateRecoveredCommand({
        ...successfulRecovered,
        phases: Object.freeze([
          ...successfulRecovered.phases.slice(0, finalizingIndex),
          Object.freeze({
            ...finalizing,
            evidence: Object.freeze({
              ...(finalizing.evidence as Readonly<Record<string, unknown>>),
              signal: "SIGWINCH"
            })
          }),
          ...successfulRecovered.phases.slice(finalizingIndex + 1)
        ])
      })
    ).rejects.toBeDefined();

    const rejectedRoot = await makeRoot();
    const rejectedArtifacts = await ArtifactStore.create({ dataRoot: rejectedRoot });
    const rejectedRegistry = await CommandRegistry.create({
      dataRoot: rejectedRoot,
      artifactStore: rejectedArtifacts
    });
    const rejectedRegistration = await rejectedRegistry.registerIntent(intent);
    const rejected = await launchRegisteredGuardian(
      rejectedRoot,
      rejectedRegistration.spool,
      rejectedArtifacts,
      (pty) => {
        pty.identityDecision = false;
      }
    );
    await rejected.session.closed;
    await expect(
      validateRecoveredCommand(await rejectedRegistration.spool.recover())
    ).resolves.toBeUndefined();
    await expect(
      (
        await CommandRegistry.create({ dataRoot: rejectedRoot, artifactStore: rejectedArtifacts })
      ).recoverAll()
    ).resolves.toBeUndefined();

    const ambiguousRoot = await makeRoot();
    const ambiguousArtifacts = await ArtifactStore.create({ dataRoot: ambiguousRoot });
    const ambiguousRegistry = await CommandRegistry.create({
      dataRoot: ambiguousRoot,
      artifactStore: ambiguousArtifacts
    });
    const ambiguousRegistration = await ambiguousRegistry.registerIntent(intent);
    const ambiguous = await launchRegisteredGuardian(
      ambiguousRoot,
      ambiguousRegistration.spool,
      ambiguousArtifacts,
      (pty) => {
        pty.createThenThrow = true;
      }
    );
    await expect(ambiguous.session.closed).rejects.toMatchObject({ code: "unsafe_state" });
    await expect(
      validateRecoveredCommand(await ambiguousRegistration.spool.recover())
    ).resolves.toBeUndefined();
    await expect(
      (
        await CommandRegistry.create({ dataRoot: ambiguousRoot, artifactStore: ambiguousArtifacts })
      ).recoverAll()
    ).rejects.toEqual(new CommandRegistryError("maintenance_required"));
    ambiguous.pty.uncertainDescendantsAbsent = true;
    await new Promise((resolve) => setTimeout(resolve, 350));
  });

  it("recovers intent-only state without execution into immutable terminal evidence", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    await registry.registerIntent(intent);

    const restarted = await CommandRegistry.create({ dataRoot });
    await restarted.recoverAll();
    const recovered = await (await ReplaySpool.open({ dataRoot, commandId: COMMAND_ID })).recover();

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
      code: "protocol_failure"
    });
  });

  it("rejects a foreign-root artifact store before registry recovery can read it", async () => {
    const dataRoot = await makeRoot();
    const otherRoot = await makeRoot();
    const foreignStore = await ArtifactStore.create({ dataRoot: otherRoot });
    const findForeign = foreignStore.findArtifact.bind(foreignStore);
    let foreignReads = 0;
    Object.defineProperty(foreignStore, "findArtifact", {
      value: async (artifactId: Parameters<ArtifactStore["findArtifact"]>[0]) => {
        foreignReads += 1;
        return await findForeign(artifactId);
      }
    });

    await expect(CommandRegistry.create({ dataRoot, artifactStore: foreignStore })).rejects.toEqual(
      new CommandRegistryError("invalid_request")
    );
    expect(foreignReads).toBe(0);
  });

  it("rejects a foreign artifact capability before creating its missing target root", async () => {
    const parent = await makeRoot();
    const missingRoot = join(parent, "missing-registry-root");
    const foreignStore = await ArtifactStore.create({ dataRoot: await makeRoot() });

    await expect(
      CommandRegistry.create({ dataRoot: missingRoot, artifactStore: foreignStore })
    ).rejects.toEqual(new CommandRegistryError("invalid_request"));
    await expect(stat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an artifact store whose root pathname was replaced", async () => {
    const dataRoot = await makeRoot();
    const staleStore = await ArtifactStore.create({ dataRoot });
    const displacedRoot = `${dataRoot}-displaced`;
    roots.push(displacedRoot);
    await rename(dataRoot, displacedRoot);
    await mkdir(dataRoot, { mode: 0o700 });

    await expect(CommandRegistry.create({ dataRoot, artifactStore: staleStore })).rejects.toEqual(
      new CommandRegistryError("invalid_request")
    );
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("revalidates the registry artifact root before enumerating or healing replacement state", async () => {
    const dataRoot = await makeRoot();
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const registry = await CommandRegistry.create({ dataRoot, artifactStore });
    const replacementRoot = await makeRoot();
    const replacementRegistry = await CommandRegistry.create({ dataRoot: replacementRoot });
    await replacementRegistry.registerIntent(intent);
    const commandDirectory = (await readdir(join(replacementRoot, "commands")))[0]!;
    const canonical = join(replacementRoot, "commands", commandDirectory, "receipt/01-intent.json");
    const alias = join(
      replacementRoot,
      "commands",
      commandDirectory,
      `receipt/.01-intent.json.${"a".repeat(32)}.tmp`
    );
    await link(canonical, alias);
    const aliasBefore = await stat(alias);
    const displacedRoot = `${dataRoot}-displaced-registry`;
    roots.push(displacedRoot);
    await rename(dataRoot, displacedRoot);
    await rename(replacementRoot, dataRoot);

    await expect(registry.recoverAll()).rejects.toEqual(
      new CommandRegistryError("maintenance_required")
    );
    const aliasAfter = await stat(alias.replace(replacementRoot, dataRoot));
    expect({ ino: aliasAfter.ino, nlink: aliasAfter.nlink }).toEqual({
      ino: aliasBefore.ino,
      nlink: aliasBefore.nlink
    });
  });

  it("rejects a stale registry capability before recreating its removed root", async () => {
    const dataRoot = await makeRoot();
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const registry = await CommandRegistry.create({ dataRoot, artifactStore });
    await rm(dataRoot, { recursive: true });

    await expect(registry.recoverAll()).rejects.toEqual(
      new CommandRegistryError("maintenance_required")
    );
    await expect(stat(dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the branded artifact find operation after the public method is rebound", async () => {
    const dataRoot = await makeRoot();
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const registry = await CommandRegistry.create({ dataRoot, artifactStore });
    const registered = await registry.registerIntent(intent);
    const launched = await launchRegisteredGuardian(
      dataRoot,
      registered.spool,
      artifactStore,
      (_pty, processTree) => {
        processTree.actualExit = Object.freeze({ exitCode: null, signal: "SIGBUS" });
      }
    );
    await launched.session.disconnect();
    await launched.session.closed;
    const otherRoot = await makeRoot();
    const foreignStore = await ArtifactStore.create({ dataRoot: otherRoot });
    const findForeign = foreignStore.findArtifact.bind(foreignStore);
    let foreignReads = 0;
    Object.defineProperty(artifactStore, "findArtifact", {
      value: async (artifactId: Parameters<ArtifactStore["findArtifact"]>[0]) => {
        foreignReads += 1;
        return await findForeign(artifactId);
      }
    });

    const restarted = await CommandRegistry.create({ dataRoot, artifactStore });
    await expect(restarted.recoverAll()).resolves.toBeUndefined();
    expect(foreignReads).toBe(0);
  });

  it("rejects pre-spawn transcript or event evidence before any recovery mutation", async () => {
    for (const forged of ["transcript", "event"] as const) {
      const dataRoot = await makeRoot();
      const artifactStore = await ArtifactStore.create({ dataRoot });
      const registry = await CommandRegistry.create({ dataRoot, artifactStore });
      const registered = await registry.registerIntent(intent);
      if (forged === "transcript") {
        await registered.spool.appendTranscriptChunk(Buffer.from("forged-pre-spawn"));
      } else {
        await registered.spool.appendEvent({
          type: "command.started",
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          commandId: COMMAND_ID,
          sequence: 1,
          occurredAt: "2026-08-21T12:00:01.000Z",
          pty: true
        });
      }
      const restarted = await CommandRegistry.create({ dataRoot, artifactStore });
      await expect(restarted.recoverAll()).rejects.toEqual(
        new CommandRegistryError("maintenance_required")
      );
      expect(await artifactStore.findArtifact(ARTIFACT_ID)).toBeUndefined();
      expect((await registered.spool.recover()).phases.map((phase) => phase.phase)).toEqual([
        "intent"
      ]);
    }
  });

  it("does not promote a valid temporary transcript before semantic recovery validation", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    await registry.registerIntent(intent);
    const commandDirectory = (await readdir(join(dataRoot, "commands")))[0]!;
    const transcriptDirectory = join(dataRoot, "commands", commandDirectory, "spool", "transcript");
    const bytes = Buffer.from("forged-pre-spawn");
    const canonicalName = "000000000001.bin";
    const temporaryName = `.${canonicalName}.${createHash("sha256").update(bytes).digest("hex")}.${bytes.byteLength}.${"a".repeat(32)}.tmp`;
    const temporaryPath = join(transcriptDirectory, temporaryName);
    const canonicalPath = join(transcriptDirectory, canonicalName);
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    const before = await stat(temporaryPath);

    const restarted = await CommandRegistry.create({ dataRoot });
    await expect(restarted.recoverAll()).rejects.toEqual(
      new CommandRegistryError("maintenance_required")
    );

    const after = await stat(temporaryPath);
    expect({ dev: after.dev, ino: after.ino, nlink: after.nlink }).toEqual({
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink
    });
    await expect(stat(canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a valid crash alias when an unknown command-root entry fails admission", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    await registry.registerIntent(intent);
    const commandDirectory = (await readdir(join(dataRoot, "commands")))[0]!;
    const commandRoot = join(dataRoot, "commands", commandDirectory);
    const canonicalPath = join(commandRoot, "receipt", "01-intent.json");
    const aliasPath = join(commandRoot, "receipt", `.01-intent.json.${"a".repeat(32)}.tmp`);
    await writeFile(aliasPath, await readFile(canonicalPath), { flag: "wx", mode: 0o600 });
    await writeFile(join(commandRoot, "unknown-root-entry"), "unknown", {
      flag: "wx",
      mode: 0o600
    });
    const before = await stat(aliasPath);

    const restarted = await CommandRegistry.create({ dataRoot });
    await expect(restarted.recoverAll()).rejects.toEqual(
      new CommandRegistryError("maintenance_required")
    );

    const after = await stat(aliasPath);
    expect({ dev: after.dev, ino: after.ino, nlink: after.nlink }).toEqual({
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink
    });
  });

  it("rejects recovery enumeration at max plus one before reading candidate contents", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    await registry.registerIntent(intent);
    const commandDirectory = (await readdir(join(dataRoot, "commands")))[0]!;
    const receiptRoot = join(dataRoot, "commands", commandDirectory, "receipt");
    const intentBytes = await readFile(join(receiptRoot, "01-intent.json"));
    for (let index = 0; index < 12; index += 1) {
      await writeFile(
        join(receiptRoot, `.01-intent.json.${index.toString(16).padStart(32, "0")}.tmp`),
        intentBytes,
        { flag: "wx", mode: 0o600 }
      );
    }
    let contentReads = 0;
    const paths = await DataPathPolicy.create(dataRoot, {
      beforeFileOpen() {
        contentReads += 1;
      }
    });
    const artifactStore = await ArtifactStore.create({ dataRoot });

    const artifacts = await admitArtifactStoreRecoveryRoot(artifactStore, paths.root);
    await expect(admitRecoveryPublications(paths, COMMAND_ID, artifacts)).rejects.toBeDefined();
    expect(contentReads).toBe(0);
  });

  it("revalidates bounded publication topology immediately before healing", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    await registry.registerIntent(intent);
    const commandDirectory = (await readdir(join(dataRoot, "commands")))[0]!;
    const commandRoot = `commands/${commandDirectory}`;
    const receiptRoot = join(dataRoot, commandRoot, "receipt");
    const intentBytes = await readFile(join(receiptRoot, "01-intent.json"));
    const aliases = Array.from(
      { length: 12 },
      (_value, index) => `.01-intent.json.${index.toString(16).padStart(32, "0")}.tmp`
    );
    const paths = await DataPathPolicy.create(dataRoot);
    const listExisting = paths.listExistingDirectory.bind(paths);
    let injected = false;
    Object.defineProperty(paths, "listExistingDirectory", {
      value: async (relativePath: string, maximumEntries: number) => {
        const entries = await listExisting(relativePath, maximumEntries);
        if (relativePath === `${commandRoot}/receipt` && !injected) {
          injected = true;
          await Promise.all(
            aliases.map((name) =>
              writeFile(join(receiptRoot, name), intentBytes, { flag: "wx", mode: 0o600 })
            )
          );
        }
        return entries;
      }
    });

    await expect(healReceiptPublications(paths, commandRoot, COMMAND_ID)).rejects.toMatchObject({
      code: "maintenance_required"
    });
    expect((await readdir(receiptRoot)).filter((name) => aliases.includes(name))).toHaveLength(12);
  });

  it("does not recreate a missing recovery directory during inspection", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    await registry.registerIntent(intent);
    const commandDirectory = (await readdir(join(dataRoot, "commands")))[0]!;
    const controlPath = join(dataRoot, "commands", commandDirectory, "control");
    await rm(controlPath, { recursive: true });

    const restarted = await CommandRegistry.create({ dataRoot });
    await expect(restarted.recoverAll()).rejects.toEqual(
      new CommandRegistryError("maintenance_required")
    );
    await expect(stat(controlPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a transferred pre-spawn lease as guardian-lost without execution", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    const registered = await registry.registerIntent(intent);
    await registered.spool.recordPhase("lease_transferred", {
      recordedAt: "2026-08-21T12:00:01.000Z",
      evidence: {
        guardianSessionBindingDigest: intent.guardianSessionBindingDigest,
        guardianNonceDigest: null,
        leaseTransferred: true
      }
    });

    const restarted = await CommandRegistry.create({ dataRoot });
    await restarted.recoverAll();
    const recovered = await registered.spool.recover();

    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "stream.error",
      code: "guardian_lost"
    });
    expect(recovered.phases.at(-1)?.phase).toBe("terminal");
    const terminal = recovered.events.at(-1)!;
    await expect(
      validateRecoveredCommand({
        ...recovered,
        events: Object.freeze([
          ...recovered.events.slice(0, -1),
          Object.freeze({
            ...terminal,
            event: Object.freeze({ ...terminal.event, message: "attacker-chosen failure" })
          })
        ])
      })
    ).rejects.toBeDefined();
  });

  it("completes a durable finalizing receipt without re-executing the command", async () => {
    const dataRoot = await makeRoot();
    const registry = await CommandRegistry.create({ dataRoot });
    const registered = await registry.registerIntent(intent);
    await registered.spool.recordPhase("lease_transferred", {
      recordedAt: "2026-08-21T12:00:01.000Z",
      evidence: {
        guardianSessionBindingDigest: intent.guardianSessionBindingDigest,
        guardianNonceDigest: null,
        leaseTransferred: true
      }
    });
    await registered.spool.recordPhase("spawned", {
      recordedAt: "2026-08-21T12:00:02.000Z",
      evidence: {
        spawnAuthorized: true,
        executableIdentityDigest: intent.executableIdentityDigest,
        cwdIdentityDigest: intent.cwdIdentityDigest
      }
    });
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:02.500Z",
      pty: true
    });
    await registered.spool.recordPhase("running", {
      recordedAt: "2026-08-21T12:00:03.000Z",
      evidence: { startedFrameDigest: started.frameDigest, liveCapability: true }
    });
    const transcript = await registered.spool.appendTranscriptChunk(Buffer.from("safe output"));
    await registered.spool.appendEvent({
      type: "terminal.output",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 2,
      occurredAt: "2026-08-21T12:00:03.250Z",
      stream: "pty",
      text: "safe output"
    });
    const cancel = await registered.spool.recordCancel({
      requestDigest: hex64("c"),
      decidedAt: "2026-08-21T12:00:03.500Z",
      cancelled: true
    });
    await registered.spool.recordCancelAck({
      claimDigest: cancel.claimDigest,
      acknowledgedAt: "2026-08-21T12:00:03.750Z"
    });
    await registered.spool.recordPhase("finalizing", {
      recordedAt: "2026-08-21T12:00:04.000Z",
      evidence: {
        cause: "interrupted",
        exitCode: null,
        signal: "SIGTERM",
        durationMs: 42,
        cancelled: false,
        interrupted: true,
        processTreeTerminated: true,
        ptyEofObserved: false,
        transcriptByteSize: transcript.cumulativeByteSize,
        transcriptHeadDigest: transcript.chunkDigest
      }
    });

    const beforeRecovery = await registered.spool.recover();
    await expect(validateRecoveredCommand(beforeRecovery)).resolves.toBeUndefined();
    const forgedArtifact = {
      artifactId: ARTIFACT_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      kind: "command_transcript" as const,
      mediaType: "text/plain; charset=utf-8",
      digest: hex64("0"),
      byteSize: 0,
      createdAt: intent.artifactCreatedAt
    };
    const forgedArtifactFrame = createFrame(
      COMMAND_ID,
      {
        type: "artifact.created",
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        commandId: COMMAND_ID,
        sequence: 3,
        occurredAt: "2026-08-21T12:00:05.000Z",
        artifact: forgedArtifact
      },
      beforeRecovery.events.at(-1)!.frameDigest
    );
    await expect(
      validateRecoveredCommand({
        ...beforeRecovery,
        events: Object.freeze([...beforeRecovery.events, forgedArtifactFrame])
      })
    ).rejects.toBeDefined();

    const restarted = await CommandRegistry.create({ dataRoot });
    await restarted.recoverAll();
    const recovered = await registered.spool.recover();

    expect(recovered.events.map((frame) => frame.event.type)).toEqual([
      "command.started",
      "terminal.output",
      "artifact.created",
      "command.completed"
    ]);
    expect(recovered.events.at(-1)?.event).toMatchObject({
      type: "command.completed",
      interrupted: true,
      durationMs: 42
    });
    expect(recovered.phases.at(-1)?.phase).toBe("terminal");
  });

  it("authorizes only the fixed quarantine control against the full receipt owner", async () => {
    const registry = await CommandRegistry.create({ dataRoot: await makeRoot() });
    const registered = await registry.registerIntent(intent);
    for (const [phase, recordedAt] of [
      ["lease_transferred", "2026-08-21T12:00:01.000Z"],
      ["spawned", "2026-08-21T12:00:02.000Z"],
      ["running", "2026-08-21T12:00:03.000Z"]
    ] as const) {
      await registered.spool.recordPhase(phase, { recordedAt, evidence: { safe: true } });
    }
    await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:02.500Z",
      pty: true
    });
    const session = {
      sessionId: "guardian-session",
      async send() {},
      async disconnect() {},
      closed: new Promise<never>(() => undefined)
    };
    await registry.attachSession(COMMAND_ID, session);

    await expect(
      registry.prepareProtocolFailure(readRequest, "output_quarantined")
    ).resolves.toMatchObject({ commandId: COMMAND_ID, replayed: false, session });
    await expect(
      registry.prepareProtocolFailure(
        { ...readRequest, workspaceId: OTHER_WORKSPACE_ID },
        "output_quarantined"
      )
    ).rejects.toEqual(new CommandRegistryError("invalid_request"));
    await expect(
      registry.prepareProtocolFailure(readRequest, "protocol_failure" as never)
    ).rejects.toEqual(new CommandRegistryError("invalid_request"));
  });

  it("rejects invalid ownership and cursors and unregisters a returned subscriber", async () => {
    const registry = await CommandRegistry.create({ dataRoot: await makeRoot() });
    const registered = await registry.registerIntent(intent);
    const started = await registered.spool.appendEvent({
      type: "command.started",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      commandId: COMMAND_ID,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    await registry.observeDurableFrame(COMMAND_ID, started);

    const wrongOwner = registry.subscribe({ ...readRequest, workspaceId: OTHER_WORKSPACE_ID });
    await expect(wrongOwner[Symbol.asyncIterator]().next()).rejects.toEqual(
      new CommandRegistryError("invalid_request")
    );
    const invalidCursor = registry.subscribe({ ...readRequest, after: 2 });
    await expect(invalidCursor[Symbol.asyncIterator]().next()).rejects.toEqual(
      new CommandRegistryError("cursor_invalid")
    );
    const iterator = registry.subscribe(readRequest)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "runner.event", event: started.event });
    expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
    await registry.close();
    await registry.close();
  });
});
