import {
  AgentSessionIdSchema,
  ApprovalSchema,
  EnvironmentAuthorizationIdSchema,
  EnvironmentAuthorizationSchema,
  EnvironmentIdSchema,
  JobIdSchema,
  PipelineEvidenceSchema,
  RunIdSchema,
  StoredDomainEventSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  createIdFactory,
  digestExecutionScope,
  digestEnvironmentAuthorization,
  digestPlanDocument,
  digestPublishScope,
  digestVersionedValue,
  type Actor,
  type Approval,
  type EnvironmentAuthorization,
  type PendingDomainEvent,
  type PipelineEvidence,
  type RepositoryInspection,
  type StoredDomainEvent,
  type VerificationCommand
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
  StageAbandoned,
  type StationDependencies,
  type WorkflowHandlerResult
} from "../../src/index.js";
import {
  buildExecutionScope,
  executionBranchForRun,
  executionEnvironmentForRun,
  type ProjectExecutionConfiguration
} from "../../src/stations/execution-scope.js";
import { runPublishStation } from "../../src/stations/publish-station.js";

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
const REPOSITORY_FULL_NAME = "org/parser";
const ENVIRONMENT_ID = executionEnvironmentForRun(RUN_ID);
const IMPLEMENTER_SESSION_ID = AgentSessionIdSchema.parse("agt_123e4567-e89b-42d3-a456-426614174040");
const REVIEWER_SESSION_ID = AgentSessionIdSchema.parse("agt_123e4567-e89b-42d3-a456-426614174041");
const REVIEWER_ENVIRONMENT_ID = EnvironmentIdSchema.parse("env_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const BRANCH = executionBranchForRun(RUN_ID);

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
  eligibleApproverIds: ["local-user"],
  repositoryFullName: REPOSITORY_FULL_NAME
};

const VERIFICATION_COMMANDS: VerificationCommand[] = [
  {
    executable: "pnpm",
    args: ["--filter", "@autostack/parser", "test"],
    usesShell: false,
    required: true
  }
];

const unusedPort = (): never => {
  throw new Error("This port should not be called in this test.");
};

// ---------------------------------------------------------------------------
// Fixture helpers — full evidence chain
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
    digest: "0".repeat(64)
  };
  return EnvironmentAuthorizationSchema.parse({
    ...draft,
    digest: await digestEnvironmentAuthorization(draft)
  });
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

const buildPlanDocument = async () => {
  const body = {
    schemaVersion: 1 as const,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    summary: "Fix the parser regression.",
    acceptanceCriteria: ["Parsing an empty file yields an empty document."],
    affectedAreas: ["packages/parser/src/reader.ts"],
    risks: [] as { severity: "low" | "high" | "medium" | "critical" | "info"; summary: string }[],
    verificationCommands: VERIFICATION_COMMANDS,
    requiredPermissions: [] as { kind: "filesystem_write" | "network_egress" | "secret_access" | "destructive_action"; detail: string }[],
    requiredCredentialRefIds: [] as string[],
    producedAt: NOW
  };
  const planDigest = await digestPlanDocument({ ...body, planDigest: "0".repeat(64) });
  return { ...body, planDigest };
};

