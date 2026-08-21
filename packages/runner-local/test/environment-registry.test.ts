import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalizeEnvironmentAuthorizationForDigest, createId } from "@autostack/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  ENVIRONMENT_REGISTRY_ERROR_MESSAGES,
  ENVIRONMENT_REGISTRY_PUBLICATION_BOUNDARIES,
  EnvironmentRegistry,
  EnvironmentRegistryError,
  type EnvironmentRegistryPublicationBoundary
} from "../src/environment-registry.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const roots: string[] = [];
const canonicalSourcePath = "/private/tmp/autostack-repository";
const repositoryCommonDirectory = `${canonicalSourcePath}/.git`;
const repositoryDigest = createHash("sha256")
  .update(repositoryCommonDirectory, "utf8")
  .digest("hex");
const workspaceId = createId("workspace", UUID);
const runId = createId("run", UUID);
const environmentId = createId("environment", UUID);
const repositoryIdentity = `local-sha256:${repositoryDigest}`;
const sourceCommit = "2".repeat(40);
const branch = "autostack/123e4567-fix-registry";
const authorizationWithoutDigest = {
  id: createId("environmentAuthorization", UUID),
  approvalId: createId("approval", UUID),
  approvalEvidenceDigest: "a".repeat(64),
  scope: {
    workspaceId,
    runId,
    environmentId,
    repositoryIdentity,
    sourceCommit,
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
const authorization = {
  ...authorizationWithoutDigest,
  digest: createHash("sha256")
    .update(
      canonicalizeEnvironmentAuthorizationForDigest({
        ...authorizationWithoutDigest,
        digest: "0".repeat(64)
      }),
      "utf8"
    )
    .digest("hex")
};

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-environment-registry-"));
  roots.push(root);
  return root;
};

const input = {
  workspaceId,
  runId,
  environmentId,
  repositoryIdentity,
  canonicalSourcePath,
  repositoryCommonDirectory,
  sourceCommit,
  branch,
  safeConfigDigest: "3".repeat(64),
  authorization,
  prepareRequestDigest: "5".repeat(64)
} as const;

const disposalIntentRequest = (creationAttemptId: string) =>
  ({
    environmentId: input.environmentId,
    creationAttemptId,
    disposalRequestDigest: "6".repeat(64),
    environmentAuthorizationId: authorization.id,
    environmentAuthorizationDigest: authorization.digest,
    terminalRunEvidence: {
      status: "completed" as const,
      terminalEventSequence: 1,
      terminalEventDigest: "8".repeat(64)
    }
  }) as const;

const disposalVerificationRequest = (creationAttemptId: string) =>
  ({
    ...disposalIntentRequest(creationAttemptId),
    worktreeListDigest: "9".repeat(64),
    retainedBranchCommit: input.sourceCommit,
    verifiedAt: "2026-08-21T12:00:00.004Z"
  }) as const;

const component = (environmentId: string): string => Buffer.from(environmentId).toString("hex");

const registryPaths = async (dataRoot: string, environmentId = input.environmentId) => {
  const canonicalRoot = await realpath(dataRoot);
  const idComponent = component(environmentId);
  return {
    intent: join(canonicalRoot, "environments", `${idComponent}.json`),
    journal: join(canonicalRoot, "environments", "journal", idComponent),
    phase1: join(canonicalRoot, "environments", "journal", idComponent, "01-intent-recorded.json"),
    phase2: join(canonicalRoot, "environments", "journal", idComponent, "02-worktree-added.json"),
    phase3: join(canonicalRoot, "environments", "journal", idComponent, "03-ready.json"),
    phase4: join(
      canonicalRoot,
      "environments",
      "journal",
      idComponent,
      "04-disposal-recorded.json"
    ),
    phase5: join(canonicalRoot, "environments", "journal", idComponent, "05-disposed.json")
  };
};

const expectRegistryError = async (
  operation: Promise<unknown>,
  code: EnvironmentRegistryError["code"]
): Promise<void> => {
  const error = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(EnvironmentRegistryError);
  expect(error).toMatchObject({ code, message: ENVIRONMENT_REGISTRY_ERROR_MESSAGES[code] });
};

const resignPhaseEvidence = (evidence: Record<string, unknown>): Record<string, unknown> => {
  const { evidenceDigest: _evidenceDigest, ...withoutDigest } = evidence;
  return {
    ...withoutDigest,
    evidenceDigest: createHash("sha256")
      .update(`autostack.environment-phase.v1\n${JSON.stringify(withoutDigest)}`, "utf8")
      .digest("hex")
  };
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EnvironmentRegistry", () => {
  it("durably records one immutable intent outside its managed worktree", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "a".repeat(32)
    });

    const state = await registry.recordIntent(input);

    expect(state.phase).toBe("intent_recorded");
    expect(state.intent).toMatchObject({
      version: 1,
      ...input,
      repositoryDigest,
      creationAttemptId: "a".repeat(32)
    });
    expect(
      state.intent.managedPath.startsWith(
        join(await realpath(dataRoot), "worktrees", repositoryDigest)
      )
    ).toBe(true);
    expect(await lstat(state.intent.managedPath).catch(() => undefined)).toBeUndefined();
    expect(await registry.recoverEnvironment(input.environmentId)).toEqual(state);

    const environmentFiles = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(dataRoot, "environments"), { recursive: true })
    );
    expect(environmentFiles.some((name) => name.includes("worktrees"))).toBe(false);
    const persisted = await readFile(
      join(dataRoot, "environments", `${Buffer.from(input.environmentId).toString("hex")}.json`),
      "utf8"
    );
    expect(JSON.parse(persisted)).toEqual(state.intent);
    expect((await lstat(join(dataRoot, "environments"))).mode & 0o777).toBe(0o700);
  });

  it("derives the repository digest from the canonical Git common directory binding", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "0".repeat(32),
      now: () => "2026-08-21T12:00:00.000Z"
    });

    const state = await registry.recordIntent(input);

    expect(state.intent.repositoryDigest).toBe(repositoryDigest);
    expect(state.intent.canonicalSourcePath).toBe(canonicalSourcePath);
    expect(state.intent.repositoryCommonDirectory).toBe(repositoryCommonDirectory);
    await expectRegistryError(
      registry.recordIntent({
        ...input,
        repositoryIdentity: `local-sha256:${"f".repeat(64)}`
      }),
      "invalid_input"
    );
  });

  it("rejects a forged or scope-mismatched environment authorization before persistence", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({ dataRoot });
    const forged = { ...authorization, digest: "f".repeat(64) };
    const mismatchedWithoutDigest = {
      ...authorizationWithoutDigest,
      scope: {
        ...authorizationWithoutDigest.scope,
        branch: "autostack/foreign-branch"
      }
    };
    const mismatched = {
      ...mismatchedWithoutDigest,
      digest: createHash("sha256")
        .update(
          canonicalizeEnvironmentAuthorizationForDigest({
            ...mismatchedWithoutDigest,
            digest: "0".repeat(64)
          }),
          "utf8"
        )
        .digest("hex")
    };
    const secretScopeWithoutDigest = {
      ...authorizationWithoutDigest,
      scope: {
        ...authorizationWithoutDigest.scope,
        cwdRoot: `ghp_${"b".repeat(36)}`
      }
    };
    const secretScope = {
      ...secretScopeWithoutDigest,
      digest: authorization.digest
    };

    await expectRegistryError(
      registry.recordIntent({ ...input, authorization: forged }),
      "invalid_input"
    );
    await expectRegistryError(
      registry.recordIntent({ ...input, authorization: mismatched }),
      "invalid_input"
    );
    await expectRegistryError(
      registry.recordIntent({ ...input, authorization: secretScope }),
      "invalid_input"
    );
    expect(await readdir(join(await realpath(dataRoot), "environments"))).toEqual(["journal"]);
  });

  it.each([
    { field: "branch", value: `autostack/ghp_${"a".repeat(36)}` },
    { field: "canonicalSourcePath", value: `/private/tmp/ghp_${"a".repeat(36)}` },
    { field: "repositoryCommonDirectory", value: `/private/tmp/ghp_${"a".repeat(36)}/.git` }
  ] as const)("rejects credential-like $field before persisting intent bytes", async (attack) => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({ dataRoot });

    await expectRegistryError(
      registry.recordIntent({ ...input, [attack.field]: attack.value }),
      "invalid_input"
    );
    const environmentRoot = join(await realpath(dataRoot), "environments");
    expect(await readdir(environmentRoot)).toEqual(["journal"]);
    expect(await readdir(join(environmentRoot, "journal"))).toEqual([]);
  });

  it("rejects a credential-like data root before deriving a persisted managed path", async () => {
    const parent = await temporaryRoot();
    const dataRoot = join(parent, `ghp_${"a".repeat(36)}`);
    await mkdir(dataRoot, { mode: 0o700 });

    await expectRegistryError(EnvironmentRegistry.create({ dataRoot }), "invalid_input");
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("advances immutable phase evidence in order and replays it after restart", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [0, 1, 2, 3, 5].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "b".repeat(32),
      now: () => {
        const value = timestamps.shift();
        if (value === undefined) throw new Error("clock exhausted");
        return value;
      }
    });
    const recorded = await registry.recordIntent(input);

    const added = await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(added.intent.managedPath, { recursive: true });
    const ready = await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });

    expect(added.phase).toBe("worktree_added");
    expect(ready.phase).toBe("ready");
    expect(
      ready.evidence.map(({ phase, sequence, recordedAt }) => ({ phase, sequence, recordedAt }))
    ).toEqual([
      { phase: "intent_recorded", sequence: 1, recordedAt: "2026-08-21T12:00:00.000Z" },
      { phase: "worktree_added", sequence: 2, recordedAt: "2026-08-21T12:00:00.001Z" },
      { phase: "ready", sequence: 3, recordedAt: "2026-08-21T12:00:00.002Z" }
    ]);
    expect(ready.evidence[1]?.previousEvidenceDigest).toBe(ready.evidence[0]?.evidenceDigest);
    expect(ready.evidence[2]?.previousEvidenceDigest).toBe(ready.evidence[1]?.evidenceDigest);

    const restarted = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => {
        throw new Error("recovery must not create an attempt");
      },
      now: () => {
        throw new Error("recovery must not read the clock");
      }
    });
    await expect(restarted.recoverEnvironment(input.environmentId)).resolves.toEqual(ready);
    expect(ready.intent.authorization).toEqual(authorization);
    expect(ready.intent.prepareRequestDigest).toBe(input.prepareRequestDigest);
    expect(ready.evidence[2]?.recordedAt).toBe("2026-08-21T12:00:00.002Z");
    await expect(
      restarted.recordReady({
        environmentId: input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId
      })
    ).resolves.toEqual(ready);
  });

  it("records disposal before removal and disposed only after verified absence", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [0, 1, 2, 3, 4].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "d".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    const added = await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(added.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    const disposalRequest = disposalIntentRequest(recorded.intent.creationAttemptId);

    const disposalRecorded = await registry.recordDisposalIntent(disposalRequest);

    expect(disposalRecorded.phase).toBe("disposal_recorded");
    expect(disposalRecorded.evidence.at(-1)).toMatchObject({
      sequence: 4,
      disposalRequestDigest: disposalRequest.disposalRequestDigest,
      environmentAuthorizationId: disposalRequest.environmentAuthorizationId,
      environmentAuthorizationDigest: disposalRequest.environmentAuthorizationDigest,
      terminalRunEvidence: disposalRequest.terminalRunEvidence
    });
    await expectRegistryError(
      registry.recordDisposed(disposalVerificationRequest(recorded.intent.creationAttemptId)),
      "invalid_transition"
    );
    await rmdir(disposalRecorded.intent.managedPath);
    const verification = disposalVerificationRequest(recorded.intent.creationAttemptId);
    const disposed = await registry.recordDisposed(verification);
    expect(disposed.phase).toBe("disposed");
    expect(disposed.evidence.at(-1)).toMatchObject({ sequence: 5, ...verification });

    const restarted = await EnvironmentRegistry.create({ dataRoot });
    await expect(restarted.recoverEnvironment(input.environmentId)).resolves.toEqual(disposed);
    await mkdir(disposed.intent.managedPath, { recursive: true });
    await expectRegistryError(
      restarted.recoverEnvironment(input.environmentId),
      "maintenance_required"
    );
  });

  it("leaves a durable disposal intent for manager reconciliation when the path is absent", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [0, 1, 2, 3, 4].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "e".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(recorded.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    const disposalRequest = disposalIntentRequest(recorded.intent.creationAttemptId);
    await registry.recordDisposalIntent(disposalRequest);
    await rmdir(recorded.intent.managedPath);

    const restarted = await EnvironmentRegistry.create({
      dataRoot,
      now: () => timestamps.shift() ?? "invalid"
    });
    const recovered = await restarted.recoverEnvironment(input.environmentId);

    expect(recovered).toMatchObject({ phase: "disposal_recorded" });
    expect(recovered?.evidence).toHaveLength(4);
    await expect(readFile((await registryPaths(dataRoot)).phase5, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each(["disposal_recorded", "disposed"] as const)(
    "rejects %s recovery evidence rebound to a foreign authorization",
    async (terminalPhase) => {
      const dataRoot = await temporaryRoot();
      const timestamps = [0, 1, 2, 3, 4].map(
        (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
      );
      const registry = await EnvironmentRegistry.create({
        dataRoot,
        createAttemptId: () => "1".repeat(32),
        now: () => timestamps.shift() ?? "invalid"
      });
      const recorded = await registry.recordIntent(input);
      await registry.recordWorktreeAdded({
        environmentId: input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId
      });
      await mkdir(recorded.intent.managedPath, { recursive: true });
      await registry.recordReady({
        environmentId: input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId
      });
      await registry.recordDisposalIntent(disposalIntentRequest(recorded.intent.creationAttemptId));
      if (terminalPhase === "disposed") {
        await rmdir(recorded.intent.managedPath);
        await registry.recordDisposed(
          disposalVerificationRequest(recorded.intent.creationAttemptId)
        );
      }
      const paths = await registryPaths(dataRoot);
      const foreignAuthorizationId = createId(
        "environmentAuthorization",
        "123e4567-e89b-42d3-a456-426614174001"
      );
      const foreignAuthorizationDigest = "b".repeat(64);
      const phase4 = JSON.parse(await readFile(paths.phase4, "utf8")) as Record<string, unknown>;
      phase4.environmentAuthorizationId = foreignAuthorizationId;
      phase4.environmentAuthorizationDigest = foreignAuthorizationDigest;
      const { evidenceDigest: _phase4Digest, ...phase4WithoutDigest } = phase4;
      phase4.evidenceDigest = createHash("sha256")
        .update(`autostack.environment-phase.v1\n${JSON.stringify(phase4WithoutDigest)}`, "utf8")
        .digest("hex");
      await writeFile(paths.phase4, `${JSON.stringify(phase4)}\n`, { mode: 0o600 });
      if (terminalPhase === "disposed") {
        const phase5 = JSON.parse(await readFile(paths.phase5, "utf8")) as Record<string, unknown>;
        phase5.environmentAuthorizationId = foreignAuthorizationId;
        phase5.environmentAuthorizationDigest = foreignAuthorizationDigest;
        phase5.previousEvidenceDigest = phase4.evidenceDigest;
        const { evidenceDigest: _phase5Digest, ...phase5WithoutDigest } = phase5;
        phase5.evidenceDigest = createHash("sha256")
          .update(`autostack.environment-phase.v1\n${JSON.stringify(phase5WithoutDigest)}`, "utf8")
          .digest("hex");
        await writeFile(paths.phase5, `${JSON.stringify(phase5)}\n`, { mode: 0o600 });
      }

      const restarted = await EnvironmentRegistry.create({ dataRoot });
      await expectRegistryError(
        restarted.recoverEnvironment(input.environmentId),
        "maintenance_required"
      );
    }
  );

  it("treats a ready environment with a missing managed path as maintenance", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [0, 1, 2].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "f".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(recorded.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await rmdir(recorded.intent.managedPath);

    await expectRegistryError(
      registry.recoverEnvironment(input.environmentId),
      "maintenance_required"
    );
  });

  it("rejects reordered and cross-attempt phase evidence with static errors", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "c".repeat(32),
      now: () => "2026-08-21T12:00:00.000Z"
    });
    const recorded = await registry.recordIntent(input);

    await expectRegistryError(
      registry.recordReady({
        environmentId: input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId
      }),
      "invalid_transition"
    );
    await expectRegistryError(
      registry.recordWorktreeAdded({
        environmentId: input.environmentId,
        creationAttemptId: "d".repeat(32)
      }),
      "invalid_transition"
    );
  });

  it.each([
    "intent.temp-synced",
    "intent.temp-directory-synced",
    "intent.canonical-linked",
    "intent.canonical-directory-synced",
    "intent.alias-unlinked",
    "intent.alias-directory-synced"
  ] satisfies readonly EnvironmentRegistryPublicationBoundary[])(
    "recovers an exact intent publication interrupted after %s",
    async (interruptedBoundary) => {
      const dataRoot = await temporaryRoot();
      const attempted: EnvironmentRegistryPublicationBoundary[] = [];
      const crashing = await EnvironmentRegistry.create({
        dataRoot,
        createAttemptId: () => "e".repeat(32),
        now: () => "2026-08-21T12:00:00.000Z",
        onBoundary: (boundary) => {
          attempted.push(boundary);
          if (boundary === interruptedBoundary) throw new Error("simulated process death");
        }
      });

      await expect(crashing.recordIntent(input)).rejects.toBeInstanceOf(EnvironmentRegistryError);
      expect(attempted).toContain(interruptedBoundary);

      const restarted = await EnvironmentRegistry.create({
        dataRoot,
        createAttemptId: () => "e".repeat(32),
        now: () => "2026-08-21T12:00:00.000Z"
      });
      const recovered = await restarted.recordIntent(input);

      expect(recovered.intent.creationAttemptId).toBe("e".repeat(32));
      expect(recovered.phase).toBe("intent_recorded");
      expect((await readdir(join(await realpath(dataRoot), "environments"))).sort()).toEqual([
        `${Buffer.from(input.environmentId).toString("hex")}.json`,
        "journal"
      ]);
    }
  );

  it("publishes every registry record through the immutable durability boundary order", async () => {
    const dataRoot = await temporaryRoot();
    const boundaries: EnvironmentRegistryPublicationBoundary[] = [];
    const timestamps = [0, 1, 2, 3, 5].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "f".repeat(32),
      now: () => timestamps.shift() ?? "invalid",
      onBoundary: (boundary) => {
        boundaries.push(boundary);
      }
    });
    const recorded = await registry.recordIntent(input);
    await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(recorded.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    const disposal = await registry.recordDisposalIntent(
      disposalIntentRequest(recorded.intent.creationAttemptId)
    );
    await rmdir(disposal.intent.managedPath);
    await registry.recordDisposed(disposalVerificationRequest(recorded.intent.creationAttemptId));

    expect(boundaries).toEqual(ENVIRONMENT_REGISTRY_PUBLICATION_BOUNDARIES);
    expect(Object.isFrozen(ENVIRONMENT_REGISTRY_PUBLICATION_BOUNDARIES)).toBe(true);
  });

  it.each(
    ENVIRONMENT_REGISTRY_PUBLICATION_BOUNDARIES.filter(
      (boundary) => boundary.startsWith("disposal_recorded.") || boundary.startsWith("disposed.")
    )
  )("recovers disposal evidence interrupted after %s", async (interruptedBoundary) => {
    const dataRoot = await temporaryRoot();
    const timestamps = [0, 1, 2, 3, 5].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const crashing = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "0".repeat(32),
      now: () => timestamps.shift() ?? "invalid",
      onBoundary: (boundary) => {
        if (boundary === interruptedBoundary) throw new Error("simulated process death");
      }
    });
    const recorded = await crashing.recordIntent(input);
    await crashing.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(recorded.intent.managedPath, { recursive: true });
    await crashing.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    const disposal = disposalIntentRequest(recorded.intent.creationAttemptId);

    if (interruptedBoundary.startsWith("disposal_recorded.")) {
      await expect(crashing.recordDisposalIntent(disposal)).rejects.toBeInstanceOf(
        EnvironmentRegistryError
      );
    } else {
      await crashing.recordDisposalIntent(disposal);
      await rmdir(recorded.intent.managedPath);
      await expect(
        crashing.recordDisposed(disposalVerificationRequest(recorded.intent.creationAttemptId))
      ).rejects.toBeInstanceOf(EnvironmentRegistryError);
    }

    const restarted = await EnvironmentRegistry.create({ dataRoot });
    const recovered = await restarted.recoverEnvironment(input.environmentId);
    expect(recovered?.phase).toBe(
      interruptedBoundary.startsWith("disposal_recorded.") ? "disposal_recorded" : "disposed"
    );
  });

  it("replays an exact intent without a new attempt and rejects any conflicting binding", async () => {
    const dataRoot = await temporaryRoot();
    let attempts = 0;
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => {
        attempts += 1;
        return "1".repeat(32);
      },
      now: () => "2026-08-21T12:00:00.000Z"
    });
    const first = await registry.recordIntent(input);

    await expect(registry.recordIntent(input)).resolves.toEqual(first);
    expect(attempts).toBe(1);
    await expectRegistryError(
      registry.recordIntent({ ...input, safeConfigDigest: "5".repeat(64) }),
      "conflicting_record"
    );
    await expectRegistryError(
      registry.recordIntent({ ...input, unexpected: "field" } as typeof input),
      "invalid_input"
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.intent)).toBe(true);
    expect(Object.isFrozen(first.evidence)).toBe(true);
    expect(Object.isFrozen(first.evidence[0])).toBe(true);
  });

  it("fails closed with static diagnostics for hostile factories and record inputs", async () => {
    const dataRoot = await temporaryRoot();
    const attemptSecret = "attempt-factory-secret";
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => {
        throw new Error(attemptSecret);
      }
    });

    await expectRegistryError(registry.recordIntent(input), "invalid_input");
    const hostile = new Proxy(input, {
      get() {
        throw new Error("input-getter-secret");
      }
    });
    await expectRegistryError(registry.recordIntent(hostile), "invalid_input");
    expect(ENVIRONMENT_REGISTRY_ERROR_MESSAGES.invalid_input).not.toContain(attemptSecret);
  });

  it("rejects impossible calendar timestamps from the injected clock", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "2".repeat(32),
      now: () => "2026-02-31T12:00:00.000Z"
    });

    await expectRegistryError(registry.recordIntent(input), "invalid_input");
  });

  it("rejects an impossible calendar timestamp in disposal verification", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [
      "2026-03-03T11:59:00.000Z",
      "2026-03-03T11:59:00.001Z",
      "2026-03-03T11:59:00.002Z",
      "2026-03-03T11:59:00.003Z",
      "2026-03-03T12:01:00.000Z"
    ];
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "2".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(recorded.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await registry.recordDisposalIntent(disposalIntentRequest(recorded.intent.creationAttemptId));
    await rmdir(recorded.intent.managedPath);

    await expectRegistryError(
      registry.recordDisposed({
        ...disposalVerificationRequest(recorded.intent.creationAttemptId),
        verifiedAt: "2026-02-31T12:00:00.000Z"
      }),
      "invalid_input"
    );
  });

  it("classifies a throwing nested authorization getter as invalid input", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({ dataRoot });
    const hostileAuthorization = new Proxy(authorization, {
      get() {
        throw new Error("nested-authorization-getter-secret");
      }
    });

    await expectRegistryError(
      registry.recordIntent({ ...input, authorization: hostileAuthorization }),
      "invalid_input"
    );
  });

  it("classifies a throwing nested terminal-evidence getter as invalid input", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [0, 1, 2].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "2".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(recorded.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    const hostileTerminalEvidence = new Proxy(
      disposalIntentRequest(recorded.intent.creationAttemptId).terminalRunEvidence,
      {
        get() {
          throw new Error("nested-terminal-getter-secret");
        }
      }
    );

    await expectRegistryError(
      registry.recordDisposalIntent({
        ...disposalIntentRequest(recorded.intent.creationAttemptId),
        terminalRunEvidence: hostileTerminalEvidence
      }),
      "invalid_input"
    );
  });

  it.each([
    "unknown_key",
    "unknown_version",
    "reordered_keys",
    "invalid_admitted_field",
    "missing_initial_phase",
    "reordered_phase"
  ] as const)("rejects corrupt durable state: %s", async (corruption) => {
    const dataRoot = await temporaryRoot();
    const timestamps = [
      "2026-08-21T12:00:00.000Z",
      "2026-08-21T12:00:00.001Z",
      "2026-08-21T12:00:00.002Z"
    ];
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "2".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    const added = await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(added.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: added.intent.creationAttemptId
    });
    const paths = await registryPaths(dataRoot);
    if (
      corruption === "unknown_key" ||
      corruption === "unknown_version" ||
      corruption === "reordered_keys" ||
      corruption === "invalid_admitted_field"
    ) {
      const intentRecord = JSON.parse(await readFile(paths.intent, "utf8")) as Record<
        string,
        unknown
      >;
      if (corruption === "unknown_key") intentRecord.unexpected = true;
      else if (corruption === "unknown_version") intentRecord.version = 99;
      else if (corruption === "invalid_admitted_field") intentRecord.branch = "refs/heads/main";
      const persisted =
        corruption === "reordered_keys"
          ? Object.fromEntries(Object.entries(intentRecord).reverse())
          : intentRecord;
      await writeFile(paths.intent, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    } else if (corruption === "missing_initial_phase") {
      await unlink(paths.phase1);
    } else {
      await unlink(paths.phase2);
    }
    const restarted = await EnvironmentRegistry.create({ dataRoot });

    await expectRegistryError(
      restarted.recoverEnvironment(input.environmentId),
      "maintenance_required"
    );
  });

  it.each(["symlink", "hardlink", "mode"] as const)(
    "rejects %s drift in immutable registry records",
    async (attack) => {
      const dataRoot = await temporaryRoot();
      const registry = await EnvironmentRegistry.create({
        dataRoot,
        createAttemptId: () => "3".repeat(32),
        now: () => "2026-08-21T12:00:00.000Z"
      });
      await registry.recordIntent(input);
      const paths = await registryPaths(dataRoot);
      if (attack === "symlink") {
        const displaced = `${paths.intent}.displaced`;
        await rename(paths.intent, displaced);
        await symlink(displaced, paths.intent);
      } else if (attack === "hardlink") {
        await link(paths.intent, join(await realpath(dataRoot), "intent-alias"));
      } else {
        await chmod(paths.intent, 0o644);
      }
      const restarted = await EnvironmentRegistry.create({ dataRoot });

      await expectRegistryError(restarted.recoverEnvironment(input.environmentId), "unsafe_state");
    }
  );

  it("recovers all environments in exact ID order and rejects unrecognized journal entries", async () => {
    const dataRoot = await temporaryRoot();
    const secondEnvironmentId = createId("environment", "123e4567-e89b-42d3-a456-426614174001");
    const attempts = ["4".repeat(32), "5".repeat(32)];
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => attempts.shift() ?? "invalid",
      now: () => "2026-08-21T12:00:00.000Z"
    });
    const secondAuthorizationWithoutDigest = {
      ...authorizationWithoutDigest,
      id: createId("environmentAuthorization", "123e4567-e89b-42d3-a456-426614174001"),
      scope: { ...authorizationWithoutDigest.scope, environmentId: secondEnvironmentId }
    };
    const secondAuthorization = {
      ...secondAuthorizationWithoutDigest,
      digest: createHash("sha256")
        .update(
          canonicalizeEnvironmentAuthorizationForDigest({
            ...secondAuthorizationWithoutDigest,
            digest: "0".repeat(64)
          }),
          "utf8"
        )
        .digest("hex")
    };
    await registry.recordIntent({
      ...input,
      environmentId: secondEnvironmentId,
      authorization: secondAuthorization
    });
    await registry.recordIntent(input);

    const recovered = await registry.recoverAll();

    expect(recovered.map((state) => state.intent.environmentId)).toEqual([
      input.environmentId,
      secondEnvironmentId
    ]);
    const paths = await registryPaths(dataRoot);
    await writeFile(join(paths.journal, "unexpected.json"), "{}\n", { mode: 0o600 });
    const restarted = await EnvironmentRegistry.create({ dataRoot });
    await expectRegistryError(restarted.recoverAll(), "maintenance_required");
  });

  it("enforces the 1000-environment capacity before creating any intent state", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({ dataRoot });
    const journalRoot = join(await realpath(dataRoot), "environments", "journal");
    const existingIds = Array.from({ length: 1_000 }, (_, index) =>
      createId(
        "environment",
        `123e4567-e89b-42d3-a456-${(index + 1).toString(16).padStart(12, "0")}`
      )
    );
    await Promise.all(
      existingIds.map((existingId) =>
        mkdir(join(journalRoot, component(existingId)), { mode: 0o700 })
      )
    );
    const targetJournal = join(journalRoot, component(input.environmentId));

    await expectRegistryError(registry.recordIntent(input), "maintenance_required");
    expect(await lstat(targetJournal).catch(() => undefined)).toBeUndefined();
    expect(await readdir(journalRoot)).toHaveLength(1_000);
  });

  it("rejects an oversized valid intent before creating its journal directory", async () => {
    const dataRoot = await temporaryRoot();
    const oversizedSourcePath = `/private/tmp/${"s".repeat(7_500)}`;
    const oversizedCommonDirectory = `/private/tmp/${"c".repeat(7_500)}/.git`;
    const oversizedRepositoryDigest = createHash("sha256")
      .update(oversizedCommonDirectory, "utf8")
      .digest("hex");
    const oversizedRepositoryIdentity = `local-sha256:${oversizedRepositoryDigest}`;
    const oversizedAuthorizationWithoutDigest = {
      ...authorizationWithoutDigest,
      scope: {
        ...authorizationWithoutDigest.scope,
        repositoryIdentity: oversizedRepositoryIdentity
      }
    };
    const oversizedAuthorization = {
      ...oversizedAuthorizationWithoutDigest,
      digest: createHash("sha256")
        .update(
          canonicalizeEnvironmentAuthorizationForDigest({
            ...oversizedAuthorizationWithoutDigest,
            digest: "0".repeat(64)
          }),
          "utf8"
        )
        .digest("hex")
    };
    const oversizedInput = {
      ...input,
      repositoryIdentity: oversizedRepositoryIdentity,
      canonicalSourcePath: oversizedSourcePath,
      repositoryCommonDirectory: oversizedCommonDirectory,
      authorization: oversizedAuthorization
    };
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "2".repeat(32)
    });

    await expectRegistryError(registry.recordIntent(oversizedInput), "invalid_input");

    const paths = await registryPaths(dataRoot);
    expect(await lstat(paths.journal).catch(() => undefined)).toBeUndefined();
    expect(await readdir(join(await realpath(dataRoot), "environments", "journal"))).toEqual([]);
    const restarted = await EnvironmentRegistry.create({ dataRoot });
    await expect(restarted.recoverAll()).resolves.toEqual([]);
  });

  it("rejects validly hashed evidence from a different creation attempt", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = ["2026-08-21T12:00:00.000Z", "2026-08-21T12:00:00.001Z"];
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "6".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    const paths = await registryPaths(dataRoot);
    const evidence = JSON.parse(await readFile(paths.phase2, "utf8")) as Record<string, unknown>;
    evidence.creationAttemptId = "7".repeat(32);
    const { evidenceDigest: _oldDigest, ...withoutDigest } = evidence;
    evidence.evidenceDigest = createHash("sha256")
      .update(`autostack.environment-phase.v1\n${JSON.stringify(withoutDigest)}`, "utf8")
      .digest("hex");
    await writeFile(paths.phase2, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
    const restarted = await EnvironmentRegistry.create({ dataRoot });

    await expectRegistryError(
      restarted.recoverEnvironment(input.environmentId),
      "maintenance_required"
    );
  });

  it("rejects unrecognized per-environment evidence during focused recovery", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "8".repeat(32),
      now: () => "2026-08-21T12:00:00.000Z"
    });
    await registry.recordIntent(input);
    const paths = await registryPaths(dataRoot);
    await writeFile(join(paths.journal, "04-unrecognized.json"), "{}\n", { mode: 0o600 });

    await expectRegistryError(
      registry.recoverEnvironment(input.environmentId),
      "maintenance_required"
    );
  });

  it.each(["partial", "conflicting"] as const)(
    "rejects an unbound %s publication temp instead of assuming ownership",
    async (kind) => {
      const dataRoot = await temporaryRoot();
      const registry = await EnvironmentRegistry.create({
        dataRoot,
        createAttemptId: () => "9".repeat(32),
        now: () => "2026-08-21T12:00:00.000Z"
      });
      const paths = await registryPaths(dataRoot);
      const intentName = `${component(input.environmentId)}.json`;
      const foreignTemp = join(
        await realpath(dataRoot),
        "environments",
        `.${intentName}.intent.${"a".repeat(32)}.tmp`
      );
      if (kind === "partial") {
        await writeFile(foreignTemp, "{", { mode: 0o600 });
      } else {
        await registry.recordIntent(input);
        await writeFile(foreignTemp, await readFile(paths.intent), { mode: 0o600 });
      }

      await expectRegistryError(registry.recordIntent(input), "maintenance_required");
    }
  );

  it("refuses to heal a linked temp whose filename names a foreign creation attempt", async () => {
    const dataRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "9".repeat(32),
      now: () => "2026-08-21T12:00:00.000Z"
    });
    await registry.recordIntent(input);
    const paths = await registryPaths(dataRoot);
    const foreignTemp = join(
      await realpath(dataRoot),
      "environments",
      `.${component(input.environmentId)}.json.intent.${"a".repeat(32)}.tmp`
    );
    await link(paths.intent, foreignTemp);

    await expectRegistryError(
      registry.recoverEnvironment(input.environmentId),
      "maintenance_required"
    );
    expect((await lstat(paths.intent)).nlink).toBe(2);
    expect((await lstat(foreignTemp)).nlink).toBe(2);
  });

  it.each(["temp_environment", "linked_phase"] as const)(
    "rejects a self-valid context-misbound %s publication before namespace mutation",
    async (attack) => {
      const dataRoot = await temporaryRoot();
      const registry = await EnvironmentRegistry.create({
        dataRoot,
        createAttemptId: () => "a".repeat(32),
        now: () => "2026-08-21T12:00:00.000Z"
      });
      const recorded = await registry.recordIntent(input);
      const paths = await registryPaths(dataRoot);
      const wrongEnvironmentId = createId("environment", "123e4567-e89b-42d3-a456-426614174001");
      const evidenceWithoutDigest = {
        version: 1,
        kind: "environment_phase",
        phase: attack === "temp_environment" ? "worktree_added" : "ready",
        sequence: attack === "temp_environment" ? 2 : 3,
        environmentId: attack === "temp_environment" ? wrongEnvironmentId : input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId,
        intentDigest: recorded.intent.intentDigest,
        previousEvidenceDigest: recorded.evidence[0]?.evidenceDigest,
        recordedAt: "2026-08-21T12:00:00.001Z"
      };
      const evidence = {
        ...evidenceWithoutDigest,
        evidenceDigest: createHash("sha256")
          .update(
            `autostack.environment-phase.v1\n${JSON.stringify(evidenceWithoutDigest)}`,
            "utf8"
          )
          .digest("hex")
      };
      const temp = join(
        paths.journal,
        `.02-worktree-added.json.worktree_added.${recorded.intent.creationAttemptId}.tmp`
      );
      if (attack === "temp_environment") {
        await writeFile(temp, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
      } else {
        await writeFile(paths.phase2, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
        await link(paths.phase2, temp);
      }

      await expectRegistryError(
        registry.recoverEnvironment(input.environmentId),
        "maintenance_required"
      );
      if (attack === "temp_environment") {
        expect(await lstat(paths.phase2).catch(() => undefined)).toBeUndefined();
        expect((await lstat(temp)).nlink).toBe(1);
      } else {
        expect((await lstat(paths.phase2)).nlink).toBe(2);
        expect((await lstat(temp)).nlink).toBe(2);
      }
    }
  );

  it("does not publish temp-only disposal evidence rebound to a foreign authorization", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [0, 1, 2, 3].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "b".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(recorded.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await registry.recordDisposalIntent(disposalIntentRequest(recorded.intent.creationAttemptId));
    const paths = await registryPaths(dataRoot);
    const temp = join(
      paths.journal,
      `.04-disposal-recorded.json.disposal_recorded.${recorded.intent.creationAttemptId}.tmp`
    );
    await rename(paths.phase4, temp);
    const foreign = JSON.parse(await readFile(temp, "utf8")) as Record<string, unknown>;
    foreign.environmentAuthorizationId = createId(
      "environmentAuthorization",
      "123e4567-e89b-42d3-a456-426614174001"
    );
    foreign.environmentAuthorizationDigest = "b".repeat(64);
    await writeFile(temp, `${JSON.stringify(resignPhaseEvidence(foreign))}\n`, { mode: 0o600 });
    const beforeTemp = await lstat(temp);

    await expectRegistryError(
      registry.recoverEnvironment(input.environmentId),
      "maintenance_required"
    );
    expect(await lstat(paths.phase4).catch(() => undefined)).toBeUndefined();
    expect(await lstat(temp)).toMatchObject({
      dev: beforeTemp.dev,
      ino: beforeTemp.ino,
      nlink: 1
    });
  });

  it("does not unlink a linked phase whose previous evidence digest is context-misbound", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [0, 1, 2, 3].map(
      (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
    );
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "c".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);
    await registry.recordWorktreeAdded({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await mkdir(recorded.intent.managedPath, { recursive: true });
    await registry.recordReady({
      environmentId: input.environmentId,
      creationAttemptId: recorded.intent.creationAttemptId
    });
    await registry.recordDisposalIntent(disposalIntentRequest(recorded.intent.creationAttemptId));
    const paths = await registryPaths(dataRoot);
    const phase4 = JSON.parse(await readFile(paths.phase4, "utf8")) as Record<string, unknown>;
    phase4.previousEvidenceDigest = "c".repeat(64);
    await writeFile(paths.phase4, `${JSON.stringify(resignPhaseEvidence(phase4))}\n`, {
      mode: 0o600
    });
    const temp = join(
      paths.journal,
      `.04-disposal-recorded.json.disposal_recorded.${recorded.intent.creationAttemptId}.tmp`
    );
    await link(paths.phase4, temp);
    const beforeCanonical = await lstat(paths.phase4);
    const beforeTemp = await lstat(temp);

    await expectRegistryError(
      registry.recoverEnvironment(input.environmentId),
      "maintenance_required"
    );
    expect(await lstat(paths.phase4)).toMatchObject({
      dev: beforeCanonical.dev,
      ino: beforeCanonical.ino,
      nlink: 2
    });
    expect(await lstat(temp)).toMatchObject({
      dev: beforeTemp.dev,
      ino: beforeTemp.ino,
      nlink: 2
    });
  });

  it.each(["disposal_digest", "authorization", "terminal_evidence"] as const)(
    "does not unlink linked disposed evidence with context-misbound %s",
    async (mismatch) => {
      const dataRoot = await temporaryRoot();
      const timestamps = [0, 1, 2, 3, 4].map(
        (millisecond) => `2026-08-21T12:00:00.00${String(millisecond)}Z`
      );
      const registry = await EnvironmentRegistry.create({
        dataRoot,
        createAttemptId: () => "d".repeat(32),
        now: () => timestamps.shift() ?? "invalid"
      });
      const recorded = await registry.recordIntent(input);
      await registry.recordWorktreeAdded({
        environmentId: input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId
      });
      await mkdir(recorded.intent.managedPath, { recursive: true });
      await registry.recordReady({
        environmentId: input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId
      });
      await registry.recordDisposalIntent(disposalIntentRequest(recorded.intent.creationAttemptId));
      await rmdir(recorded.intent.managedPath);
      await registry.recordDisposed(disposalVerificationRequest(recorded.intent.creationAttemptId));
      const paths = await registryPaths(dataRoot);
      const phase5 = JSON.parse(await readFile(paths.phase5, "utf8")) as Record<string, unknown>;
      if (mismatch === "disposal_digest") {
        phase5.disposalRequestDigest = "d".repeat(64);
      } else if (mismatch === "authorization") {
        phase5.environmentAuthorizationId = createId(
          "environmentAuthorization",
          "123e4567-e89b-42d3-a456-426614174001"
        );
        phase5.environmentAuthorizationDigest = "b".repeat(64);
      } else {
        phase5.terminalRunEvidence = {
          status: "completed",
          terminalEventSequence: 2,
          terminalEventDigest: "e".repeat(64)
        };
      }
      await writeFile(paths.phase5, `${JSON.stringify(resignPhaseEvidence(phase5))}\n`, {
        mode: 0o600
      });
      const temp = join(
        paths.journal,
        `.05-disposed.json.disposed.${recorded.intent.creationAttemptId}.tmp`
      );
      await link(paths.phase5, temp);
      const beforeCanonical = await lstat(paths.phase5);
      const beforeTemp = await lstat(temp);

      await expectRegistryError(
        registry.recoverEnvironment(input.environmentId),
        "maintenance_required"
      );
      expect(await lstat(paths.phase5)).toMatchObject({
        dev: beforeCanonical.dev,
        ino: beforeCanonical.ino,
        nlink: 2
      });
      expect(await lstat(temp)).toMatchObject({
        dev: beforeTemp.dev,
        ino: beforeTemp.ino,
        nlink: 2
      });
    }
  );

  it("serializes focused and full recovery behind a live environment publication", async () => {
    const dataRoot = await temporaryRoot();
    let releasePublication!: () => void;
    let publicationReached!: () => void;
    const releaseGate = new Promise<void>((resolvePromise) => {
      releasePublication = resolvePromise;
    });
    const reachedGate = new Promise<void>((resolvePromise) => {
      publicationReached = resolvePromise;
    });
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "c".repeat(32),
      now: () => "2026-08-21T12:00:00.000Z",
      onBoundary: async (boundary) => {
        if (boundary !== "intent.canonical-linked") return;
        publicationReached();
        await releaseGate;
      }
    });
    const writer = registry.recordIntent(input);
    await reachedGate;
    let focusedSettled = false;
    let fullSettled = false;
    const focused = registry.recoverEnvironment(input.environmentId).finally(() => {
      focusedSettled = true;
    });
    const full = registry.recoverAll().finally(() => {
      fullSettled = true;
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(focusedSettled).toBe(false);
    expect(fullSettled).toBe(false);
    releasePublication();
    const written = await writer;
    await expect(focused).resolves.toEqual(written);
    await expect(full).resolves.toEqual([written]);
  });

  it("rejects non-monotonic phase clocks and strict phase-request extensions", async () => {
    const dataRoot = await temporaryRoot();
    const timestamps = [
      "2026-08-21T12:00:00.000Z",
      "2026-08-21T12:00:00.000Z",
      "2026-08-21T12:00:00.001Z"
    ];
    const registry = await EnvironmentRegistry.create({
      dataRoot,
      createAttemptId: () => "b".repeat(32),
      now: () => timestamps.shift() ?? "invalid"
    });
    const recorded = await registry.recordIntent(input);

    await expectRegistryError(
      registry.recordWorktreeAdded({
        environmentId: input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId
      }),
      "invalid_input"
    );
    await expectRegistryError(
      registry.recordWorktreeAdded({
        environmentId: input.environmentId,
        creationAttemptId: recorded.intent.creationAttemptId,
        unexpected: true
      } as Parameters<EnvironmentRegistry["recordWorktreeAdded"]>[0]),
      "invalid_input"
    );
  });

  it("keeps public errors immutable and rejects extended options and noncanonical attempts", async () => {
    const firstRoot = await temporaryRoot();
    await expectRegistryError(
      EnvironmentRegistry.create({ dataRoot: firstRoot, unexpected: true } as Parameters<
        typeof EnvironmentRegistry.create
      >[0]),
      "invalid_input"
    );

    const secondRoot = await temporaryRoot();
    const registry = await EnvironmentRegistry.create({
      dataRoot: secondRoot,
      createAttemptId: () => "A".repeat(32)
    });
    const error = await registry.recordIntent(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnvironmentRegistryError);
    expect(error).toMatchObject({
      code: "invalid_input",
      message: ENVIRONMENT_REGISTRY_ERROR_MESSAGES.invalid_input
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(() => {
      (error as { code: string }).code = "filesystem_error";
    }).toThrow(TypeError);
  });
});
