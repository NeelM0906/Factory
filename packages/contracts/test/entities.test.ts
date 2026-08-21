import { describe, expect, it } from "vitest";

import {
  ApprovalSchema,
  ArtifactSchema,
  AutomationSchema,
  CredentialRefSchema,
  FactoryLaneSchema,
  ProjectSchema,
  RUN_STATUSES,
  RunSchema,
  RunStageSchema,
  StageRunSchema,
  WorkItemSchema,
  WorkspaceSchema
} from "../src/entities.js";

const IDS = {
  approval: "apr_123e4567-e89b-42d3-a456-426614174000",
  artifact: "art_123e4567-e89b-42d3-a456-426614174000",
  automation: "aut_123e4567-e89b-42d3-a456-426614174000",
  credential: "cred_123e4567-e89b-42d3-a456-426614174000",
  project: "prj_123e4567-e89b-42d3-a456-426614174000",
  run: "run_123e4567-e89b-42d3-a456-426614174000",
  stage: "stage_123e4567-e89b-42d3-a456-426614174000",
  workItem: "wi_123e4567-e89b-42d3-a456-426614174000",
  workspace: "ws_123e4567-e89b-42d3-a456-426614174000"
} as const;

const NOW = "2026-08-20T12:00:00.000Z";

describe("entity contracts", () => {
  it("accepts the implicit personal local workspace", () => {
    expect(
      WorkspaceSchema.parse({
        schemaVersion: 1,
        id: IDS.workspace,
        name: "Personal",
        mode: "local",
        createdAt: NOW,
        updatedAt: NOW
      })
    ).toMatchObject({ mode: "local", name: "Personal" });
  });

  it("accepts a GitHub project and a manual work item", () => {
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: IDS.project,
      workspaceId: IDS.workspace,
      name: "AutoStack",
      repository: {
        provider: "github",
        owner: "autostack-dev",
        name: "autostack",
        repositoryId: "R_kgDOExample"
      },
      executionSources: [{ kind: "local", checkoutPath: "/projects/autostack" }],
      createdAt: NOW,
      updatedAt: NOW
    });
    const workItem = WorkItemSchema.parse({
      schemaVersion: 1,
      id: IDS.workItem,
      workspaceId: IDS.workspace,
      projectId: IDS.project,
      source: { kind: "manual", client: "desktop" },
      title: "Add durable workflow state",
      description: "Persist transitions before external effects.",
      requester: { externalId: "local-user", displayName: "Local User" },
      attachments: [],
      priority: "normal",
      labels: ["foundation"],
      acceptanceContext: ["State survives restart"],
      createdAt: NOW,
      updatedAt: NOW
    });

    expect(project.repository.owner).toBe("autostack-dev");
    expect(workItem.source.kind).toBe("manual");
  });

  it.each(RUN_STATUSES)("accepts the %s run status", (status) => {
    expect(
      RunSchema.parse({
        schemaVersion: 1,
        id: IDS.run,
        workspaceId: IDS.workspace,
        workItemId: IDS.workItem,
        workflowVersion: "foundation.v1",
        status,
        createdAt: NOW,
        updatedAt: NOW
      }).status
    ).toBe(status);
  });

  it("keeps harness, model route, and environment as separate stage references", () => {
    const stage = StageRunSchema.parse({
      schemaVersion: 1,
      id: IDS.stage,
      workspaceId: IDS.workspace,
      runId: IDS.run,
      stage: "plan",
      status: "queued",
      attempt: 1,
      harnessRef: "codex-local",
      modelRouteRef: "gateway:openai/gpt-5",
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
      inputArtifactIds: [],
      outputArtifactIds: [],
      createdAt: NOW,
      updatedAt: NOW
    });

    expect(stage).toMatchObject({
      harnessRef: "codex-local",
      modelRouteRef: "gateway:openai/gpt-5"
    });
  });

  it("requires a SHA-256 digest for approval evidence", () => {
    expect(() =>
      ApprovalSchema.parse({
        schemaVersion: 1,
        id: IDS.approval,
        workspaceId: IDS.workspace,
        runId: IDS.run,
        kind: "plan",
        status: "pending",
        evidenceDigest: "too-short",
        eligibleApproverIds: ["local-user"],
        createdAt: NOW,
        updatedAt: NOW
      })
    ).toThrow();
  });

  it("accepts immutable artifact metadata", () => {
    expect(
      ArtifactSchema.parse({
        schemaVersion: 1,
        id: IDS.artifact,
        workspaceId: IDS.workspace,
        runId: IDS.run,
        kind: "plan",
        digest: "a".repeat(64),
        mediaType: "text/markdown",
        byteSize: 42,
        storageRef: "artifacts/aa/plan.md",
        createdAt: NOW
      }).byteSize
    ).toBe(42);
  });

  it("accepts a versioned manual automation", () => {
    expect(
      AutomationSchema.parse({
        schemaVersion: 1,
        id: IDS.automation,
        workspaceId: IDS.workspace,
        name: "Manual foundation run",
        version: 1,
        enabled: true,
        trigger: { kind: "manual" },
        workflowId: "foundation.v1",
        projectIds: [IDS.project],
        ownerActorId: "local-user",
        createdAt: NOW,
        updatedAt: NOW
      }).trigger.kind
    ).toBe("manual");
  });

  it("rejects secret material in a credential reference", () => {
    expect(() =>
      CredentialRefSchema.parse({
        schemaVersion: 1,
        id: IDS.credential,
        workspaceId: IDS.workspace,
        provider: "github",
        store: "macos_keychain",
        locator: "autostack/github/default",
        metadata: { label: "GitHub", scopes: ["contents:write"] },
        secret: "ghp_not_allowed",
        createdAt: NOW,
        updatedAt: NOW
      })
    ).toThrow();
  });

  it("keeps executable stages separate from factory lanes", () => {
    expect(RunStageSchema.parse("verify")).toBe("verify");
    expect(FactoryLaneSchema.parse("validate")).toBe("validate");
    expect(() => RunStageSchema.parse("validate")).toThrow();
  });
});
