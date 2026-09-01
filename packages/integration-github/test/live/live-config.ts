/**
 * Pure guards for the gated live-GitHub suite (`github-live.test.ts`). This module makes no
 * network calls and spawns no process itself -- `readGhToken` below takes its process launcher as
 * an injected dependency, so this whole file is safe to import, and its own tests safe to run,
 * unconditionally in CI. The gating decision itself (`AUTOSTACK_LIVE_GITHUB === "1"`) lives here
 * too, as `resolveLiveConfig`, so the live suite and its guard tests read the same logic rather
 * than each re-deriving it.
 */

import { assertAutoStackBranch } from "../../src/branch-policy.js";

export interface LiveConfig {
  readonly enabled: boolean;
}

/**
 * Only the exact string `"1"` enables the live suite. Every other value -- unset, `""`, `"0"`,
 * `"true"`, or `"1"` with incidental whitespace (`"1 "`) -- is off. A looser check (truthy string,
 * `Boolean(value)`, `value !== "0"`) would treat an unrelated non-empty environment value as
 * "live", which is exactly the accidental-enablement shape this guard exists to prevent.
 */
export const resolveLiveConfig = (
  env: Readonly<Record<string, string | undefined>>
): LiveConfig => ({
  enabled: env.AUTOSTACK_LIVE_GITHUB === "1"
});

/**
 * The one repository the live suite is permitted to touch. Exported as a single constant (rather
 * than inlined separately in the guard and in the suite) so there is exactly one place that could
 * ever drift.
 */
export const LIVE_REPOSITORY_FULL_NAME = "NeelM0906/Factory";

/**
 * Throws unless `repositoryFullName` is EXACTLY {@link LIVE_REPOSITORY_FULL_NAME}, including case.
 * A case-insensitive or prefix/substring comparison here would let the suite run against a
 * differently-cased fork or a repository that merely starts with the right name.
 */
export const assertLiveRepository = (repositoryFullName: string): void => {
  if (repositoryFullName !== LIVE_REPOSITORY_FULL_NAME) {
    throw new Error(
      `Live GitHub suite is hard-coded to "${LIVE_REPOSITORY_FULL_NAME}"; refusing to run ` +
        `against "${repositoryFullName}".`
    );
  }
};

/**
 * Produces the one branch-name shape the live suite is allowed to create: `autostack/e2e-<id>`.
 * The result is also run through the committed `assertAutoStackBranch` (defense in depth,
 * matching every other branch-ref call site in this package) so a future change to either
 * function's prefix cannot silently drift the two apart.
 */
export const liveBranchName = (id: string): string => assertAutoStackBranch(`autostack/e2e-${id}`);

interface YamlLine {
  readonly indent: number;
  readonly trimmed: string;
}

/**
 * Strips a YAML comment from one line, respecting single- and double-quoted strings so a `#`
 * inside a quoted scalar is never mistaken for a comment marker.
 */
const stripYamlComment = (line: string): string => {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    else if (character === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    else if (character === "#" && !inSingleQuote && !inDoubleQuote) return line.slice(0, index);
  }
  return line;
};

/**
 * Comment-stripped, non-blank lines with their leading-space indent recorded. Blank lines (as
 * written, or left blank once their comment is stripped) are dropped entirely -- they carry no
 * YAML structure and would otherwise need special-casing in every indent comparison below.
 */
const toYamlLines = (yamlText: string): readonly YamlLine[] =>
  yamlText
    .split("\n")
    .map((rawLine) => stripYamlComment(rawLine))
    .map((line) => ({ indent: line.length - line.trimStart().length, trimmed: line.trim() }))
    .filter((line) => line.trimmed !== "");

/**
 * The lines strictly nested under `lines[parentIndex]` -- indent greater than the parent's --
 * stopping at the first line that returns to the parent's indent or shallower.
 */
const blockUnder = (lines: readonly YamlLine[], parentIndex: number): readonly YamlLine[] => {
  const parent = lines[parentIndex];
  if (parent === undefined) return [];
  const block: YamlLine[] = [];
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.indent <= parent.indent) break;
    block.push(line);
  }
  return block;
};

