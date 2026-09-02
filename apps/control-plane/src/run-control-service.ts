/**
 * Run control service — steer and cancel routes.
 *
 * Steer emits a `run.steered` event with a user-supplied instruction.
 * Cancel transitions the run to `cancelling` and, if no workflow job is currently leased
 * for the run, immediately follows with `cancelled`. When a job is leased, the running
 * station detects the cancellation at its next await boundary (F1/F11).
 *
 * Both routes require a client-supplied `Idempotency-Key` (D9).
 */

import {
  PendingDomainEventSchema,
  RunIdSchema,
  RunSchema,
  SteerRunResponseSchema,
  CancelRunResponseSchema,
  type Actor,
  type CancelRunRequest,
  type CancelRunResponse,
  type Run,
  type RunId,
  type SteerRunRequest,
  type SteerRunResponse,
  type StoredDomainEvent,
  type WorkspaceId
} from "@autostack/contracts";
import {
  InvalidRunTransitionError,
  transitionRun,
  type CommitResult,
  type DurableStore,
  type StreamAppend
} from "@autostack/domain";

export class TerminalRunError extends Error {
  constructor(runId: string, status: string) {
    super(`Run ${runId} is in terminal status ${status} and cannot be steered or cancelled.`);
    this.name = "TerminalRunError";
  }
}

export interface RunControlServiceDependencies {
  readonly store: DurableStore;
  readonly workspaceId: WorkspaceId;
  readonly now: () => string;
}

const LOCAL_ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

/**
 * Project the latest run state from the event stream.
 */
const projectRunFromEvents = (events: readonly StoredDomainEvent[]): Run | undefined => {
  let run: Run | undefined;
  for (const event of events) {
    if (event.type === "run.created") {
      run = RunSchema.parse(event.payload.run);
      continue;
    }
    if (event.type === "run.transitioned" && run !== undefined) {
      run = transitionRun({
        run,
        to: event.payload.to,
        reason: event.payload.reason,
        ...(event.payload.resumeStatus === undefined
          ? {}
          : { resumeStatus: event.payload.resumeStatus }),
        actor: event.actor,
        correlationId: event.correlationId,
        occurredAt: event.occurredAt
      }).run;
    }
  }
  return run;
};


export class RunControlService {
  readonly #dependencies: RunControlServiceDependencies;

  constructor(dependencies: RunControlServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async steer(
    runIdInput: string,
    request: SteerRunRequest,
    idempotencyKey: string
  ): Promise<SteerRunResponse> {
    const runId = RunIdSchema.parse(runIdInput);
    const idempotency = {
      scope: `api:steer-run:${this.#dependencies.workspaceId}`,
      key: idempotencyKey
    };

    // Check for replay first.
    const replay = await this.#dependencies.store.readCommitResult(idempotency);
    if (replay !== null) {
      return this.#steerResponse(runId, replay);
    }

    // Verify the run exists.
    if (
      !(await this.#dependencies.store.runExists({
        workspaceId: this.#dependencies.workspaceId,
        runId
      }))
    ) {
      throw new (await import("./run-service.js")).RunNotFoundError(runId);
    }

