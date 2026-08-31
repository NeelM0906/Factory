import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { assertAutoStackBranch } from "../../src/branch-policy.js";
import {
  LIVE_REPOSITORY_FULL_NAME,
  assertLiveRepository,
  assertPullRequestCiFilter,
  liveBranchName,
  readGhToken,
  resolveLiveConfig
} from "./live-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../");
const realCiWorkflowYaml = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

describe("resolveLiveConfig", () => {
  // Guard-test doctrine: the environment's default state is "unset", and unset must resolve to
  // disabled. A looser check (truthy string, `!== "0"`, `Boolean(value)`) would treat any
  // unrelated non-empty value as "live" -- this table exercises exactly those near-miss shapes.
  it.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["true", false],
    ["1 ", false],
    ["1", true]
  ])("AUTOSTACK_LIVE_GITHUB=%p -> enabled=%p", (value, expectedEnabled) => {
    const env: Readonly<Record<string, string | undefined>> = { AUTOSTACK_LIVE_GITHUB: value };
    expect(resolveLiveConfig(env)).toEqual({ enabled: expectedEnabled });
  });

  it("is disabled when the variable is absent from the environment entirely", () => {
    expect(resolveLiveConfig({})).toEqual({ enabled: false });
  });
});

describe("assertLiveRepository", () => {
  it("passes only for the hard-coded repository", () => {
    expect(() => assertLiveRepository(LIVE_REPOSITORY_FULL_NAME)).not.toThrow();
    expect(LIVE_REPOSITORY_FULL_NAME).toBe("NeelM0906/Factory");
  });

  // Guard-test doctrine: a substring or case-insensitive comparison would let a differently-cased
  // fork, or a repository that merely starts with the right name, slip through.
  it.each([
    ["NeelM0906/Other", "wrong repo, right owner"],
    ["Other/Factory", "wrong owner, right repo"],
    ["", "empty string"],
    ["neelm0906/factory", "case variant"],
    ["NeelM0906/Factory ", "trailing whitespace"],
    ["NeelM0906/Factory-fork", "suffixed variant"]
  ])("throws for %s (%s)", (repositoryFullName) => {
    expect(() => assertLiveRepository(repositoryFullName)).toThrow();
  });
});

describe("liveBranchName", () => {
  it("always produces autostack/e2e-<id>", () => {
    expect(liveBranchName("run-1")).toBe("autostack/e2e-run-1");
    expect(liveBranchName("base-abc123")).toBe("autostack/e2e-base-abc123");
  });

  it("produces a branch name that passes the committed assertAutoStackBranch guard", () => {
    expect(() => assertAutoStackBranch(liveBranchName("head-xyz"))).not.toThrow();
    expect(assertAutoStackBranch(liveBranchName("head-xyz"))).toBe("autostack/e2e-head-xyz");
  });
});

