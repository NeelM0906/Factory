import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  writeFile,
  realpath,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import type { CommandId } from "@autostack/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireCommandGuardianLease,
  acquireDataRootLock,
  DataRootLockError,
  guardianLeaseRelativePath,
  type CommandGuardianLease,
  type DataRootLock
} from "../src/data-root-lock.js";

const COMMAND_ID = "cmd_11111111-1111-4111-8111-111111111111" as CommandId;
const roots: string[] = [];
const locks: Array<DataRootLock | CommandGuardianLease> = [];
const children: ChildProcess[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "autostack-data-root-lock-"));
  roots.push(root);
  return join(root, "state");
};

const waitForLine = async (child: ChildProcess): Promise<string> => {
  if (child.stdout === null) throw new TypeError("Child stdout is unavailable.");
  const [chunk] = (await once(child.stdout, "data")) as [Buffer];
  return chunk.toString("utf8").trim();
};

const spawnSqliteOwner = (databasePath: string): ChildProcess => {
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.argv[1]);
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
    process.stdout.write("ready\\n");
    setInterval(() => {}, 60_000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, databasePath], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  return child;
};

const commandIdFor = (index: number): CommandId =>
  `cmd_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}` as CommandId;

type LeaseDatabaseKind = "root" | "guardian";

const establishLeaseDatabase = async (
  dataRoot: string,
  kind: LeaseDatabaseKind
): Promise<string> => {
  if (kind === "root") {
    const lock = await acquireDataRootLock(dataRoot);
    lock.close();
    return join(dataRoot, "locks", "data-root.sqlite3");
  }
  const guardian = await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
  guardian.close();
  return join(dataRoot, ...guardianLeaseRelativePath(COMMAND_ID).split("/"));
};

const reacquireLease = async (dataRoot: string, kind: LeaseDatabaseKind): Promise<void> => {
  const lease =
    kind === "root"
      ? await acquireDataRootLock(dataRoot)
      : await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
  locks.push(lease);
};

