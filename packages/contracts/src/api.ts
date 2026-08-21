import { z } from "zod";

import { RunSchema, RunStageSchema, RunStatusSchema, WorkItemSchema } from "./entities.js";
import { StoredDomainEventSchema } from "./events.js";
import { RunIdSchema, WorkItemIdSchema } from "./ids.js";

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
    acceptanceContext: z.array(z.string().trim().min(1).max(2_000)).default([])
  })
  .strict();

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
    events: z.array(StoredDomainEventSchema),
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
          "missing_idempotency_key",
          "run_not_found",
          "version_conflict",
          "internal_error"
        ]),
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional()
      })
      .strict(),
    requestId: z.string().min(1).optional()
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type ListRunsResponse = z.infer<typeof ListRunsResponseSchema>;
export type ListEventsResponse = z.infer<typeof ListEventsResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
