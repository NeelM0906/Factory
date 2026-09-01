import { describe, expect, it } from "vitest";

import { GitHubBranchPolicyError } from "../src/errors.js";
import { assertAutoStackBranch } from "../src/branch-policy.js";

describe("assertAutoStackBranch", () => {
  describe("accepted refs", () => {
    it.each([
      ["autostack/run-abc-slug", "autostack/run-abc-slug"],
      ["autostack/e2e-1234", "autostack/e2e-1234"],
      ["refs/heads/autostack/run-1", "autostack/run-1"]
    ])("normalises %s to %s", (input, expected) => {
      expect(assertAutoStackBranch(input)).toBe(expected);
    });
  });

  describe("rejected refs (defence in depth, not caller discipline)", () => {
    const rejectedRefs: readonly string[] = [
      "main",
      "codex/foo",
      "Autostack/x", // case-sensitive -- GitHub refs are
      "autostack", // prefix with no segment
      "autostack/",
      "../autostack/x",
      "autostack/x/../../main",
      "refs/heads/main",
      "autostack/x y", // whitespace
      "",
      `autostack/${"a".repeat(290)}`, // 300 characters total
      "autostack/x~y",
      "autostack/x^y",
      "autostack/x:y",
      "autostack/x?y",
      "autostack/x*y",
      "autostack/x[y",
      "autostack/x\\y",
      "autostack/.hidden", // a segment starting with "."
      "autostack/build.lock", // a segment ending with ".lock"
      "autostack/x\u0007y" // ASCII control character (BEL)
    ];

    it.each(rejectedRefs)("rejects %j", (ref) => {
      expect(() => assertAutoStackBranch(ref)).toThrow(GitHubBranchPolicyError);
    });

    it("names the offending ref on the thrown error", () => {
      let caught: unknown;
      try {
        assertAutoStackBranch("codex/foo");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitHubBranchPolicyError);
      expect((caught as GitHubBranchPolicyError).ref).toBe("codex/foo");
    });
  });
});