const createGate = (): { readonly promise: Promise<void>; readonly release: () => void } => {
  const state: { release?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  return {
    promise,
    release: () => {
      const release = state.release;
      if (release === undefined) throw new TypeError("Gate initialization is incomplete.");
      release();
    }
  };
};

afterEach(async () => {
  for (const lock of locks.splice(0)) lock.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("data-root ownership", () => {
  it("freezes emitted errors without exposing mutable code or message fields", async () => {
    const dataRoot = await temporaryRoot();
    const owner = await acquireDataRootLock(dataRoot);
    locks.push(owner);
    let captured: unknown;
    try {
      await acquireDataRootLock(dataRoot);
    } catch (error) {
      captured = error;
    }
    if (!(captured instanceof DataRootLockError)) {
      throw new TypeError("A data-root lock error was required.");
    }

    expect(Object.isFrozen(captured)).toBe(true);
    expect(Reflect.set(captured, "code", "unsafe_state")).toBe(false);
    expect(Reflect.set(captured, "message", "attacker-controlled")).toBe(false);
    expect(captured.code).toBe("root_busy");
    expect(captured.message).toBe("The AutoStack data root is busy.");
  });

  it("freezes root handles while private close state remains mutable and idempotent", async () => {
    const dataRoot = await temporaryRoot();
    const owner = await acquireDataRootLock(dataRoot);
    locks.push(owner);
    const canonicalRoot = owner.root;

    expect(Object.isFrozen(owner)).toBe(true);
    expect(Reflect.set(owner, "root", "/attacker-controlled")).toBe(false);
    expect(owner.root).toBe(canonicalRoot);
    owner.close();
    owner.close();
    const successor = await acquireDataRootLock(dataRoot);
    locks.push(successor);
  });

  it("holds one exclusive owner for the daemon lifetime and closes idempotently", async () => {
    const dataRoot = await temporaryRoot();
    const first = await acquireDataRootLock(dataRoot);
    locks.push(first);

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({
      name: "DataRootLockError",
      code: "root_busy",
      message: "The AutoStack data root is busy."
    });

    first.close();
    first.close();
    const successor = await acquireDataRootLock(dataRoot);
    locks.push(successor);
    expect(successor.root).toBe(await realpath(dataRoot));
  });

  it("creates a private canonical root and private lock database", async () => {
    const dataRoot = await temporaryRoot();
    const lock = await acquireDataRootLock(dataRoot);
    locks.push(lock);

    expect((await lstat(dataRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dataRoot, "locks"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dataRoot, "locks", "data-root.sqlite3"))).mode & 0o777).toBe(0o600);
  });

  it("normalizes an independently held SQLite transaction to root_busy", async () => {
    const dataRoot = await temporaryRoot();
    const initial = await acquireDataRootLock(dataRoot);
    initial.close();
    const database = new DatabaseSync(join(dataRoot, "locks", "data-root.sqlite3"));
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");

    try {
      await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({
        code: "root_busy",
        message: "The AutoStack data root is busy."
      });
    } finally {
      database.exec("ROLLBACK");
      database.close();
    }
  });

  it("relies on the OS to release ownership when a distinct process dies", async () => {
    const dataRoot = await temporaryRoot();
    const initial = await acquireDataRootLock(dataRoot);
    initial.close();
    const child = spawnSqliteOwner(join(dataRoot, "locks", "data-root.sqlite3"));
    expect(await waitForLine(child)).toBe("ready");
    const rollbackJournal = join(dataRoot, "locks", "data-root.sqlite3-journal");
    expect((await lstat(rollbackJournal)).size).toBeGreaterThanOrEqual(512);
    expect((await lstat(rollbackJournal)).size).toBeLessThanOrEqual(65_536);
    expect((await lstat(rollbackJournal)).mode & 0o777).toBe(0o600);

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({ code: "root_busy" });
    child.kill("SIGKILL");
    await once(child, "exit");

    const recovered = await acquireDataRootLock(dataRoot);
    locks.push(recovered);
    recovered.close();
    await expect(lstat(rollbackJournal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds command-journal enumeration and releases ownership on overflow", async () => {
    const dataRoot = await temporaryRoot();
    const initial = await acquireDataRootLock(dataRoot);
    initial.close();
    for (let offset = 0; offset <= 10_000; offset += 250) {
      const count = Math.min(250, 10_001 - offset);
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          mkdir(
            join(
              dataRoot,
              "commands",
              Buffer.from(commandIdFor(offset + index), "utf8").toString("hex")
            ),
            { mode: 0o700 }
          )
        )
      );
    }

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({
      code: "unsafe_state",
      message: "The AutoStack data root is unsafe."
    });
    const database = new DatabaseSync(join(dataRoot, "locks", "data-root.sqlite3"));
    database.exec("PRAGMA busy_timeout = 0");
    expect(() => database.exec("BEGIN EXCLUSIVE")).not.toThrow();
    database.exec("ROLLBACK");
    database.close();
  }, 30_000);

  it("fails closed with static diagnostics for an unsafe root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "autostack-data-root-unsafe-"));
    roots.push(parent);
    const actual = join(parent, "actual");
    const alias = join(parent, "alias");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, alias);

    await expect(acquireDataRootLock(alias)).rejects.toMatchObject({
      name: "DataRootLockError",
      code: "unsafe_state",
      message: "The AutoStack data root is unsafe."
    });
  });

  it("rejects permission drift on an existing root lock database", async () => {
    const dataRoot = await temporaryRoot();
    const initial = await acquireDataRootLock(dataRoot);
    initial.close();
    await chmod(join(dataRoot, "locks", "data-root.sqlite3"), 0o644);

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({
      code: "unsafe_state",
      message: "The AutoStack data root is unsafe."
    });
  });

  it("rejects content in the dedicated lock-only database", async () => {
    const dataRoot = await temporaryRoot();
    const initial = await acquireDataRootLock(dataRoot);
    initial.close();
    await writeFile(join(dataRoot, "locks", "data-root.sqlite3"), "not lock-only state", {
      mode: 0o600
    });

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({
      code: "unsafe_state",
      message: "The AutoStack data root is unsafe."
    });
  });

  it("rejects a valid SQLite schema in the dedicated lock-only database", async () => {
    const dataRoot = await temporaryRoot();
    const initial = await acquireDataRootLock(dataRoot);
    initial.close();
    const database = new DatabaseSync(join(dataRoot, "locks", "data-root.sqlite3"));
    database.exec("CREATE TABLE unexpected_state (value TEXT NOT NULL)");
    database.close();

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({
      code: "unsafe_state",
      message: "The AutoStack data root is unsafe."
    });
  });
});

