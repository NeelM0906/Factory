import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { fileIdentity, sameDirectoryIdentity } from "./git-client-admission.js";
import { gitError, isOwnedGitError, type FileIdentity } from "./git-client-types.js";

export interface PinnedAbsentManagedTarget {
  readonly path: string;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
}

class MutationBroker {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const mutationBroker = new MutationBroker();

export const pinAbsentManagedTarget = async (
  path: string,
  validateAbsentTarget: (path: string) => Promise<string>
): Promise<PinnedAbsentManagedTarget> => {
  const admittedPath = await validateAbsentTarget(path);
  const parent = resolve(admittedPath, "..");
  const canonicalParent = await realpath(parent);
  const status = await lstat(canonicalParent);
  if (
    canonicalParent !== parent ||
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0
  ) {
    throw gitError("invalid_request");
  }
  return Object.freeze({
    path: admittedPath,
    parent,
    parentIdentity: fileIdentity(status)
  });
};

export const validatePinnedAbsentManagedTarget = async (
  target: PinnedAbsentManagedTarget,
  validateManagedRoot: () => Promise<void>
): Promise<void> => {
  await validateManagedRoot();
  const canonicalParent = await realpath(target.parent);
  const status = await lstat(canonicalParent);
  if (
    canonicalParent !== target.parent ||
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    !sameDirectoryIdentity(fileIdentity(status), target.parentIdentity) ||
    resolve(canonicalParent, target.path.slice(target.parent.length + 1)) !== target.path
  ) {
    throw gitError("invalid_request");
  }
  try {
    await lstat(target.path);
    throw gitError("invalid_request");
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { readonly code?: unknown }).code !== "ENOENT"
    ) {
      throw gitError("invalid_request");
    }
  }
  await validateManagedRoot();
};
