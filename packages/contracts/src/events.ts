import { z } from "zod";

import {
  ActorSchema,
  ApprovalSchema,
  ArtifactSchema,
  RunSchema,
  RunStageSchema,
  RunStatusSchema,
  WorkItemSchema
} from "./entities.js";
import {
  ApprovalIdSchema,
  CommandAuthorizationIdSchema,
  CommandIdSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentIdSchema,
  EventIdSchema,
  JobIdSchema,
  RunIdSchema,
  WorkspaceIdSchema
} from "./ids.js";
import {
  ArtifactDescriptorSchema,
  CommandAuthorizationSchema,
  EnvironmentAuthorizationSchema,
  PrepareEnvironmentRequestSchema,
  PreparedEnvironmentSchema,
  StartCommandRequestSchema
} from "./runner.js";
import { WorkflowFailureSchema } from "./workflow-failure.js";

export const EVENT_TYPES = [
  "work_item.created",
  "run.created",
  "run.transitioned",
  "stage.queued",
  "stage.leased",
  "stage.succeeded",
  "stage.failed",
  "approval.requested",
  "approval.decided",
  "environment.authorization_recorded",
  "command.authorization_recorded",
  "environment.prepare_requested",
  "environment.prepared",
  "command.intent_recorded",
  "command.started",
  "command.completed",
  "artifact.recorded",
  "environment.disposed"
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
          error: WorkflowFailureSchema
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
    .strict(),
  z
    .object({
      type: z.literal("environment.authorization_recorded"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          authorization: EnvironmentAuthorizationSchema
        })
        .strict()
    })
    .strict()
    .superRefine((value, context) => {
      const scope = value.payload.authorization.scope;
      if (
        scope.runId !== value.payload.runId ||
        scope.environmentId !== value.payload.environmentId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload"],
          message: "Environment authorization identity is invalid."
        });
      }
    }),
  z
    .object({
      type: z.literal("command.authorization_recorded"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          commandId: CommandIdSchema,
          authorization: CommandAuthorizationSchema
        })
        .strict()
    })
    .strict()
    .superRefine((value, context) => {
      const scope = value.payload.authorization.scope;
      if (
        scope.runId !== value.payload.runId ||
        scope.environmentId !== value.payload.environmentId ||
        scope.commandId !== value.payload.commandId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload"],
          message: "Command authorization identity is invalid."
        });
      }
    }),
  z
    .object({
      type: z.literal("environment.prepare_requested"),
      payload: z.object({ request: PrepareEnvironmentRequestSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("environment.prepared"),
      payload: z.object({ environment: PreparedEnvironmentSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("command.intent_recorded"),
      payload: z.object({ request: StartCommandRequestSchema }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("command.started"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          commandId: CommandIdSchema,
          startedAt: z.iso.datetime()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("command.completed"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          commandId: CommandIdSchema,
          terminalSequence: z.number().int().positive(),
          terminalDigest: z.string().regex(/^[0-9a-f]{64}$/i),
          status: z.enum(["completed", "cancelled", "failed"]),
          completedAt: z.iso.datetime()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact.recorded"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          commandId: CommandIdSchema,
          artifact: ArtifactDescriptorSchema
        })
        .strict()
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.payload.artifact.runId !== value.payload.runId ||
        value.payload.artifact.commandId !== value.payload.commandId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "artifact"],
          message: "Artifact identity is invalid."
        });
      }
    }),
  z
    .object({
      type: z.literal("environment.disposed"),
      payload: z
        .object({
          runId: RunIdSchema,
          environmentId: EnvironmentIdSchema,
          environmentAuthorizationId: EnvironmentAuthorizationIdSchema,
          terminalEventSequence: z.number().int().positive(),
          terminalEventDigest: z.string().regex(/^[0-9a-f]{64}$/i),
          disposedAt: z.iso.datetime()
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

export const PendingDomainEventSchema = EventContextSchema.and(DomainEventBodySchema).superRefine(
  (event, context) => {
    const mismatchedWorkspace = (workspaceId: string) => {
      if (event.workspaceId !== workspaceId) {
        context.addIssue({
          code: "custom",
          path: ["workspaceId"],
          message: "Event workspace does not match local execution evidence."
        });
      }
    };
    switch (event.type) {
      case "environment.authorization_recorded":
        mismatchedWorkspace(event.payload.authorization.scope.workspaceId);
        break;
      case "command.authorization_recorded":
        mismatchedWorkspace(event.payload.authorization.scope.workspaceId);
        break;
      case "environment.prepare_requested":
        mismatchedWorkspace(event.payload.request.workspaceId);
        break;
      case "environment.prepared":
        mismatchedWorkspace(event.payload.environment.workspaceId);
        break;
      case "command.intent_recorded":
        mismatchedWorkspace(event.payload.request.workspaceId);
        break;
      case "artifact.recorded":
        mismatchedWorkspace(event.payload.artifact.workspaceId);
        break;
      default:
        break;
    }
  }
);
export type PendingDomainEvent = z.infer<typeof PendingDomainEventSchema>;

export const domainEventIdentity = (event: PendingDomainEvent) => {
  switch (event.type) {
    case "work_item.created":
      return {
        kind: "work_item" as const,
        id: event.payload.workItem.id,
        workspaceId: event.payload.workItem.workspaceId
      };
    case "run.created":
      return {
        kind: "run" as const,
        id: event.payload.run.id,
        workspaceId: event.payload.run.workspaceId
      };
    case "approval.requested":
      return {
        kind: "run" as const,
        id: event.payload.approval.runId,
        workspaceId: event.payload.approval.workspaceId
      };
    case "environment.prepared":
      return {
        kind: "run" as const,
        id: event.payload.environment.runId,
        workspaceId: event.payload.environment.workspaceId
      };
    case "environment.prepare_requested":
      return {
        kind: "run" as const,
        id: event.payload.request.runId,
        workspaceId: event.payload.request.workspaceId
      };
    case "command.intent_recorded":
      return {
        kind: "run" as const,
        id: event.payload.request.runId,
        workspaceId: event.payload.request.workspaceId
      };
    default:
      return { kind: "run" as const, id: event.payload.runId, workspaceId: event.workspaceId };
  }
};

export const StoredDomainEventSchema = PendingDomainEventSchema.and(
  StoredEventMetadataSchema
).superRefine((event, context) => {
  const identity = domainEventIdentity(event);
  if (event.stream.kind !== identity.kind || event.stream.id !== identity.id) {
    context.addIssue({
      code: "custom",
      path: ["stream"],
      message: "Event stream identity is invalid."
    });
  }
  if (event.workspaceId !== identity.workspaceId) {
    context.addIssue({
      code: "custom",
      path: ["workspaceId"],
      message: "Event workspace is invalid."
    });
  }
});

export type StoredDomainEvent = z.infer<typeof StoredDomainEventSchema>;
export type DomainEventType = (typeof EVENT_TYPES)[number];

export const parseStoredDomainEvent = (candidate: unknown): StoredDomainEvent => {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return StoredDomainEventSchema.parse(candidate);
  }
  const event = candidate as Readonly<Record<string, unknown>>;
  if (event.schemaVersion !== 1 || event.type !== "stage.failed") {
    return StoredDomainEventSchema.parse(candidate);
  }
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return StoredDomainEventSchema.parse(candidate);
  }
  const error = (payload as Readonly<Record<string, unknown>>).error;
  if (
    error === null ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    Object.hasOwn(error, "code")
  ) {
    return StoredDomainEventSchema.parse(candidate);
  }
  return StoredDomainEventSchema.parse({
    ...event,
    payload: {
      ...payload,
      error: { ...error, code: "legacy_workflow_failure" }
    }
  });
};
