import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { readConfinedDirectory, type ConfinedDirectoryEntry } from "./confined-directory.js";
import { PinnedDirectories } from "./pinned-directories.js";
import { isNodeError, rejectInvalidRelativePath, snapshotStringInput } from "./path-security.js";
import { OwnedPathPolicyError as PathPolicyError, isPathPolicyError } from "./path-types.js";

interface ExistingDirectoryInput {
  readonly root: string;
  readonly directories: PinnedDirectories;
  readonly relativePathInput: string;
}

/** Pins an already-existing directory without creating any missing path component. */
export const pinExistingDirectory = async (
  input: ExistingDirectoryInput
): Promise<string | undefined> => {
  const relativePath = snapshotStringInput(
    input.relativePathInput,
    "invalid_relative_path",
    "A relative state-directory path is required."
  );
  const segments = rejectInvalidRelativePath(relativePath, true);
  let directory = input.root;
  await input.directories.validateAllowingConcurrentEntries(directory);
  for (const segment of segments) {
    directory = resolve(directory, segment);
    let status: Stats;
    try {
      status = await lstat(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new PathPolicyError(
        "symlink_forbidden",
        "A symbolic link is forbidden in AutoStack state."
      );
    }
    if (input.directories.has(directory)) {
      await input.directories.validateAllowingConcurrentEntries(directory);
    } else await input.directories.pinExisting(directory);
  }
  await input.directories.validateChain(segments, true);
  await input.directories.validateAllowingConcurrentEntries(directory);
  return directory;
};

/** Opens an already-existing pinned directory without creating any missing path component. */
export const readExistingDirectory = async (
  input: ExistingDirectoryInput & {
    readonly maximumEntries: number;
  }
): Promise<readonly ConfinedDirectoryEntry[] | undefined> => {
  try {
    const directory = await pinExistingDirectory(input);
    if (directory === undefined) return undefined;
    const expected = await input.directories.validateAllowingConcurrentEntries(directory);
    const entries = await readConfinedDirectory(directory, expected, input.maximumEntries);
    await input.directories.validate(directory);
    return entries;
  } catch (error) {
    if (isPathPolicyError(error)) throw error;
    throw new PathPolicyError("filesystem_error", "A private recovery directory is unavailable.");
  }
};
