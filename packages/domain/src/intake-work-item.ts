import {
  PendingDomainEventSchema,
  RunSchema,
  WorkItemSchema,
  type Actor,
  type IdFactory,
  type Run,
  type SourceRef,
  type WorkItem,
  type WorkspaceId
} from "@autostack/contracts";

import type { NewWorkflowJob, StreamAppend } from "./ports/durable-store.js";

export interface IntakeWorkItemDependencies {
  readonly now: () => string;
  readonly ids: Pick<IdFactory, "workItem" | "run" | "job">;
}

export interface IntakeWorkItemInput {
  readonly source: SourceRef;
  readonly title: string;
  readonly description?: string;
  readonly requester: {
    readonly externalId: string;
    readonly displayName?: string;
  };
  readonly attachments?: readonly { readonly name: string; readonly uri: string }[];
  readonly priority: WorkItem["priority"];
  readonly labels: readonly string[];
  readonly acceptanceContext: readonly string[];
  /**
   * Caller-supplied dedup key for `manual` sources, which carry no
   * `deliveryId`. Required when `source.kind === "manual"`; ignored
   * otherwise.
   */
  readonly manualIdempotencyKey?: string;
}

export interface WorkItemIdempotency {
  readonly scope: string;
  readonly key: string;
}

export interface IntakeWorkItemDecision {
  readonly workItem: WorkItem;
  readonly run: Run;
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
  readonly idempotency: WorkItemIdempotency;
}

function deriveIdempotency(
  source: SourceRef,
  workspaceId: WorkspaceId,
  manualIdempotencyKey: string | undefined
): WorkItemIdempotency {
  switch (source.kind) {
    case "github":
      return { scope: `intake:github:${workspaceId}`, key: source.deliveryId };
    case "slack":
      return { scope: `intake:slack:${workspaceId}`, key: source.deliveryId };
    case "api":
      return { scope: `intake:api:${workspaceId}`, key: source.deliveryId };
    case "manual": {
      if (manualIdempotencyKey === undefined || manualIdempotencyKey.trim().length === 0) {
        throw new Error("A manual source requires a caller-supplied idempotency key.");
      }
      return { scope: `intake:manual:${workspaceId}`, key: manualIdempotencyKey };
    }
    default: {
      const unreachable: never = source;
      throw new Error(`Unsupported source kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function intakeWorkItem(
  input: IntakeWorkItemInput,
  context: {
    readonly workspaceId: WorkspaceId;
    readonly actor: Actor;
    readonly correlationId: string;
  },
  dependencies: IntakeWorkItemDependencies
): IntakeWorkItemDecision {
  const occurredAt = dependencies.now();
  const workItem = WorkItemSchema.parse({
    schemaVersion: 1,
    id: dependencies.ids.workItem(),
    workspaceId: context.workspaceId,
    source: input.source,
    title: input.title,
    description: input.description ?? "",
    requester: input.requester,
    attachments: input.attachments ?? [],
    priority: input.priority,
    labels: input.labels,
    acceptanceContext: input.acceptanceContext,
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
  const idempotency = deriveIdempotency(
    workItem.source,
    context.workspaceId,
    input.manualIdempotencyKey
  );

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
    jobs: [
      {
        jobId: dependencies.ids.job(),
        workspaceId: context.workspaceId,
        runId: run.id,
        stage: "triage",
        handler: "pipeline.triage",
        // Shaped for `PipelineJobPayloadSchema` (plan Task 3), which every station handler
        // registers with and which parses this payload before the handler runs. `runId` is
        // deliberately absent: it is already a top-level `NewWorkflowJob` field and reaches the
        // handler as `job.runId`. Triage is the one stage that legitimately has no prior
        // evidence, so `inputEvidenceDigests` is empty here and non-empty for every later stage.
        payload: {
          workItemId: workItem.id,
          pipelineStage: "triage",
          attempt: 1,
          inputEvidenceDigests: []
        },
        maxAttempts: 3,
        availableAt: occurredAt,
        createdAt: occurredAt
      }
    ],
    idempotency
  };
}
