import {
  PendingDomainEventSchema,
  PipelineEvidenceSchema,
  assertPipelineReworkTransition,
  assertPipelineTransition,
  digestVersionedValue,
  type JobId,
  type PendingDomainEvent,
  type PipelineEvidence,
  type PipelineStage,
  type RunId,
  type WorkflowFailure
} from "@autostack/contracts";
import { transitionRun, type LeasedWorkflowJob, type StreamAppend } from "@autostack/domain";

import { RetryableJobError } from "../errors.js";
import type { WorkflowHandlerResult } from "../handler-registry.js";
import { PipelineJobPayloadSchema } from "./pipeline-job.js";
import type { StationDependencies } from "./station-context.js";
import { readPipelineState } from "./station-kernel-state.js";

/**
 * Raised by `checkpoint()` when the lease was aborted. A station that catches nothing therefore
 * unwinds without producing a commit, leaving the lease to expire and be recovered (plan F1).
 */
export class StageAbandoned extends Error {
  readonly jobId: JobId;

  constructor(jobId: JobId) {
    super(`Workflow job ${jobId} was abandoned before it could commit.`);
    this.name = "StageAbandoned";
    this.jobId = jobId;
  }
}

export type StageOutcome =
  { readonly status: "succeeded" } | { readonly status: "failed"; readonly error: WorkflowFailure };

type EnvelopeContextKey =
  "schemaVersion" | "workspaceId" | "workItemId" | "runId" | "evidenceDigest" | "producedAt";

/**
 * Array fields are widened to `readonly` so a station may hand over the list it already holds —
 * `artifactIds` from a runner read, `findings` from a review report — without copying it.
 */
type WithReadonlyArrays<T> = {
  [K in keyof T]: T[K] extends readonly (infer Item)[] ? readonly Item[] : T[K];
};

type WithoutEnvelopeContext<T> = T extends unknown
  ? WithReadonlyArrays<Omit<T, EnvelopeContextKey>>
  : never;

/**
 * What a station supplies: its stage's own fields plus the artifact ids its work produced. Run
 * identity, the schema version, the timestamp, and the digest are the kernel's to fill (plan D13).
 */
export type PipelineEvidenceDraft = WithoutEnvelopeContext<PipelineEvidence>;

export interface StationKernel {
  buildEvidence(draft: PipelineEvidenceDraft): Promise<PipelineEvidence>;
  openStage(job: LeasedWorkflowJob): readonly PendingDomainEvent[];
  closeStage(job: LeasedWorkflowJob, outcome: StageOutcome): readonly PendingDomainEvent[];
  advance(from: PipelineStage, to: PipelineStage, attempt: number): PipelineStage;
  failDeterministically(
    job: LeasedWorkflowJob,
    failure: WorkflowFailure
  ): Promise<WorkflowHandlerResult>;
  checkpoint(): void;
  appendFor(streamVersion: number, events: readonly PendingDomainEvent[]): StreamAppend;
}

/**
 * The digest domain for a `PipelineEvidence` envelope. Contracts ships digest helpers for every
 * station *document* and for the publish scope, but none for the envelope, so this module is the
 * single authority for it: `implementationEvidenceDigest`, `verificationEvidenceDigest`, and the
 * whole `PublicationEvidenceBundle` chain only line up because every envelope is sealed here.
 */
const EVIDENCE_DIGEST_DOMAIN = "autostack.pipeline-evidence";

