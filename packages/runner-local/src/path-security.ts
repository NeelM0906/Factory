import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, rmdir, symlink, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  OwnedPathPolicyError as PathPolicyError,
  type DataPathPolicyHooks,
  type PathPolicyErrorCode,
  type PrivateFileOpenMode
} from "./path-types.js";

export interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
}

const O_NOFOLLOW_ANY_DARWIN = 0x2000_0000;
const O_UNIQUE_DARWIN = 0x0000_2000;
const DARWIN_NOFOLLOW_ANY_FLAG = process.platform === "darwin" ? O_NOFOLLOW_ANY_DARWIN : 0;
const DARWIN_UNIQUE_FLAG = process.platform === "darwin" ? O_UNIQUE_DARWIN : 0;
export const DARWIN_DIRECTORY_OPEN_FLAGS =
  process.platform === "darwin" ? O_NOFOLLOW_ANY_DARWIN : 0;

export const isNodeError = (value: unknown): value is NodeJS.ErrnoException =>
  value instanceof Error && "code" in value;

export const snapshotStringInput = (
  value: unknown,
  code: PathPolicyErrorCode,
  message: string
): string => {
  if (typeof value !== "string") throw new PathPolicyError(code, message);
  return value;
};

export const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
};

export const identityOf = (status: Stats): PathIdentity => ({
  dev: status.dev,
  ino: status.ino,
  uid: status.uid,
  mode: status.mode & 0o7777,
  nlink: status.nlink
});

export const sameObject = (left: PathIdentity, right: PathIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export const samePinnedIdentity = (left: PathIdentity, right: PathIdentity): boolean =>
  sameObject(left, right) &&
  left.uid === right.uid &&
  left.mode === right.mode &&
  left.nlink === right.nlink;

export const sameIdentityExceptLinkCount = (left: PathIdentity, right: PathIdentity): boolean =>
  sameObject(left, right) && left.uid === right.uid && left.mode === right.mode;

const currentUid = (): number | undefined =>
  typeof process.geteuid === "function"
    ? process.geteuid()
    : typeof process.getuid === "function"
      ? process.getuid()
      : undefined;

export const assertPrivateDirectory = (
  status: Stats,
  nonDirectoryCode: "state_root_invalid" | "symlink_forbidden" = "symlink_forbidden"
): void => {
  if (status.isSymbolicLink()) {
    throw new PathPolicyError(nonDirectoryCode, "A symbolic link is forbidden in AutoStack state.");
  }
  if (!status.isDirectory()) {
    throw new PathPolicyError(nonDirectoryCode, "A private AutoStack state directory is required.");
  }
  const uid = currentUid();
  if ((status.mode & 0o7777) !== 0o700 || (uid !== undefined && status.uid !== uid)) {
    throw new PathPolicyError(
      "unsafe_permissions",
      "An AutoStack state directory does not have its pinned private ownership and mode."
    );
  }
};

export const assertPrivateFileLinkCount = (status: Stats, linkCount: 1 | 2): void => {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new PathPolicyError("symlink_forbidden", "A regular no-follow state file is required.");
  }
  if (status.nlink !== linkCount) {
    throw new PathPolicyError("hardlink_forbidden", "A hard-linked state file is forbidden.");
  }
  const uid = currentUid();
  if ((status.mode & 0o7777) !== 0o600 || (uid !== undefined && status.uid !== uid)) {
    throw new PathPolicyError(
      "unsafe_permissions",
      "An AutoStack state file does not have its pinned private ownership and mode."
    );
  }
};

export const assertPrivateFile = (status: Stats): void => assertPrivateFileLinkCount(status, 1);

export const rejectInvalidRelativePath = (
  candidate: string,
  allowRoot: boolean
): readonly string[] => {
  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.includes("\\") ||
    isAbsolute(candidate) ||
    /^[A-Za-z]:/.test(candidate) ||
    /%(?:2e|2f|5c)/i.test(candidate)
  ) {
    throw new PathPolicyError(
      "invalid_relative_path",
      "A portable relative AutoStack data path is required."
    );
  }
  if (candidate === ".") {
    if (allowRoot) return [];
    throw new PathPolicyError(
      "invalid_relative_path",
      "A file path below the data root is required."
    );
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new PathPolicyError(
      "invalid_relative_path",
      "Dot segments and empty path segments are forbidden."
    );
  }
  return segments;
};

