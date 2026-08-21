import {
  RunSummarySchema,
  type Run,
  type RunSummary,
  type StoredDomainEvent,
  type WorkItem
} from "@autostack/contracts";

import { ProjectionOrderError } from "./errors.js";
import { transitionRun } from "./run-machine.js";

interface ProjectedRun {
  readonly run: Run;
  readonly lastGlobalSequence: number;
}

const streamKey = (event: StoredDomainEvent): string => `${event.stream.kind}:${event.stream.id}`;

export function projectRunSummaries(events: readonly StoredDomainEvent[]): readonly RunSummary[] {
  const streamVersions = new Map<string, number>();
  const workItems = new Map<string, WorkItem>();
  const runs = new Map<string, ProjectedRun>();
  let lastGlobalSequence = 0;

  for (const event of events) {
    if (event.globalSequence <= lastGlobalSequence) {
      throw new ProjectionOrderError(event.stream.id);
    }
    lastGlobalSequence = event.globalSequence;

    const key = streamKey(event);
    const previousVersion = streamVersions.get(key) ?? 0;
    if (event.streamVersion <= previousVersion) {
      throw new ProjectionOrderError(event.stream.id);
    }
    streamVersions.set(key, event.streamVersion);

    if (event.type === "work_item.created") {
      workItems.set(event.payload.workItem.id, event.payload.workItem);
      continue;
    }
    if (event.type === "run.created") {
      runs.set(event.payload.run.id, {
        run: event.payload.run,
        lastGlobalSequence: event.globalSequence
      });
      continue;
    }
    if (event.type === "run.transitioned") {
      const current = runs.get(event.payload.runId);
      if (current === undefined || current.run.status !== event.payload.from) {
        throw new ProjectionOrderError(event.payload.runId);
      }
      const decision = transitionRun({
        run: current.run,
        to: event.payload.to,
        reason: event.payload.reason,
        ...(event.payload.resumeStatus === undefined
          ? {}
          : { resumeStatus: event.payload.resumeStatus }),
        actor: event.actor,
        correlationId: event.correlationId,
        occurredAt: event.occurredAt
      });
      runs.set(event.payload.runId, {
        run: decision.run,
        lastGlobalSequence: event.globalSequence
      });
    }
  }

  return [...runs.values()]
    .flatMap(({ run, lastGlobalSequence: runSequence }) => {
      const workItem = workItems.get(run.workItemId);
      if (workItem === undefined) return [];

      return [
        RunSummarySchema.parse({
          runId: run.id,
          workItemId: run.workItemId,
          title: workItem.title,
          source: workItem.source.kind,
          status: run.status,
          ...(run.currentStage === undefined ? {} : { currentStage: run.currentStage }),
          lastGlobalSequence: runSequence,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt
        })
      ];
    })
    .sort((left, right) => right.lastGlobalSequence - left.lastGlobalSequence);
}

export { ProjectionOrderError };
