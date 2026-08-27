import { lstatSync, type Stats } from "node:fs";
import { opendir, lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CommandIdSchema, type CommandId } from "@autostack/contracts";

import { DataPathPolicy } from "./path-policy.js";
import {
  assertPrivateDirectory,
  assertPrivateFile,
  identityOf,
  isWithin,
  privateOpenFlags,
  sameIdentityExceptLinkCount,
  samePinnedIdentity,
  type PathIdentity
} from "./path-security.js";

const ROOT_LOCK_RELATIVE_PATH = "locks/data-root.sqlite3";
const COMMAND_JOURNAL_DIRECTORY = "commands";
const GUARDIAN_LEASE_FILE_NAME = "guardian-lease.sqlite3";
const MAXIMUM_COMMAND_JOURNAL_COUNT = 10_000;
const MINIMUM_ROLLBACK_JOURNAL_BYTES = 512;
const MAXIMUM_ROLLBACK_JOURNAL_BYTES = 65_536;
const MAXIMUM_SIDECAR_SNAPSHOT_ATTEMPTS = 4;
const RETRY_SIDECAR_SNAPSHOT = Symbol("retry-sidecar-snapshot");

export type DataRootLockErrorCode = "root_busy" | "unsafe_state";

export interface DataRootLockHooks {
  readonly afterRecoveryReadBeforePostcheck?: () => Promise<void> | void;
  readonly afterSidecarSnapshotBeforeOpen?: () => Promise<void> | void;
  readonly afterSidecarValidationBeforeOpen?: () => Promise<void> | void;
}

const ERROR_MESSAGES: Readonly<Record<DataRootLockErrorCode, string>> = Object.freeze({
  root_busy: "The AutoStack data root is busy.",
  unsafe_state: "The AutoStack data root is unsafe."
});

const ownedErrors = new WeakSet<object>();

export class DataRootLockError extends Error {
  readonly code: DataRootLockErrorCode;

  constructor(code: DataRootLockErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "DataRootLockError";
    this.code = code;
    Object.freeze(this);
  }
}

class OwnedDataRootLockError extends DataRootLockError {
  constructor(code: DataRootLockErrorCode) {
    super(code);
    ownedErrors.add(this);
  }
}

const failure = (code: DataRootLockErrorCode): DataRootLockError =>
  new OwnedDataRootLockError(code);

const isOwnedError = (value: unknown): value is DataRootLockError =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  ownedErrors.has(value);

const normalizeFailure = (error: unknown): DataRootLockError =>
  failure(isOwnedError(error) ? error.code : "unsafe_state");

const snapshotHooks = (hooks: DataRootLockHooks): Readonly<DataRootLockHooks> => {
  const afterRecoveryReadBeforePostcheck = hooks.afterRecoveryReadBeforePostcheck;
  const afterSidecarSnapshotBeforeOpen = hooks.afterSidecarSnapshotBeforeOpen;
  const afterSidecarValidationBeforeOpen = hooks.afterSidecarValidationBeforeOpen;
  if (
    (afterRecoveryReadBeforePostcheck !== undefined &&
      typeof afterRecoveryReadBeforePostcheck !== "function") ||
    (afterSidecarSnapshotBeforeOpen !== undefined &&
      typeof afterSidecarSnapshotBeforeOpen !== "function") ||
    (afterSidecarValidationBeforeOpen !== undefined &&
      typeof afterSidecarValidationBeforeOpen !== "function")
  ) {
    throw failure("unsafe_state");
  }
  return Object.freeze({
    ...(afterRecoveryReadBeforePostcheck === undefined ? {} : { afterRecoveryReadBeforePostcheck }),
    ...(afterSidecarSnapshotBeforeOpen === undefined ? {} : { afterSidecarSnapshotBeforeOpen }),
    ...(afterSidecarValidationBeforeOpen === undefined ? {} : { afterSidecarValidationBeforeOpen })
  });
};

const NO_HOOKS: Readonly<DataRootLockHooks> = Object.freeze({});

const isSqliteBusy = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "errcode");
  return descriptor?.value === 5 || descriptor?.value === 6;
};

