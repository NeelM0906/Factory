import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertPrivateDirectory,
  assertPrivateFile,
  assertPrivateFileLinkCount,
  identityOf,
  isNodeError,
  isWithin,
  privateOpenFlags,
  rejectInvalidRelativePath,
  sameIdentityExceptLinkCount,
  sameObject,
  samePinnedIdentity,
  snapshotStringInput,
  type PathIdentity
} from "./path-security.js";
import { readConfinedDirectory, type ConfinedDirectoryEntry } from "./confined-directory.js";
import { pinExistingDirectory, readExistingDirectory } from "./existing-directory.js";
import { admitDirectoryCreation, invokePathHook } from "./path-policy-hooks.js";
import { admitDataPathRoot } from "./data-path-policy-root.js";
import { PinnedDirectories } from "./pinned-directories.js";
import {
  AUTOSTACK_NAMESPACE_MUTATION_PROTECTION,
  AUTOSTACK_PATH_ENFORCEMENT_SCOPE,
  OwnedPathPolicyError as PathPolicyError,
  isPathPolicyError,
  type AutoStackNamespaceMutationProtection,
  type AutoStackPathEnforcementScope,
  type DataPathPolicyHooks,
  type PathPolicyErrorCode,
  type PrivateFileOpenMode
} from "./path-types.js";

export {
  AUTOSTACK_NAMESPACE_MUTATION_PROTECTION,
  AUTOSTACK_PATH_ENFORCEMENT_SCOPE,
  PathPolicyError,
  type AutoStackNamespaceMutationProtection,
  type AutoStackPathEnforcementScope,
  type DataPathPolicyHooks,
  type DirectoryCreateContext,
  type PathPolicyErrorCode,
  type PrivateFileOpenMode
} from "./path-types.js";
export { RepositoryInspectionPathPolicy } from "./repository-path-policy.js";
export type { ConfinedDirectoryEntry } from "./confined-directory.js";

/** Confines product state; same-UID namespace-race protection remains advisory. */
export class DataPathPolicy {
  readonly enforcementScope: AutoStackPathEnforcementScope = AUTOSTACK_PATH_ENFORCEMENT_SCOPE;
  readonly namespaceMutationProtection: AutoStackNamespaceMutationProtection =
    AUTOSTACK_NAMESPACE_MUTATION_PROTECTION;
  readonly root: string;
  readonly #hooks: DataPathPolicyHooks;
  readonly #directories: PinnedDirectories;

