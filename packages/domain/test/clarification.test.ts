import {
  RunIdSchema,
  RunSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  createIdFactory,
  validateRunStreamCoherence,
  type Actor,
  type ClarificationRequest,
  type ClarificationResponse,
  type Run
} from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import { answerClarification, type AnswerClarificationContext } from "../src/clarification.js";

const NOW = "2026-08-27T12:00:00.000Z";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174009";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174002");
const OTHER_RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174003");
const WORK_ITEM_ID = WorkItemIdSchema.parse("wi_123e4567-e89b-42d3-a456-426614174004");
const ACTOR: Actor = { kind: "user", id: "local-user" };
const EVIDENCE_DIGEST = "d".repeat(64);

const run = (overrides: Partial<Run> = {}): Run =>
  RunSchema.parse({
    schemaVersion: 1,
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    workflowVersion: "foundation.v1",
    status: "needs_clarification",
    currentStage: "triage",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  });

const request: ClarificationRequest = {
  schemaVersion: 1,
  workspaceId: WORKSPACE_ID,
  workItemId: WORK_ITEM_ID,
  runId: RUN_ID,
  clarificationRef: "which-branch",
  stage: "triage",
  question: "Which branch should this target?",
  evidenceDigest: EVIDENCE_DIGEST,
  requestedAt: NOW
};

const response = (overrides: Partial<ClarificationResponse> = {}): ClarificationResponse => ({
  schemaVersion: 1,
  idempotencyKey: "answer-1",
  runId: RUN_ID,
  clarificationRef: "which-branch",
  answer: "Target main.",
  origin: "desktop",
  actorId: "local-user",
  answeredAt: NOW,
  ...overrides
});

const context = (
  overrides: Partial<AnswerClarificationContext> = {}
): AnswerClarificationContext => ({
  run: run(),
  clarifications: [{ request }],
  streamVersion: 4,
  actor: ACTOR,
  correlationId: CORRELATION_ID,
  ...overrides
});

const dependencies = { now: () => NOW, ids: createIdFactory(() => UUID) };

const answer = (
  input: ClarificationResponse = response(),
  overrides: Partial<AnswerClarificationContext> = {}
) => answerClarification(input, context(overrides), dependencies);

describe("answering a clarification", () => {
  it("records the answer, returns the run to triaging, and queues a fresh triage job", () => {
    const decision = answer();

    expect(decision.replayed).toBe(false);
    expect(decision.run.status).toBe("triaging");
    expect(decision.idempotency).toEqual({
      scope: `clarification:${WORKSPACE_ID}:${RUN_ID}`,
      key: "answer-1"
    });
    expect(decision.appends).toHaveLength(1);
    expect(decision.appends[0]).toMatchObject({
      stream: { kind: "run", id: RUN_ID },
      expectedVersion: 4
    });
    expect(decision.appends[0]?.events.map((event) => event.type)).toEqual([
      "clarification.answered",
      "run.transitioned"
    ]);
    expect(decision.appends[0]?.events[0]?.payload).toEqual({
      runId: RUN_ID,
      response: response()
    });
    expect(decision.jobs).toEqual([
      {
        jobId: `job_${UUID}`,
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        stage: "triage",
        handler: "pipeline.triage",
        payload: {
          workItemId: WORK_ITEM_ID,
          pipelineStage: "triage",
          attempt: 1,
          inputEvidenceDigests: [EVIDENCE_DIGEST]
        },
        maxAttempts: 3,
        availableAt: NOW,
        createdAt: NOW
      }
    ]);
  });

  // Rejects an implementation that resumes the run through `run.resumeStatus` — the shape
  // `transitionRun({ run, to: run.resumeStatus ?? "triaging" })`. `needs_clarification` is not a
  // resumable status: only `waiting_for_user` and `retry_scheduled` are, and the run machine
  // consults `resumeStatus` for those alone (`run-machine.ts` RESUMABLE). A run carrying a stray
  // `resumeStatus` must still take the one declared edge, `needs_clarification -> triaging`, and the
  // emitted transition must not carry a `resumeStatus` of its own.
  it("never consults resumeStatus when it returns a clarified run to triaging", () => {
    const decision = answer(response(), { run: run({ resumeStatus: "planning" }) });

    expect(decision.run.status).toBe("triaging");
    expect(decision.run.resumeStatus).toBeUndefined();
    expect(decision.appends[0]?.events[1]?.payload).toEqual({
      runId: RUN_ID,
      from: "needs_clarification",
      to: "triaging",
      reason: "A clarifying question was answered."
    });
  });

  // The adjacent-but-distinguishable case for the guard above: a `waiting_for_user` run is exactly
  // the status that *does* resume through `resumeStatus`, and resuming it is the run machine's job,
  // not this loop's. An implementation that treated both statuses the same would answer here too.
  it("refuses a run that is waiting on the user rather than on a clarification", () => {
    expect(() =>
      answer(response(), { run: run({ status: "waiting_for_user", resumeStatus: "planning" }) })
    ).toThrow(/needs_clarification/i);
  });

  it("refuses an unknown reference, a foreign run, and a malformed response", () => {
    expect(() => answer(response({ clarificationRef: "never-asked" }))).toThrow(/never asked/i);
    expect(() => answer(response({ runId: OTHER_RUN_ID }))).toThrow(/different run/i);
    expect(() =>
      answerClarification(
        { ...response(), answer: "" } as unknown as ClarificationResponse,
        context(),
        dependencies
      )
    ).toThrow();
  });

  // Adjacent-but-distinguishable: the same key is a replay of one delivery and must be silent, a
  // different key is a second answer to a settled question and must be refused. An implementation
  // that keyed only on `clarificationRef` would refuse both; one that keyed only on
  // `idempotencyKey` would answer the question twice.
  it("replays an identical delivery and refuses a second, different answer", () => {
    const answered = { request, response: response() };

    const replay = answer(response(), { clarifications: [answered] });
    expect(replay).toMatchObject({ replayed: true, appends: [], jobs: [] });
    expect(replay.run).toEqual(run());

    expect(() =>
      answer(response({ idempotencyKey: "answer-2", answer: "Target develop." }), {
        clarifications: [answered]
      })
    ).toThrow(/already answered/i);
  });

  it("emits an answer the run stream accepts after the question it answers", async () => {
    const asked = {
      workspaceId: WORKSPACE_ID,
      actor: ACTOR,
      correlationId: CORRELATION_ID,
      occurredAt: NOW,
      type: "clarification.requested",
      payload: { runId: RUN_ID, request }
    };

    const answered = answer().appends[0]?.events ?? [];

    await expect(validateRunStreamCoherence([asked, ...answered])).resolves.toHaveLength(3);
  });
});
