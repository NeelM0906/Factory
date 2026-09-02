import { describe, expect, it } from "vitest";

import {
  AgentSessionIdSchema,
  ApprovalIdSchema,
  ArtifactIdSchema,
  EnvironmentIdSchema,
  JobIdSchema,
  RunIdSchema,
  StoredDomainEventSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  createIdFactory,
  digestTriageReport,
  validateRunStreamCoherence,
  type Actor,
  type PipelineEvidence,
  type PipelineStationDocument,
  type StoredDomainEvent,
  type TriageReport
} from "@autostack/contracts";
import {
  OptimisticConcurrencyError,
  intakeWorkItem,
  type LeasedWorkflowJob,
  type RunnerProvider,
  type StreamAppend
} from "@autostack/domain";
import { createFakeAgentHarness, createFakeDeliveryIntegration } from "@autostack/domain/testing";

import {
  PipelineJobPayloadSchema,
  RetryableJobError,
  StageAbandoned,
  classifyStageFailure,
  createStationKernel,
  readPipelineState,
  type StationDependencies
} from "../../src/index.js";

const NOW = "2026-08-27T12:00:00.000Z";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174009";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174002");
const OTHER_RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174003");
const WORK_ITEM_ID = WorkItemIdSchema.parse("wi_123e4567-e89b-42d3-a456-426614174004");
const JOB_ID = JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174005");
const FOREIGN_JOB_ID = JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174006");
const APPROVAL_ID = ApprovalIdSchema.parse("apr_123e4567-e89b-42d3-a456-426614174007");
const SESSION_ID = AgentSessionIdSchema.parse("agt_123e4567-e89b-42d3-a456-426614174010");
const REVIEWER_SESSION_ID = AgentSessionIdSchema.parse("agt_123e4567-e89b-42d3-a456-426614174011");
const ENVIRONMENT_ID = EnvironmentIdSchema.parse("env_123e4567-e89b-42d3-a456-426614174012");
const REVIEWER_ENVIRONMENT_ID = EnvironmentIdSchema.parse(
  "env_123e4567-e89b-42d3-a456-426614174013"
);
const ACTOR: Actor = { kind: "system", id: "workflow" };
const digestOf = (seed: string): string => seed.repeat(64).slice(0, 64);

const unusedPort = (): never => {
  throw new Error("The station kernel does not use this port.");
};
const runner: RunnerProvider = {
  capabilities: async () => unusedPort(),
  inspectRepository: async () => unusedPort(),
  prepareEnvironment: async () => unusedPort(),
  listEnvironments: async () => unusedPort(),
  startCommand: async () => unusedPort(),
  readCommandEvents: () => unusedPort(),
  cancelCommand: async () => unusedPort(),
  readArtifactChunk: async () => unusedPort(),
  disposeEnvironment: async () => unusedPort()
};

const job = (overrides: Partial<LeasedWorkflowJob> = {}): LeasedWorkflowJob => ({
  jobId: JOB_ID,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  stage: "triage",
  handler: "pipeline.triage",
  payload: {
    workItemId: WORK_ITEM_ID,
    pipelineStage: "triage",
    attempt: 1,
    inputEvidenceDigests: []
  },
  maxAttempts: 3,
  availableAt: NOW,
  createdAt: NOW,
  attempt: 2,
  leaseOwner: "worker-1",
  leaseToken: "lease-1",
  leaseExpiresAt: "2026-08-27T12:01:00.000Z",
  ...overrides
});

const dependencies = (overrides: Partial<StationDependencies> = {}): StationDependencies => ({
  now: () => NOW,
  random: () => 0.5,
  signal: new AbortController().signal,
  ids: createIdFactory(() => UUID),
  harness: createFakeAgentHarness({
    script: [],
    now: () => NOW,
    providerSessionRef: () => "provider-session"
  }),
  runner,
  delivery: createFakeDeliveryIntegration({
    now: () => NOW,
    pullRequestNumber: () => 1,
    commentId: () => 1,
    providerEvidenceDigest: () => digestOf("d")
  }),
  readRunEvents: async () => [],
  workspaceId: WORKSPACE_ID,
  actor: ACTOR,
  ...overrides
});

