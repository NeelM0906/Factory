import { lstatSync, type Stats } from "node:fs";
import { opendir, lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
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
  if (
    (afterRecoveryReadBeforePostcheck !== undefined &&
      typeof afterRecoveryReadBeforePostcheck !== "function") ||
    (afterSidecarSnapshotBeforeOpen !== undefined &&
      typeof afterSidecarSnapshotBeforeOpen !== "function")
  ) {
    throw failure("unsafe_state");
  }
  return Object.freeze({
    ...(afterRecoveryReadBeforePostcheck === undefined ? {} : { afterRecoveryReadBeforePostcheck }),
    ...(afterSidecarSnapshotBeforeOpen === undefined ? {} : { afterSidecarSnapshotBeforeOpen })
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

const assertSqliteSidecarsAbsentAfterRecovery = (file: PrivateSqliteFile): void => {
  assertForbiddenSidecarsAbsent(file);
  const journal = lstatIfPresent(`${file.absolutePath}-journal`);
  if (journal === undefined) return;
  assertPrivateFile(journal);
  if (
    journal.size < MINIMUM_ROLLBACK_JOURNAL_BYTES ||
    journal.size > MAXIMUM_ROLLBACK_JOURNAL_BYTES
  ) {
    throw failure("unsafe_state");
  }
  throw RETRY_SIDECAR_SNAPSHOT;
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
      connection = new DatabaseSync(file.absolutePath);
      try {
        connection.prepare("PRAGMA schema_version").get();
      } catch (error) {
        if (isSqliteBusy(error)) throw failure("root_busy");
        throw error;
      }
      await hooks.afterRecoveryReadBeforePostcheck?.();
      assertMainFileUnchanged(file);
      assertSqliteSidecarsAbsentAfterRecovery(file);
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

export class CommandGuardianLease {
  readonly commandId: CommandId;
  #connection: DatabaseSync | undefined;

  protected constructor(commandId: CommandId, connection: DatabaseSync) {
    this.commandId = commandId;
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

class OwnedCommandGuardianLease extends CommandGuardianLease {
  constructor(commandId: CommandId, connection: DatabaseSync) {
    super(commandId, connection);
  }
}

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
    const lease = new OwnedCommandGuardianLease(commandId, connection);
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
