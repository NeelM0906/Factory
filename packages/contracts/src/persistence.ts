import { z } from "zod";

import { RunStageSchema } from "./entities.js";
import { PendingDomainEventSchema, domainEventIdentity } from "./events.js";
import {
  AutomationIdSchema,
  JobIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import { assertSafeJson } from "./secret-safety.js";
import { WorkflowFailureSchema } from "./workflow-failure.js";
export { WorkflowFailureSchema, type WorkflowFailure } from "./workflow-failure.js";

const TimestampSchema = z.iso.datetime();
const JsonObjectSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  try {
    assertSafeJson(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid JSON."
    });
  }
});

export const StreamRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), id: WorkspaceIdSchema }).strict(),
  z.object({ kind: z.literal("project"), id: ProjectIdSchema }).strict(),
  z.object({ kind: z.literal("work_item"), id: WorkItemIdSchema }).strict(),
  z.object({ kind: z.literal("run"), id: RunIdSchema }).strict(),
  z.object({ kind: z.literal("automation"), id: AutomationIdSchema }).strict()
]);

export const StreamAppendSchema = z
  .object({
    stream: StreamRefSchema,
    expectedVersion: z.number().int().nonnegative(),
    events: z.array(PendingDomainEventSchema).min(1)
  })
  .strict()
  .superRefine((append, context) => {
    append.events.forEach((event, index) => {
      const identity = domainEventIdentity(event);
      if (append.stream.kind !== identity.kind || append.stream.id !== identity.id) {
        context.addIssue({
          code: "custom",
          path: ["events", index],
          message: "Event identity does not match its stream."
        });
      }
      if (event.workspaceId !== identity.workspaceId) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "workspaceId"],
          message: "Event workspace does not match its payload."
        });
      }
    });
  });

export const NewWorkflowJobSchema = z
  .object({
    jobId: JobIdSchema,
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    stage: RunStageSchema,
    handler: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i),
    payload: JsonObjectSchema,
    maxAttempts: z.number().int().positive().max(100),
    availableAt: TimestampSchema,
    createdAt: TimestampSchema
  })
  .strict();

const IdempotencySchema = z
  .object({ scope: z.string().trim().min(1).max(200), key: z.string().trim().min(1).max(200) })
  .strict();

export const CommitRequestSchema = z
  .object({
    idempotency: IdempotencySchema,
    appends: z.array(StreamAppendSchema),
    jobs: z.array(NewWorkflowJobSchema)
  })
  .strict();

export const CompleteJobRequestSchema = z
  .object({
    jobId: JobIdSchema,
    leaseToken: z.string().trim().min(1).max(500),
    now: TimestampSchema,
    idempotency: IdempotencySchema,
    appends: z.array(StreamAppendSchema),
    jobs: z.array(NewWorkflowJobSchema)
  })
  .strict();

export const FailJobRequestSchema = z
  .object({
    jobId: JobIdSchema,
    leaseToken: z.string().trim().min(1).max(500),
    now: TimestampSchema,
    error: WorkflowFailureSchema,
    nextAvailableAt: TimestampSchema.optional()
  })
  .strict();

export const WorkflowHandlerResultSchema = z
  .object({ appends: z.array(StreamAppendSchema), jobs: z.array(NewWorkflowJobSchema) })
  .strict();