const kernelFor = (
  overrides: Partial<StationDependencies> = {},
  leased: LeasedWorkflowJob = job()
) => createStationKernel(leased, dependencies(overrides));

let sequence = 0;
const stored = (
  type: string,
  payload: Record<string, unknown>,
  streamId: string,
  streamVersion: number
): StoredDomainEvent => {
  sequence += 1;
  return StoredDomainEventSchema.parse({
    workspaceId: WORKSPACE_ID,
    actor: ACTOR,
    correlationId: CORRELATION_ID,
    occurredAt: NOW,
    type,
    payload,
    eventId: `evt_123e4567-e89b-42d3-a456-${String(426614174000 + sequence)}`,
    stream: { kind: "run", id: streamId },
    streamVersion,
    globalSequence: sequence,
    schemaVersion: 1
  });
};

const runEntity = (runId: string) => ({
  schemaVersion: 1,
  id: runId,
  workspaceId: WORKSPACE_ID,
  workItemId: WORK_ITEM_ID,
  workflowVersion: "foundation.v1",
  status: "queued",
  createdAt: NOW,
  updatedAt: NOW
});

const transitioned = (runId: string, from: string, to: string) => ({
  runId,
  from,
  to,
  reason: `${from} to ${to}`
});

const triageReport: TriageReport = {
  schemaVersion: 1,
  workspaceId: WORKSPACE_ID,
  workItemId: WORK_ITEM_ID,
  runId: RUN_ID,
  taskType: "bug",
  priority: "normal",
  complexity: "small",
  actionable: true,
  rationale: "A reproducible regression.",
  duplicates: [],
  producedAt: NOW
};

const evidenceEvent = (
  evidence: PipelineEvidence,
  attempt: number,
  document?: PipelineStationDocument
): Record<string, unknown> => ({
  workspaceId: WORKSPACE_ID,
  actor: ACTOR,
  correlationId: CORRELATION_ID,
  occurredAt: NOW,
  type: "pipeline.evidence_recorded",
  payload: {
    runId: RUN_ID,
    jobId: JOB_ID,
    attempt,
    evidence,
    ...(document === undefined ? {} : { document })
  }
});

const implementDraft = {
  stage: "implement",
  artifactIds: [],
  planApprovalEvidenceDigest: digestOf("2"),
  agentSessionId: SESSION_ID,
  environmentId: ENVIRONMENT_ID,
  sourceCommit: "a".repeat(40),
  resultCommit: "b".repeat(40),
  finalDiffDigest: digestOf("f")
} as const;

const reviewDraft = (verdict: "approved" | "changes_requested") =>
  ({
    stage: "isolated_review",
    artifactIds: [],
    implementationEvidenceDigest: digestOf("3"),
    verificationEvidenceDigest: digestOf("4"),
    reviewedDiffDigest: digestOf("f"),
    implementation: { agentSessionId: SESSION_ID, environmentId: ENVIRONMENT_ID },
    reviewer: {
      agentSessionId: REVIEWER_SESSION_ID,
      environmentId: REVIEWER_ENVIRONMENT_ID
    },
    verdict,
    findings: []
  }) as const;

describe("pipeline job payload", () => {
  it("parses the triage payload intake already enqueues, unchanged", () => {
    const decision = intakeWorkItem(
      {
        source: { kind: "manual", client: "cli" },
        title: "Fix the regression",
        requester: { externalId: "octocat" },
        priority: "normal",
        labels: [],
        acceptanceContext: [],
        manualIdempotencyKey: "manual-1"
      },
      { workspaceId: WORKSPACE_ID, actor: ACTOR, correlationId: CORRELATION_ID },
      { now: () => NOW, ids: createIdFactory(() => UUID) }
    );

    const enqueued = decision.jobs[0]?.payload;
    expect(PipelineJobPayloadSchema.parse(enqueued)).toEqual(enqueued);
    expect(PipelineJobPayloadSchema.parse(enqueued)).toEqual({
      workItemId: `wi_${UUID}`,
      pipelineStage: "triage",
      attempt: 1,
      inputEvidenceDigests: []
    });
  });

  it("refuses a payload that smuggles identity the leased job already carries", () => {
    expect(() =>
      PipelineJobPayloadSchema.parse({
        workItemId: WORK_ITEM_ID,
        pipelineStage: "triage",
        attempt: 1,
        inputEvidenceDigests: [],
        runId: RUN_ID
      })
    ).toThrow();
  });
});

