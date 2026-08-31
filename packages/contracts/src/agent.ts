import { z } from "zod";

import {
  AgentSessionIdSchema,
  ApprovalIdSchema,
  CredentialRefIdSchema,
  EnvironmentIdSchema,
  RunIdSchema,
  StageRunIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import { ModelCostSchema, ModelTokenUsageSchema } from "./model.js";
import { RelativeWorkspacePathSchema } from "./runner.js";
import { SafeMetadataStringSchema } from "./secret-safety.js";
import { WorkflowFailureCodeSchema } from "./workflow-failure.js";

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
    /**
     * The work item the session serves. Optional because an adapter may be invoked outside a work
     * item, but a station that writes a document carrying `workItemId` in its identity must fail
     * closed when it is absent — the only other source would be the model, and untrusted output
     * must never supply identity for a document it authors (spec §14.1).
     */
    workItemId: WorkItemIdSchema.optional(),
    stageRunId: StageRunIdSchema,
    agentSessionId: AgentSessionIdSchema,
    /**
     * The provisioned environment the session runs in. Optional because pre-provisioning stations
     * (e.g. triage, spec §8.2) invoke agents before any environment exists — `StageRunSchema`
     * already models that reality with an optional `environmentId`. Absence is legitimate ONLY
     * when no environment has been provisioned: a station operating inside a provisioned
     * environment must supply the id and fail closed when it cannot, and it must never be minted
     * to satisfy the field — an id that reaches no durable event is fabricated identity.
     */
    environmentId: EnvironmentIdSchema.optional(),
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
      // The workflow-failure alphabet: a code that does not survive normalization unchanged (a
      // JSON-RPC `-32601`, a dotted `provider.rate_limited`) must be mapped by the adapter first.
      code: WorkflowFailureCodeSchema,
      message: SafeMetadataStringSchema.max(2_000),
      retryable: z.boolean(),
      evidenceDigest: DigestSchema.optional()
    })
    .strict(),
  z.object({ ...AgentEventContextShape, type: z.literal("cancelled") }).strict()
]);

/**
 * Declarative harness profile (spec §9.1). Capabilities the adapter cannot honour stay visibly
 * unavailable, and installed/authenticated status is reported separately from capability.
 */
export const AgentHarnessProfileSchema = z
  .object({
    schemaVersion: VersionSchema,
    descriptor: AgentHarnessDescriptorSchema,
    selection: z
      .object({
        modelSelection: z.boolean(),
        reasoningSelection: z.boolean(),
        permissionModes: z.array(StableRefSchema).max(16)
      })
      .strict(),
    availability: z
      .object({
        installed: z.boolean(),
        authenticated: z.boolean(),
        detail: SafeMetadataStringSchema.max(2_000).optional(),
        checkedAt: TimestampSchema
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.availability.authenticated && !value.availability.installed) {
      context.addIssue({
        code: "custom",
        path: ["availability", "authenticated"],
        message: "A harness cannot be authenticated while it is not installed."
      });
    }
    const { permissionModes } = value.selection;
    if (!value.descriptor.capabilities.permissions && permissionModes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["selection", "permissionModes"],
        message: "A harness without permission support cannot declare permission modes."
      });
    }
    if (new Set(permissionModes).size !== permissionModes.length) {
      context.addIssue({
        code: "custom",
        path: ["selection", "permissionModes"],
        message: "Permission modes must be unique."
      });
    }
  });

export const AGENT_PERMISSION_OPTION_KINDS = [
  "allow_once",
  "allow_always",
  "deny_once",
  "deny_always"
] as const;
export const AgentPermissionOptionKindSchema = z.enum(AGENT_PERMISSION_OPTION_KINDS);

export const AgentPermissionOptionSchema = z
  .object({
    optionId: StableRefSchema,
    kind: AgentPermissionOptionKindSchema,
    label: SafeMetadataStringSchema.max(200)
  })
  .strict();

export const AgentPermissionRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    sessionId: AgentSessionIdSchema,
    permissionRef: StableRefSchema,
    summary: SafeMetadataStringSchema.max(2_000),
    evidenceDigest: DigestSchema,
    options: z.array(AgentPermissionOptionSchema).min(1).max(16),
    requestedAt: TimestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    const optionIds = value.options.map((option) => option.optionId);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Permission option identifiers must be unique."
      });
    }
    if (
      !value.options.some((option) => option.kind === "deny_once" || option.kind === "deny_always")
    ) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "A permission request must offer a denial option."
      });
    }
  });

export const AgentPermissionResponseSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    sessionId: AgentSessionIdSchema,
    permissionRef: StableRefSchema,
    approvalId: ApprovalIdSchema,
    selectedOptionId: StableRefSchema,
    evidenceDigest: DigestSchema,
    decidedAt: TimestampSchema
  })
  .strict();

