import { describe, expect, it } from "vitest";

import { WorkspaceIdSchema } from "@autostack/contracts";

import { createApp } from "../src/app.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");

describe("local-only control-plane routes", () => {
  const dependencies = {
    store: {} as never,
    executor: { getStatus: () => "idle" as const },
    token: TOKEN,
    workspaceId: WORKSPACE_ID,
    now: () => "2026-08-21T12:00:00.000Z"
  };

  it("does not register the local surface in hosted mode", async () => {
    const app = createApp({ ...dependencies, mode: "hosted" });
    const response = await app.request("/v1/local/environments", {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    expect(response.status).toBe(404);
  });

  it("maps the authenticated inspect route to a named local operation", async () => {
    const app = createApp({
      ...dependencies,
      mode: "local",
      localExecution: {
        inspect: async () => ({
          repositoryIdentity: "github:example/repo",
          canonicalSourcePath: "/repo",
          repositoryCommonDirectory: "/repo/.git",
          resolvedBaseRef: "main",
          sourceCommit: "b".repeat(40),
          dirty: false,
          diagnostics: []
        })
      } as never
    });
    const response = await app.request("/v1/local/repositories/inspect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sourcePath: "/repo", baseRef: "main" })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repositoryIdentity: "github:example/repo" });
  });
});
