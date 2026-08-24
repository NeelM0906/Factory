import { describe, expect, it, vi } from "vitest";

import { runLocalCommand } from "../src/local.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

const harness = () => {
  let stdout = "";
  let stderr = "";
  const client = {
    localStart: vi.fn(async (_request: unknown, _idempotencyKey: string) => ({
      commandId: `cmd_${UUID}`,
      acceptedAt: "2026-08-21T12:00:00.000Z",
      replayed: false
    })),
    localInspect: vi.fn(async (_request: unknown) => ({
      repositoryIdentity: "github:example/repo",
      canonicalSourcePath: "/repo",
      repositoryCommonDirectory: "/repo/.git",
      resolvedBaseRef: "main",
      sourceCommit: "b".repeat(40),
      dirty: false,
      diagnostics: []
    }))
  };
  return {
    dependencies: {
      client: client as never,
      stdout: { write: (value: string) => void (stdout += value) },
      stderr: { write: (value: string) => void (stderr += value) }
    },
    client,
    output: () => ({ stdout, stderr })
  };
};

describe("local CLI", () => {
  it("preserves executable and arguments only after the literal delimiter", async () => {
    const test = harness();
    const result = await runLocalCommand(
      [
        "exec",
        "--run",
        `run_${UUID}`,
        "--approval",
        `apr_${UUID}`,
        "--command-authorization",
        `cmdauth_${UUID}`,
        "--environment",
        `env_${UUID}`,
        "--command-id",
        `cmd_${UUID}`,
        "--idempotency-key",
        "exec-1",
        "--",
        "pnpm",
        "test",
        "--filter",
        "@autostack/contracts"
      ],
      test.dependencies
    );
    expect(result).toBe(0);
    expect(test.client.localStart.mock.calls[0]?.[0]).toMatchObject({
      command: { executable: "pnpm", args: ["test", "--filter", "@autostack/contracts"] }
    });
    expect(test.output().stderr).toBe("");
  });

  it("rejects exec without the literal delimiter and maps inspect without shell parsing", async () => {
    const invalid = harness();
    expect(await runLocalCommand(["exec", "pnpm", "test"], invalid.dependencies)).toBe(1);
    expect(invalid.client.localStart).not.toHaveBeenCalled();

    const inspect = harness();
    expect(
      await runLocalCommand(
        ["inspect", "--repo", "/repo", "--base", "main", "--json"],
        inspect.dependencies
      )
    ).toBe(0);
    expect(inspect.client.localInspect).toHaveBeenCalledWith({
      sourcePath: "/repo",
      baseRef: "main"
    });
    expect(JSON.parse(inspect.output().stdout)).toMatchObject({
      repositoryIdentity: "github:example/repo"
    });
  });
});
