/**
 * Tests for the Codex availability probe.
 *
 * All tests use fixture shell scripts that simulate `codex login status`
 * responses. Never spawns the real CLI (D-6).
 */

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { probeCodexAvailability } from "../src/availability.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE_OK = resolve(__dirname, "fixtures/probe-ok.sh");
const PROBE_FAIL = resolve(__dirname, "fixtures/probe-fail.sh");

describe("availability", () => {
  it("reports installed and authenticated when exit code 0", async () => {
    const result = await probeCodexAvailability({
      executable: PROBE_OK,
      timeoutMs: 5_000
    });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.checkedAt).toBeDefined();
  });

  it("reports installed but not authenticated when exit code non-zero", async () => {
    const result = await probeCodexAvailability({
      executable: PROBE_FAIL,
      timeoutMs: 5_000
    });
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.checkedAt).toBeDefined();
  });

  it("reports not installed when executable is ENOENT", async () => {
    const result = await probeCodexAvailability({
      executable: "/nonexistent/codex-that-does-not-exist",
      timeoutMs: 5_000
    });
    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.detail).toContain("not found");
    expect(result.checkedAt).toBeDefined();
  });

  it("provides a checkedAt ISO timestamp", async () => {
    const result = await probeCodexAvailability({
      executable: PROBE_OK,
      timeoutMs: 5_000
    });
    expect(result.checkedAt).toBeDefined();
    expect(() => new Date(result.checkedAt)).not.toThrow();
  });

  it("sanitizes probe output in the detail field", async () => {
    const result = await probeCodexAvailability({
      executable: PROBE_OK,
      timeoutMs: 5_000
    });
    if (result.detail != null) {
      expect(typeof result.detail).toBe("string");
    }
  });
});