const stripListItemQuotes = (value: string): string => value.trim().replace(/^['"]|['"]$/g, "");

const extractInlineListItems = (inlineList: string): readonly string[] =>
  inlineList
    .split(",")
    .map((item) => stripListItemQuotes(item))
    .filter((item) => item !== "");

/**
 * The string values of a YAML list-valued key, searched only within `lines` (a caller-scoped
 * block, never the whole document): either the inline form (`key: [a, "b"]`) or the block form
 * (`key:` followed by `- item` lines indented under it). Returns `undefined` when the key itself
 * is absent from `lines`.
 */
const findListValues = (
  lines: readonly YamlLine[],
  keyName: string
): readonly string[] | undefined => {
  const keyIndex = lines.findIndex((line) => line.trimmed.startsWith(`${keyName}:`));
  if (keyIndex === -1) return undefined;
  const line = lines[keyIndex];
  if (line === undefined) return undefined;

  const inlineMatch = new RegExp(`^${keyName}:\\s*\\[(.*)\\]\\s*$`).exec(line.trimmed);
  if (inlineMatch !== null) return extractInlineListItems(inlineMatch[1] ?? "");

  return blockUnder(lines, keyIndex)
    .filter((entry) => entry.trimmed.startsWith("- "))
    .map((entry) => stripListItemQuotes(entry.trimmed.slice(2)));
};

/**
 * Structural (not substring) check that the worktree's CI workflow keeps the `pull_request`
 * trigger from firing on `autostack/**` branches -- the precondition that stops a live PR opened
 * by this suite from starting the full CI matrix, including the 60-minute macOS job (coordinator
 * ruling on E-1, finding 7).
 *
 * REJECTED implementation: `workflowYamlText.includes("autostack/**")`. That passes on a file
 * where the literal string appears anywhere at all -- inside a comment, under an unrelated
 * `push:` trigger, or as a `branches:` allow-list (which has the OPPOSITE effect of
 * `branches-ignore`: it would restrict the trigger to ONLY `autostack/**` pull requests rather
 * than excluding them). This function instead parses just enough of the YAML's block structure to
 * require the literal string appear as a list item of a `branches-ignore:` key nested specifically
 * under `pull_request:`.
 */
export const assertPullRequestCiFilter = (workflowYamlText: string): void => {
  const lines = toYamlLines(workflowYamlText);
  const pullRequestIndex = lines.findIndex((line) => line.trimmed === "pull_request:");
  if (pullRequestIndex === -1) {
    throw new Error(
      'CI workflow has no "pull_request:" trigger; cannot verify the autostack/** exclusion filter.'
    );
  }

  const pullRequestBlock = blockUnder(lines, pullRequestIndex);
  const branchesIgnore = findListValues(pullRequestBlock, "branches-ignore");
  if (branchesIgnore === undefined) {
    throw new Error(
      'CI workflow\'s "pull_request:" trigger has no "branches-ignore:" filter; a live PR would ' +
        "start the full CI matrix, including the 60-minute macOS job."
    );
  }

  if (!branchesIgnore.includes("autostack/**")) {
    throw new Error(
      'CI workflow\'s "pull_request: branches-ignore" filter does not list "autostack/**"; a ' +
        "live PR would start the full CI matrix, including the 60-minute macOS job."
    );
  }
};

export interface ExecFileLauncher {
  (
    executable: string,
    args: readonly string[]
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

export interface ReadGhTokenDependencies {
  readonly execFile: ExecFileLauncher;
}

/**
 * Reads the current `gh` CLI auth token by spawning `gh auth token` through an injected launcher
 * -- `execFile("gh", ["auth", "token"])`, executable and args, never a shell string, so no value
 * ever passes through a shell where it could be word-split or interpreted. `gh` emits a token
 * (e.g. a 40-character `gho_...` value) followed by a trailing newline, so the output is trimmed
 * before use.
 *
 * On failure, the thrown message is a fixed string that never interpolates the underlying error's
 * stdout or stderr: `gh` failure output could itself carry partial token material, and repeating
 * it into a new error's message would defeat the "never logged, stored, or committed" rule just
 * as surely as logging the token directly.
 */
export const readGhToken = async (deps: ReadGhTokenDependencies): Promise<string> => {
  let result: { readonly stdout: string; readonly stderr: string };
  try {
    result = await deps.execFile("gh", ["auth", "token"]);
  } catch {
    throw new Error('"gh auth token" failed; run "gh auth login" and retry.');
  }

  const token = result.stdout.trim();
  if (token === "") {
    throw new Error('"gh auth token" produced no output.');
  }
  return token;
};