describe("assertPullRequestCiFilter", () => {
  it("passes on the worktree's real .github/workflows/ci.yml", () => {
    expect(() => assertPullRequestCiFilter(realCiWorkflowYaml)).not.toThrow();
  });

  it("passes on an equivalent block-list form (not just the real file's inline-array form)", () => {
    const yaml = [
      "on:",
      "  pull_request:",
      "    branches-ignore:",
      "      - autostack/**",
      "      - some-other-pattern"
    ].join("\n");
    expect(() => assertPullRequestCiFilter(yaml)).not.toThrow();
  });

  // Guard-test doctrine: for each rejected shape, ask what a naive `.includes("autostack/**")`
  // implementation would do with it. Every one of these is a case where that naive check would
  // wrongly PASS, which is exactly why each is asserted to throw here instead.
  const rejectedFixtures: ReadonlyArray<readonly [string, string]> = [
    ["no pull_request key at all", ["on:", "  push:", "    branches-ignore: [main]"].join("\n")],
    [
      "bare pull_request: with no filter under it",
      ["on:", "  pull_request:", "  push:", "    branches: [main]"].join("\n")
    ],
    [
      "branches-ignore omitting autostack/**",
      ["on:", "  pull_request:", '    branches-ignore: ["main", "release/**"]'].join("\n")
    ],
    [
      "a branches: allow-list instead of branches-ignore",
      ["on:", "  pull_request:", '    branches: ["autostack/**"]'].join("\n")
    ],
    [
      // The naive `.includes` check is fooled by this: the literal string is present in the
      // file, just never as a real branches-ignore value.
      "autostack/** appears only inside a YAML comment",
      [
        "on:",
        "  pull_request:",
        '    branches-ignore: ["main"]',
        '    # branches-ignore: ["autostack/**"]'
      ].join("\n")
    ],
    [
      // Also fools the naive check: the pattern is real YAML, just attached to the wrong trigger.
      "autostack/** appears only under push:, not under pull_request:",
      [
        "on:",
        "  push:",
        '    branches-ignore: ["autostack/**"]',
        "  pull_request:",
        '    branches-ignore: ["main"]'
      ].join("\n")
    ]
  ];

  it.each(rejectedFixtures)("throws when %s", (_description, yaml) => {
    expect(() => assertPullRequestCiFilter(yaml)).toThrow();
  });

  // These three fixtures are the ones that literally contain the string "autostack/**" -- so a
  // naive `.includes("autostack/**")` implementation would wrongly PASS them, even though the
  // structural check above correctly rejects all of them. (The other three rejected fixtures
  // above don't contain the substring at all -- they fail every implementation, naive or not --
  // so they don't belong in this specific check.)
  it("independently confirms the naive substring check would have been fooled by the branches-allow-list, comment-only, and push-only fixtures", () => {
    const foolsNaiveSubstringCheck = [
      "a branches: allow-list instead of branches-ignore",
      "autostack/** appears only inside a YAML comment",
      "autostack/** appears only under push:, not under pull_request:"
    ];
    for (const [description, yaml] of rejectedFixtures) {
      if (!foolsNaiveSubstringCheck.includes(description)) continue;
      expect(yaml.includes("autostack/**")).toBe(true);
    }
  });
});

describe("readGhToken", () => {
  it('invokes execFile with ("gh", ["auth", "token"]) as executable+args, never a shell string', async () => {
    const execFile = vi.fn(async () => ({ stdout: "gho_" + "a".repeat(36) + "\n", stderr: "" }));
    await readGhToken({ execFile });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith("gh", ["auth", "token"]);
  });

  it("trims the trailing newline gh emits after the token", async () => {
    const token = "gho_" + "b".repeat(36);
    const execFile = vi.fn(async () => ({ stdout: `${token}\n`, stderr: "" }));
    await expect(readGhToken({ execFile })).resolves.toBe(token);
  });

  // Guard-test doctrine: what does the environment return when gh has never been authenticated?
  // A real `gh auth token` on a signed-out machine exits non-zero. If a guard here merely checked
  // "did execFile resolve", an implementation that swallowed the rejection and returned "" would
  // pass -- so the assertion is on the throw itself, not on some looser side effect.
  it("throws when the launcher rejects (non-zero exit), with a message containing none of the failure's stdout", async () => {
    const sensitiveLookingStdout = "gho_PARTIAL_LEAKED_TOKEN_FRAGMENT";
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error("Command failed"), {
        stdout: sensitiveLookingStdout,
        stderr: "error: not logged in to any GitHub hosts"
      });
    });
    await expect(readGhToken({ execFile })).rejects.toThrow();
    try {
      await readGhToken({ execFile });
      expect.unreachable("readGhToken should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(sensitiveLookingStdout);
      expect(message).not.toContain("not logged in");
    }
  });

  // Guard-test doctrine: an implementation that skipped the emptiness check would silently
  // "authenticate" with a blank Authorization value against the live repository.
  it("throws when the trimmed output is empty", async () => {
    const execFile = vi.fn(async () => ({ stdout: "   \n", stderr: "" }));
    await expect(readGhToken({ execFile })).rejects.toThrow();
  });
});