const beginExclusive = (connection: DatabaseSync): void => {
  connection.exec("PRAGMA busy_timeout = 0");
  connection.exec("BEGIN EXCLUSIVE");
};

const closeConnection = (connection: DatabaseSync, transactionOpen: boolean): void => {
  let rollbackError: unknown;
  if (transactionOpen) {
    try {
      connection.exec("ROLLBACK");
    } catch (error) {
      rollbackError = error;
    }
  }
  try {
    connection.close();
  } catch (error) {
    rollbackError ??= error;
  }
  if (rollbackError !== undefined) throw failure("unsafe_state");
};

const encodeCommandJournalName = (commandIdInput: unknown): string => {
  if (typeof commandIdInput !== "string") throw failure("unsafe_state");
  const parsed = CommandIdSchema.safeParse(commandIdInput);
  if (!parsed.success) throw failure("unsafe_state");
  return Buffer.from(parsed.data, "utf8").toString("hex");
};

const decodeCommandJournalName = (journalName: string): CommandId => {
  if (!/^[0-9a-f]+$/.test(journalName) || journalName.length % 2 !== 0) {
    throw failure("unsafe_state");
  }
  const decoded = Buffer.from(journalName, "hex").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("hex") !== journalName) {
    throw failure("unsafe_state");
  }
  const parsed = CommandIdSchema.safeParse(decoded);
  if (!parsed.success || encodeCommandJournalName(parsed.data) !== journalName) {
    throw failure("unsafe_state");
  }
  return parsed.data;
};

/** Returns the one portable path that preserves the exact schema-valid command ID bytes. */
export const guardianLeaseRelativePath = (commandId: CommandId): string =>
  `${COMMAND_JOURNAL_DIRECTORY}/${encodeCommandJournalName(commandId)}/${GUARDIAN_LEASE_FILE_NAME}`;

interface PrivateSqliteFile {
  readonly absolutePath: string;
  readonly identity: PathIdentity;
  readonly relativePath: string;
}

interface RollbackJournalSnapshot {
  readonly identity: PathIdentity;
  readonly size: number;
}

interface SqliteSidecarSnapshot {
  readonly rollbackJournal?: RollbackJournalSnapshot;
}

const absolutePathFor = (policy: DataPathPolicy, relativePath: string): string => {
  const absolutePath = resolve(policy.root, ...relativePath.split("/"));
  if (!isWithin(policy.root, absolutePath)) throw failure("unsafe_state");
  return absolutePath;
};

const openExistingPrivateSqliteFile = async (
  policy: DataPathPolicy,
  relativePath: string
): Promise<PrivateSqliteFile> => {
  const handle = await policy.openFile(relativePath, "r");
  try {
    const status = await handle.stat();
    assertPrivateFile(status);
    if (status.size !== 0) throw failure("unsafe_state");
    return {
      absolutePath: absolutePathFor(policy, relativePath),
      identity: identityOf(status),
      relativePath
    };
  } finally {
    await handle.close();
  }
};

const ensurePrivateSqliteFile = async (
  policy: DataPathPolicy,
  relativePath: string
): Promise<PrivateSqliteFile> => {
  if (!(await policy.fileExists(relativePath))) {
    try {
      const created = await policy.openFile(relativePath, "wx");
      try {
        await created.sync();
      } finally {
        await created.close();
      }
    } catch {
      // A concurrent valid creator may win. The trusted read below proves that outcome.
    }
  }
  return openExistingPrivateSqliteFile(policy, relativePath);
};

const assertMainFileUnchanged = (file: PrivateSqliteFile): void => {
  const status = lstatSync(file.absolutePath);
  assertPrivateFile(status);
  if (status.size !== 0 || !samePinnedIdentity(file.identity, identityOf(status))) {
    throw failure("unsafe_state");
  }
};

