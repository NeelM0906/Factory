import { chmod, lstat, opendir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { EnvironmentRegistryState } from "./environment-registry.js";
import type { DataPathPolicy } from "./path-policy.js";
import { WorktreeManagerError } from "./worktree-manager-shared.js";

const MAXIMUM_MANAGED_ENTRIES = 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const boundedDirectoryNames = async (
  directoryPath: string,
  requirePrivateChildren: boolean
): Promise<readonly string[]> => {
  const before = await lstat(directoryPath);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o077) !== 0 ||
    (await realpath(directoryPath)) !== directoryPath
  ) {
    throw new WorktreeManagerError("maintenance_required");
  }
  const names: string[] = [];
  const directory = await opendir(directoryPath);
  try {
    for await (const child of directory) {
      if (names.length >= MAXIMUM_MANAGED_ENTRIES || !child.isDirectory()) {
        throw new WorktreeManagerError("maintenance_required");
      }
      const path = resolve(directoryPath, child.name);
      const status = await lstat(path);
      if (
        status.isSymbolicLink() ||
        !status.isDirectory() ||
        status.uid !== process.getuid?.() ||
        (status.mode & 0o022) !== 0 ||
        (requirePrivateChildren && (status.mode & 0o077) !== 0) ||
        (await realpath(path)) !== path
      ) {
        throw new WorktreeManagerError("maintenance_required");
      }
      names.push(child.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  const after = await lstat(directoryPath);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.uid !== before.uid ||
    (after.mode & 0o777) !== (before.mode & 0o777) ||
    (await realpath(directoryPath)) !== directoryPath
  ) {
    throw new WorktreeManagerError("maintenance_required");
  }
  return Object.freeze(names);
};

export const assertManagedRoot = async (
  paths: DataPathPolicy,
  states: readonly EnvironmentRegistryState[]
): Promise<void> => {
  const expected = new Set(
    states.filter((state) => state.phase !== "disposed").map((state) => state.intent.managedPath)
  );
  const repositoryDigests = new Set(states.map((state) => state.intent.repositoryDigest));
  const managedRoot = resolve(paths.root, "worktrees");
  const repositoryNames = await boundedDirectoryNames(managedRoot, true);
  for (const repositoryName of repositoryNames) {
    if (!SHA256_PATTERN.test(repositoryName) || !repositoryDigests.has(repositoryName)) {
      throw new WorktreeManagerError("maintenance_required");
    }
    const repositoryRoot = resolve(managedRoot, repositoryName);
    const childNames = await boundedDirectoryNames(repositoryRoot, false);
    for (const childName of childNames) {
      if (!expected.has(resolve(repositoryRoot, childName))) {
        throw new WorktreeManagerError("maintenance_required");
      }
    }
  }
};

export const managedPathPresent = async (path: string): Promise<boolean> => {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory() || (await realpath(path)) !== path) {
      throw new WorktreeManagerError("maintenance_required");
    }
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

export const hardenManagedDirectory = async (path: string): Promise<void> => {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory() || (await realpath(path)) !== path) {
    throw new WorktreeManagerError("maintenance_required");
  }
  await chmod(path, 0o700);
  const after = await lstat(path);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    (after.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  ) {
    throw new WorktreeManagerError("maintenance_required");
  }
};
