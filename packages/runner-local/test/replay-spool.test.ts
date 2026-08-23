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
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

const boundedInspectionMeter = vi.hoisted(() => ({ reads: 0, maximum: Infinity }));
vi.mock("../src/replay-spool-codec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/replay-spool-codec.js")>();
  return {
    ...actual,
    async readBoundedInspection(...args: Parameters<typeof actual.readBoundedInspection>) {
      boundedInspectionMeter.reads += 1;
      if (boundedInspectionMeter.reads > boundedInspectionMeter.maximum) {
        throw new Error("triangular bounded-inspection budget exceeded");
      }
      return await actual.readBoundedInspection(...args);
    }
  };
});

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

import { ArtifactStore } from "../src/artifact-store.js";
import { writeArtifactUnderRecoveryGuard } from "../src/artifact-mutation-authority.js";
import { recoverCommandUnderLease } from "../src/command-recovery.js";
import { validateRecoveredCommand } from "../src/command-recovery-validation.js";
import { digestSpawnEnvelope } from "../src/command-spawn-envelope.js";
import { DataPathPolicy } from "../src/path-policy.js";
import {
  ReplaySpool,
  ReplaySpoolError,
  type ReplaySpoolPublicationStage
} from "../src/replay-spool.js";
import { canonicalJson, createPhaseReceipt, digestSpoolValue } from "../src/replay-spool-codec.js";
import { publishImmutable } from "../src/replay-spool-immutable-publication.js";
import { publishTranscriptImmutable } from "../src/replay-spool-transcript-publication.js";
import {
  acquireCommandGuardianLease,
  assertLiveCommandGuardianLease
} from "../src/data-root-lock.js";

const roots: string[] = [];
const openForRecovery = async (dataRoot: string): Promise<ReplaySpool> => {
  const lease = await acquireCommandGuardianLease(dataRoot, commandId);
  try {
    return await ReplaySpool.openForRecovery({ dataRoot, commandId, lease });
  } finally {
    lease.close();
  }
};
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-command-spool-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const commandId = createId("command", "00000000-0000-4000-8000-000000000002");
const workspaceId = createId("workspace", "00000000-0000-4000-8000-000000000003");
const runId = createId("run", "00000000-0000-4000-8000-000000000004");
const environmentId = createId("environment", "00000000-0000-4000-8000-000000000005");
const artifactId = createId("artifact", "00000000-0000-4000-8000-000000000006");
const environmentAuthorizationId = createId(
  "environmentAuthorization",
  "00000000-0000-4000-8000-000000000007"
);
const commandAuthorizationId = createId(
  "commandAuthorization",
  "00000000-0000-4000-8000-000000000008"
);
const approvalId = createId("approval", "00000000-0000-4000-8000-000000000009");

const hex64 = (character: string): string => character.repeat(64);
const command = {
  executable: "true",
  args: [] as string[],
  cwd: ".",
  environment: [] as const,
  timeoutSeconds: 10,
  terminal: { columns: 100, rows: 30 }
};
const environmentScope = {
  workspaceId,
  runId,
  environmentId,
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
  id: environmentAuthorizationId,
  approvalId,
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
  environmentAuthorizationId,
  environmentAuthorizationDigest: environmentAuthorization.digest,
  workspaceId,
  runId,
  environmentId,
  commandId,
  action: "implement" as const,
  commandDigest: await digestCommandSpec(command),
  repositoryIdentity: environmentScope.repositoryIdentity,
  sourceCommit: environmentScope.sourceCommit,
  branch: environmentScope.branch,
  cwdRoot: ".",
  networkPolicy: "host" as const,
  filesystemDisclosure: "host_user" as const,
  resourceLimits: { cpu: 2, memoryMb: 1_024, durationSeconds: 30 },
  allowedCredentialRefIds: []
};
const commandAuthorizationBase = {
  id: commandAuthorizationId,
  approvalId,
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
  workspaceId,
  runId,
  environmentId,
  commandId,
  command,
  environmentAuthorizationId,
  environmentAuthorizationDigest: environmentAuthorization.digest,
  authorization: commandAuthorization,
  idempotency: { key: "replay-spool-command" }
};
const spawnEnvelope = {
  executable: "/usr/bin/true",
  args: [] as string[],
  cwd: "/private/worktree",
  environment: [{ name: "PATH", value: "/usr/bin:/bin" }],
  terminal: { columns: 100, rows: 30 }
} as const;
const intent = Object.freeze({
  commandId,
  workspaceId,
  runId,
  environmentId,
  request: startRequest,
  requestDigest: await digestVersionedValue("autostack.start-command-request", startRequest),
  environmentIntentDigest: hex64("2"),
  environmentAuthorizationId,
  environmentAuthorizationDigest: environmentAuthorization.digest,
  environmentAuthorization,
  commandAuthorizationId,
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
  transcriptArtifactId: artifactId,
  artifactCreatedAt: "2026-08-21T12:00:00.000Z",
  guardianSessionBindingDigest: hex64("7"),
  limits: Object.freeze({
    eventBytes: 65_536,
    replayBytes: 1_048_576,
    transcriptBytes: 1_048_576,
    cancellationGraceMs: 1,
    eofSettleMs: 1
  })
});

