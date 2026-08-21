import { describe, expect, it } from "vitest";

import {
  HostRouteRequestSchema,
  HostApiRouteSchema,
  admitHostOperation,
  HostArtifactContentRequestSchema,
  HostArtifactRangeSchema,
  HostCommandEventFrameSchema,
  HostErrorSchema,
  HostHealthResponseSchema
} from "../src/index.js";

describe("host daemon API contracts", () => {
  it("admits only the versioned local-runner route surface", () => {
    expect(HostApiRouteSchema.options).toEqual([
      "GET /v1/health",
      "GET /v1/environments",
      "POST /v1/repositories/inspect",
      "POST /v1/environments",
      "POST /v1/environments/:environmentId/commands",
      "GET /v1/environments/:environmentId/commands/:commandId/events",
      "POST /v1/environments/:environmentId/commands/:commandId/cancel",
      "GET /v1/artifacts/:artifactId/content",
      "DELETE /v1/environments/:environmentId"
    ]);
    expect(
      HostHealthResponseSchema.parse({
        service: "autostack-host-daemon",
        version: "1.0.0",
        status: "ok",
        capabilities: {
          runnerId: "runner-local",
          version: "1.0.0",
          platform: { os: "darwin", architecture: "arm64" },
          pty: true,
          cancellation: true,
          maximumBytes: { liveOutput: 1, replay: 1, transcript: 1, artifact: 1 },
          supportedNetworkPolicies: ["host"],
          enforcement: {
            cpu: "advisory",
            memory: "advisory",
            duration: "hard",
            autostackPathOperations: "hard",
            childFilesystem: "unavailable",
            network: "unavailable"
          }
        }
      })
    ).toMatchObject({ status: "ok" });
  });

  it("bounds artifact byte ranges and validates newline event frames", () => {
    expect(
      HostArtifactContentRequestSchema.parse({
        workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
        runId: "run_123e4567-e89b-42d3-a456-426614174000",
        environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
        commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
        environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
        environmentAuthorizationDigest: "a".repeat(64),
        commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
        commandAuthorizationDigest: "a".repeat(64),
        range: { start: 0, end: 1_048_575 }
      })
    ).toMatchObject({ range: { end: 1_048_575 } });
    expect(() =>
      HostArtifactContentRequestSchema.parse({
        workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
        runId: "run_123e4567-e89b-42d3-a456-426614174000",
        environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
        commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
        environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
        environmentAuthorizationDigest: "a".repeat(64),
        commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
        commandAuthorizationDigest: "a".repeat(64),
        range: { start: 0, end: 1_048_576 }
      })
    ).toThrow();
    expect(
      HostCommandEventFrameSchema.parse({
        type: "subscription.lagged",
        lastDurableSequence: 2,
        resumeCursor: 2
      })
    ).toMatchObject({ type: "subscription.lagged" });
    expect(
      HostErrorSchema.parse({ error: { code: "unsupported_policy", message: "host only" } })
    ).toBeDefined();
  });

  it("rejects a body whose resource identity differs from its route identity", () => {
    expect(() =>
      HostRouteRequestSchema.parse({
        route: "GET /v1/environments/:environmentId/commands/:commandId/events",
        environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
        commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
        query: {
          workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
          runId: "run_123e4567-e89b-42d3-a456-426614174000",
          environmentId: "env_123e4567-e89b-42d3-a456-426614174099",
          commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
          environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
          environmentAuthorizationDigest: "a".repeat(64),
          commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
          commandAuthorizationDigest: "a".repeat(64)
        }
      })
    ).toThrow();
  });

  it("has no parser-only host admission surface", async () => {
    await expect(
      admitHostOperation({ route: "GET /v1/health" }, "2026-08-21T12:00:00.000Z")
    ).resolves.toMatchObject({ route: "GET /v1/health" });
    expect(() => HostArtifactRangeSchema.parse({ start: 2, end: 1 })).toThrow();
    expect(() =>
      HostErrorSchema.parse({
        error: {
          code: "invalid_request",
          message: "invalid request",
          details: Object.fromEntries(
            Array.from({ length: 11 }, (_, index) => [`detail${index}`, index])
          )
        }
      })
    ).toThrow();
  });
});
