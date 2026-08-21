import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  gitError,
  isOwnedGitError,
  type AddLockedWorktreeRequest,
  type AdmittedAddRequest,
  type FileIdentity,
  type GitClientErrorCode,
  type ManagedWorktreeRequest,
  type PrivateConfiguration
} from "./git-client-types.js";
import { decodeSingleLine } from "./git-client-parsers.js";
import type { ProcessRunResult } from "./process-runner.js";

const SYSTEM_GIT_EXECUTABLE = "/usr/bin/git";
const SYSTEM_TOOLCHAIN_ROOTS = Object.freeze(["/usr/bin", "/System/Library"]);

export const fileIdentity = (status: Stats): FileIdentity =>
  Object.freeze({
    dev: status.dev,
    ino: status.ino,
    mode: status.mode,
    uid: status.uid,
    size: status.size,
    mtimeMs: status.mtimeMs,
    ctimeMs: status.ctimeMs
  });

export const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.uid === right.uid &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export const sameDirectoryIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.uid === right.uid;

export const isWithin = (root: string, candidate: string): boolean => {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
};

const privateDirectoryIdentity = async (path: string): Promise<FileIdentity> => {
  const status = await lstat(path);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0
  ) {
    throw gitError("unsafe_private_config");
  }
  if ((await realpath(path)) !== path) throw gitError("unsafe_private_config");
  return fileIdentity(status);
};

export const createPrivateConfiguration = async (
  rootInput: unknown
): Promise<PrivateConfiguration> => {
  try {
    const root = snapshotAbsolutePath(rootInput);
    const canonicalRoot = await realpath(root);
    if (canonicalRoot !== root) throw gitError("unsafe_private_config");
    const initialEntries = await readdir(root);
    if (initialEntries.some((entry) => entry !== "home" && entry !== "xdg")) {
      throw gitError("unsafe_private_config");
    }
    const home = resolve(root, "home");
    const xdg = resolve(root, "xdg");
    const homeIdentity = await privateDirectoryIdentity(home);
    const xdgIdentity = await privateDirectoryIdentity(xdg);
    const rootIdentity = await privateDirectoryIdentity(root);
    if ((await readdir(home)).length !== 0 || (await readdir(xdg)).length !== 0) {
      throw gitError("unsafe_private_config");
    }
    return Object.freeze({
      root,
      rootIdentity,
      home,
      homeIdentity,
      xdg,
      xdgIdentity,
      environment: Object.freeze([
        Object.freeze({ name: "PATH", value: "/usr/bin:/bin" }),
        Object.freeze({ name: "LANG", value: "C" }),
        Object.freeze({ name: "LC_ALL", value: "C" }),
        Object.freeze({ name: "TMPDIR", value: "/tmp" }),
        Object.freeze({ name: "HOME", value: home }),
        Object.freeze({ name: "XDG_CONFIG_HOME", value: xdg }),
        Object.freeze({ name: "GIT_CONFIG_NOSYSTEM", value: "1" }),
        Object.freeze({ name: "GIT_CONFIG_SYSTEM", value: "/dev/null" }),
        Object.freeze({ name: "GIT_CONFIG_GLOBAL", value: "/dev/null" }),
        Object.freeze({ name: "GIT_TERMINAL_PROMPT", value: "0" }),
        Object.freeze({ name: "GCM_INTERACTIVE", value: "Never" }),
        Object.freeze({ name: "GIT_NO_LAZY_FETCH", value: "1" })
      ])
    });
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    throw gitError("unsafe_private_config");
  }
};

export const validatePrivateConfiguration = async (
  configuration: PrivateConfiguration
): Promise<void> => {
  try {
    const root = await privateDirectoryIdentity(configuration.root);
    const home = await privateDirectoryIdentity(configuration.home);
    const xdg = await privateDirectoryIdentity(configuration.xdg);
    if (
      !sameFileIdentity(root, configuration.rootIdentity) ||
      !sameFileIdentity(home, configuration.homeIdentity) ||
      !sameFileIdentity(xdg, configuration.xdgIdentity) ||
      (await readdir(configuration.root)).some((entry) => entry !== "home" && entry !== "xdg") ||
      (await readdir(configuration.home)).length !== 0 ||
      (await readdir(configuration.xdg)).length !== 0
    ) {
      throw gitError("unsafe_private_config");
    }
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    throw gitError("unsafe_private_config");
  }
};

export const snapshotString = (
  value: unknown,
  maximumLength: number,
  code: GitClientErrorCode = "invalid_request"
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    throw gitError(code);
  }
  return value;
};

export const snapshotAbsolutePath = (value: unknown): string => {
  const path = snapshotString(value, 8_192);
  if (!isAbsolute(path)) throw gitError("invalid_request");
  return resolve(path);
};