const withoutUndefined = (value: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

/**
 * Every event a station emits for one run shares that run's correlation id. `StationDependencies`
 * carries no request-scoped correlation — a station is woken by a lease, not by a request — and
 * minting one per event would leave the run's causal chain uncorrelated. A `RunId` is
 * `run_<uuid>`, so its suffix is exactly the uuid the event schema requires.
 */
const correlationIdForRun = (runId: RunId): string => runId.slice(runId.indexOf("_") + 1);

/** The two stages whose failed judgement routes the run back to implement (spec §8.2). */
const JUDGING_STAGES = new Set<PipelineStage>(["verify", "isolated_review"]);

export const createStationKernel = (
  job: LeasedWorkflowJob,
  dependencies: StationDependencies
): StationKernel => {
  const payload = PipelineJobPayloadSchema.parse(job.payload);
  if (dependencies.workspaceId !== job.workspaceId) {
    throw new TypeError("A station's workspace must be the workspace of its leased job.");
  }
  const correlationId = correlationIdForRun(job.runId);

  const assertOwnJob = (candidate: LeasedWorkflowJob): void => {
    if (
      candidate.jobId !== job.jobId ||
      candidate.runId !== job.runId ||
      candidate.stage !== job.stage
    ) {
      throw new TypeError("A station may only emit stage evidence for its own leased job.");
    }
  };

  const stageEvent = (
    type: string,
    extra: Readonly<Record<string, unknown>> = {}
  ): PendingDomainEvent =>
    PendingDomainEventSchema.parse({
      workspaceId: job.workspaceId,
      actor: dependencies.actor,
      correlationId,
      occurredAt: dependencies.now(),
      type,
      payload: { runId: job.runId, stage: job.stage, jobId: job.jobId, ...extra }
    });

  const closeStage = (
    candidate: LeasedWorkflowJob,
    outcome: StageOutcome
  ): readonly PendingDomainEvent[] => {
    assertOwnJob(candidate);
    return outcome.status === "succeeded"
      ? [stageEvent("stage.succeeded")]
      : [stageEvent("stage.failed", { error: outcome.error })];
  };

  const appendFor = (
    streamVersion: number,
    events: readonly PendingDomainEvent[]
  ): StreamAppend => ({
    stream: { kind: "run", id: job.runId },
    expectedVersion: streamVersion,
    events
  });

  return {
    async buildEvidence(draft: PipelineEvidenceDraft): Promise<PipelineEvidence> {
      // Identity is spread last so a draft can never displace it, whatever a document body said.
      const envelope = withoutUndefined({
        ...draft,
        schemaVersion: 1,
        workspaceId: job.workspaceId,
        workItemId: payload.workItemId,
        runId: job.runId,
        producedAt: dependencies.now()
      });
      const evidenceDigest = await digestVersionedValue(EVIDENCE_DIGEST_DOMAIN, envelope);
      return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
    },

    openStage(candidate: LeasedWorkflowJob): readonly PendingDomainEvent[] {
      assertOwnJob(candidate);
      return [
        stageEvent("stage.queued"),
        stageEvent("stage.leased", { workerId: candidate.leaseOwner, attempt: candidate.attempt })
      ];
    },

    closeStage,

    advance(from: PipelineStage, to: PipelineStage, attempt: number): PipelineStage {
      if (to === "implement" && JUDGING_STAGES.has(from)) {
        return assertPipelineReworkTransition(from, attempt);
      }
      return assertPipelineTransition(from, to);
    },

    /**
     * A deterministic failure is an outcome, not an exception (plan D10). Rethrowing would leave
     * the executor to fail the job while the run stayed in an active status, stranding it with no
     * lease and no terminal event. A retryable failure is the opposite case: it must reach the
     * executor so the job is rescheduled, and it must not write a terminal run transition.
     */
    async failDeterministically(
      candidate: LeasedWorkflowJob,
      failure: WorkflowFailure
    ): Promise<WorkflowHandlerResult> {
      assertOwnJob(candidate);
      // Abandonment outranks failure. The natural station shape is
      // `catch (error) { return failDeterministically(job, classifyStageFailure(error)) }`, and
      // `classifyStageFailure` has no case for `StageAbandoned` — it would fall through to
      // `unknown_error`/non-retryable and commit `run.transitioned -> failed` on a lease that was
      // told to stop. That marks a run permanently failed where lease expiry should have recovered
      // it, and it does so silently. Checking here closes the hole for every caller, however the
      // failure was classified or hand-built.
      if (dependencies.signal.aborted) throw new StageAbandoned(job.jobId);
      if (failure.retryable) throw new RetryableJobError(failure.message);
      const state = readPipelineState(await dependencies.readRunEvents(job.runId), job.runId);
      if (state.run === undefined) {
        throw new TypeError("A run must be recorded before its stage can fail.");
      }
      const transition = transitionRun({
        run: state.run,
        to: "failed",
        reason: failure.message,
        actor: dependencies.actor,
        correlationId,
        occurredAt: dependencies.now()
      });
      return {
        appends: [
          appendFor(state.streamVersion, [
            ...closeStage(candidate, { status: "failed", error: failure }),
            ...transition.events
          ])
        ],
        jobs: []
      };
    },

    checkpoint(): void {
      if (dependencies.signal.aborted) throw new StageAbandoned(job.jobId);
    },

    appendFor
  };
};
