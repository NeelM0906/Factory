import { describe, expect, it } from "vitest";

import {
  LocalInspectRequestSchema,
  LocalPrepareRequestSchema,
  LocalStartRequestSchema
} from "../src/local-api.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("caller-safe local API contracts", () => {
  it("accepts stable evidence pins without caller-supplied workspace, digests, or host authority", () => {
    expect(LocalInspectRequestSchema.parse({ sourcePath: "/repo", baseRef: "main" })).toEqual({
      sourcePath: "/repo",
      baseRef: "main"
    });
    const prepare = LocalPrepareRequestSchema.parse({
      runId: `run_${UUID}`,
      approvalId: `apr_${UUID}`,
      environmentAuthorizationId: `envauth_${UUID}`,
      environmentId: `env_${UUID}`,
      sourcePath: "/repo",
      baseRef: "main",
      branchSlug: "feature"
    });
    expect(prepare).not.toHaveProperty("workspaceId");
    expect(prepare).not.toHaveProperty("authorization");
    expect(prepare).not.toHaveProperty("hostToken");
  });

  it("keeps command input as an argv specification and rejects shell strings and hidden authority", () => {
    const request = LocalStartRequestSchema.parse({
      runId: `run_${UUID}`,
      approvalId: `apr_${UUID}`,
      commandAuthorizationId: `cmdauth_${UUID}`,
      environmentId: `env_${UUID}`,
      commandId: `cmd_${UUID}`,
      command: {
        executable: "pnpm",
        args: ["test"],
        cwd: ".",
        environment: [],
        timeoutSeconds: 60,
        terminal: { columns: 120, rows: 40 }
      }
    });
    expect(request.command).toMatchObject({ executable: "pnpm", args: ["test"] });
    expect(() =>
      LocalStartRequestSchema.parse({
        ...request,
        authorization: { digest: "a".repeat(64) }
      })
    ).toThrow();
  });
});
