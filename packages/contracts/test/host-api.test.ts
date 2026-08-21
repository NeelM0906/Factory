import { describe, expect, it } from "vitest";

import {
  HostRouteRequestSchema,
  HostApiRouteSchema,
  admitHostOperation,
  admitHostResponse,
  HostArtifactContentRequestSchema,
  HostArtifactRangeSchema,
  HostCommandEventFrameSchema,
  HostErrorSchema,
  HostHealthResponseSchema,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  type TrustedHostAdmissionDependencies
} from "../src/index.js";

const hostDependencies: TrustedHostAdmissionDependencies = {
  now: () => "2026-08-21T12:00:00.000Z",
  resolveApproval: async () => undefined,
  resolveEnvironmentAuthorization: async () => undefined,
  resolveCommandAuthorization: async () => undefined,
  resolvePreparedEnvironment: async () => undefined,
  resolveArtifact: async () => undefined,
  resolveTerminalRunEvidence: async () => undefined,
  hasActiveCommand: async () => false
};

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
          filesystemDisclosure: "host_user",
          maximumBytes: { liveOutput: 1, replay: 1, transcript: 1, artifact: 1 },
          supportedNetworkPolicies: ["host"],
          enforcement: {
            cpu: "advisory",
            memory: "advisory",
            duration: "hard",
            autostackPathOperations: "hard",
            childFilesystem: "advisory",
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
      admitHostOperation({ route: "GET /v1/health" }, hostDependencies)
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

  it("fails closed for every protected lifecycle request without trusted records", async () => {
    const shared = {
      workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
      runId: "run_123e4567-e89b-42d3-a456-426614174000",
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
      commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
      environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
      environmentAuthorizationDigest: "a".repeat(64),
      commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
      commandAuthorizationDigest: "a".repeat(64)
    };
    const requests = [
      {
        route: "GET /v1/environments/:environmentId/commands/:commandId/events" as const,
        environmentId: shared.environmentId,
        commandId: shared.commandId,
        query: shared
      },
      {
        route: "POST /v1/environments/:environmentId/commands/:commandId/cancel" as const,
        environmentId: shared.environmentId,
        commandId: shared.commandId,
        body: { ...shared, idempotency: { key: "cancel" } }
      },
      {
        route: "GET /v1/artifacts/:artifactId/content" as const,
        artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
        query: { ...shared, range: { start: 0, end: 0 } }
      },
      {
        route: "DELETE /v1/environments/:environmentId" as const,
        environmentId: shared.environmentId,
        body: {
          workspaceId: shared.workspaceId,
          runId: shared.runId,
          environmentId: shared.environmentId,
          environmentAuthorizationId: shared.environmentAuthorizationId,
          environmentAuthorizationDigest: shared.environmentAuthorizationDigest,
          terminalRunEvidence: {
            status: "completed" as const,
            terminalEventSequence: 1,
            terminalEventDigest: "a".repeat(64)
          },
          idempotency: { key: "dispose" }
        }
      }
    ];
    for (const request of requests) {
      await expect(admitHostOperation(request, hostDependencies)).rejects.toThrow(/recorded/i);
    }
  });

  it("rejects a successful response that belongs to another command", () => {
    const request = {
      route: "POST /v1/environments/:environmentId/commands" as const,
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
      body: {
        workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
        runId: "run_123e4567-e89b-42d3-a456-426614174000",
        environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
        commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
        command: {
          executable: "true",
          args: [],
          cwd: ".",
          environment: [],
          timeoutSeconds: 1,
          terminal: { columns: 80, rows: 24 }
        },
        environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
        environmentAuthorizationDigest: "a".repeat(64),
        authorization: {
          id: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
          digest: "a".repeat(64),
          approvalId: "apr_123e4567-e89b-42d3-a456-426614174000",
          approvalEvidenceDigest: "a".repeat(64),
          scope: {
            environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
            environmentAuthorizationDigest: "a".repeat(64),
            workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
            runId: "run_123e4567-e89b-42d3-a456-426614174000",
            environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
            commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
            action: "implement" as const,
            commandDigest: "a".repeat(64),
            repositoryIdentity: "github:autostack/contracts",
            sourceCommit: "b".repeat(40),
            branch: "autostack/host-test",
            cwdRoot: ".",
            networkPolicy: "host" as const,
            filesystemDisclosure: "host_user" as const,
            resourceLimits: { cpu: 1, memoryMb: 1, durationSeconds: 1 },
            allowedCredentialRefIds: []
          },
          createdAt: "2026-08-21T12:00:00.000Z",
          expiresAt: "2026-08-21T13:00:00.000Z"
        },
        idempotency: { key: "start" }
      }
    };
    expect(() =>
      admitHostResponse(request, {
        status: 202,
        mediaType: "application/json",
        body: {
          commandId: "cmd_123e4567-e89b-42d3-a456-426614174099",
          acceptedAt: "2026-08-21T12:00:00.000Z",
          replayed: false
        }
      })
    ).toThrow(/match/i);
  });

  it("admits request-aware health, list, inspection, event, cancel, artifact, and disposal responses", () => {
    const shared = {
      workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
      runId: "run_123e4567-e89b-42d3-a456-426614174000",
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
      commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
      environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
      environmentAuthorizationDigest: "a".repeat(64),
      commandAuthorizationId: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
      commandAuthorizationDigest: "a".repeat(64)
    };
    const capabilities = {
      runnerId: "runner-local",
      version: "1.0.0",
      platform: { os: "darwin" as const, architecture: "arm64" as const },
      pty: true as const,
      cancellation: true as const,
      filesystemDisclosure: "host_user" as const,
      maximumBytes: { liveOutput: 1, replay: 1, transcript: 1, artifact: 1 },
      supportedNetworkPolicies: ["host" as const],
      enforcement: {
        cpu: "advisory" as const,
        memory: "advisory" as const,
        duration: "hard" as const,
        autostackPathOperations: "hard" as const,
        childFilesystem: "advisory" as const,
        network: "unavailable" as const
      }
    };
    expect(
      admitHostResponse(
        { route: "GET /v1/health" },
        {
          status: 200,
          mediaType: "application/json",
          body: { service: "autostack-host-daemon", version: "1.0.0", status: "ok", capabilities }
        }
      )
    ).toMatchObject({ status: "ok" });
    expect(
      admitHostResponse(
        { route: "GET /v1/environments" },
        { status: 200, mediaType: "application/json", body: { items: [] } }
      )
    ).toMatchObject({ items: [] });
    expect(
      admitHostResponse(
        {
          route: "POST /v1/repositories/inspect",
          body: { sourcePath: "/source", baseRef: "main" }
        },
        {
          status: 200,
          mediaType: "application/json",
          body: {
            repositoryIdentity: "github:autostack/contracts",
            canonicalSourcePath: "/source",
            repositoryCommonDirectory: "/source/.git",
            resolvedBaseRef: "main",
            sourceCommit: "a".repeat(40),
            dirty: false,
            diagnostics: []
          }
        }
      )
    ).toMatchObject({ dirty: false });
    expect(
      admitHostResponse(
        {
          route: "GET /v1/environments/:environmentId/commands/:commandId/events",
          environmentId: shared.environmentId,
          commandId: shared.commandId,
          query: shared
        },
        {
          status: 200,
          mediaType: "application/x-ndjson",
          body: { type: "subscription.lagged", lastDurableSequence: 2, resumeCursor: 2 }
        }
      )
    ).toMatchObject({ type: "subscription.lagged" });
    expect(
      admitHostResponse(
        {
          route: "POST /v1/environments/:environmentId/commands/:commandId/cancel",
          environmentId: shared.environmentId,
          commandId: shared.commandId,
          body: { ...shared, idempotency: { key: "cancel" } }
        },
        {
          status: 200,
          mediaType: "application/json",
          body: { commandId: shared.commandId, cancelled: true, replayed: false }
        }
      )
    ).toMatchObject({ cancelled: true });
    const artifact = {
      artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
      workspaceId: shared.workspaceId,
      runId: shared.runId,
      commandId: shared.commandId,
      kind: "command_output" as const,
      mediaType: "text/plain",
      digest: "a".repeat(64),
      byteSize: 0,
      createdAt: "2026-08-21T12:00:00.000Z"
    };
    expect(
      admitHostResponse(
        {
          route: "GET /v1/artifacts/:artifactId/content",
          artifactId: artifact.artifactId,
          query: { ...shared, range: { start: 0, end: 0 } }
        },
        {
          status: 206,
          mediaType: "application/json",
          body: {
            contentType: "text/plain",
            chunk: { artifact, offset: 0, bytes: "", nextOffset: 0, done: true }
          }
        }
      )
    ).toMatchObject({ done: true });
    expect(
      admitHostResponse(
        {
          route: "DELETE /v1/environments/:environmentId",
          environmentId: shared.environmentId,
          body: {
            workspaceId: shared.workspaceId,
            runId: shared.runId,
            environmentId: shared.environmentId,
            environmentAuthorizationId: shared.environmentAuthorizationId,
            environmentAuthorizationDigest: shared.environmentAuthorizationDigest,
            terminalRunEvidence: {
              status: "completed" as const,
              terminalEventSequence: 1,
              terminalEventDigest: "a".repeat(64)
            },
            idempotency: { key: "dispose" }
          }
        },
        {
          status: 200,
          mediaType: "application/json",
          body: { environmentId: shared.environmentId, disposed: true, replayed: false }
        }
      )
    ).toMatchObject({ disposed: true });
  });

  it("admits trusted prepare, start, lifecycle, artifact, and terminal disposal operations", async () => {
    const workspaceId = "ws_123e4567-e89b-42d3-a456-426614174000";
    const runId = "run_123e4567-e89b-42d3-a456-426614174000";
    const environmentId = "env_123e4567-e89b-42d3-a456-426614174000";
    const commandId = "cmd_123e4567-e89b-42d3-a456-426614174000";
    const scope = {
      workspaceId,
      runId,
      environmentId,
      repositoryIdentity: "github:autostack/contracts",
      sourceCommit: "a".repeat(40),
      branch: "autostack/host-admission",
      cwdRoot: ".",
      resourceLimits: { cpu: 1, memoryMb: 1, durationSeconds: 60 },
      networkPolicy: "host" as const,
      filesystemDisclosure: "host_user" as const,
      allowedCredentialRefIds: []
    };
    const environmentAuthorization = {
      id: "envauth_123e4567-e89b-42d3-a456-426614174000",
      digest: "0".repeat(64),
      approvalId: "apr_123e4567-e89b-42d3-a456-426614174000",
      approvalEvidenceDigest: await digestExecutionScope(scope),
      scope,
      createdAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    environmentAuthorization.digest =
      await digestEnvironmentAuthorization(environmentAuthorization);
    const command = {
      executable: "true",
      args: [],
      cwd: ".",
      environment: [],
      timeoutSeconds: 1,
      terminal: { columns: 80, rows: 24 }
    };
    const commandScope = {
      environmentAuthorizationId: environmentAuthorization.id,
      environmentAuthorizationDigest: environmentAuthorization.digest,
      workspaceId,
      runId,
      environmentId,
      commandId,
      action: "implement" as const,
      commandDigest: await digestCommandSpec(command),
      repositoryIdentity: scope.repositoryIdentity,
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      cwdRoot: scope.cwdRoot,
      networkPolicy: "host" as const,
      filesystemDisclosure: "host_user" as const,
      resourceLimits: scope.resourceLimits,
      allowedCredentialRefIds: []
    };
    const commandAuthorization = {
      id: "cmdauth_123e4567-e89b-42d3-a456-426614174000",
      digest: "0".repeat(64),
      approvalId: "apr_123e4567-e89b-42d3-a456-426614174002",
      approvalEvidenceDigest: await digestCommandScope(commandScope),
      scope: commandScope,
      createdAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T13:00:00.000Z"
    };
    commandAuthorization.digest = await digestCommandAuthorization(commandAuthorization);
    const planApproval = {
      schemaVersion: 1,
      id: environmentAuthorization.approvalId,
      workspaceId,
      runId,
      kind: "plan" as const,
      status: "approved" as const,
      evidenceDigest: environmentAuthorization.approvalEvidenceDigest,
      eligibleApproverIds: ["local-user"],
      decision: {
        decision: "approved" as const,
        actor: { kind: "user" as const, id: "local-user" },
        origin: "desktop" as const,
        decidedAt: "2026-08-21T12:00:00.000Z"
      },
      createdAt: "2026-08-21T12:00:00.000Z",
      updatedAt: "2026-08-21T12:00:00.000Z"
    };
    const permissionApproval = {
      ...planApproval,
      id: commandAuthorization.approvalId,
      kind: "permission" as const,
      evidenceDigest: commandAuthorization.approvalEvidenceDigest
    };
    const artifact = {
      artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
      workspaceId,
      runId,
      commandId,
      kind: "command_output" as const,
      mediaType: "text/plain",
      digest: "a".repeat(64),
      byteSize: 0,
      createdAt: "2026-08-21T12:00:00.000Z"
    };
    const dependencies: TrustedHostAdmissionDependencies = {
      now: () => "2026-08-21T12:30:00.000Z",
      resolveApproval: async (approvalId) =>
        approvalId === planApproval.id
          ? planApproval
          : approvalId === permissionApproval.id
            ? permissionApproval
            : undefined,
      resolveEnvironmentAuthorization: async (authorizationId) =>
        authorizationId === environmentAuthorization.id ? environmentAuthorization : undefined,
      resolveCommandAuthorization: async (authorizationId) =>
        authorizationId === commandAuthorization.id ? commandAuthorization : undefined,
      resolvePreparedEnvironment: async () => ({
        environmentId,
        workspaceId,
        runId,
        repositoryIdentity: scope.repositoryIdentity,
        sourceCommit: scope.sourceCommit,
        branch: scope.branch,
        authorization: environmentAuthorization,
        state: "prepared",
        preparedAt: "2026-08-21T12:00:00.000Z"
      }),
      resolveArtifact: async () => artifact,
      resolveTerminalRunEvidence: async () => ({
        status: "completed",
        terminalEventSequence: 1,
        terminalEventDigest: "a".repeat(64)
      }),
      hasActiveCommand: async () => false
    };
    const prepare = {
      workspaceId,
      runId,
      environmentId,
      inspection: {
        repositoryIdentity: scope.repositoryIdentity,
        canonicalSourcePath: "/source",
        repositoryCommonDirectory: "/source/.git",
        resolvedBaseRef: "main",
        sourceCommit: scope.sourceCommit,
        dirty: false,
        diagnostics: []
      },
      sourceCommit: scope.sourceCommit,
      branch: scope.branch,
      authorization: environmentAuthorization,
      idempotency: { key: "prepare" }
    };
    const start = {
      workspaceId,
      runId,
      environmentId,
      commandId,
      command,
      environmentAuthorizationId: environmentAuthorization.id,
      environmentAuthorizationDigest: environmentAuthorization.digest,
      authorization: commandAuthorization,
      idempotency: { key: "start" }
    };
    await expect(
      admitHostOperation({ route: "POST /v1/environments", body: prepare }, dependencies)
    ).resolves.toMatchObject({ route: "POST /v1/environments" });
    await expect(
      admitHostOperation(
        {
          route: "POST /v1/environments/:environmentId/commands",
          environmentId,
          body: start
        },
        dependencies
      )
    ).resolves.toMatchObject({ route: "POST /v1/environments/:environmentId/commands" });
    const lifecycle = {
      workspaceId,
      runId,
      environmentId,
      commandId,
      environmentAuthorizationId: environmentAuthorization.id,
      environmentAuthorizationDigest: environmentAuthorization.digest,
      commandAuthorizationId: commandAuthorization.id,
      commandAuthorizationDigest: commandAuthorization.digest
    };
    await expect(
      admitHostOperation(
        {
          route: "GET /v1/environments/:environmentId/commands/:commandId/events",
          environmentId,
          commandId,
          query: lifecycle
        },
        dependencies
      )
    ).resolves.toMatchObject({
      route: "GET /v1/environments/:environmentId/commands/:commandId/events"
    });
    await expect(
      admitHostOperation(
        {
          route: "POST /v1/environments/:environmentId/commands/:commandId/cancel",
          environmentId,
          commandId,
          body: { ...lifecycle, idempotency: { key: "cancel" } }
        },
        dependencies
      )
    ).resolves.toMatchObject({
      route: "POST /v1/environments/:environmentId/commands/:commandId/cancel"
    });
    await expect(
      admitHostOperation(
        {
          route: "GET /v1/artifacts/:artifactId/content",
          artifactId: artifact.artifactId,
          query: { ...lifecycle, range: { start: 0, end: 0 } }
        },
        dependencies
      )
    ).resolves.toMatchObject({ route: "GET /v1/artifacts/:artifactId/content" });
    await expect(
      admitHostOperation(
        {
          route: "DELETE /v1/environments/:environmentId",
          environmentId,
          body: {
            workspaceId,
            runId,
            environmentId,
            environmentAuthorizationId: environmentAuthorization.id,
            environmentAuthorizationDigest: environmentAuthorization.digest,
            terminalRunEvidence: {
              status: "completed",
              terminalEventSequence: 1,
              terminalEventDigest: "a".repeat(64)
            },
            idempotency: { key: "dispose" }
          }
        },
        dependencies
      )
    ).resolves.toMatchObject({ route: "DELETE /v1/environments/:environmentId" });
  });
});
