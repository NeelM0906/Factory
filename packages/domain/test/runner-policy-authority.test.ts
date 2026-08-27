import { describe, expect, it } from "vitest";
import {
  ArtifactDescriptorSchema,
  CommandAuthorizationSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  RunSchema,
  WorkspaceIdSchema,
  digestCommandAuthorization,
  digestEnvironmentAuthorization
} from "@autostack/contracts";

import type { ExecutionPolicyAuthority } from "../src/runner-policy.js";
import {
  authorizeArtifactRead,
  authorizeCancelCommand,
  authorizeCommandEvents,
  decideEnvironmentDisposal
} from "../src/runner-policy.js";

const authority: ExecutionPolicyAuthority = {
  resolveRun: async () => undefined,
  resolveApproval: async () => undefined,
  resolveEnvironmentAuthorization: async () => undefined,
  resolveCommandAuthorization: async () => undefined,
  resolveArtifact: async () => undefined,
  resolveTerminalRunEvidence: async () => undefined,
  hasActiveCommands: async () => false
};
const MISSING_WORKSPACE = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174099");
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174000");
const ENVIRONMENT_ID = EnvironmentIdSchema.parse("env_123e4567-e89b-42d3-a456-426614174000");
const COMMAND_ID = CommandIdSchema.parse("cmd_123e4567-e89b-42d3-a456-426614174000");
const ENVIRONMENT_AUTHORIZATION_ID = EnvironmentAuthorizationIdSchema.parse(
  "envauth_123e4567-e89b-42d3-a456-426614174000"
);
const COMMAND_AUTHORIZATION_ID = CommandAuthorizationIdSchema.parse(
  "cmdauth_123e4567-e89b-42d3-a456-426614174000"
);
const NOW = "2026-08-21T12:00:00.000Z";
const DIGEST = "a".repeat(64);

