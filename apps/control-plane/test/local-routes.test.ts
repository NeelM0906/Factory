import { beforeAll, describe, expect, it } from "vitest";

import { WorkspaceIdSchema } from "@autostack/contracts";

import { createApp } from "../src/app.js";
import { LocalRunnerUnavailableError } from "../src/local-execution-service.js";

import { NOW, authorizedIdentity, preparedEnvironmentFor } from "./fixtures/seed-approved-run.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const ARTIFACT_ID = "art_123e4567-e89b-42d3-a456-4266141743b0";

let identity: Awaited<ReturnType<typeof authorizedIdentity>>;

beforeAll(async () => {
  identity = await authorizedIdentity(0);
});

const buildApp = (localExecution: Record<string, unknown>, ingress?: { isOpen: () => boolean }) =>
  createApp({
    store: {} as never,
    executor: { getStatus: () => "idle" as const },
    token: TOKEN,
    workspaceId: WORKSPACE_ID,
    now: () => NOW,
    mode: "local",
    localExecution: localExecution as never,
    ...(ingress === undefined ? {} : { ingress })
  });

const call = (app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers
    }
  });

const prepareBody = () => ({
  runId: identity.runId,
  approvalId: identity.planApprovalId,
  environmentAuthorizationId: identity.environmentAuthorization.id,
  environmentId: identity.environmentId,
  sourcePath: "/repo",
  baseRef: "main",
  branchSlug: identity.branchSlug
});

const startBody = () => ({
  runId: identity.runId,
  approvalId: identity.commandApprovalId,
  commandAuthorizationId: identity.commandAuthorization.id,
  environmentId: identity.environmentId,
  commandId: identity.commandId,
  command: identity.command
});

const chunk = () => ({
  artifact: {
    artifactId: ARTIFACT_ID,
    workspaceId: WORKSPACE_ID,
    runId: identity.runId,
    commandId: identity.commandId,
    kind: "command_transcript",
    mediaType: "text/plain; charset=utf-8",
    digest: "c".repeat(64),
    byteSize: 1,
    createdAt: NOW
  },
  offset: 0,
  bytes: "eA==",
  nextOffset: 1,
  done: true
});

describe("local environment preparation route", () => {
  it("accepts a fresh preparation with 202 and passes the header idempotency key through", async () => {
    const keys: string[] = [];
    const app = buildApp({
      prepare: async (_request: unknown, key: string) => {
        keys.push(key);
        return preparedEnvironmentFor(identity);
      }
    });

    const response = await call(app, "/v1/local/environments", {
      method: "POST",
      headers: { "Idempotency-Key": "prepare-1" },
      body: JSON.stringify(prepareBody())
    });

    expect(response.status).toBe(202);
    expect(keys).toEqual(["prepare-1"]);
    expect(await response.json()).toMatchObject({ replayed: false });
  });

  it("answers a replayed preparation with 200 rather than a second acceptance", async () => {
    const app = buildApp({
      prepare: async () => ({
        ...preparedEnvironmentFor(identity),
        replayed: true
      })
    });

    const response = await call(app, "/v1/local/environments", {
      method: "POST",
      headers: { "Idempotency-Key": "prepare-1" },
      body: JSON.stringify(prepareBody())
    });

    expect(response.status).toBe(200);
  });

  it("refuses a preparation with no idempotency key before reaching the service", async () => {
    let called = false;
    const app = buildApp({
      prepare: async () => {
        called = true;
        return preparedEnvironmentFor(identity);
      }
    });

    const response = await call(app, "/v1/local/environments", {
      method: "POST",
      body: JSON.stringify(prepareBody())
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "missing_idempotency_key",
        message: "A valid Idempotency-Key header is required."
      }
    });
    expect(called).toBe(false);
  });

  it("refuses a preparation whose idempotency key exceeds the local key budget", async () => {
    const app = buildApp({
      prepare: async () => preparedEnvironmentFor(identity)
    });

    const response = await call(app, "/v1/local/environments", {
      method: "POST",
      headers: { "Idempotency-Key": "k".repeat(129) },
      body: JSON.stringify(prepareBody())
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "missing_idempotency_key" } });
  });
});