const AgentSessionDetailEventOptions = [
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("message"),
      role: z.enum(["assistant", "user"]),
      text: SafeMetadataStringSchema.max(100_000)
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("thought_summary"),
      text: SafeMetadataStringSchema.max(20_000)
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("plan"),
      planDigest: DigestSchema,
      summary: SafeMetadataStringSchema.max(20_000)
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("tool_call"),
      toolCallRef: StableRefSchema,
      name: SafeMetadataStringSchema.max(200),
      phase: z.enum(["started", "completed", "failed"]),
      detail: SafeMetadataStringSchema.max(20_000).optional()
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("file_change"),
      path: RelativeWorkspacePathSchema,
      change: z.enum(["added", "modified", "deleted"]),
      diffDigest: DigestSchema.optional()
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("permission_resolved"),
      permissionRef: StableRefSchema,
      selectedOptionId: StableRefSchema
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("usage"),
      tokens: ModelTokenUsageSchema,
      cost: ModelCostSchema,
      model: StableRefSchema.optional()
    })
    .strict(),
  z
    .object({
      ...AgentEventContextShape,
      type: z.literal("interrupted"),
      reason: SafeMetadataStringSchema.max(2_000),
      retryable: z.boolean(),
      evidenceDigests: z.array(DigestSchema).min(1).max(100)
    })
    .strict()
] as const;

/** Normalized detail events (spec §9.1) that share the lifecycle stream's sequence space. */
export const AgentSessionDetailEventSchema = z.discriminatedUnion(
  "type",
  AgentSessionDetailEventOptions
);

/** The complete normalized agent stream: lifecycle plus detail events, ordered by `sequence`. */
export const AgentSessionStreamEventSchema = z.discriminatedUnion("type", [
  ...AgentSessionEventSchema.options,
  ...AgentSessionDetailEventOptions
]);

export type AgentHarnessProfile = z.infer<typeof AgentHarnessProfileSchema>;
export type AgentPermissionOptionKind = z.infer<typeof AgentPermissionOptionKindSchema>;
export type AgentPermissionOption = z.infer<typeof AgentPermissionOptionSchema>;
export type AgentPermissionRequest = z.infer<typeof AgentPermissionRequestSchema>;
export type AgentPermissionResponse = z.infer<typeof AgentPermissionResponseSchema>;
export type AgentSessionDetailEvent = z.infer<typeof AgentSessionDetailEventSchema>;
export type AgentSessionStreamEvent = z.infer<typeof AgentSessionStreamEventSchema>;

/** Admits a permission decision only when it answers the request it claims to answer. */
export const admitAgentPermissionResponse = (
  request: unknown,
  response: unknown
): {
  readonly request: AgentPermissionRequest;
  readonly response: AgentPermissionResponse;
} => {
  const permissionRequest = AgentPermissionRequestSchema.parse(request);
  const permissionResponse = AgentPermissionResponseSchema.parse(response);
  if (permissionResponse.sessionId !== permissionRequest.sessionId) {
    throw new TypeError("Permission response belongs to a different agent session.");
  }
  if (permissionResponse.permissionRef !== permissionRequest.permissionRef) {
    throw new TypeError("Permission response does not answer this permission request.");
  }
  if (permissionResponse.evidenceDigest !== permissionRequest.evidenceDigest) {
    throw new TypeError("Permission response decides stale permission evidence.");
  }
  if (
    !permissionRequest.options.some(
      (option) => option.optionId === permissionResponse.selectedOptionId
    )
  ) {
    throw new TypeError("Permission response selects an option the request did not offer.");
  }
  return { request: permissionRequest, response: permissionResponse };
};

export type AgentHarnessDescriptor = z.infer<typeof AgentHarnessDescriptorSchema>;
export type AgentInvocationRequest = z.infer<typeof AgentInvocationRequestSchema>;
export type AgentResumeRequest = z.infer<typeof AgentResumeRequestSchema>;
export type AgentSteerRequest = z.infer<typeof AgentSteerRequestSchema>;
export type AgentCancelRequest = z.infer<typeof AgentCancelRequestSchema>;
export type AgentSessionEvent = z.infer<typeof AgentSessionEventSchema>;

/**
 * Vendor-neutral lifecycle boundary. Model routing is intentionally a separate port.
 *
 * The stream carries `AgentSessionStreamEvent` — lifecycle plus normalized detail events in one
 * sequence space — because that is what `AgentSessionStreamEventSchema` describes adapters as
 * emitting. Narrowing it to `AgentSessionEvent` would have made the detail events unreachable
 * through the only boundary an adapter has.
 */
export interface AgentHarnessPort {
  readonly descriptor: AgentHarnessDescriptor;
  start(request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent>;
  resume(request: AgentResumeRequest): AsyncIterable<AgentSessionStreamEvent>;
  steer(request: AgentSteerRequest): Promise<void>;
  cancel(request: AgentCancelRequest): Promise<void>;
}

/**
 * Implemented in addition to `AgentHarnessPort` by adapters whose descriptor declares
 * `capabilities.permissions`. Adapters without that capability must not implement it.
 */
export interface AgentPermissionResponderPort {
  respondToPermission(response: AgentPermissionResponse): Promise<void>;
}
