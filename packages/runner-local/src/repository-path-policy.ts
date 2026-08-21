import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  identityOf,
  isWithin,
  sameObject,
  snapshotStringInput,
  type PathIdentity
} from "./path-security.js";
import {
  AUTOSTACK_PATH_ENFORCEMENT_SCOPE,
  OwnedPathPolicyError as PathPolicyError,
  isPathPolicyError,
  type AutoStackPathEnforcementScope
} from "./path-types.js";

/** Read-only source checkout validation for AutoStack repository inspection. */
export class RepositoryInspectionPathPolicy {
  readonly enforcementScope: AutoStackPathEnforcementScope = AUTOSTACK_PATH_ENFORCEMENT_SCOPE;
  readonly managedWorktreeRoot: string;
  readonly #managedWorktreeIdentity: PathIdentity;

  private constructor(managedWorktreeRoot: string, managedWorktreeIdentity: PathIdentity) {
    this.managedWorktreeRoot = managedWorktreeRoot;
    this.#managedWorktreeIdentity = managedWorktreeIdentity;
  }

  static async create(managedWorktreeRootInput: string): Promise<RepositoryInspectionPathPolicy> {
    try {
      const managedWorktreeRoot = snapshotStringInput(
        managedWorktreeRootInput,
        "state_root_invalid",
        "An absolute managed-worktree root is required."
      );
      if (!isAbsolute(managedWorktreeRoot) || managedWorktreeRoot.includes("\0")) {
        throw new PathPolicyError(
          "state_root_invalid",
          "An absolute managed-worktree root is required."
        );
      }
      const status = await lstat(managedWorktreeRoot);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new PathPolicyError(
          "state_root_invalid",
          "A managed-worktree directory is required."
        );
      }
      const canonicalRoot = await realpath(managedWorktreeRoot);
      const canonicalStatus = await lstat(canonicalRoot);
      if (!sameObject(identityOf(status), identityOf(canonicalStatus))) {
        throw new PathPolicyError("path_identity_changed", "The managed-worktree root changed.");
      }
      return new RepositoryInspectionPathPolicy(canonicalRoot, identityOf(canonicalStatus));
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("filesystem_error", "The managed-worktree root is unavailable.");
    }
  }

  async resolveSource(sourcePathInput: string): Promise<string> {
    try {
      const sourcePath = snapshotStringInput(
        sourcePathInput,
        "invalid_source",
        "An absolute repository source is required."
      );
      if (!isAbsolute(sourcePath) || sourcePath.includes("\0")) {
        throw new PathPolicyError("invalid_source", "An absolute repository source is required.");
      }
      await this.#validateManagedWorktreeRoot();
      const canonicalSource = await realpath(sourcePath);
      const status = await lstat(canonicalSource);
      if (!status.isDirectory()) {
        throw new PathPolicyError("invalid_source", "A repository source directory is required.");
      }
      if (isWithin(this.managedWorktreeRoot, canonicalSource)) {
        throw new PathPolicyError(
          "managed_worktree_source",
          "A managed worktree cannot be selected as a source checkout."
        );
      }
      await this.#validateManagedWorktreeRoot();
      return canonicalSource;
    } catch (error) {
      if (isPathPolicyError(error)) throw error;
      throw new PathPolicyError("invalid_source", "The repository source cannot be inspected.");
    }
  }

  async #validateManagedWorktreeRoot(): Promise<void> {
    const status = await lstat(this.managedWorktreeRoot);
    if (
      status.isSymbolicLink() ||
      !status.isDirectory() ||
      !sameObject(this.#managedWorktreeIdentity, identityOf(status)) ||
      (await realpath(this.managedWorktreeRoot)) !== this.managedWorktreeRoot
    ) {
      throw new PathPolicyError("path_identity_changed", "The managed-worktree root changed.");
    }
  }
}