describe("guardian lease preflight", () => {
  it("freezes guardian handles while private close state remains mutable and idempotent", async () => {
    const dataRoot = await temporaryRoot();
    const guardian = await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    locks.push(guardian);

    expect(Object.isFrozen(guardian)).toBe(true);
    expect(Reflect.set(guardian, "commandId", "cmd_22222222-2222-4222-8222-222222222222")).toBe(
      false
    );
    expect(guardian.commandId).toBe(COMMAND_ID);
    guardian.close();
    guardian.close();
    const successor = await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    locks.push(successor);
  });

  it("blocks root readiness while a guardian owns a command lease", async () => {
    const dataRoot = await temporaryRoot();
    const guardian = await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    locks.push(guardian);

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({
      name: "DataRootLockError",
      code: "root_busy",
      message: "The AutoStack data root is busy."
    });

    guardian.close();
    const root = await acquireDataRootLock(dataRoot);
    locks.push(root);
  });

  it("accepts the root after an out-of-process guardian terminalizes", async () => {
    const dataRoot = await temporaryRoot();
    const initialGuardian = await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    initialGuardian.close();
    const child = spawnSqliteOwner(
      join(dataRoot, ...guardianLeaseRelativePath(COMMAND_ID).split("/"))
    );
    expect(await waitForLine(child)).toBe("ready");
    const rollbackJournal = `${join(
      dataRoot,
      ...guardianLeaseRelativePath(COMMAND_ID).split("/")
    )}-journal`;
    expect((await lstat(rollbackJournal)).size).toBeGreaterThanOrEqual(512);
    expect((await lstat(rollbackJournal)).size).toBeLessThanOrEqual(65_536);
    expect((await lstat(rollbackJournal)).mode & 0o777).toBe(0o600);

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({ code: "root_busy" });
    child.kill("SIGKILL");
    await once(child, "exit");

    const root = await acquireDataRootLock(dataRoot);
    locks.push(root);
    await expect(lstat(rollbackJournal)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases root ownership when guardian preflight fails", async () => {
    const dataRoot = await temporaryRoot();
    const guardian = await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    locks.push(guardian);
    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({ code: "root_busy" });

    const rootDatabase = new DatabaseSync(join(dataRoot, "locks", "data-root.sqlite3"));
    rootDatabase.exec("PRAGMA busy_timeout = 0");
    expect(() => rootDatabase.exec("BEGIN EXCLUSIVE")).not.toThrow();
    rootDatabase.exec("ROLLBACK");
    rootDatabase.close();
  });

  it("validates command identities before creating lease state", async () => {
    const dataRoot = await temporaryRoot();

    await expect(
      acquireCommandGuardianLease(dataRoot, "../outside" as CommandId)
    ).rejects.toMatchObject({
      code: "unsafe_state",
      message: "The AutoStack data root is unsafe."
    });
    await expect(lstat(join(dataRoot, "commands"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves command ID bytes so mixed-case IDs can hold distinct leases", async () => {
    const dataRoot = await temporaryRoot();
    const lowerGuardian = await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    const mixedCase = COMMAND_ID.toUpperCase() as CommandId;
    const upperGuardian = await acquireCommandGuardianLease(dataRoot, mixedCase);
    locks.push(lowerGuardian, upperGuardian);

    expect((await readdir(join(dataRoot, "commands"))).sort()).toEqual(
      [COMMAND_ID, mixedCase].map((value) => Buffer.from(value, "utf8").toString("hex")).sort()
    );
    expect(guardianLeaseRelativePath(mixedCase)).not.toBe(guardianLeaseRelativePath(COMMAND_ID));
    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({ code: "root_busy" });
    lowerGuardian.close();
    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({ code: "root_busy" });
    upperGuardian.close();
    const root = await acquireDataRootLock(dataRoot);
    locks.push(root);
  });

  it.each([
    Buffer.from(COMMAND_ID, "utf8").toString("hex").toUpperCase(),
    "not-hex",
    Buffer.from("not-a-command-id", "utf8").toString("hex")
  ])("rejects malformed or non-canonical command journal name %s", async (journalName) => {
    const dataRoot = await temporaryRoot();
    const initial = await acquireDataRootLock(dataRoot);
    initial.close();
    await mkdir(join(dataRoot, "commands", journalName), { mode: 0o700 });

    await expect(acquireDataRootLock(dataRoot)).rejects.toMatchObject({
      code: "unsafe_state",
      message: "The AutoStack data root is unsafe."
    });
  });
});

describe.each(["root", "guardian"] as const)("%s SQLite sidecar admission", (kind) => {
  it.each(["-wal", "-shm"])("rejects any %s sidecar", async (suffix) => {
    const dataRoot = await temporaryRoot();
    const databasePath = await establishLeaseDatabase(dataRoot, kind);
    await writeFile(`${databasePath}${suffix}`, "unexpected", { mode: 0o600 });

    await expect(reacquireLease(dataRoot, kind)).rejects.toMatchObject({
      code: "unsafe_state",
      message: "The AutoStack data root is unsafe."
    });
  });

  it("rejects a symlinked rollback journal", async () => {
    const dataRoot = await temporaryRoot();
    const databasePath = await establishLeaseDatabase(dataRoot, kind);
    const outside = join(await temporaryRoot(), "outside-journal");
    await mkdir(join(outside, ".."), { recursive: true });
    await writeFile(outside, Buffer.alloc(512), { mode: 0o600 });
    await symlink(outside, `${databasePath}-journal`);

    await expect(reacquireLease(dataRoot, kind)).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("rejects a hard-linked rollback journal", async () => {
    const dataRoot = await temporaryRoot();
    const databasePath = await establishLeaseDatabase(dataRoot, kind);
    const outside = join(await temporaryRoot(), "outside-journal");
    await mkdir(join(outside, ".."), { recursive: true });
    await writeFile(outside, Buffer.alloc(512), { mode: 0o600 });
    await link(outside, `${databasePath}-journal`);

    await expect(reacquireLease(dataRoot, kind)).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("rejects rollback-journal permission drift", async () => {
    const dataRoot = await temporaryRoot();
    const databasePath = await establishLeaseDatabase(dataRoot, kind);
    await writeFile(`${databasePath}-journal`, Buffer.alloc(512), { mode: 0o644 });

    await expect(reacquireLease(dataRoot, kind)).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("rejects an oversized rollback journal", async () => {
    const dataRoot = await temporaryRoot();
    const databasePath = await establishLeaseDatabase(dataRoot, kind);
    await writeFile(`${databasePath}-journal`, Buffer.alloc(65_537), { mode: 0o600 });

    await expect(reacquireLease(dataRoot, kind)).rejects.toMatchObject({ code: "unsafe_state" });
  });

  it("rejects rollback-journal content outside the lock-only policy", async () => {
    const dataRoot = await temporaryRoot();
    const databasePath = await establishLeaseDatabase(dataRoot, kind);
    await writeFile(`${databasePath}-journal`, Buffer.alloc(512, 0x41), { mode: 0o600 });

    await expect(reacquireLease(dataRoot, kind)).rejects.toMatchObject({ code: "unsafe_state" });
  });
});

describe.each(["root", "guardian"] as const)("%s SQLite snapshot races", (kind) => {
  it("classifies a valid journal appearing after recovery as bounded contention", async () => {
    const dataRoot = await temporaryRoot();
    await establishLeaseDatabase(dataRoot, kind);
    const recovered = createGate();
    const continuePostcheck = createGate();
    let hookCallCount = 0;
    const contender =
      kind === "root"
        ? acquireDataRootLock(dataRoot, {
            afterRecoveryReadBeforePostcheck: async () => {
              hookCallCount += 1;
              if (hookCallCount !== 1) return;
              recovered.release();
              await continuePostcheck.promise;
            }
          })
        : acquireCommandGuardianLease(dataRoot, COMMAND_ID, {
            afterRecoveryReadBeforePostcheck: async () => {
              hookCallCount += 1;
              if (hookCallCount !== 1) return;
              recovered.release();
              await continuePostcheck.promise;
            }
          });
    await recovered.promise;
    const owner =
      kind === "root"
        ? await acquireDataRootLock(dataRoot)
        : await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    locks.push(owner);
    continuePostcheck.release();

    await expect(contender).rejects.toMatchObject({ code: "root_busy" });
    expect(hookCallCount).toBe(1);
    owner.close();
    await reacquireLease(dataRoot, kind);
  });

  it("restarts when an observed valid journal disappears before SQLite open", async () => {
    const dataRoot = await temporaryRoot();
    const owner =
      kind === "root"
        ? await acquireDataRootLock(dataRoot)
        : await acquireCommandGuardianLease(dataRoot, COMMAND_ID);
    locks.push(owner);
    const snapshotted = createGate();
    const continueOpen = createGate();
    let hookCallCount = 0;
    const contender =
      kind === "root"
        ? acquireDataRootLock(dataRoot, {
            afterSidecarSnapshotBeforeOpen: async () => {
              hookCallCount += 1;
              if (hookCallCount !== 1) return;
              snapshotted.release();
              await continueOpen.promise;
            }
          })
        : acquireCommandGuardianLease(dataRoot, COMMAND_ID, {
            afterSidecarSnapshotBeforeOpen: async () => {
              hookCallCount += 1;
              if (hookCallCount !== 1) return;
              snapshotted.release();
              await continueOpen.promise;
            }
          });
    await snapshotted.promise;
    owner.close();
    continueOpen.release();

    const successor = await contender;
    locks.push(successor);
    expect(hookCallCount).toBe(2);
  });
});
