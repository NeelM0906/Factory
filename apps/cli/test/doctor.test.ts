import { describe, expect, it, vi } from "vitest";

import { runDoctor } from "../src/doctor.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const healthy = {
  service: "autostack-control-plane",
  version: "0.1.0",
  status: "ok",
  storage: { status: "ok", journalMode: "wal", schemaVersion: 1 },
  executor: { status: "idle" }
};

const makeOutput = () => {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (value: string) => void (stdout += value) },
    stderr: { write: (value: string) => void (stderr += value) },
    values: () => ({ stdout, stderr })
  };
};

const responseFetch = (healthResponse: Response, runsResponse = Response.json({ items: [] })) =>
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/health")) {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return healthResponse;
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    return runsResponse;
  });

describe("autostack doctor", () => {
  it("reports a healthy API, storage, schema, and executor", async () => {
    const output = makeOutput();
    const fetch = responseFetch(Response.json(healthy));

    const exitCode = await runDoctor(
      { baseUrl: "http://127.0.0.1:4318", token: TOKEN, json: false },
      { fetch, stdout: output.stdout, stderr: output.stderr }
    );

    expect(exitCode).toBe(0);
    expect(output.values()).toEqual({
      stdout: expect.stringMatching(
        /API: healthy[\s\S]*Storage: ok \(wal\)[\s\S]*Schema: v1[\s\S]*Executor: idle/
      ),
      stderr: ""
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable for a degraded control plane", async () => {
    const output = makeOutput();
    const fetch = responseFetch(
      Response.json(
        {
          ...healthy,
          status: "degraded",
          storage: { ...healthy.storage, status: "degraded" }
        },
        { status: 503 }
      )
    );

    expect(
      await runDoctor(
        { baseUrl: "http://127.0.0.1:4318", token: TOKEN, json: false },
        { fetch, stdout: output.stdout, stderr: output.stderr }
      )
    ).toBe(3);
    expect(output.values().stdout).toContain("API: degraded");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the authentication exit code without exposing the token", async () => {
    const output = makeOutput();
    const fetch = responseFetch(
      Response.json(healthy),
      Response.json(
        { error: { code: "unauthorized", message: "Authentication required." } },
        { status: 401 }
      )
    );

    expect(
      await runDoctor(
        { baseUrl: "http://127.0.0.1:4318", token: TOKEN, json: false },
        { fetch, stdout: output.stdout, stderr: output.stderr }
      )
    ).toBe(2);
    expect(output.values().stderr).toContain("Authentication failed");
    expect(JSON.stringify(output.values())).not.toContain(TOKEN);
  });

  it.each([
    ["connection failure", vi.fn(async () => Promise.reject(new Error(`offline ${TOKEN}`)))],
    ["invalid server data", vi.fn(async () => new Response("not-json"))]
  ])("handles %s as unavailable", async (_label, fetch) => {
    const output = makeOutput();

    expect(
      await runDoctor(
        { baseUrl: "http://127.0.0.1:4318", token: TOKEN, json: false },
        { fetch, stdout: output.stdout, stderr: output.stderr }
      )
    ).toBe(3);
    expect(output.values().stderr).toContain("Control plane unavailable");
    expect(JSON.stringify(output.values())).not.toContain(TOKEN);
  });

  it("emits exactly one machine-readable JSON object", async () => {
    const output = makeOutput();

    expect(
      await runDoctor(
        { baseUrl: "http://127.0.0.1:4318", token: TOKEN, json: true },
        {
          fetch: responseFetch(Response.json(healthy)),
          stdout: output.stdout,
          stderr: output.stderr
        }
      )
    ).toBe(0);
    expect(output.values().stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.values().stdout)).toMatchObject({
      status: "healthy",
      api: "healthy",
      storage: "ok",
      schemaVersion: 1,
      executor: "idle"
    });
    expect(output.values().stderr).toBe("");
  });
});
