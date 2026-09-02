/**
 * Pipeline restart tests (Task 17 Step 3).
 *
 * Mid-stage restart: a handler is aborted mid-execution; after lease expiry a new
 * executor recovers the job, completes it without duplicate evidence.
 *
 * Mid-wait restart: the pipeline reaches a no-job wait state; after a full
 * composition rebuild, the external decision resumes the pipeline.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactDescriptorSchema,
  ArtifactIdSchema,
  PendingDomainEventSchema,
  PipelineEvidenceSchema,
  SourceAuthorizationPolicySchema,
  WorkspaceIdSchema,
  createIdFactory,
  digestExecutionScope,
  digestPublishScope,
  digestVersionedValue,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type CommandAccepted,
  type DeliveryIntegrationPort,
  type RunnerSubscriptionItem,
  type RepositoryInspection,
  type StoredDomainEvent,
  type VerificationCommand
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import {
  answerClarification,
  decidePipelineApproval,
  intakeWorkItem,
  PIPELINE_EVIDENCE_DIGEST_DOMAIN,
  transitionRun,
  type RunnerProvider
} from "@autostack/domain";
import {
  createFakeAgentHarness,
  createFakeDeliveryIntegration,
  type FakeHarnessScript
} from "@autostack/domain/testing";

import {
  HandlerRegistry,
  LocalWorkflowExecutor,
  type SanitizedWorkflowError
} from "../src/index.js";
import {
  registerPipelineStations,
  type ProjectExecutionConfiguration
} from "../src/stations/index.js";
import {
  buildExecutionScope,
  executionBranchForRun,
  executionEnvironmentForRun
} from "../src/stations/execution-scope.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = "2026-08-28T12:00:00.000Z";
const LATER = "2026-08-28T12:00:01.000Z";
const UUID_BASE = "aaa11111-bbbb-4ccc-8ddd-eeeeeeeeee";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_11111111-2222-4333-8444-555555555555");
const SOURCE_COMMIT = "3f7c1b9e5a2d4086bf13c9e7a5d20486fb91c3d7";
const RESULT_COMMIT = "9d8c7b6a5f4e3d2c1b0a99887766554433221100";
const REPOSITORY_IDENTITY = "git:/Users/dev/projects/parser";
const REPOSITORY_FULL_NAME = "org/parser";
const digestOf = (seed: string): string => seed.repeat(64).slice(0, 64);
const LEASE_DURATION_MS = 30_000;

const temporaryDirectories: string[] = [];
const temporaryDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-restart-"));
  temporaryDirectories.push(directory);
  return join(directory, "autostack.sqlite");
};

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

const AUTHORIZED_POLICY = SourceAuthorizationPolicySchema.parse({
  schemaVersion: 1,
  workspaceId: WORKSPACE_ID,
  authorizedRequesters: [{ source: "manual", externalId: "octocat" }],
  updatedAt: NOW
});

// ---------------------------------------------------------------------------
// Harness scripts (completing versions) — identical to happy-path scripts
// ---------------------------------------------------------------------------

const triageScript: FakeHarnessScript = [
  { kind: "emit", event: { type: "started" } },
  {
    kind: "emit",
    event: {
      type: "output",
      stream: "structured",
      text: JSON.stringify({
        taskType: "bug",
        priority: "normal",
        complexity: "small",
        actionable: true,
        rationale: "A reproducible parser regression with a failing input.",
        duplicates: []
      })
    }
  },
  { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
];

const triageClarificationScript: FakeHarnessScript = [
  { kind: "emit", event: { type: "started" } },
  {
    kind: "emit",
    event: {
      type: "output",
      stream: "structured",
      text: JSON.stringify({
        taskType: "bug",
        priority: "normal",
        complexity: "small",
        actionable: true,
        rationale: "Need to know which parser to fix.",
        duplicates: [],
        clarificationRef: "q1",
        question: "Which parser?"
      })
    }
  },
  { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
];

const planScript: FakeHarnessScript = [
  { kind: "emit", event: { type: "started" } },
  {
    kind: "emit",
    event: {
      type: "output",
      stream: "structured",
      text: JSON.stringify({
        summary: "Guard the empty-input path in the reader.",
        acceptanceCriteria: ["Parsing an empty file yields an empty document."],
        affectedAreas: ["packages/parser/src/reader.ts"],
        risks: [],
        verificationCommands: VERIFICATION_COMMANDS,
        requiredPermissions: [{ kind: "filesystem_write", detail: "Edit parser files." }],
        requiredCredentialRefIds: []
      })
    }
  },
  { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
];

const implementScript: FakeHarnessScript = [
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

const buildReviewScript = async (
  runId: string,
  planDigest: string,
  workItemId: string
): Promise<FakeHarnessScript> => {
  const report = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId,
    runId,
    planDigest,
    reviewedDiffDigest: digestOf("d"),
    verificationReportDigest: digestOf("a"),
    verdict: "approved" as const,
    summary: "All acceptance criteria met.",
    findings: [],
    producedAt: NOW
  };
  return [
    { kind: "emit", event: { type: "started" } },
    {
      kind: "emit",
      event: {
        type: "output",
        stream: "structured",
        text: JSON.stringify(report)
      }
    },
    { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
  ];
};

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

const createTestRunner = (runId: string): RunnerProvider => {
  const environmentId = executionEnvironmentForRun(runId as any);

  return {
    capabilities: async () => {
      throw new Error("Not used.");
    },
    inspectRepository: async () => INSPECTION,
    prepareEnvironment: async (request) => {
      const scope = buildExecutionScope({
        workspaceId: WORKSPACE_ID,
        runId: runId as any,
        environmentId,
        inspection: INSPECTION,
        configuration: CONFIGURATION,
        allowedCredentialRefIds: []
      });
      const scopeDigest = await digestExecutionScope(scope);
      const { digestEnvironmentAuthorization } = await import("@autostack/contracts");
      const draft = {
        id: request.authorization?.id ?? `envauth_${UUID_BASE}20`,
        approvalId: request.authorization?.approvalId ?? `apr_${UUID_BASE}30`,
        approvalEvidenceDigest: request.authorization?.approvalEvidenceDigest ?? scopeDigest,
        scope: request.authorization?.scope ?? scope,
        createdAt: request.authorization?.createdAt ?? NOW,
        expiresAt: request.authorization?.expiresAt ?? "2026-08-29T12:00:00.000Z",
        digest: "0".repeat(64)
      };
      const { EnvironmentAuthorizationSchema } = await import("@autostack/contracts");
      const authorization = EnvironmentAuthorizationSchema.parse({
        ...draft,
        digest: await digestEnvironmentAuthorization(draft)
      });
      return {
        environmentId,
        workspaceId: WORKSPACE_ID,
        runId: runId as any,
        repositoryIdentity: REPOSITORY_IDENTITY,
        sourceCommit: SOURCE_COMMIT,
        branch: executionBranchForRun(runId as any),
        authorization: request.authorization ?? authorization,
        state: "prepared" as const,
        preparedAt: NOW
      };
    },
    listEnvironments: async () => [],
    startCommand: async (request): Promise<CommandAccepted> => ({
      commandId: request.commandId,
      acceptedAt: NOW,
      replayed: false
    }),
    readCommandEvents: (request): AsyncIterable<RunnerSubscriptionItem> =>
      (async function* () {
        const baseEvent = {
          workspaceId: request.workspaceId,
          runId: request.runId,
          environmentId: request.environmentId,
          commandId: request.commandId,
          occurredAt: NOW
        };
        yield {
          type: "runner.event" as const,
          event: {
            type: "command.started" as const,
            ...baseEvent,
            sequence: 1,
            pty: true as const
          }
        };
        yield {
          type: "runner.event" as const,
          event: {
            type: "command.completed" as const,
            ...baseEvent,
            sequence: 2,
            exitCode: 0,
            signal: null,
            durationMs: 1500,
            cancelled: false,
            interrupted: false,
            transcript: ArtifactDescriptorSchema.parse({
              artifactId: ArtifactIdSchema.parse("art_11111111-2222-4333-8444-555555555560"),
              workspaceId: WORKSPACE_ID,
              runId: request.runId,
              commandId: request.commandId,
              kind: "command_transcript",
              mediaType: "text/plain",
              byteSize: 1024,
              digest: digestOf("0"),
              createdAt: NOW
            })
          }
        };
      })(),
    cancelCommand: async () => {
      throw new Error("Not used.");
    },
    readArtifactChunk: async () => {
      throw new Error("Not used.");
    },
    disposeEnvironment: async () => ({
      environmentId,
      disposed: true,
      replayed: false
    })
  };
};

// ---------------------------------------------------------------------------
// Blocking harness: yields `started`, then blocks on a deferred promise.
// Resolving the deferred ends the generator, which lets the station continue
// to a checkpoint that finds the signal aborted and throws StageAbandoned.
// ---------------------------------------------------------------------------

interface BlockingHarness {
  readonly harness: AgentHarnessPort;
  /** Resolve the block to allow the generator to finish. */
  readonly release: () => void;
}

