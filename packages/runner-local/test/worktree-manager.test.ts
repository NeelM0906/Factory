import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  canonicalizeEnvironmentAuthorizationForDigest,
  createId,
  type DisposeEnvironmentRequest,
  type EnvironmentAuthorization,
  type PrepareEnvironmentRequest
} from "@autostack/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitClient } from "../src/git-client.js";
import { EnvironmentRegistry } from "../src/environment-registry.js";
import { acquireCommandGuardianLease } from "../src/data-root-lock.js";
import {
  WorktreeManager,
  WorktreeManagerError,
  type WorktreeManagerOptions
} from "../src/worktree-manager.js";
import { assertTargetRecord, exactTargetRecord } from "../src/worktree-manager-shared.js";
import { BoundedProcessRunner, type ProcessRunner } from "../src/process-runner.js";
import {
  captureSourceCheckoutInvariant,
  configureRepository,
  createGitRepository,
  gitFixtureCommand
} from "./fixtures/create-git-repository.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const roots: string[] = [];

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForProcessExit = async (pid: number, timeoutMs = 2_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !processIsAlive(pid);
};

const createAuthorization = (
  inspection: PrepareEnvironmentRequest["inspection"],
  branch: string,
  environmentId = createId("environment", UUID)
): EnvironmentAuthorization => {
  const withoutDigest = {
    id: createId("environmentAuthorization", UUID),
    approvalId: createId("approval", UUID),
    approvalEvidenceDigest: "a".repeat(64),
    scope: {
      workspaceId: createId("workspace", UUID),
      runId: createId("run", UUID),
      environmentId,
      repositoryIdentity: inspection.repositoryIdentity,
      sourceCommit: inspection.sourceCommit,
      branch,
      cwdRoot: ".",
      resourceLimits: { cpu: 2, memoryMb: 512, durationSeconds: 120 },
      networkPolicy: "host" as const,
      filesystemDisclosure: "host_user" as const,
      allowedCredentialRefIds: []
    },
    createdAt: "2026-08-21T11:00:00.000Z",
    expiresAt: "2026-08-21T13:00:00.000Z"
  };
  return {
    ...withoutDigest,
    digest: createHash("sha256")
      .update(
        canonicalizeEnvironmentAuthorizationForDigest({
          ...withoutDigest,
          digest: "0".repeat(64)
        }),
        "utf8"
      )
      .digest("hex")
  };
};

const createSetup = async () => {
  const fixture = await createGitRepository();
  roots.push(fixture.root);
  const inspectionClient = await GitClient.create({
    managedWorktreeRoot: fixture.managedWorktreeRoot,
    privateConfigRoot: fixture.privateConfigRoot,
    trustedGitExecutable: "/usr/bin/git"
  });
  const inspected = await inspectionClient.inspectRepository({
    sourcePath: fixture.sourcePath,
    baseRef: fixture.baseBranch
  });
  const branch = `autostack/${UUID}-manager`;
  const authorization = createAuthorization(inspected.inspection, branch);
  const request: PrepareEnvironmentRequest = {
    workspaceId: authorization.scope.workspaceId,
    runId: authorization.scope.runId,
    environmentId: authorization.scope.environmentId,
    inspection: inspected.inspection,
    sourceCommit: inspected.inspection.sourceCommit,
    branch,
    authorization,
    idempotency: { key: "prepare-1" }
  };
  const dataRoot = join(fixture.root, "autostack-data");
  return { fixture, dataRoot, inspected, request };
};

const managerOptions = (
  dataRoot: string,
  start = "2026-08-21T12:00:00.000Z"
): WorktreeManagerOptions => {
  let tick = 0;
  return {
    dataRoot,
    now: () => new Date(Date.parse(start) + tick++).toISOString(),
    verifyTerminalEvidence: async () => true,
    acquireEnvironmentQuiescence: async () => ({ close: async () => undefined }),
    trustedGitExecutable: "/usr/bin/git"
  };
};

const disposalRequest = (request: PrepareEnvironmentRequest): DisposeEnvironmentRequest => ({
  workspaceId: request.workspaceId,
  runId: request.runId,
  environmentId: request.environmentId,
  environmentAuthorizationId: request.authorization.id,
  environmentAuthorizationDigest: request.authorization.digest,
  terminalRunEvidence: {
    status: "completed",
    terminalEventSequence: 7,
    terminalEventDigest: "b".repeat(64)
  },
  idempotency: { key: "dispose-1" }
});

const recordPhase4Disposal = async (
  dataRoot: string,
  request: PrepareEnvironmentRequest,
  recordedAt = "2026-08-21T12:01:00.000Z"
): Promise<EnvironmentRegistry> => {
  const registry = await EnvironmentRegistry.create({ dataRoot, now: () => recordedAt });
  const ready = await registry.recoverEnvironment(request.environmentId);
  if (ready?.phase !== "ready") throw new Error("expected a ready environment fixture");
  await registry.recordDisposalIntent({
    environmentId: request.environmentId,
    creationAttemptId: ready.intent.creationAttemptId,
    disposalRequestDigest: "6".repeat(64),
    environmentAuthorizationId: request.authorization.id,
    environmentAuthorizationDigest: request.authorization.digest,
    terminalRunEvidence: disposalRequest(request).terminalRunEvidence
  });
  return registry;
};

const phaseFile = (dataRoot: string, environmentId: string, sequence: number, phase: string) =>
  join(
    dataRoot,
    "environments",
    "journal",
    Buffer.from(environmentId).toString("hex"),
    `${String(sequence).padStart(2, "0")}-${phase}.json`
  );

const resignPhaseEvidence = (evidence: Record<string, unknown>): Record<string, unknown> => {
  const { evidenceDigest: _evidenceDigest, ...withoutDigest } = evidence;
  return {
    ...withoutDigest,
    evidenceDigest: createHash("sha256")
      .update(`autostack.environment-phase.v1\n${JSON.stringify(withoutDigest)}`, "utf8")
      .digest("hex")
  };
};

// Teardown races a writer: a Git subprocess that outlives its test can still be creating files
// under the root while the recursive removal walks it, which surfaces as ENOTEMPTY under full-suite
// parallel load. `rm` defaults to `maxRetries: 0`; retrying is the documented remedy.
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  );
});