export const existingNearestAncestor = async (candidate: string): Promise<string> => {
  let current = candidate;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parent = resolve(current, "..");
      if (parent === current) throw error;
      current = parent;
    }
  }
};

export const assertNoUserSymlinkComponents = async (candidate: string): Promise<void> => {
  const segments = resolve(candidate)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let current: string = sep;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink()) {
        const canonical = await realpath(current);
        const allowedDarwinSystemAlias =
          process.platform === "darwin" &&
          index === 0 &&
          canonical === resolve(sep, "private", segment);
        if (!allowedDarwinSystemAlias) {
          throw new PathPolicyError(
            "state_root_invalid",
            "The state root cannot traverse a user-controlled symlink."
          );
        }
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
};

export const invokePathHook = async (
  hook: (() => Promise<void> | void) | undefined
): Promise<void> => {
  if (hook === undefined) return;
  try {
    await hook();
  } catch {
    throw new PathPolicyError("filesystem_error", "A path-policy test boundary failed.");
  }
};

export const syncUnmanagedDirectory = async (directoryPath: string): Promise<void> => {
  const handle = await open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | DARWIN_DIRECTORY_OPEN_FLAGS
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const verifyDarwinOpenCapabilities = async (
  root: string,
  hook: DataPathPolicyHooks["onDarwinCapabilityVerified"]
): Promise<void> => {
  if (process.platform !== "darwin") return;
  const token = randomUUID();
  const target = resolve(root, `.open-capability-${token}`);
  const linked = resolve(root, `.unique-capability-${token}`);
  const directory = resolve(root, `.nofollow-capability-${token}`);
  const alias = resolve(directory, "alias");
  let targetCreated = false;
  let linkedCreated = false;
  let directoryCreated = false;
  let aliasCreated = false;
  let cleanupFailed = false;
  try {
    const created = await open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW_ANY_DARWIN,
      0o600
    );
    targetCreated = true;
    try {
      await created.sync();
    } finally {
      await created.close();
    }
    await syncUnmanagedDirectory(root);
    const uniquePositive = await open(
      target,
      fsConstants.O_RDONLY | O_NOFOLLOW_ANY_DARWIN | O_UNIQUE_DARWIN
    );
    await uniquePositive.close();
    await mkdir(directory, { mode: 0o700 });
    directoryCreated = true;
    await symlink("..", alias);
    aliasCreated = true;
    let noFollowRejected = false;
    try {
      const escaped = await open(
        resolve(alias, `.open-capability-${token}`),
        fsConstants.O_RDONLY | O_NOFOLLOW_ANY_DARWIN
      );
      await escaped.close();
    } catch (error) {
      noFollowRejected = isNodeError(error) && error.code === "ELOOP";
    }
    if (!noFollowRejected) {
      throw new PathPolicyError(
        "state_root_invalid",
        "Darwin whole-path no-follow semantics are unavailable."
      );
    }
    await invokePathHook(() => hook?.("nofollow_any"));
    await link(target, linked);
    linkedCreated = true;
    let uniqueRejected = false;
    try {
      const hardLinked = await open(
        target,
        fsConstants.O_RDONLY | O_NOFOLLOW_ANY_DARWIN | O_UNIQUE_DARWIN
      );
      await hardLinked.close();
    } catch {
      uniqueRejected = true;
    }
    if (!uniqueRejected) {
      throw new PathPolicyError(
        "state_root_invalid",
        "Darwin unique-link open semantics are unavailable."
      );
    }
    await invokePathHook(() => hook?.("unique_link"));
  } finally {
    const clean = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch {
        cleanupFailed = true;
      }
    };
    if (aliasCreated) await clean(() => unlink(alias));
    if (directoryCreated) await clean(() => rmdir(directory));
    if (linkedCreated) await clean(() => unlink(linked));
    if (targetCreated) await clean(() => unlink(target));
    await clean(() => syncUnmanagedDirectory(root));
    if (cleanupFailed) {
      throw new PathPolicyError(
        "filesystem_error",
        "Darwin capability-probe cleanup failed closed."
      );
    }
  }
};

