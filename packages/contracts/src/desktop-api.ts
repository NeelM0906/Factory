import { z } from "zod";

import {
  ApprovalIdSchema,
  ArtifactIdSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  InspectedSourceCapabilityIdSchema,
  RepositoryCapabilityIdSchema,
  RunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import {
  CancelCommandResponseSchema,
  CommandAcceptedSchema,
  CommandSpecSchema,
  DisposeEnvironmentResponseSchema,
  ListEnvironmentsResponseSchema,
  PreparedEnvironmentSchema,
  ReadArtifactChunkResponseSchema,
  RunnerStreamEventSchema,
  TerminalRunEvidenceSchema
} from "./runner.js";
import { containsSensitiveMaterial, SafeMetadataStringSchema } from "./secret-safety.js";

const EmptyRequestSchema = z.object({}).strict();
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const RepositoryDisplayLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^/\\\u0000-\u001f]+$/)
  .refine(
    (value) => value !== "." && value !== ".." && !containsSensitiveMaterial(value),
    "A secret-free basename display label is required."
  );
const RepositoryCapabilitySchema = z
  .object({
    id: RepositoryCapabilityIdSchema,
    label: RepositoryDisplayLabelSchema,
    expiresAt: z.iso.datetime()
  })
  .strict();
export const DesktopRepositoryPickerRequestSchema = EmptyRequestSchema.extend({
  operation: z.literal("repository.pick")
});
export const DesktopRepositoryPickerResponseSchema = z
  .object({ repository: RepositoryCapabilitySchema.nullable() })
  .strict();
export const DesktopRuntimeStatusSchema = z
  .object({
    status: z.enum(["starting", "ready", "degraded", "stopped"]),
    message: SafeMetadataStringSchema.max(512).optional()
  })
  .strict();
export const DesktopRuntimeStatusRequestSchema = EmptyRequestSchema.extend({
  operation: z.literal("runtime.status")
});
export const DesktopLocalInspectRequestSchema = z
  .object({
    operation: z.literal("local.inspect"),
    repositoryCapabilityId: RepositoryCapabilityIdSchema,
    baseRef: SafeMetadataStringSchema.max(512)
  })
  .strict();
export const DesktopRepositoryInspectionSchema = z
  .object({
    inspectedSourceCapabilityId: InspectedSourceCapabilityIdSchema
  })
  .strict();
export const DesktopLocalListRequestSchema = EmptyRequestSchema.extend({
  operation: z.literal("local.list")
});
export const DesktopLocalPrepareRequestSchema = z
  .object({
    operation: z.literal("local.prepare"),
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    approvalId: ApprovalIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    inspectedSourceCapabilityId: InspectedSourceCapabilityIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopLocalStartRequestSchema = z
  .object({
    operation: z.literal("local.start"),
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    commandAuthorizationDigest: Sha256Schema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    command: CommandSpecSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopCommandStreamRequestSchema = z
  .object({
    operation: z.literal("local.events"),
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    commandAuthorizationDigest: Sha256Schema,
    after: z.number().int().nonnegative().default(0)
  })
  .strict();
export const DesktopArtifactReadRequestSchema = z
  .object({
    operation: z.literal("local.artifact.read"),
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    artifactId: ArtifactIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    commandAuthorizationDigest: Sha256Schema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(1_048_576)
  })
  .strict();
export const DesktopLocalCancelRequestSchema = z
  .object({
    operation: z.literal("local.cancel"),
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    commandAuthorizationDigest: Sha256Schema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopLocalDisposeRequestSchema = z
  .object({
    operation: z.literal("local.dispose"),
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentAuthorizationDigest: Sha256Schema,
    terminalRunEvidence: TerminalRunEvidenceSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();

export const DesktopApiRequestSchemaByOperation = {
  "runtime.status": DesktopRuntimeStatusRequestSchema,
  "repository.pick": DesktopRepositoryPickerRequestSchema,
  "local.inspect": DesktopLocalInspectRequestSchema,
  "local.list": DesktopLocalListRequestSchema,
  "local.prepare": DesktopLocalPrepareRequestSchema,
  "local.start": DesktopLocalStartRequestSchema,
  "local.events": DesktopCommandStreamRequestSchema,
  "local.artifact.read": DesktopArtifactReadRequestSchema,
  "local.cancel": DesktopLocalCancelRequestSchema,
  "local.dispose": DesktopLocalDisposeRequestSchema
} as const;

export const DesktopApiOperationMapSchema = z.discriminatedUnion("operation", [
  DesktopRuntimeStatusRequestSchema,
  DesktopRepositoryPickerRequestSchema,
  DesktopLocalInspectRequestSchema,
  DesktopLocalListRequestSchema,
  DesktopLocalPrepareRequestSchema,
  DesktopLocalStartRequestSchema,
  DesktopCommandStreamRequestSchema,
  DesktopArtifactReadRequestSchema,
  DesktopLocalCancelRequestSchema,
  DesktopLocalDisposeRequestSchema
]);

export const DesktopApiResponseSchemaByOperation = {
  "runtime.status": DesktopRuntimeStatusSchema,
  "repository.pick": DesktopRepositoryPickerResponseSchema,
  "local.inspect": DesktopRepositoryInspectionSchema,
  "local.list": ListEnvironmentsResponseSchema,
  "local.prepare": z
    .object({ environment: PreparedEnvironmentSchema, replayed: z.boolean() })
    .strict(),
  "local.start": CommandAcceptedSchema,
  "local.events": RunnerStreamEventSchema,
  "local.artifact.read": ReadArtifactChunkResponseSchema,
  "local.cancel": CancelCommandResponseSchema,
  "local.dispose": DisposeEnvironmentResponseSchema
} as const;

export type DesktopApiOperationMap = {
  readonly [Operation in keyof typeof DesktopApiRequestSchemaByOperation]: {
    readonly request: z.infer<(typeof DesktopApiRequestSchemaByOperation)[Operation]>;
    readonly response: z.infer<(typeof DesktopApiResponseSchemaByOperation)[Operation]>;
  };
};

export interface DesktopCommandSubscription {
  readonly request: z.infer<typeof DesktopCommandStreamRequestSchema>;
  readonly event: z.infer<typeof RunnerStreamEventSchema>;
}

export type RepositoryCapability = z.infer<typeof RepositoryCapabilitySchema>;
export type DesktopCommandStreamRequest = z.infer<typeof DesktopCommandStreamRequestSchema>;
export type DesktopRuntimeStatus = z.infer<typeof DesktopRuntimeStatusSchema>;
export type DesktopArtifactReadRequest = z.infer<typeof DesktopArtifactReadRequestSchema>;
