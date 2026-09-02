import {
  ClarificationResponseSchema,
  PendingDomainEventSchema,
  type Actor,
  type ClarificationRequest,
  type ClarificationResponse,
  type IdFactory,
  type Run
} from "@autostack/contracts";

import type { NewWorkflowJob, StreamAppend } from "./ports/durable-store.js";
import { transitionRun } from "./run-machine.js";

/** A question this run asked, with the answer once one arrived. */
export interface ClarificationState {
  readonly request: ClarificationRequest;
  readonly response?: ClarificationResponse;
}

export interface AnswerClarificationContext {
  readonly run: Run;
  readonly clarifications: readonly ClarificationState[];
  /** The run stream version the caller read, stamped on the append so a concurrent writer conflicts. */
  readonly streamVersion: number;
  readonly actor: Actor;
  readonly correlationId: string;
}

export interface AnswerClarificationDependencies {
  readonly now: () => string;
  readonly ids: Pick<IdFactory, "job">;
}

export interface AnswerClarificationDecision {
  readonly run: Run;
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
  readonly idempotency: { readonly scope: string; readonly key: string };
  readonly replayed: boolean;
}

const TRIAGE_MAX_ATTEMPTS = 3;
const TRANSITION_REASON = "A clarifying question was answered.";

/**
 * Answers an outstanding clarification and sends the run back through triage (plan F6).
 *
 * `needs_clarification -> triaging` is a declared edge of the run machine, and it is taken directly:
 * `resumeStatus` is never consulted here. Only `waiting_for_user` and `retry_scheduled` are
 * resumable statuses, and for those the run machine itself resolves the target from the run's own
 * `resumeStatus`. A run that is waiting on the *user* is therefore refused by this use case rather
 * than answered, because resuming it is a different move with a different target.
 *
 * The answer travels to the new triage attempt on the run stream, not in the job payload:
 * `PipelineJobPayloadSchema` is strict and carries no free text, so the fresh job names the
 * clarification's `evidenceDigest` in `inputEvidenceDigests` and the station reads the answered
 * question back out of the events it already folds.
 */
export function answerClarification(
  input: ClarificationResponse,
  context: AnswerClarificationContext,
  dependencies: AnswerClarificationDependencies
): AnswerClarificationDecision {
  const response = ClarificationResponseSchema.parse(input);
  const { run } = context;
  const idempotency = {
    scope: `clarification:${run.workspaceId}:${run.id}`,
    key: response.idempotencyKey
  };

  if (response.runId !== run.id) {
    throw new TypeError("A clarification answer belongs to a different run.");
  }
  if (run.status !== "needs_clarification") {
    throw new TypeError(
      `A clarification answer applies to a run in needs_clarification, not ${run.status}.`
    );
  }
  const asked = context.clarifications.find(
    (candidate) => candidate.request.clarificationRef === response.clarificationRef
  );
  if (asked === undefined) {
    throw new TypeError("This run never asked the clarification being answered.");
  }
  if (asked.response !== undefined) {
    // One delivery replayed is silence; a second, different answer is a decision the run already
    // made being overwritten, which is refused rather than appended.
    if (asked.response.idempotencyKey === response.idempotencyKey) {
      return { run, appends: [], jobs: [], idempotency, replayed: true };
    }
    throw new TypeError("This clarification is already answered.");
  }

  const occurredAt = dependencies.now();
  const answered = PendingDomainEventSchema.parse({
    workspaceId: run.workspaceId,
    actor: context.actor,
    correlationId: context.correlationId,
    occurredAt,
    type: "clarification.answered",
    payload: { runId: run.id, response }
  });
  const transition = transitionRun({
    run,
    to: "triaging",
    reason: TRANSITION_REASON,
    actor: context.actor,
    correlationId: context.correlationId,
    occurredAt
  });

  return {
    run: transition.run,
    appends: [
      {
        stream: { kind: "run", id: run.id },
        expectedVersion: context.streamVersion,
        events: [answered, ...transition.events]
      }
    ],
    jobs: [
      {
        jobId: dependencies.ids.job(),
        workspaceId: run.workspaceId,
        runId: run.id,
        stage: "triage",
        handler: "pipeline.triage",
        payload: {
          workItemId: run.workItemId,
          pipelineStage: "triage",
          // The implement-rework counter, which no clarification spends: a re-triage is the first
          // attempt at the same stage, not a rework of a failed judgement.
          attempt: 1,
          inputEvidenceDigests: [asked.request.evidenceDigest]
        },
        maxAttempts: TRIAGE_MAX_ATTEMPTS,
        availableAt: occurredAt,
        createdAt: occurredAt
      }
    ],
    idempotency,
    replayed: false
  };
}
