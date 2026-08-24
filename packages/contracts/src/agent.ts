import { z } from "zod";

import {
  AgentSessionIdSchema,
  CredentialRefIdSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  StageRunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import { SafeMetadataStringSchema } from "./secret-safety.js";

const VersionSchema = z.literal(1);
const TimestampSchema = z.iso.datetime();
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const StableRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/-]+$/);
const IdempotencyKeySchema = z.string().trim().min(1).max(240);

export const AGENT_HARNESS_KINDS = ["codex", "claude", "acp", "native"] as const;
export const AgentHarnessKindSchema = z.enum(AGENT_HARNESS_KINDS);

export const AgentHarnessCapabilitiesSchema = z
  .object({
    resume: z.boolean(),
    steering: z.boolean(),
    permissions: z.boolean(),
    structuredPlans: z.boolean()
  })
  .strict();

export const AgentHarnessDescriptorSchema = z
  .object({
    schemaVersion: VersionSchema,
    adapterId: StableRefSchema,
    kind: AgentHarnessKindSchema,
    displayName: SafeMetadataStringSchema.max(120),
    capabilities: AgentHarnessCapabilitiesSchema
  })
  .strict();

const NonSecretEnvironmentEntrySchema = z
  .object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    value: SafeMetadataStringSchema.max(4_096)
  })
  .strict();

export const AgentInvocationRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    stageRunId: StageRunIdSchema,
    agentSessionId: AgentSessionIdSchema,
    environmentId: EnvironmentIdSchema,
    adapterId: StableRefSchema,
    objective: SafeMetadataStringSchema.max(100_000),
    cwd: z.string().min(1).max(4_096),
    inputEvidenceDigests: z.array(DigestSchema).max(100),
    credentialRefIds: z.array(CredentialRefIdSchema).max(32).default([]),
    environment: z.array(NonSecretEnvironmentEntrySchema).max(100).default([])
  })
  .strict();

export const AgentResumeRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    sessionId: AgentSessionIdSchema,
    providerSessionRef: StableRefSchema,
    objective: SafeMetadataStringSchema.max(100_000),
    inputEvidenceDigests: z.array(DigestSchema).max(100)
  })
  .strict();

export const AgentSteerRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    sessionId: AgentSessionIdSchema,
    instruction: SafeMetadataStringSchema.max(20_000),
    evidenceDigest: DigestSchema
  })
  .strict();

export const AgentCancelRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    sessionId: AgentSessionIdSchema,
    reason: SafeMetadataStringSchema.max(2_000)
  })
  .strict();

const AgentEventContextShape = {
  schemaVersion: VersionSchema,
  sessionId: AgentSessionIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: TimestampSchema
} as const;

export const AgentSessionEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("started"),
      providerSessionRef: StableRefSchema.optional()
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("output"),
      stream: z.enum(["stdout", "stderr", "structured"]),
      text: SafeMetadataStringSchema.max(100_000)
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("permission_requested"),
      permissionRef: StableRefSchema,
      summary: SafeMetadataStringSchema.max(2_000),
      evidenceDigest: DigestSchema
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("waiting"),
      reason: SafeMetadataStringSchema.max(2_000)
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("completed"),
      evidenceDigests: z.array(DigestSchema).min(1).max(100)
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("failed"),
      code: StableRefSchema,
      message: SafeMetadataStringSchema.max(2_000),
      retryable: z.boolean(),
      evidenceDigest: DigestSchema.optional()
    })
    .strict(),
  z.object({ ...AgentEventContextShape, type: z.literal("cancelled") }).strict()
]);

export type AgentHarnessDescriptor = z.infer<typeof AgentHarnessDescriptorSchema>;
export type AgentInvocationRequest = z.infer<typeof AgentInvocationRequestSchema>;
export type AgentResumeRequest = z.infer<typeof AgentResumeRequestSchema>;
export type AgentSteerRequest = z.infer<typeof AgentSteerRequestSchema>;
export type AgentCancelRequest = z.infer<typeof AgentCancelRequestSchema>;
export type AgentSessionEvent = z.infer<typeof AgentSessionEventSchema>;

/** Vendor-neutral lifecycle boundary. Model routing is intentionally a separate port. */
export interface AgentHarnessPort {
  readonly descriptor: AgentHarnessDescriptor;
  start(request: AgentInvocationRequest): AsyncIterable<AgentSessionEvent>;
  resume(request: AgentResumeRequest): AsyncIterable<AgentSessionEvent>;
  steer(request: AgentSteerRequest): Promise<void>;
  cancel(request: AgentCancelRequest): Promise<void>;
}