const createBlockingHarness = (nowFn: () => string): BlockingHarness => {
  let resolveBlock: (() => void) | undefined;
  const descriptor = {
    schemaVersion: 1 as const,
    adapterId: "fake.agent-harness",
    kind: "native" as const,
    displayName: "Blocking Agent Harness",
    capabilities: { resume: true, steering: true, permissions: true, structuredPlans: true }
  };

  const harness: AgentHarnessPort = {
    descriptor,
    start: (request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent> => ({
      [Symbol.asyncIterator]() {
        let yieldedStarted = false;
        return {
          async next(): Promise<IteratorResult<AgentSessionStreamEvent>> {
            if (!yieldedStarted) {
              yieldedStarted = true;
              return {
                value: {
                  type: "started",
                  schemaVersion: 1,
                  sessionId: request.agentSessionId,
                  sequence: 1,
                  occurredAt: nowFn(),
                  providerSessionRef: "provider-session"
                } as AgentSessionStreamEvent,
                done: false
              };
            }
            // Block until released
            await new Promise<void>((resolve) => {
              resolveBlock = resolve;
            });
            return { value: undefined as any, done: true };
          },
          async return(): Promise<IteratorResult<AgentSessionStreamEvent>> {
            return { value: undefined as any, done: true };
          }
        };
      }
    }),
    resume: () => {
      throw new Error("Not supported in blocking harness.");
    },
    steer: async () => {
      throw new Error("Not supported in blocking harness.");
    },
    cancel: async () => {
      throw new Error("Not supported in blocking harness.");
    }
  };

  return {
    harness,
    release: () => resolveBlock?.()
  };
};

// ---------------------------------------------------------------------------
// Blocking runner: readCommandEvents blocks on a deferred promise
// ---------------------------------------------------------------------------

interface BlockingRunnerOverride {
  readonly runner: RunnerProvider;
  readonly release: () => void;
}

const createBlockingRunner = (baseRunner: RunnerProvider): BlockingRunnerOverride => {
  let resolveBlock: (() => void) | undefined;

  const runner: RunnerProvider = {
    ...baseRunner,
    readCommandEvents: (_request): AsyncIterable<RunnerSubscriptionItem> => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<RunnerSubscriptionItem>> {
            // Block until released — the verify station will wait here
            await new Promise<void>((resolve) => {
              resolveBlock = resolve;
            });
            return { value: undefined as any, done: true };
          },
          async return(): Promise<IteratorResult<RunnerSubscriptionItem>> {
            return { value: undefined as any, done: true };
          }
        };
      }
    })
  };

  return {
    runner,
    release: () => resolveBlock?.()
  };
};

