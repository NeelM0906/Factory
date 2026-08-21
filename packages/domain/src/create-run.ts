import {
  CreateRunRequestSchema,
  PendingDomainEventSchema,
  RunSchema,
  WorkItemSchema,
  type Actor,
  type CreateRunRequestInput,
  type IdFactory,
  type Run,
  type WorkItem,
  type WorkspaceId
} from "@autostack/contracts";

import type { NewWorkflowJob, StreamAppend } from "./ports/durable-store.js";

export interface CreateRunDependencies {
  readonly now: () => string;
  readonly ids: Pick<IdFactory, "workItem" | "run">;
}

export interface CreateRunDecision {
  readonly workItem: WorkItem;
  readonly run: Run;
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
}

export function createManualRun(
  input: CreateRunRequestInput,
  context: {
    readonly workspaceId: WorkspaceId;
    readonly actor: Actor;
    readonly correlationId: string;
  },
  dependencies: CreateRunDependencies
): CreateRunDecision {
  const request = CreateRunRequestSchema.parse(input);
  const occurredAt = dependencies.now();
  const workItem = WorkItemSchema.parse({
    schemaVersion: 1,
    id: dependencies.ids.workItem(),
    workspaceId: context.workspaceId,
    source: { kind: "manual", client: "api" },
    title: request.title,
    description: request.description,
    requester: {
      externalId: context.actor.id,
      ...(context.actor.kind === "user" && context.actor.displayName !== undefined
        ? { displayName: context.actor.displayName }
        : {})
    },
    attachments: [],
    priority: "normal",
    labels: [],
    acceptanceContext: request.acceptanceContext,
    createdAt: occurredAt,
    updatedAt: occurredAt
  });
  const run = RunSchema.parse({
    schemaVersion: 1,
    id: dependencies.ids.run(),
    workspaceId: context.workspaceId,
    workItemId: workItem.id,
    workflowVersion: "foundation.v1",
    status: "queued",
    createdAt: occurredAt,
    updatedAt: occurredAt
  });
  const workItemEvent = PendingDomainEventSchema.parse({
    workspaceId: context.workspaceId,
    actor: context.actor,
    correlationId: context.correlationId,
    occurredAt,
    type: "work_item.created",
    payload: { workItem }
  });
  const runEvent = PendingDomainEventSchema.parse({
    workspaceId: context.workspaceId,
    actor: context.actor,
    correlationId: context.correlationId,
    occurredAt,
    type: "run.created",
    payload: { run }
  });

  return {
    workItem,
    run,
    appends: [
      {
        stream: { kind: "work_item", id: workItem.id },
        expectedVersion: 0,
        events: [workItemEvent]
      },
      {
        stream: { kind: "run", id: run.id },
        expectedVersion: 0,
        events: [runEvent]
      }
    ],
    jobs: []
  };
}
