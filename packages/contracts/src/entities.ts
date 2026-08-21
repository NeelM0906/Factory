import { z } from "zod";

import {
  AgentSessionIdSchema,
  ApprovalIdSchema,
  ArtifactIdSchema,
  AutomationIdSchema,
  CredentialRefIdSchema,
  EnvironmentIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  StageRunIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import { SafeMetadataStringSchema } from "./secret-safety.js";

const TimestampSchema = z.iso.datetime();
const VersionSchema = z.literal(1);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

export const RUN_STATUSES = [
  "queued",
  "triaging",
  "needs_clarification",
  "planning",
  "awaiting_plan_approval",
  "provisioning",
  "implementing",
  "verifying",
  "reviewing",
  "awaiting_publish_approval",
  "publishing",
  "completed",
  "waiting_for_user",
  "retry_scheduled",
  "cancelling",
  "cancelled",
  "failed"
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export const RunStageSchema = z.enum([
  "triage",
  "plan",
  "implement",
  "verify",
  "review",
  "publish"
]);
export const FactoryLaneSchema = z.enum([
  "signal",
  "triage",
  "plan",
  "implement",
  "validate",
  "release",
  "document",
  "monitor"
]);

export const ActorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user"),
      id: z.string().min(1),
      displayName: z.string().min(1).optional()
    })
    .strict(),
  z.object({ kind: z.literal("system"), id: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal("agent"), id: z.string().min(1), adapterId: z.string().min(1) })
    .strict(),
  z
    .object({ kind: z.literal("integration"), id: z.string().min(1), provider: z.string().min(1) })
    .strict()
]);

export const WorkspaceSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: WorkspaceIdSchema,
    name: z.string().trim().min(1).max(120),
    mode: z.enum(["local", "team"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .strict();

const RepositorySchema = z
  .object({
    provider: z.literal("github"),
    owner: z.string().trim().min(1),
    name: z.string().trim().min(1),
    repositoryId: z.string().min(1)
  })
  .strict();

const ExecutionSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), checkoutPath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("cloud"), snapshotRef: z.string().min(1) }).strict()
]);

export const ProjectSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: ProjectIdSchema,
    workspaceId: WorkspaceIdSchema,
    name: z.string().trim().min(1).max(160),
    repository: RepositorySchema,
    executionSources: z.array(ExecutionSourceSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .strict();

export const SourceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("manual"), client: z.enum(["desktop", "web", "cli", "api"]) })
    .strict(),
  z
    .object({
      kind: z.literal("github"),
      repositoryFullName: z.string().min(3),
      issueNumber: z.number().int().positive(),
      deliveryId: z.string().min(1),
      url: z.url().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("slack"),
      slackWorkspaceId: z.string().min(1),
      channelId: z.string().min(1),
      threadTs: z.string().min(1),
      deliveryId: z.string().min(1)
    })
    .strict(),
  z
    .object({ kind: z.literal("api"), clientId: z.string().min(1), deliveryId: z.string().min(1) })
    .strict()
]);

export const WorkItemSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: WorkItemIdSchema,
    workspaceId: WorkspaceIdSchema,
    projectId: ProjectIdSchema.optional(),
    source: SourceRefSchema,
    title: z.string().trim().min(1).max(240),
    description: z.string().max(100_000).default(""),
    requester: z
      .object({ externalId: z.string().min(1), displayName: z.string().trim().min(1).optional() })
      .strict(),
    attachments: z
      .array(z.object({ name: z.string().min(1), uri: z.string().min(1) }).strict())
      .default([]),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    labels: z.array(z.string().trim().min(1).max(100)),
    acceptanceContext: z.array(z.string().trim().min(1).max(2_000)),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .strict();

export const RunSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: RunIdSchema,
    workspaceId: WorkspaceIdSchema,
    workItemId: WorkItemIdSchema,
    workflowVersion: z.string().min(1),
    status: RunStatusSchema,
    currentStage: RunStageSchema.optional(),
    resumeStatus: RunStatusSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.optional()
  })
  .strict();

export const StageRunSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: StageRunIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    stage: RunStageSchema,
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    attempt: z.number().int().positive(),
    harnessRef: z.string().min(1).optional(),
    modelRouteRef: z.string().min(1).optional(),
    environmentId: EnvironmentIdSchema.optional(),
    inputArtifactIds: z.array(ArtifactIdSchema),
    outputArtifactIds: z.array(ArtifactIdSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional()
  })
  .strict();