// ---------------------------------------------------------------------------
// Blocking delivery: createDraftPullRequest blocks on a deferred promise
// ---------------------------------------------------------------------------

interface BlockingDeliveryOverride {
  readonly delivery: DeliveryIntegrationPort;
  readonly release: () => void;
}

const createBlockingDelivery = (
  base: DeliveryIntegrationPort
): BlockingDeliveryOverride => {
  let resolveBlock: (() => void) | undefined;

  const delivery: DeliveryIntegrationPort = {
    ...base,
    createDraftPullRequest: async (_request) => {
      // Block until released
      await new Promise<void>((resolve) => {
        resolveBlock = resolve;
      });
      // After release, throw so that failDeterministically catches it and
      // detects the abort. The station's catch checks signal.aborted first.
      throw new Error("Delivery was released after abort.");
    }
  };

  return {
    delivery,
    release: () => resolveBlock?.()
  };
};

// ---------------------------------------------------------------------------
// Switchable harness: wraps multiple harnesses; the active one is swapped
// by the test after each abort-and-retry.
// ---------------------------------------------------------------------------

interface SwitchableHarness {
  readonly port: AgentHarnessPort;
  setActive: (harness: AgentHarnessPort) => void;
}

const createSwitchableHarness = (initial: AgentHarnessPort): SwitchableHarness => {
  let active = initial;
  const port: AgentHarnessPort = {
    get descriptor() {
      return active.descriptor;
    },
    start: (request) => active.start(request),
    resume: (request) => active.resume(request),
    steer: async (request) => active.steer(request),
    cancel: async (request) => active.cancel(request)
  };
  return {
    port,
    setActive: (h: AgentHarnessPort) => {
      active = h;
    }
  };
};

// ---------------------------------------------------------------------------
// Shared infrastructure builder
// ---------------------------------------------------------------------------

interface TestInfra {
  store: SqliteDurableStore;
  idFactory: ReturnType<typeof createIdFactory>;
  nowValue: string;
  now: () => string;
  errors: SanitizedWorkflowError[];
  /** Commits the intake + queued->triaging transition, returns runId and workItemId. */
  seedRun: () => Promise<{ runId: string; workItemId: string }>;
}

const buildInfra = async (): Promise<TestInfra> => {
  const database = openDatabase({ filePath: await temporaryDatabasePath() });
  let idCounter = 0;
  const idFactory = createIdFactory(() => {
    idCounter++;
    const hex = idCounter.toString(16).padStart(12, "0");
    return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
  });
  let eventNumber = 0;
  let leaseNumber = 0;
  let nowValue = NOW;
  const now = () => nowValue;
  const store = new SqliteDurableStore(database, {
    eventId: () => {
      eventNumber++;
      const hex = eventNumber.toString(16).padStart(12, "0");
      return `evt_eeeeeeee-eeee-4eee-8eee-${hex}` as any;
    },
    leaseToken: () => `lease-${++leaseNumber}`,
    now
  });
  const errors: SanitizedWorkflowError[] = [];

  const seedRun = async (): Promise<{ runId: string; workItemId: string }> => {
    const intake = intakeWorkItem(
      {
        source: { kind: "manual", client: "cli" },
        title: "Fix the parser regression",
        description: "Parsing fails on an empty input file.",
        requester: { externalId: "octocat" },
        priority: "normal",
        labels: [],
        acceptanceContext: [],
        manualIdempotencyKey: "test-restart-pipeline"
      },
      {
        workspaceId: WORKSPACE_ID,
        actor: { kind: "system", id: "test" },
        correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001"
      },
      { now, ids: idFactory }
    );
    await store.commit({
      idempotency: intake.idempotency,
      appends: intake.appends,
      jobs: intake.jobs
    });

    const runId = intake.run.id;
    const workItemId = intake.workItem.id;

    const triagingTransition = transitionRun({
      run: intake.run,
      to: "triaging",
      reason: "Intake queued triage.",
      actor: { kind: "system", id: "test" },
      correlationId: runId.slice(runId.indexOf("_") + 1),
      occurredAt: now()
    });
    await store.commit({
      idempotency: {
        scope: `test:transition:${WORKSPACE_ID}`,
        key: `${runId}:triaging`
      },
      appends: [
        {
          stream: { kind: "run" as const, id: runId },
          expectedVersion: 1,
          events: triagingTransition.events
        }
      ],
      jobs: []
    });

    return { runId, workItemId };
  };

  return {
    store,
    idFactory,
    get nowValue() {
      return nowValue;
    },
    set nowValue(v: string) {
      nowValue = v;
    },
    now,
    errors,
    seedRun
  };
};

// ---------------------------------------------------------------------------
// Executor builder
// ---------------------------------------------------------------------------

const buildExecutor = (
  store: SqliteDurableStore,
  registry: HandlerRegistry,
  now: () => string,
  errors: SanitizedWorkflowError[],
  workerId = "worker-1"
): LocalWorkflowExecutor =>
  new LocalWorkflowExecutor({
    store,
    registry,
    workerId,
    now,
    leaseDurationMs: LEASE_DURATION_MS,
    pollIntervalMs: 100,
    retryAt: () => LATER,
    reportError: (error) => {
      errors.push(error);
    }
  });