describe("station kernel evidence", () => {
  it("seals an envelope whose digest is reproducible and identity-bound", async () => {
    const kernel = kernelFor();
    const draft = { stage: "triage", artifactIds: [], summary: "Triaged." } as const;

    const evidence = await kernel.buildEvidence(draft);
    const again = await kernel.buildEvidence(draft);

    expect(evidence).toEqual(again);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      stage: "triage",
      workspaceId: WORKSPACE_ID,
      workItemId: WORK_ITEM_ID,
      runId: RUN_ID,
      producedAt: NOW
    });
    const changed = await kernel.buildEvidence({ ...draft, summary: "Triaged again." });
    expect(changed.evidenceDigest).not.toBe(evidence.evidenceDigest);
  });

  it("carries runner-produced artifact ids through unchanged", async () => {
    const artifactIds = [ArtifactIdSchema.parse(`art_${UUID}`)];
    const evidence = await kernelFor().buildEvidence({
      stage: "triage",
      artifactIds,
      summary: "Triaged."
    });

    expect(evidence.artifactIds).toEqual(artifactIds);
  });

  it("takes identity from the leased job, never from the caller's draft", async () => {
    const evidence = await kernelFor().buildEvidence(
      Object.assign({ stage: "triage", artifactIds: [], summary: "Triaged." } as const, {
        runId: OTHER_RUN_ID,
        workItemId: WorkItemIdSchema.parse("wi_123e4567-e89b-42d3-a456-426614174008")
      })
    );

    expect(evidence.runId).toBe(RUN_ID);
    expect(evidence.workItemId).toBe(WORK_ITEM_ID);
  });
});

describe("station kernel stage events", () => {
  it("emits its own queued and leased evidence with the lease owner and attempt", () => {
    const leased = job();
    const events = kernelFor({}, leased).openStage(leased);

    expect(events.map((event) => event.type)).toEqual(["stage.queued", "stage.leased"]);
    expect(events[1]?.payload).toEqual({
      runId: RUN_ID,
      stage: "triage",
      jobId: JOB_ID,
      workerId: "worker-1",
      attempt: 2
    });
  });

  it("closes the stage with a terminal event", () => {
    const leased = job();
    const kernel = kernelFor({}, leased);
    const failure = {
      code: "unknown_error",
      name: "UnknownError",
      message: "It failed.",
      retryable: false
    };

    expect(kernel.closeStage(leased, { status: "succeeded" }).map((event) => event.type)).toEqual([
      "stage.succeeded"
    ]);
    const failed = kernel.closeStage(leased, { status: "failed", error: failure });
    expect(failed[0]?.type).toBe("stage.failed");
    expect(failed[0]?.payload).toMatchObject({ jobId: JOB_ID, error: failure });
  });

  it("refuses to emit stage evidence for a successor job", () => {
    const kernel = kernelFor();

    expect(() => kernel.openStage(job({ jobId: FOREIGN_JOB_ID }))).toThrow(/leased/i);
    expect(() => kernel.closeStage(job({ stage: "plan" }), { status: "succeeded" })).toThrow(
      /leased/i
    );
  });
});

describe("station kernel transitions", () => {
  it("advances forward, reworks from either judging stage, and refuses the rest", () => {
    const kernel = kernelFor();

    expect(kernel.advance("triage", "plan", 1)).toBe("plan");
    expect(kernel.advance("verify", "isolated_review", 1)).toBe("isolated_review");
    expect(kernel.advance("verify", "implement", 1)).toBe("implement");
    expect(kernel.advance("isolated_review", "implement", 2)).toBe("implement");

    expect(() => kernel.advance("implement", "publish_approval", 1)).toThrow(/transition/i);
    expect(() => kernel.advance("verify", "implement", 3)).toThrow(/exhausted/i);
    expect(() => kernel.advance("isolated_review", "implement", 3)).toThrow(/exhausted/i);
  });
});

