import {
  ApprovalSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentAuthorizationSchema,
  JobIdSchema,
  PipelineEvidenceSchema,
  RunIdSchema,
  StoredDomainEventSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  createIdFactory,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  digestVersionedValue,
  type Actor,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type Approval,
  type EnvironmentAuthorization,
  type PendingDomainEvent,
  type PipelineEvidence,
  type PrepareEnvironmentRequest,
  type RepositoryInspection,
  type StoredDomainEvent
} from "@autostack/contracts";
import {
  PIPELINE_EVIDENCE_DIGEST_DOMAIN,
  type LeasedWorkflowJob,
  type RunnerProvider
} from "@autostack/domain";
import {
  createFakeAgentHarness,
  createFakeDeliveryIntegration,
  type FakeHarnessScript
} from "@autostack/domain/testing";
import { describe, expect, it } from "vitest";

import {
  PipelineJobPayloadSchema,
  RetryableJobError,
  StageAbandoned,
  type StationDependencies,
  type WorkflowHandlerResult
} from "../../src/index.js";
import {
  buildExecutionScope,
  executionEnvironmentForRun,
  type ProjectExecutionConfiguration
} from "../../src/stations/execution-scope.js";
import { runImplementStation } from "../../src/stations/implement-station.js";

const NOW = "2026-08-28T12:00:00.000Z";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174002";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174002");
const WORK_ITEM_ID = WorkItemIdSchema.parse("wi_123e4567-e89b-42d3-a456-426614174004");
const JOB_ID = JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174005");
const ACTOR: Actor = { kind: "system", id: "workflow" };
const digestOf = (seed: string): string => seed.repeat(64).slice(0, 64);

const SOURCE_COMMIT = "3f7c1b9e5a2d4086bf13c9e7a5d20486fb91c3d7";
const RESULT_COMMIT = "9d8c7b6a5f4e3d2c1b0a99887766554433221100";
const REPOSITORY_IDENTITY = "git:/Users/dev/projects/parser";
const PLACEHOLDER_DIGEST = "0".repeat(64);
const ENVIRONMENT_ID = executionEnvironmentForRun(RUN_ID);

const INSPECTION: RepositoryInspection = {
  repositoryIdentity: REPOSITORY_IDENTITY,
  canonicalSourcePath: "/Users/dev/projects/parser",
  repositoryCommonDirectory: "/Users/dev/projects/parser/.git",
  resolvedBaseRef: "refs/heads/main",
  sourceCommit: SOURCE_COMMIT,
  dirty: false,
  diagnostics: []
};

const CONFIGURATION: ProjectExecutionConfiguration = {
  inspection: { sourcePath: "/Users/dev/projects/parser", baseRef: "main" },
  cwdRoot: ".",
  resourceLimits: { cpu: 2, memoryMb: 4_096, durationSeconds: 900 },
  allowedPermissionKinds: ["filesystem_write", "network_egress"],
  allowedCredentialRefIds: [],
  eligibleApproverIds: ["local-user"]
};

const unusedPort = (): never => {
  throw new Error("This port should not be called in this test.");
};

// ---------------------------------------------------------------------------
// Fixtures: a run that has been approved and is ready to implement
// ---------------------------------------------------------------------------

const executionScope = () =>
  buildExecutionScope({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    environmentId: ENVIRONMENT_ID,
    inspection: INSPECTION,
    configuration: CONFIGURATION,
    allowedCredentialRefIds: []
  });

const buildAuthorization = async (): Promise<EnvironmentAuthorization> => {
  const scope = executionScope();
  const scopeDigest = await digestExecutionScope(scope);
  const draft = {
    id: EnvironmentAuthorizationIdSchema.parse("envauth_123e4567-e89b-42d3-a456-426614174020"),
    approvalId: "apr_123e4567-e89b-42d3-a456-426614174030",
    approvalEvidenceDigest: scopeDigest,
    scope,
    createdAt: NOW,
    expiresAt: "2026-08-29T12:00:00.000Z",
    digest: PLACEHOLDER_DIGEST
  };
  return EnvironmentAuthorizationSchema.parse({
    ...draft,
    digest: await digestEnvironmentAuthorization(draft)
  });
};

