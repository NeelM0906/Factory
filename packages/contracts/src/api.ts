import { z } from "zod";

import {
  ApprovalSchema,
  OriginSchema,
  RunSchema,
  RunStageSchema,
  RunStatusSchema,
  WorkItemSchema
} from "./entities.js";
import { StoredDomainEventSchema } from "./events.js";
import { ApprovalIdSchema, RunIdSchema, WorkItemIdSchema } from "./ids.js";
import { SafeMetadataStringSchema } from "./secret-safety.js";

// Same per-module private convention as station-evidence.ts / agent.ts / integration.ts.
const StableRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9._:/-]+$/);

export const HealthResponseSchema = z
  .object({
    service: z.literal("autostack-control-plane"),
    version: z.string().min(1),
    status: z.enum(["ok", "degraded"]),
    storage: z
      .object({
        status: z.enum(["ok", "degraded"]),
        journalMode: z.literal("wal"),
        schemaVersion: z.number().int().positive()
      })
      .strict(),
    executor: z.object({ status: z.enum(["stopped", "idle", "working"]) }).strict()
  })
  .strict();

export const CreateRunRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    description: z.string().max(100_000).default(""),
    acceptanceContext: z.array(z.string().trim().min(1).max(2_000)).max(50).default([])
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = value.acceptanceContext.reduce(
      (total, item) => total + new TextEncoder().encode(item).byteLength,
      0
    );
    if (bytes > 20_000) {
      context.addIssue({
        code: "custom",
        path: ["acceptanceContext"],
        message: "Acceptance context exceeds the aggregate size limit."
      });
    }
  });

export const CreateRunResponseSchema = z
  .object({
    workItem: WorkItemSchema,
    run: RunSchema,
    replayed: z.boolean()
  })
  .strict();

export const RunSummarySchema = z
  .object({
    runId: RunIdSchema,
    workItemId: WorkItemIdSchema,
    title: z.string().min(1),
    source: z.enum(["manual", "github", "slack", "api"]),
    status: RunStatusSchema,
    currentStage: RunStageSchema.optional(),
    lastGlobalSequence: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .strict();

export const ListRunsResponseSchema = z
  .object({
    items: z.array(RunSummarySchema),
    nextCursor: z.number().int().positive().optional()
  })
  .strict();

export const ListEventsResponseSchema = z
  .object({
    events: z.array(StoredDomainEventSchema).max(100),
    nextSequence: z.number().int().nonnegative().default(0)
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "unauthorized",
          "invalid_request",
          "request_too_large",
          "missing_idempotency_key",
          "run_not_found",
          "idempotency_conflict",
          "version_conflict",
          "scope_mismatch",
          "authorization_invalid",
          "authorization_expired",
          "unsupported_policy",
          "local_runner_unavailable",
          "internal_error"
        ]),
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional()
      })
      .strict(),
    requestId: z.string().min(1).optional()
  })
  .strict();

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

export const ApprovalSummarySchema = z
  .object({
    approvalId: ApprovalIdSchema,
    runId: RunIdSchema,
    workItemId: WorkItemIdSchema,
    title: z.string().min(1).max(240),
    kind: ApprovalSchema.shape.kind,
    status: ApprovalSchema.shape.status,
    evidenceDigest: Sha256Schema,
    requestedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .strict();

/** Query for the approval inbox. Values arrive as strings from the query string. */
export const ListApprovalsQuerySchema = z
  .object({
    /**
     * Derived from the approval entity's own status vocabulary plus the one wildcard the query
     * layer needs: `"all"` means NO status filter, and the route must treat it as unfiltered.
     * Without it a client's "All" view silently degrades to the `"pending"` default — a filter
     * UI that lies. The default stays `"pending"` (the inbox's working set).
     */
    status: z.union([ApprovalSchema.shape.status, z.literal("all")]).default("pending"),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.coerce.number().int().positive().optional()
  })
  .strict();

export const ListApprovalsResponseSchema = z
  .object({
    items: z.array(ApprovalSummarySchema).max(100),
    nextCursor: z.number().int().positive().optional()
  })
  .strict();

export const ApprovalDecisionRequestSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    evidenceDigest: Sha256Schema,
    origin: OriginSchema,
    note: SafeMetadataStringSchema.trim().min(1).max(2_000).optional()
  })
  .strict();

export const ApprovalDecisionResponseSchema = z
  .object({
    approvalId: ApprovalIdSchema,
    runId: RunIdSchema,
    // Derived so the decided statuses cannot drift from the approval entity's own vocabulary; a
    // decision response is every approval status except the one it leaves behind.
    status: ApprovalSchema.shape.status.exclude(["pending"]),
    decidedAt: z.iso.datetime(),
    replayed: z.boolean()
  })
  .strict();

export const SteerRunRequestSchema = z
  .object({ instruction: SafeMetadataStringSchema.trim().min(1).max(20_000) })
  .strict();

export const SteerRunResponseSchema = z
  .object({ runId: RunIdSchema, accepted: z.boolean(), acceptedAt: z.iso.datetime() })
  .strict();

export const CancelRunRequestSchema = z
  .object({ reason: SafeMetadataStringSchema.trim().min(1).max(2_000) })
  .strict();

export const CancelRunResponseSchema = z
  .object({ runId: RunIdSchema, status: RunStatusSchema, requestedAt: z.iso.datetime() })
  .strict();

/**
 * Answers a pending clarification (`POST /v1/runs/:runId/clarifications/:clarificationRef/answer`).
 * The request carries only what the caller legitimately supplies: the run and clarification are
 * named by the path, `actorId` comes from the authenticated context, and idempotency is
 * server-derived from the clarification ref and answer content — mirroring the approval-decision
 * pattern, so a client cannot mint two distinct acts out of one answer. The durable record is
 * `ClarificationResponseSchema` (station-evidence); this is only its wire-side request.
 */
export const AnswerClarificationRequestSchema = z
  .object({
    answer: SafeMetadataStringSchema.trim().min(1).max(20_000),
    origin: OriginSchema
  })
  .strict();

export const AnswerClarificationResponseSchema = z
  .object({
    runId: RunIdSchema,
    clarificationRef: StableRefSchema,
    answeredAt: z.iso.datetime(),
    replayed: z.boolean()
  })
  .strict();

export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;
export type ListApprovalsQuery = z.infer<typeof ListApprovalsQuerySchema>;
export type ListApprovalsResponse = z.infer<typeof ListApprovalsResponseSchema>;
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;
export type SteerRunRequest = z.infer<typeof SteerRunRequestSchema>;
export type SteerRunResponse = z.infer<typeof SteerRunResponseSchema>;
export type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;
export type AnswerClarificationRequest = z.infer<typeof AnswerClarificationRequestSchema>;
export type AnswerClarificationResponse = z.infer<typeof AnswerClarificationResponseSchema>;

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type CreateRunRequestInput = z.input<typeof CreateRunRequestSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type ListRunsResponse = z.infer<typeof ListRunsResponseSchema>;
export type ListEventsResponse = z.infer<typeof ListEventsResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