const isLockOnlyRollbackJournal = (content: Buffer): boolean => {
  if (
    content.byteLength < MINIMUM_ROLLBACK_JOURNAL_BYTES ||
    content.byteLength > MAXIMUM_ROLLBACK_JOURNAL_BYTES
  ) {
    return false;
  }
  for (let index = 0; index < 12; index += 1) {
    if (content[index] !== 0) return false;
  }
  for (let index = 16; index < 20; index += 1) {
    if (content[index] !== 0) return false;
  }
  const sectorSize = content.readUInt32BE(20);
  if (
    sectorSize !== content.byteLength ||
    sectorSize < MINIMUM_ROLLBACK_JOURNAL_BYTES ||
    sectorSize > MAXIMUM_ROLLBACK_JOURNAL_BYTES ||
    (sectorSize & (sectorSize - 1)) !== 0
  ) {
    return false;
  }
  const encodedPageSize = content.readUInt32BE(24);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) return false;
  for (let index = 28; index < content.byteLength; index += 1) {
    if (content[index] !== 0) return false;
  }
  return true;
};

const inspectRollbackJournal = async (
  file: PrivateSqliteFile
): Promise<RollbackJournalSnapshot | undefined> => {
  const absolutePath = `${file.absolutePath}-journal`;
  const pathBefore = lstatIfPresent(absolutePath);
  if (pathBefore === undefined) return undefined;
  assertPrivateFile(pathBefore);
  if (
    pathBefore.size < MINIMUM_ROLLBACK_JOURNAL_BYTES ||
    pathBefore.size > MAXIMUM_ROLLBACK_JOURNAL_BYTES
  ) {
    throw failure("unsafe_state");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolutePath, privateOpenFlags("r"));
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") throw RETRY_SIDECAR_SNAPSHOT;
    throw failure("unsafe_state");
  }
  try {
    const before = await handle.stat();
    assertPrivateFile(before);
    if (
      before.size < MINIMUM_ROLLBACK_JOURNAL_BYTES ||
      before.size > MAXIMUM_ROLLBACK_JOURNAL_BYTES
    ) {
      throw failure("unsafe_state");
    }
    if (!samePinnedIdentity(identityOf(pathBefore), identityOf(before))) {
      throw RETRY_SIDECAR_SNAPSHOT;
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset);
      if (bytesRead === 0) throw failure("unsafe_state");
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    if ((await handle.read(overflow, 0, 1, content.byteLength)).bytesRead !== 0) {
      throw failure("unsafe_state");
    }
    const after = await handle.stat();
    assertPrivateFile(after);
    const pathStatus = lstatIfPresent(absolutePath);
    if (pathStatus === undefined) throw RETRY_SIDECAR_SNAPSHOT;
    assertPrivateFile(pathStatus);
    if (
      after.size !== before.size ||
      !samePinnedIdentity(identityOf(before), identityOf(after)) ||
      !isLockOnlyRollbackJournal(content)
    ) {
      throw failure("unsafe_state");
    }
    if (!samePinnedIdentity(identityOf(after), identityOf(pathStatus))) {
      throw RETRY_SIDECAR_SNAPSHOT;
    }
    return Object.freeze({ identity: identityOf(after), size: after.size });
  } finally {
    await handle.close();
  }
};

const inspectSqliteSidecarsBeforeOpen = async (
  policy: DataPathPolicy,
  file: PrivateSqliteFile
): Promise<SqliteSidecarSnapshot> => {
  for (const suffix of ["-wal", "-shm"] as const) {
    if (await policy.fileExists(`${file.relativePath}${suffix}`)) throw failure("unsafe_state");
  }
  const rollbackJournal = await inspectRollbackJournal(file);
  assertMainFileUnchanged(file);
  if (rollbackJournal === undefined) return Object.freeze({});
  return Object.freeze({ rollbackJournal });
};

const lstatIfPresent = (absolutePath: string): Stats | undefined => {
  try {
    return lstatSync(absolutePath);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT") return undefined;
    throw failure("unsafe_state");
  }
};

const nodeErrorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null
    ? Object.getOwnPropertyDescriptor(error, "code")?.value
    : undefined;

const assertForbiddenSidecarsAbsent = (file: PrivateSqliteFile): void => {
  for (const suffix of ["-wal", "-shm"] as const) {
    if (lstatIfPresent(`${file.absolutePath}${suffix}`) !== undefined) {
      throw failure("unsafe_state");
    }
  }
};