const buildPlanApprovalEvidence = async (): Promise<PipelineEvidence> => {
  const scope = executionScope();
  const scopeDigest = await digestExecutionScope(scope);
  const envelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    stage: "plan_approval",
    artifactIds: [],
    approvalId: "apr_123e4567-e89b-42d3-a456-426614174030",
    decision: "approved",
    approvedEvidenceDigest: scopeDigest,
    actorId: "local-user",
    producedAt: NOW
  };
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const buildApproval = async (): Promise<Approval> => {
  const scope = executionScope();
  return ApprovalSchema.parse({
    schemaVersion: 1,
    id: "apr_123e4567-e89b-42d3-a456-426614174030",
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    kind: "plan",
    status: "approved",
    evidenceDigest: await digestExecutionScope(scope),
    eligibleApproverIds: ["local-user"],
    decision: {
      decision: "approved",
      actor: { kind: "user", id: "local-user" },
      origin: "desktop",
      decidedAt: NOW
    },
    createdAt: NOW,
    updatedAt: NOW
  });
};

let sequence = 0;
const stored = (
  type: string,
  payload: Readonly<Record<string, unknown>>,
  stream: { readonly kind: string; readonly id: string },
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
    stream,
    streamVersion,
    globalSequence: sequence,
    schemaVersion: 1
  });
};

const implementingRun = async (): Promise<readonly StoredDomainEvent[]> => {
  const authorization = await buildAuthorization();
  const planApprovalEvidence = await buildPlanApprovalEvidence();
  const approval = await buildApproval();
  return [
    stored(
      "run.created",
      {
        run: {
          schemaVersion: 1,
          id: RUN_ID,
          workspaceId: WORKSPACE_ID,
          workItemId: WORK_ITEM_ID,
          workflowVersion: "foundation.v1",
          status: "queued",
          createdAt: NOW,
          updatedAt: NOW
        }
      },
      { kind: "run", id: RUN_ID },
      1
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "queued", to: "triaging", reason: "Intake queued triage." },
      { kind: "run", id: RUN_ID },
      2
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "triaging", to: "planning", reason: "Triage found it actionable." },
      { kind: "run", id: RUN_ID },
      3
    ),
    stored(
      "run.transitioned",
      {
        runId: RUN_ID,
        from: "planning",
        to: "awaiting_plan_approval",
        reason: "The plan is waiting on a human decision."
      },
      { kind: "run", id: RUN_ID },
      4
    ),
    stored(
      "approval.requested",
      { approval },
      { kind: "run", id: RUN_ID },
      5
    ),
    stored(
      "approval.decided",
      {
        approvalId: approval.id,
        runId: RUN_ID,
        decision: "approved",
        evidenceDigest: approval.evidenceDigest,
        origin: "desktop",
        decidedAt: NOW
      },
      { kind: "run", id: RUN_ID },
      6
    ),
    stored(
      "pipeline.evidence_recorded",
      {
        runId: RUN_ID,
        jobId: JOB_ID,
        attempt: 1,
        evidence: planApprovalEvidence
      },
      { kind: "run", id: RUN_ID },
      7
    ),
    stored(
      "environment.authorization_recorded",
      {
        runId: RUN_ID,
        environmentId: ENVIRONMENT_ID,
        authorization,
        phaseKey: `environment:${ENVIRONMENT_ID}:authorization`,
        phaseDigest: digestOf("a")
      },
      { kind: "run", id: RUN_ID },
      8
    ),
    stored(
      "run.transitioned",
      {
        runId: RUN_ID,
        from: "awaiting_plan_approval",
        to: "provisioning",
        reason: "A human approved the plan and its execution scope."
      },
      { kind: "run", id: RUN_ID },
      9
    ),
    stored(
      "run.transitioned",
      {
        runId: RUN_ID,
        from: "provisioning",
        to: "implementing",
        reason: "Environment provisioned."
      },
      { kind: "run", id: RUN_ID },
      10
    )
  ];
};

