import { describe, expect, it, vi } from "vitest";
import { HostRouteRequestSchema } from "@autostack/contracts";
import { LocalRunnerProviderError } from "@autostack/runner-local";

import { createHostApp, createHostBearerAuthenticator } from "../src/app.js";
import { createHostIngressState } from "../src/shutdown.js";

const token = "host-token-0123456789-abcdefghijklmnop";
const auth = { Authorization: `Bearer ${token}` };
const shared = {
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000",
  environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
  commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
  environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
  environmentAuthorizationDigest: "a".repeat(64),
  commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
  commandAuthorizationDigest: "b".repeat(64)
};
const artifactId = "art_123e4567-e89b-42d3-a456-426614174000";

const query = (value: Record<string, unknown>): string =>
  new URLSearchParams(Object.entries(value).map(([key, item]) => [key, String(item)])).toString();

const makeApp = () => {
  const terminalizeProtocolFailure = vi.fn();
  const runner = {
    capabilities: vi.fn(),
    inspectRepository: vi.fn(async () => ({
      repositoryIdentity: "github:autostack/contracts",
      canonicalSourcePath: "/source",
      repositoryCommonDirectory: "/source/.git",
      resolvedBaseRef: "main",
      sourceCommit: "a".repeat(40),
      dirty: false,
      diagnostics: []
    })),
    prepareEnvironment: vi.fn(),
    listEnvironments: vi.fn(async () => []),
    startCommand: vi.fn(),
    readCommandEvents: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "subscription.lagged", lastDurableSequence: 0, resumeCursor: 0 };
      }
    })),
    cancelCommand: vi.fn(async () => ({
      commandId: shared.commandId,
      cancelled: true,
      replayed: false
    })),
    readArtifactChunk: vi.fn(async () => ({
      artifact: {
        artifactId,
        workspaceId: shared.workspaceId,
        runId: shared.runId,
        commandId: shared.commandId,
        kind: "command_output",
        mediaType: "text/plain",
        digest: "c".repeat(64),
        byteSize: 1,
        createdAt: "2026-08-21T12:00:00.000Z"
      },
      offset: 0,
      bytes: "eA==",
      nextOffset: 1,
      done: true
    })),
    disposeEnvironment: vi.fn(async () => ({
      environmentId: shared.environmentId,
      disposed: true,
      replayed: false
    }))
  };
  const app = createHostApp({
    runner: runner as never,
    ingress: createHostIngressState(),
    auth: createHostBearerAuthenticator(token),
    prepareWithReplay: vi.fn(),
    terminalizeProtocolFailure,
    requestId: () => "request_2",
    log: vi.fn()
  });
  return { app, runner, terminalizeProtocolFailure };
};

