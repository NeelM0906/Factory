import { GitHubBranchPolicyError } from "./errors.js";

const HEADS_PREFIX = "refs/heads/";
const AUTOSTACK_PREFIX = "autostack/";

// git's own ref-name length ceiling is filesystem-dependent, but 255 matches the common
// single-path-component limit and is comfortably below anything AutoStack ever needs to mint.
const MAXIMUM_REF_LENGTH = 255;

// Characters git-check-ref-format forbids anywhere in a ref, beyond the ".." and control-
// character checks below.
const FORBIDDEN_CHARACTERS = ["~", "^", ":", "?", "*", "[", "\\"];

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * A pure subset of `git check-ref-format`'s rules, applied to the already `refs/heads/`-
 * stripped branch name. Not exhaustive of every rule git enforces, but covers every shape this
 * package must refuse: control characters, whitespace, the forbidden punctuation set, `..`
 * anywhere, `@{`, a bare `@`, leading/trailing/doubled slashes, a trailing dot, and any
 * slash-separated component that starts with `.` or ends with `.lock`.
 */
const violatesRefFormat = (branch: string): boolean => {
  if (branch === "") return true;
  if (branch.length > MAXIMUM_REF_LENGTH) return true;
  if (hasControlCharacter(branch)) return true;
  if (/\s/.test(branch)) return true;
  if (FORBIDDEN_CHARACTERS.some((character) => branch.includes(character))) return true;
  if (branch.includes("..")) return true;
  if (branch.includes("@{")) return true;
  if (branch === "@") return true;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return true;
  if (branch.endsWith(".")) return true;
  if (branch.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))) {
    return true;
  }
  return false;
};

/**
 * Normalises `refs/heads/<branch>` to `<branch>`, then enforces both git's ref-format rules and
 * AutoStack's `autostack/`-prefix branch policy. Throws {@link GitHubBranchPolicyError} on any
 * violation and returns the normalised branch name otherwise.
 *
 * This is defence in depth, not caller discipline: every branch-ref operation in
 * `client/branch-refs.ts` calls this BEFORE any network I/O, so a caller cannot reach GitHub
 * with a non-`autostack/` ref even by constructing the request some other way.
 */
export const assertAutoStackBranch = (ref: string): string => {
  const normalized = ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;

  if (violatesRefFormat(normalized)) throw new GitHubBranchPolicyError(ref);
  if (!normalized.startsWith(AUTOSTACK_PREFIX)) throw new GitHubBranchPolicyError(ref);
  if (normalized.length === AUTOSTACK_PREFIX.length) throw new GitHubBranchPolicyError(ref);

  return normalized;
};