/**
 * A session script that starts, emits structured implementation output, and completes.
 * The structured output represents the agent's implementation result with commit info.
 */
const implementationScript: FakeHarnessScript = [
  { kind: "emit", event: { type: "started" } },
  {
    kind: "emit",
    event: {
      type: "output",
      stream: "structured",
      text: JSON.stringify({
        resultCommit: RESULT_COMMIT,
        finalDiffDigest: digestOf("d"),
        artifactIds: []
      })
    }
  },
  { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
];

interface RecordingRunner extends RunnerProvider {
  readonly prepareRequests: readonly PrepareEnvironmentRequest[];
}

const runnerFor = (
  authorization?: EnvironmentAuthorization
): RecordingRunner => {
  const prepareRequests: PrepareEnvironmentRequest[] = [];
  return {
    capabilities: async () => unusedPort(),
    inspectRepository: async () => INSPECTION,
    prepareEnvironment: async (request) => {
      prepareRequests.push(request);
      return {
        environmentId: ENVIRONMENT_ID,
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        repositoryIdentity: REPOSITORY_IDENTITY,
        sourceCommit: SOURCE_COMMIT,
        branch: `autostack/run/${RUN_ID.slice(RUN_ID.indexOf("_") + 1)}`,
        authorization: authorization ?? (await buildAuthorization()),
        state: "prepared" as const,
        preparedAt: NOW
      };
    },
    listEnvironments: async () => [],
    startCommand: async () => unusedPort(),
    readCommandEvents: () => unusedPort(),
    cancelCommand: async () => unusedPort(),
    readArtifactChunk: async () => unusedPort(),
    disposeEnvironment: async () => ({ environmentId: ENVIRONMENT_ID, disposed: true, replayed: false }),
    get prepareRequests() {
      return [...prepareRequests];
    }
  };
};

interface RecordingHarness extends AgentHarnessPort {
  readonly requests: readonly AgentInvocationRequest[];
}

const harnessFor = (script: FakeHarnessScript = implementationScript): RecordingHarness => {
  const inner = createFakeAgentHarness({
    script,
    now: () => NOW,
    providerSessionRef: () => "provider-session"
  });
  const requests: AgentInvocationRequest[] = [];
  return {
    descriptor: inner.descriptor,
    start: (request) => {
      requests.push(request);
      return inner.start(request);
    },
    resume: (request) => inner.resume(request),
    steer: (request) => inner.steer(request),
    cancel: (request) => inner.cancel(request),
    get requests() {
      return [...requests];
    }
  };
};

const job = (overrides: Partial<LeasedWorkflowJob> = {}): LeasedWorkflowJob => ({
  jobId: JOB_ID,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  stage: "implement",
  handler: "pipeline.implement",
  payload: {
    workItemId: WORK_ITEM_ID,
    pipelineStage: "implement",
    attempt: 1,
    inputEvidenceDigests: [digestOf("a")]
  },
  maxAttempts: 3,
  availableAt: NOW,
  createdAt: NOW,
  attempt: 1,
  leaseOwner: "worker-1",
  leaseToken: "lease-1",
  leaseExpiresAt: "2026-08-28T12:01:00.000Z",
  ...overrides
});

const dependencies = (overrides: Partial<StationDependencies> = {}): StationDependencies => ({
  now: () => NOW,
  random: () => 0.5,
  signal: new AbortController().signal,
  ids: createIdFactory(() => UUID),
  harness: harnessFor(),
  runner: runnerFor(),
  delivery: createFakeDeliveryIntegration({
    now: () => NOW,
    pullRequestNumber: () => 1,
    commentId: () => 1,
    providerEvidenceDigest: () => digestOf("d")
  }),
  readRunEvents: async () => implementingRun(),
  workspaceId: WORKSPACE_ID,
  actor: ACTOR,
  ...overrides
});

const runImplement = async (
  overrides: Partial<StationDependencies> = {},
  configuration: ProjectExecutionConfiguration = CONFIGURATION,
  leased: LeasedWorkflowJob = job()
): Promise<WorkflowHandlerResult> => {
  const injected = dependencies(overrides);
  return runImplementStation(
    PipelineJobPayloadSchema.parse(leased.payload),
    { job: leased, signal: injected.signal },
    injected,
    configuration
  );
};

const eventsOf = (result: WorkflowHandlerResult): readonly PendingDomainEvent[] =>
  result.appends[0]?.events ?? [];

const typesOf = (result: WorkflowHandlerResult): readonly string[] =>
  eventsOf(result).map((event) => event.type);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the implement station provisions and starts a session", () => {
  it("provisions through runner.prepareEnvironment using the recorded authorization", async () => {
    const runner = runnerFor();
    const result = await runImplement({ runner });

    // The station must call prepareEnvironment.
    expect(runner.prepareRequests.length).toBeGreaterThan(0);
    // It must use the environment id derived from the run, not a minted one.
    expect(runner.prepareRequests[0]!.environmentId).toBe(ENVIRONMENT_ID);
  });

  it("starts a harness session whose input contains the approved plan", async () => {
    const harness = harnessFor();
    const result = await runImplement({ harness });

    expect(harness.requests).toHaveLength(1);
    // The request must name the workspace and run from the job, not from model output.
    expect(harness.requests[0]!.workspaceId).toBe(WORKSPACE_ID);
    expect(harness.requests[0]!.runId).toBe(RUN_ID);
  });

  it("transitions to verifying and enqueues a verify job on success", async () => {
    const result = await runImplement();

    const types = typesOf(result);
    expect(types).toContain("stage.queued");
    expect(types).toContain("stage.leased");
    expect(types).toContain("pipeline.evidence_recorded");
    expect(types).toContain("stage.succeeded");
    expect(types).toContain("run.transitioned");

    // Check that the transition goes to verifying.
    const transition = eventsOf(result).find((e) => e.type === "run.transitioned");
    expect(transition?.payload.to).toBe("verifying");

    // Check that a verify job is enqueued.
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.handler).toBe("pipeline.verify");
    expect(result.jobs[0]!.stage).toBe("verify");
  });

  it("emits ImplementationEvidence binding the plan approval, commits, and diff", async () => {
    const result = await runImplement();

    const evidenceEvent = eventsOf(result).find((e) => e.type === "pipeline.evidence_recorded");
    expect(evidenceEvent).toBeDefined();
    const evidence = evidenceEvent!.payload.evidence as Record<string, unknown>;
    expect(evidence.stage).toBe("implement");
    expect(evidence.sourceCommit).toBe(SOURCE_COMMIT);
    expect(evidence.resultCommit).toBe(RESULT_COMMIT);
    expect(evidence.finalDiffDigest).toBe(digestOf("d"));
  });
});

