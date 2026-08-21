import type { ProcessRunResult } from "./process-runner.js";
import { isAbsolute } from "node:path";
import {
  gitError,
  isOwnedGitError,
  materializeGitError,
  type GitWorktreeRecord
} from "./git-client-types.js";

const MAXIMUM_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAXIMUM_WORKTREE_RECORDS = 4_096;
const PROCESS_SIGNALS = new Set<string>([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINFO",
  "SIGINT",
  "SIGIO",
  "SIGKILL",
  "SIGPIPE",
  "SIGPROF",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGWINCH",
  "SIGXCPU",
  "SIGXFSZ"
]);

export const decodeSingleLine = (value: string, maximumLength = 8_192): string => {
  if (
    value.length === 0 ||
    value.length > maximumLength + 1 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("�")
  ) {
    throw gitError("malformed_output");
  }
  const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (trimmed.length === 0 || trimmed.length > maximumLength || trimmed.includes("\n")) {
    throw gitError("malformed_output");
  }
  return trimmed;
};

export const processResult = (value: unknown): ProcessRunResult => {
  try {
    if (typeof value !== "object" || value === null) throw gitError("git_failed");
    const candidate = value as Partial<ProcessRunResult>;
    const exitCode = candidate.exitCode;
    const signal = candidate.signal;
    const stdout = candidate.stdout;
    const stderr = candidate.stderr;
    if (
      (exitCode !== null &&
        (!Number.isSafeInteger(exitCode) ||
          (exitCode as number) < 0 ||
          (exitCode as number) > 255)) ||
      (signal !== null && (typeof signal !== "string" || !PROCESS_SIGNALS.has(signal))) ||
      (exitCode === null) === (signal === null) ||
      typeof stdout !== "string" ||
      typeof stderr !== "string" ||
      Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAXIMUM_GIT_OUTPUT_BYTES
    ) {
      throw gitError("git_failed");
    }
    return Object.freeze({ exitCode: exitCode as number | null, signal, stdout, stderr });
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    throw gitError("git_failed");
  }
};

const malformedWorktreeOutput = (): never => {
  throw gitError("malformed_output");
};

const validBranchReference = (value: string): boolean => {
  if (!value.startsWith("refs/heads/") || value.length > 512) return false;
  const branch = value.slice("refs/heads/".length);
  const invalidCharacter = [...branch].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      "~^:?*[\\".includes(character)
    );
  });
  const segments = branch.split("/");
  return (
    branch.length > 0 &&
    !invalidCharacter &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.endsWith(".") &&
    segments.every(
      (segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".lock")
    )
  );
};

/** Internal parser retaining immutable failure classification for GitClient composition. */
export const parseWorktreePorcelainZInternal = (
  outputInput: string
): readonly GitWorktreeRecord[] => {
  try {
    if (
      typeof outputInput !== "string" ||
      Buffer.byteLength(outputInput) > MAXIMUM_GIT_OUTPUT_BYTES ||
      outputInput.includes("�") ||
      !outputInput.endsWith("\0\0")
    ) {
      return malformedWorktreeOutput();
    }
    const recordTexts = outputInput.slice(0, -2).split("\0\0");
    if (recordTexts.length > MAXIMUM_WORKTREE_RECORDS) return malformedWorktreeOutput();
    const records: GitWorktreeRecord[] = [];
    const seenPaths = new Set<string>();
    for (const recordText of recordTexts) {
      const fields = recordText.split("\0");
      const seen = new Set<string>();
      let path: string | undefined;
      let head: string | undefined;
      let branch: string | undefined;
      let lockedReason: string | undefined;
      let prunableReason: string | undefined;
      let bare = false;
      let detached = false;
      for (const field of fields) {
        if (field.length === 0 || field.length > 8_192) return malformedWorktreeOutput();
        const separator = field.indexOf(" ");
        const name = separator < 0 ? field : field.slice(0, separator);
        const value = separator < 0 ? "" : field.slice(separator + 1);
        if (seen.has(name)) return malformedWorktreeOutput();
        seen.add(name);
        switch (name) {
          case "worktree":
            if (!isAbsolute(value) || value.includes("\0")) return malformedWorktreeOutput();
            path = value;
            break;
          case "HEAD":
            if (!/^[0-9a-f]{40}$/.test(value)) return malformedWorktreeOutput();
            head = value;
            break;
          case "branch":
            if (!validBranchReference(value)) {
              return malformedWorktreeOutput();
            }
            branch = value;
            break;
          case "locked":
            if (value.length > 1_024) return malformedWorktreeOutput();
            lockedReason = value;
            break;
          case "prunable":
            if (value.length > 1_024) return malformedWorktreeOutput();
            prunableReason = value;
            break;
          case "bare":
            if (value !== "") return malformedWorktreeOutput();
            bare = true;
            break;
          case "detached":
            if (value !== "") return malformedWorktreeOutput();
            detached = true;
            break;
          default:
            return malformedWorktreeOutput();
        }
      }
      const branchAttached = branch !== undefined;
      if (
        path === undefined ||
        seenPaths.has(path) ||
        (!bare && head === undefined) ||
        (!bare && branchAttached === detached) ||
        (bare && (head !== undefined || branch !== undefined || detached))
      ) {
        return malformedWorktreeOutput();
      }
      seenPaths.add(path);
      records.push(
        Object.freeze({
          path,
          ...(head === undefined ? {} : { head }),
          ...(branch === undefined ? {} : { branch }),
          ...(lockedReason === undefined ? {} : { lockedReason }),
          ...(prunableReason === undefined ? {} : { prunableReason }),
          bare,
          detached
        })
      );
    }
    return Object.freeze(records);
  } catch (error) {
    if (isOwnedGitError(error)) throw error;
    throw gitError("malformed_output");
  }
};

/** Strict public parser for `git worktree list --porcelain -z`. */
export const parseWorktreePorcelainZ = (outputInput: string): readonly GitWorktreeRecord[] => {
  try {
    return parseWorktreePorcelainZInternal(outputInput);
  } catch (error) {
    throw materializeGitError(error, "malformed_output");
  }
};