describe("ReplaySpool", () => {
  it("keeps thousands of live transcript appends within a linear bounded-read budget", async () => {
    const dataRoot = await makeRoot();
    const originalOpenFile = DataPathPolicy.prototype.openFile;
    let boundedReads = 0;
    const openFile = vi.spyOn(DataPathPolicy.prototype, "openFile").mockImplementation(function (
      this: DataPathPolicy,
      relativePath,
      mode,
      createMissingParents
    ) {
      if (mode === "r") {
        boundedReads += 1;
        if (boundedReads > 64) throw new Error("triangular bounded-read budget exceeded");
      }
      return Reflect.apply(originalOpenFile, this, [relativePath, mode, createMissingParents]);
    });
    try {
      boundedInspectionMeter.reads = 0;
      boundedInspectionMeter.maximum = 64;
      const registered = await ReplaySpool.register({
        dataRoot,
        intent: {
          ...intent,
          limits: { ...intent.limits, transcriptBytes: 4_096 }
        }
      });
      boundedReads = 0;
      for (let ordinal = 0; ordinal < 1_024; ordinal += 1) {
        await registered.spool.appendTranscriptChunk(Buffer.from("x"));
      }

      expect(boundedReads).toBeLessThanOrEqual(64);
      expect(boundedInspectionMeter.reads).toBeLessThanOrEqual(64);
    } finally {
      boundedInspectionMeter.maximum = Infinity;
      openFile.mockRestore();
    }
    expect(
      (await (await ReplaySpool.open({ dataRoot, commandId })).recover()).transcriptChunks
    ).toHaveLength(1_024);
  }, 120_000);

  it("rechecks the recovery lease after an immutable alias-unlinked hook", async () => {
    const dataRoot = await makeRoot();
    const paths = await DataPathPolicy.create(dataRoot);
    await paths.ensureDirectory("direct");
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const stages: ReplaySpoolPublicationStage[] = [];
    const guard = () => assertLiveCommandGuardianLease(lease, paths.root, commandId);

    try {
      await expect(
        publishImmutable(
          paths,
          "direct/receipt.json",
          Buffer.from("receipt", "utf8"),
          "00000000000000000000000000000041",
          (_relativePath, stage) => {
            stages.push(stage);
            if (stage === "alias-unlinked") lease.close();
          },
          guard
        )
      ).rejects.toMatchObject({ code: "filesystem_error" });
      expect(stages.at(-1)).toBe("alias-unlinked");
      expect(stages).not.toContain("alias-directory-synced");
    } finally {
      lease.close();
    }
  });

  it("copies a cross-realm transcript chunk without reading own byte coercion properties", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    const realm = { propertyReads: 0 };
    const source = runInNewContext(
      `(() => {
        const value = new Uint8Array([0x78]);
        Object.defineProperties(value, {
          valueOf: {
            configurable: true,
            get() {
              propertyReads += 1;
              throw new Error("valueOf accessor reached");
            }
          },
          length: {
            configurable: true,
            get() {
              propertyReads += 1;
              return 100;
            }
          }
        });
        return value;
      })()`,
      realm
    ) as Uint8Array;

    await expect(spool.appendTranscriptChunk(source)).resolves.toMatchObject({
      byteSize: 1,
      cumulativeByteSize: 1
    });
    expect(realm.propertyReads).toBe(0);
    const component = Buffer.from(commandId, "utf8").toString("hex");
    await expect(
      readFile(join(dataRoot, "commands", component, "spool/transcript/000000000001.bin"))
    ).resolves.toEqual(Buffer.from([0x78]));
  });

  it("rechecks the recovery lease after a transcript alias-unlinked hook", async () => {
    const dataRoot = await makeRoot();
    const paths = await DataPathPolicy.create(dataRoot);
    await paths.ensureDirectory("direct");
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const stages: ReplaySpoolPublicationStage[] = [];
    const guard = () => assertLiveCommandGuardianLease(lease, paths.root, commandId);

    try {
      await expect(
        publishTranscriptImmutable({
          paths,
          canonicalRelativePath: "direct/transcript.bin",
          bytes: Buffer.from("x", "utf8"),
          evidence: {
            ordinal: 1,
            previousChunkDigest: null,
            contentDigest: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
            byteSize: 1,
            cumulativeByteSize: 1,
            chunkDigest: hex64("a")
          },
          attempt: "00000000000000000000000000000042",
          publicationHook: (_relativePath, stage) => {
            stages.push(stage);
            if (stage === "alias-unlinked") lease.close();
          },
          mutationGuard: guard
        })
      ).rejects.toMatchObject({ code: "filesystem_error" });
      expect(stages.at(-1)).toBe("alias-unlinked");
      expect(stages).not.toContain("alias-directory-synced");
    } finally {
      lease.close();
    }
  });

  it("does not report terminal receipt recovery after the final hook closes its lease", async () => {
    const dataRoot = await makeRoot();
    const paths = await DataPathPolicy.create(dataRoot);
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const parent = `commands/${component}/receipt`;
    const canonicalRelativePath = `${parent}/06-terminal.json`;
    await paths.ensureDirectory(parent);
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const stages: ReplaySpoolPublicationStage[] = [];
    const guard = () => assertLiveCommandGuardianLease(lease, paths.root, commandId);
    const terminal = createPhaseReceipt(
      "terminal",
      6,
      commandId,
      hex64("b"),
      "2026-08-21T12:00:06.000Z",
      { recovered: true }
    );
    const bytes = Buffer.from(canonicalJson(terminal), "utf8");

    try {
      await expect(
        publishImmutable(
          paths,
          canonicalRelativePath,
          bytes,
          "00000000000000000000000000000043",
          (_relativePath, stage) => {
            stages.push(stage);
            if (stage === "alias-directory-synced") lease.close();
          },
          guard
        )
      ).rejects.toMatchObject({ code: "unsafe_state" });
      expect(stages.at(-1)).toBe("alias-directory-synced");
      expect(JSON.parse(await readFile(join(dataRoot, canonicalRelativePath), "utf8"))).toEqual(
        terminal
      );
    } finally {
      lease.close();
    }
  });

  it("does not report transcript recovery after the final hook closes its lease", async () => {
    const dataRoot = await makeRoot();
    const paths = await DataPathPolicy.create(dataRoot);
    await paths.ensureDirectory("direct");
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const stages: ReplaySpoolPublicationStage[] = [];
    const guard = () => assertLiveCommandGuardianLease(lease, paths.root, commandId);
    const bytes = Buffer.from("x", "utf8");

    try {
      await expect(
        publishTranscriptImmutable({
          paths,
          canonicalRelativePath: "direct/final-transcript.bin",
          bytes,
          evidence: {
            ordinal: 1,
            previousChunkDigest: null,
            contentDigest: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
            byteSize: 1,
            cumulativeByteSize: 1,
            chunkDigest: hex64("c")
          },
          attempt: "00000000000000000000000000000044",
          publicationHook: (_relativePath, stage) => {
            stages.push(stage);
            if (stage === "alias-directory-synced") lease.close();
          },
          mutationGuard: guard
        })
      ).rejects.toMatchObject({ code: "unsafe_state" });
      expect(stages.at(-1)).toBe("alias-directory-synced");
      expect(await readFile(join(dataRoot, "direct/final-transcript.bin"))).toEqual(bytes);
    } finally {
      lease.close();
    }
  });

  it("does not report artifact recovery after the final boundary closes its lease", async () => {
    const dataRoot = await makeRoot();
    let lease: Awaited<ReturnType<typeof acquireCommandGuardianLease>> | undefined;
    const boundaries: string[] = [];
    const store = await ArtifactStore.create({
      dataRoot,
      onBoundary: (boundary) => {
        boundaries.push(boundary);
        if (boundary === "transaction.directory-synced-final") lease?.close();
      }
    });
    lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const paths = await DataPathPolicy.create(dataRoot);
    const guard = () => assertLiveCommandGuardianLease(lease, paths.root, commandId);

    await expect(
      writeArtifactUnderRecoveryGuard(
        store,
        {
          metadata: {
            artifactId,
            workspaceId,
            runId,
            commandId,
            kind: "command_transcript",
            mediaType: "text/plain",
            createdAt: "2026-08-21T12:00:06.000Z"
          },
          content: (async function* () {
            yield Buffer.from("safe artifact", "utf8");
          })(),
          maximumBytes: 1024,
          sensitiveValues: []
        },
        guard
      )
    ).rejects.toMatchObject({ code: "unsafe_state" });
    expect(boundaries.at(-1)).toBe("transaction.directory-synced-final");
    await expect(store.findArtifact(artifactId)).resolves.toMatchObject({ artifactId, commandId });
    lease.close();
  });

  it("rejects accessor and Proxy recovery-open options without touching their traps", async () => {
    const dataRoot = await makeRoot();
    const otherRoot = await makeRoot();
    await ReplaySpool.register({ dataRoot, intent });
    await ReplaySpool.register({ dataRoot: otherRoot, intent });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    let rootReads = 0;
    const accessorOptions = Object.defineProperties(
      {},
      {
        dataRoot: {
          enumerable: true,
          get() {
            rootReads += 1;
            return rootReads === 1 ? dataRoot : otherRoot;
          }
        },
        commandId: { enumerable: true, value: commandId },
        lease: { enumerable: true, value: lease }
      }
    );

    await expect(ReplaySpool.openForRecovery(accessorOptions as never)).rejects.toEqual(
      new ReplaySpoolError("maintenance_required")
    );
    expect(rootReads).toBe(0);

    let proxyTraps = 0;
    const proxyOptions = new Proxy(
      { dataRoot, commandId, lease },
      {
        get() {
          proxyTraps += 1;
          throw new Error("recovery option getter reached");
        },
        ownKeys() {
          proxyTraps += 1;
          throw new Error("recovery option keys reached");
        }
      }
    );
    await expect(ReplaySpool.openForRecovery(proxyOptions)).rejects.toEqual(
      new ReplaySpoolError("maintenance_required")
    );
    expect(proxyTraps).toBe(0);
    expect((await ReplaySpool.open({ dataRoot, commandId })).intent.commandId).toBe(commandId);
    expect((await ReplaySpool.open({ dataRoot: otherRoot, commandId })).intent.commandId).toBe(
      commandId
    );
    lease.close();
  });

  it("snapshots recovery options before accessors can substitute foreign capabilities", async () => {
    const dataRoot = await makeRoot();
    const otherRoot = await makeRoot();
    const local = await ReplaySpool.register({ dataRoot, intent });
    const foreign = await ReplaySpool.register({ dataRoot: otherRoot, intent });
    const localStore = await ArtifactStore.create({ dataRoot });
    const foreignStore = await ArtifactStore.create({ dataRoot: otherRoot });
    const localLease = await acquireCommandGuardianLease(dataRoot, commandId);
    const foreignLease = await acquireCommandGuardianLease(otherRoot, commandId);
    const localRecovery = await ReplaySpool.openForRecovery({
      dataRoot,
      commandId,
      lease: localLease
    });
    const foreignRecovery = await ReplaySpool.openForRecovery({
      dataRoot: otherRoot,
      commandId,
      lease: foreignLease
    });
    let spoolReads = 0;
    let storeReads = 0;
    const options = Object.defineProperties(
      {},
      {
        dataRoot: { enumerable: true, value: dataRoot },
        commandId: { enumerable: true, value: commandId },
        spool: {
          enumerable: true,
          get() {
            spoolReads += 1;
            return spoolReads === 1 ? localRecovery : foreignRecovery;
          }
        },
        artifactStore: {
          enumerable: true,
          get() {
            storeReads += 1;
            return storeReads === 1 ? localStore : foreignStore;
          }
        },
        acquiredLease: { enumerable: true, value: localLease }
      }
    );

    await expect(recoverCommandUnderLease(options as never)).rejects.toEqual(
      new ReplaySpoolError("maintenance_required")
    );
    expect({ spoolReads, storeReads }).toEqual({ spoolReads: 0, storeReads: 0 });
    expect((await local.spool.recover()).phases.map((phase) => phase.phase)).toEqual(["intent"]);
    expect((await foreign.spool.recover()).phases.map((phase) => phase.phase)).toEqual(["intent"]);
    await expect(localStore.findArtifact(artifactId)).resolves.toBeUndefined();
    await expect(foreignStore.findArtifact(artifactId)).resolves.toBeUndefined();
    localLease.close();
    foreignLease.close();
  });

  it("uses recovery-spool operations captured before public methods are rebound", async () => {
    const dataRoot = await makeRoot();
    const otherRoot = await makeRoot();
    const local = await ReplaySpool.register({ dataRoot, intent });
    const foreign = await ReplaySpool.register({ dataRoot: otherRoot, intent });
    const localStore = await ArtifactStore.create({ dataRoot });
    const localLease = await acquireCommandGuardianLease(dataRoot, commandId);
    const foreignLease = await acquireCommandGuardianLease(otherRoot, commandId);
    const localRecovery = await ReplaySpool.openForRecovery({
      dataRoot,
      commandId,
      lease: localLease
    });
    const foreignRecovery = await ReplaySpool.openForRecovery({
      dataRoot: otherRoot,
      commandId,
      lease: foreignLease
    });
    Object.defineProperties(localRecovery, {
      recover: { value: foreignRecovery.recover.bind(foreignRecovery) },
      recordPhase: { value: foreignRecovery.recordPhase.bind(foreignRecovery) },
      appendEvent: { value: foreignRecovery.appendEvent.bind(foreignRecovery) }
    });

    await expect(
      recoverCommandUnderLease({
        dataRoot,
        commandId,
        spool: localRecovery,
        artifactStore: localStore,
        acquiredLease: localLease
      })
    ).resolves.toMatchObject({ intent: { commandId } });
    expect((await local.spool.recover()).phases.at(-1)?.phase).toBe("terminal");
    expect((await foreign.spool.recover()).phases.map((phase) => phase.phase)).toEqual(["intent"]);
    localLease.close();
    foreignLease.close();
  });

  it("uses artifact operations captured before public methods are rebound", async () => {
    const dataRoot = await makeRoot();
    const otherRoot = await makeRoot();
    await ReplaySpool.register({ dataRoot, intent });
    const localStore = await ArtifactStore.create({ dataRoot });
    const foreignStore = await ArtifactStore.create({ dataRoot: otherRoot });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const recovery = await ReplaySpool.openForRecovery({ dataRoot, commandId, lease });
    const findLocalArtifact = localStore.findArtifact.bind(localStore);
    const findForeignArtifact = foreignStore.findArtifact.bind(foreignStore);
    Object.defineProperties(localStore, {
      writeArtifact: { value: foreignStore.writeArtifact.bind(foreignStore) },
      findArtifact: { value: foreignStore.findArtifact.bind(foreignStore) }
    });

    await expect(
      recoverCommandUnderLease({
        dataRoot,
        commandId,
        spool: recovery,
        artifactStore: localStore,
        acquiredLease: lease
      })
    ).resolves.toMatchObject({ intent: { commandId } });
    await expect(findLocalArtifact(artifactId)).resolves.toMatchObject({ artifactId, commandId });
    await expect(findForeignArtifact(artifactId)).resolves.toBeUndefined();
    lease.close();
  });

  it("rejects a replacement root at the leased pathname before healing its aliases", async () => {
    const dataRoot = await makeRoot();
    await ReplaySpool.register({ dataRoot, intent });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const displacedRoot = `${dataRoot}-displaced`;
    roots.push(displacedRoot);
    await rename(dataRoot, displacedRoot);
    await mkdir(dataRoot, { mode: 0o700 });
    const replacement = await ReplaySpool.register({ dataRoot, intent });
    const canonical = join(dataRoot, replacement.intentRelativePath);
    const alias = join(canonical, "..", ".01-intent.json.00000000000000000000000000000045.tmp");
    await link(canonical, alias);
    const before = await stat(alias);

    await expect(ReplaySpool.openForRecovery({ dataRoot, commandId, lease })).rejects.toEqual(
      new ReplaySpoolError("maintenance_required")
    );
    const after = await stat(alias);
    expect({ dev: after.dev, ino: after.ino, nlink: after.nlink }).toEqual({
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink
    });
    lease.close();
  });

  it("rejects a replacement command directory before healing its aliases", async () => {
    const dataRoot = await makeRoot();
    const registered = await ReplaySpool.register({ dataRoot, intent });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const commandRoot = join(dataRoot, "commands", component);
    const displacedCommandRoot = join(dataRoot, "commands", `${component}.displaced`);
    await rename(commandRoot, displacedCommandRoot);
    const replacement = await ReplaySpool.register({ dataRoot, intent });
    const canonical = join(dataRoot, replacement.intentRelativePath);
    const alias = join(canonical, "..", ".01-intent.json.00000000000000000000000000000046.tmp");
    await link(canonical, alias);
    const before = await stat(alias);

    await expect(ReplaySpool.openForRecovery({ dataRoot, commandId, lease })).rejects.toEqual(
      new ReplaySpoolError("maintenance_required")
    );
    const after = await stat(alias);
    expect({ dev: after.dev, ino: after.ino, nlink: after.nlink }).toEqual({
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink
    });
    lease.close();
    expect(registered.receipt.commandId).toBe(commandId);
  });

  it("rejects a replacement guardian lease file before healing aliases", async () => {
    const dataRoot = await makeRoot();
    const registered = await ReplaySpool.register({ dataRoot, intent });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const commandRoot = join(dataRoot, "commands", component);
    const leasePath = join(commandRoot, "guardian-lease.sqlite3");
    const leaseHoldingRoot = await makeRoot();
    await rename(leasePath, join(leaseHoldingRoot, "old-lease.sqlite3"));
    await writeFile(leasePath, "", { flag: "wx", mode: 0o600 });
    const canonical = join(dataRoot, registered.intentRelativePath);
    const alias = join(canonical, "..", ".01-intent.json.00000000000000000000000000000047.tmp");
    await link(canonical, alias);
    const before = await stat(alias);

    await expect(ReplaySpool.openForRecovery({ dataRoot, commandId, lease })).rejects.toEqual(
      new ReplaySpoolError("maintenance_required")
    );
    const after = await stat(alias);
    expect({ dev: after.dev, ino: after.ino, nlink: after.nlink }).toEqual({
      dev: before.dev,
      ino: before.ino,
      nlink: before.nlink
    });
    lease.close();
  });

  it("publishes an immutable intent and replays only an exact request", async () => {
    const dataRoot = await makeRoot();
    const first = await ReplaySpool.register({
      dataRoot,
      intent,
      createAttemptId: () => "00000000000000000000000000000001"
    });

    expect(first.replayed).toBe(false);
    expect(first.receipt.phase).toBe("intent");
    const durableBytes = await readFile(join(dataRoot, first.intentRelativePath), "utf8");
    expect(durableBytes).toContain(`\"commandId\":\"${commandId}\"`);

    const replay = await ReplaySpool.register({ dataRoot, intent });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);

    await expect(
      ReplaySpool.register({
        dataRoot,
        intent: { ...intent, requestDigest: hex64("8") }
      })
    ).rejects.toEqual(new ReplaySpoolError("command_conflict"));
  });

  it("recovers a gap-free hash-chained event stream", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    await spool.appendEvent({
      type: "command.started",
      workspaceId,
      runId,
      commandId,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });

    const recovered = await spool.recover();
    expect(recovered.events.map((frame) => frame.event.sequence)).toEqual([1]);
    expect(recovered.events[0]?.previousFrameDigest).toBeNull();
    expect(recovered.events[0]?.frameDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deeply snapshots live and recovered nested runner event evidence", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    await spool.appendEvent({
      type: "command.started",
      workspaceId,
      runId,
      commandId,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });
    const artifact = {
      artifactId,
      workspaceId,
      runId,
      commandId,
      kind: "command_transcript" as const,
      mediaType: "text/plain; charset=utf-8",
      digest: hex64("8"),
      byteSize: 12,
      createdAt: intent.artifactCreatedAt
    };
    const artifactFrame = await spool.appendEvent({
      type: "artifact.created",
      workspaceId,
      runId,
      commandId,
      sequence: 2,
      occurredAt: "2026-08-21T12:00:02.000Z",
      artifact
    });
    if (artifactFrame.event.type !== "artifact.created") throw new TypeError();
    expect(Reflect.set(artifactFrame.event.artifact, "digest", hex64("9"))).toBe(false);
    artifact.digest = hex64("a");
    const liveArtifact = await spool.readEvent(2);
    expect(liveArtifact?.event).toMatchObject({
      type: "artifact.created",
      artifact: { digest: hex64("8") }
    });
    expect(
      liveArtifact?.event.type === "artifact.created" &&
        Object.isFrozen(liveArtifact.event.artifact)
    ).toBe(true);

    const completed = await spool.appendEvent({
      type: "command.completed",
      workspaceId,
      runId,
      commandId,
      sequence: 3,
      occurredAt: "2026-08-21T12:00:03.000Z",
      exitCode: 0,
      signal: null,
      durationMs: 10,
      cancelled: false,
      interrupted: false,
      transcript: { ...artifact, digest: hex64("b") }
    });
    const reopened = await ReplaySpool.open({ dataRoot, commandId });
    const recovered = await reopened.recover();
    const recoveredCompleted = recovered.events.at(-1);
    if (
      completed.event.type !== "command.completed" ||
      recoveredCompleted?.event.type !== "command.completed"
    ) {
      throw new TypeError();
    }
    expect(Reflect.set(recoveredCompleted.event.transcript, "digest", hex64("c"))).toBe(false);
    expect((await reopened.readEvent(3))?.event).toMatchObject({
      type: "command.completed",
      transcript: { digest: hex64("b") }
    });
    expect(Object.isFrozen(recoveredCompleted.event.transcript)).toBe(true);
  });

  it("rejects aggregate replay overflow before publishing the frame", async () => {
    const dataRoot = await makeRoot();
    const constrained = {
      ...intent,
      limits: { ...intent.limits, eventBytes: 8_192, replayBytes: 32_768 }
    };
    const { spool } = await ReplaySpool.register({ dataRoot, intent: constrained });
    await spool.appendEvent({
      type: "command.started",
      workspaceId,
      runId,
      commandId,
      sequence: 1,
      occurredAt: "2026-08-21T12:00:01.000Z",
      pty: true
    });

    for (let sequence = 2; sequence < 6; sequence += 1) {
      await spool.appendEvent({
        type: "terminal.output",
        workspaceId,
        runId,
        commandId,
        sequence,
        occurredAt: `2026-08-21T12:00:0${sequence}.000Z`,
        stream: "pty",
        text: "x".repeat(7_000)
      });
    }
    await expect(
      spool.appendEvent({
        type: "terminal.output",
        workspaceId,
        runId,
        commandId,
        sequence: 6,
        occurredAt: "2026-08-21T12:00:06.000Z",
        stream: "pty",
        text: "x".repeat(7_000)
      })
    ).rejects.toEqual(new ReplaySpoolError("invalid_transition"));
    expect((await spool.recover()).events).toHaveLength(5);
  });

  it("closes transcript admission before finalizing or terminal publication", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    for (const [index, phase] of [
      "lease_transferred",
      "spawned",
      "running",
      "finalizing"
    ].entries()) {
      await spool.recordPhase(phase as never, {
        recordedAt: `2026-08-21T12:00:0${index + 1}.000Z`,
        evidence: { safe: true }
      });
    }
    await expect(spool.appendTranscriptChunk(Buffer.from("late output"))).rejects.toEqual(
      new ReplaySpoolError("invalid_transition")
    );
  });

  it("does not mutate a semantic alias before full receipt binding validation", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    const rebound = createPhaseReceipt(
      "lease_transferred",
      2,
      createId("command", "00000000-0000-4000-8000-000000000099"),
      spool.intent.receiptDigest,
      "2026-08-21T12:00:01.000Z",
      { leaseTransferred: true }
    );
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const receiptRoot = join(dataRoot, "commands", component, "receipt");
    const alias = join(
      receiptRoot,
      ".02-lease-transferred.json.11111111111111111111111111111111.tmp"
    );
    const canonical = join(receiptRoot, "02-lease-transferred.json");
    await writeFile(alias, canonicalJson(rebound), { flag: "wx", mode: 0o600 });

    await expect(spool.recover()).resolves.toMatchObject({ intent: spool.intent });
    await expect(access(canonical)).rejects.toBeDefined();
    await expect(access(alias)).resolves.toBeUndefined();
  });

  it("keeps live canonical inspection non-mutating when an exact hardlink alias remains", async () => {
    const dataRoot = await makeRoot();
    const registered = await ReplaySpool.register({ dataRoot, intent });
    const canonical = join(dataRoot, registered.intentRelativePath);
    const alias = join(canonical, "..", ".01-intent.json.11111111111111111111111111111111.tmp");
    await link(canonical, alias);
    const beforeCanonical = await stat(canonical);
    const beforeAlias = await stat(alias);

    await expect(registered.spool.recover()).resolves.toMatchObject({
      intent: registered.receipt
    });
    const afterCanonical = await stat(canonical);
    const afterAlias = await stat(alias);
    expect({
      dev: afterCanonical.dev,
      ino: afterCanonical.ino,
      nlink: afterCanonical.nlink
    }).toEqual({
      dev: beforeCanonical.dev,
      ino: beforeCanonical.ino,
      nlink: beforeCanonical.nlink
    });
    expect({ dev: afterAlias.dev, ino: afterAlias.ino, nlink: afterAlias.nlink }).toEqual({
      dev: beforeAlias.dev,
      ino: beforeAlias.ino,
      nlink: beforeAlias.nlink
    });
  });

  it("does not unlink a hardlinked invalid recovery candidate before semantic validation", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const receiptRoot = join(dataRoot, "commands", component, "receipt");
    const canonical = join(receiptRoot, "02-lease-transferred.json");
    const alias = join(
      receiptRoot,
      ".02-lease-transferred.json.22222222222222222222222222222222.tmp"
    );
    await writeFile(canonical, "{}", { mode: 0o600, flag: "wx" });
    await link(canonical, alias);
    const before = await stat(canonical);

    await expect(spool.recover()).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    const canonicalAfter = await stat(canonical);
    const aliasAfter = await stat(alias);
    expect({ ino: canonicalAfter.ino, nlink: canonicalAfter.nlink }).toEqual({
      ino: before.ino,
      nlink: before.nlink
    });
    expect({ ino: aliasAfter.ino, nlink: aliasAfter.nlink }).toEqual({
      ino: before.ino,
      nlink: before.nlink
    });
  });

  it("heals exact crash aliases and removes exact incomplete temporaries", async () => {
    const dataRoot = await makeRoot();
    const registered = await ReplaySpool.register({ dataRoot, intent });
    const canonical = join(dataRoot, registered.intentRelativePath);
    const parent = join(canonical, "..");
    const linkedAlias = join(parent, ".01-intent.json.00000000000000000000000000000011.tmp");
    await link(canonical, linkedAlias);

    await expect(openForRecovery(dataRoot)).resolves.toBeInstanceOf(ReplaySpool);
    await expect(access(linkedAlias)).rejects.toMatchObject({ code: "ENOENT" });

    const completeAlias = join(parent, ".01-intent.json.00000000000000000000000000000012.tmp");
    await link(canonical, completeAlias);
    await unlink(canonical);
    await expect(openForRecovery(dataRoot)).resolves.toBeInstanceOf(ReplaySpool);
    await expect(access(completeAlias)).rejects.toMatchObject({ code: "ENOENT" });

    const incompleteAlias = join(parent, ".01-intent.json.00000000000000000000000000000013.tmp");
    await writeFile(incompleteAlias, "", { mode: 0o600, flag: "wx" });
    await expect(openForRecovery(dataRoot)).resolves.toBeInstanceOf(ReplaySpool);
    await expect(access(incompleteAlias)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["closed", "wrong-root", "forged"] as const)(
    "rejects a %s guardian lease before mutating a recoverable alias",
    async (variant) => {
      const dataRoot = await makeRoot();
      const otherRoot = await makeRoot();
      const registered = await ReplaySpool.register({ dataRoot, intent });
      const canonical = join(dataRoot, registered.intentRelativePath);
      const alias = join(canonical, "..", ".01-intent.json.00000000000000000000000000000021.tmp");
      await link(canonical, alias);
      const beforeCanonical = await stat(canonical);
      const beforeAlias = await stat(alias);
      const lease =
        variant === "wrong-root"
          ? await acquireCommandGuardianLease(otherRoot, commandId)
          : variant === "closed"
            ? await acquireCommandGuardianLease(dataRoot, commandId)
            : ({ commandId } as never);
      if (variant === "closed") lease.close();

      await expect(ReplaySpool.openForRecovery({ dataRoot, commandId, lease })).rejects.toEqual(
        new ReplaySpoolError("maintenance_required")
      );
      const afterCanonical = await stat(canonical);
      const afterAlias = await stat(alias);
      expect({ ino: afterCanonical.ino, nlink: afterCanonical.nlink }).toEqual({
        ino: beforeCanonical.ino,
        nlink: beforeCanonical.nlink
      });
      expect({ ino: afterAlias.ino, nlink: afterAlias.nlink }).toEqual({
        ino: beforeAlias.ino,
        nlink: beforeAlias.nlink
      });
      expect((await registered.spool.recover()).phases.map((phase) => phase.phase)).toEqual([
        "intent"
      ]);
      if (variant === "wrong-root") lease.close();
    }
  );

  it("does not inspect an accessor-backed lease before exact brand admission", async () => {
    const dataRoot = await makeRoot();
    const registered = await ReplaySpool.register({ dataRoot, intent });
    const canonical = join(dataRoot, registered.intentRelativePath);
    const alias = join(canonical, "..", ".01-intent.json.00000000000000000000000000000022.tmp");
    await link(canonical, alias);
    const owned = await acquireCommandGuardianLease(dataRoot, commandId);
    let traps = 0;
    const proxy = new Proxy(owned, {
      get() {
        traps += 1;
        throw new Error("lease accessor reached");
      }
    });

    await expect(
      ReplaySpool.openForRecovery({ dataRoot, commandId, lease: proxy })
    ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    expect(traps).toBe(0);
    await expect(access(alias)).resolves.toBeUndefined();
    owned.close();
  });

  it("rejects closed and forged recovery leases before creating a missing root", async () => {
    const closedRoot = await makeRoot();
    const closedLease = await acquireCommandGuardianLease(closedRoot, commandId);
    closedLease.close();
    await rm(closedRoot, { recursive: true });

    await expect(
      ReplaySpool.openForRecovery({ dataRoot: closedRoot, commandId, lease: closedLease })
    ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    await expect(access(closedRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const parent = await makeRoot();
    const forgedRoot = join(parent, "missing-forged-root");
    await expect(
      ReplaySpool.openForRecovery({
        dataRoot: forgedRoot,
        commandId,
        lease: { commandId } as never
      })
    ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    await expect(access(forgedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the exact live lease guard on a recovery-opened spool", async () => {
    const dataRoot = await makeRoot();
    await ReplaySpool.register({ dataRoot, intent });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const recoveredSpool = await ReplaySpool.openForRecovery({ dataRoot, commandId, lease });
    lease.close();

    await expect(
      recoveredSpool.recordPhase("lease_transferred", {
        recordedAt: "2026-08-21T12:00:01.000Z",
        evidence: { exactLease: true }
      })
    ).rejects.toMatchObject({ code: "unsafe_state" });
    expect((await recoveredSpool.recover()).phases.map((phase) => phase.phase)).toEqual(["intent"]);
  });

  it("rechecks a live guardian lease inside a recovery publication boundary", async () => {
    const dataRoot = await makeRoot();
    await ReplaySpool.register({ dataRoot, intent });
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const recoveredSpool = await ReplaySpool.openForRecovery({
      dataRoot,
      commandId,
      lease,
      createAttemptId: () => {
        lease.close();
        return "00000000000000000000000000000023";
      }
    });

    await expect(
      recoverCommandUnderLease({
        dataRoot,
        commandId,
        spool: recoveredSpool,
        artifactStore,
        acquiredLease: lease
      })
    ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    const component = Buffer.from(commandId, "utf8").toString("hex");
    await expect(
      access(join(dataRoot, "commands", component, "receipt", "02-lease-transferred.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(artifactStore.findArtifact(artifactId)).resolves.toBeUndefined();
  });

  it("rejects a live non-recovery spool before reading or publishing recovery state", async () => {
    const dataRoot = await makeRoot();
    const registered = await ReplaySpool.register({ dataRoot, intent });
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);

    await expect(
      recoverCommandUnderLease({
        dataRoot,
        commandId,
        spool: registered.spool,
        artifactStore,
        acquiredLease: lease
      })
    ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    expect((await registered.spool.recover()).phases.map((phase) => phase.phase)).toEqual([
      "intent"
    ]);
    await expect(artifactStore.findArtifact(artifactId)).resolves.toBeUndefined();
    lease.close();
  });

  it("rejects a valid recovery spool from another root without mutating either root", async () => {
    const dataRoot = await makeRoot();
    const otherRoot = await makeRoot();
    const local = await ReplaySpool.register({ dataRoot, intent });
    const foreign = await ReplaySpool.register({ dataRoot: otherRoot, intent });
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const localLease = await acquireCommandGuardianLease(dataRoot, commandId);
    const foreignLease = await acquireCommandGuardianLease(otherRoot, commandId);
    const foreignRecoverySpool = await ReplaySpool.openForRecovery({
      dataRoot: otherRoot,
      commandId,
      lease: foreignLease
    });

    await expect(
      recoverCommandUnderLease({
        dataRoot,
        commandId,
        spool: foreignRecoverySpool,
        artifactStore,
        acquiredLease: localLease
      })
    ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    expect((await local.spool.recover()).phases.map((phase) => phase.phase)).toEqual(["intent"]);
    expect((await foreign.spool.recover()).phases.map((phase) => phase.phase)).toEqual(["intent"]);
    await expect(artifactStore.findArtifact(artifactId)).resolves.toBeUndefined();
    localLease.close();
    foreignLease.close();
  });

  it("rejects a foreign-root artifact writer before recovery mutates command state", async () => {
    const dataRoot = await makeRoot();
    const otherRoot = await makeRoot();
    const registered = await ReplaySpool.register({ dataRoot, intent });
    const artifactStore = await ArtifactStore.create({ dataRoot: otherRoot });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const recoveredSpool = await ReplaySpool.openForRecovery({ dataRoot, commandId, lease });

    await expect(
      recoverCommandUnderLease({
        dataRoot,
        commandId,
        spool: recoveredSpool,
        artifactStore,
        acquiredLease: lease
      })
    ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    expect((await registered.spool.recover()).phases.map((phase) => phase.phase)).toEqual([
      "intent"
    ]);
    await expect(artifactStore.findArtifact(artifactId)).resolves.toBeUndefined();
    lease.close();
  });

  it("rejects an unbranded accessor spool without invoking any accessor", async () => {
    const dataRoot = await makeRoot();
    await ReplaySpool.register({ dataRoot, intent });
    const artifactStore = await ArtifactStore.create({ dataRoot });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    let traps = 0;
    const forged = new Proxy(
      {},
      {
        get() {
          traps += 1;
          throw new Error("spool accessor reached");
        }
      }
    );

    await expect(
      recoverCommandUnderLease({
        dataRoot,
        commandId,
        spool: forged as never,
        artifactStore,
        acquiredLease: lease
      })
    ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    expect(traps).toBe(0);
    lease.close();
  });

  it("does not recreate a deleted recovery publication parent", async () => {
    const dataRoot = await makeRoot();
    await ReplaySpool.register({ dataRoot, intent });
    const lease = await acquireCommandGuardianLease(dataRoot, commandId);
    const recoveredSpool = await ReplaySpool.openForRecovery({ dataRoot, commandId, lease });
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const controlDirectory = join(dataRoot, "commands", component, "control");
    await rm(controlDirectory, { recursive: true });

    await expect(
      recoveredSpool.recordCancel({
        requestDigest: hex64("8"),
        decidedAt: "2026-08-21T12:00:01.000Z",
        cancelled: true
      })
    ).rejects.toBeDefined();
    await expect(access(controlDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    lease.close();
  });

  it.each(["blob.before-publish", "blob.canonical-directory-synced"] as const)(
    "rechecks the exact recovery lease at artifact filesystem boundary %s",
    async (closingBoundary) => {
      const dataRoot = await makeRoot();
      const registered = await ReplaySpool.register({ dataRoot, intent });
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
        workspaceId,
        runId,
        commandId,
        sequence: 1,
        occurredAt: "2026-08-21T12:00:02.500Z",
        pty: true
      });
      await registered.spool.recordPhase("running", {
        recordedAt: "2026-08-21T12:00:03.000Z",
        evidence: { startedFrameDigest: started.frameDigest, liveCapability: true }
      });
      await registered.spool.recordPhase("finalizing", {
        recordedAt: "2026-08-21T12:00:04.000Z",
        evidence: {
          cause: "natural",
          exitCode: 0,
          signal: null,
          durationMs: 42,
          cancelled: false,
          interrupted: false,
          processTreeTerminated: true,
          ptyEofObserved: true,
          transcriptByteSize: 0,
          transcriptHeadDigest: null
        }
      });
      await expect(
        validateRecoveredCommand(await registered.spool.recover())
      ).resolves.toBeUndefined();
      let lease: Awaited<ReturnType<typeof acquireCommandGuardianLease>> | undefined;
      const boundaries: string[] = [];
      const artifactStore = await ArtifactStore.create({
        dataRoot,
        onBoundary: (boundary) => {
          boundaries.push(boundary);
          if (boundary === closingBoundary) lease?.close();
        }
      });
      lease = await acquireCommandGuardianLease(dataRoot, commandId);
      const recoveredSpool = await ReplaySpool.openForRecovery({
        dataRoot,
        commandId,
        lease
      });

      await expect(
        recoverCommandUnderLease({
          dataRoot,
          commandId,
          spool: recoveredSpool,
          artifactStore,
          acquiredLease: lease
        })
      ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
      expect(boundaries).toContain(closingBoundary);
      await expect(artifactStore.findArtifact(artifactId)).resolves.toBeUndefined();
      if (closingBoundary === "blob.canonical-directory-synced") {
        expect(await readdir(join(dataRoot, "artifacts", "sha256", "e3"))).toHaveLength(2);
      }
      const after = await registered.spool.recover();
      expect(after.phases.at(-1)?.phase).toBe("finalizing");
      expect(after.events).toHaveLength(1);
    }
  );

  it.each(["closed", "wrong-root", "forged"] as const)(
    "rejects a %s guardian lease before recovery phase or artifact publication",
    async (variant) => {
      const dataRoot = await makeRoot();
      const otherRoot = await makeRoot();
      const registered = await ReplaySpool.register({ dataRoot, intent });
      const artifactStore = await ArtifactStore.create({ dataRoot });
      const lease =
        variant === "wrong-root"
          ? await acquireCommandGuardianLease(otherRoot, commandId)
          : variant === "closed"
            ? await acquireCommandGuardianLease(dataRoot, commandId)
            : ({ commandId } as never);
      if (variant === "closed") lease.close();
      const before = await registered.spool.recover();

      await expect(
        recoverCommandUnderLease({
          dataRoot,
          commandId,
          spool: registered.spool,
          artifactStore,
          acquiredLease: lease
        })
      ).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
      const after = await registered.spool.recover();
      expect({ phases: after.phases, events: after.events }).toEqual({
        phases: before.phases,
        events: before.events
      });
      await expect(artifactStore.findArtifact(artifactId)).resolves.toBeUndefined();
      if (variant === "wrong-root") lease.close();
    }
  );

  it("keeps malformed or foreign crash aliases unsafe", async () => {
    const dataRoot = await makeRoot();
    const registered = await ReplaySpool.register({ dataRoot, intent });
    const parent = join(dataRoot, registered.intentRelativePath, "..");
    await writeFile(join(parent, ".foreign.tmp"), "{}", { mode: 0o600, flag: "wx" });

    await expect(openForRecovery(dataRoot)).rejects.toEqual(
      new ReplaySpoolError("maintenance_required")
    );
  });

  it("recovers every immutable publication class at every crash boundary", async () => {
    const stages: readonly ReplaySpoolPublicationStage[] = [
      "temp-created",
      "file-synced",
      "temp-directory-synced",
      "canonical-linked",
      "canonical-directory-synced",
      "alias-unlinked",
      "alias-directory-synced"
    ];
    const publicationClasses = [
      "intent",
      "phase",
      "frame",
      "transcript",
      "cancel",
      "terminal"
    ] as const;

    for (const publicationClass of publicationClasses) {
      for (const stage of stages) {
        const dataRoot = await makeRoot();
        let crashArmed = publicationClass === "intent";
        let crashed = false;
        const targetSuffix =
          publicationClass === "intent"
            ? "/receipt/01-intent.json"
            : publicationClass === "phase"
              ? "/receipt/02-lease-transferred.json"
              : publicationClass === "frame"
                ? "/spool/events/000000000001.json"
                : publicationClass === "transcript"
                  ? "/spool/transcript/000000000001.bin"
                  : publicationClass === "cancel"
                    ? "/control/cancel.json"
                    : "/receipt/06-terminal.json";
        const publicationHook = (relativePath: string, current: ReplaySpoolPublicationStage) => {
          if (crashArmed && !crashed && relativePath.endsWith(targetSuffix) && current === stage) {
            crashed = true;
            throw new ReplaySpoolError("unsafe_state");
          }
        };
        const register = async () =>
          await ReplaySpool.register({ dataRoot, intent, publicationHook });

        if (publicationClass === "intent") {
          await expect(register()).rejects.toEqual(new ReplaySpoolError("unsafe_state"));
          crashArmed = false;
          const retried = await register();
          await expect(retried.spool.recover()).resolves.toMatchObject({ intent: retried.receipt });
          continue;
        }

        const { spool } = await register();
        if (publicationClass === "terminal") {
          for (const [index, phase] of [
            "lease_transferred",
            "spawned",
            "running",
            "finalizing"
          ].entries()) {
            await spool.recordPhase(phase as never, {
              recordedAt: `2026-08-21T12:00:0${index + 1}.000Z`,
              evidence: { safe: true }
            });
          }
        }
        crashArmed = true;
        const operation = async () => {
          if (publicationClass === "phase") {
            await spool.recordPhase("lease_transferred", {
              recordedAt: "2026-08-21T12:00:01.000Z",
              evidence: { safe: true }
            });
          } else if (publicationClass === "frame") {
            await spool.appendEvent({
              type: "command.started",
              workspaceId,
              runId,
              commandId,
              sequence: 1,
              occurredAt: "2026-08-21T12:00:01.000Z",
              pty: true
            });
          } else if (publicationClass === "transcript") {
            await spool.appendTranscriptChunk(Buffer.from("crash-safe transcript"));
          } else if (publicationClass === "cancel") {
            await spool.recordCancel({
              requestDigest: hex64("8"),
              decidedAt: "2026-08-21T12:00:01.000Z",
              cancelled: true
            });
          } else {
            await spool.recordPhase("terminal", {
              recordedAt: "2026-08-21T12:00:05.000Z",
              evidence: { safe: true }
            });
          }
        };

        await expect(operation()).rejects.toBeDefined();
        crashArmed = false;
        const recoveredSpool = await openForRecovery(dataRoot);
        let recovered = await recoveredSpool.recover();
        const present =
          publicationClass === "phase"
            ? recovered.phases.some((receipt) => receipt.phase === "lease_transferred")
            : publicationClass === "frame"
              ? recovered.events.length === 1
              : publicationClass === "transcript"
                ? recovered.transcriptChunks.length === 1
                : publicationClass === "cancel"
                  ? recovered.cancel !== undefined
                  : recovered.phases.at(-1)?.phase === "terminal";
        if (!present) {
          await operation();
          recovered = await spool.recover();
        }
        expect(crashed).toBe(true);
        expect(recovered.intent.commandId).toBe(commandId);
      }
    }
  }, 60_000);

  it("heals a complete maximum-class transcript publication alias", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    await spool.appendTranscriptChunk(Buffer.alloc(200_000, 0x61));
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const transcriptDirectory = join(dataRoot, "commands", component, "spool", "transcript");
    const canonical = join(transcriptDirectory, "000000000001.bin");
    const temporary = join(
      transcriptDirectory,
      `.000000000001.bin.${"2287d207f24a941ff3b56c04c8a25ad56b63e3023207b3bb5b4ac0c9869d74be"}.200000.00000000000000000000000000000014.tmp`
    );
    await link(canonical, temporary);
    await unlink(canonical);

    await expect(openForRecovery(dataRoot)).resolves.toBeInstanceOf(ReplaySpool);
    await expect(access(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never promotes a nonempty transcript temporary without complete content identity", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    await spool.appendTranscriptChunk(Buffer.from("complete transcript"));
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const directory = join(dataRoot, "commands", component, "spool", "transcript");
    await unlink(join(directory, "000000000001.bin"));
    await writeFile(
      join(directory, ".000000000001.bin.00000000000000000000000000000016.tmp"),
      "partial",
      { mode: 0o600, flag: "wx" }
    );

    await expect(openForRecovery(dataRoot)).rejects.toEqual(
      new ReplaySpoolError("maintenance_required")
    );
  });

  it("persists ordered phase receipts and immutable transcript segments", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });

    const firstChunk = await spool.appendTranscriptChunk(Buffer.from("first "));
    const secondChunk = await spool.appendTranscriptChunk(Buffer.from("second"));
    expect(firstChunk.previousChunkDigest).toBeNull();
    expect(secondChunk.previousChunkDigest).toBe(firstChunk.chunkDigest);
    expect(secondChunk.cumulativeByteSize).toBe(12);

    await spool.recordPhase("lease_transferred", {
      recordedAt: "2026-08-21T12:00:01.000Z",
      evidence: { handshakeDigest: hex64("8") }
    });
    await spool.recordPhase("spawned", {
      recordedAt: "2026-08-21T12:00:02.000Z",
      evidence: { launchEnvelopeDigest: hex64("9") }
    });

    const recovered = await spool.recover();
    expect(recovered.phases.map((phase) => phase.phase)).toEqual([
      "intent",
      "lease_transferred",
      "spawned"
    ]);
    expect(Buffer.concat(recovered.transcriptChunks.map((chunk) => chunk.bytes)).toString()).toBe(
      "first second"
    );
  });

  it("rejects skipped durable phases before publication", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });

    await expect(
      spool.recordPhase("running", {
        recordedAt: "2026-08-21T12:00:01.000Z",
        evidence: { startedFrameDigest: hex64("8") }
      })
    ).rejects.toEqual(new ReplaySpoolError("invalid_transition"));
  });

  it("durably claims one exact cancellation decision and replays it after restart", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });

    const claim = await spool.recordCancel({
      requestDigest: hex64("8"),
      decidedAt: "2026-08-21T12:00:01.000Z",
      cancelled: true
    });
    expect(claim).toMatchObject({ cancelled: true, replayed: false });
    const acknowledgement = await spool.recordCancelAck({
      claimDigest: claim.claimDigest,
      acknowledgedAt: "2026-08-21T12:00:02.000Z"
    });
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const acknowledgementPath = join(dataRoot, "commands", component, "control", "cancel-ack.json");
    const acknowledgementAlias = join(
      acknowledgementPath,
      "..",
      ".cancel-ack.json.00000000000000000000000000000015.tmp"
    );
    await link(acknowledgementPath, acknowledgementAlias);
    await unlink(acknowledgementPath);
    const reopened = await openForRecovery(dataRoot);
    expect((await reopened.recover()).cancelAck).toEqual(acknowledgement);
    await expect(access(acknowledgementAlias)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      reopened.recordCancelAck({
        claimDigest: claim.claimDigest,
        acknowledgedAt: "2026-08-21T12:00:08.000Z"
      })
    ).resolves.toEqual(acknowledgement);
    expect(
      await reopened.recordCancel({
        requestDigest: hex64("8"),
        decidedAt: "2026-08-21T12:00:09.000Z",
        cancelled: false
      })
    ).toMatchObject({
      requestDigest: hex64("8"),
      decidedAt: "2026-08-21T12:00:01.000Z",
      cancelled: true,
      replayed: true
    });
    await expect(
      reopened.recordCancel({
        requestDigest: hex64("9"),
        decidedAt: "2026-08-21T12:00:10.000Z",
        cancelled: true
      })
    ).rejects.toEqual(new ReplaySpoolError("command_conflict"));
  });

  it("admits cancellation claim inputs exactly once without accessors", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const claimPath = join(dataRoot, "commands", component, "control", "cancel.json");
    let claimReads = 0;
    const hostileClaim = Object.defineProperties(Object.create(null) as object, {
      requestDigest: {
        enumerable: true,
        get: () => {
          claimReads += 1;
          return claimReads === 1 ? hex64("8") : hex64("9");
        }
      },
      decidedAt: { enumerable: true, value: "2026-08-21T12:00:01.000Z" },
      cancelled: { enumerable: true, value: true }
    });
    await expect(spool.recordCancel(hostileClaim as never)).rejects.toEqual(
      new ReplaySpoolError("invalid_input")
    );
    expect(claimReads).toBe(0);
    await expect(access(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits cancellation acknowledgement inputs exactly once without accessors", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const claim = await spool.recordCancel({
      requestDigest: hex64("8"),
      decidedAt: "2026-08-21T12:00:02.000Z",
      cancelled: true
    });
    const ackPath = join(dataRoot, "commands", component, "control", "cancel-ack.json");
    let acknowledgementReads = 0;
    const hostileAcknowledgement = Object.defineProperties(Object.create(null) as object, {
      claimDigest: {
        enumerable: true,
        get: () => {
          acknowledgementReads += 1;
          return acknowledgementReads === 1 ? claim.claimDigest : hex64("9");
        }
      },
      acknowledgedAt: { enumerable: true, value: "2026-08-21T12:00:03.000Z" }
    });
    await expect(spool.recordCancelAck(hostileAcknowledgement as never)).rejects.toEqual(
      new ReplaySpoolError("invalid_input")
    );
    expect(acknowledgementReads).toBe(0);
    await expect(access(ackPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds cancellation claim and acknowledgement identities to the command receipt", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    await spool.recordCancel({
      requestDigest: hex64("8"),
      decidedAt: "2026-08-21T12:00:01.000Z",
      cancelled: true
    });
    const component = Buffer.from(commandId, "utf8").toString("hex");
    const claimPath = join(dataRoot, "commands", component, "control", "cancel.json");
    const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
    const reboundBase = {
      version: claim.version,
      kind: claim.kind,
      commandId: createId("command", "00000000-0000-4000-8000-000000000099"),
      requestDigest: claim.requestDigest,
      decidedAt: claim.decidedAt,
      cancelled: claim.cancelled
    };
    await unlink(claimPath);
    await writeFile(
      claimPath,
      canonicalJson({
        ...reboundBase,
        claimDigest: digestSpoolValue("autostack.command-cancel", reboundBase)
      }),
      { mode: 0o600, flag: "wx" }
    );

    await expect(spool.recover()).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
  });

  it("rejects malformed intent, event, phase, transcript, and cancel inputs statically", async () => {
    const dataRoot = await makeRoot();
    for (const malformed of [
      { ...intent, requestDigest: "not-a-digest" },
      { ...intent, executablePath: "relative/tool" },
      { ...intent, cwdRelativePath: "../escape" },
      { ...intent, limits: { ...intent.limits, eventBytes: 0 } },
      { ...intent, limits: { ...intent.limits, eventBytes: 4_095 } },
      { ...intent, limits: { ...intent.limits, replayBytes: 16_383 } }
    ]) {
      await expect(ReplaySpool.register({ dataRoot, intent: malformed as never })).rejects.toEqual(
        new ReplaySpoolError("invalid_input")
      );
    }
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    await expect(
      spool.appendEvent({
        type: "command.started",
        workspaceId,
        runId,
        commandId,
        sequence: 2,
        occurredAt: "2026-08-21T12:00:01.000Z",
        pty: true
      })
    ).rejects.toEqual(new ReplaySpoolError("invalid_transition"));
    await expect(
      spool.recordPhase("lease_transferred", {
        recordedAt: "not-a-time",
        evidence: { safe: true }
      })
    ).rejects.toEqual(new ReplaySpoolError("invalid_input"));
    await expect(spool.appendTranscriptChunk(Buffer.alloc(0))).rejects.toEqual(
      new ReplaySpoolError("invalid_input")
    );
    await expect(spool.appendTranscriptChunk(Buffer.alloc(1_048_577))).rejects.toEqual(
      new ReplaySpoolError("invalid_input")
    );
    await expect(spool.readEvent(0)).rejects.toEqual(new ReplaySpoolError("invalid_input"));
    await expect(
      spool.recordCancel({ requestDigest: "bad", decidedAt: "not-a-time", cancelled: true })
    ).rejects.toEqual(new ReplaySpoolError("invalid_input"));
  });

  it("fails recovery closed on an unknown control record", async () => {
    const dataRoot = await makeRoot();
    const { spool } = await ReplaySpool.register({ dataRoot, intent });
    const component = Buffer.from(commandId, "utf8").toString("hex");
    await writeFile(join(dataRoot, "commands", component, "control", "unknown.json"), "{}", {
      mode: 0o600
    });

    await expect(spool.recover()).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
  });

  it("fails recovery closed on unknown command-root and spool-root entries", async () => {
    for (const relative of ["foreign.bin", "spool/foreign"]) {
      const dataRoot = await makeRoot();
      const { spool } = await ReplaySpool.register({ dataRoot, intent });
      const component = Buffer.from(commandId, "utf8").toString("hex");
      await writeFile(join(dataRoot, "commands", component, relative), "foreign", {
        mode: 0o600,
        flag: "wx"
      });
      await expect(spool.recover()).rejects.toEqual(new ReplaySpoolError("maintenance_required"));
    }
  });
});