describe("station kernel failure and cancellation", () => {
  const activeRun = [
    stored("run.created", { run: runEntity(RUN_ID) }, RUN_ID, 1),
    stored("run.transitioned", transitioned(RUN_ID, "queued", "triaging"), RUN_ID, 2)
  ];

  it("commits a deterministic failure instead of rethrowing it", async () => {
    const leased = job();
    const kernel = kernelFor({ readRunEvents: async () => activeRun }, leased);

    const outcome = await kernel.failDeterministically(leased, {
      code: "invalid_input",
      name: "ZodError",
      message: "The triage result is malformed.",
      retryable: false
    });

    expect(outcome.jobs).toEqual([]);
    expect(outcome.appends).toHaveLength(1);
    expect(outcome.appends[0]?.expectedVersion).toBe(2);
    expect(outcome.appends[0]?.events.map((event) => event.type)).toEqual([
      "stage.failed",
      "run.transitioned"
    ]);
    expect(outcome.appends[0]?.events[1]?.payload).toMatchObject({
      from: "triaging",
      to: "failed"
    });
  });

  it("raises a retryable failure instead of committing a terminal run", async () => {
    const leased = job();
    const kernel = kernelFor({ readRunEvents: async () => activeRun }, leased);

    await expect(
      kernel.failDeterministically(leased, {
        code: "rate_limited",
        name: "ModelRoutingError",
        message: "The provider is rate limited.",
        retryable: true
      })
    ).rejects.toBeInstanceOf(RetryableJobError);
  });

  it("refuses to fail a run the event stream never recorded, or a foreign workspace", async () => {
    const leased = job();
    const failure = {
      code: "invalid_input",
      name: "ZodError",
      message: "The triage result is malformed.",
      retryable: false
    };

    await expect(kernelFor({}, leased).failDeterministically(leased, failure)).rejects.toThrow(
      /recorded/i
    );
    expect(() =>
      kernelFor({
        workspaceId: WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174014")
      })
    ).toThrow(/workspace/i);
  });

  it("abandons an aborted stage without producing any commit", async () => {
    const abort = new AbortController();
    const leased = job();
    const kernel = kernelFor({ signal: abort.signal }, leased);
    const commits: StreamAppend[] = [];

    expect(() => kernel.checkpoint()).not.toThrow();
    abort.abort();
    const station = async (): Promise<void> => {
      const events = kernel.openStage(leased);
      kernel.checkpoint();
      commits.push(kernel.appendFor(2, events));
    };

    await expect(station()).rejects.toBeInstanceOf(StageAbandoned);
    expect(commits).toEqual([]);
  });

  // The natural station shape is `catch (error) { failDeterministically(job, classify(error)) }`,
  // and `classifyStageFailure` has no case for `StageAbandoned` — it classifies as
  // `unknown_error`/non-retryable. Without a guard that path commits `run.transitioned -> failed`
  // on a lease that was told to stop, marking a run permanently failed where lease expiry should
  // have recovered it. Abandonment outranks failure.
  it("refuses to commit a terminal failure on an aborted lease", async () => {
    const abort = new AbortController();
    const leased = job();
    const kernel = kernelFor({ signal: abort.signal }, leased);
    abort.abort();

    await expect(
      kernel.failDeterministically(leased, {
        code: "unknown_error",
        name: "UnknownError",
        message: "An unrecognized failure occurred.",
        retryable: false
      })
    ).rejects.toBeInstanceOf(StageAbandoned);
  });

  it("stamps the version read at lease head so a concurrent writer conflicts", async () => {
    const leased = job();
    const kernel = kernelFor({}, leased);
    const append = kernel.appendFor(2, kernel.openStage(leased));
    const store = async (candidate: StreamAppend): Promise<void> => {
      if (candidate.expectedVersion !== 4) {
        throw new OptimisticConcurrencyError(RUN_ID, candidate.expectedVersion, 4);
      }
    };

    expect(append).toMatchObject({ stream: { kind: "run", id: RUN_ID }, expectedVersion: 2 });
    await expect(store(append)).rejects.toBeInstanceOf(OptimisticConcurrencyError);
    await store(append).catch((error: unknown) => {
      expect(classifyStageFailure(error)).toMatchObject({
        code: "version_conflict",
        retryable: true
      });
    });
  });
});

