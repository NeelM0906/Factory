import { z } from "zod";

import {
  ApprovalIdSchema,
  ArtifactIdSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  RunIdSchema
} from "./ids.js";
import { HostPrepareEnvironmentResponseSchema } from "./host-api.js";
import {
  ArtifactDescriptorSchema,
  CancelCommandResponseSchema,
  CommandAcceptedSchema,
  CommandSpecSchema,
  DisposeEnvironmentResponseSchema,
  InspectRepositoryRequestSchema,
  ListEnvironmentsResponseSchema,
  ReadArtifactChunkResponseSchema,
  RepositoryInspectionSchema,
  RunnerSubscriptionItemSchema
} from "./runner.js";

const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const LocalInspectRequestSchema = InspectRepositoryRequestSchema;
export const LocalInspectResponseSchema = RepositoryInspectionSchema;
export const LocalListEnvironmentsResponseSchema = ListEnvironmentsResponseSchema;

export const LocalPrepareRequestSchema = z
  .object({
    runId: RunIdSchema,
    approvalId: ApprovalIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    environmentId: EnvironmentIdSchema,
    sourcePath: z.string().min(1).max(8_192),
    baseRef: z.string().min(1).max(512),
    branchSlug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/)
  })
  .strict();
export const LocalPrepareResponseSchema = HostPrepareEnvironmentResponseSchema;

export const LocalStartRequestSchema = z
  .object({
    runId: RunIdSchema,
    approvalId: ApprovalIdSchema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    command: CommandSpecSchema
  })
  .strict();
export const LocalStartResponseSchema = CommandAcceptedSchema;

export const LocalEventsRequestSchema = z
  .object({
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    after: z.number().int().nonnegative().default(0)
  })
  .strict();
export const LocalEventFrameSchema = RunnerSubscriptionItemSchema;

export const LocalCancelRequestSchema = z
  .object({
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();
export const LocalCancelResponseSchema = CancelCommandResponseSchema;

export const LocalArtifactReadRequestSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(1_048_576)
  })
  .strict();
export const LocalArtifactReadResponseSchema = ReadArtifactChunkResponseSchema;
export const LocalArtifactDescriptorResponseSchema = ArtifactDescriptorSchema;

export const LocalDisposeRequestSchema = z
  .object({
    environmentId: EnvironmentIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict();
export const LocalDisposeResponseSchema = DisposeEnvironmentResponseSchema;

export type LocalInspectRequest = z.infer<typeof LocalInspectRequestSchema>;
export type LocalPrepareRequest = z.infer<typeof LocalPrepareRequestSchema>;
export type LocalStartRequest = z.infer<typeof LocalStartRequestSchema>;
export type LocalEventsRequest = z.infer<typeof LocalEventsRequestSchema>;
export type LocalCancelRequest = z.infer<typeof LocalCancelRequestSchema>;
export type LocalArtifactReadRequest = z.infer<typeof LocalArtifactReadRequestSchema>;
export type LocalDisposeRequest = z.infer<typeof LocalDisposeRequestSchema>;
