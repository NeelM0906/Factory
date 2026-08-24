import { describe, expect, it, vi } from "vitest";

import { HostErrorSchema, HostHealthResponseSchema } from "@autostack/contracts";
import { LocalRunnerProviderError } from "@autostack/runner-local";

import { createHostApp, createHostBearerAuthenticator } from "../src/app.js";
import { createHostIngressState } from "../src/shutdown.js";

const token = "host-token-0123456789-abcdefghijklmnop";
const capabilities = {
  runnerId: "autostack-local",
  version: "0.1.0",
  platform: { os: "darwin", architecture: "arm64" },
  pty: true,
  cancellation: true,
  filesystemDisclosure: "host_user",
  maximumBytes: {
    liveOutput: 65_536,
    replay: 1_048_576,
    transcript: 2_097_152,
    artifact: 4_194_304
  },
  supportedNetworkPolicies: ["host"],
  enforcement: {
    cpu: "advisory",
    memory: "advisory",
    duration: "hard",
    autostackPathOperations: "hard",
    childFilesystem: "advisory",
    network: "unavailable"
  }
};

const runner = {
  capabilities: vi.fn(async () => capabilities),
  inspectRepository: vi.fn(),
  prepareEnvironment: vi.fn(),
  listEnvironments: vi.fn(async () => []),
  startCommand: vi.fn(),
  readCommandEvents: vi.fn(),
  cancelCommand: vi.fn(),
  readArtifactChunk: vi.fn(),
  disposeEnvironment: vi.fn()
};

const app = createHostApp({
  runner: runner as never,
  ingress: createHostIngressState(),
  auth: createHostBearerAuthenticator(token),
  prepareWithReplay: vi.fn(),
  terminalizeProtocolFailure: vi.fn(),
  requestId: () => "request_1",
  log: () => undefined
});

describe("host app", () => {
  it.each([undefined, "Basic abc", "Bearer wrong", `Bearer ${token}, Bearer x`])(
    "authenticates health without reflecting credentials",
    async (authorization) => {
      const response = await app.request(
        "/v1/health",
        authorization === undefined ? {} : { headers: { Authorization: authorization } }
      );
      const copy = response.clone();
      expect(response.status).toBe(401);
      expect(HostErrorSchema.parse(await response.json()).error.code).toBe("unauthorized");
      expect(await copy.text()).not.toContain(token);
    }
  );

  it("returns a schema-valid health response for an authenticated caller", async () => {
    const response = await app.request("/v1/health", {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(200);
    expect(HostHealthResponseSchema.parse(await response.json())).toMatchObject({
      service: "autostack-host-daemon",
      status: "ok"
    });
  });

  it("authenticates unknown and dangerous routes before returning a fixed 404", async () => {
    expect((await app.request("/v1/exec")).status).toBe(401);
    const response = await app.request("/v1/exec", {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(404);
    expect(HostErrorSchema.parse(await response.json()).error.code).toBe("not_found");
  });

  it("bounds bearer work and rejects mutations after quiesce", async () => {
    expect((await app.request("/outside")).status).toBe(404);
    expect(
      (
        await app.request("/v1/health", {
          headers: { Authorization: `Bearer ${"y".repeat(5_000)}` }
        })
      ).status
    ).toBe(401);
    const ingress = createHostIngressState();
    ingress.quiesce();
    const quiesced = createHostApp({
      runner: runner as never,
      ingress,
      auth: createHostBearerAuthenticator(token),
      prepareWithReplay: vi.fn(),
      terminalizeProtocolFailure: vi.fn(),
      requestId: () => "request_3",
      log: () => undefined
    });
    expect(
      (
        await quiesced.request("/v1/environments", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` }
        })
      ).status
    ).toBe(503);
    const closingIngress = createHostIngressState();
    closingIngress.closing();
    const closing = createHostApp({
      runner: runner as never,
      ingress: closingIngress,
      auth: createHostBearerAuthenticator(token),
      prepareWithReplay: vi.fn(),
      terminalizeProtocolFailure: vi.fn(),
      requestId: () => "request_4",
      log: () => undefined
    });
    expect(
      (
        await closing.request("/v1/health", {
          headers: { Authorization: `Bearer ${token}` }
        })
      ).status
    ).toBe(503);
  });

  it.each([
    ["conflict", 409, "idempotency_conflict"],
    ["authorization_mismatch", 403, "scope_mismatch"],
    ["authorization_stale", 403, "authorization_expired"],
    ["unsupported_policy", 422, "unsupported_policy"],
    ["environment_not_prepared", 409, "environment_not_prepared"],
    ["command_not_found", 404, "command_not_found"],
    ["artifact_not_found", 404, "artifact_not_found"],
    ["active_command", 409, "environment_active"],
    ["missing_credential", 403, "authorization_invalid"],
    ["unsafe_state", 500, "internal_error"]
  ] as const)(
    "maps trusted provider %s without leaking its message",
    async (code, status, hostCode) => {
      runner.capabilities.mockRejectedValueOnce(new LocalRunnerProviderError(code));
      const response = await app.request("/v1/health", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = HostErrorSchema.parse(await response.json());
      expect(response.status).toBe(status);
      expect(body.error.code).toBe(hostCode);
      expect(body.error.message).not.toContain("local runner");
    }
  );
});