// ---------------------------------------------------------------------------
// Pipeline driver helpers
// ---------------------------------------------------------------------------

/**
 * Rebuilds the current run state by replaying all run.transitioned events.
 */
const replayRunState = (events: readonly StoredDomainEvent[], runId: string) => {
  const runCreatedEvent = events.find(
    (e) => e.type === "run.created" && (e.payload as any).run.id === runId
  );
  if (!runCreatedEvent) throw new Error("run.created not found");
  let run = (runCreatedEvent.payload as any).run;
  for (const event of events) {
    if (event.type === "run.transitioned" && event.stream.id === runId) {
      run = transitionRun({
        run,
        to: (event.payload as any).to,
        reason: (event.payload as any).reason,
        actor: event.actor,
        correlationId: event.correlationId,
        occurredAt: event.occurredAt
      }).run;
    }
  }
  return run;
};

/**
 * Commits the plan approval and provisioning->implementing transition.
 * Returns the run in its post-approval state.
 */
const commitPlanApproval = async (
  infra: TestInfra,
  runId: string,
  _workItemId: string
): Promise<void> => {
  const { store, idFactory, now } = infra;
  const events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });

  const approvalEvent = events.find(
    (e) => e.type === "approval.requested" && (e.payload as any).approval.kind === "plan"
  );
  if (!approvalEvent) throw new Error("Plan approval event not found");
  const planApproval = (approvalEvent.payload as any).approval;

  const planEvidenceEvent = events.find(
    (e) =>
      e.type === "pipeline.evidence_recorded" &&
      (e.payload as any).evidence?.stage === "plan"
  );
  if (!planEvidenceEvent) throw new Error("Plan evidence event not found");
  const planEvidence = (planEvidenceEvent.payload as any).evidence;
  const planDocument = (planEvidenceEvent.payload as any).document?.document;

  const currentRun = replayRunState(events, runId);
  const environmentId = executionEnvironmentForRun(runId as any);
  const executionScope = buildExecutionScope({
    workspaceId: WORKSPACE_ID,
    runId: runId as any,
    environmentId,
    inspection: INSPECTION,
    configuration: CONFIGURATION,
    allowedCredentialRefIds: planDocument.requiredCredentialRefIds ?? []
  });

  const runStreamEvents = events.filter(
    (e) => e.stream.kind === "run" && e.stream.id === runId
  );
  const streamVersion = Math.max(...runStreamEvents.map((e) => e.streamVersion));

  const planDecision = await decidePipelineApproval(
    {
      approval: planApproval,
      decision: "approved",
      run: currentRun,
      streamVersion,
      planEvidence,
      planDocument,
      executionScope,
      actor: { kind: "user", id: "local-user" },
      origin: "desktop",
      correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000100"
    },
    { now, ids: idFactory }
  );

  await store.commit({
    idempotency: planDecision.idempotency,
    appends: planDecision.appends,
    jobs: planDecision.jobs
  });

  // provisioning -> implementing transition
  const runStreamAfterApproval = (
    await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 })
  ).filter((e) => e.stream.kind === "run" && e.stream.id === runId);
  const svAfterApproval = Math.max(...runStreamAfterApproval.map((e) => e.streamVersion));
  const implementingTransition = transitionRun({
    run: planDecision.run,
    to: "implementing",
    reason: "Environment provisioned.",
    actor: { kind: "system", id: "workflow" },
    correlationId: runId.slice(runId.indexOf("_") + 1),
    occurredAt: now()
  });
  await store.commit({
    idempotency: {
      scope: `test:transition:${WORKSPACE_ID}`,
      key: `${runId}:implementing`
    },
    appends: [
      {
        stream: { kind: "run" as const, id: runId },
        expectedVersion: svAfterApproval,
        events: implementingTransition.events
      }
    ],
    jobs: []
  });
};

/**
 * Commits publish approval events and a publish job.
 */
