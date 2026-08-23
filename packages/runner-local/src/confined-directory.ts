import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DARWIN_DIRECTORY_OPEN_FLAGS,
  assertPrivateDirectory,
  assertPrivateFileLinkCount,
  identityOf,
  isWithin,
  samePinnedIdentity,
  type PathIdentity
} from "./path-security.js";
import { OwnedPathPolicyError as PathPolicyError } from "./path-types.js";

export interface ConfinedDirectoryEntry {
  readonly name: string;
  readonly type: "directory" | "file";
  readonly identity: PathIdentity;
}

/** Takes a stable, no-follow snapshot of one already-pinned recovery directory. */
export const readConfinedDirectory = async (
  directory: string,
  expected: PathIdentity,
  maximumEntries?: number
): Promise<readonly ConfinedDirectoryEntry[]> => {
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | DARWIN_DIRECTORY_OPEN_FLAGS
  );
  try {
    const openedStatus = await handle.stat();
    assertPrivateDirectory(openedStatus);
    if (!samePinnedIdentity(expected, identityOf(openedStatus))) {
      throw new PathPolicyError(
        "path_identity_changed",
        "A recovery directory changed while opening."
      );
    }
    const readNames = async (): Promise<string[]> => {
      if (maximumEntries === undefined) return (await readdir(directory)).sort();
      if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
        throw new PathPolicyError("filesystem_error", "A recovery directory bound is invalid.");
      }
      const names: string[] = [];
      const stream = await opendir(directory);
      try {
        for await (const entry of stream) {
          names.push(entry.name);
          if (names.length > maximumEntries) {
            throw new PathPolicyError(
              "filesystem_error",
              "A recovery directory exceeds its admitted bound."
            );
          }
        }
      } finally {
        await stream.close().catch(() => undefined);
      }
      return names.sort();
    };
    const firstNames = await readNames();
    const entries: ConfinedDirectoryEntry[] = [];
    for (const name of firstNames) {
      const entryPath = resolve(directory, name);
      if (!isWithin(directory, entryPath)) {
        throw new PathPolicyError("path_escape", "A recovery entry escaped its directory.");
      }
      const status = await lstat(entryPath);
      if (status.isDirectory() && !status.isSymbolicLink()) {
        assertPrivateDirectory(status);
        entries.push({ name, type: "directory", identity: identityOf(status) });
        continue;
      }
      if (status.isFile() && !status.isSymbolicLink()) {
        if (status.nlink === 1 || status.nlink === 2) {
          assertPrivateFileLinkCount(status, status.nlink);
        } else {
          throw new PathPolicyError("hardlink_forbidden", "A recovery file has extra links.");
        }
        entries.push({ name, type: "file", identity: identityOf(status) });
        continue;
      }
      throw new PathPolicyError(
        "symlink_forbidden",
        "A recovery entry is not a private regular file or directory."
      );
    }
    const secondNames = await readNames();
    if (
      firstNames.length !== secondNames.length ||
      firstNames.some((name, index) => name !== secondNames[index])
    ) {
      throw new PathPolicyError(
        "path_identity_changed",
        "Recovery directory entries changed during enumeration."
      );
    }
    for (const entry of entries) {
      const status = await lstat(resolve(directory, entry.name));
      if (entry.type === "directory") assertPrivateDirectory(status);
      else assertPrivateFileLinkCount(status, entry.identity.nlink as 1 | 2);
      if (!samePinnedIdentity(entry.identity, identityOf(status))) {
        throw new PathPolicyError(
          "path_identity_changed",
          "A recovery entry changed during enumeration."
        );
      }
    }
    const afterStatus = await handle.stat();
    assertPrivateDirectory(afterStatus);
    if (!samePinnedIdentity(expected, identityOf(afterStatus))) {
      throw new PathPolicyError(
        "path_identity_changed",
        "A recovery directory changed during enumeration."
      );
    }
    return entries;
  } finally {
    await handle.close();
  }
};