describe("implement station cancellation", () => {
  it("abandons on an aborted signal without committing", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runImplement({ signal: controller.signal })
    ).rejects.toThrow(StageAbandoned);
  });
});

describe("implement station harness failure", () => {
  it("raises RetryableJobError on a transient harness failure", async () => {
    const failingScript: FakeHarnessScript = [
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: {
          type: "failed",
          code: "provider_rate_limited",
          message: "Transient network error",
          retryable: true
        }
      }
    ];
    const harness = harnessFor(failingScript);

    await expect(runImplement({ harness })).rejects.toThrow(RetryableJobError);
  });

  it("fails deterministically on a non-retryable harness failure", async () => {
    const failingScript: FakeHarnessScript = [
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: {
          type: "failed",
          code: "context_exceeded",
          message: "Model context exceeded",
          retryable: false
        }
      }
    ];
    const harness = harnessFor(failingScript);

    const result = await runImplement({ harness });

    // A deterministic failure transitions the run to failed.
    const types = typesOf(result);
    expect(types).toContain("stage.failed");
    expect(types).toContain("run.transitioned");
    const transition = eventsOf(result).find((e) => e.type === "run.transitioned");
    expect(transition?.payload.to).toBe("failed");
    expect(result.jobs).toEqual([]);
  });
});