const commitPublishApproval = async (
  infra: TestInfra,
  runId: string,
  workItemId: string
): Promise<void> => {
  const { store, idFactory, now } = infra;
  const events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });

  const runAfterReview = replayRunState(events, runId);

  const reviewEvidenceEvent = events.find(
    (e) =>
      e.type === "pipeline.evidence_recorded" &&
      (e.payload as any).evidence?.stage === "isolated_review"
  );
  if (!reviewEvidenceEvent) throw new Error("Review evidence not found");

  const branch = executionBranchForRun(runId as any);
  const publishScopeBody = {
    schemaVersion: 1 as const,
    workspaceId: WORKSPACE_ID,
    workItemId,
    runId,
    repositoryFullName: REPOSITORY_FULL_NAME,
    base: "main",
    head: branch,
    finalDiffDigest: digestOf("d"),
    action: "create_draft_pr" as const,
    scopeDigest: "0".repeat(64),
    createdAt: now()
  };
  const publishScopeDigest = await digestPublishScope(publishScopeBody);
  const publishApprovalEnvelope = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId,
    runId,
    stage: "publish_approval",
    artifactIds: [],
    approvalId: `apr_${idFactory.approval().slice(4)}`,
    decision: "approved",
    approvedEvidenceDigest: publishScopeDigest,
    reviewEvidenceDigest: (reviewEvidenceEvent.payload as any).evidence.evidenceDigest,
    publishScopeDigest,
    actorId: "local-user",
    producedAt: now()
  };
  const publishApprovalEvidenceDigest = await digestVersionedValue(
    PIPELINE_EVIDENCE_DIGEST_DOMAIN,
    publishApprovalEnvelope
  );
  const publishApprovalEvidence = PipelineEvidenceSchema.parse({
    ...publishApprovalEnvelope,
    evidenceDigest: publishApprovalEvidenceDigest
  });

  const publishTransition = transitionRun({
    run: runAfterReview,
    to: "publishing",
    reason: "Publish approved.",
    actor: { kind: "user", id: "local-user" },
    correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000200",
    occurredAt: now()
  });

  const runStreamAfterReview = events.filter(
    (e) => e.stream.kind === "run" && e.stream.id === runId
  );
  const streamVersionAfterReview = Math.max(
    ...runStreamAfterReview.map((e) => e.streamVersion)
  );

  const publishJobId = idFactory.job();

  await store.commit({
    idempotency: {
      scope: `test:publish-approval:${WORKSPACE_ID}`,
      key: `${runId}:approved`
    },
    appends: [
      {
        stream: { kind: "run", id: runId },
        expectedVersion: streamVersionAfterReview,
        events: [
          PendingDomainEventSchema.parse({
            workspaceId: WORKSPACE_ID,
            actor: { kind: "user", id: "local-user" },
            correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000200",
            occurredAt: now(),
            type: "pipeline.evidence_recorded",
            payload: {
              runId,
              jobId: publishJobId,
              attempt: 1,
              evidence: publishApprovalEvidence
            }
          }),
          ...publishTransition.events
        ]
      }
    ],
    jobs: [
      {
        jobId: publishJobId,
        workspaceId: WORKSPACE_ID,
        runId: runId as any,
        stage: "publish",
        handler: "pipeline.publish",
        payload: {
          workItemId,
          pipelineStage: "draft_pr",
          attempt: 1,
          inputEvidenceDigests: [publishApprovalEvidenceDigest]
        },
        maxAttempts: 3,
        availableAt: now(),
        createdAt: now()
      }
    ]
  });
};

/**
 * Counts evidence events for a given stage.
 */
const countEvidenceForStage = (
  events: readonly StoredDomainEvent[],
  stage: string
): number =>
  events.filter(
    (e) =>
      e.type === "pipeline.evidence_recorded" &&
      (e.payload as any).evidence?.stage === stage
  ).length;

/**
 * Reads the plan digest from committed plan evidence.
 */
const readPlanDigest = (events: readonly StoredDomainEvent[]): string => {
  const planEvidenceEvent = events.find(
    (e) =>
      e.type === "pipeline.evidence_recorded" &&
      (e.payload as any).evidence?.stage === "plan"
  );
  if (!planEvidenceEvent) throw new Error("Plan evidence not found");
  return (planEvidenceEvent.payload as any).document?.document?.planDigest ??
    (planEvidenceEvent.payload as any).document?.report?.planDigest;
};

// ---------------------------------------------------------------------------
// Build a composition: registry + executor for a given infra and ports
// ---------------------------------------------------------------------------

interface Composition {
  executor: LocalWorkflowExecutor;
  registry: HandlerRegistry;
}

