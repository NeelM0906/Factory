import type { RepositoryInspection } from "@autostack/contracts";

import type { ProcessRunner } from "./process-runner.js";

export type GitClientErrorCode =
  | "invalid_request"
  | "unsafe_git_executable"
  | "unsafe_private_config"
  | "unsafe_process_state"
  | "invalid_repository"
  | "shallow_repository"
  | "missing_ref"
  | "ambiguous_ref"
  | "unsafe_repository"
  | "unsafe_remote"
  | "config_changed"
  | "branch_conflict"
  | "git_failed"
  | "malformed_output";

const GIT_ERROR_MESSAGES = Object.freeze({
  invalid_request: "The Git operation request is invalid.",
  unsafe_git_executable: "The Git executable is unsafe.",
  unsafe_private_config: "The private Git configuration root is unsafe.",
  unsafe_process_state: "The Git process state is unsafe.",
  invalid_repository: "The repository cannot be inspected.",
  shallow_repository: "Shallow repositories are not supported.",
  missing_ref: "The requested Git reference does not exist.",
  ambiguous_ref: "The requested Git reference is ambiguous.",
  unsafe_repository: "The repository configuration is unsafe.",
  unsafe_remote: "The repository remote is unsafe.",
  config_changed: "The repository configuration changed.",
  branch_conflict: "The AutoStack branch conflicts with repository state.",
  git_failed: "The Git operation failed.",
  malformed_output: "Git returned malformed output."
} satisfies Readonly<Record<GitClientErrorCode, string>>);

const internalGitErrorCodes = new WeakMap<object, GitClientErrorCode>();

export class GitClientError extends Error {
  readonly code: GitClientErrorCode;

  constructor(code: GitClientErrorCode, _untrustedMessage?: string) {
    const admittedCode = Object.hasOwn(GIT_ERROR_MESSAGES, code) ? code : "invalid_request";
    super(GIT_ERROR_MESSAGES[admittedCode]);
    this.name = "GitClientError";
    this.code = admittedCode;
    Object.freeze(this);
  }
}

class InternalGitClientError extends Error {
  readonly code: GitClientErrorCode;

  constructor(code: GitClientErrorCode) {
    super(GIT_ERROR_MESSAGES[code]);
    this.code = code;
    internalGitErrorCodes.set(this, code);
    Object.freeze(this);
  }
}

export const gitError = (code: GitClientErrorCode): InternalGitClientError =>
  new InternalGitClientError(code);

export const internalGitErrorCode = (error: unknown): GitClientErrorCode | undefined =>
  (typeof error === "object" && error !== null) || typeof error === "function"
    ? internalGitErrorCodes.get(error)
    : undefined;

export const isOwnedGitError = (error: unknown): error is InternalGitClientError =>
  internalGitErrorCode(error) !== undefined;

export const materializeGitError = (error: unknown, fallback: GitClientErrorCode): GitClientError =>
  new GitClientError(internalGitErrorCode(error) ?? fallback);

export type GitProcessRunner = ProcessRunner;

export interface GitClientOptions {
  readonly managedWorktreeRoot: string;
  readonly privateConfigRoot: string;
  /** Explicit trusted dependency for portable tests; production omits it. */
  readonly trustedGitExecutable?: string;
  /** Explicit process dependency for tests; production uses BoundedProcessRunner. */
  readonly processRunner?: GitProcessRunner;
}

export interface InspectedGitRepository {
  readonly inspection: RepositoryInspection;
  readonly safeConfigDigest: string;
}

export interface GitWorktreeRecord {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly lockedReason?: string;
  readonly prunableReason?: string;
  readonly bare: boolean;
  readonly detached: boolean;
}

export interface AddLockedWorktreeRequest {
  readonly sourcePath: string;
  readonly expectedSafeConfigDigest: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly commit: string;
}

export interface ManagedWorktreeRequest {
  readonly sourcePath: string;
  readonly worktreePath: string;
}

export interface GitWorktreeInspection {
  readonly head: string;
  readonly branch: string;
  readonly dirty: boolean;
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface PrivateConfiguration {
  readonly root: string;
  readonly rootIdentity: FileIdentity;
  readonly home: string;
  readonly homeIdentity: FileIdentity;
  readonly xdg: string;
  readonly xdgIdentity: FileIdentity;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
}

export interface LocalConfiguration {
  readonly digest: string;
  readonly remoteIdentity?: string;
}

export interface AdmittedAddRequest {
  readonly sourcePath: string;
  readonly expectedSafeConfigDigest: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly commit: string;
}