export const AgentSessionSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: AgentSessionIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    stageRunId: StageRunIdSchema,
    adapterId: z.string().min(1),
    providerSessionRef: z.string().min(1).optional(),
    status: z.enum([
      "starting",
      "active",
      "waiting",
      "completed",
      "cancelled",
      "failed",
      "interrupted"
    ]),
    capabilities: z
      .object({
        steering: z.boolean(),
        resume: z.boolean(),
        permissions: z.boolean(),
        structuredPlans: z.boolean(),
        modelSelection: z.boolean()
      })
      .strict(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .strict();

export const EnvironmentSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: EnvironmentIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    runnerId: z.string().min(1),
    repositoryRef: z.string().min(1),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/i),
    branch: z.string().min(1),
    workspacePath: z.string().min(1).optional(),
    networkPolicy: z.enum(["none", "restricted", "repository"]),
    resourceLimits: z
      .object({
        cpu: z.number().positive(),
        memoryMb: z.number().int().positive(),
        durationSeconds: z.number().int().positive()
      })
      .strict(),
    createdAt: TimestampSchema
  })
  .strict();

const ApprovalDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    actor: ActorSchema,
    origin: z.enum(["desktop", "web", "cli", "slack", "github", "api"]),
    decidedAt: TimestampSchema
  })
  .strict();

export const ApprovalSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: ApprovalIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    kind: z.enum(["plan", "publish", "permission"]),
    status: z.enum(["pending", "approved", "rejected", "stale"]),
    evidenceDigest: Sha256Schema,
    eligibleApproverIds: z.array(z.string().min(1)).min(1),
    decision: ApprovalDecisionSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .strict();

export const ArtifactSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: ArtifactIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    stageRunId: StageRunIdSchema.optional(),
    kind: z.enum([
      "plan",
      "patch",
      "diff",
      "test_report",
      "command_transcript",
      "reviewer_report",
      "screenshot",
      "pull_request_ref"
    ]),
    digest: Sha256Schema,
    mediaType: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    storageRef: z.string().min(1),
    createdAt: TimestampSchema
  })
  .strict();

const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z
    .object({
      kind: z.literal("schedule"),
      expression: z.string().min(1),
      timezone: z.string().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("github"),
      event: z.string().min(1),
      filter: z.string().min(1).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("slack"),
      event: z.string().min(1),
      filter: z.string().min(1).optional()
    })
    .strict()
]);

export const AutomationSchema = z
  .object({
    schemaVersion: VersionSchema,
    id: AutomationIdSchema,
    workspaceId: WorkspaceIdSchema,
    name: z.string().trim().min(1).max(160),
    version: z.number().int().positive(),
    enabled: z.boolean(),
    trigger: AutomationTriggerSchema,
    workflowId: z.string().min(1),
    projectIds: z.array(ProjectIdSchema),
    ownerActorId: z.string().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  })
  .strict();

const CredentialMetadataSchema = z
  .object({
    label: SafeMetadataStringSchema.max(160),
    account: SafeMetadataStringSchema.max(320).optional(),
    scopes: z.array(SafeMetadataStringSchema.max(320)).max(100).default([]),
    expiresAt: TimestampSchema.optional()
  })
  .strict();

const CredentialRefBaseShape = {
  schemaVersion: VersionSchema,
  id: CredentialRefIdSchema,
  workspaceId: WorkspaceIdSchema,
  provider: SafeMetadataStringSchema.max(120),
  metadata: CredentialMetadataSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
} as const;

export const CredentialRefSchema = z.discriminatedUnion("store", [
  z
    .object({
      ...CredentialRefBaseShape,
      store: z.literal("macos_keychain"),
      locator: z
        .object({
          service: SafeMetadataStringSchema.max(320),
          account: SafeMetadataStringSchema.max(320)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...CredentialRefBaseShape,
      store: z.literal("vercel"),
      locator: z
        .object({
          projectId: SafeMetadataStringSchema.max(320),
          name: SafeMetadataStringSchema.max(320)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...CredentialRefBaseShape,
      store: z.literal("server_encrypted"),
      locator: z.object({ recordId: SafeMetadataStringSchema.max(320) }).strict()
    })
    .strict(),
  z
    .object({
      ...CredentialRefBaseShape,
      store: z.literal("external_vault"),
      locator: z
        .object({
          vault: SafeMetadataStringSchema.max(320),
          path: SafeMetadataStringSchema.max(1_000),
          key: SafeMetadataStringSchema.max(320)
        })
        .strict()
    })
    .strict()
]);

export type Actor = z.infer<typeof ActorSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type WorkItem = z.infer<typeof WorkItemSchema>;
export type Run = z.infer<typeof RunSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunStage = z.infer<typeof RunStageSchema>;
export type FactoryLane = z.infer<typeof FactoryLaneSchema>;
export type StageRun = z.infer<typeof StageRunSchema>;
export type AgentSession = z.infer<typeof AgentSessionSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type Automation = z.infer<typeof AutomationSchema>;
export type CredentialRef = z.infer<typeof CredentialRefSchema>;