describe("WorktreeManager", () => {
  it("rejects malformed construction and rematerializes only static diagnostics", async () => {
    await expect(WorktreeManager.create({} as never)).rejects.toEqual(
      expect.objectContaining({
        code: "invalid_request",
        message: "The worktree request is invalid."
      })
    );
    await expect(
      WorktreeManager.create({
        ...managerOptions("relative"),
        unexpected: true
      } as never)
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(new WorktreeManagerError("attacker" as never)).toMatchObject({
      code: "unsafe_state",
      message: "The worktree operation failed safely."
    });
  });

  it("holds one data-root lock for its lifetime and releases it on close", async () => {
    const { dataRoot } = await createSetup();
    const first = await WorktreeManager.create(managerOptions(dataRoot));

    await expect(WorktreeManager.create(managerOptions(dataRoot))).rejects.toMatchObject({
      name: "WorktreeManagerError",
      code: "root_busy",
      message: "The AutoStack data root is busy."
    });

    await first.close();
    await first.close();
    const replacement = await WorktreeManager.create(managerOptions(dataRoot));
    await replacement.close();
  });

  it("blocks startup while a command guardian still owns a durable lease", async () => {
    const { dataRoot } = await createSetup();
    const guardian = await acquireCommandGuardianLease(dataRoot, createId("command", UUID));

    await expect(WorktreeManager.create(managerOptions(dataRoot))).rejects.toMatchObject({
      code: "root_busy"
    });
    guardian.close();

    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.close();
  });

  it("releases its root lock when startup rejects unexpected managed state", async () => {
    const { dataRoot } = await createSetup();
    await mkdir(join(dataRoot, "worktrees", "unexpected"), {
      recursive: true,
      mode: 0o700
    });

    await expect(WorktreeManager.create(managerOptions(dataRoot))).rejects.toMatchObject({
      code: "maintenance_required"
    });
    await rm(join(dataRoot, "worktrees", "unexpected"), { recursive: true });

    const replacement = await WorktreeManager.create(managerOptions(dataRoot));
    await replacement.close();
  });

  it("rejects every new operation after its idempotent close", async () => {
    const { dataRoot } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.close();
    await manager.close();

    await expect(manager.listEnvironments()).rejects.toMatchObject({ code: "closed" });
  });

  it("creates the exact locked worktree without changing the source checkout", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const manager = await WorktreeManager.create(managerOptions(dataRoot));

    const prepared = await manager.prepareEnvironment(request);
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);

    expect(prepared).toMatchObject({
      environmentId: request.environmentId,
      workspaceId: request.workspaceId,
      runId: request.runId,
      repositoryIdentity: request.inspection.repositoryIdentity,
      sourceCommit: request.sourceCommit,
      branch: request.branch,
      authorization: request.authorization,
      state: "prepared"
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(resolved.environment).toEqual(prepared);
    expect(resolved.managedPath).toBe(
      join(
        dataRoot,
        "worktrees",
        request.inspection.repositoryIdentity.slice("local-sha256:".length),
        Buffer.from(request.environmentId).toString("hex")
      )
    );
    expect(resolved.intentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await gitFixtureCommand(resolved.managedPath, ["rev-parse", "HEAD"])).toBe(
      request.sourceCommit
    );
    expect(await gitFixtureCommand(resolved.managedPath, ["symbolic-ref", "--short", "HEAD"])).toBe(
      request.branch
    );
    expect(
      await gitFixtureCommand(fixture.sourcePath, ["worktree", "list", "--porcelain"])
    ).toContain("locked AutoStack");
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    expect(await manager.listEnvironments()).toEqual([prepared]);
    await manager.close();
  });

  it("serializes concurrent identical prepares and keeps casing-distinct IDs isolated", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    const secondEnvironmentId =
      request.environmentId.toUpperCase() as PrepareEnvironmentRequest["environmentId"];
    const secondBranch = `${request.branch}-case`;
    const secondAuthorization = createAuthorization(
      request.inspection,
      secondBranch,
      secondEnvironmentId
    );
    const secondRequest: PrepareEnvironmentRequest = {
      ...request,
      environmentId: secondEnvironmentId,
      branch: secondBranch,
      authorization: secondAuthorization,
      idempotency: { key: "prepare-case" }
    };

    const [first, replay, second, secondReplay] = await Promise.all([
      manager.prepareEnvironment(request),
      manager.prepareEnvironment(request),
      manager.prepareEnvironment(secondRequest),
      manager.prepareEnvironment(secondRequest)
    ]);

    expect(replay).toEqual(first);
    expect(secondReplay).toEqual(second);
    expect(second.environmentId).not.toBe(first.environmentId);
    expect((await manager.resolvePreparedEnvironment(first.environmentId)).managedPath).not.toBe(
      (await manager.resolvePreparedEnvironment(second.environmentId)).managedPath
    );
    expect(new Set((await manager.listEnvironments()).map((item) => item.environmentId))).toEqual(
      new Set([request.environmentId, secondEnvironmentId])
    );
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await manager.close();
  });

  it("recovers a ready environment after restart and replays the exact request", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    const original = await first.prepareEnvironment(request);
    await first.close();

    const restarted = await WorktreeManager.create(
      managerOptions(dataRoot, "2026-08-21T12:02:00.000Z")
    );
    expect(await restarted.prepareEnvironment(request)).toEqual(original);
    expect(await restarted.listEnvironments()).toEqual([original]);
    await expect(
      restarted.prepareEnvironment({
        ...request,
        idempotency: { key: "different" }
      })
    ).rejects.toBeInstanceOf(WorktreeManagerError);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await restarted.close();
  });

  it("recovers the exact locked checkout from the post-add pre-ready crash state", async () => {
    const { fixture, dataRoot, inspected, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    let tick = 0;
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "c".repeat(32),
      now: () => new Date(Date.parse("2026-08-21T11:30:00.000Z") + tick++).toISOString()
    });
    let state = await registry.recordIntent({
      workspaceId: request.workspaceId,
      runId: request.runId,
      environmentId: request.environmentId,
      repositoryIdentity: request.inspection.repositoryIdentity,
      canonicalSourcePath: request.inspection.canonicalSourcePath,
      repositoryCommonDirectory: request.inspection.repositoryCommonDirectory,
      sourceCommit: request.sourceCommit,
      branch: request.branch,
      safeConfigDigest: inspected.safeConfigDigest,
      authorization: request.authorization,
      prepareRequestDigest: "5".repeat(64)
    });
    await mkdir(join(state.intent.managedPath, ".."), { recursive: true, mode: 0o700 });
    await gitFixtureCommand(fixture.sourcePath, [
      "worktree",
      "add",
      "--lock",
      "--reason",
      "AutoStack",
      "-b",
      request.branch,
      state.intent.managedPath,
      request.sourceCommit
    ]);
    state = await registry.recordWorktreeAdded({
      environmentId: request.environmentId,
      creationAttemptId: state.intent.creationAttemptId
    });
    expect(state.phase).toBe("worktree_added");

    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    expect((await manager.listEnvironments()).map((item) => item.environmentId)).toEqual([
      request.environmentId
    ]);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await manager.close();
  });

  it("attaches the exact unoccupied product branch after a branch-only crash", async () => {
    const { fixture, dataRoot, inspected, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    let tick = 0;
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "d".repeat(32),
      now: () => new Date(Date.parse("2026-08-21T11:30:00.000Z") + tick++).toISOString()
    });
    await registry.recordIntent({
      workspaceId: request.workspaceId,
      runId: request.runId,
      environmentId: request.environmentId,
      repositoryIdentity: request.inspection.repositoryIdentity,
      canonicalSourcePath: request.inspection.canonicalSourcePath,
      repositoryCommonDirectory: request.inspection.repositoryCommonDirectory,
      sourceCommit: request.sourceCommit,
      branch: request.branch,
      safeConfigDigest: inspected.safeConfigDigest,
      authorization: request.authorization,
      prepareRequestDigest: "5".repeat(64)
    });
    await gitFixtureCommand(fixture.sourcePath, ["branch", request.branch, request.sourceCommit]);

    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    const [prepared] = await manager.listEnvironments();
    expect(prepared?.environmentId).toBe(request.environmentId);
    expect(
      await gitFixtureCommand(fixture.sourcePath, ["worktree", "list", "--porcelain"])
    ).toContain(`branch refs/heads/${request.branch}`);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await manager.close();
  });

  it("refuses disposal before journaling when environment quiescence is unavailable", async () => {
    const { dataRoot, request } = await createSetup();
    const options = managerOptions(dataRoot);
    const manager = await WorktreeManager.create({
      ...options,
      acquireEnvironmentQuiescence: async () => undefined
    });
    await manager.prepareEnvironment(request);

    await expect(manager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "active_commands"
    });
    expect(
      (await manager.resolvePreparedEnvironment(request.environmentId)).environment.environmentId
    ).toBe(request.environmentId);
    await manager.close();
  });

  it("preserves a dirty worktree and rejects untrusted terminal evidence", async () => {
    const { dataRoot, request } = await createSetup();
    const options = managerOptions(dataRoot);
    const invalidEvidence = await WorktreeManager.create({
      ...options,
      verifyTerminalEvidence: async () => false
    });
    await invalidEvidence.prepareEnvironment(request);
    const resolved = await invalidEvidence.resolvePreparedEnvironment(request.environmentId);

    await expect(
      invalidEvidence.disposeEnvironment(disposalRequest(request))
    ).rejects.toMatchObject({ code: "terminal_evidence_invalid" });
    await writeFile(join(resolved.managedPath, "untracked.txt"), "retain me\n");
    await invalidEvidence.close();

    const dirtyManager = await WorktreeManager.create(managerOptions(dataRoot));
    await expect(dirtyManager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "dirty_worktree"
    });
    expect(await gitFixtureCommand(resolved.managedPath, ["status", "--porcelain"])).toContain(
      "untracked.txt"
    );
    await dirtyManager.close();
  });

  it("disposes only the clean managed checkout, retains its branch, and replays after restart", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);

    expect(await manager.disposeEnvironment(disposalRequest(request))).toEqual({
      environmentId: request.environmentId,
      disposed: true,
      replayed: false
    });
    expect(await gitFixtureCommand(fixture.sourcePath, ["rev-parse", request.branch])).toBe(
      request.sourceCommit
    );
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    expect(await manager.listEnvironments()).toEqual([]);
    await manager.close();

    const restarted = await WorktreeManager.create(managerOptions(dataRoot));
    expect(await restarted.disposeEnvironment(disposalRequest(request))).toEqual({
      environmentId: request.environmentId,
      disposed: true,
      replayed: true
    });
    await expect(
      restarted.disposeEnvironment({
        ...disposalRequest(request),
        idempotency: { key: "different-dispose" }
      })
    ).rejects.toMatchObject({ code: "environment_conflict" });
    await restarted.close();
  });

  it("resumes a durable phase-4 disposal after unlock without inferring absence", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    await first.prepareEnvironment(request);
    const resolved = await first.resolvePreparedEnvironment(request.environmentId);
    await first.close();

    let tick = 0;
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      now: () => new Date(Date.parse("2026-08-21T12:01:00.000Z") + tick++).toISOString()
    });
    const ready = await registry.recoverEnvironment(request.environmentId);
    expect(ready?.phase).toBe("ready");
    await registry.recordDisposalIntent({
      environmentId: request.environmentId,
      creationAttemptId: ready!.intent.creationAttemptId,
      disposalRequestDigest: "6".repeat(64),
      environmentAuthorizationId: request.authorization.id,
      environmentAuthorizationDigest: request.authorization.digest,
      terminalRunEvidence: disposalRequest(request).terminalRunEvidence
    });
    await gitFixtureCommand(fixture.sourcePath, ["worktree", "unlock", resolved.managedPath]);

    const restarted = await WorktreeManager.create(
      managerOptions(dataRoot, "2026-08-21T12:02:00.000Z")
    );
    expect(await restarted.listEnvironments()).toEqual([]);
    expect(await gitFixtureCommand(fixture.sourcePath, ["rev-parse", request.branch])).toBe(
      request.sourceCommit
    );
    await expect(gitFixtureCommand(resolved.managedPath, ["rev-parse", "HEAD"])).rejects.toThrow();
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await restarted.close();
  });

  it("rejects repository configuration drift even after durable disposal", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    await manager.disposeEnvironment(disposalRequest(request));
    await manager.close();
    await configureRepository(fixture, "user.name", "Changed Identity");

    await expect(WorktreeManager.create(managerOptions(dataRoot))).rejects.toMatchObject({
      code: "environment_conflict"
    });
  });

  it("never returns historical prepared state after disposal starts or completes", async () => {
    const { dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      now: () => "2026-08-21T12:03:00.000Z"
    });
    const ready = await registry.recoverEnvironment(request.environmentId);
    await registry.recordDisposalIntent({
      environmentId: request.environmentId,
      creationAttemptId: ready!.intent.creationAttemptId,
      disposalRequestDigest: "6".repeat(64),
      environmentAuthorizationId: request.authorization.id,
      environmentAuthorizationDigest: request.authorization.digest,
      terminalRunEvidence: disposalRequest(request).terminalRunEvidence
    });

    await expect(manager.prepareEnvironment(request)).rejects.toMatchObject({
      code: "environment_conflict"
    });
    expect(await gitFixtureCommand(resolved.managedPath, ["rev-parse", "HEAD"])).toBe(
      request.sourceCommit
    );
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe(
      "disposal_recorded"
    );
    await manager.close();

    const finishing = await WorktreeManager.create(
      managerOptions(dataRoot, "2026-08-21T12:04:00.000Z")
    );
    await expect(finishing.prepareEnvironment(request)).rejects.toMatchObject({
      code: "environment_conflict"
    });
    await finishing.close();
  });

  it("revalidates every ready environment before listing it", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    await configureRepository(fixture, "user.name", "Drifted During Session");

    await expect(manager.listEnvironments()).rejects.toMatchObject({
      code: "environment_conflict"
    });
    await manager.close();
  });

  it("revalidates branch retention before replaying disposed in the same session", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    await manager.disposeEnvironment(disposalRequest(request));
    await gitFixtureCommand(fixture.sourcePath, ["branch", "-D", request.branch]);

    await expect(manager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "maintenance_required"
    });
    await manager.close();
  });

  it("rejects recreation of disposed filesystem and Git administrative state", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);
    await manager.disposeEnvironment(disposalRequest(request));
    await gitFixtureCommand(fixture.sourcePath, [
      "worktree",
      "add",
      "--lock",
      "--reason",
      "AutoStack",
      resolved.managedPath,
      request.branch
    ]);

    await expect(manager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "maintenance_required"
    });
    await manager.close();
  });

  it("rejects recreation of only the disposed managed directory", async () => {
    const { dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);
    await manager.disposeEnvironment(disposalRequest(request));
    await mkdir(resolved.managedPath, { recursive: true, mode: 0o700 });

    await expect(manager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "maintenance_required"
    });
    await manager.close();
  });

  it("rejects a structurally valid forged phase-5 disposal proof", async () => {
    const { dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    await manager.disposeEnvironment(disposalRequest(request));
    await manager.close();
    const evidencePath = phaseFile(dataRoot, request.environmentId, 5, "disposed");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        resignPhaseEvidence({ ...evidence, worktreeListDigest: "c".repeat(64) })
      )}\n`,
      { mode: 0o600 }
    );

    const outcome = await WorktreeManager.create(managerOptions(dataRoot)).then(
      async (unexpected) => {
        await unexpected.close();
        return undefined;
      },
      (error: unknown) => error
    );
    expect(outcome).toMatchObject({ code: "maintenance_required" });
  });

  it("verifies terminal evidence exactly once during a disposal attempt", async () => {
    const { dataRoot, request } = await createSetup();
    let verifierCalls = 0;
    let closeReads = 0;
    let closeCalls = 0;
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      verifyTerminalEvidence: async () => {
        verifierCalls += 1;
        return true;
      },
      acquireEnvironmentQuiescence: async () => {
        const lease = Object.create(null) as { readonly close: () => Promise<void> };
        Object.defineProperty(lease, "close", {
          enumerable: true,
          get: () => {
            closeReads += 1;
            return async () => {
              closeCalls += 1;
            };
          }
        });
        return lease;
      }
    });
    await manager.prepareEnvironment(request);

    await manager.disposeEnvironment(disposalRequest(request));

    expect(verifierCalls).toBe(1);
    expect(closeReads).toBe(1);
    expect(closeCalls).toBe(1);
    await manager.close();
  });

  it("verifies durable phase-4 evidence exactly once during startup recovery", async () => {
    const { dataRoot, request } = await createSetup();
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    await first.prepareEnvironment(request);
    await first.close();
    const registry = await recordPhase4Disposal(dataRoot, request);
    let verifierCalls = 0;

    const recovered = await WorktreeManager.create({
      ...managerOptions(dataRoot, "2026-08-21T12:02:00.000Z"),
      verifyTerminalEvidence: async () => {
        verifierCalls += 1;
        return true;
      }
    });

    expect(verifierCalls).toBe(1);
    await recovered.resumePendingDisposals();
    expect(verifierCalls).toBe(1);
    await recovered.close();
  });

  it("defers a durable phase-4 disposal and resumes it exactly once under concurrent replay", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    await first.prepareEnvironment(request);
    const resolved = await first.resolvePreparedEnvironment(request.environmentId);
    await first.close();
    const registry = await recordPhase4Disposal(dataRoot, request);
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const calls: string[][] = [];
    const processRunner: ProcessRunner = {
      async run(processRequest) {
        calls.push([...processRequest.args]);
        return delegate.run(processRequest);
      }
    };
    let verifierCalls = 0;
    let leaseCloseReads = 0;
    let leaseCloseCalls = 0;

    const deferred = await WorktreeManager.create({
      ...managerOptions(dataRoot, "2026-08-21T12:02:00.000Z"),
      deferStartupDisposal: true,
      gitProcessRunner: processRunner,
      verifyTerminalEvidence: async () => {
        verifierCalls += 1;
        return true;
      },
      acquireEnvironmentQuiescence: async () => {
        const lease = Object.create(null) as { readonly close: () => Promise<void> };
        Object.defineProperty(lease, "close", {
          enumerable: true,
          get: () => {
            leaseCloseReads += 1;
            return async () => {
              leaseCloseCalls += 1;
            };
          }
        });
        return lease;
      }
    });

    const mutationSubcommandsBeforeResume = calls.flatMap((args) => {
      const worktree = args.indexOf("worktree");
      return worktree < 0 ? [] : [args[worktree + 1]];
    });
    expect(mutationSubcommandsBeforeResume).not.toContain("unlock");
    expect(mutationSubcommandsBeforeResume).not.toContain("remove");
    expect(verifierCalls).toBe(0);
    expect(leaseCloseReads).toBe(0);
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe(
      "disposal_recorded"
    );
    expect(await gitFixtureCommand(resolved.managedPath, ["rev-parse", "HEAD"])).toBe(
      request.sourceCommit
    );
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await expect(WorktreeManager.create(managerOptions(dataRoot))).rejects.toMatchObject({
      code: "root_busy"
    });

    await Promise.all([deferred.resumePendingDisposals(), deferred.resumePendingDisposals()]);

    expect(verifierCalls).toBe(1);
    expect(leaseCloseReads).toBe(1);
    expect(leaseCloseCalls).toBe(1);
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe("disposed");
    expect(await deferred.listEnvironments()).toEqual([]);
    await expect(gitFixtureCommand(resolved.managedPath, ["rev-parse", "HEAD"])).rejects.toThrow();
    const mutationSubcommands = calls.flatMap((args) => {
      const worktree = args.indexOf("worktree");
      return worktree < 0 ? [] : [args[worktree + 1]];
    });
    expect(mutationSubcommands.filter((command) => command === "unlock")).toHaveLength(1);
    expect(mutationSubcommands.filter((command) => command === "remove")).toHaveLength(1);
    await deferred.resumePendingDisposals();
    expect(verifierCalls).toBe(1);
    expect(leaseCloseCalls).toBe(1);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await deferred.close();
  });

  it("retains phase 4 after a failed deferred resume and retries from the journal", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    await first.prepareEnvironment(request);
    const resolved = await first.resolvePreparedEnvironment(request.environmentId);
    await first.close();
    const registry = await recordPhase4Disposal(dataRoot, request);
    let acceptEvidence = false;
    let verifierCalls = 0;
    let leaseCloseCalls = 0;
    const deferred = await WorktreeManager.create({
      ...managerOptions(dataRoot, "2026-08-21T12:02:00.000Z"),
      deferStartupDisposal: true,
      verifyTerminalEvidence: async () => {
        verifierCalls += 1;
        return acceptEvidence;
      },
      acquireEnvironmentQuiescence: async () => ({
        close: async () => {
          leaseCloseCalls += 1;
        }
      })
    });

    await expect(deferred.resumePendingDisposals()).rejects.toMatchObject({
      code: "terminal_evidence_invalid",
      message: "The terminal run evidence is invalid."
    });
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe(
      "disposal_recorded"
    );
    expect(await gitFixtureCommand(resolved.managedPath, ["rev-parse", "HEAD"])).toBe(
      request.sourceCommit
    );
    expect(verifierCalls).toBe(1);
    expect(leaseCloseCalls).toBe(1);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);

    acceptEvidence = true;
    await deferred.resumePendingDisposals();
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe("disposed");
    expect(verifierCalls).toBe(2);
    expect(leaseCloseCalls).toBe(2);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await deferred.close();
  });

  it("lets an admitted deferred resume finish before close and rejects replay after close", async () => {
    const { dataRoot, request } = await createSetup();
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    await first.prepareEnvironment(request);
    await first.close();
    await recordPhase4Disposal(dataRoot, request);
    let verifierEntered!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      verifierEntered = resolvePromise;
    });
    let releaseVerifier!: () => void;
    const released = new Promise<void>((resolvePromise) => {
      releaseVerifier = resolvePromise;
    });
    const deferred = await WorktreeManager.create({
      ...managerOptions(dataRoot, "2026-08-21T12:02:00.000Z"),
      deferStartupDisposal: true,
      verifyTerminalEvidence: async () => {
        verifierEntered();
        await released;
        return true;
      }
    });

    const resuming = deferred.resumePendingDisposals();
    await entered;
    const closing = deferred.close();
    await expect(WorktreeManager.create(managerOptions(dataRoot))).rejects.toMatchObject({
      code: "root_busy"
    });
    releaseVerifier();
    await resuming;
    await closing;

    const outcome = await deferred.resumePendingDisposals().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(outcome).toMatchObject({
      code: "closed",
      message: "The worktree manager is closed."
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    const replacement = await WorktreeManager.create(managerOptions(dataRoot));
    await replacement.close();
  });

  it("captures the defer option once and rejects hostile or extra construction values", async () => {
    const { dataRoot } = await createSetup();
    let reads = 0;
    const captured: WorktreeManagerOptions = { ...managerOptions(dataRoot) };
    Object.defineProperty(captured, "deferStartupDisposal", {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) throw new Error("defer option read twice");
        return true;
      }
    });
    const manager = await WorktreeManager.create(captured);
    expect(reads).toBe(1);
    await manager.resumePendingDisposals();
    await manager.close();

    await expect(
      WorktreeManager.create({
        ...managerOptions(dataRoot),
        deferStartupDisposal: "true"
      } as never)
    ).rejects.toMatchObject({ code: "invalid_request" });
    const hostile = { ...managerOptions(dataRoot) } as Record<string, unknown>;
    Object.defineProperty(hostile, "deferStartupDisposal", {
      enumerable: true,
      get: () => {
        throw new Error("hostile defer getter detail");
      }
    });
    await expect(WorktreeManager.create(hostile as never)).rejects.toMatchObject({
      code: "invalid_request",
      message: "The worktree request is invalid."
    });
    await expect(
      WorktreeManager.create({
        ...managerOptions(dataRoot),
        deferStartupDisposal: true,
        extraDeferAuthority: true
      } as never)
    ).rejects.toMatchObject({ code: "invalid_request" });
    const replacement = await WorktreeManager.create(managerOptions(dataRoot));
    await replacement.close();
  });

  it("releases the root lock when deferred construction fails before publication", async () => {
    const { dataRoot } = await createSetup();
    await mkdir(join(dataRoot, "worktrees", "unexpected"), {
      recursive: true,
      mode: 0o700
    });

    await expect(
      WorktreeManager.create({
        ...managerOptions(dataRoot),
        deferStartupDisposal: true
      })
    ).rejects.toMatchObject({ code: "maintenance_required" });
    await rm(join(dataRoot, "worktrees", "unexpected"), { recursive: true });

    const replacement = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      deferStartupDisposal: true
    });
    await replacement.close();
  });

  it("still reconciles ready environments when only phase-4 disposal is deferred", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    await first.prepareEnvironment(request);
    await first.close();
    await configureRepository(fixture, "user.name", "Deferred Ready Drift");

    const outcome = await WorktreeManager.create({
      ...managerOptions(dataRoot, "2026-08-21T12:02:00.000Z"),
      deferStartupDisposal: true
    }).then(
      async (unexpected) => {
        await unexpected.close();
        return undefined;
      },
      (error: unknown) => error
    );
    expect(outcome).toMatchObject({ code: "environment_conflict" });
  });

  it("preserves a primary disposal failure when lease release also fails", async () => {
    const { dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      verifyTerminalEvidence: async () => false,
      acquireEnvironmentQuiescence: async () => ({
        close: async () => {
          throw new Error("untrusted release failure");
        }
      })
    });
    await manager.prepareEnvironment(request);

    await expect(manager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "terminal_evidence_invalid"
    });
    await expect(manager.listEnvironments()).rejects.toMatchObject({ code: "closed" });
    await manager.close();
  });

  it("normalizes a spoofed pure lease-release failure and permanently quarantines work", async () => {
    const { dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      acquireEnvironmentQuiescence: async () => ({
        close: async () => {
          throw new WorktreeManagerError("active_commands");
        }
      })
    });
    await manager.prepareEnvironment(request);

    await expect(manager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "unsafe_state",
      message: "The worktree operation failed safely."
    });
    await expect(manager.listEnvironments()).rejects.toMatchObject({ code: "closed" });
    await manager.close();
  });

  it("revalidates the source binding inside quiescence before phase-4 journaling", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    let changed = false;
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      onDisposalBoundary: async (boundary: string) => {
        if (boundary === "before_ready_source_revalidation" && !changed) {
          changed = true;
          await configureRepository(fixture, "user.name", "Ready Race Drift");
        }
      }
    } as never);
    await manager.prepareEnvironment(request);

    await expect(manager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "environment_conflict"
    });
    const registry = await EnvironmentRegistry.create({ dataRoot });
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe("ready");
    await manager.close();
  });

  it("revalidates the source binding immediately before phase-4 unlock and removal", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    await first.prepareEnvironment(request);
    const resolved = await first.resolvePreparedEnvironment(request.environmentId);
    await first.close();
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      now: () => "2026-08-21T12:01:00.000Z"
    });
    const ready = await registry.recoverEnvironment(request.environmentId);
    await registry.recordDisposalIntent({
      environmentId: request.environmentId,
      creationAttemptId: ready!.intent.creationAttemptId,
      disposalRequestDigest: "6".repeat(64),
      environmentAuthorizationId: request.authorization.id,
      environmentAuthorizationDigest: request.authorization.digest,
      terminalRunEvidence: disposalRequest(request).terminalRunEvidence
    });
    let changed = false;

    await expect(
      WorktreeManager.create({
        ...managerOptions(dataRoot, "2026-08-21T12:02:00.000Z"),
        onDisposalBoundary: async (boundary: string) => {
          if (boundary === "before_final_source_revalidation" && !changed) {
            changed = true;
            await configureRepository(fixture, "user.name", "Phase Four Race Drift");
          }
        }
      } as never)
    ).rejects.toMatchObject({ code: "environment_conflict" });
    expect(await gitFixtureCommand(resolved.managedPath, ["rev-parse", "HEAD"])).toBe(
      request.sourceCommit
    );
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe(
      "disposal_recorded"
    );
  });

  it("rejects a ready managed path replaced by a symlink alias", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);
    const aliasPath = join(fixture.root, "moved-managed-worktree");
    await rename(resolved.managedPath, aliasPath);
    await symlink(aliasPath, resolved.managedPath, "dir");

    await expect(manager.listEnvironments()).rejects.toMatchObject({
      code: "maintenance_required"
    });
    await manager.close();
  });

  it.each(["wrong head", "wrong lock", "detached", "prunable"] as const)(
    "rejects live ready-state drift: %s",
    async (kind) => {
      const { fixture, dataRoot, request } = await createSetup();
      const manager = await WorktreeManager.create(managerOptions(dataRoot));
      await manager.prepareEnvironment(request);
      const resolved = await manager.resolvePreparedEnvironment(request.environmentId);
      if (kind === "wrong head") {
        await gitFixtureCommand(resolved.managedPath, ["reset", "--hard", fixture.firstCommit]);
      } else if (kind === "wrong lock") {
        await gitFixtureCommand(fixture.sourcePath, ["worktree", "unlock", resolved.managedPath]);
      } else if (kind === "detached") {
        await gitFixtureCommand(resolved.managedPath, [
          "checkout",
          "--detach",
          request.sourceCommit
        ]);
      } else {
        await rm(resolved.managedPath, { recursive: true });
      }

      await expect(manager.listEnvironments()).rejects.toMatchObject({
        code: kind === "prunable" ? "maintenance_required" : "environment_conflict"
      });
      await manager.close();
    }
  );

  it.each(["wrong commit", "occupied elsewhere"] as const)(
    "rejects an intent whose product branch is %s",
    async (kind) => {
      const { fixture, dataRoot, inspected, request } = await createSetup();
      const registry = await EnvironmentRegistry.create({
        dataRoot,
        createAttemptId: () => "e".repeat(32),
        now: () => "2026-08-21T11:30:00.000Z"
      });
      await registry.recordIntent({
        workspaceId: request.workspaceId,
        runId: request.runId,
        environmentId: request.environmentId,
        repositoryIdentity: request.inspection.repositoryIdentity,
        canonicalSourcePath: request.inspection.canonicalSourcePath,
        repositoryCommonDirectory: request.inspection.repositoryCommonDirectory,
        sourceCommit: request.sourceCommit,
        branch: request.branch,
        safeConfigDigest: inspected.safeConfigDigest,
        authorization: request.authorization,
        prepareRequestDigest: "5".repeat(64)
      });
      if (kind === "wrong commit") {
        await gitFixtureCommand(fixture.sourcePath, [
          "branch",
          request.branch,
          fixture.firstCommit
        ]);
      } else {
        await gitFixtureCommand(fixture.sourcePath, [
          "worktree",
          "add",
          "-b",
          request.branch,
          join(fixture.root, "foreign-worktree"),
          request.sourceCommit
        ]);
      }

      await expect(WorktreeManager.create(managerOptions(dataRoot))).rejects.toMatchObject({
        code: "environment_conflict"
      });
    }
  );

  it("recovers phase 4 after the exact worktree is already absent", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const first = await WorktreeManager.create(managerOptions(dataRoot));
    await first.prepareEnvironment(request);
    const resolved = await first.resolvePreparedEnvironment(request.environmentId);
    await first.close();
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      now: () => "2026-08-21T12:01:00.000Z"
    });
    const ready = await registry.recoverEnvironment(request.environmentId);
    await registry.recordDisposalIntent({
      environmentId: request.environmentId,
      creationAttemptId: ready!.intent.creationAttemptId,
      disposalRequestDigest: "6".repeat(64),
      environmentAuthorizationId: request.authorization.id,
      environmentAuthorizationDigest: request.authorization.digest,
      terminalRunEvidence: disposalRequest(request).terminalRunEvidence
    });
    await gitFixtureCommand(fixture.sourcePath, ["worktree", "unlock", resolved.managedPath]);
    await gitFixtureCommand(fixture.sourcePath, ["worktree", "remove", resolved.managedPath]);

    const recovered = await WorktreeManager.create(
      managerOptions(dataRoot, "2026-08-21T12:02:00.000Z")
    );

    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe("disposed");
    expect(await gitFixtureCommand(fixture.sourcePath, ["rev-parse", request.branch])).toBe(
      request.sourceCommit
    );
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await recovered.close();
  });

  it("rejects foreign ownership and nonterminal evidence before verification or journaling", async () => {
    const { dataRoot, request } = await createSetup();
    let verifierCalls = 0;
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      verifyTerminalEvidence: async () => {
        verifierCalls += 1;
        return true;
      }
    });
    await manager.prepareEnvironment(request);

    await expect(
      manager.disposeEnvironment({
        ...disposalRequest(request),
        workspaceId: createId("workspace", "223e4567-e89b-42d3-a456-426614174000")
      })
    ).rejects.toMatchObject({ code: "environment_conflict" });
    await expect(
      manager.disposeEnvironment({
        ...disposalRequest(request),
        terminalRunEvidence: { status: "running" }
      } as never)
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(verifierCalls).toBe(0);
    const registry = await EnvironmentRegistry.create({ dataRoot });
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe("ready");
    await manager.close();
  });

  it("close waits for an admitted operation before releasing the root lock", async () => {
    const { dataRoot, request } = await createSetup();
    let enterVerifier!: () => void;
    const verifierEntered = new Promise<void>((resolvePromise) => {
      enterVerifier = resolvePromise;
    });
    let releaseVerifier!: () => void;
    const verifierReleased = new Promise<void>((resolvePromise) => {
      releaseVerifier = resolvePromise;
    });
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      verifyTerminalEvidence: async () => {
        enterVerifier();
        await verifierReleased;
        return true;
      }
    });
    await manager.prepareEnvironment(request);
    const disposing = manager.disposeEnvironment(disposalRequest(request));
    await verifierEntered;
    const closing = manager.close();

    await expect(WorktreeManager.create(managerOptions(dataRoot))).rejects.toMatchObject({
      code: "root_busy"
    });
    releaseVerifier();
    await disposing;
    await closing;
    const replacement = await WorktreeManager.create(managerOptions(dataRoot));
    await replacement.close();
  });

  it.each([
    "after_disposal_recorded",
    "after_worktree_unlock",
    "after_worktree_remove",
    "before_disposed_publication"
  ] as const)("recovers after the deterministic disposal crash barrier %s", async (target) => {
    const { dataRoot, request } = await createSetup();
    let crashed = false;
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      onDisposalBoundary: async (boundary: string) => {
        if (boundary === target && !crashed) {
          crashed = true;
          throw new Error("simulated process death");
        }
      }
    } as never);
    await manager.prepareEnvironment(request);

    await expect(manager.disposeEnvironment(disposalRequest(request))).rejects.toMatchObject({
      code: "unsafe_state"
    });
    expect(crashed).toBe(true);
    const registry = await EnvironmentRegistry.create({ dataRoot });
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe(
      "disposal_recorded"
    );

    await expect(manager.disposeEnvironment(disposalRequest(request))).resolves.toMatchObject({
      disposed: true,
      replayed: false
    });
    await manager.close();
  });

  it.each(["intent.temp-synced", "worktree_added.temp-synced"] as const)(
    "retries prepare after registry publication crash %s",
    async (target) => {
      const { fixture, dataRoot, request } = await createSetup();
      const before = await captureSourceCheckoutInvariant(fixture);
      let crashed = false;
      const manager = await WorktreeManager.create({
        ...managerOptions(dataRoot),
        onRegistryBoundary: (boundary) => {
          if (boundary === target && !crashed) {
            crashed = true;
            throw new Error("simulated process death");
          }
        }
      });

      await expect(manager.prepareEnvironment(request)).rejects.toMatchObject({
        code: "unsafe_state"
      });
      expect(crashed).toBe(true);
      await expect(manager.prepareEnvironment(request)).resolves.toMatchObject({
        environmentId: request.environmentId,
        state: "prepared"
      });
      expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
      await manager.close();
    }
  );

  it("recovers an attached branch after the phase-2 publication crashes", async () => {
    const { fixture, dataRoot, inspected, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "f".repeat(32),
      now: () => "2026-08-21T11:30:00.000Z"
    });
    await registry.recordIntent({
      workspaceId: request.workspaceId,
      runId: request.runId,
      environmentId: request.environmentId,
      repositoryIdentity: request.inspection.repositoryIdentity,
      canonicalSourcePath: request.inspection.canonicalSourcePath,
      repositoryCommonDirectory: request.inspection.repositoryCommonDirectory,
      sourceCommit: request.sourceCommit,
      branch: request.branch,
      safeConfigDigest: inspected.safeConfigDigest,
      authorization: request.authorization,
      prepareRequestDigest: "5".repeat(64)
    });
    await gitFixtureCommand(fixture.sourcePath, ["branch", request.branch, request.sourceCommit]);
    let crashed = false;

    await expect(
      WorktreeManager.create({
        ...managerOptions(dataRoot),
        onRegistryBoundary: (boundary) => {
          if (boundary === "worktree_added.temp-synced" && !crashed) {
            crashed = true;
            throw new Error("simulated process death");
          }
        }
      })
    ).rejects.toMatchObject({ code: "unsafe_state" });
    expect(crashed).toBe(true);

    const recovered = await WorktreeManager.create(
      managerOptions(dataRoot, "2026-08-21T12:01:00.000Z")
    );
    expect((await recovered.listEnvironments()).map((item) => item.environmentId)).toEqual([
      request.environmentId
    ]);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await recovered.close();
  });

  it("rejects duplicate path/branch records and a bare target record", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    await manager.prepareEnvironment(request);
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);
    const registry = await EnvironmentRegistry.create({ dataRoot });
    const state = await registry.recoverEnvironment(request.environmentId);
    const exact = {
      path: resolved.managedPath,
      head: request.sourceCommit,
      branch: `refs/heads/${request.branch}`,
      lockedReason: "AutoStack",
      bare: false,
      detached: false
    };

    expect(() =>
      exactTargetRecord([exact, { ...exact, path: join(fixture.root, "duplicate-branch") }], state!)
    ).toThrowError(expect.objectContaining({ code: "environment_conflict" }));
    expect(() =>
      exactTargetRecord([exact, { ...exact, branch: "refs/heads/autostack/different" }], state!)
    ).toThrowError(expect.objectContaining({ code: "environment_conflict" }));
    expect(() => assertTargetRecord({ ...exact, bare: true }, state!)).toThrowError(
      expect.objectContaining({ code: "environment_conflict" })
    );
    await manager.close();
  });

  it("permanently quarantines the manager after unsafe Git process state", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const pidPath = join(fixture.root, "manager-quarantined-child.pid");
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const hanging = new BoundedProcessRunner({ timeoutMs: 50, maximumOutputBytes: 1_024 });
    let armed = false;
    let armedCalls = 0;
    const processRunner: ProcessRunner = {
      async run(processRequest) {
        if (!armed) return delegate.run(processRequest);
        armedCalls += 1;
        if (armedCalls === 1) {
          return hanging.run({
            executable: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>{},10000)`
            ],
            cwd: fixture.root,
            environment: []
          });
        }
        return delegate.run(processRequest);
      }
    };
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      gitProcessRunner: processRunner
    } as never);
    await manager.prepareEnvironment(request);
    armed = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let pid: number | undefined;
    try {
      await expect(manager.listEnvironments()).rejects.toMatchObject({
        code: "unsafe_process_state"
      });
      pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      const callsAtQuarantine = armedCalls;
      await expect(manager.listEnvironments()).rejects.toMatchObject({
        code: "unsafe_process_state"
      });
      expect(armedCalls).toBe(callsAtQuarantine);
      killSpy.mockRestore();
      expect(await waitForProcessExit(pid)).toBe(true);
    } finally {
      killSpy.mockRestore();
      if (pid !== undefined && processIsAlive(pid)) process.kill(pid, "SIGKILL");
      await manager.close();
    }
  });

  it.each(["throwing getter", "non-function"] as const)(
    "quarantines after acquiring a malformed lease with a %s close boundary",
    async (kind) => {
      const { dataRoot, request } = await createSetup();
      let closeReads = 0;
      const candidate = Object.create(null) as { readonly close: unknown };
      Object.defineProperty(candidate, "close", {
        enumerable: true,
        get: () => {
          closeReads += 1;
          if (kind === "throwing getter") throw new Error("hostile close getter detail");
          return "not a function";
        }
      });
      const manager = await WorktreeManager.create({
        ...managerOptions(dataRoot),
        acquireEnvironmentQuiescence: async () => candidate
      } as never);
      await manager.prepareEnvironment(request);

      const disposal = manager.disposeEnvironment(disposalRequest(request));
      const preAdmitted = manager.listEnvironments();
      await expect(disposal).rejects.toMatchObject({
        code: "unsafe_state",
        message: "The worktree operation failed safely."
      });
      await expect(preAdmitted).rejects.toMatchObject({ code: "closed" });
      expect(closeReads).toBe(1);
      await expect(manager.listEnvironments()).rejects.toMatchObject({ code: "closed" });
      await manager.close();
    }
  );

  it("lets an operation admitted immediately before close complete", async () => {
    const { dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    const prepared = await manager.prepareEnvironment(request);

    const operation = manager.listEnvironments();
    const closing = manager.close();

    await expect(operation).resolves.toEqual([prepared]);
    await closing;
    await expect(manager.listEnvironments()).rejects.toMatchObject({ code: "closed" });
  });

  it("drains two queued pre-admitted operations before close", async () => {
    const { dataRoot, request } = await createSetup();
    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    const prepared = await manager.prepareEnvironment(request);

    const first = manager.listEnvironments();
    const second = manager.resolvePreparedEnvironment(request.environmentId);
    const closing = manager.close();

    await expect(first).resolves.toEqual([prepared]);
    await expect(second).resolves.toMatchObject({ environment: prepared });
    await closing;
    await expect(manager.resolvePreparedEnvironment(request.environmentId)).rejects.toMatchObject({
      code: "closed"
    });
  });

  it("starts from a pure phase-1 intent by performing the exact first add", async () => {
    const { fixture, dataRoot, inspected, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "1".repeat(32),
      now: () => "2026-08-21T11:30:00.000Z"
    });
    const intent = await registry.recordIntent({
      workspaceId: request.workspaceId,
      runId: request.runId,
      environmentId: request.environmentId,
      repositoryIdentity: request.inspection.repositoryIdentity,
      canonicalSourcePath: request.inspection.canonicalSourcePath,
      repositoryCommonDirectory: request.inspection.repositoryCommonDirectory,
      sourceCommit: request.sourceCommit,
      branch: request.branch,
      safeConfigDigest: inspected.safeConfigDigest,
      authorization: request.authorization,
      prepareRequestDigest: "5".repeat(64)
    });
    expect(intent.phase).toBe("intent_recorded");
    await expect(
      gitFixtureCommand(fixture.sourcePath, ["show-ref", request.branch])
    ).rejects.toThrow();

    const manager = await WorktreeManager.create(managerOptions(dataRoot));
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);

    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe("ready");
    expect(await gitFixtureCommand(resolved.managedPath, ["rev-parse", "HEAD"])).toBe(
      request.sourceCommit
    );
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await manager.close();
  });

  it("adopts an exact locked worktree while durable state is still phase 1", async () => {
    const { fixture, dataRoot, inspected, request } = await createSetup();
    const before = await captureSourceCheckoutInvariant(fixture);
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "2".repeat(32),
      now: () => "2026-08-21T11:30:00.000Z"
    });
    const intent = await registry.recordIntent({
      workspaceId: request.workspaceId,
      runId: request.runId,
      environmentId: request.environmentId,
      repositoryIdentity: request.inspection.repositoryIdentity,
      canonicalSourcePath: request.inspection.canonicalSourcePath,
      repositoryCommonDirectory: request.inspection.repositoryCommonDirectory,
      sourceCommit: request.sourceCommit,
      branch: request.branch,
      safeConfigDigest: inspected.safeConfigDigest,
      authorization: request.authorization,
      prepareRequestDigest: "5".repeat(64)
    });
    await mkdir(join(intent.intent.managedPath, ".."), { recursive: true, mode: 0o700 });
    await gitFixtureCommand(fixture.sourcePath, [
      "worktree",
      "add",
      "--lock",
      "--reason",
      "AutoStack",
      "-b",
      request.branch,
      intent.intent.managedPath,
      request.sourceCommit
    ]);
    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe(
      "intent_recorded"
    );

    const manager = await WorktreeManager.create(managerOptions(dataRoot));

    expect((await registry.recoverEnvironment(request.environmentId))?.phase).toBe("ready");
    expect((await manager.listEnvironments()).map((item) => item.environmentId)).toEqual([
      request.environmentId
    ]);
    expect(await captureSourceCheckoutInvariant(fixture)).toEqual(before);
    await manager.close();
  });

  it("rejects actual canonical source and common-directory identity drift", async () => {
    const canonicalDrift = await createSetup();
    const first = await WorktreeManager.create(managerOptions(canonicalDrift.dataRoot));
    await first.prepareEnvironment(canonicalDrift.request);
    await first.disposeEnvironment(disposalRequest(canonicalDrift.request));
    await first.close();
    const movedSource = join(canonicalDrift.fixture.root, "moved-source");
    await rename(canonicalDrift.fixture.sourcePath, movedSource);
    await symlink(movedSource, canonicalDrift.fixture.sourcePath, "dir");

    await expect(
      WorktreeManager.create(managerOptions(canonicalDrift.dataRoot))
    ).rejects.toMatchObject({ code: "environment_conflict" });

    const commonDrift = await createSetup();
    const second = await WorktreeManager.create(managerOptions(commonDrift.dataRoot));
    await second.prepareEnvironment(commonDrift.request);
    await second.disposeEnvironment(disposalRequest(commonDrift.request));
    await second.close();
    const movedCommon = join(commonDrift.fixture.root, "moved-common.git");
    await rename(commonDrift.request.inspection.repositoryCommonDirectory, movedCommon);
    await writeFile(join(commonDrift.fixture.sourcePath, ".git"), `gitdir: ${movedCommon}\n`, {
      mode: 0o600
    });
    expect(await gitFixtureCommand(commonDrift.fixture.sourcePath, ["rev-parse", "HEAD"])).toBe(
      commonDrift.request.sourceCommit
    );

    await expect(
      WorktreeManager.create(managerOptions(commonDrift.dataRoot))
    ).rejects.toMatchObject({ code: "environment_conflict" });
  });

  it("captures the exact first-add argv and permits only the mutation allowlist", async () => {
    const { fixture, dataRoot, request } = await createSetup();
    const delegate = new BoundedProcessRunner({
      timeoutMs: 10_000,
      maximumOutputBytes: 4 * 1024 * 1024
    });
    const calls: string[][] = [];
    const processRunner: ProcessRunner = {
      async run(processRequest) {
        calls.push([...processRequest.args]);
        return delegate.run(processRequest);
      }
    };
    const manager = await WorktreeManager.create({
      ...managerOptions(dataRoot),
      gitProcessRunner: processRunner
    });
    await manager.prepareEnvironment(request);
    const resolved = await manager.resolvePreparedEnvironment(request.environmentId);
    await manager.disposeEnvironment(disposalRequest(request));
    await manager.close();

    const addCall = calls.find((args) => {
      const worktree = args.indexOf("worktree");
      return worktree >= 0 && args[worktree + 1] === "add";
    });
    expect(addCall).toEqual([
      "--no-optional-locks",
      "--no-pager",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "submodule.recurse=false",
      "-C",
      fixture.sourcePath,
      "worktree",
      "add",
      "--lock",
      "--reason",
      "AutoStack",
      "-b",
      request.branch,
      resolved.managedPath,
      request.sourceCommit
    ]);
    const worktreeSubcommands = calls.flatMap((args) => {
      const worktree = args.indexOf("worktree");
      return worktree < 0 ? [] : [args[worktree + 1]];
    });
    expect(new Set(worktreeSubcommands)).toEqual(new Set(["list", "add", "unlock", "remove"]));
    for (const args of calls) {
      expect(args).not.toContain("--force");
      expect(args).not.toContain("reset");
      expect(args).not.toContain("clean");
      expect(args).not.toContain("stash");
      expect(args).not.toContain("checkout");
      const sourceSelector = args.indexOf("-C");
      expect(sourceSelector < 0 || args[sourceSelector + 2] !== "branch").toBe(true);
    }
  });
});