describe("pipeline run state", () => {
  it("reconstructs a mid-pipeline run and ignores every other run", async () => {
    const evidence = await kernelFor().buildEvidence({
      stage: "triage",
      artifactIds: [],
      summary: "Triaged.",
      triageReportDigest: await digestTriageReport(triageReport)
    });
    const approval = {
      schemaVersion: 1,
      id: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "plan",
      status: "pending",
      evidenceDigest: digestOf("2"),
      eligibleApproverIds: ["local-user"],
      createdAt: NOW,
      updatedAt: NOW
    };
    const clarification = {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workItemId: WORK_ITEM_ID,
      runId: RUN_ID,
      clarificationRef: "which-branch",
      stage: "triage",
      question: "Which branch should this target?",
      evidenceDigest: digestOf("1"),
      requestedAt: NOW
    };
    const state = readPipelineState(
      [
        stored("run.created", { run: runEntity(RUN_ID) }, RUN_ID, 1),
        stored("run.created", { run: runEntity(OTHER_RUN_ID) }, OTHER_RUN_ID, 1),
        stored("run.transitioned", transitioned(RUN_ID, "queued", "triaging"), RUN_ID, 2),
        stored(
          "pipeline.evidence_recorded",
          {
            runId: RUN_ID,
            jobId: JOB_ID,
            attempt: 1,
            evidence,
            document: { kind: "triage", report: triageReport }
          },
          RUN_ID,
          3
        ),
        stored("clarification.requested", { runId: RUN_ID, request: clarification }, RUN_ID, 4),
        stored(
          "clarification.answered",
          {
            runId: RUN_ID,
            response: {
              schemaVersion: 1,
              idempotencyKey: "answer-1",
              runId: RUN_ID,
              clarificationRef: "which-branch",
              answer: "main",
              origin: "desktop",
              actorId: "local-user",
              answeredAt: NOW
            }
          },
          RUN_ID,
          5
        ),
        stored("approval.requested", { approval }, RUN_ID, 6),
        stored(
          "approval.decided",
          {
            approvalId: APPROVAL_ID,
            runId: RUN_ID,
            decision: "approved",
            evidenceDigest: digestOf("2"),
            origin: "desktop",
            decidedAt: NOW
          },
          RUN_ID,
          7
        ),
        stored(
          "run.steered",
          {
            runId: RUN_ID,
            instruction: "Prefer the smaller diff.",
            origin: "desktop",
            actorId: "local-user",
            acceptedAt: NOW
          },
          RUN_ID,
          8
        ),
        stored("run.transitioned", transitioned(RUN_ID, "triaging", "planning"), RUN_ID, 9),
        stored(
          "run.transitioned",
          transitioned(OTHER_RUN_ID, "queued", "triaging"),
          OTHER_RUN_ID,
          2
        )
      ],
      RUN_ID
    );

    expect(state.run?.status).toBe("planning");
    expect(state.streamVersion).toBe(9);
    expect(state.priorEvidence).toEqual([evidence]);
    expect(state.documents).toEqual([{ kind: "triage", report: triageReport }]);
    expect(state.approvals.map((entry) => entry.status)).toEqual(["approved"]);
    expect(state.clarifications).toEqual([
      { request: clarification, response: expect.objectContaining({ answer: "main" }) }
    ]);
    expect(state.steers.map((steer) => steer.instruction)).toEqual(["Prefer the smaller diff."]);
    expect(state.permissions).toEqual([]);
    expect(state.cancelRequested).toBe(false);
  });

  it("folds the agent permission round trips a station has to answer", () => {
    const relayed = (
      sequence: number,
      event: Record<string, unknown>
    ): Record<string, unknown> => ({
      runId: RUN_ID,
      stage: "implement",
      agentSessionId: SESSION_ID,
      sequence,
      event: { schemaVersion: 1, sessionId: SESSION_ID, sequence, occurredAt: NOW, ...event }
    });
    const state = readPipelineState(
      [
        stored("run.created", { run: runEntity(RUN_ID) }, RUN_ID, 1),
        stored(
          "agent.session_event",
          relayed(1, {
            type: "permission_requested",
            permissionRef: "write-src",
            summary: "Write packages/workflow/src.",
            evidenceDigest: digestOf("e")
          }),
          RUN_ID,
          2
        ),
        stored(
          "agent.session_event",
          relayed(2, {
            type: "permission_resolved",
            permissionRef: "write-src",
            selectedOptionId: "allow-once"
          }),
          RUN_ID,
          3
        )
      ],
      RUN_ID
    );

    expect(state.permissions).toEqual([
      {
        agentSessionId: SESSION_ID,
        permissionRef: "write-src",
        summary: "Write packages/workflow/src.",
        evidenceDigest: digestOf("e"),
        selectedOptionId: "allow-once"
      }
    ]);
  });

  it("reports a requested cancellation and an empty stream", () => {
    const state = readPipelineState(
      [
        stored("run.created", { run: runEntity(RUN_ID) }, RUN_ID, 1),
        stored("run.transitioned", transitioned(RUN_ID, "queued", "cancelling"), RUN_ID, 2)
      ],
      RUN_ID
    );

    expect(state.cancelRequested).toBe(true);
    expect(readPipelineState([], RUN_ID)).toMatchObject({ run: undefined, streamVersion: 0 });
  });
});

