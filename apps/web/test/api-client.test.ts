import { describe, expect, it, vi } from "vitest";

import { ApiAuthenticationError, ApiResponseError, createApiClient } from "../src/api-client.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const health = {
  service: "autostack-control-plane",
  version: "0.1.0",
  status: "ok",
  storage: { status: "ok", journalMode: "wal", schemaVersion: 1 },
  executor: { status: "idle" }
};
const run = {
  schemaVersion: 1,
  id: "run_123e4567-e89b-42d3-a456-426614174000",
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174001",
  workItemId: "wi_123e4567-e89b-42d3-a456-426614174002",
  workflowVersion: "foundation-v1",
  status: "queued",
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z"
};
const workItem = {
  schemaVersion: 1,
  id: run.workItemId,
  workspaceId: run.workspaceId,
  source: { kind: "manual", client: "web" },
  title: "Build AutoStack",
  description: "Foundation",
  requester: { externalId: "local-user" },
  attachments: [],
  priority: "normal",
  labels: [],
  acceptanceContext: [],
  createdAt: run.createdAt,
  updatedAt: run.updatedAt
};

describe("AutoStack web API client", () => {
  it("validates public health without attaching credentials", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return Response.json(health);
    });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch });

    await expect(client.health()).resolves.toEqual(health);
    expect(fetch).toHaveBeenCalledWith("/v1/health", expect.any(Object));
  });

  it("authenticates and validates run listing using the current token", async () => {
    const getToken = vi.fn(() => TOKEN);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBe("/v1/runs?cursor=42");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
      return Response.json({ items: [], nextCursor: 21 });
    });

    await expect(createApiClient({ baseUrl: "/", getToken, fetch }).listRuns(42)).resolves.toEqual({
      items: [],
      nextCursor: 21
    });
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("creates a run with a fresh UUID idempotency key", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(String(init?.body))).toMatchObject({ title: "Build AutoStack" });
      return Response.json({ workItem, run, replayed: false }, { status: 201 });
    });
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:4318/",
      getToken: () => TOKEN,
      fetch
    });

    await expect(
      client.createRun({
        title: "Build AutoStack",
        description: "Foundation",
        acceptanceContext: []
      })
    ).resolves.toMatchObject({ replayed: false, run: { id: run.id } });
  });

  it("uses a named authentication error for missing or rejected credentials", async () => {
    const missing = createApiClient({ baseUrl: "", getToken: () => null, fetch: vi.fn() });
    const rejected = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => new Response(null, { status: 401 }))
    });

    await expect(missing.listRuns()).rejects.toBeInstanceOf(ApiAuthenticationError);
    await expect(rejected.listRuns()).rejects.toBeInstanceOf(ApiAuthenticationError);
  });

  it("rejects empty credentials and non-success API responses", async () => {
    const empty = createApiClient({ baseUrl: "", getToken: () => "", fetch: vi.fn() });
    const unavailable = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => new Response(null, { status: 500 }))
    });

    await expect(empty.listRuns()).rejects.toBeInstanceOf(ApiAuthenticationError);
    await expect(unavailable.listRuns()).rejects.toBeInstanceOf(ApiResponseError);
    await expect(
      unavailable.createRun({
        title: "Build AutoStack",
        description: "",
        acceptanceContext: []
      })
    ).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("normalizes network failures and unexpected health status", async () => {
    const networkFailure = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => Promise.reject(new Error("offline")))
    });
    const badStatus = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => new Response(null, { status: 404 }))
    });

    await expect(networkFailure.health()).rejects.toBeInstanceOf(ApiResponseError);
    await expect(badStatus.health()).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("rejects malformed server data without reflecting it", async () => {
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => Response.json({ token: TOKEN }))
    });

    const error = await client.health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("propagates AbortSignal to fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("Aborted", "AbortError");
    });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch });
    controller.abort();

    await expect(client.health(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
