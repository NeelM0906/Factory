/**
 * Clarification service — answers outstanding clarification questions (Task 6, plan F6).
 *
 * Finds the run, projects its clarification state from the event stream, delegates to
 * `answerClarification` from domain, and commits the result. The idempotency key is
 * server-derived from the clarification ref and answer content: the client carries only
 * `answer` and `origin`; the rest is read from the path and context.
 */

import { createHash } from "node:crypto";

import {
  ClarificationResponseSchema,
  RunIdSchema,
  RunSchema,
  type Actor,
  type AnswerClarificationRequest,
  type AnswerClarificationResponse,
  type ClarificationRequest,
  type IdFactory,
  type StoredDomainEvent,
  type WorkspaceId
} from "@autostack/contracts";
import {
  answerClarification,
  type ClarificationState,
  type DurableStore
} from "@autostack/domain";

export class ClarificationNotFoundError extends Error {
  constructor(runId: string, clarificationRef: string) {
    super(`Clarification ${clarificationRef} was not found on run ${runId}.`);
    this.name = "ClarificationNotFoundError";
  }
}

export class RunNotInClarificationError extends Error {
  constructor(runId: string, status: string) {
    super(
      `Run ${runId} is in status ${status}, not needs_clarification.`
    );
    this.name = "RunNotInClarificationError";
  }
}

export interface ClarificationServiceDependencies {
  readonly store: DurableStore;
  readonly workspaceId: WorkspaceId;
  readonly now: () => string;
  readonly ids: Pick<IdFactory, "job">;
}

const LOCAL_ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };

/**
 * Derives a deterministic idempotency key from the clarification ref and the answer content,
 * so the same answer to the same question is always a replay. A different answer to the same
 * question is refused by the domain function (not a new commit).
 */
function deriveIdempotencyKey(clarificationRef: string, answer: string): string {
  return createHash("sha256")
    .update(`${clarificationRef}:${answer}`)
    .digest("hex");
}

/**
 * Projects the run and its clarification state from a stream of stored domain events.
 */
function projectClarifications(
  events: readonly StoredDomainEvent[]
): {
  readonly run: { id: string; status: string; workspaceId: string; workItemId: string } | undefined;
  readonly clarifications: readonly ClarificationState[];
  readonly streamVersion: number;
} {
  let run: ReturnType<typeof RunSchema.parse> | undefined;
  const clarifications: ClarificationState[] = [];
  let streamVersion = 0;

  for (const event of events) {
    streamVersion = Math.max(streamVersion, event.streamVersion);

    if (event.type === "run.created") {
      run = RunSchema.parse(event.payload.run);
    }
    if (event.type === "run.transitioned" && run !== undefined) {
      run = RunSchema.parse({
        ...run,
        status: event.payload.to,
        updatedAt: event.occurredAt
      });
    }
    if (event.type === "clarification.requested") {
      const request = event.payload.request as ClarificationRequest;
      clarifications.push({ request });
    }
    if (event.type === "clarification.answered") {
      const response = event.payload.response as { clarificationRef: string };
      const existing = clarifications.find(
        (c) => c.request.clarificationRef === response.clarificationRef
      );
      if (existing !== undefined) {
        const index = clarifications.indexOf(existing);
        clarifications[index] = {
          request: existing.request,
          response: event.payload.response as NonNullable<ClarificationState["response"]>
        };
      }
    }
  }

  return { run, clarifications, streamVersion };
}

export class ClarificationService {
  readonly #deps: ClarificationServiceDependencies;

  constructor(deps: ClarificationServiceDependencies) {
    this.#deps = deps;
  }

  async answer(
    runIdInput: string,
    clarificationRef: string,
    request: AnswerClarificationRequest
  ): Promise<AnswerClarificationResponse> {
    const runId = RunIdSchema.parse(runIdInput);

    // Verify the run exists.
    if (
      !(await this.#deps.store.runExists({
        workspaceId: this.#deps.workspaceId,
        runId
      }))
    ) {
      throw new (await import("./run-service.js")).RunNotFoundError(runId);
    }

    // Read events and project state.
    const events = await this.#deps.store.readRunEvents({
      workspaceId: this.#deps.workspaceId,
      runId
    });
    const projected = projectClarifications(events);
    if (projected.run === undefined) {
      throw new (await import("./run-service.js")).RunNotFoundError(runId);
    }

    // Build the ClarificationResponse for the domain function.
    const occurredAt = this.#deps.now();
    const idempotencyKey = deriveIdempotencyKey(clarificationRef, request.answer);

    const clarificationResponse = ClarificationResponseSchema.parse({
      schemaVersion: 1,
      idempotencyKey,
      runId,
      clarificationRef,
      answer: request.answer,
      origin: request.origin,
      actorId: LOCAL_ACTOR.id,
      answeredAt: occurredAt
    });

    const correlationId = runId.slice(runId.indexOf("_") + 1);

    // Check the idempotency key BEFORE delegating to domain. The domain function rejects
    // answers when the run has already transitioned away from needs_clarification, but a
    // replayed answer should still return 200 even after the transition.
    const earlyIdempotency = {
      scope: `clarification:${this.#deps.workspaceId}:${runId}`,
      key: idempotencyKey
    };
    const existingResult = await this.#deps.store.readCommitResult(earlyIdempotency);
    if (existingResult !== null) {
      const answeredEvent = existingResult.events.find(
        (e) => e.type === "clarification.answered"
      );
      return {
        runId,
        clarificationRef,
        answeredAt:
          (answeredEvent?.payload.response as { answeredAt?: string })?.answeredAt ??
          occurredAt,
        replayed: true
      };
    }

    // Delegate to domain.
    const decision = answerClarification(
      clarificationResponse,
      {
        run: RunSchema.parse(projected.run),
        clarifications: projected.clarifications,
        streamVersion: projected.streamVersion,
        actor: LOCAL_ACTOR,
        correlationId
      },
      {
        now: () => occurredAt,
        ids: { job: this.#deps.ids.job }
      }
    );

    if (decision.replayed) {
      return {
        runId,
        clarificationRef,
        answeredAt: occurredAt,
        replayed: true
      };
    }

    // Commit.
    const idempotency = decision.idempotency;

    try {
      const result = await this.#deps.store.commit({
        idempotency,
        appends: decision.appends,
        jobs: decision.jobs
      });
      const answeredEvent = result.events.find(
        (e) => e.type === "clarification.answered"
      );
      return {
        runId,
        clarificationRef,
        answeredAt:
          (answeredEvent?.payload.response as { answeredAt?: string })?.answeredAt ??
          occurredAt,
        replayed: result.replayed
      };
    } catch {
      // On OCC conflict, check for replay.
      const replay = await this.#deps.store.readCommitResult(idempotency);
      if (replay !== null) {
        return {
          runId,
          clarificationRef,
          answeredAt: occurredAt,
          replayed: true
        };
      }
      throw new Error("The clarification answer could not be committed.");
    }
  }
}
