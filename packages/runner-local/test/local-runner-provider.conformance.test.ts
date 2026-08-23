import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeLocalRunnerLifecycleConformance,
  describeRunnerProviderConformance,
  type LocalRunnerLifecycleConformanceFixture,
  type RunnerProviderConformanceFixture
} from "../../domain/src/testing/runner-provider-conformance.js";

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
  type CancelCommandRequest,
  type CommandAuthorization,
  type DisposeEnvironmentRequest,
  type EnvironmentAuthorization,
  type InspectRepositoryRequest,
  type PrepareEnvironmentRequest,
  type ReadArtifactChunkRequest,
  type ReadCommandEventsRequest,
  type RepositoryInspection,
  type StartCommandRequest,
  type TerminalRunEvidence
} from "@autostack/contracts";

import { ArtifactStore } from "../src/artifact-store.js";
import { CommandActivityCoordinator } from "../src/command-activity.js";
import { CommandExecutor } from "../src/command-executor.js";
import { commandExecutorTestControl } from "../src/command-executor-control.js";
import { GitClient } from "../src/git-client.js";
import { LocalRunnerProvider, localRunnerHostControl } from "../src/local-runner-provider.js";
import { createLocalRunnerProviderForTesting } from "../src/local-runner-provider-testing.js";
import { DataPathPolicy } from "../src/path-policy.js";
import { WorktreeManager } from "../src/worktree-manager.js";
import {
  captureSourceCheckoutInvariant,
  createGitRepository,
  gitFixtureCommand
} from "./fixtures/create-git-repository.js";
import {
  FakeAuthenticatedGuardianLauncher,
  FakeProcessTreeController,
  FakePtyFactory
} from "./fixtures/fake-pty.js";

const NOW = "2026-08-21T12:00:00.000Z";
vi.setConfig({ testTimeout: 15_000 });
const roots: string[] = [];
const providers: LocalRunnerProvider[] = [];
let counter = 0;

