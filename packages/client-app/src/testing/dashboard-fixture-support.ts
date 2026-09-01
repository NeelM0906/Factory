import {
  StoredDomainEventSchema,
  type DomainEventType,
  type RunStage,
  type StoredDomainEvent,
  type WorkflowFailure,
  type WorkspaceId
} from "@autostack/contracts";

import { buildDeterministicUuid } from "./deterministic-ids.js";

const SYSTEM_ACTOR = { kind: "system", id: "fixture-seed" } as const;

export interface DashboardEventStreamId {
  readonly kind: "work_item" | "run";
  readonly id: string;
}

export interface DashboardEventStream {
  readonly events: readonly StoredDomainEvent[];
  /**
   * Records one event. Every substantive field — `type`, `payload`, the stream identity, the
   * timestamp — is supplied by the caller as a literal; this stamps only the mechanical envelope
   * metadata a real event store assigns on write (`eventId`, `correlationId`, `streamVersion`,
   * `globalSequence`) and then runs the result through `StoredDomainEventSchema`, so a seeded event
   * that does not match its own contract fails here, at fixture construction, not at first use.
   */
  emit(
    body: { readonly type: DomainEventType; readonly payload: unknown },
    stream: DashboardEventStreamId,
    occurredAt: string
  ): StoredDomainEvent;
}

export function createDashboardEventStream(workspaceId: WorkspaceId): DashboardEventStream {
  const events: StoredDomainEvent[] = [];
  const streamVersions = new Map<string, number>();
  let globalSequence = 0;
  let correlationCounter = 0;

  return {
    events,
    emit(body, stream, occurredAt) {
      globalSequence += 1;
      correlationCounter += 1;
      const streamKey = `${stream.kind}:${stream.id}`;
      const streamVersion = (streamVersions.get(streamKey) ?? 0) + 1;
      streamVersions.set(streamKey, streamVersion);
      const event = StoredDomainEventSchema.parse({
        workspaceId,
        actor: SYSTEM_ACTOR,
        correlationId: buildDeterministicUuid(2_000_000 + correlationCounter),
        occurredAt,
        ...body,
        eventId: `evt_${buildDeterministicUuid(3_000_000 + globalSequence)}`,
        stream,
        streamVersion,
        globalSequence,
        schemaVersion: 1
      });
      events.push(event);
      return event;
    }
  };
}

/**
 * A deterministic, injectable replacement for a SHA-256 hex digest. Not a real hash — a stand-in
 * that satisfies the `/^[0-9a-f]{64}$/` digest shape while staying reproducible and free of any
 * credential-shaped literal (fixture doctrine, Task 9a brief).
 */
export function createDeterministicDigestFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return counter.toString(16).padStart(64, "0");
  };
}

export type StageOutcome =
  | { readonly kind: "succeeded"; readonly at: string }
  | { readonly kind: "failed"; readonly at: string; readonly error: WorkflowFailure };

export interface StageTripleParams {
  readonly runId: string;
  readonly stage: RunStage;
  readonly jobId: string;
  readonly workerId: string;
  readonly attempt: number;
  readonly queuedAt: string;
  readonly leasedAt: string;
  readonly outcome: StageOutcome;
}

/**
 * Emits the `stage.queued` -> `stage.leased` -> `stage.succeeded`|`stage.failed` triple the plan's
 * Task 9a composition table counts. Every field is supplied by the call site as a literal; this
 * only spares each of the 19 call sites the three repeated `emit` calls.
 */
export function emitStageTriple(stream: DashboardEventStream, params: StageTripleParams): void {
  const streamId: DashboardEventStreamId = { kind: "run", id: params.runId };
  stream.emit(
    {
      type: "stage.queued",
      payload: { runId: params.runId, stage: params.stage, jobId: params.jobId }
    },
    streamId,
    params.queuedAt
  );
  stream.emit(
    {
      type: "stage.leased",
      payload: {
        runId: params.runId,
        stage: params.stage,
        jobId: params.jobId,
        workerId: params.workerId,
        attempt: params.attempt
      }
    },
    streamId,
    params.leasedAt
  );
  if (params.outcome.kind === "succeeded") {
    stream.emit(
      {
        type: "stage.succeeded",
        payload: { runId: params.runId, stage: params.stage, jobId: params.jobId }
      },
      streamId,
      params.outcome.at
    );
    return;
  }
  stream.emit(
    {
      type: "stage.failed",
      payload: {
        runId: params.runId,
        stage: params.stage,
        jobId: params.jobId,
        error: params.outcome.error
      }
    },
    streamId,
    params.outcome.at
  );
}
