import { invokePathHook } from "./path-security.js";
import { OwnedPathPolicyError as PathPolicyError, type DataPathPolicyHooks } from "./path-types.js";

export { invokePathHook };

export const admitDirectoryCreation = (value: unknown): boolean => {
  if (typeof value !== "boolean") {
    throw new PathPolicyError("filesystem_error", "A directory-creation policy is invalid.");
  }
  return value;
};

export const snapshotPathPolicyHooks = (hooks: DataPathPolicyHooks): DataPathPolicyHooks => {
  const beforeRootCreate = hooks.beforeRootCreate;
  const beforeRootDirectoryCreate = hooks.beforeRootDirectoryCreate;
  const beforeDirectoryCreate = hooks.beforeDirectoryCreate;
  const beforeFileOpen = hooks.beforeFileOpen;
  const onDarwinCapabilityVerified = hooks.onDarwinCapabilityVerified;
  if (
    [
      beforeRootCreate,
      beforeRootDirectoryCreate,
      beforeDirectoryCreate,
      beforeFileOpen,
      onDarwinCapabilityVerified
    ].some((hook) => hook !== undefined && typeof hook !== "function")
  ) {
    throw new PathPolicyError("filesystem_error", "Path-policy hooks are unavailable.");
  }
  return Object.freeze({
    ...(beforeRootCreate === undefined ? {} : { beforeRootCreate }),
    ...(beforeRootDirectoryCreate === undefined ? {} : { beforeRootDirectoryCreate }),
    ...(beforeDirectoryCreate === undefined ? {} : { beforeDirectoryCreate }),
    ...(beforeFileOpen === undefined ? {} : { beforeFileOpen }),
    ...(onDarwinCapabilityVerified === undefined ? {} : { onDarwinCapabilityVerified })
  });
};