    // Read run events and project the run state.
    const events = await this.#dependencies.store.readRunEvents({
      workspaceId: this.#dependencies.workspaceId,
      runId
    });
    const run = projectRunFromEvents(events);
    if (run === undefined) {
      throw new (await import("./run-service.js")).RunNotFoundError(runId);
    }
    if (TERMINAL.has(run.status)) {
      throw new TerminalRunError(runId, run.status);
    }

    const occurredAt = this.#dependencies.now();
    const correlationId = runId.slice(runId.indexOf("_") + 1);

    const event = PendingDomainEventSchema.parse({
      workspaceId: this.#dependencies.workspaceId,
      actor: LOCAL_ACTOR,
      correlationId,
      occurredAt,
      type: "run.steered",
      payload: {
        runId,
        instruction: request.instruction,
        origin: "api",
        actorId: LOCAL_ACTOR.id,
        acceptedAt: occurredAt
      }
    });

    const streamVersion = events[events.length - 1]!.streamVersion;
    const append: StreamAppend = {
      stream: { kind: "run", id: runId },
      expectedVersion: streamVersion,
      events: [event]
    };

    let result: CommitResult;
    try {
      result = await this.#dependencies.store.commit({
        idempotency,
        appends: [append],
        jobs: []
      });
    } catch {
      const concurrentReplay = await this.#dependencies.store.readCommitResult(idempotency);
      if (concurrentReplay !== null) return this.#steerResponse(runId, concurrentReplay);
      throw new Error("The steer command could not be committed.");
    }

    return this.#steerResponse(runId, result);
  }

  #steerResponse(runId: RunId, result: CommitResult): SteerRunResponse {
    const steeredEvent = result.events.find((e) => e.type === "run.steered");
    return SteerRunResponseSchema.parse({
      runId,
      accepted: true,
      acceptedAt: (steeredEvent?.payload.acceptedAt as string) ?? this.#dependencies.now()
    });
  }

  async cancel(
    runIdInput: string,
    request: CancelRunRequest,
    idempotencyKey: string
  ): Promise<CancelRunResponse> {
    const runId = RunIdSchema.parse(runIdInput);
    const idempotency = {
      scope: `api:cancel-run:${this.#dependencies.workspaceId}`,
      key: idempotencyKey
    };

    // Check for replay first.
    const replay = await this.#dependencies.store.readCommitResult(idempotency);
    if (replay !== null) {
      return this.#cancelResponse(runId, replay);
    }

    // Verify the run exists.
    if (
      !(await this.#dependencies.store.runExists({
        workspaceId: this.#dependencies.workspaceId,
        runId
      }))
    ) {
      throw new (await import("./run-service.js")).RunNotFoundError(runId);
    }

    // Read run events and project the run state.
    const events = await this.#dependencies.store.readRunEvents({
      workspaceId: this.#dependencies.workspaceId,
      runId
    });
    const run = projectRunFromEvents(events);
    if (run === undefined) {
      throw new (await import("./run-service.js")).RunNotFoundError(runId);
    }
    if (TERMINAL.has(run.status)) {
      throw new TerminalRunError(runId, run.status);
    }

    const occurredAt = this.#dependencies.now();
    const correlationId = runId.slice(runId.indexOf("_") + 1);

    // Transition to cancelling.
    const cancellingResult = transitionRun({
      run,
      to: "cancelling",
      reason: request.reason,
      actor: LOCAL_ACTOR,
      correlationId,
      occurredAt
    });

    const pendingEvents = [...cancellingResult.events];

    // If no job is currently leased, also transition to cancelled.
    const jobIsLeased = await this.#dependencies.store.hasLeasedJobForRun({
      workspaceId: this.#dependencies.workspaceId,
      runId
    });
    if (!jobIsLeased) {
      const cancelledResult = transitionRun({
        run: cancellingResult.run,
        to: "cancelled",
        reason: request.reason,
        actor: LOCAL_ACTOR,
        correlationId,
        occurredAt
      });
      pendingEvents.push(...cancelledResult.events);
    }

    const streamVersion = events[events.length - 1]!.streamVersion;
    const append: StreamAppend = {
      stream: { kind: "run", id: runId },
      expectedVersion: streamVersion,
      events: pendingEvents
    };

    let result: CommitResult;
    try {
      result = await this.#dependencies.store.commit({
        idempotency,
        appends: [append],
        jobs: []
      });
    } catch {
      const concurrentReplay = await this.#dependencies.store.readCommitResult(idempotency);
      if (concurrentReplay !== null) return this.#cancelResponse(runId, concurrentReplay);
      throw new Error("The cancel command could not be committed.");
    }

    return this.#cancelResponse(runId, result);
  }

  #cancelResponse(runId: RunId, result: CommitResult): CancelRunResponse {
    // Find the latest transition to determine the final status.
    const transitions = result.events.filter((e) => e.type === "run.transitioned");
    const lastTransition = transitions[transitions.length - 1];
    const status = (lastTransition?.payload.to as string) ?? "cancelling";
    const requestedAt =
      (transitions.find((e) => e.type === "run.transitioned" && e.payload.to === "cancelling")
        ?.occurredAt as string) ?? this.#dependencies.now();

    return CancelRunResponseSchema.parse({
      runId,
      status,
      requestedAt
    });
  }
}