const buildComposition = (
  infra: TestInfra,
  runId: string,
  harness: AgentHarnessPort,
  runner: RunnerProvider,
  delivery: DeliveryIntegrationPort,
  workerId = "worker-1"
): Composition => {
  const readRunEvents = async () =>
    infra.store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });

  const registry = new HandlerRegistry();
  registerPipelineStations(registry, {
    dependencies: {
      now: infra.now,
      random: () => 0.5,
      ids: infra.idFactory,
      harness,
      runner,
      delivery,
      readRunEvents,
      workspaceId: WORKSPACE_ID,
      actor: { kind: "system", id: "workflow" },
      sourceAuthorizationPolicy: AUTHORIZED_POLICY
    },
    configuration: CONFIGURATION
  });

  const executor = buildExecutor(infra.store, registry, infra.now, infra.errors, workerId);
  return { executor, registry };
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("pipeline mid-stage restart", () => {
  // -----------------------------------------------------------------------
  // 1. Triage: mid-stage abort and recovery
  // -----------------------------------------------------------------------
  it("recovers triage after mid-stage abort", async () => {
    const infra = await buildInfra();
    const { store, now } = infra;
    const { runId, workItemId } = await infra.seedRun();

    const delivery = createFakeDeliveryIntegration({
      now,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });
    const runner = createTestRunner(runId);

    // --- Attempt 1: blocking harness ---
    const { harness: blockingH, release } = createBlockingHarness(now);
    const comp1 = buildComposition(infra, runId, blockingH, runner, delivery, "worker-a");

    // Start the cycle — the handler picks up the triage job and blocks inside the harness
    const cyclePromise = comp1.executor.runOnce();

    // Give the handler a microtask to enter the blocking await
    await new Promise((r) => setTimeout(r, 0));

    // Abort: stop the executor, then release the harness so the handler can unwind.
    // stop() aborts the signal and awaits the cycle; release() lets the generator
    // return done, so the handler continues, hits a checkpoint/failDeterministically
    // that detects signal.aborted, and throws StageAbandoned.
    const stopPromise = comp1.executor.stop({ abortCurrent: true });
    release();
    await stopPromise;
    const result1 = await cyclePromise;
    expect(result1).toBe("interrupted");

    // --- Advance clock past lease expiry ---
    (infra as any).nowValue = "2026-08-28T12:01:00.000Z";

    // --- Attempt 2: completing harness ---
    const completingH = createFakeAgentHarness({
      script: triageScript,
      now,
      providerSessionRef: () => "provider-session"
    });
    const comp2 = buildComposition(infra, runId, completingH, runner, delivery, "worker-b");
    const result2 = await comp2.executor.runOnce();
    expect(result2).toBe("completed");

    // Assertions: no duplicate evidence
    const finalEvents = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    expect(countEvidenceForStage(finalEvents, "triage")).toBe(1);
    const currentRun = replayRunState(finalEvents, runId);
    expect(currentRun.status).toBe("planning");

    await store.close();
  });

  // -----------------------------------------------------------------------
  // 2. Verify: mid-stage abort and recovery (runner-using station)
  // -----------------------------------------------------------------------
  it("recovers verify after mid-stage abort", async () => {
    const infra = await buildInfra();
    const { store, now } = infra;
    const { runId, workItemId } = await infra.seedRun();

    const delivery = createFakeDeliveryIntegration({
      now,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });
    const normalRunner = createTestRunner(runId);

    // Build a multi-session harness for triage, plan, implement (3 sessions)
    const harnessScripts = [triageScript, planScript, implementScript];
    const activeInners: AgentHarnessPort[] = harnessScripts.map((script) =>
      createFakeAgentHarness({ script, now, providerSessionRef: () => "provider-session" })
    );
    let sessionIndex = 0;
    const multiHarness: AgentHarnessPort = {
      descriptor: activeInners[0]!.descriptor,
      start: (request: AgentInvocationRequest) => {
        const idx = sessionIndex++;
        if (idx >= activeInners.length) {
          throw new Error(`Harness exhausted at session ${idx}`);
        }
        return activeInners[idx]!.start(request);
      },
      resume: () => {
        throw new Error("Not used");
      },
      steer: async () => {
        throw new Error("Not used");
      },
      cancel: async () => {
        throw new Error("Not used");
      }
    };

    // Drive through triage, plan, plan-approval, implement
    const comp0 = buildComposition(infra, runId, multiHarness, normalRunner, delivery);
    expect(await comp0.executor.runOnce()).toBe("completed"); // triage
    expect(await comp0.executor.runOnce()).toBe("completed"); // plan
    await commitPlanApproval(infra, runId, workItemId);
    expect(await comp0.executor.runOnce()).toBe("completed"); // implement

    // --- Attempt 1: blocking runner ---
    const { runner: blockingRunner, release } = createBlockingRunner(normalRunner);
    const comp1 = buildComposition(infra, runId, multiHarness, blockingRunner, delivery, "worker-a");
    const cyclePromise = comp1.executor.runOnce();
    await new Promise((r) => setTimeout(r, 0));

    const stopPromise = comp1.executor.stop({ abortCurrent: true });
    release();
    await stopPromise;
    const result1 = await cyclePromise;
    expect(result1).toBe("interrupted");

    // --- Advance clock past lease expiry ---
    (infra as any).nowValue = "2026-08-28T12:01:00.000Z";

    // --- Attempt 2: completing runner ---
    // Verify does NOT use the harness, so we just need a normal runner
    const comp2 = buildComposition(infra, runId, multiHarness, normalRunner, delivery, "worker-b");
    const result2 = await comp2.executor.runOnce();
    expect(result2).toBe("completed");

    // Assertions
    const finalEvents = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    expect(countEvidenceForStage(finalEvents, "verify")).toBe(1);
    const currentRun = replayRunState(finalEvents, runId);
    expect(currentRun.status).toBe("reviewing");

    await store.close();
  });

  // -----------------------------------------------------------------------
  // 3. Publish: mid-stage abort and recovery (delivery-using station)
  // -----------------------------------------------------------------------
  it("recovers publish after mid-stage abort", async () => {
    const infra = await buildInfra();
    const { store, now } = infra;
    const { runId, workItemId } = await infra.seedRun();

    const normalDelivery = createFakeDeliveryIntegration({
      now,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });
    const normalRunner = createTestRunner(runId);

    // Drive through all stages up to and including review
    const harnessScripts = [triageScript, planScript, implementScript];
    const activeInners: AgentHarnessPort[] = harnessScripts.map((script) =>
      createFakeAgentHarness({ script, now, providerSessionRef: () => "provider-session" })
    );
    let sessionIndex = 0;
    const multiHarness: AgentHarnessPort = {
      descriptor: activeInners[0]!.descriptor,
      start: (request: AgentInvocationRequest) => {
        const idx = sessionIndex++;
        if (idx >= activeInners.length) throw new Error(`Harness exhausted at session ${idx}`);
        return activeInners[idx]!.start(request);
      },
      resume: () => { throw new Error("Not used"); },
      steer: async () => { throw new Error("Not used"); },
      cancel: async () => { throw new Error("Not used"); }
    };

    const comp0 = buildComposition(infra, runId, multiHarness, normalRunner, normalDelivery);
    expect(await comp0.executor.runOnce()).toBe("completed"); // triage
    expect(await comp0.executor.runOnce()).toBe("completed"); // plan
    await commitPlanApproval(infra, runId, workItemId);
    expect(await comp0.executor.runOnce()).toBe("completed"); // implement
    expect(await comp0.executor.runOnce()).toBe("completed"); // verify

    // Add review script and run review
    const events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const planDigest = readPlanDigest(events);
    const reviewScriptBuilt = await buildReviewScript(runId, planDigest, workItemId);
    activeInners.push(
      createFakeAgentHarness({ script: reviewScriptBuilt, now, providerSessionRef: () => "provider-session" })
    );
    expect(await comp0.executor.runOnce()).toBe("completed"); // review

    // Commit publish approval
    await commitPublishApproval(infra, runId, workItemId);

    // --- Attempt 1: blocking delivery ---
    const { delivery: blockingDelivery, release } = createBlockingDelivery(normalDelivery);
    const comp1 = buildComposition(infra, runId, multiHarness, normalRunner, blockingDelivery, "worker-a");
    const cyclePromise = comp1.executor.runOnce();
    await new Promise((r) => setTimeout(r, 0));

    const stopPromise = comp1.executor.stop({ abortCurrent: true });
    release();
    await stopPromise;
    const result1 = await cyclePromise;
    expect(result1).toBe("interrupted");

    // --- Advance clock past lease expiry ---
    (infra as any).nowValue = "2026-08-28T12:01:00.000Z";

    // --- Attempt 2: completing delivery ---
    const comp2 = buildComposition(infra, runId, multiHarness, normalRunner, normalDelivery, "worker-b");
    const result2 = await comp2.executor.runOnce();
    expect(result2).toBe("completed");

    // Assertions
    const finalEvents = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    expect(countEvidenceForStage(finalEvents, "draft_pr")).toBe(1);
    const currentRun = replayRunState(finalEvents, runId);
    expect(currentRun.status).toBe("completed");
    expect(normalDelivery.pullRequests).toHaveLength(1);

    await store.close();
  });
});

