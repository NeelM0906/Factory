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

/**
 * Takes a stable, no-follow snapshot of one already-pinned recovery directory.
 *
 * Every identity comparison below is deliberately strict, link count included. This function's
 * contract is that nothing moved while it looked, and the checks divide the window between them
 * rather than duplicating each other. The opening comparison against the caller's pinned
 * `expected` is the only thing covering the gap between that pin and this open: the double
 * enumeration cannot see into it, because both reads happen afterwards and would agree with each
 * other about an entry that arrived before the first one. Link count is what makes that opening
 * comparison able to see an added or removed entry at all, so dropping it would leave the
 * pin-to-open window unguarded. Callers pin immediately before calling (see
 * DataPathPolicy.listDirectory) and the window is a handful of lstat calls, so no legitimate
 * drift is expected inside it. Contrast the identity checks that tolerate drift --
 * path-security.ts:createMissingRoot and PinnedDirectories.validateAllowingConcurrentEntries --
 * which serve directories that independent brokers write to concurrently by design.
 */
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
      // Strict for both entry kinds, per this function's stable-snapshot contract. For a file
      // the link count is a real hard-link control (asserted exactly, one line above). For a
      // directory it additionally pins the child's own entry count, which is stricter than the
      // contract strictly requires -- but the identity returned here becomes the caller's pin,
      // so relaxing it would silently widen every pin this function hands out.
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