const uuid = (): string => `60000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const hex = (value: string): string => value.repeat(64);

const ids = () => ({
  workspaceId: createId("workspace", uuid()),
  runId: createId("run", uuid()),
  environmentId: createId("environment", uuid()),
  commandId: createId("command", uuid()),
  environmentAuthorizationId: createId("environmentAuthorization", uuid()),
  commandAuthorizationId: createId("commandAuthorization", uuid()),
  environmentApprovalId: createId("approval", uuid()),
  commandApprovalId: createId("approval", uuid()),
  artifactId: createId("artifact", uuid())
});

const environmentAuthorization = async (
  inspection: RepositoryInspection,
  identity: ReturnType<typeof ids>,
  branch: string
): Promise<EnvironmentAuthorization> => {
  const scope = {
    workspaceId: identity.workspaceId,
    runId: identity.runId,
    environmentId: identity.environmentId,
    repositoryIdentity: inspection.repositoryIdentity,
    sourceCommit: inspection.sourceCommit,
    branch,
    cwdRoot: ".",
    resourceLimits: { cpu: 2, memoryMb: 512, durationSeconds: 120 },
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    allowedCredentialRefIds: []
  };
  const envelope = {
    id: identity.environmentAuthorizationId,
    approvalId: identity.environmentApprovalId,
    approvalEvidenceDigest: await digestExecutionScope(scope),
    scope,
    createdAt: "2026-08-21T11:00:00.000Z",
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  return EnvironmentAuthorizationSchema.parse({
    ...envelope,
    digest: await digestEnvironmentAuthorization({ ...envelope, digest: hex("0") })
  });
};

const commandAuthorization = async (
  prepare: PrepareEnvironmentRequest,
  identity: ReturnType<typeof ids>,
  command: StartCommandRequest["command"]
): Promise<CommandAuthorization> => {
  const scope = {
    environmentAuthorizationId: prepare.authorization.id,
    environmentAuthorizationDigest: prepare.authorization.digest,
    workspaceId: identity.workspaceId,
    runId: identity.runId,
    environmentId: identity.environmentId,
    commandId: identity.commandId,
    action: "implement" as const,
    commandDigest: await digestCommandSpec(command),
    repositoryIdentity: prepare.authorization.scope.repositoryIdentity,
    sourceCommit: prepare.sourceCommit,
    branch: prepare.branch,
    cwdRoot: ".",
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    resourceLimits: { cpu: 1, memoryMb: 256, durationSeconds: 30 },
    allowedCredentialRefIds: []
  };
  const envelope = {
    id: identity.commandAuthorizationId,
    approvalId: identity.commandApprovalId,
    approvalEvidenceDigest: await digestCommandScope(scope),
    scope,
    createdAt: "2026-08-21T11:30:00.000Z",
    expiresAt: "2026-08-21T12:30:00.000Z"
  };
  return CommandAuthorizationSchema.parse({
    ...envelope,
    digest: await digestCommandAuthorization({ ...envelope, digest: hex("0") })
  });
};

interface RealFixture {
  readonly provider: LocalRunnerProvider;
  readonly manager: WorktreeManager;
  readonly executor: CommandExecutor;
  readonly repository: Awaited<ReturnType<typeof createGitRepository>>;
  readonly dataRoot: string;
  readonly inspection: RepositoryInspection;
  readonly prepare: PrepareEnvironmentRequest;
  readonly start: StartCommandRequest;
  readonly pty: FakePtyFactory;
  readonly processTree: FakeProcessTreeController;
  readonly evidence: TerminalRunEvidence;
  authorizeDisposal(): void;
  recordTerminalEvidence(evidence: TerminalRunEvidence): void;
}

const composeReal = async (input?: {
  readonly repository?: Awaited<ReturnType<typeof createGitRepository>>;
  readonly dataRoot?: string;
  readonly prepare?: PrepareEnvironmentRequest;
  readonly start?: StartCommandRequest;
  readonly artifactId?: ReturnType<typeof ids>["artifactId"];
  readonly subscriberQueueFrames?: number;
}): Promise<RealFixture> => {
  const repository = input?.repository ?? (await createGitRepository());
  if (input?.repository === undefined) roots.push(repository.root);
  const dataRoot = input?.dataRoot ?? (await mkdtemp(join(tmpdir(), "autostack-provider-real-")));
  if (input?.dataRoot === undefined) roots.push(dataRoot);
  const activity = new CommandActivityCoordinator();
  let authorizedEvidence: TerminalRunEvidence | undefined;
  let clockTick = 0;
  const manager = await WorktreeManager.create({
    dataRoot,
    now: () => new Date(Date.parse(NOW) + clockTick++).toISOString(),
    deferStartupDisposal: true,
    verifyTerminalEvidence: (verification) =>
      authorizedEvidence !== undefined &&
      JSON.stringify(verification.terminalRunEvidence) === JSON.stringify(authorizedEvidence),
    acquireEnvironmentQuiescence: (environmentId) =>
      activity.acquireEnvironmentQuiescence(environmentId),
    trustedGitExecutable: "/usr/bin/git"
  });
  const paths = await DataPathPolicy.openExisting(dataRoot);
  const inspector = await GitClient.create({
    managedWorktreeRoot: await paths.ensureDirectory("worktrees"),
    privateConfigRoot: await paths.ensureDirectory("git-config"),
    trustedGitExecutable: "/usr/bin/git"
  });
  const inspection = (
    await inspector.inspectRepository({ sourcePath: repository.sourcePath, baseRef: "main" })
  ).inspection;
  const identity = ids();
  const authorization =
    input?.prepare?.authorization ??
    (await environmentAuthorization(inspection, identity, `autostack/${uuid()}-provider`));
  const prepare =
    input?.prepare ??
    ({
      workspaceId: authorization.scope.workspaceId,
      runId: authorization.scope.runId,
      environmentId: authorization.scope.environmentId,
      inspection,
      sourceCommit: inspection.sourceCommit,
      branch: authorization.scope.branch,
      authorization,
      idempotency: { key: "prepare-real" }
    } satisfies PrepareEnvironmentRequest);
  const command = {
    executable: "echo",
    args: ["verified"],
    cwd: ".",
    environment: [],
    timeoutSeconds: 30,
    terminal: { columns: 100, rows: 30 }
  };
  const commandIdentity = {
    ...identity,
    workspaceId: prepare.workspaceId,
    runId: prepare.runId,
    environmentId: prepare.environmentId,
    environmentAuthorizationId: prepare.authorization.id
  };
  const commandAuth = await commandAuthorization(prepare, commandIdentity, command);
  const start: StartCommandRequest = input?.start ?? {
    workspaceId: prepare.workspaceId,
    runId: prepare.runId,
    environmentId: prepare.environmentId,
    commandId: commandIdentity.commandId,
    command,
    environmentAuthorizationId: prepare.authorization.id,
    environmentAuthorizationDigest: prepare.authorization.digest,
    authorization: commandAuth,
    idempotency: { key: "command-real" }
  };
  const artifacts = await ArtifactStore.create({ dataRoot });
  const pty = new FakePtyFactory();
  const processTree = new FakeProcessTreeController();
  pty.processTreeAuthority = processTree;
  const launcher = new FakeAuthenticatedGuardianLauncher({
    artifactStore: artifacts,
    spawnAuthority: pty,
    now: () => NOW,
    monotonicNowMs: () => 100
  });
  const executor = await CommandExecutor.create({
    dataRoot,
    worktrees: manager,
    artifactStore: artifacts,
    activity,
    guardianLauncher: launcher,
    async resolveCredentials() {
      return [];
    },
    executableResolver: {
      async resolve() {
        return {
          canonicalPath: "/bin/echo",
          identityDigest: hex("e"),
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
      cancellationGraceMs: 10,
      eofSettleMs: 10,
      subscriberQueueFrames: input?.subscriberQueueFrames ?? 64,
      subscriberQueueBytes: 1_048_576
    },
    now: () => NOW,
    monotonicNowMs: () => 100,
    createArtifactId: () => input?.artifactId ?? identity.artifactId,
    createGuardianSession: () => ({
      sessionId: `provider-${counter}`,
      secret: Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
      bindingDigest: hex("f")
    })
  });
  await manager.resumePendingDisposals();
  const provider = createLocalRunnerProviderForTesting({
    inspector,
    worktrees: manager,
    executor,
    artifacts,
    now: () => NOW,
    limits: {
      eventBytes: 65_536,
      replayBytes: 1_048_576,
      transcriptBytes: 1_048_576,
      artifactBytes: 1_048_576
    }
  });
  providers.push(provider);
  const evidence = {
    status: "completed" as const,
    terminalEventSequence: 3,
    terminalEventDigest: hex("d")
  };
  return {
    provider,
    manager,
    executor,
    repository,
    dataRoot,
    inspection,
    prepare,
    start,
    pty,
    processTree,
    evidence,
    authorizeDisposal() {
      authorizedEvidence = evidence;
    },
    recordTerminalEvidence(value) {
      authorizedEvidence = value;
    }
  };
};

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close().catch(() => undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (sharedData !== undefined)
    await rm(sharedData.repository.root, { recursive: true, force: true });
  previousConformanceReal = undefined;
  sharedData = undefined;
});

describe("LocalRunnerProvider real composition", () => {
  it("replays a prepared environment after restart without touching the source checkout", async () => {
    const repository = await createGitRepository();
    roots.push(repository.root);
    const before = await captureSourceCheckoutInvariant(repository);
    const first = await composeReal({ repository });
    const prepared = await first.provider.prepareEnvironment(first.prepare);
    await first.provider.close();

    const restarted = await composeReal({
      repository,
      dataRoot: first.dataRoot,
      prepare: first.prepare
    });
    await expect(
      localRunnerHostControl(restarted.provider).prepareEnvironmentWithReplay(first.prepare)
    ).resolves.toEqual({ environment: prepared, replayed: true });
    expect(await captureSourceCheckoutInvariant(repository)).toEqual(before);
  });

  it("runs a real guardian command and disposes only with exact evidence without touching source", async () => {
    const fixture = await composeReal();
    const sourceBefore = await captureSourceCheckoutInvariant(fixture.repository);
    await fixture.provider.prepareEnvironment(fixture.prepare);
    await fixture.provider.startCommand(fixture.start);
    const events = fixture.provider.readCommandEvents({
      workspaceId: fixture.start.workspaceId,
      runId: fixture.start.runId,
      environmentId: fixture.start.environmentId,
      commandId: fixture.start.commandId,
      environmentAuthorizationId: fixture.start.environmentAuthorizationId,
      environmentAuthorizationDigest: fixture.start.environmentAuthorizationDigest,
      commandAuthorizationId: fixture.start.authorization.id,
      commandAuthorizationDigest: fixture.start.authorization.digest,
      after: 0
    });
    fixture.processTree.actualExit = { exitCode: 0, signal: null };
    fixture.pty.session.emitData(Buffer.from("verified\n"));
    fixture.pty.session.emitEof();
    fixture.pty.session.emitExit({ exitCode: 0, signal: null });
    const collected = [];
    for await (const item of events) collected.push(item);
    const terminal = collected.findLast(
      (item) => item.type === "runner.event" && item.event.type === "command.completed"
    );
    if (terminal?.type !== "runner.event" || terminal.event.type !== "command.completed") {
      throw new TypeError("Missing real terminal evidence.");
    }
    await fixture.provider.interruptAndDrain();
    expect(terminal.event.transcript.digest).toMatch(/^[a-f0-9]{64}$/);
    const disposal = {
      workspaceId: fixture.prepare.workspaceId,
      runId: fixture.prepare.runId,
      environmentId: fixture.prepare.environmentId,
      environmentAuthorizationId: fixture.prepare.authorization.id,
      environmentAuthorizationDigest: fixture.prepare.authorization.digest,
      terminalRunEvidence: fixture.evidence,
      idempotency: { key: "dispose-real" }
    } as const;
    await expect(fixture.provider.disposeEnvironment(disposal)).rejects.toMatchObject({
      code: "terminal_evidence_invalid"
    });
    fixture.authorizeDisposal();
    await expect(fixture.provider.disposeEnvironment(disposal)).resolves.toMatchObject({
      disposed: true,
      replayed: false
    });
    expect(await captureSourceCheckoutInvariant(fixture.repository)).toEqual(sourceBefore);
  });

  it("retains a dirty managed worktree when disposal evidence is otherwise valid", async () => {
    const fixture = await composeReal();
    await fixture.provider.prepareEnvironment(fixture.prepare);
    const managed = await fixture.manager.resolvePreparedEnvironment(fixture.prepare.environmentId);
    await writeFile(join(managed.managedPath, "dirty.txt"), "retain\n", { mode: 0o600 });
    fixture.authorizeDisposal();
    await expect(
      fixture.provider.disposeEnvironment({
        workspaceId: fixture.prepare.workspaceId,
        runId: fixture.prepare.runId,
        environmentId: fixture.prepare.environmentId,
        environmentAuthorizationId: fixture.prepare.authorization.id,
        environmentAuthorizationDigest: fixture.prepare.authorization.digest,
        terminalRunEvidence: fixture.evidence,
        idempotency: { key: "dispose-dirty" }
      })
    ).rejects.toMatchObject({ code: "dirty_worktree" });
    await expect(access(managed.managedPath)).resolves.toBeUndefined();
  });
});

interface RealConformanceData extends Omit<RunnerProviderConformanceFixture, "create"> {
  readonly repository: Awaited<ReturnType<typeof createGitRepository>>;
}

const inspectRealRepository = async (
  repository: Awaited<ReturnType<typeof createGitRepository>>
): Promise<RepositoryInspection> => {
  const dataRoot = await mkdtemp(join(tmpdir(), "autostack-provider-inspection-"));
  let manager: WorktreeManager | undefined;
  try {
    const activity = new CommandActivityCoordinator();
    let clockTick = 0;
    manager = await WorktreeManager.create({
      dataRoot,
      now: () => new Date(Date.parse(NOW) + clockTick++).toISOString(),
      deferStartupDisposal: true,
      verifyTerminalEvidence: async () => false,
      acquireEnvironmentQuiescence: (environmentId) =>
        activity.acquireEnvironmentQuiescence(environmentId),
      trustedGitExecutable: "/usr/bin/git"
    });
    const paths = await DataPathPolicy.openExisting(dataRoot);
    const inspector = await GitClient.create({
      managedWorktreeRoot: await paths.ensureDirectory("worktrees"),
      privateConfigRoot: await paths.ensureDirectory("git-config"),
      trustedGitExecutable: "/usr/bin/git"
    });
    return (
      await inspector.inspectRepository({ sourcePath: repository.sourcePath, baseRef: "main" })
    ).inspection;
  } finally {
    await manager?.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
  }
};

const buildRealConformanceData = async (
  existingRepository?: Awaited<ReturnType<typeof createGitRepository>>
): Promise<RealConformanceData> => {
  const repository = existingRepository ?? (await createGitRepository());
  const inspection = await inspectRealRepository(repository);
  const primary = ids();
  const nextEnvironment = { ...ids(), workspaceId: primary.workspaceId, runId: primary.runId };
  const nextCommandIdentity = {
    ...ids(),
    workspaceId: primary.workspaceId,
    runId: primary.runId,
    environmentId: primary.environmentId,
    environmentAuthorizationId: primary.environmentAuthorizationId
  };
  const foreignIdentity = ids();
  const authorization = await environmentAuthorization(
    inspection,
    primary,
    `autostack/${uuid()}-conformance`
  );
  const conflictingAuthorization = await environmentAuthorization(
    inspection,
    primary,
    `autostack/${uuid()}-conflicting`
  );
  const nextAuthorization = await environmentAuthorization(
    inspection,
    nextEnvironment,
    `autostack/${uuid()}-next`
  );
  const prepare: PrepareEnvironmentRequest = {
    workspaceId: primary.workspaceId,
    runId: primary.runId,
    environmentId: primary.environmentId,
    inspection,
    sourceCommit: inspection.sourceCommit,
    branch: authorization.scope.branch,
    authorization,
    idempotency: { key: "prepare-conformance" }
  };
  const conflictingPrepare: PrepareEnvironmentRequest = {
    ...prepare,
    branch: conflictingAuthorization.scope.branch,
    authorization: conflictingAuthorization
  };
  const nextPrepare: PrepareEnvironmentRequest = {
    ...prepare,
    environmentId: nextEnvironment.environmentId,
    branch: nextAuthorization.scope.branch,
    authorization: nextAuthorization,
    idempotency: { key: "prepare-next" }
  };
  const command = {
    executable: "echo",
    args: ["verified"],
    cwd: ".",
    environment: [],
    timeoutSeconds: 30,
    terminal: { columns: 100, rows: 30 }
  };
  const conflictingCommand = { ...command, args: ["conflict"] };
  const nextCommand = { ...command, args: ["next"] };
  const commandAuth = await commandAuthorization(prepare, primary, command);
  const conflictingCommandAuth = await commandAuthorization(prepare, primary, conflictingCommand);
  const nextCommandAuth = await commandAuthorization(prepare, nextCommandIdentity, nextCommand);
  const start: StartCommandRequest = {
    workspaceId: primary.workspaceId,
    runId: primary.runId,
    environmentId: primary.environmentId,
    commandId: primary.commandId,
    command,
    environmentAuthorizationId: authorization.id,
    environmentAuthorizationDigest: authorization.digest,
    authorization: commandAuth,
    idempotency: { key: "command-conformance" }
  };
  const conflictingStart: StartCommandRequest = {
    ...start,
    command: conflictingCommand,
    authorization: conflictingCommandAuth
  };
  const nextStart: StartCommandRequest = {
    ...start,
    commandId: nextCommandIdentity.commandId,
    command: nextCommand,
    authorization: nextCommandAuth,
    idempotency: { key: "command-next" }
  };
  const events: ReadCommandEventsRequest = {
    workspaceId: start.workspaceId,
    runId: start.runId,
    environmentId: start.environmentId,
    commandId: start.commandId,
    environmentAuthorizationId: start.environmentAuthorizationId,
    environmentAuthorizationDigest: start.environmentAuthorizationDigest,
    commandAuthorizationId: start.authorization.id,
    commandAuthorizationDigest: start.authorization.digest,
    after: 0
  };
  const cancel: CancelCommandRequest = {
    workspaceId: events.workspaceId,
    runId: events.runId,
    environmentId: events.environmentId,
    commandId: events.commandId,
    environmentAuthorizationId: events.environmentAuthorizationId,
    environmentAuthorizationDigest: events.environmentAuthorizationDigest,
    commandAuthorizationId: events.commandAuthorizationId,
    commandAuthorizationDigest: events.commandAuthorizationDigest,
    idempotency: { key: "cancel-conformance" }
  };
  const artifact: ReadArtifactChunkRequest = {
    workspaceId: events.workspaceId,
    runId: events.runId,
    environmentId: events.environmentId,
    commandId: events.commandId,
    environmentAuthorizationId: events.environmentAuthorizationId,
    environmentAuthorizationDigest: events.environmentAuthorizationDigest,
    commandAuthorizationId: events.commandAuthorizationId,
    commandAuthorizationDigest: events.commandAuthorizationDigest,
    artifactId: primary.artifactId,
    offset: 0,
    length: 1_048_576
  };
  const terminalRunEvidence: TerminalRunEvidence = {
    status: "completed",
    terminalEventSequence: 3,
    terminalEventDigest: await digestVersionedValue("autostack.provider-conformance-terminal", {
      commandId: primary.commandId,
      sequence: 3
    })
  };
  const dispose: DisposeEnvironmentRequest = {
    workspaceId: prepare.workspaceId,
    runId: prepare.runId,
    environmentId: prepare.environmentId,
    environmentAuthorizationId: prepare.authorization.id,
    environmentAuthorizationDigest: prepare.authorization.digest,
    terminalRunEvidence,
    idempotency: { key: "dispose-conformance" }
  };
  const wrongEnvironmentEvidence = {
    ...authorization,
    approvalEvidenceDigest: hex("f"),
    digest: hex("0")
  };
  wrongEnvironmentEvidence.digest = await digestEnvironmentAuthorization(wrongEnvironmentEvidence);
  const wrongCommandEvidence = {
    ...commandAuth,
    approvalEvidenceDigest: hex("f"),
    digest: hex("0")
  };
  wrongCommandEvidence.digest = await digestCommandAuthorization(wrongCommandEvidence);
  const broadenedScope = {
    ...commandAuth.scope,
    resourceLimits: {
      ...commandAuth.scope.resourceLimits,
      cpu: prepare.authorization.scope.resourceLimits.cpu + 1
    }
  };
  const broadenedAuthorization = {
    ...commandAuth,
    scope: broadenedScope,
    approvalEvidenceDigest: await digestCommandScope(broadenedScope),
    digest: hex("0")
  };
  broadenedAuthorization.digest = await digestCommandAuthorization(broadenedAuthorization);
  return {
    repository,
    inspectionRequest: {
      sourcePath: repository.sourcePath,
      baseRef: "main"
    } satisfies InspectRepositoryRequest,
    prepare,
    conflictingPrepare,
    nextPrepare,
    start,
    conflictingStart,
    nextStart,
    events,
    cancel,
    artifact,
    dispose,
    expectedArtifactBytes: Uint8Array.from(Buffer.from("verified\n")),
    foreign: {
      workspaceId: foreignIdentity.workspaceId,
      runId: foreignIdentity.runId,
      environmentId: foreignIdentity.environmentId,
      commandId: foreignIdentity.commandId,
      environmentAuthorizationId: foreignIdentity.environmentAuthorizationId,
      commandAuthorizationId: foreignIdentity.commandAuthorizationId,
      artifactId: foreignIdentity.artifactId,
      digest: hex("f")
    },
    tampered: {
      prepareWrongAuthorizationDigest: {
        ...prepare,
        authorization: { ...authorization, digest: hex("f") }
      },
      prepareWrongApprovalEvidence: {
        ...prepare,
        authorization: EnvironmentAuthorizationSchema.parse(wrongEnvironmentEvidence)
      },
      startWrongAuthorizationDigest: {
        ...start,
        authorization: { ...commandAuth, digest: hex("f") }
      },
      startWrongApprovalEvidence: {
        ...start,
        authorization: CommandAuthorizationSchema.parse(wrongCommandEvidence)
      },
      startCommandSpecMismatch: {
        ...start,
        command: { ...command, args: ["authorization-mismatch"] }
      },
      startBroadenedAuthorization: {
        ...start,
        authorization: CommandAuthorizationSchema.parse(broadenedAuthorization)
      }
    }
  };
};

let sharedData: RealConformanceData | undefined;
let previousConformanceReal: RealFixture | undefined;
const requireSharedData = (): RealConformanceData => {
  if (sharedData === undefined) throw new TypeError("Real conformance data is unavailable.");
  return sharedData;
};

const createRealConformanceInstance = async () => {
  const data = requireSharedData();
  if (previousConformanceReal !== undefined) {
    await previousConformanceReal.provider.close().catch(() => undefined);
    await rm(previousConformanceReal.dataRoot, { recursive: true, force: true });
    const providerIndex = providers.indexOf(previousConformanceReal.provider);
    if (providerIndex >= 0) providers.splice(providerIndex, 1);
    const rootIndex = roots.indexOf(previousConformanceReal.dataRoot);
    if (rootIndex >= 0) roots.splice(rootIndex, 1);
    const worktreeRecords = await gitFixtureCommand(data.repository.sourcePath, [
      "worktree",
      "list",
      "--porcelain"
    ]);
    const branchRecord = worktreeRecords
      .split("\n\n")
      .find((record) => record.includes(`branch refs/heads/${data.prepare.branch}`));
    const managedPath = branchRecord
      ?.split("\n")
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (managedPath !== undefined) {
      await gitFixtureCommand(data.repository.sourcePath, [
        "worktree",
        "unlock",
        managedPath
      ]).catch(() => undefined);
    }
    await gitFixtureCommand(data.repository.sourcePath, ["worktree", "prune", "--expire", "now"]);
    await gitFixtureCommand(data.repository.sourcePath, [
      "branch",
      "-D",
      data.prepare.branch
    ]).catch(async () => {
      const branches = await gitFixtureCommand(data.repository.sourcePath, ["branch", "--list"]);
      if (branches.includes(data.prepare.branch))
        throw new TypeError("Conformance branch could not be retired.");
    });
  }
  const real = await composeReal({
    repository: data.repository,
    prepare: data.prepare,
    start: data.start,
    artifactId: data.artifact.artifactId,
    subscriberQueueFrames: 1
  });
  previousConformanceReal = real;
  const completeCommand = async (commandId: typeof data.start.commandId): Promise<void> => {
    if (commandId !== data.start.commandId) throw new TypeError("Unknown conformance command.");
    real.processTree.actualExit = { exitCode: 0, signal: null };
    real.pty.session.emitData(data.expectedArtifactBytes);
    real.pty.session.emitEof();
    real.pty.session.emitExit({ exitCode: 0, signal: null });
    for await (const _item of real.provider.readCommandEvents(data.events)) {
      // Drain through the real registry so terminal publication and lease release settle.
    }
    for (
      let attempt = 0;
      attempt < 1_000 && commandExecutorTestControl(real.executor).activeGuardianCount() > 0;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    if (commandExecutorTestControl(real.executor).activeGuardianCount() > 0)
      throw new TypeError("Conformance guardian authority did not settle.");
    let artifactReady = false;
    for (let attempt = 0; attempt < 1_000 && !artifactReady; attempt += 1) {
      try {
        await real.provider.readArtifactChunk({ ...data.artifact, length: 1 });
        artifactReady = true;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    }
    if (!artifactReady) throw new TypeError("Conformance artifact did not become authoritative.");
  };
  const control = {
    completeCommand,
    async recordTerminalRunEvidence(
      environmentId: typeof data.prepare.environmentId,
      evidence: TerminalRunEvidence
    ) {
      if (environmentId !== data.prepare.environmentId)
        throw new TypeError("Unknown conformance environment.");
      real.recordTerminalEvidence(evidence);
    },
    async inspectRetainedCommand(commandId: typeof data.start.commandId) {
      return commandExecutorTestControl(real.executor).retainedRequest(commandId);
    },
    async guardianLeaseCount() {
      return commandExecutorTestControl(real.executor).activeGuardianCount();
    }
  };
  return { provider: real.provider, lifecycle: real.provider, control };
};

const sharedFixture: RunnerProviderConformanceFixture & LocalRunnerLifecycleConformanceFixture = {
  create: createRealConformanceInstance,
  get inspectionRequest() {
    return requireSharedData().inspectionRequest;
  },
  get prepare() {
    return requireSharedData().prepare;
  },
  get conflictingPrepare() {
    return requireSharedData().conflictingPrepare;
  },
  get nextPrepare() {
    return requireSharedData().nextPrepare;
  },
  get start() {
    return requireSharedData().start;
  },
  get conflictingStart() {
    return requireSharedData().conflictingStart;
  },
  get nextStart() {
    return requireSharedData().nextStart;
  },
  get events() {
    return requireSharedData().events;
  },
  get cancel() {
    return requireSharedData().cancel;
  },
  get artifact() {
    return requireSharedData().artifact;
  },
  get dispose() {
    return requireSharedData().dispose;
  },
  get expectedArtifactBytes() {
    return requireSharedData().expectedArtifactBytes;
  },
  get foreign() {
    return requireSharedData().foreign;
  },
  get tampered() {
    return requireSharedData().tampered;
  }
};

beforeEach(async () => {
  sharedData = await buildRealConformanceData();
});

describeRunnerProviderConformance("LocalRunnerProvider shared provider conformance", sharedFixture);
describeLocalRunnerLifecycleConformance(
  "LocalRunnerProvider shared lifecycle conformance",
  sharedFixture
);
