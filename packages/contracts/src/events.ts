import { z } from "zod";

import {
  ActorSchema,
  ApprovalSchema,
  RunSchema,
  RunStageSchema,
  RunStatusSchema,
  WorkItemSchema
} from "./entities.js";
import {
  ApprovalIdSchema,
  EventIdSchema,
  JobIdSchema,
  RunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";

export const EVENT_TYPES = [
  "work_item.created",
  "run.created",
  "run.transitioned",
  "stage.queued",
  "stage.leased",
  "stage.succeeded",
  "stage.failed",
  "approval.requested",
  "approval.decided"
] as const;

const EventContextSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  actor: ActorSchema,
  correlationId: z.uuid(),
  causationId: EventIdSchema.optional(),
  occurredAt: z.iso.datetime()
});

const StageIdentityShape = {
  runId: RunIdSchema,
  stage: RunStageSchema,
  jobId: JobIdSchema
} as const;

const DomainEventBodySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("work_item.created"),
      payload: z.object({ workItem: WorkItemSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("run.created"),
      payload: z.object({ run: RunSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("run.transitioned"),
      payload: z
        .object({
          runId: RunIdSchema,
          from: RunStatusSchema,
          to: RunStatusSchema,
          reason: z.string().trim().min(1).max(2_000),
          resumeStatus: RunStatusSchema.optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.queued"),
      payload: z.object(StageIdentityShape).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.leased"),
      payload: z
        .object({
          ...StageIdentityShape,
          workerId: z.string().min(1),
          attempt: z.number().int().positive()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.succeeded"),
      payload: z.object(StageIdentityShape).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("stage.failed"),
      payload: z
        .object({
          ...StageIdentityShape,
          error: z
            .object({
              name: z.string().min(1),
              message: z.string().min(1).max(2_000),
              retryable: z.boolean()
            })
            .strict()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.requested"),
      payload: z.object({ approval: ApprovalSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.decided"),
      payload: z
        .object({
          approvalId: ApprovalIdSchema,
          runId: RunIdSchema,
          decision: z.enum(["approved", "rejected"]),
          evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/i),
          origin: z.enum(["desktop", "web", "cli", "slack", "github", "api"]),
          decidedAt: z.iso.datetime()
        })
        .strict()
    })
    .strict()
]);

const StoredEventMetadataSchema = z.object({
  eventId: EventIdSchema,
  stream: z
    .object({
      kind: z.enum(["workspace", "project", "work_item", "run", "automation"]),
      id: z.string().min(1)
    })
    .strict(),
  streamVersion: z.number().int().positive(),
  globalSequence: z.number().int().positive(),
  schemaVersion: z.literal(1)
});

export const PendingDomainEventSchema = EventContextSchema.and(DomainEventBodySchema);
export const StoredDomainEventSchema = PendingDomainEventSchema.and(StoredEventMetadataSchema);

export type PendingDomainEvent = z.infer<typeof PendingDomainEventSchema>;
export type StoredDomainEvent = z.infer<typeof StoredDomainEventSchema>;
export type DomainEventType = (typeof EVENT_TYPES)[number];