describe("pipeline mid-wait restart", () => {
  // -----------------------------------------------------------------------
  // 7. Plan approval wait: pipeline rebuilds and resumes from plan approval
  // -----------------------------------------------------------------------
  it("resumes after plan approval wait and full composition rebuild", async () => {
    const infra = await buildInfra();
    const { store, now } = infra;
    const { runId, workItemId } = await infra.seedRun();

    const delivery = createFakeDeliveryIntegration({
      now,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });
    const runner = createTestRunner(runId);

    // Drive through triage and plan
    const triageH = createFakeAgentHarness({
      script: triageScript,
      now,
      providerSessionRef: () => "provider-session"
    });
    const planH = createFakeAgentHarness({
      script: planScript,
      now,
      providerSessionRef: () => "provider-session"
    });
    const activeInners: AgentHarnessPort[] = [triageH, planH];
    let sessionIndex = 0;
    const multiHarness: AgentHarnessPort = {
      descriptor: activeInners[0]!.descriptor,
      start: (request: AgentInvocationRequest) => {
        const idx = sessionIndex++;
        if (idx >= activeInners.length) throw new Error(`Harness exhausted at session ${idx}`);
        return activeInners[idx]!.start(request);
      },
      resume: () => { throw new Error("Not used"); },
      steer: async () => { throw new Error("Not used"); },
      cancel: async () => { throw new Error("Not used"); }
    };

    const comp1 = buildComposition(infra, runId, multiHarness, runner, delivery);
    expect(await comp1.executor.runOnce()).toBe("completed"); // triage
    expect(await comp1.executor.runOnce()).toBe("completed"); // plan

    // Assert run is awaiting_plan_approval with no queued jobs
    let events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    let currentRun = replayRunState(events, runId);
    expect(currentRun.status).toBe("awaiting_plan_approval");
    expect(await comp1.executor.runOnce()).toBe("idle"); // no jobs

    // Destroy old executor (simulate process restart)
    // Create new composition from the same database
    const implementH = createFakeAgentHarness({
      script: implementScript,
      now,
      providerSessionRef: () => "provider-session"
    });
    const newInners: AgentHarnessPort[] = [implementH];
    let newSessionIndex = 0;
    const newHarness: AgentHarnessPort = {
      descriptor: implementH.descriptor,
      start: (request: AgentInvocationRequest) => {
        const idx = newSessionIndex++;
        if (idx >= newInners.length) throw new Error(`New harness exhausted at session ${idx}`);
        return newInners[idx]!.start(request);
      },
      resume: () => { throw new Error("Not used"); },
      steer: async () => { throw new Error("Not used"); },
      cancel: async () => { throw new Error("Not used"); }
    };

    // Decide plan approval
    await commitPlanApproval(infra, runId, workItemId);

    // New executor runs implement
    const comp2 = buildComposition(infra, runId, newHarness, runner, delivery, "worker-2");
    expect(await comp2.executor.runOnce()).toBe("completed"); // implement

    // Verify pipeline progressed
    events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    currentRun = replayRunState(events, runId);
    expect(currentRun.status).toBe("verifying");

    await store.close();
  });

  // -----------------------------------------------------------------------
  // 8. Publish approval wait: pipeline rebuilds and resumes from publish approval
  // -----------------------------------------------------------------------
  it("resumes after publish approval wait and full composition rebuild", async () => {
    const infra = await buildInfra();
    const { store, now } = infra;
    const { runId, workItemId } = await infra.seedRun();

    const delivery = createFakeDeliveryIntegration({
      now,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });
    const runner = createTestRunner(runId);

    // Drive through triage -> plan -> plan-approval -> implement -> verify -> review
    const harnessScripts = [triageScript, planScript, implementScript];
    const activeInners: AgentHarnessPort[] = harnessScripts.map((script) =>
      createFakeAgentHarness({ script, now, providerSessionRef: () => "provider-session" })
    );
    let sessionIndex = 0;
    const multiHarness: AgentHarnessPort = {
      descriptor: activeInners[0]!.descriptor,
      start: (request: AgentInvocationRequest) => {
        const idx = sessionIndex++;
        if (idx >= activeInners.length) throw new Error(`Harness exhausted at session ${idx}`);
        return activeInners[idx]!.start(request);
      },
      resume: () => { throw new Error("Not used"); },
      steer: async () => { throw new Error("Not used"); },
      cancel: async () => { throw new Error("Not used"); }
    };

    const comp1 = buildComposition(infra, runId, multiHarness, runner, delivery);
    expect(await comp1.executor.runOnce()).toBe("completed"); // triage
    expect(await comp1.executor.runOnce()).toBe("completed"); // plan
    await commitPlanApproval(infra, runId, workItemId);
    expect(await comp1.executor.runOnce()).toBe("completed"); // implement
    expect(await comp1.executor.runOnce()).toBe("completed"); // verify

    // Add review script
    const events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const planDigest = readPlanDigest(events);
    const reviewScriptBuilt = await buildReviewScript(runId, planDigest, workItemId);
    activeInners.push(
      createFakeAgentHarness({ script: reviewScriptBuilt, now, providerSessionRef: () => "provider-session" })
    );
    expect(await comp1.executor.runOnce()).toBe("completed"); // review

    // Assert run is awaiting_publish_approval with no queued jobs
    let eventsAfterReview = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    let currentRun = replayRunState(eventsAfterReview, runId);
    expect(currentRun.status).toBe("awaiting_publish_approval");
    expect(await comp1.executor.runOnce()).toBe("idle"); // no jobs

    // Simulate process restart: new composition from same DB
    await commitPublishApproval(infra, runId, workItemId);

    // New delivery for the new composition
    const delivery2 = createFakeDeliveryIntegration({
      now,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });
    // New harness (publish doesn't use harness, but composition needs one)
    const stubHarness = createFakeAgentHarness({
      script: [{ kind: "emit", event: { type: "started" } }],
      now,
      providerSessionRef: () => "provider-session"
    });
    const comp2 = buildComposition(infra, runId, stubHarness, runner, delivery2, "worker-2");
    expect(await comp2.executor.runOnce()).toBe("completed"); // publish

    // Verify pipeline completed
    const finalEvents = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    currentRun = replayRunState(finalEvents, runId);
    expect(currentRun.status).toBe("completed");
    expect(delivery2.pullRequests).toHaveLength(1);

    await store.close();
  });

  // -----------------------------------------------------------------------
  // 9. Clarification wait: triage asks a question, user answers, pipeline resumes
  // -----------------------------------------------------------------------
  it("resumes after clarification answer and full composition rebuild", async () => {
    const infra = await buildInfra();
    const { store, now, idFactory } = infra;
    const { runId, workItemId } = await infra.seedRun();

    const delivery = createFakeDeliveryIntegration({
      now,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });
    const runner = createTestRunner(runId);

    // Triage with clarification script
    const clarH = createFakeAgentHarness({
      script: triageClarificationScript,
      now,
      providerSessionRef: () => "provider-session"
    });
    const comp1 = buildComposition(infra, runId, clarH, runner, delivery);
    expect(await comp1.executor.runOnce()).toBe("completed"); // triage -> needs_clarification

    // Assert run is needs_clarification with no queued jobs
    let events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    let currentRun = replayRunState(events, runId);
    expect(currentRun.status).toBe("needs_clarification");
    expect(await comp1.executor.runOnce()).toBe("idle"); // no jobs

    // Find the clarification request
    const clarificationEvent = events.find(
      (e) => e.type === "clarification.requested"
    );
    expect(clarificationEvent).toBeDefined();
    const clarRequest = (clarificationEvent!.payload as any).request;

    // Simulate process restart: answer the clarification
    const runStreamEvents = events.filter(
      (e) => e.stream.kind === "run" && e.stream.id === runId
    );
    const streamVersion = Math.max(...runStreamEvents.map((e) => e.streamVersion));

    const { ClarificationResponseSchema: ClarRespSchema } = await import("@autostack/contracts");
    const clarResponse = ClarRespSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `answer:${runId}:q1`,
      runId,
      clarificationRef: clarRequest.clarificationRef,
      answer: "The JSON parser in packages/parser/src/reader.ts",
      origin: "desktop",
      actorId: "local-user",
      answeredAt: now()
    });

    const answer = answerClarification(
      clarResponse,
      {
        run: currentRun,
        clarifications: [{ request: clarRequest }],
        streamVersion,
        actor: { kind: "user", id: "local-user" },
        correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000300"
      },
      { now, ids: idFactory }
    );

    await store.commit({
      idempotency: answer.idempotency,
      appends: answer.appends,
      jobs: answer.jobs
    });

    // New composition: triage re-runs with the normal (non-clarification) script
    const triageH2 = createFakeAgentHarness({
      script: triageScript,
      now,
      providerSessionRef: () => "provider-session"
    });
    const comp2 = buildComposition(infra, runId, triageH2, runner, delivery, "worker-2");
    expect(await comp2.executor.runOnce()).toBe("completed"); // triage re-run -> planning

    // Verify pipeline progressed
    events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    currentRun = replayRunState(events, runId);
    expect(currentRun.status).toBe("planning");

    await store.close();
  });

  // -----------------------------------------------------------------------
  // 10. Permission wait
  // -----------------------------------------------------------------------
  // Permission approval in this pipeline is handled in-session (during the
  // implement station's harness interaction), not as a run-level wait state.
  // There is no run status like "awaiting_permission" that parks the pipeline
  // with no queued jobs. The permission flow is between the harness adapter
  // and the executor, mediated by the AbortSignal and the harness's
  // await_permission script step. Testing mid-wait restart for permissions
  // would require mocking internal adapter-executor handshakes that don't
  // surface as durable pipeline state — a different kind of test than what
  // this suite covers.
});