export const createMissingRoot = async (
  absoluteRoot: string,
  nearest: string,
  hook: DataPathPolicyHooks["beforeRootCreate"],
  directoryHook: DataPathPolicyHooks["beforeRootDirectoryCreate"]
): Promise<string> => {
  const canonicalNearest = await realpath(nearest);
  const suffix = relative(nearest, absoluteRoot);
  const canonicalRoot = resolve(canonicalNearest, suffix);
  if (!isWithin(canonicalNearest, canonicalRoot)) {
    throw new PathPolicyError("path_escape", "The state root escaped its existing ancestor.");
  }
  const nearestBeforeStatus = await lstat(canonicalNearest);
  if (!nearestBeforeStatus.isDirectory() || nearestBeforeStatus.isSymbolicLink()) {
    throw new PathPolicyError(
      "state_root_invalid",
      "The state root needs a stable directory parent."
    );
  }
  let parentIdentity = identityOf(nearestBeforeStatus);
  const segments = suffix.split(sep).filter((segment) => segment.length > 0);
  const firstTarget =
    segments.length === 0 ? canonicalRoot : resolve(canonicalNearest, segments[0]!);
  await invokePathHook(() => hook?.({ directoryPath: firstTarget, parentPath: canonicalNearest }));
  // Link count is excluded exactly as it is at the in-loop parent re-check below: a directory's
  // nlink tracks its subdirectory count, so any concurrent sibling creation moves it without the
  // parent changing identity. Directories cannot be hard-linked, so nlink carries no attack signal
  // here; inode replacement and symlink substitution stay covered by dev/ino, and ownership and
  // mode drift by uid/mode.
  if (!sameIdentityExceptLinkCount(parentIdentity, identityOf(await lstat(canonicalNearest)))) {
    throw new PathPolicyError("path_identity_changed", "The state-root parent identity changed.");
  }
  const created: Array<{ path: string; identity: PathIdentity; parent: string }> = [];
  let parent = canonicalNearest;
  try {
    for (const segment of segments) {
      const target = resolve(parent, segment);
      await invokePathHook(() => directoryHook?.({ directoryPath: target, parentPath: parent }));
      let createdByAttempt = false;
      try {
        await mkdir(target, { mode: 0o700 });
        createdByAttempt = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      const targetStatus = await lstat(target);
      const targetIdentity = identityOf(targetStatus);
      if (createdByAttempt) created.push({ path: target, identity: targetIdentity, parent });
      assertPrivateDirectory(targetStatus, "state_root_invalid");
      const parentAfter = identityOf(await lstat(parent));
      if (!sameIdentityExceptLinkCount(parentIdentity, parentAfter)) {
        throw new PathPolicyError(
          "path_identity_changed",
          "The state-root parent identity changed."
        );
      }
      if ((await realpath(target)) !== target) {
        throw new PathPolicyError(
          "path_identity_changed",
          "A concurrently created state-root directory was redirected."
        );
      }
      await syncUnmanagedDirectory(target);
      await syncUnmanagedDirectory(parent);
      parent = target;
      parentIdentity = targetIdentity;
    }
    if ((await realpath(canonicalRoot)) !== canonicalRoot) {
      throw new PathPolicyError("path_identity_changed", "The new state root changed identity.");
    }
    return canonicalRoot;
  } catch (error) {
    for (const entry of created.reverse()) {
      try {
        if (sameObject(entry.identity, identityOf(await lstat(entry.path)))) {
          await rmdir(entry.path);
          await syncUnmanagedDirectory(entry.parent);
        }
      } catch {
        // Cleanup is best effort; the public error remains typed and path-free.
      }
    }
    throw error;
  }
};

export const privateOpenFlags = (mode: PrivateFileOpenMode): number => {
  if (mode === "r") {
    return (
      fsConstants.O_RDONLY |
      (process.platform === "darwin" ? DARWIN_NOFOLLOW_ANY_FLAG : fsConstants.O_NOFOLLOW) |
      DARWIN_UNIQUE_FLAG
    );
  }
  return (
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (process.platform === "darwin" ? DARWIN_NOFOLLOW_ANY_FLAG : fsConstants.O_NOFOLLOW)
  );
};