describe("authoritative runner policy", () => {
  it("fails closed for missing durable records instead of trusting a self-consistent envelope", async () => {
    const result = await authorizeCommandEvents({
      authority,
      authenticatedWorkspaceId: MISSING_WORKSPACE
    });
    expect(result).toEqual({ ok: false, code: "invalid_input" });
  });

  it("keeps expired recovery reads and cancellation available only to the persisted owner", async () => {
    const events = await authorizeCommandEvents({
      authority,
      authenticatedWorkspaceId: MISSING_WORKSPACE
    });
    const cancel = await authorizeCancelCommand({
      authority,
      authenticatedWorkspaceId: MISSING_WORKSPACE
    });
    expect(events).toEqual({ ok: false, code: "invalid_input" });
    expect(cancel).toEqual({ ok: false, code: "invalid_input" });
  });

  it("requires authoritative artifact and terminal evidence with an explicit operator", async () => {
    const artifact = await authorizeArtifactRead({
      authority,
      authenticatedWorkspaceId: MISSING_WORKSPACE
    });
    const dispose = await decideEnvironmentDisposal({
      authority,
      authenticatedWorkspaceId: MISSING_WORKSPACE
    });
    expect(artifact).toEqual({ ok: false, code: "invalid_input" });
    expect(dispose).toEqual({ ok: false, code: "invalid_input" });
  });

  // Crypto-digest bound: this case recomputes real SHA-256 digests for every persisted identity in
  // the recovery envelope, and measures ~0.3s on an unconstrained dev machine. CI runs
  // `pnpm test:coverage` on a 2-vCPU runner with V8 coverage instrumentation while every workspace
  // package tests in parallel, which stretches it past the 5s default.
  it(
    "authorizes expired recovery operations only when every persisted identity agrees",
    { timeout: 15_000 },
    async () => {
      const environmentWithoutDigest = {
        id: ENVIRONMENT_AUTHORIZATION_ID,
        approvalId: "apr_123e4567-e89b-42d3-a456-426614174000",
        approvalEvidenceDigest: DIGEST,
        scope: {
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          environmentId: ENVIRONMENT_ID,
          repositoryIdentity: "github:autostack/coding-factory",
          sourceCommit: "a".repeat(40),
          branch: "autostack/authority",
          cwdRoot: ".",
          resourceLimits: { cpu: 1, memoryMb: 64, durationSeconds: 60 },
          networkPolicy: "host" as const,
          filesystemDisclosure: "host_user" as const,
          allowedCredentialRefIds: []
        },
        createdAt: NOW,
        expiresAt: "2026-08-21T12:00:30.000Z"
      };
      const environment = EnvironmentAuthorizationSchema.parse({
        ...environmentWithoutDigest,
        digest: await digestEnvironmentAuthorization({
          ...environmentWithoutDigest,
          digest: DIGEST
        })
      });
      const commandWithoutDigest = {
        id: COMMAND_AUTHORIZATION_ID,
        approvalId: "apr_123e4567-e89b-42d3-a456-426614174001",
        approvalEvidenceDigest: DIGEST,
        scope: {
          environmentAuthorizationId: environment.id,
          environmentAuthorizationDigest: environment.digest,
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          environmentId: ENVIRONMENT_ID,
          commandId: COMMAND_ID,
          action: "implement" as const,
          commandDigest: DIGEST,
          repositoryIdentity: environment.scope.repositoryIdentity,
          sourceCommit: environment.scope.sourceCommit,
          branch: environment.scope.branch,
          cwdRoot: ".",
          networkPolicy: "host" as const,
          filesystemDisclosure: "host_user" as const,
          resourceLimits: environment.scope.resourceLimits,
          allowedCredentialRefIds: []
        },
        createdAt: NOW,
        expiresAt: "2026-08-21T12:00:30.000Z"
      };
      const command = CommandAuthorizationSchema.parse({
        ...commandWithoutDigest,
        digest: await digestCommandAuthorization({ ...commandWithoutDigest, digest: DIGEST })
      });
      const run = RunSchema.parse({
        schemaVersion: 1,
        id: RUN_ID,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_123e4567-e89b-42d3-a456-426614174000",
        workflowVersion: "foundation.v1",
        status: "completed",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW
      });
      const descriptor = ArtifactDescriptorSchema.parse({
        artifactId: "art_123e4567-e89b-42d3-a456-426614174000",
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        commandId: COMMAND_ID,
        kind: "command_output",
        mediaType: "text/plain",
        digest: DIGEST,
        byteSize: 1,
        createdAt: NOW
      });
      const persisted: ExecutionPolicyAuthority = {
        resolveRun: async () => run,
        resolveApproval: async () => undefined,
        resolveEnvironmentAuthorization: async () => environment,
        resolveCommandAuthorization: async () => command,
        resolveArtifact: async () => descriptor,
        resolveTerminalRunEvidence: async () => ({
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          evidence: { status: "completed", terminalEventSequence: 7, terminalEventDigest: DIGEST }
        }),
        hasActiveCommands: async () => false
      };
      const eventRequest = {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        environmentId: ENVIRONMENT_ID,
        commandId: COMMAND_ID,
        environmentAuthorizationId: environment.id,
        environmentAuthorizationDigest: environment.digest,
        commandAuthorizationId: command.id,
        commandAuthorizationDigest: command.digest,
        after: 0
      };
      const cancelRequest = {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        environmentId: ENVIRONMENT_ID,
        commandId: COMMAND_ID,
        environmentAuthorizationId: environment.id,
        environmentAuthorizationDigest: environment.digest,
        commandAuthorizationId: command.id,
        commandAuthorizationDigest: command.digest,
        idempotency: { key: "cancel-1" }
      };
      const artifactRequest = {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        environmentId: ENVIRONMENT_ID,
        commandId: COMMAND_ID,
        environmentAuthorizationId: environment.id,
        environmentAuthorizationDigest: environment.digest,
        commandAuthorizationId: command.id,
        commandAuthorizationDigest: command.digest,
        artifactId: descriptor.artifactId,
        offset: 0,
        length: 1
      };
      expect(
        (
          await authorizeCommandEvents({
            authority: persisted,
            authenticatedWorkspaceId: WORKSPACE_ID,
            request: eventRequest
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await authorizeCancelCommand({
            authority: persisted,
            authenticatedWorkspaceId: WORKSPACE_ID,
            request: cancelRequest
          })
        ).ok
      ).toBe(true);
      expect(
        (
          await authorizeArtifactRead({
            authority: persisted,
            authenticatedWorkspaceId: WORKSPACE_ID,
            request: artifactRequest
          })
        ).ok
      ).toBe(true);
      expect(
        await authorizeArtifactRead({
          authority: { ...persisted, resolveArtifact: async () => undefined },
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: artifactRequest
        })
      ).toEqual({ ok: false, code: "record_not_found" });
      expect(
        await authorizeArtifactRead({
          authority: {
            ...persisted,
            resolveArtifact: async () => ({
              ...descriptor,
              commandId: CommandIdSchema.parse("cmd_123e4567-e89b-42d3-a456-426614174099")
            })
          },
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: artifactRequest
        })
      ).toEqual({ ok: false, code: "artifact_mismatch" });
      expect(
        await decideEnvironmentDisposal({
          authority: persisted,
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: {
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            environmentId: ENVIRONMENT_ID,
            environmentAuthorizationId: environment.id,
            environmentAuthorizationDigest: environment.digest,
            terminalRunEvidence: {
              status: "completed",
              terminalEventSequence: 7,
              terminalEventDigest: DIGEST
            },
            idempotency: { key: "dispose-1" }
          },
          actor: { kind: "user", id: "local-user" },
          origin: "desktop"
        })
      ).toMatchObject({ ok: true });
      expect(
        await authorizeCommandEvents({
          authority: persisted,
          authenticatedWorkspaceId: MISSING_WORKSPACE,
          request: eventRequest
        })
      ).toEqual({ ok: false, code: "workspace_mismatch" });
      expect(
        await authorizeCommandEvents({
          authority: persisted,
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: { ...eventRequest, commandAuthorizationDigest: DIGEST }
        })
      ).toEqual({ ok: false, code: "authorization_mismatch" });
      expect(
        await authorizeCommandEvents({
          authority: persisted,
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: {
            ...eventRequest,
            commandAuthorizationId: CommandAuthorizationIdSchema.parse(
              "cmdauth_123e4567-e89b-42d3-a456-426614174099"
            )
          }
        })
      ).toEqual({ ok: false, code: "record_identity_mismatch" });
      expect(
        await decideEnvironmentDisposal({
          authority: persisted,
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: {
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            environmentId: ENVIRONMENT_ID,
            environmentAuthorizationId: environment.id,
            environmentAuthorizationDigest: environment.digest,
            terminalRunEvidence: {
              status: "completed",
              terminalEventSequence: 7,
              terminalEventDigest: DIGEST
            },
            idempotency: { key: "dispose-2" }
          },
          actor: { kind: "system", id: "operator" },
          origin: "desktop"
        })
      ).toEqual({ ok: false, code: "operator_required" });
      expect(
        await decideEnvironmentDisposal({
          authority: { ...persisted, hasActiveCommands: async () => true },
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: {
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            environmentId: ENVIRONMENT_ID,
            environmentAuthorizationId: environment.id,
            environmentAuthorizationDigest: environment.digest,
            terminalRunEvidence: {
              status: "completed",
              terminalEventSequence: 7,
              terminalEventDigest: DIGEST
            },
            idempotency: { key: "dispose-3" }
          },
          actor: { kind: "user", id: "local-user" },
          origin: "desktop"
        })
      ).toEqual({ ok: false, code: "active_command" });
      expect(
        await decideEnvironmentDisposal({
          authority: persisted,
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: {
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            environmentId: ENVIRONMENT_ID,
            environmentAuthorizationId: environment.id,
            environmentAuthorizationDigest: environment.digest,
            terminalRunEvidence: {
              status: "completed",
              terminalEventSequence: 7,
              terminalEventDigest: DIGEST
            },
            idempotency: { key: "dispose-origin" }
          },
          actor: { kind: "user", id: "local-user" },
          origin: "cli"
        })
      ).toMatchObject({ ok: true });
      const disposalRequest = {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        environmentId: ENVIRONMENT_ID,
        environmentAuthorizationId: environment.id,
        environmentAuthorizationDigest: environment.digest,
        terminalRunEvidence: {
          status: "completed" as const,
          terminalEventSequence: 7,
          terminalEventDigest: DIGEST
        },
        idempotency: { key: "dispose-4" }
      };
      expect(
        await decideEnvironmentDisposal({
          authority: { ...persisted, resolveTerminalRunEvidence: async () => undefined },
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: disposalRequest,
          actor: { kind: "user", id: "local-user" },
          origin: "desktop"
        })
      ).toEqual({ ok: false, code: "record_not_found" });
      expect(
        await decideEnvironmentDisposal({
          authority: {
            ...persisted,
            resolveTerminalRunEvidence: async () => ({
              workspaceId: WORKSPACE_ID,
              runId: RUN_ID,
              evidence: {
                status: "cancelled",
                terminalEventSequence: 7,
                terminalEventDigest: DIGEST
              }
            })
          },
          authenticatedWorkspaceId: WORKSPACE_ID,
          request: disposalRequest,
          actor: { kind: "user", id: "local-user" },
          origin: "desktop"
        })
      ).toEqual({ ok: false, code: "terminal_evidence_mismatch" });
    }
  );
});
