import { z } from "zod";

import {
  ApprovalIdSchema,
  ArtifactIdSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  RepositoryCapabilityIdSchema,
  RunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import {
  CancelCommandResponseSchema,
  CommandAcceptedSchema,
  DisposeEnvironmentResponseSchema,
  ListEnvironmentsResponseSchema,
  ReadArtifactChunkResponseSchema,
  RunnerStreamEventSchema
} from "./runner.js";
import { SafeMetadataStringSchema } from "./secret-safety.js";

const EmptyRequestSchema = z.object({}).strict();
const RepositoryDisplayLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^/\\\u0000-\u001f]+$/)
  .refine((value) => value !== "." && value !== "..", "A basename display label is required.");
const RepositoryCapabilitySchema = z
  .object({
    id: RepositoryCapabilityIdSchema,
    label: RepositoryDisplayLabelSchema,
    expiresAt: z.iso.datetime()
  })
  .strict();
export const DesktopRepositoryPickerRequestSchema = EmptyRequestSchema;
export const DesktopRepositoryPickerResponseSchema = z
  .object({ repository: RepositoryCapabilitySchema.nullable() })
  .strict();
export const DesktopRuntimeStatusSchema = z
  .object({
    status: z.enum(["starting", "ready", "degraded", "stopped"]),
    message: SafeMetadataStringSchema.max(512).optional()
  })
  .strict();
export const DesktopLocalInspectRequestSchema = z
  .object({
    repositoryCapabilityId: RepositoryCapabilityIdSchema,
    baseRef: SafeMetadataStringSchema.max(512)
  })
  .strict();
export const DesktopRepositoryInspectionSchema = z
  .object({
    repositoryIdentity: SafeMetadataStringSchema.max(1_024),
    remoteIdentity: SafeMetadataStringSchema.max(1_024).optional(),
    resolvedBaseRef: SafeMetadataStringSchema.max(512),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    dirty: z.boolean(),
    diagnostics: z.array(SafeMetadataStringSchema.max(2_000)).max(100)
  })
  .strict();
export const DesktopLocalListRequestSchema = EmptyRequestSchema;
export const DesktopLocalPrepareRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    approvalId: ApprovalIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopLocalStartRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopCommandStreamRequestSchema = z
  .object({
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    after: z.number().int().nonnegative().default(0)
  })
  .strict();
export const DesktopArtifactReadRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    artifactId: ArtifactIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(1_048_576)
  })
  .strict();
export const DesktopLocalCancelRequestSchema = z
  .object({
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopLocalDisposeRequestSchema = z
  .object({
    environmentId: EnvironmentIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();

export const DesktopApiOperationMapSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("runtime.status"),
      request: EmptyRequestSchema,
      response: DesktopRuntimeStatusSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("repository.pick"),
      request: DesktopRepositoryPickerRequestSchema,
      response: DesktopRepositoryPickerResponseSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("local.inspect"),
      request: DesktopLocalInspectRequestSchema,
      response: DesktopRepositoryInspectionSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("local.list"),
      request: DesktopLocalListRequestSchema,
      response: ListEnvironmentsResponseSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("local.prepare"),
      request: DesktopLocalPrepareRequestSchema,
      response: z.object({ environmentId: EnvironmentIdSchema }).strict()
    })
    .strict(),
  z
    .object({
      operation: z.literal("local.start"),
      request: DesktopLocalStartRequestSchema,
      response: CommandAcceptedSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("local.events"),
      request: DesktopCommandStreamRequestSchema,
      response: RunnerStreamEventSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("local.artifact.read"),
      request: DesktopArtifactReadRequestSchema,
      response: ReadArtifactChunkResponseSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("local.cancel"),
      request: DesktopLocalCancelRequestSchema,
      response: CancelCommandResponseSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("local.dispose"),
      request: DesktopLocalDisposeRequestSchema,
      response: DisposeEnvironmentResponseSchema
    })
    .strict()
]);

export interface DesktopApiOperationMap {
  readonly "runtime.status": {
    readonly request: z.infer<typeof EmptyRequestSchema>;
    readonly response: z.infer<typeof DesktopRuntimeStatusSchema>;
  };
  readonly "repository.pick": {
    readonly request: z.infer<typeof DesktopRepositoryPickerRequestSchema>;
    readonly response: z.infer<typeof DesktopRepositoryPickerResponseSchema>;
  };
  readonly "local.inspect": {
    readonly request: z.infer<typeof DesktopLocalInspectRequestSchema>;
    readonly response: z.infer<typeof DesktopRepositoryInspectionSchema>;
  };
  readonly "local.list": {
    readonly request: z.infer<typeof DesktopLocalListRequestSchema>;
    readonly response: z.infer<typeof ListEnvironmentsResponseSchema>;
  };
  readonly "local.prepare": {
    readonly request: z.infer<typeof DesktopLocalPrepareRequestSchema>;
    readonly response: { readonly environmentId: z.infer<typeof EnvironmentIdSchema> };
  };
  readonly "local.start": {
    readonly request: z.infer<typeof DesktopLocalStartRequestSchema>;
    readonly response: z.infer<typeof CommandAcceptedSchema>;
  };
  readonly "local.events": {
    readonly request: z.infer<typeof DesktopCommandStreamRequestSchema>;
    readonly response: z.infer<typeof RunnerStreamEventSchema>;
  };
  readonly "local.artifact.read": {
    readonly request: z.infer<typeof DesktopArtifactReadRequestSchema>;
    readonly response: z.infer<typeof ReadArtifactChunkResponseSchema>;
  };
  readonly "local.cancel": {
    readonly request: z.infer<typeof DesktopLocalCancelRequestSchema>;
    readonly response: z.infer<typeof CancelCommandResponseSchema>;
  };
  readonly "local.dispose": {
    readonly request: z.infer<typeof DesktopLocalDisposeRequestSchema>;
    readonly response: z.infer<typeof DisposeEnvironmentResponseSchema>;
  };
}

export interface DesktopCommandSubscription {
  readonly request: z.infer<typeof DesktopCommandStreamRequestSchema>;
  readonly event: z.infer<typeof RunnerStreamEventSchema>;
}

export type RepositoryCapability = z.infer<typeof RepositoryCapabilitySchema>;
export type DesktopCommandStreamRequest = z.infer<typeof DesktopCommandStreamRequestSchema>;
export type DesktopRuntimeStatus = z.infer<typeof DesktopRuntimeStatusSchema>;
export type DesktopArtifactReadRequest = z.infer<typeof DesktopArtifactReadRequestSchema>;