const assertSnapshotStillCurrent = (
  file: PrivateSqliteFile,
  snapshot: SqliteSidecarSnapshot
): void => {
  assertForbiddenSidecarsAbsent(file);
  const current = lstatIfPresent(`${file.absolutePath}-journal`);
  const expected = snapshot.rollbackJournal;
  if (expected === undefined) {
    if (current === undefined) return;
    assertPrivateFile(current);
    if (
      current.size < MINIMUM_ROLLBACK_JOURNAL_BYTES ||
      current.size > MAXIMUM_ROLLBACK_JOURNAL_BYTES
    ) {
      throw failure("unsafe_state");
    }
    throw RETRY_SIDECAR_SNAPSHOT;
  }
  if (current === undefined) throw RETRY_SIDECAR_SNAPSHOT;
  assertPrivateFile(current);
  if (
    current.size !== expected.size ||
    !samePinnedIdentity(expected.identity, identityOf(current))
  ) {
    throw RETRY_SIDECAR_SNAPSHOT;
  }
};

const recoverRetainedRollbackJournal = async (
  connection: DatabaseSync,
  policy: DataPathPolicy,
  file: PrivateSqliteFile,
  snapshot: SqliteSidecarSnapshot
): Promise<void> => {
  assertForbiddenSidecarsAbsent(file);
  const retained = await inspectRollbackJournal(file);
  if (retained === undefined) return;
  const expected = snapshot.rollbackJournal;
  if (
    expected === undefined ||
    retained.size !== expected.size ||
    !samePinnedIdentity(expected.identity, retained.identity)
  ) {
    throw RETRY_SIDECAR_SNAPSHOT;
  }

  let transactionOpen = false;
  try {
    connection.exec("PRAGMA locking_mode = EXCLUSIVE");
    beginExclusive(connection);
    transactionOpen = true;
    const exclusivelyOwnedJournal = await inspectRollbackJournal(file);
    const current = lstatIfPresent(`${file.absolutePath}-journal`);
    if (
      exclusivelyOwnedJournal === undefined ||
      current === undefined ||
      !samePinnedIdentity(exclusivelyOwnedJournal.identity, identityOf(current)) ||
      !(await policy.unlinkFile(`${file.relativePath}-journal`, false))
    ) {
      throw RETRY_SIDECAR_SNAPSHOT;
    }
    connection.exec("ROLLBACK");
    transactionOpen = false;
  } catch (error) {
    if (isSqliteBusy(error)) throw failure("root_busy");
    throw error;
  } finally {
    if (transactionOpen) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        throw failure("unsafe_state");
      }
    }
  }
  assertMainFileUnchanged(file);
  assertForbiddenSidecarsAbsent(file);
  if (lstatIfPresent(`${file.absolutePath}-journal`) !== undefined) {
    throw RETRY_SIDECAR_SNAPSHOT;
  }
};

const openVerifiedConnection = async (
  policy: DataPathPolicy,
  file: PrivateSqliteFile,
  hooks: Readonly<DataRootLockHooks>
): Promise<DatabaseSync> => {
  for (let attempt = 0; attempt < MAXIMUM_SIDECAR_SNAPSHOT_ATTEMPTS; attempt += 1) {
    let connection: DatabaseSync | undefined;
    try {
      const attemptPolicy = attempt === 0 ? policy : await DataPathPolicy.create(policy.root);
      const snapshot = await inspectSqliteSidecarsBeforeOpen(attemptPolicy, file);
      await hooks.afterSidecarSnapshotBeforeOpen?.();
      assertSnapshotStillCurrent(file, snapshot);
      await hooks.afterSidecarValidationBeforeOpen?.();
      connection = new DatabaseSync(file.absolutePath);
      try {
        connection.prepare("PRAGMA schema_version").get();
      } catch (error) {
        if (isSqliteBusy(error)) throw failure("root_busy");
        throw error;
      }
      await hooks.afterRecoveryReadBeforePostcheck?.();
      assertMainFileUnchanged(file);
      await recoverRetainedRollbackJournal(connection, attemptPolicy, file, snapshot);
      return connection;
    } catch (error) {
      let closeFailed = false;
      if (connection !== undefined) {
        try {
          connection.close();
        } catch {
          closeFailed = true;
        }
      }
      if (closeFailed) throw failure("unsafe_state");
      if (error === RETRY_SIDECAR_SNAPSHOT) {
        if (attempt + 1 === MAXIMUM_SIDECAR_SNAPSHOT_ATTEMPTS) {
          throw failure("root_busy");
        }
        continue;
      }
      throw error;
    }
  }
  throw failure("root_busy");
};

