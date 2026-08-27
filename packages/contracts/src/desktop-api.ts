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
  ApprovalDecisionRequestSchema,
  ApprovalDecisionResponseSchema,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  HealthResponseSchema,
  ListApprovalsQuerySchema,
  ListApprovalsResponseSchema,
  ListRunsResponseSchema,
  ListEventsResponseSchema,
  SteerRunRequestSchema,
  SteerRunResponseSchema
} from "./api.js";
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
export const DesktopFactoryHealthRequestSchema = EmptyRequestSchema.extend({
  operation: z.literal("factory.health")
});
export const DesktopFactoryRunListRequestSchema = z
  .object({
    operation: z.literal("factory.runs.list"),
    cursor: z.number().int().positive().optional()
  })
  .strict();
export const DesktopFactoryRunEventsRequestSchema = z
  .object({
    operation: z.literal("factory.runs.events"),
    runId: RunIdSchema,
    after: z.number().int().nonnegative().default(0)
  })
  .strict();
export const DesktopFactoryCreateRunRequestSchema = z
  .object({
    operation: z.literal("factory.runs.create"),
    request: CreateRunRequestSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopLocalInspectRequestSchema = z
  .object({
    operation: z.literal("local.inspect"),
    repositoryCapabilityId: RepositoryCapabilityIdSchema,
    baseRef: SafeMetadataStringSchema.max(512),
    branchSlug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/)
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
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    inspectedSourceCapabilityId: InspectedSourceCapabilityIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopLocalStartRequestSchema = z
  .object({
    operation: z.literal("local.start"),
    runId: RunIdSchema,
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    command: CommandSpecSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopCommandStreamRequestSchema = z
  .object({
    operation: z.literal("local.events"),
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    after: z.number().int().nonnegative().default(0)
  })
  .strict();
export const DesktopArtifactReadRequestSchema = z
  .object({
    operation: z.literal("local.artifact.read"),
    artifactId: ArtifactIdSchema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(1_048_576)
  })
  .strict();
export const DesktopLocalCancelRequestSchema = z
  .object({
    operation: z.literal("local.cancel"),
    environmentId: EnvironmentIdSchema,
    commandId: CommandIdSchema,
    commandAuthorizationId: CommandAuthorizationIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
export const DesktopLocalDisposeRequestSchema = z
  .object({
    operation: z.literal("local.dispose"),
    environmentId: EnvironmentIdSchema,
    environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();

/**
 * The approval and run-control operations, each derived from the HTTP schema it mirrors rather than
 * re-declared, so the two surfaces cannot drift. Two deliberate differences from HTTP:
 *
 * - No idempotency key. Over HTTP a client supplies one; over IPC the main process derives it, so
 *   a renderer cannot replay another window's decision by guessing the key.
 * - `origin` is narrowed to the literal `"desktop"`. The renderer is the desktop, and a contract
 *   that let it claim to be Slack would be recording a lie.
 */
export const DesktopFactoryApprovalListRequestSchema = ListApprovalsQuerySchema.extend({
  operation: z.literal("factory.approvals.list")
});
export const DesktopFactoryApprovalDecideRequestSchema = ApprovalDecisionRequestSchema.extend({
  operation: z.literal("factory.approvals.decide"),
  approvalId: ApprovalIdSchema,
  origin: z.literal("desktop")
});
export const DesktopFactoryRunSteerRequestSchema = SteerRunRequestSchema.extend({
  operation: z.literal("factory.runs.steer"),
  runId: RunIdSchema
});
export const DesktopFactoryRunCancelRequestSchema = CancelRunRequestSchema.extend({
  operation: z.literal("factory.runs.cancel"),
  runId: RunIdSchema
});

export const DesktopApiRequestSchemaByOperation = {
  "factory.health": DesktopFactoryHealthRequestSchema,
  "factory.runs.list": DesktopFactoryRunListRequestSchema,
  "factory.runs.events": DesktopFactoryRunEventsRequestSchema,
  "factory.runs.create": DesktopFactoryCreateRunRequestSchema,
  "factory.approvals.list": DesktopFactoryApprovalListRequestSchema,
  "factory.approvals.decide": DesktopFactoryApprovalDecideRequestSchema,
  "factory.runs.steer": DesktopFactoryRunSteerRequestSchema,
  "factory.runs.cancel": DesktopFactoryRunCancelRequestSchema,
  "local.inspect": DesktopLocalInspectRequestSchema,
  "local.list": DesktopLocalListRequestSchema,
  "local.prepare": DesktopLocalPrepareRequestSchema,
  "local.start": DesktopLocalStartRequestSchema,
  "local.artifact.read": DesktopArtifactReadRequestSchema,
  "local.cancel": DesktopLocalCancelRequestSchema,
  "local.dispose": DesktopLocalDisposeRequestSchema
} as const;

export const DesktopApiOperationMapSchema = z.discriminatedUnion("operation", [
  DesktopFactoryHealthRequestSchema,
  DesktopFactoryRunListRequestSchema,
  DesktopFactoryRunEventsRequestSchema,
  DesktopFactoryCreateRunRequestSchema,
  DesktopFactoryApprovalListRequestSchema,
  DesktopFactoryApprovalDecideRequestSchema,
  DesktopFactoryRunSteerRequestSchema,
  DesktopFactoryRunCancelRequestSchema,
  DesktopLocalInspectRequestSchema,
  DesktopLocalListRequestSchema,
  DesktopLocalPrepareRequestSchema,
  DesktopLocalStartRequestSchema,
  DesktopArtifactReadRequestSchema,
  DesktopLocalCancelRequestSchema,
  DesktopLocalDisposeRequestSchema
]);

export const DesktopApiResponseSchemaByOperation = {
  "factory.health": HealthResponseSchema,
  "factory.runs.list": ListRunsResponseSchema,
  "factory.runs.events": ListEventsResponseSchema,
  "factory.runs.create": CreateRunResponseSchema,
  "factory.approvals.list": ListApprovalsResponseSchema,
  "factory.approvals.decide": ApprovalDecisionResponseSchema,
  "factory.runs.steer": SteerRunResponseSchema,
  "factory.runs.cancel": CancelRunResponseSchema,
  "local.inspect": DesktopRepositoryInspectionSchema,
  "local.list": ListEnvironmentsResponseSchema,
  "local.prepare": z
    .object({ environment: PreparedEnvironmentSchema, replayed: z.boolean() })
    .strict(),
  "local.start": CommandAcceptedSchema,
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
