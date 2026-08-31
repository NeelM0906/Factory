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
  SOURCE_REF_KINDS,
  SourceAuthorizationPolicySchema,
  StageRunSchema,
  WorkItemSchema,
  WorkspaceSchema,
  type SourceRef
} from "../src/entities.js";
import { digestSourceAuthorizationPolicy } from "../src/station-evidence.js";

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
        locator: { service: "autostack.github", account: "default" },
        metadata: { label: "GitHub", scopes: ["contents:write"] },
        secret: "ghp_not_allowed",
        createdAt: NOW,
        updatedAt: NOW
      })
    ).toThrow();
  });

  it.each(["label", "account", "scope", "locator"])(
    "rejects a raw credential embedded in credential %s metadata",
    (field) => {
      const token = "ghp_0123456789abcdefghijklmnop";
      const credential = {
        schemaVersion: 1,
        id: IDS.credential,
        workspaceId: IDS.workspace,
        provider: "github",
        store: "macos_keychain",
        locator: {
          service: field === "locator" ? token : "autostack.github",
          account: field === "account" ? token : "default"
        },
        metadata: {
          label: field === "label" ? token : "GitHub",
          scopes: [field === "scope" ? token : "contents:write"]
        },
        createdAt: NOW,
        updatedAt: NOW
      };

      expect(() => CredentialRefSchema.parse(credential)).toThrow();
    }
  );

  it("keeps executable stages separate from factory lanes", () => {
    expect(RunStageSchema.parse("verify")).toBe("verify");
    expect(FactoryLaneSchema.parse("validate")).toBe("validate");
    expect(() => RunStageSchema.parse("validate")).toThrow();
  });
});

describe("origin vocabulary", () => {
  it("is declared once and reused by every surface that records one", async () => {
    const { ORIGINS, OriginSchema } = await import("../src/entities.js");
    const { ApprovalDecisionRequestSchema } = await import("../src/api.js");
    const { ClarificationResponseSchema } = await import("../src/station-evidence.js");

    expect([...ORIGINS]).toEqual(["desktop", "web", "cli", "slack", "github", "api"]);
    expect(OriginSchema.options).toEqual([...ORIGINS]);
    // The two surfaces that used to keep their own copy now read the same options object.
    expect(ApprovalDecisionRequestSchema.shape.origin.options).toEqual(OriginSchema.options);
    expect(ClarificationResponseSchema.shape.origin.options).toEqual(OriginSchema.options);
  });

  it("accepts every declared origin and refuses an undeclared one at each event site", async () => {
    const { ORIGINS } = await import("../src/entities.js");
    const { PendingDomainEventSchema } = await import("../src/events.js");
    const envelope = {
      workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
      actor: { kind: "user", id: "local-user" },
      correlationId: "123e4567-e89b-42d3-a456-426614174001",
      occurredAt: "2026-08-20T12:00:00.000Z"
    };
    const runId = "run_123e4567-e89b-42d3-a456-426614174000";
    const bodies = (origin: string) => [
      {
        type: "approval.decided",
        payload: {
          approvalId: "apr_123e4567-e89b-42d3-a456-426614174000",
          runId,
          decision: "approved",
          evidenceDigest: "a".repeat(64),
          origin,
          decidedAt: "2026-08-20T12:00:00.000Z"
        }
      },
      {
        type: "run.steered",
        payload: {
          runId,
          instruction: "Prefer the smaller refactor.",
          origin,
          actorId: "local-user",
          acceptedAt: "2026-08-20T12:00:00.000Z"
        }
      }
    ];

    for (const origin of ORIGINS) {
      for (const body of bodies(origin)) {
        expect(PendingDomainEventSchema.parse({ ...envelope, ...body }).type).toBe(body.type);
      }
    }
    for (const body of bodies("carrier-pigeon")) {
      expect(() => PendingDomainEventSchema.parse({ ...envelope, ...body })).toThrow();
    }
  });
});

describe("source authorization policy", () => {
  // Completeness half of the SOURCE_REF_KINDS bind: a fifth SourceRef kind that is missing from
  // the list makes this alias `never`, and the assignment below stops compiling.
  type MissingKinds = Exclude<SourceRef["kind"], (typeof SOURCE_REF_KINDS)[number]>;
  const noSourceRefKindIsMissing: MissingKinds extends never ? true : never = true;

  const policy = {
    schemaVersion: 1 as const,
    workspaceId: IDS.workspace,
    authorizedRequesters: [
      { source: "github" as const, externalId: "octocat" },
      { source: "manual" as const, externalId: "workspace-owner" }
    ],
    updatedAt: NOW
  };

  it("scopes workspace-wide when projectId is absent, per-project when present", () => {
    expect(noSourceRefKindIsMissing).toBe(true);
    expect(SourceAuthorizationPolicySchema.parse(policy).projectId).toBeUndefined();
    expect(
      SourceAuthorizationPolicySchema.parse({ ...policy, projectId: IDS.project }).projectId
    ).toBe(IDS.project);
  });

  it("accepts a deny-all empty policy and rejects source kinds outside the SourceRef alphabet", () => {
    expect(
      SourceAuthorizationPolicySchema.parse({ ...policy, authorizedRequesters: [] })
        .authorizedRequesters
    ).toEqual([]);
    // "local" is a real value in the ADJACENT ExecutionSource alphabet (where execution runs) —
    // the exact confusion this schema exists to prevent, not an arbitrary junk string.
    expect(() =>
      SourceAuthorizationPolicySchema.parse({
        ...policy,
        authorizedRequesters: [{ source: "local", externalId: "octocat" }]
      })
    ).toThrow();
    expect(() =>
      SourceAuthorizationPolicySchema.parse({
        ...policy,
        authorizedRequesters: [{ source: "github", externalId: "" }]
      })
    ).toThrow();
  });

  it("digests policy content: order- and updatedAt-insensitive, entry-sensitive", async () => {
    const digest = await digestSourceAuthorizationPolicy(policy);
    const reordered = {
      ...policy,
      authorizedRequesters: [...policy.authorizedRequesters].reverse(),
      updatedAt: "2026-08-21T12:00:00.000Z"
    };
    expect(await digestSourceAuthorizationPolicy(reordered)).toBe(digest);
    expect(
      await digestSourceAuthorizationPolicy({
        ...policy,
        authorizedRequesters: [
          ...policy.authorizedRequesters,
          { source: "slack", externalId: "U12345678" }
        ]
      })
    ).not.toBe(digest);
    expect(await digestSourceAuthorizationPolicy({ ...policy, projectId: IDS.project })).not.toBe(
      digest
    );
  });
});