describe("station kernel output under run stream coherence", () => {
  it("survives coherence for a stage that carries its own document", async () => {
    const kernel = kernelFor();
    const triage = await kernel.buildEvidence({
      stage: "triage",
      artifactIds: [],
      summary: "Triaged.",
      triageReportDigest: await digestTriageReport(triageReport)
    });
    const plan = await kernel.buildEvidence({
      stage: "plan",
      artifactIds: [],
      planDigest: digestOf("a")
    });

    await expect(
      validateRunStreamCoherence([
        evidenceEvent(triage, 1, { kind: "triage", report: triageReport }),
        evidenceEvent(plan, 1)
      ])
    ).resolves.toHaveLength(2);
  });

  it("refuses a document whose kind or run is not the envelope's", async () => {
    const kernel = kernelFor();
    const plan = await kernel.buildEvidence({
      stage: "plan",
      artifactIds: [],
      planDigest: digestOf("a")
    });
    const triage = await kernel.buildEvidence({
      stage: "triage",
      artifactIds: [],
      summary: "Triaged."
    });

    await expect(
      validateRunStreamCoherence([evidenceEvent(plan, 1, { kind: "triage", report: triageReport })])
    ).rejects.toThrow(/stage/i);

    await expect(
      validateRunStreamCoherence([
        evidenceEvent(triage, 1, {
          kind: "triage",
          report: { ...triageReport, runId: OTHER_RUN_ID }
        })
      ])
    ).rejects.toThrow(/different run/i);
  });

  it("refuses an envelope built for a different run than the event records", async () => {
    const foreign = await kernelFor({}, job({ runId: OTHER_RUN_ID })).buildEvidence({
      stage: "triage",
      artifactIds: [],
      summary: "Triaged."
    });

    await expect(validateRunStreamCoherence([evidenceEvent(foreign, 1)])).rejects.toThrow(
      /different run/i
    );
  });

  it("admits rework only after a judgement that failed", async () => {
    const kernel = kernelFor();
    const implementation = await kernel.buildEvidence(implementDraft);
    const verification = async (status: "passed" | "failed") =>
      kernel.buildEvidence({
        stage: "verify",
        artifactIds: [],
        implementationEvidenceDigest: digestOf("3"),
        status
      });

    await expect(
      validateRunStreamCoherence([
        evidenceEvent(await verification("failed"), 1),
        evidenceEvent(implementation, 2)
      ])
    ).resolves.toHaveLength(2);

    await expect(
      validateRunStreamCoherence([
        evidenceEvent(await verification("passed"), 1),
        evidenceEvent(implementation, 2)
      ])
    ).rejects.toThrow(/failed judgement/i);

    await expect(
      validateRunStreamCoherence([
        evidenceEvent(await kernel.buildEvidence(reviewDraft("approved")), 1),
        evidenceEvent(implementation, 2)
      ])
    ).rejects.toThrow(/failed judgement/i);

    await expect(
      validateRunStreamCoherence([
        evidenceEvent(await kernel.buildEvidence(reviewDraft("changes_requested")), 1),
        evidenceEvent(implementation, 2)
      ])
    ).resolves.toHaveLength(2);
  });
});
