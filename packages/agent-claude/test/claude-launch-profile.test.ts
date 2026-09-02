/**
 * Tests for Claude Code launch profiles.
 *
 * Two profiles:
 * - claude-code.streaming: full interactive session with resume, steering, and permissions
 * - claude-code.batch: non-interactive batch run with no capabilities
 */

import { describe, expect, it } from "vitest";

import {
  buildStreamingProfile,
  buildBatchProfile,
  CLAUDE_AUTH_VARIABLES,
  type ClaudeLaunchProfile
} from "../src/claude-launch-profile.js";

describe("claude-launch-profile", () => {
  const EXECUTABLE = "/opt/homebrew/bin/claude";

  describe("claude-code.streaming", () => {
    it("builds an argv array with the correct flags", () => {
      const profile = buildStreamingProfile({
        executable: EXECUTABLE,
        objective: "Print README.md",
        sessionId: "11111111-2222-4333-8444-555555555555",
        cwd: "/tmp/workspace"
      });

      expect(profile.executable).toBe(EXECUTABLE);
      // Must be an array, not a shell string
      expect(Array.isArray(profile.args)).toBe(true);
      expect(profile.args.join(" ")).not.toContain("&&");
      expect(profile.args.join(" ")).not.toContain("$(");

      // Expected flags
      expect(profile.args).toContain("-p");
      expect(profile.args).toContain("--output-format");
      expect(profile.args).toContain("stream-json");
      expect(profile.args).toContain("--input-format");
      expect(profile.args).toContain("stream-json");
      expect(profile.args).toContain("--verbose");
      expect(profile.args).toContain("--session-id");
      expect(profile.args).toContain("11111111-2222-4333-8444-555555555555");
      expect(profile.args).toContain("--permission-mode");
      expect(profile.args).toContain("manual");
    });

    it("passes the objective as a trailing argument, not interpolated into a flag", () => {
      const profile = buildStreamingProfile({
        executable: EXECUTABLE,
        objective: "Do something; rm -rf /",
        sessionId: "11111111-2222-4333-8444-555555555555",
        cwd: "/tmp/workspace"
      });

      // The objective must be its own array element, never part of a flag value
      const objIdx = profile.args.indexOf("Do something; rm -rf /");
      expect(objIdx).toBeGreaterThan(-1);
      // The element before it should NOT be a flag that the objective is a value of
      // (it should be the last positional argument)
      const prev = profile.args[objIdx - 1];
      expect(prev).not.toMatch(/^--/);
    });

    it("uses the adapter-minted session id for provider session identity", () => {
      const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const profile = buildStreamingProfile({
        executable: EXECUTABLE,
        objective: "test",
        sessionId: sid,
        cwd: "/tmp/workspace"
      });

      const idx = profile.args.indexOf("--session-id");
      expect(idx).toBeGreaterThan(-1);
      expect(profile.args[idx + 1]).toBe(sid);
    });

    it("declares resume, steering, and permissions capabilities", () => {
      const profile = buildStreamingProfile({
        executable: EXECUTABLE,
        objective: "test",
        sessionId: "11111111-2222-4333-8444-555555555555",
        cwd: "/tmp/workspace"
      });

      expect(profile.descriptor.capabilities.resume).toBe(true);
      expect(profile.descriptor.capabilities.steering).toBe(true);
      expect(profile.descriptor.capabilities.permissions).toBe(true);
    });

    it("has a descriptive adapterId and kind", () => {
      const profile = buildStreamingProfile({
        executable: EXECUTABLE,
        objective: "test",
        sessionId: "11111111-2222-4333-8444-555555555555",
        cwd: "/tmp/workspace"
      });

      expect(profile.descriptor.adapterId).toBe("claude-code/streaming");
      expect(profile.descriptor.kind).toBe("claude");
    });

    it("supports model selection via --model flag", () => {
      const profile = buildStreamingProfile({
        executable: EXECUTABLE,
        objective: "test",
        sessionId: "11111111-2222-4333-8444-555555555555",
        cwd: "/tmp/workspace",
        model: "claude-sonnet-4-20250514"
      });

      const idx = profile.args.indexOf("--model");
      expect(idx).toBeGreaterThan(-1);
      expect(profile.args[idx + 1]).toBe("claude-sonnet-4-20250514");
    });

    it("supports resume via --resume flag", () => {
      const profile = buildStreamingProfile({
        executable: EXECUTABLE,
        objective: "continue",
        sessionId: "11111111-2222-4333-8444-555555555555",
        cwd: "/tmp/workspace",
        resume: true
      });

      expect(profile.args).toContain("--resume");
    });
  });

  describe("claude-code.batch", () => {
    it("builds a minimal argv with no session-id or permission flags", () => {
      const profile = buildBatchProfile({
        executable: EXECUTABLE,
        objective: "Print README.md",
        cwd: "/tmp/workspace"
      });

      expect(profile.executable).toBe(EXECUTABLE);
      expect(Array.isArray(profile.args)).toBe(true);
      expect(profile.args).toContain("-p");
      expect(profile.args).toContain("--output-format");
      expect(profile.args).toContain("stream-json");
      expect(profile.args).toContain("--verbose");

      // Batch has no session-id, no input-format, no permission-mode
      expect(profile.args).not.toContain("--session-id");
      expect(profile.args).not.toContain("--input-format");
      expect(profile.args).not.toContain("--permission-mode");
    });

    it("declares no capabilities", () => {
      const profile = buildBatchProfile({
        executable: EXECUTABLE,
        objective: "test",
        cwd: "/tmp/workspace"
      });

      expect(profile.descriptor.capabilities.resume).toBe(false);
      expect(profile.descriptor.capabilities.steering).toBe(false);
      expect(profile.descriptor.capabilities.permissions).toBe(false);
    });

    it("has a batch adapterId", () => {
      const profile = buildBatchProfile({
        executable: EXECUTABLE,
        objective: "test",
        cwd: "/tmp/workspace"
      });

      expect(profile.descriptor.adapterId).toBe("claude-code/batch");
      expect(profile.descriptor.kind).toBe("claude");
    });

    it("supports model selection via --model flag", () => {
      const profile = buildBatchProfile({
        executable: EXECUTABLE,
        objective: "test",
        cwd: "/tmp/workspace",
        model: "claude-sonnet-4-20250514"
      });

      const idx = profile.args.indexOf("--model");
      expect(idx).toBeGreaterThan(-1);
      expect(profile.args[idx + 1]).toBe("claude-sonnet-4-20250514");
    });
  });

  describe("CLAUDE_AUTH_VARIABLES", () => {
    it("includes the documented Claude Code auth variables", () => {
      // D-5: documented auth variables from Task 1
      expect(CLAUDE_AUTH_VARIABLES).toContain("ANTHROPIC_API_KEY");
      expect(CLAUDE_AUTH_VARIABLES).toContain("CLAUDE_CODE_USE_BEDROCK");
      expect(CLAUDE_AUTH_VARIABLES).toContain("CLAUDE_CODE_USE_VERTEX");
      // Array, not a mutable reference
      expect(Object.isFrozen(CLAUDE_AUTH_VARIABLES)).toBe(true);
    });
  });
});