describe("local command routes", () => {
  it("accepts a start whose route and body environments agree", async () => {
    const app = buildApp({
      start: async () => ({ commandId: identity.commandId, acceptedAt: NOW, replayed: false })
    });

    const response = await call(app, `/v1/local/environments/${identity.environmentId}/commands`, {
      method: "POST",
      headers: { "Idempotency-Key": "start-1" },
      body: JSON.stringify(startBody())
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ commandId: identity.commandId });
  });

  it("refuses a start whose route environment differs from the body environment", async () => {
    let called = false;
    const app = buildApp({
      start: async () => {
        called = true;
        return { commandId: identity.commandId, acceptedAt: NOW, replayed: false };
      }
    });

    const response = await call(
      app,
      "/v1/local/environments/env_123e4567-e89b-42d3-a456-4266141749aa/commands",
      {
        method: "POST",
        headers: { "Idempotency-Key": "start-1" },
        body: JSON.stringify(startBody())
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Route and body identities differ." }
    });
    expect(called).toBe(false);
  });

  it("answers a replayed start with 200", async () => {
    const app = buildApp({
      start: async () => ({ commandId: identity.commandId, acceptedAt: NOW, replayed: true })
    });

    const response = await call(app, `/v1/local/environments/${identity.environmentId}/commands`, {
      method: "POST",
      headers: { "Idempotency-Key": "start-1" },
      body: JSON.stringify(startBody())
    });

    expect(response.status).toBe(200);
  });

  it("streams command events as newline-delimited JSON in emission order", async () => {
    const frames = [
      { type: "runner.heartbeat", sequence: 1 },
      { type: "runner.heartbeat", sequence: 2 }
    ];
    let requestedAfter: number | undefined;
    const app = buildApp({
      events: async (request: { after: number }) => {
        requestedAfter = request.after;
        return (async function* () {
          yield* frames;
        })();
      }
    });

    const response = await call(
      app,
      `/v1/local/environments/${identity.environmentId}/commands/${identity.commandId}/events?after=7`
    );

    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe(
      frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")
    );
    expect(requestedAfter).toBe(7);
  });

  it("defaults the event cursor to zero when no after query is supplied", async () => {
    let requestedAfter: number | undefined;
    const app = buildApp({
      events: async (request: { after: number }) => {
        requestedAfter = request.after;
        return (async function* () {})();
      }
    });

    await call(
      app,
      `/v1/local/environments/${identity.environmentId}/commands/${identity.commandId}/events`
    );

    expect(requestedAfter).toBe(0);
  });

  it("surfaces a mid-stream failure by erroring the response body rather than truncating silently", async () => {
    const app = buildApp({
      events: async () =>
        (async function* () {
          yield { type: "runner.heartbeat", sequence: 1 };
          throw new Error("private stream failure");
        })()
    });

    const response = await call(
      app,
      `/v1/local/environments/${identity.environmentId}/commands/${identity.commandId}/events`
    );

    await expect(response.text()).rejects.toThrow();
  });

  it("passes an authorized cancellation through to the service", async () => {
    const app = buildApp({
      cancel: async () => ({ commandId: identity.commandId, cancelled: true, replayed: false })
    });

    const response = await call(
      app,
      `/v1/local/environments/${identity.environmentId}/commands/${identity.commandId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({
          environmentId: identity.environmentId,
          commandId: identity.commandId,
          commandAuthorizationId: identity.commandAuthorization.id,
          idempotencyKey: "cancel-1"
        })
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commandId: identity.commandId,
      cancelled: true,
      replayed: false
    });
  });

  it("refuses a cancellation whose route command differs from the body command", async () => {
    let called = false;
    const app = buildApp({
      cancel: async () => {
        called = true;
        return { commandId: identity.commandId, cancelled: true, replayed: false };
      }
    });

    const response = await call(
      app,
      `/v1/local/environments/${identity.environmentId}/commands/cmd_123e4567-e89b-42d3-a456-4266141749bb/cancel`,
      {
        method: "POST",
        body: JSON.stringify({
          environmentId: identity.environmentId,
          commandId: identity.commandId,
          commandAuthorizationId: identity.commandAuthorization.id,
          idempotencyKey: "cancel-1"
        })
      }
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
});

describe("local artifact and disposal routes", () => {
  it("reads an artifact range using the offset and length from the query string", async () => {
    let received: unknown;
    const app = buildApp({
      readArtifact: async (request: unknown) => {
        received = request;
        return chunk();
      }
    });

    const response = await call(
      app,
      `/v1/local/artifacts/${ARTIFACT_ID}/content?offset=0&length=64`
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({ artifactId: ARTIFACT_ID, offset: 0, length: 64 });
    expect(await response.json()).toMatchObject({ done: true, bytes: "eA==" });
  });

  it("defaults an artifact read to the whole maximum chunk when no range is supplied", async () => {
    let received: { length: number } | undefined;
    const app = buildApp({
      readArtifact: async (request: { length: number }) => {
        received = request;
        return chunk();
      }
    });

    await call(app, `/v1/local/artifacts/${ARTIFACT_ID}/content`);

    expect(received).toEqual({ artifactId: ARTIFACT_ID, offset: 0, length: 1_048_576 });
  });

  it("rejects an artifact read whose requested length exceeds the chunk ceiling", async () => {
    let called = false;
    const app = buildApp({
      readArtifact: async () => {
        called = true;
        return chunk();
      }
    });

    const response = await call(
      app,
      `/v1/local/artifacts/${ARTIFACT_ID}/content?offset=0&length=1048577`
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(called).toBe(false);
  });

  it("disposes an environment named identically in the route and the body", async () => {
    const app = buildApp({
      dispose: async () => ({
        environmentId: identity.environmentId,
        disposed: true,
        replayed: false
      })
    });

    const response = await call(app, `/v1/local/environments/${identity.environmentId}`, {
      method: "DELETE",
      body: JSON.stringify({
        environmentId: identity.environmentId,
        environmentAuthorizationId: identity.environmentAuthorization.id,
        idempotencyKey: "dispose-1"
      })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ disposed: true });
  });

  it("refuses a disposal whose route environment differs from the body environment", async () => {
    let called = false;
    const app = buildApp({
      dispose: async () => {
        called = true;
        return { environmentId: identity.environmentId, disposed: true, replayed: false };
      }
    });

    const response = await call(
      app,
      "/v1/local/environments/env_123e4567-e89b-42d3-a456-4266141749cc",
      {
        method: "DELETE",
        body: JSON.stringify({
          environmentId: identity.environmentId,
          environmentAuthorizationId: identity.environmentAuthorization.id,
          idempotencyKey: "dispose-1"
        })
      }
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("lists prepared environments through the local surface", async () => {
    const app = buildApp({
      list: async () => ({
        items: [preparedEnvironmentFor(identity).environment]
      })
    });

    const response = await call(app, "/v1/local/environments");

    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
  });
});

describe("local surface availability", () => {
  it("maps a retired local runner to 503 local_runner_unavailable", async () => {
    const app = buildApp({
      list: async () => {
        throw new LocalRunnerUnavailableError();
      }
    });

    const response = await call(app, "/v1/local/environments");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "local_runner_unavailable", message: "The local runner is unavailable." }
    });
  });

  it("closes every authenticated route except health once ingress is closed", async () => {
    const app = buildApp({ list: async () => ({ items: [] }) }, { isOpen: () => false });

    const local = await call(app, "/v1/local/environments");
    const runs = await call(app, "/v1/runs");

    expect(local.status).toBe(503);
    expect(await local.json()).toEqual({
      error: {
        code: "local_runner_unavailable",
        message: "The local runner generation is unavailable."
      }
    });
    expect(runs.status).toBe(503);
  });

  it("keeps health reachable while ingress is closed", async () => {
    const app = createApp({
      store: {
        health: async () => ({ status: "ok", journalMode: "wal", schemaVersion: 5 })
      } as never,
      executor: { getStatus: () => "idle" as const },
      token: TOKEN,
      workspaceId: WORKSPACE_ID,
      now: () => NOW,
      mode: "local",
      localExecution: {} as never,
      ingress: { isOpen: () => false }
    });

    const response = await app.request("/v1/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("refuses to build a local app without a local execution service", () => {
    expect(() =>
      createApp({
        store: {} as never,
        executor: { getStatus: () => "idle" as const },
        token: TOKEN,
        workspaceId: WORKSPACE_ID,
        now: () => NOW,
        mode: "local"
      })
    ).toThrow(/Local mode and local execution service must be configured together/);
  });

  it("refuses to build a hosted app that was handed a local execution service", () => {
    expect(() =>
      createApp({
        store: {} as never,
        executor: { getStatus: () => "idle" as const },
        token: TOKEN,
        workspaceId: WORKSPACE_ID,
        now: () => NOW,
        mode: "hosted",
        localExecution: {} as never
      })
    ).toThrow(/Local mode and local execution service must be configured together/);
  });
});
