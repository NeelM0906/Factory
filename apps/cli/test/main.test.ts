import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/main.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

const makeDependencies = () => {
  let stdout = "";
  let stderr = "";
  const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
    String(input).endsWith("/v1/health")
      ? Response.json({
          service: "autostack-control-plane",
          version: "0.1.0",
          status: "ok",
          storage: { status: "ok", journalMode: "wal", schemaVersion: 1 },
          executor: { status: "idle" }
        })
      : Response.json({ items: [] })
  );
  return {
    dependencies: {
      fetch,
      stdout: { write: (value: string) => void (stdout += value) },
      stderr: { write: (value: string) => void (stderr += value) },
      environment: {} as Readonly<Record<string, string | undefined>>
    },
    values: () => ({ stdout, stderr })
  };
};

describe("AutoStack CLI", () => {
  it("prints help and version", async () => {
    const help = makeDependencies();
    const version = makeDependencies();

    expect(await runCli(["--help"], help.dependencies)).toBe(0);
    expect(help.values().stdout).toContain("autostack doctor");
    expect(help.values().stdout).not.toContain("--token");
    expect(await runCli(["--version"], version.dependencies)).toBe(0);
    expect(version.values().stdout).toBe("0.1.0\n");
  });

  it("uses environment defaults for doctor", async () => {
    const harness = makeDependencies();
    harness.dependencies.environment = {
      AUTOSTACK_URL: "http://127.0.0.1:4318",
      AUTOSTACK_LOCAL_API_TOKEN: TOKEN
    };

    expect(await runCli(["doctor"], harness.dependencies)).toBe(0);
    expect(harness.values().stdout).toContain("API: healthy");
  });

  it("rejects the removed --token option even when an environment token exists", async () => {
    const harness = makeDependencies();
    harness.dependencies.environment = {
      AUTOSTACK_URL: "http://127.0.0.1:4318",
      AUTOSTACK_LOCAL_API_TOKEN: TOKEN
    };

    expect(
      await runCli(["doctor", "--token", "flag-token-that-must-not-win"], harness.dependencies)
    ).toBe(1);
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
    expect(harness.values().stderr).toContain("Usage error");
    expect(JSON.stringify(harness.values())).not.toContain(TOKEN);
    expect(JSON.stringify(harness.values())).not.toContain("flag-token-that-must-not-win");
  });

  it("rejects plaintext HTTP for non-loopback hosts", async () => {
    const harness = makeDependencies();
    harness.dependencies.environment = { AUTOSTACK_LOCAL_API_TOKEN: TOKEN };

    expect(await runCli(["doctor", "--url", "http://example.com"], harness.dependencies)).toBe(1);
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });

  it.each([["unknown"], ["doctor", "extra"]])(
    "returns a stable usage error for invalid arguments",
    async (...arguments_) => {
      const harness = makeDependencies();

      expect(await runCli(arguments_, harness.dependencies)).toBe(1);
      expect(harness.values().stderr).toContain("Usage error");
      expect(JSON.stringify(harness.values())).not.toContain(TOKEN);
    }
  );
});
