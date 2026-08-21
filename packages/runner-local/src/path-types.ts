export type PathPolicyErrorCode =
  | "invalid_relative_path"
  | "invalid_open_mode"
  | "state_root_invalid"
  | "symlink_forbidden"
  | "path_escape"
  | "path_identity_changed"
  | "unsafe_permissions"
  | "hardlink_forbidden"
  | "managed_worktree_source"
  | "invalid_source"
  | "filesystem_error";

const ownedPathPolicyErrors = new WeakSet<object>();

export class PathPolicyError extends Error {
  readonly code: PathPolicyErrorCode;

  constructor(code: PathPolicyErrorCode, message: string) {
    super(message);
    this.name = "PathPolicyError";
    this.code = code;
  }
}

/** Package-internal owned error; the public constructor is intentionally untrusted. */
export class OwnedPathPolicyError extends PathPolicyError {
  constructor(code: PathPolicyErrorCode, message: string) {
    super(code, message);
    ownedPathPolicyErrors.add(this);
  }
}

export const isPathPolicyError = (value: unknown): value is PathPolicyError =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  ownedPathPolicyErrors.has(value);

export type PrivateFileOpenMode = "wx" | "r";

export interface DirectoryCreateContext {
  readonly directoryPath: string;
  readonly parentPath: string;
}

export interface DataPathPolicyHooks {
  readonly beforeRootCreate?: (context: DirectoryCreateContext) => Promise<void> | void;
  readonly beforeRootDirectoryCreate?: (context: DirectoryCreateContext) => Promise<void> | void;
  readonly beforeDirectoryCreate?: (context: DirectoryCreateContext) => Promise<void> | void;
  readonly beforeFileOpen?: (absolutePath: string) => Promise<void> | void;
  readonly onDarwinCapabilityVerified?: (
    capability: "nofollow_any" | "unique_link"
  ) => Promise<void> | void;
}

export const AUTOSTACK_PATH_ENFORCEMENT_SCOPE = "autostack_operations" as const;
export type AutoStackPathEnforcementScope = typeof AUTOSTACK_PATH_ENFORCEMENT_SCOPE;

export const AUTOSTACK_NAMESPACE_MUTATION_PROTECTION = "advisory_same_uid" as const;
export type AutoStackNamespaceMutationProtection = typeof AUTOSTACK_NAMESPACE_MUTATION_PROTECTION;
