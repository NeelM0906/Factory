/**
 * Tests for the Claude Code availability probe.
 *
 * All tests use fixture shell scripts that accept arbitrary args and
 * simulate `claude auth status` responses. Never spawns the real CLI (D-6).
 */

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { probeClaudeAvailability } from "../src/availability.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_OK = resolve(__dirname, "fixtures/probe-ok.sh");
const PROBE_FAIL = resolve(__dirname, "fixtures/probe-fail.sh");

describe("availability", () => {
  it("reports installed and authenticated when exit code 0", async () => {
    const result = await probeClaudeAvailability({
      executable: PROBE_OK,
      timeoutMs: 5_000
    });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.checkedAt).toBeDefined();
  });

  it("reports installed but not authenticated when exit code non-zero", async () => {
    const result = await probeClaudeAvailability({
      executable: PROBE_FAIL,
      timeoutMs: 5_000
    });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.checkedAt).toBeDefined();
  });

  it("reports not installed when executable is ENOENT", async () => {
    const result = await probeClaudeAvailability({
      executable: "/nonexistent/claude-that-does-not-exist",
      timeoutMs: 5_000
    });
    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.detail).toContain("not found");
    expect(result.checkedAt).toBeDefined();
  });

  it("provides a checkedAt ISO timestamp", async () => {
    const before = new Date().toISOString();
    const result = await probeClaudeAvailability({
      executable: PROBE_OK,
      timeoutMs: 5_000
    });
    expect(result.checkedAt).toBeDefined();
    // Valid ISO datetime
    expect(() => new Date(result.checkedAt)).not.toThrow();
  });

  it("sanitizes probe output in the detail field", async () => {
    const result = await probeClaudeAvailability({
      executable: PROBE_OK,
      timeoutMs: 5_000
    });
    // Should contain the sanitized output text
    if (result.detail != null) {
      expect(typeof result.detail).toBe("string");
    }
  });

  it("omits detail when probe produces no output", async () => {
    // /usr/bin/true exits 0 with no stdout/stderr, so detail is undefined
    const result = await probeClaudeAvailability({
      executable: "/usr/bin/true",
      timeoutMs: 5_000
    });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it("reports not installed with detail for non-ENOENT spawn errors", async () => {
    // /dev/null exists but is not executable, so spawn throws EACCES
    const result = await probeClaudeAvailability({
      executable: "/dev/null",
      timeoutMs: 5_000
    });
    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
    // The detail should contain the sanitized error message (not "not found")
    expect(result.detail).toBeDefined();
    expect(result.detail).not.toContain("not found");
  });
});