const buildPlanEvidence = async (): Promise<PipelineEvidence> => {
  const planDocument = await buildPlanDocument();
  const envelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    stage: "plan",
    artifactIds: [],
    planDigest: planDocument.planDigest,
    producedAt: NOW
  };
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const buildPlanApprovalEvidence = async (): Promise<PipelineEvidence> => {
  const planEvidence = await buildPlanEvidence();
  const envelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    stage: "plan_approval",
    artifactIds: [],
    approvalId: "apr_123e4567-e89b-42d3-a456-426614174030",
    decision: "approved",
    approvedEvidenceDigest: planEvidence.evidenceDigest,
    actorId: "local-user",
    producedAt: NOW
  };
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const buildImplementationEvidence = async (): Promise<PipelineEvidence> => {
  const planApprovalEvidence = await buildPlanApprovalEvidence();
  const envelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    stage: "implement",
    artifactIds: [],
    planApprovalEvidenceDigest: planApprovalEvidence.evidenceDigest,
    agentSessionId: IMPLEMENTER_SESSION_ID,
    environmentId: ENVIRONMENT_ID,
    sourceCommit: SOURCE_COMMIT,
    resultCommit: RESULT_COMMIT,
    finalDiffDigest: digestOf("d"),
    producedAt: NOW
  };
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const buildVerificationEvidence = async (): Promise<PipelineEvidence> => {
  const implementationEvidence = await buildImplementationEvidence();
  const envelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    stage: "verify",
    artifactIds: [],
    implementationEvidenceDigest: implementationEvidence.evidenceDigest,
    status: "passed",
    producedAt: NOW
  };
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const buildReviewEvidence = async (): Promise<PipelineEvidence> => {
  const implementationEvidence = await buildImplementationEvidence();
  const verificationEvidence = await buildVerificationEvidence();
  const envelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    stage: "isolated_review",
    artifactIds: [],
    implementationEvidenceDigest: implementationEvidence.evidenceDigest,
    verificationEvidenceDigest: verificationEvidence.evidenceDigest,
    reviewedDiffDigest: digestOf("d"),
    implementation: {
      agentSessionId: IMPLEMENTER_SESSION_ID,
      environmentId: ENVIRONMENT_ID
    },
    reviewer: {
      agentSessionId: REVIEWER_SESSION_ID,
      environmentId: REVIEWER_ENVIRONMENT_ID
    },
    verdict: "approved",
    findings: [],
    producedAt: NOW
  };
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const buildPublishScope = async () => {
  const body = {
    schemaVersion: 1 as const,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    repositoryFullName: REPOSITORY_FULL_NAME,
    base: "main",
    head: BRANCH,
    finalDiffDigest: digestOf("d"),
    action: "create_draft_pr" as const,
    scopeDigest: "0".repeat(64),
    createdAt: NOW
  };
  const scopeDigest = await digestPublishScope(body);
  return { ...body, scopeDigest };
};

const buildPublishApprovalEvidence = async (): Promise<PipelineEvidence> => {
  const reviewEvidence = await buildReviewEvidence();
  const publishScope = await buildPublishScope();
  const envelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    stage: "publish_approval",
    artifactIds: [],
    approvalId: "apr_123e4567-e89b-42d3-a456-426614174031",
    decision: "approved",
    approvedEvidenceDigest: publishScope.scopeDigest,
    reviewEvidenceDigest: reviewEvidence.evidenceDigest,
    publishScopeDigest: publishScope.scopeDigest,
    actorId: "local-user",
    producedAt: NOW
  };
  const evidenceDigest = await digestVersionedValue(PIPELINE_EVIDENCE_DIGEST_DOMAIN, envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
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

/**
 * Full event history for a run in "publishing" status.
 */
const publishingRun = async (): Promise<readonly StoredDomainEvent[]> => {
  const authorization = await buildAuthorization();
  const planEvidence = await buildPlanEvidence();
  const planApprovalEvidence = await buildPlanApprovalEvidence();
  const implementationEvidence = await buildImplementationEvidence();
  const verificationEvidence = await buildVerificationEvidence();
  const reviewEvidence = await buildReviewEvidence();
  const publishApprovalEvidence = await buildPublishApprovalEvidence();
  const approval = await buildApproval();
  const planDocument = await buildPlanDocument();
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
      { runId: RUN_ID, from: "queued", to: "triaging", reason: "Start." },
      { kind: "run", id: RUN_ID },
      2
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "triaging", to: "planning", reason: "Triage." },
      { kind: "run", id: RUN_ID },
      3
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "planning", to: "awaiting_plan_approval", reason: "Plan wait." },
      { kind: "run", id: RUN_ID },
      4
    ),
    stored("approval.requested", { approval }, { kind: "run", id: RUN_ID }, 5),
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
        evidence: planEvidence
      },
      { kind: "run", id: RUN_ID },
      7
    ),
    stored(
      "pipeline.evidence_recorded",
      {
        runId: RUN_ID,
        jobId: JOB_ID,
        attempt: 1,
        evidence: planApprovalEvidence,
        document: { kind: "plan", document: planDocument }
      },
      { kind: "run", id: RUN_ID },
      8
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
      9
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "awaiting_plan_approval", to: "provisioning", reason: "Approved." },
      { kind: "run", id: RUN_ID },
      10
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "provisioning", to: "implementing", reason: "Provisioned." },
      { kind: "run", id: RUN_ID },
      11
    ),
    stored(
      "pipeline.evidence_recorded",
      { runId: RUN_ID, jobId: JOB_ID, attempt: 1, evidence: implementationEvidence },
      { kind: "run", id: RUN_ID },
      12
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "implementing", to: "verifying", reason: "Implemented." },
      { kind: "run", id: RUN_ID },
      13
    ),
    stored(
      "pipeline.evidence_recorded",
      { runId: RUN_ID, jobId: JOB_ID, attempt: 1, evidence: verificationEvidence },
      { kind: "run", id: RUN_ID },
      14
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "verifying", to: "reviewing", reason: "Verified." },
      { kind: "run", id: RUN_ID },
      15
    ),
    stored(
      "pipeline.evidence_recorded",
      { runId: RUN_ID, jobId: JOB_ID, attempt: 1, evidence: reviewEvidence },
      { kind: "run", id: RUN_ID },
      16
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "reviewing", to: "awaiting_publish_approval", reason: "Reviewed." },
      { kind: "run", id: RUN_ID },
      17
    ),
    stored(
      "pipeline.evidence_recorded",
      {
        runId: RUN_ID,
        jobId: JOB_ID,
        attempt: 1,
        evidence: publishApprovalEvidence
      },
      { kind: "run", id: RUN_ID },
      18
    ),
    stored(
      "run.transitioned",
      { runId: RUN_ID, from: "awaiting_publish_approval", to: "publishing", reason: "Publish approved." },
      { kind: "run", id: RUN_ID },
      19
    )
  ];
};