export const executableIdentity = async (
  executableInput: unknown,
  requireSystemToolchain: boolean
): Promise<{ readonly path: string; readonly identity: FileIdentity }> => {
  try {
    const requested = snapshotAbsolutePath(executableInput);
    const canonical = await realpath(requested);
    const status = await lstat(canonical);
    if (
      status.isSymbolicLink() ||
      !status.isFile() ||
      (status.mode & 0o111) === 0 ||
      (status.mode & 0o022) !== 0
    ) {
      throw gitError("unsafe_git_executable");
    }
    if (requireSystemToolchain) {
      if (
        process.platform !== "darwin" ||
        requested !== SYSTEM_GIT_EXECUTABLE ||
        status.uid !== 0 ||
        !SYSTEM_TOOLCHAIN_ROOTS.some((root) => isWithin(root, canonical))
      ) {
        throw gitError("unsafe_git_executable");
      }
      let current = canonical;
      while (true) {
        const component = await lstat(current);
        if (component.uid !== 0 || (component.mode & 0o022) !== 0) {
          throw gitError("unsafe_git_executable");
        }
        if (current === "/") break;
        const parent = resolve(current, "..");
        if (parent === current) break;
        current = parent;
      }
    }
    return Object.freeze({ path: canonical, identity: fileIdentity(status) });
  } catch (error) {
    if (isOwnedGitError(error) && error.code !== "invalid_request") throw error;
    throw gitError("unsafe_git_executable");
  }
};

export const validateExecutableIdentity = async (
  executable: string,
  expected: FileIdentity
): Promise<void> => {
  try {
    const canonical = await realpath(executable);
    const status = await lstat(canonical);
    if (
      canonical !== executable ||
      status.isSymbolicLink() ||
      !status.isFile() ||
      (status.mode & 0o111) === 0 ||
      (status.mode & 0o022) !== 0 ||
      !sameFileIdentity(fileIdentity(status), expected)
    ) {
      throw gitError("unsafe_git_executable");
    }
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    throw gitError("unsafe_git_executable");
  }
};

export const safeGeneratedBranch = (value: unknown): string => {
  const branch = snapshotString(value, 250);
  const segments = branch.split("/");
  if (
    !/^autostack\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    segments.some((segment) => segment === "." || segment === ".." || segment.endsWith(".lock"))
  ) {
    throw gitError("invalid_request");
  }
  return branch;
};

export const exactCommit = (value: unknown): string => {
  const commit = snapshotString(value, 40);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw gitError("invalid_request");
  return commit;
};

export const exactDigest = (value: unknown): string => {
  const digest = snapshotString(value, 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw gitError("invalid_request");
  return digest;
};

export const admitAddRequest = (requestInput: AddLockedWorktreeRequest): AdmittedAddRequest => {
  try {
    if (typeof requestInput !== "object" || requestInput === null) {
      throw gitError("invalid_request");
    }
    return Object.freeze({
      sourcePath: snapshotAbsolutePath(requestInput.sourcePath),
      expectedSafeConfigDigest: exactDigest(requestInput.expectedSafeConfigDigest),
      branch: safeGeneratedBranch(requestInput.branch),
      worktreePath: snapshotAbsolutePath(requestInput.worktreePath),
      commit: exactCommit(requestInput.commit)
    });
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    throw gitError("invalid_request");
  }
};

export const snapshotManagedRequest = (
  requestInput: ManagedWorktreeRequest
): ManagedWorktreeRequest => {
  try {
    if (typeof requestInput !== "object" || requestInput === null) {
      throw gitError("invalid_request");
    }
    return Object.freeze({
      sourcePath: snapshotAbsolutePath(requestInput.sourcePath),
      worktreePath: snapshotAbsolutePath(requestInput.worktreePath)
    });
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    throw gitError("invalid_request");
  }
};

export const assertSupportedGitVersion = async (
  runRequired: (args: readonly string[]) => Promise<ProcessRunResult>
): Promise<void> => {
  try {
    const result = await runRequired(["--version"]);
    const version = decodeSingleLine(result.stdout, 128);
    const match =
      /^git version ([0-9]{1,3})\.([0-9]{1,3})(?:\.[0-9]{1,3})?(?: \([A-Za-z0-9 ._+-]+\))?$/.exec(
        version
      );
    if (match === null) throw gitError("unsafe_git_executable");
    const major = Number.parseInt(match[1] ?? "", 10);
    const minor = Number.parseInt(match[2] ?? "", 10);
    if (major < 2 || (major === 2 && minor < 45)) {
      throw gitError("unsafe_git_executable");
    }
  } catch (error) {
    if (
      isOwnedGitError(error) &&
      (error.code === "unsafe_git_executable" || error.code === "unsafe_process_state")
    ) {
      throw error;
    }
    throw gitError("unsafe_git_executable");
  }
};
