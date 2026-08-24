import { describe, expect, it } from "vitest";

import {
  ApprovalIdSchema,
  CommandAcceptedSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  DesktopRepositoryInspectionSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  InspectedSourceCapabilityIdSchema,
  RepositoryCapabilityIdSchema,
  RepositoryInspectionSchema,
  RunIdSchema,
  type LocalPrepareRequest,
  type LocalStartRequest
} from "@autostack/contracts";

import { createControlPlaneDesktopDispatcher } from "../src/desktop-dispatcher.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const ids = {
  runId: RunIdSchema.parse(`run_${UUID}`),
  environmentId: EnvironmentIdSchema.parse(`env_${UUID}`),
  commandId: CommandIdSchema.parse(`cmd_${UUID}`),
  environmentAuthorizationId: EnvironmentAuthorizationIdSchema.parse(`envauth_${UUID}`),
  commandAuthorizationId: CommandAuthorizationIdSchema.parse(`cmdauth_${UUID}`),
  inspectedSourceCapabilityId: InspectedSourceCapabilityIdSchema.parse(`inspsrc_${UUID}`),
  repositoryCapabilityId: RepositoryCapabilityIdSchema.parse(`repocap_${UUID}`),
  environmentApprovalId: ApprovalIdSchema.parse("apr_223e4567-e89b-42d3-a456-426614174000"),
  commandApprovalId: ApprovalIdSchema.parse("apr_323e4567-e89b-42d3-a456-426614174000")
} as const;

describe("control-plane desktop dispatcher", () => {
  it("resolves source and approval authority inside the control plane", async () => {
    let prepared: LocalPrepareRequest | undefined;
    let started: LocalStartRequest | undefined;
    const dispatcher = createControlPlaneDesktopDispatcher({
      ids: { inspectedSourceCapability: () => ids.inspectedSourceCapabilityId },
      repositoryPaths: { resolve: () => "/private/source" },
      authority: {
        resolvePreparationApproval: async () => ids.environmentApprovalId,
        resolveCommandApproval: async () => ids.commandApprovalId
      },
      local: {
        inspect: async () =>
          RepositoryInspectionSchema.parse({
            repositoryIdentity: "github:example/repo",
            canonicalSourcePath: "/canonical/source",
            repositoryCommonDirectory: "/canonical/source/.git",
            resolvedBaseRef: "refs/heads/main",
            sourceCommit: "a".repeat(40),
            dirty: false,
            diagnostics: []
          }),
        prepare: async (input) => {
          prepared = input;
          return { environment: {}, replayed: false } as never;
        },
        start: async (input) => {
          started = input;
          return CommandAcceptedSchema.parse({
            commandId: ids.commandId,
            replayed: true,
            acceptedAt: "2026-08-23T12:00:00.000Z"
          });
        }
      }
    });

    await expect(
      dispatcher.dispatch({
        operation: "local.inspect",
        repositoryCapabilityId: ids.repositoryCapabilityId,
        baseRef: "main",
        branchSlug: "safe-feature"
      })
    ).resolves.toEqual(
      DesktopRepositoryInspectionSchema.parse({
        inspectedSourceCapabilityId: ids.inspectedSourceCapabilityId
      })
    );
    await dispatcher.dispatch({
      operation: "local.prepare",
      runId: ids.runId,
      environmentId: ids.environmentId,
      environmentAuthorizationId: ids.environmentAuthorizationId,
      inspectedSourceCapabilityId: ids.inspectedSourceCapabilityId,
      idempotencyKey: "prepare-1"
    });
    await dispatcher.dispatch({
      operation: "local.start",
      runId: ids.runId,
      environmentId: ids.environmentId,
      commandId: ids.commandId,
      commandAuthorizationId: ids.commandAuthorizationId,
      command: {
        executable: "pnpm",
        args: ["test"],
        cwd: ".",
        environment: [],
        timeoutSeconds: 60,
        terminal: { columns: 80, rows: 24 }
      },
      idempotencyKey: "start-1"
    });

    expect(prepared).toMatchObject({
      approvalId: ids.environmentApprovalId,
      sourcePath: "/canonical/source",
      baseRef: "refs/heads/main",
      branchSlug: "safe-feature"
    });
    expect(started).toMatchObject({ approvalId: ids.commandApprovalId });
    expect(JSON.stringify(prepared)).not.toContain("repositoryCapabilityId");
  });

  it("rejects an unknown inspected-source capability before local prepare", async () => {
    const dispatcher = createControlPlaneDesktopDispatcher({
      ids: { inspectedSourceCapability: () => ids.inspectedSourceCapabilityId },
      repositoryPaths: { resolve: () => "/private/source" },
      authority: {
        resolvePreparationApproval: async () => ids.environmentApprovalId,
        resolveCommandApproval: async () => ids.commandApprovalId
      },
      local: {
        inspect: async () => {
          throw new Error("must not inspect");
        },
        prepare: async () => {
          throw new Error("must not prepare");
        },
        start: async () => {
          throw new Error("must not start");
        }
      }
    });

    await expect(
      dispatcher.dispatch({
        operation: "local.prepare",
        runId: ids.runId,
        environmentId: ids.environmentId,
        environmentAuthorizationId: ids.environmentAuthorizationId,
        inspectedSourceCapabilityId: ids.inspectedSourceCapabilityId,
        idempotencyKey: "prepare-1"
      })
    ).rejects.toThrow(/source capability/i);
  });
});