const probeGuardianLease = async (policy: DataPathPolicy, commandId: CommandId): Promise<void> => {
  const relativePath = guardianLeaseRelativePath(commandId);
  if (!(await policy.fileExists(relativePath))) return;
  const file = await openExistingPrivateSqliteFile(policy, relativePath);
  const connection = await openVerifiedConnection(policy, file, NO_HOOKS);
  let transactionOpen = false;
  try {
    try {
      beginExclusive(connection);
      transactionOpen = true;
    } catch (error) {
      if (isSqliteBusy(error)) throw failure("root_busy");
      throw error;
    }
  } finally {
    closeConnection(connection, transactionOpen);
  }
};

const scanGuardianLeases = async (policy: DataPathPolicy): Promise<void> => {
  const commandDirectory = await policy.ensureDirectory(COMMAND_JOURNAL_DIRECTORY);
  const directoryBefore = await lstat(commandDirectory);
  assertPrivateDirectory(directoryBefore);
  const identityBefore = identityOf(directoryBefore);
  if ((await realpath(commandDirectory)) !== commandDirectory) throw failure("unsafe_state");

  const directory = await opendir(commandDirectory);
  let count = 0;
  try {
    for await (const entry of directory) {
      count += 1;
      if (count > MAXIMUM_COMMAND_JOURNAL_COUNT || !entry.isDirectory()) {
        throw failure("unsafe_state");
      }
      const commandId = decodeCommandJournalName(entry.name);
      const journalPath = resolve(commandDirectory, entry.name);
      if (!isWithin(commandDirectory, journalPath)) throw failure("unsafe_state");
      const before = await lstat(journalPath);
      assertPrivateDirectory(before);
      const journalIdentity = identityOf(before);
      if ((await realpath(journalPath)) !== journalPath) throw failure("unsafe_state");
      await probeGuardianLease(policy, commandId);
      const after = await lstat(journalPath);
      assertPrivateDirectory(after);
      // SQLite may remove its own hot rollback journal while proving a crashed
      // guardian's lease is acquirable. On APFS that can change directory nlink.
      if (!sameIdentityExceptLinkCount(journalIdentity, identityOf(after))) {
        throw failure("unsafe_state");
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  const directoryAfter = await lstat(commandDirectory);
  assertPrivateDirectory(directoryAfter);
  // Strict here, unlike the per-journal re-check above, and deliberately so. The scan runs
  // inside the root lock's BEGIN EXCLUSIVE transaction (acquireDataRootLock opens it before
  // calling this), and every producer of a `commands/<id>` entry is downstream of a root lock
  // that was successfully held: WorktreeManager.create is the only caller of
  // acquireDataRootLock, and the CommandRegistry recovery and CommandGuardian paths that call
  // acquireCommandGuardianLease only exist once that manager has been constructed. A competing
  // host is turned away with root_busy before it can reach them.
  //
  // The one caller that is NOT literally downstream of a manager is the spawned guardian child
  // (command-guardian-child-runtime.ts:234), which acquires its own lease from its own process.
  // It is still safe, because it never adds a `commands/` entry: on the host side
  // CommandGuardian.start acquires the lease at command-guardian.ts:127-132 -- creating
  // `commands/<id>` -- strictly before authorizeAndSpawnGuardian at :135, so by the time the
  // child acquires, that directory already exists. An orphaned child from a crashed host is
  // likewise pre-existing, and this scan's own probe finds its lease busy and reports root_busy.
  //
  // Nothing this scan does moves this directory's link count either -- SQLite's sidecars land one
  // level down, inside `commands/<id>`, which is why only that inner check tolerates drift. So
  // any entry count change observed across this window is unaccounted for, and it is the only
  // signal that catches an entry appearing after the directory stream above was snapshotted.
  //
  // This strictness DEPENDS on the call-graph facts above staying true; it is not self-evident
  // from the types. acquireCommandGuardianLease is exported and takes a raw dataRoot string, so
  // nothing stops a future caller from acquiring a lease outside a WorktreeManager. Such a caller
  // would create a `commands/<id>` entry concurrently with this scan and surface as an
  // intermittent unsafe_state at daemon startup. Re-derive this before adding one, or bind the
  // lease API to a held lock handle.
  if (!samePinnedIdentity(identityBefore, identityOf(directoryAfter)))
    throw failure("unsafe_state");
};

export class DataRootLock {
  readonly root: string;
  #connection: DatabaseSync | undefined;

  protected constructor(root: string, connection: DatabaseSync) {
    this.root = root;
    this.#connection = connection;
    Object.freeze(this);
  }

  close(): void {
    const connection = this.#connection;
    if (connection === undefined) return;
    this.#connection = undefined;
    closeConnection(connection, true);
  }
}

class OwnedDataRootLock extends DataRootLock {
  constructor(root: string, connection: DatabaseSync) {
    super(root, connection);
  }
}

interface CommandGuardianLeaseState {
  readonly admittedRoot: string;
  readonly root: string;
  readonly rootIdentity: PathIdentity;
  readonly commandId: CommandId;
  readonly commandDirectoryIdentity: PathIdentity;
  readonly leaseFileIdentity: PathIdentity;
  readonly connection: DatabaseSync;
  active: boolean;
}

const commandGuardianLeaseStates = new WeakMap<CommandGuardianLease, CommandGuardianLeaseState>();

export class CommandGuardianLease {
  readonly commandId: CommandId;

  protected constructor(commandId: CommandId) {
    this.commandId = commandId;
    Object.freeze(this);
  }

  close(): void {
    const state = commandGuardianLeaseStates.get(this);
    if (state === undefined) throw failure("unsafe_state");
    if (!state.active) return;
    state.active = false;
    closeConnection(state.connection, true);
  }
}

class OwnedCommandGuardianLease extends CommandGuardianLease {
  constructor(commandId: CommandId) {
    super(commandId);
  }
}

/** Package-internal capability check for an exact, currently owned guardian lease. */
export function assertLiveCommandGuardianLease(
  candidate: unknown,
  canonicalRoot: string,
  commandId: CommandId
): asserts candidate is CommandGuardianLease {
  const state =
    (typeof candidate === "object" && candidate !== null) || typeof candidate === "function"
      ? commandGuardianLeaseStates.get(candidate as CommandGuardianLease)
      : undefined;
  if (
    state === undefined ||
    !state.active ||
    (state.root !== canonicalRoot && state.admittedRoot !== resolve(canonicalRoot)) ||
    state.commandId !== commandId
  ) {
    throw failure("unsafe_state");
  }
}

/** Package-internal namespace proof for a live lease and its exact recovery paths. */
export const assertCommandGuardianLeaseFilesystemIdentity = async (
  candidate: unknown,
  policy: DataPathPolicy,
  commandId: CommandId
): Promise<void> => {
  assertLiveCommandGuardianLease(candidate, policy.root, commandId);
  const state = commandGuardianLeaseStates.get(candidate);
  if (state === undefined) throw failure("unsafe_state");
  try {
    const leasePath = absolutePathFor(policy, guardianLeaseRelativePath(commandId));
    const rootStatus = await lstat(policy.root);
    const commandDirectoryStatus = await lstat(dirname(leasePath));
    const leaseFileStatus = await lstat(leasePath);
    assertPrivateDirectory(rootStatus);
    assertPrivateDirectory(commandDirectoryStatus);
    assertPrivateFile(leaseFileStatus);
    if (
      !sameIdentityExceptLinkCount(state.rootIdentity, identityOf(rootStatus)) ||
      // The lease database lives directly in this directory, so SQLite's own sidecars
      // (hot rollback journal, WAL) appear and disappear inside it for the whole life of
      // the lease. On APFS those file entries move the directory's link count -- the same
      // rationale recorded at the journal re-check above (see line 519). Identity itself
      // stays pinned by dev/ino/uid/mode, and the lease file below keeps its exact
      // single-link hard-link proof.
      !sameIdentityExceptLinkCount(
        state.commandDirectoryIdentity,
        identityOf(commandDirectoryStatus)
      ) ||
      !samePinnedIdentity(state.leaseFileIdentity, identityOf(leaseFileStatus))
    ) {
      throw new TypeError();
    }
    assertLiveCommandGuardianLease(candidate, policy.root, commandId);
  } catch {
    throw failure("unsafe_state");
  }
};

export const acquireDataRootLock = async (
  dataRoot: string,
  hooks: DataRootLockHooks = {}
): Promise<DataRootLock> => {
  let connection: DatabaseSync | undefined;
  let transactionOpen = false;
  try {
    const admittedHooks = snapshotHooks(hooks);
    const policy = await DataPathPolicy.create(dataRoot);
    const file = await ensurePrivateSqliteFile(policy, ROOT_LOCK_RELATIVE_PATH);
    connection = await openVerifiedConnection(policy, file, admittedHooks);
    try {
      beginExclusive(connection);
      transactionOpen = true;
    } catch (error) {
      if (isSqliteBusy(error)) throw failure("root_busy");
      throw error;
    }
    await scanGuardianLeases(policy);
    const lock = new OwnedDataRootLock(policy.root, connection);
    connection = undefined;
    transactionOpen = false;
    return lock;
  } catch (error) {
    if (connection !== undefined) {
      try {
        closeConnection(connection, transactionOpen);
      } catch {
        // Preserve the original stable error classification.
      }
    }
    throw normalizeFailure(error);
  }
};

export const acquireCommandGuardianLease = async (
  dataRoot: string,
  commandIdInput: CommandId,
  hooks: DataRootLockHooks = {}
): Promise<CommandGuardianLease> => {
  let connection: DatabaseSync | undefined;
  let transactionOpen = false;
  try {
    const admittedHooks = snapshotHooks(hooks);
    const parsedCommandId = CommandIdSchema.safeParse(commandIdInput);
    if (!parsedCommandId.success) throw failure("unsafe_state");
    const commandId = parsedCommandId.data;
    const policy = await DataPathPolicy.create(dataRoot);
    const file = await ensurePrivateSqliteFile(policy, guardianLeaseRelativePath(commandId));
    connection = await openVerifiedConnection(policy, file, admittedHooks);
    try {
      beginExclusive(connection);
      transactionOpen = true;
    } catch (error) {
      if (isSqliteBusy(error)) throw failure("root_busy");
      throw error;
    }
    const lease = new OwnedCommandGuardianLease(commandId);
    const rootStatus = await lstat(policy.root);
    const commandDirectoryStatus = await lstat(dirname(file.absolutePath));
    const leaseFileStatus = await lstat(file.absolutePath);
    assertPrivateDirectory(rootStatus);
    assertPrivateDirectory(commandDirectoryStatus);
    assertPrivateFile(leaseFileStatus);
    commandGuardianLeaseStates.set(lease, {
      admittedRoot: resolve(dataRoot),
      root: policy.root,
      rootIdentity: identityOf(rootStatus),
      commandId,
      commandDirectoryIdentity: identityOf(commandDirectoryStatus),
      leaseFileIdentity: identityOf(leaseFileStatus),
      connection,
      active: true
    });
    connection = undefined;
    transactionOpen = false;
    return lease;
  } catch (error) {
    if (connection !== undefined) {
      try {
        closeConnection(connection, transactionOpen);
      } catch {
        // Preserve the original stable error classification.
      }
    }
    throw normalizeFailure(error);
  }
};
