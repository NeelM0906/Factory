import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { createBearerAuth } from "../src/auth.js";
import { deriveLocalWorkspaceId, loadConfig } from "../src/config.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("local bearer authentication", () => {
  const request = async (authorization?: string) => {
    const app = new Hono();
    app.use("*", createBearerAuth(TOKEN));
    app.get("/protected", (context) => context.json({ ok: true }));
    return app.request("/protected", {
      headers: authorization === undefined ? {} : { Authorization: authorization }
    });
  };

  it("accepts the configured bearer token", async () => {
    expect((await request(`Bearer ${TOKEN}`)).status).toBe(200);
  });

  it.each([undefined, "Basic abc", "Bearer wrong", "Bearer"])(
    "returns the same response for missing or invalid authorization %s",
    async (authorization) => {
      const response = await request(authorization);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "unauthorized", message: "Authentication required." }
      });
    }
  );

  it("never reflects the configured token in an error", async () => {
    expect(await (await request(`Bearer ${TOKEN}wrong`)).text()).not.toContain(TOKEN);
  });
});

describe("control-plane configuration", () => {
  it("defaults to loopback port 4318 and a repository-local data directory", () => {
    expect(
      loadConfig({
        AUTOSTACK_LOCAL_API_TOKEN: TOKEN
      })
    ).toMatchObject({ host: "127.0.0.1", port: 4318, token: TOKEN });
  });

  it("rejects short tokens and unapproved non-loopback binding", () => {
    expect(() => loadConfig({ AUTOSTACK_LOCAL_API_TOKEN: "short" })).toThrow(/32 bytes/i);
    expect(() =>
      loadConfig({ AUTOSTACK_LOCAL_API_TOKEN: TOKEN, AUTOSTACK_HOST: "0.0.0.0" })
    ).toThrow(/non-loopback/i);
  });

  it("allows an explicit non-loopback development override", () => {
    expect(
      loadConfig({
        AUTOSTACK_LOCAL_API_TOKEN: TOKEN,
        AUTOSTACK_HOST: "0.0.0.0",
        AUTOSTACK_ALLOW_NON_LOOPBACK: "true"
      }).host
    ).toBe("0.0.0.0");
  });

  it.each(["0", "65536", "1.5", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() => loadConfig({ AUTOSTACK_LOCAL_API_TOKEN: TOKEN, AUTOSTACK_PORT: port })).toThrow(
      /port/i
    );
  });

  it("derives a stable valid local workspace ID from the installation token", () => {
    const workspaceId = deriveLocalWorkspaceId(TOKEN);

    expect(workspaceId).toMatch(/^ws_[0-9a-f-]{36}$/);
    expect(deriveLocalWorkspaceId(TOKEN)).toBe(workspaceId);
    expect(deriveLocalWorkspaceId(`${TOKEN}different`)).not.toBe(workspaceId);
  });
});
