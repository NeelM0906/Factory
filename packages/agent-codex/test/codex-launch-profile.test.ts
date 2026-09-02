/**
 * Tests for Codex launch profiles.
 *
 * Two profiles:
 * - codex.app-server: full capabilities (resume, steering, permissions)
 * - codex.exec: minimal capabilities (no resume, no steering, no permissions)
 *
 * Codex `app-server` is marked [experimental] by the CLI (finding 18).
 */

import { describe, expect, it } from "vitest";

import {
  buildAppServerProfile,
  buildExecProfile,
  CODEX_AUTH_VARIABLES,
  type AppServerProfileOptions,
  type ExecProfileOptions
} from "../src/codex-launch-profile.js";

describe("codex-launch-profile", () => {
  describe("app-server profile", () => {
    const defaults: AppServerProfileOptions = {
      executable: "/opt/homebrew/bin/codex",
      cwd: "/tmp/workspace"
    };

    it("produces array-built argv with app-server subcommand", () => {
      const profile = buildAppServerProfile(defaults);
      expect(profile.args[0]).toBe("app-server");
      expect(Array.isArray(profile.args)).toBe(true);
    });

    it("declares full capabilities", () => {
      const profile = buildAppServerProfile(defaults);
      expect(profile.descriptor.capabilities.resume).toBe(true);
      expect(profile.descriptor.capabilities.steering).toBe(true);
      expect(profile.descriptor.capabilities.permissions).toBe(true);
    });

    it("has kind codex", () => {
      const profile = buildAppServerProfile(defaults);
      expect(profile.descriptor.kind).toBe("codex");
    });

    it("does not include dangerous bypass flags", () => {
      const profile = buildAppServerProfile(defaults);
      const argv = profile.args.join(" ");
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain("--dangerously-bypass-hook-trust");
    });

    it("derives model selection from D-9 options", () => {
      const profile = buildAppServerProfile({
        ...defaults,
        model: "gpt-5.6-luna",
        reasoningEffort: "high"
      });
      const joined = profile.args.join(" ");
      expect(joined).toContain("-m");
      expect(joined).toContain("gpt-5.6-luna");
      expect(joined).toContain("--reasoning-effort");
      expect(joined).toContain("high");
    });

    it("includes MCP server config override", () => {
      const profile = buildAppServerProfile(defaults);
      const idx = profile.args.indexOf("-c");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(profile.args[idx + 1]).toBe("mcp_servers={}");
    });
  });

  describe("exec profile", () => {
    const defaults: ExecProfileOptions = {
      executable: "/opt/homebrew/bin/codex",
      objective: "Read the README",
      cwd: "/tmp/workspace"
    };

    it("produces array-built argv with exec subcommand and --json flag", () => {
      const profile = buildExecProfile(defaults);
      expect(profile.args[0]).toBe("exec");
      expect(profile.args).toContain("--json");
      expect(Array.isArray(profile.args)).toBe(true);
    });

    it("includes the objective in argv", () => {
      const profile = buildExecProfile(defaults);
      expect(profile.args).toContain("Read the README");
    });

    it("declares minimal capabilities", () => {
      const profile = buildExecProfile(defaults);
      expect(profile.descriptor.capabilities.resume).toBe(false);
      expect(profile.descriptor.capabilities.steering).toBe(false);
      expect(profile.descriptor.capabilities.permissions).toBe(false);
    });

    it("has kind codex", () => {
      const profile = buildExecProfile(defaults);
      expect(profile.descriptor.kind).toBe("codex");
    });

    it("does not include dangerous bypass flags", () => {
      const profile = buildExecProfile(defaults);
      const argv = profile.args.join(" ");
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain("--dangerously-bypass-hook-trust");
    });

    it("derives model selection from D-9 options", () => {
      const profile = buildExecProfile({
        ...defaults,
        model: "gpt-5.6-luna"
      });
      const joined = profile.args.join(" ");
      expect(joined).toContain("-m");
      expect(joined).toContain("gpt-5.6-luna");
    });
  });

  describe("auth variables", () => {
    it("exports a frozen list of documented Codex auth variables", () => {
      expect(Array.isArray(CODEX_AUTH_VARIABLES)).toBe(true);
      expect(CODEX_AUTH_VARIABLES.length).toBeGreaterThan(0);
      // Must include OpenAI's key
      expect(CODEX_AUTH_VARIABLES).toContain("OPENAI_API_KEY");
      // Must be frozen
      expect(Object.isFrozen(CODEX_AUTH_VARIABLES)).toBe(true);
    });
  });
});