const defaultHarnessScript: FakeHarnessScript = [
  { kind: "emit", event: { type: "started" } },
  { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
];

const job = (overrides: Partial<LeasedWorkflowJob> = {}): LeasedWorkflowJob => ({
  jobId: JOB_ID,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  stage: "publish",
  handler: "pipeline.publish",
  payload: {
    workItemId: WORK_ITEM_ID,
    pipelineStage: "draft_pr",
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

const runnerFor = (): RunnerProvider => ({
  capabilities: async () => unusedPort(),
  inspectRepository: async () => INSPECTION,
  prepareEnvironment: async () => unusedPort(),
  listEnvironments: async () => [],
  startCommand: async () => unusedPort(),
  readCommandEvents: () => unusedPort(),
  cancelCommand: async () => unusedPort(),
  readArtifactChunk: async () => unusedPort(),
  disposeEnvironment: async () => ({ environmentId: ENVIRONMENT_ID, disposed: true, replayed: false })
});

const dependencies = (overrides: Partial<StationDependencies> = {}): StationDependencies => ({
  now: () => NOW,
  random: () => 0.5,
  signal: new AbortController().signal,
  ids: createIdFactory(() => UUID),
  harness: createFakeAgentHarness({
    script: defaultHarnessScript,
    now: () => NOW,
    providerSessionRef: () => "provider-session"
  }),
  runner: runnerFor(),
  delivery: createFakeDeliveryIntegration({
    now: () => NOW,
    pullRequestNumber: () => 42,
    commentId: () => 1,
    providerEvidenceDigest: () => digestOf("d")
  }),
  readRunEvents: async () => publishingRun(),
  workspaceId: WORKSPACE_ID,
  actor: ACTOR,
  ...overrides
});

const runPublish = async (
  overrides: Partial<StationDependencies> = {},
  configuration: ProjectExecutionConfiguration = CONFIGURATION,
  leased: LeasedWorkflowJob = job()
): Promise<WorkflowHandlerResult> => {
  const injected = dependencies(overrides);
  return runPublishStation(
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

describe("publish station creates draft PR and completes", () => {
  it("transitions to completed and enqueues nothing after creating a draft PR", async () => {
    const result = await runPublish();

    const types = typesOf(result);
    expect(types).toContain("stage.queued");
    expect(types).toContain("stage.leased");
    expect(types).toContain("pipeline.evidence_recorded");
    expect(types).toContain("stage.succeeded");
    expect(types).toContain("run.transitioned");

    const transition = eventsOf(result).find((e) => e.type === "run.transitioned");
    expect(transition?.payload.to).toBe("completed");

    expect(result.jobs).toHaveLength(0);
  });

  it("emits DraftPr evidence with draft: true and a pullRequestUrl", async () => {
    const result = await runPublish();

    const evidenceEvent = eventsOf(result).find((e) => e.type === "pipeline.evidence_recorded");
    expect(evidenceEvent).toBeDefined();
    const evidence = evidenceEvent!.payload.evidence as Record<string, unknown>;
    expect(evidence.stage).toBe("draft_pr");
    expect(evidence.draft).toBe(true);
    expect(evidence.pullRequestUrl).toBeDefined();
    expect(evidence.pullRequestNumber).toBe(42);
  });
});

describe("publish station cancellation", () => {
  it("abandons on an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPublish({ signal: controller.signal })
    ).rejects.toThrow(StageAbandoned);
  });
});