  private constructor(root: string, rootIdentity: PathIdentity, hooks: DataPathPolicyHooks) {
    this.root = root;
    this.#directories = new PinnedDirectories(root, rootIdentity);
    this.#hooks = hooks;
  }
  static async create(rootInput: string, hooks: DataPathPolicyHooks = {}): Promise<DataPathPolicy> {
    try {
      const admitted = await admitDataPathRoot(rootInput, hooks, true);
      return new DataPathPolicy(admitted.root, admitted.identity, admitted.hooks);
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state root is unavailable.");
    }
  }
  static async openExisting(
    rootInput: string,
    hooks: DataPathPolicyHooks = {}
  ): Promise<DataPathPolicy> {
    try {
      const admitted = await admitDataPathRoot(rootInput, hooks, false);
      return new DataPathPolicy(admitted.root, admitted.identity, admitted.hooks);
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state root is unavailable.");
    }
  }
  async ensureDirectory(relativePath: string): Promise<string> {
    try {
      const relative = snapshotStringInput(
        relativePath,
        "invalid_relative_path",
        "A relative state-directory path is required."
      );
      const segments = rejectInvalidRelativePath(relative, true);
      let current = this.root;
      const pinnedSegments: string[] = [];
      let requested = this.root;
      for (const segment of segments) {
        requested = resolve(requested, segment);
        try {
          if ((await lstat(requested)).isSymbolicLink()) {
            throw new PathPolicyError(
              "symlink_forbidden",
              "A symbolic link is forbidden in AutoStack state."
            );
          }
        } catch (error) {
          if (isPathPolicyError(error)) throw error;
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          break;
        }
      }
      await this.#directories.validateAllowingConcurrentEntries(current);
      for (const segment of segments) {
        const target = resolve(current, segment);
        if (!isWithin(this.root, target)) {
          throw new PathPolicyError("path_escape", "The requested state path escaped its root.");
        }
        try {
          await lstat(target);
          if (this.#directories.has(target)) {
            await this.#directories.validateAllowingConcurrentEntries(target);
          } else await this.#directories.pinExisting(target);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          await invokePathHook(() =>
            this.#hooks.beforeDirectoryCreate?.({ directoryPath: target, parentPath: current })
          );
          await this.#directories.validateChain(pinnedSegments, true);
          const parentBefore = await this.#directories.validateAllowingConcurrentEntries(current);
          let createdIdentity: PathIdentity | undefined;
          try {
            await mkdir(target, { mode: 0o700 });
            const createdStatus = await lstat(target);
            assertPrivateDirectory(createdStatus);
            createdIdentity = identityOf(createdStatus);
            const parentAfter = identityOf(await lstat(current));
            if (!sameIdentityExceptLinkCount(parentBefore, parentAfter)) {
              throw new PathPolicyError("path_identity_changed", "A directory parent changed.");
            }
            this.#directories.set(current, parentAfter);
            this.#directories.set(target, createdIdentity);
            if ((await realpath(target)) !== target) {
              throw new PathPolicyError("path_identity_changed", "A new state directory moved.");
            }
            await this.#directories.syncAllowingConcurrentEntries(target);
            await this.#directories.syncAllowingConcurrentEntries(current);
          } catch (error) {
            if (createdIdentity === undefined && isNodeError(error) && error.code === "EEXIST") {
              const winnerStatus = await lstat(target);
              assertPrivateDirectory(winnerStatus);
              const winnerIdentity = identityOf(winnerStatus);
              const parentAfter = identityOf(await lstat(current));
              if (
                !sameIdentityExceptLinkCount(parentBefore, parentAfter) ||
                (await realpath(target)) !== target
              ) {
                throw new PathPolicyError(
                  "path_identity_changed",
                  "A concurrently created state directory changed."
                );
              }
              this.#directories.set(current, parentAfter);
              this.#directories.set(target, winnerIdentity);
              await this.#directories.syncAllowingConcurrentEntries(target);
              await this.#directories.syncAllowingConcurrentEntries(current);
            } else {
              if (createdIdentity !== undefined) {
                try {
                  const present = identityOf(await lstat(target));
                  if (sameObject(createdIdentity, present)) await rmdir(target);
                } catch {
                  // Exact-inode cleanup is best effort under the documented same-UID race boundary.
                }
              }
              throw error;
            }
          }
        }
        current = target;
        pinnedSegments.push(segment);
      }
      await this.#directories.validateChain(segments, true);
      return current;
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state directory is unavailable.");
    }
  }
  async #directory(relativePath: string, createMissing: boolean): Promise<string | undefined> {
    return createMissing
      ? await this.ensureDirectory(relativePath)
      : await pinExistingDirectory({
          root: this.root,
          directories: this.#directories,
          relativePathInput: relativePath
        });
  }
  async fileExists(relativePathInput: string, createMissingParents = true): Promise<boolean> {
    try {
      createMissingParents = admitDirectoryCreation(createMissingParents);
      const relativePath = snapshotStringInput(
        relativePathInput,
        "invalid_relative_path",
        "A relative state-file path is required."
      );
      return await this.#fileExists(relativePath, createMissingParents);
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state file is unavailable.");
    }
  }
  async #fileExists(relativePath: string, createMissingParents: boolean): Promise<boolean> {
    const segments = rejectInvalidRelativePath(relativePath, false);
    const fileName = segments.at(-1);
    if (fileName === undefined) {
      throw new PathPolicyError("invalid_relative_path", "A file path is required.");
    }
    const parentSegments = segments.slice(0, -1);
    const parent = await this.#directory(
      parentSegments.length === 0 ? "." : parentSegments.join("/"),
      createMissingParents
    );
    if (parent === undefined) return false;
    const absolutePath = resolve(parent, fileName);
    try {
      const firstStatus = await lstat(absolutePath);
      assertPrivateFile(firstStatus);
      await this.#directories.validateChain(parentSegments);
      const secondStatus = await lstat(absolutePath);
      assertPrivateFile(secondStatus);
      if (!samePinnedIdentity(identityOf(firstStatus), identityOf(secondStatus))) {
        throw new PathPolicyError(
          "path_identity_changed",
          "A state file changed during inspection."
        );
      }
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state file is unavailable.");
    }
  }
  async unlinkFile(relativePathInput: string, createMissingParents = true): Promise<boolean> {
    try {
      createMissingParents = admitDirectoryCreation(createMissingParents);
      const relativePath = snapshotStringInput(
        relativePathInput,
        "invalid_relative_path",
        "A relative state-file path is required."
      );
      return await this.#unlinkFile(relativePath, createMissingParents);
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state file could not be removed.");
    }
  }
  async #unlinkFile(relativePath: string, createMissingParents: boolean): Promise<boolean> {
    const segments = rejectInvalidRelativePath(relativePath, false);
    const fileName = segments.at(-1);
    if (fileName === undefined) {
      throw new PathPolicyError("invalid_relative_path", "A file path is required.");
    }
    const parentSegments = segments.slice(0, -1);
    const parent = await this.#directory(
      parentSegments.length === 0 ? "." : parentSegments.join("/"),
      createMissingParents
    );
    if (parent === undefined) return false;
    const absolutePath = resolve(parent, fileName);
    try {
      const status = await lstat(absolutePath);
      assertPrivateFile(status);
      const fileIdentity = identityOf(status);
      await this.#directories.validateChain(parentSegments, true);
      const parentBefore = await this.#directories.validateAllowingConcurrentEntries(parent);
      const present = await lstat(absolutePath);
      assertPrivateFile(present);
      if (!samePinnedIdentity(fileIdentity, identityOf(present))) {
        throw new PathPolicyError("path_identity_changed", "A state file changed before removal.");
      }
      await unlink(absolutePath);
      const parentAfter = identityOf(await lstat(parent));
      if (!sameIdentityExceptLinkCount(parentBefore, parentAfter)) {
        throw new PathPolicyError("path_identity_changed", "A state-file parent changed.");
      }
      this.#directories.set(parent, parentAfter);
      await this.#directories.syncAllowingConcurrentEntries(parent);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state file could not be removed.");
    }
  }
  async linkFileNoReplace(
    sourceRelativePath: string,
    destinationRelativePath: string,
    createMissingParents = true
  ): Promise<boolean> {
    try {
      createMissingParents = admitDirectoryCreation(createMissingParents);
      const sourceRelative = snapshotStringInput(
        sourceRelativePath,
        "invalid_relative_path",
        "A relative state-file path is required."
      );
      const destinationRelative = snapshotStringInput(
        destinationRelativePath,
        "invalid_relative_path",
        "A relative state-file path is required."
      );
      const sourceSegments = rejectInvalidRelativePath(sourceRelative, false);
      const destinationSegments = rejectInvalidRelativePath(destinationRelative, false);
      const sourceName = sourceSegments.at(-1);
      const destinationName = destinationSegments.at(-1);
      if (sourceName === undefined || destinationName === undefined) {
        throw new PathPolicyError("invalid_relative_path", "Two state-file paths are required.");
      }
      const sourceParentSegments = sourceSegments.slice(0, -1);
      const destinationParentSegments = destinationSegments.slice(0, -1);
      const sourceParent = await this.#directory(
        sourceParentSegments.length === 0 ? "." : sourceParentSegments.join("/"),
        createMissingParents
      );
      const destinationParent = await this.#directory(
        destinationParentSegments.length === 0 ? "." : destinationParentSegments.join("/"),
        createMissingParents
      );
      if (sourceParent === undefined || destinationParent === undefined) return false;
      const source = resolve(sourceParent, sourceName);
      const destination = resolve(destinationParent, destinationName);
      const sourceStatus = await lstat(source);
      assertPrivateFile(sourceStatus);
      const sourceIdentity = identityOf(sourceStatus);
      await this.#directories.validateChain(sourceParentSegments, true);
      await this.#directories.validateChain(destinationParentSegments, true);
      const sourceParentBefore =
        await this.#directories.validateAllowingConcurrentEntries(sourceParent);
      const destinationParentBefore =
        await this.#directories.validateAllowingConcurrentEntries(destinationParent);
      try {
        await link(source, destination);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") return false;
        throw error;
      }
      const sourceLinked = await lstat(source);
      const destinationLinked = await lstat(destination);
      assertPrivateFileLinkCount(sourceLinked, 2);
      assertPrivateFileLinkCount(destinationLinked, 2);
      if (
        !sameObject(sourceIdentity, identityOf(sourceLinked)) ||
        !sameObject(sourceIdentity, identityOf(destinationLinked))
      ) {
        throw new PathPolicyError("path_identity_changed", "A linked state file changed identity.");
      }
      const sourceParentAfter = identityOf(await lstat(sourceParent));
      const destinationParentAfter = identityOf(await lstat(destinationParent));
      if (
        !sameIdentityExceptLinkCount(sourceParentBefore, sourceParentAfter) ||
        !sameIdentityExceptLinkCount(destinationParentBefore, destinationParentAfter)
      ) {
        throw new PathPolicyError("path_identity_changed", "A linked-file parent changed.");
      }
      this.#directories.set(sourceParent, sourceParentAfter);
      this.#directories.set(destinationParent, destinationParentAfter);
      return true;
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "A private state link could not be published.");
    }
  }
  async healLinkedAlias(
    aliasRelativePath: string,
    canonicalRelativePath: string,
    afterUnlink?: () => Promise<void>,
    createMissingParents = true
  ): Promise<boolean> {
    try {
      createMissingParents = admitDirectoryCreation(createMissingParents);
      const aliasRelative = snapshotStringInput(
        aliasRelativePath,
        "invalid_relative_path",
        "A relative state-file path is required."
      );
      const canonicalRelative = snapshotStringInput(
        canonicalRelativePath,
        "invalid_relative_path",
        "A relative state-file path is required."
      );
      const aliasSegments = rejectInvalidRelativePath(aliasRelative, false);
      const canonicalSegments = rejectInvalidRelativePath(canonicalRelative, false);
      const aliasName = aliasSegments.at(-1);
      const canonicalName = canonicalSegments.at(-1);
      if (aliasName === undefined || canonicalName === undefined) {
        throw new PathPolicyError("invalid_relative_path", "Two state-file paths are required.");
      }
      const aliasParentSegments = aliasSegments.slice(0, -1);
      const canonicalParentSegments = canonicalSegments.slice(0, -1);
      const aliasParent = await this.#directory(
        aliasParentSegments.length === 0 ? "." : aliasParentSegments.join("/"),
        createMissingParents
      );
      const canonicalParent = await this.#directory(
        canonicalParentSegments.length === 0 ? "." : canonicalParentSegments.join("/"),
        createMissingParents
      );
      if (aliasParent === undefined || canonicalParent === undefined) return false;
      const alias = resolve(aliasParent, aliasName);
      const canonical = resolve(canonicalParent, canonicalName);
      let aliasStatus: Stats;
      let canonicalStatus: Stats;
      try {
        aliasStatus = await lstat(alias);
        canonicalStatus = await lstat(canonical);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
      }
      if (!sameObject(identityOf(aliasStatus), identityOf(canonicalStatus))) return false;
      assertPrivateFileLinkCount(aliasStatus, 2);
      assertPrivateFileLinkCount(canonicalStatus, 2);
      await this.#directories.validateChain(aliasParentSegments, true);
      await this.#directories.validateChain(canonicalParentSegments, true);
      const aliasParentBefore =
        await this.#directories.validateAllowingConcurrentEntries(aliasParent);
      await unlink(alias);
      const canonicalAfter = await lstat(canonical);
      assertPrivateFile(canonicalAfter);
      if (!sameObject(identityOf(canonicalStatus), identityOf(canonicalAfter))) {
        throw new PathPolicyError("path_identity_changed", "A canonical state file changed.");
      }
      await afterUnlink?.();
      const aliasParentAfter = identityOf(await lstat(aliasParent));
      if (!sameIdentityExceptLinkCount(aliasParentBefore, aliasParentAfter)) {
        throw new PathPolicyError("path_identity_changed", "A linked-file parent changed.");
      }
      this.#directories.set(aliasParent, aliasParentAfter);
      await this.#directories.syncAllowingConcurrentEntries(aliasParent);
      if (canonicalParent !== aliasParent) {
        await this.#directories.syncAllowingConcurrentEntries(canonicalParent);
      }
      return true;
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "A private state link could not be healed.");
    }
  }
  async syncDirectory(relativePathInput: string, createMissing = true): Promise<void> {
    try {
      createMissing = admitDirectoryCreation(createMissing);
      const relativePath = snapshotStringInput(
        relativePathInput,
        "invalid_relative_path",
        "A relative state-directory path is required."
      );
      const directory = await this.#directory(relativePath, createMissing);
      if (directory === undefined) {
        throw new PathPolicyError(
          "filesystem_error",
          "The private state directory is unavailable."
        );
      }
      await this.#directories.syncAllowingConcurrentEntries(directory);
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state directory is unavailable.");
    }
  }
  async listDirectory(relativePathInput: string): Promise<readonly ConfinedDirectoryEntry[]> {
    try {
      const relativePath = snapshotStringInput(
        relativePathInput,
        "invalid_relative_path",
        "A relative state-directory path is required."
      );
      const segments = rejectInvalidRelativePath(relativePath, true);
      const directory = await this.ensureDirectory(relativePath);
      await this.#directories.validateChain(segments, true);
      const expected = await this.#directories.validateAllowingConcurrentEntries(directory);
      const entries = await readConfinedDirectory(directory, expected);
      await this.#directories.validate(directory);
      return entries;
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "A private recovery directory is unavailable.");
    }
  }
  /** Enumerates only an already-existing private directory and never creates recovery state. */
  async listExistingDirectory(
    relativePathInput: string,
    maximumEntries: number
  ): Promise<readonly ConfinedDirectoryEntry[] | undefined> {
    return await readExistingDirectory({
      root: this.root,
      directories: this.#directories,
      relativePathInput,
      maximumEntries
    });
  }

  /**
   * Refreshes link counts between artifact-broker operations while retaining every
   * stable directory capability attribute. APFS changes directory nlink for file
   * entries, so independently created stores must admit that expected drift.
   */
  async refreshDirectoryChainAfterConcurrentEntryChange(
    relativePathInput: string
  ): Promise<boolean> {
    try {
      const relativePath = snapshotStringInput(
        relativePathInput,
        "invalid_relative_path",
        "A relative state-directory path is required."
      );
      return await this.#refreshDirectoryChainAfterConcurrentEntryChange(relativePath);
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "A publication directory is unavailable.");
    }
  }
  async #refreshDirectoryChainAfterConcurrentEntryChange(relativePath: string): Promise<boolean> {
    const segments = rejectInvalidRelativePath(relativePath, true);
    let current = this.root;
    for (const segment of ["", ...segments]) {
      if (segment !== "") current = resolve(current, segment);
      let status: Stats;
      try {
        status = await lstat(current);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw new PathPolicyError("filesystem_error", "A publication directory is unavailable.");
      }
      assertPrivateDirectory(status);
      const actual = identityOf(status);
      const expected = this.#directories.expected(current);
      if (
        (expected !== undefined && !sameIdentityExceptLinkCount(expected, actual)) ||
        (await realpath(current)) !== current
      ) {
        throw new PathPolicyError(
          "path_identity_changed",
          "A publication directory changed identity."
        );
      }
      this.#directories.set(current, actual);
    }
    return true;
  }

  async openFile(
    relativePathInput: string,
    mode: PrivateFileOpenMode,
    createMissingParents = true
  ): Promise<FileHandle> {
    try {
      createMissingParents = admitDirectoryCreation(createMissingParents);
      const relativePath = snapshotStringInput(
        relativePathInput,
        "invalid_relative_path",
        "A relative state-file path is required."
      );
      return await this.#openFile(relativePath, mode, createMissingParents);
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The private state file could not be opened.");
    }
  }

  async #openFile(
    relativePath: string,
    mode: PrivateFileOpenMode,
    createMissingParents: boolean
  ): Promise<FileHandle> {
    if (mode !== "r" && mode !== "wx") {
      throw new PathPolicyError(
        "invalid_open_mode",
        "Only read or exclusive-create opens are allowed."
      );
    }
    const segments = rejectInvalidRelativePath(relativePath, false);
    const fileName = segments.at(-1);
    if (fileName === undefined) {
      throw new PathPolicyError("invalid_relative_path", "A file path is required.");
    }
    const parentSegments = segments.slice(0, -1);
    const parent = await this.#directory(
      parentSegments.length === 0 ? "." : parentSegments.join("/"),
      createMissingParents
    );
    if (parent === undefined) {
      throw new PathPolicyError("filesystem_error", "The state-file parent is unavailable.");
    }
    const absolutePath = resolve(parent, fileName);
    if (!isWithin(this.root, absolutePath)) {
      throw new PathPolicyError("path_escape", "The requested state file escaped its root.");
    }

    let handle: FileHandle | undefined;
    let openedIdentity: PathIdentity | undefined;
    try {
      try {
        const existingStatus = await lstat(absolutePath);
        if (mode === "r") assertPrivateFile(existingStatus);
        else if (existingStatus.isSymbolicLink()) {
          throw new PathPolicyError("symlink_forbidden", "A state file cannot be a symlink.");
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }

      await invokePathHook(() => this.#hooks.beforeFileOpen?.(absolutePath));
      try {
        if ((await lstat(absolutePath)).isSymbolicLink()) {
          throw new PathPolicyError("symlink_forbidden", "A state file cannot be a symlink.");
        }
      } catch (error) {
        if (isPathPolicyError(error)) throw error;
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
      await this.#directories.validateChain(parentSegments, true);
      const parentBefore = await this.#directories.validateAllowingConcurrentEntries(parent);
      handle = await open(absolutePath, privateOpenFlags(mode), 0o600);
      const handleStatus = await handle.stat();
      assertPrivateFile(handleStatus);
      openedIdentity = identityOf(handleStatus);
      const pathStatus = await lstat(absolutePath);
      assertPrivateFile(pathStatus);
      if (!samePinnedIdentity(openedIdentity, identityOf(pathStatus))) {
        throw new PathPolicyError(
          "path_identity_changed",
          "The opened state file changed identity."
        );
      }
      if (mode === "wx") {
        const parentAfter = identityOf(await lstat(parent));
        if (!sameIdentityExceptLinkCount(parentBefore, parentAfter)) {
          throw new PathPolicyError("path_identity_changed", "The state-file parent changed.");
        }
        this.#directories.set(parent, parentAfter);
      }
      await this.#directories.validateChain(parentSegments, true);
      if (mode === "wx") await this.#directories.syncAllowingConcurrentEntries(parent);
      return handle;
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (mode === "wx" && openedIdentity !== undefined) {
        try {
          const present = identityOf(await lstat(absolutePath));
          if (sameObject(openedIdentity, present)) {
            await unlink(absolutePath);
            await this.#directories.syncAllowingConcurrentEntries(parent);
          }
        } catch {
          // Cleanup cannot safely name a different inode.
        }
      }
      if (isPathPolicyError(error)) throw error;
      let code: PathPolicyErrorCode = "filesystem_error";
      if (isNodeError(error) && error.code === "ELOOP") code = "symlink_forbidden";
      if (mode === "r") {
        try {
          if ((await lstat(absolutePath)).nlink !== 1) code = "hardlink_forbidden";
        } catch {
          // Preserve the static filesystem classification.
        }
      }
      throw new PathPolicyError(code, "The private state file could not be opened safely.");
    }
  }
}
