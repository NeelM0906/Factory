import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  assertNoUserSymlinkComponents,
  assertPrivateDirectory,
  createMissingRoot,
  existingNearestAncestor,
  identityOf,
  isNodeError,
  snapshotStringInput,
  verifyDarwinOpenCapabilities,
  type PathIdentity
} from "./path-security.js";
import { snapshotPathPolicyHooks } from "./path-policy-hooks.js";
import { OwnedPathPolicyError as PathPolicyError, type DataPathPolicyHooks } from "./path-types.js";

export interface AdmittedDataPathRoot {
  readonly root: string;
  readonly identity: PathIdentity;
  readonly hooks: DataPathPolicyHooks;
}

export const admitDataPathRoot = async (
  rootInput: string,
  hooksInput: DataPathPolicyHooks,
  createIfMissing: boolean
): Promise<AdmittedDataPathRoot> => {
  const hooks = snapshotPathPolicyHooks(hooksInput);
  const root = snapshotStringInput(
    rootInput,
    "state_root_invalid",
    "An absolute state root is required."
  );
  if (!isAbsolute(root) || root.includes("\0")) {
    throw new PathPolicyError("state_root_invalid", "An absolute state root is required.");
  }
  const absoluteRoot = resolve(root);
  await assertNoUserSymlinkComponents(absoluteRoot);
  let canonicalRoot: string;
  try {
    const existing = await lstat(absoluteRoot);
    assertPrivateDirectory(existing, "state_root_invalid");
    canonicalRoot = await realpath(absoluteRoot);
  } catch (error) {
    if (!createIfMissing || !isNodeError(error) || error.code !== "ENOENT") throw error;
    const nearest = await existingNearestAncestor(absoluteRoot);
    canonicalRoot = await createMissingRoot(
      absoluteRoot,
      nearest,
      hooks.beforeRootCreate,
      hooks.beforeRootDirectoryCreate
    );
  }
  if (createIfMissing) {
    await verifyDarwinOpenCapabilities(canonicalRoot, hooks.onDarwinCapabilityVerified);
  }
  const rootStatus = await lstat(canonicalRoot);
  assertPrivateDirectory(rootStatus, "state_root_invalid");
  if ((await realpath(canonicalRoot)) !== canonicalRoot) {
    throw new PathPolicyError("state_root_invalid", "The state root is not canonical.");
  }
  return Object.freeze({ root: canonicalRoot, identity: identityOf(rootStatus), hooks });
};