describe("host transports", () => {
  it("serves inspection, list, cancellation, disposal, NDJSON and receipt-backed artifact bytes", async () => {
    const { app, runner } = makeApp();
    expect((await app.request("/v1/environments", { headers: auth })).status).toBe(200);
    const inspection = await app.request("/v1/repositories/inspect", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePath: "/source", baseRef: "main" })
    });
    expect(inspection.status).toBe(200);
    expect(inspection.headers.get("content-type")).toBe("application/json");
    const cancel = await app.request(
      `/v1/environments/${shared.environmentId}/commands/${shared.commandId}/cancel`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ ...shared, idempotency: { key: "cancel" } })
      }
    );
    expect(cancel.status).toBe(200);
    const dispose = await app.request(`/v1/environments/${shared.environmentId}`, {
      method: "DELETE",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: shared.workspaceId,
        runId: shared.runId,
        environmentId: shared.environmentId,
        environmentAuthorizationId: shared.environmentAuthorizationId,
        environmentAuthorizationDigest: shared.environmentAuthorizationDigest,
        terminalRunEvidence: {
          status: "completed",
          terminalEventSequence: 1,
          terminalEventDigest: "d".repeat(64)
        },
        idempotency: { key: "dispose" }
      })
    });
    expect(dispose.status).toBe(200);
    const eventQuery = query({
      workspaceId: shared.workspaceId,
      runId: shared.runId,
      environmentAuthorizationId: shared.environmentAuthorizationId,
      environmentAuthorizationDigest: shared.environmentAuthorizationDigest,
      commandAuthorizationId: shared.commandAuthorizationId,
      commandAuthorizationDigest: shared.commandAuthorizationDigest,
      after: 0
    });
    const events = await app.request(
      `/v1/environments/${shared.environmentId}/commands/${shared.commandId}/events?${eventQuery}`,
      { headers: auth }
    );
    expect(await events.text()).toBe(
      `${JSON.stringify({ type: "subscription.lagged", lastDurableSequence: 0, resumeCursor: 0 })}\n`
    );
    const artifactQuery = query(shared);
    expect(() =>
      HostRouteRequestSchema.parse({
        route: "GET /v1/artifacts/:artifactId/content",
        artifactId,
        query: { ...shared, range: { start: 0, end: 0 } }
      })
    ).not.toThrow();
    const artifact = await app.request(`/v1/artifacts/${artifactId}/content?${artifactQuery}`, {
      headers: { ...auth, Range: "bytes=0-0" }
    });
    expect({ status: artifact.status, body: await artifact.clone().text() }).toEqual({
      status: 206,
      body: expect.any(String)
    });
    expect(await artifact.json()).toMatchObject({ chunk: { bytes: "eA==", done: true } });
    expect(runner.readArtifactChunk).toHaveBeenCalledOnce();
  });

  it("rejects malformed media, duplicate query and unbounded range without calling providers", async () => {
    const { app, runner } = makeApp();
    expect(
      (
        await app.request("/v1/repositories/inspect", {
          method: "POST",
          headers: auth,
          body: "{}"
        })
      ).status
    ).toBe(400);
    const eventQuery = `${query({
      workspaceId: shared.workspaceId,
      runId: shared.runId,
      environmentAuthorizationId: shared.environmentAuthorizationId,
      environmentAuthorizationDigest: shared.environmentAuthorizationDigest,
      commandAuthorizationId: shared.commandAuthorizationId,
      commandAuthorizationDigest: shared.commandAuthorizationDigest
    })}&after=0&after=1`;
    expect(
      (
        await app.request(
          `/v1/environments/${shared.environmentId}/commands/${shared.commandId}/events?${eventQuery}`,
          { headers: auth }
        )
      ).status
    ).toBe(400);
    expect(
      (
        await app.request(`/v1/artifacts/${artifactId}/content?${query(shared)}`, {
          headers: { ...auth, Range: "bytes=0-1048576" }
        })
      ).status
    ).toBe(416);
    expect(runner.readArtifactChunk).not.toHaveBeenCalled();
  });

  it("bounds declared bodies and range grammar", async () => {
    const { app } = makeApp();
    const post = (headers: Record<string, string>, body = "{}") =>
      app.request("/v1/repositories/inspect", {
        method: "POST",
        headers: { ...auth, ...headers },
        body
      });
    expect(
      (await post({ "Content-Type": "application/json", "Content-Length": "invalid" })).status
    ).toBe(400);
    expect(
      (
        await post({
          "Content-Type": "application/json",
          "Content-Length": String(33 * 1_024 * 1_024)
        })
      ).status
    ).toBe(413);
    expect((await post({ "Content-Type": "application/json" }, "")).status).toBe(400);
    for (const range of [undefined, "bytes=1-", "bytes=2-1", "items=0-1"]) {
      const headers: Record<string, string> = { ...auth };
      if (range !== undefined) headers.Range = range;
      expect(
        (await app.request(`/v1/artifacts/${artifactId}/content?${query(shared)}`, { headers }))
          .status
      ).toBe(416);
    }
  });

  it("quarantines a malformed provider stream without writing the frame", async () => {
    const { app, runner, terminalizeProtocolFailure } = makeApp();
    runner.readCommandEvents.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: "subscription.lagged", lastDurableSequence: 4, resumeCursor: 4 };
      }
    } as never);
    const eventQuery = query({
      workspaceId: shared.workspaceId,
      runId: shared.runId,
      environmentAuthorizationId: shared.environmentAuthorizationId,
      environmentAuthorizationDigest: shared.environmentAuthorizationDigest,
      commandAuthorizationId: shared.commandAuthorizationId,
      commandAuthorizationDigest: shared.commandAuthorizationDigest
    });
    const response = await app.request(
      `/v1/environments/${shared.environmentId}/commands/${shared.commandId}/events?${eventQuery}`,
      { headers: auth }
    );
    expect(await response.text()).toBe("");
    expect(terminalizeProtocolFailure).toHaveBeenCalledOnce();
  });

  it("returns provider stream preflight failures before committing NDJSON status", async () => {
    const { app, runner, terminalizeProtocolFailure } = makeApp();
    runner.readCommandEvents.mockReturnValueOnce({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new LocalRunnerProviderError("command_not_found");
          }
        };
      }
    } as never);
    const eventQuery = query({
      workspaceId: shared.workspaceId,
      runId: shared.runId,
      environmentAuthorizationId: shared.environmentAuthorizationId,
      environmentAuthorizationDigest: shared.environmentAuthorizationDigest,
      commandAuthorizationId: shared.commandAuthorizationId,
      commandAuthorizationDigest: shared.commandAuthorizationDigest,
      after: 0
    });
    const response = await app.request(
      `/v1/environments/${shared.environmentId}/commands/${shared.commandId}/events?${eventQuery}`,
      { headers: auth }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "command_not_found" } });
    expect(terminalizeProtocolFailure).not.toHaveBeenCalled();
  });
});
