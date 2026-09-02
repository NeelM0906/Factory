/**
 * Pipeline end-to-end flow test (Task 17).
 *
 * Drives a work item from intake through all six delivery pipeline stages
 * (triage, plan, implement, verify, review, publish) to completion, proving
 * the full flow works when wired together through a real durable store and
 * executor.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactDescriptorSchema,
  ArtifactIdSchema,
  CommandIdSchema,
  SourceAuthorizationPolicySchema,
  WorkspaceIdSchema,
  createIdFactory,
  digestExecutionScope,
  digestPlanDocument,
  digestPublishScope,
  digestVersionedValue,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type CommandAccepted,
  type RunnerSubscriptionItem,
  type RepositoryInspection,
  type StoredDomainEvent,
  type VerificationCommand
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import {
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

const NOW = "2026-08-28T12:00:00.000Z";
const LATER = "2026-08-28T12:00:01.000Z";
const UUID_BASE = "aaa11111-bbbb-4ccc-8ddd-eeeeeeeeee";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_11111111-2222-4333-8444-555555555555");
const SOURCE_COMMIT = "3f7c1b9e5a2d4086bf13c9e7a5d20486fb91c3d7";
const RESULT_COMMIT = "9d8c7b6a5f4e3d2c1b0a99887766554433221100";
const REPOSITORY_IDENTITY = "git:/Users/dev/projects/parser";
const REPOSITORY_FULL_NAME = "org/parser";
const digestOf = (seed: string): string => seed.repeat(64).slice(0, 64);

const temporaryDirectories: string[] = [];
const temporaryDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-pipeline-"));
  temporaryDirectories.push(directory);
  return join(directory, "autostack.sqlite");
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

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
// Harness scripts — what each station's agent session returns
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

const verifyHarnessScript: FakeHarnessScript = [
  { kind: "emit", event: { type: "started" } },
  { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
];

const publishHarnessScript: FakeHarnessScript = [
  { kind: "emit", event: { type: "started" } },
  { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
];

// ---------------------------------------------------------------------------
// Multi-session harness: one harness that handles start() across stations
// ---------------------------------------------------------------------------

const createMultiSessionHarness = (
  scripts: readonly FakeHarnessScript[],
  now: () => string
): AgentHarnessPort => {
  let sessionIndex = 0;
  const inners: AgentHarnessPort[] = scripts.map((script) =>
    createFakeAgentHarness({ script, now, providerSessionRef: () => "provider-session" })
  );

  return {
    descriptor: inners[0]!.descriptor,
    start: (request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent> => {
      const index = sessionIndex++;
      if (index >= inners.length) {
        throw new Error(`Multi-session harness exhausted: no script for session ${index}.`);
      }
      return inners[index]!.start(request);
    },
    resume: (request) => {
      if (sessionIndex === 0) throw new Error("No session to resume.");
      return inners[sessionIndex - 1]!.resume(request);
    },
    steer: async (request) => {
      if (sessionIndex === 0) throw new Error("No session to steer.");
      return inners[sessionIndex - 1]!.steer(request);
    },
    cancel: async (request) => {
      if (sessionIndex === 0) throw new Error("No session to cancel.");
      return inners[sessionIndex - 1]!.cancel(request);
    }
  };
};

// ---------------------------------------------------------------------------
// Runner: supports inspectRepository, prepareEnvironment, startCommand,
// readCommandEvents, disposeEnvironment
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
// Review harness script: must return the review report as structured output.
// This is built dynamically because it needs digests from prior stages.
// ---------------------------------------------------------------------------

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
// Test
// ---------------------------------------------------------------------------

describe("pipeline end-to-end flow", () => {
  it("drives a work item from intake through all six stages to completed", async () => {
    // 1. Create store and executor infrastructure
    const database = openDatabase({ filePath: await temporaryDatabasePath() });
    let idCounter = 0;
    const idFactory = createIdFactory(() => {
      idCounter++;
      const hex = idCounter.toString(16).padStart(12, "0");
      return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
    });
    let eventNumber = 0;
    let leaseNumber = 0;
    const store = new SqliteDurableStore(database, {
      eventId: () => {
        eventNumber++;
        const hex = eventNumber.toString(16).padStart(12, "0");
        return `evt_eeeeeeee-eeee-4eee-8eee-${hex}` as any;
      },
      leaseToken: () => `lease-${++leaseNumber}`,
      now: () => NOW
    });

    const registry = new HandlerRegistry();

    // The readRunEvents port: reads ALL events from the store for this workspace.
    // Stations need both work_item and run stream events.
    const readRunEvents = async (): Promise<readonly StoredDomainEvent[]> =>
      store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });

    // We need to know the plan digest before building the review script.
    // We will build the review script lazily after the plan stage.
    let reviewScript: FakeHarnessScript | undefined;

    // Build a harness that delegates to different scripts for each session.
    // Stations will start sessions in order: triage, plan, implement, (verify uses runner),
    // review, (publish uses delivery).
    // The verify station does use the harness but with a simple script.
    // Only stations that call harness.start() consume a session:
    // triage, plan, implement, and review. Verify uses the runner
    // (commands), publish uses the delivery integration.
    const harnessScripts: FakeHarnessScript[] = [
      triageScript,    // session 0: triage
      planScript,      // session 1: plan
      implementScript, // session 2: implement
      // session 3: review - will be pushed before review runs
    ];

    // We need a harness that supports dynamic script addition.
    let sessionIndex = 0;
    const activeInners: AgentHarnessPort[] = [];

    const makeInner = (script: FakeHarnessScript): AgentHarnessPort =>
      createFakeAgentHarness({ script, now: () => NOW, providerSessionRef: () => "provider-session" });

    // Pre-create the first few
    for (const s of harnessScripts) {
      activeInners.push(makeInner(s));
    }

    const dynamicHarness: AgentHarnessPort = {
      descriptor: activeInners[0]!.descriptor,
      start: (request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent> => {
        const idx = sessionIndex++;
        if (idx >= activeInners.length) {
          throw new Error(`Harness exhausted at session ${idx}, only ${activeInners.length} scripts.`);
        }
        return activeInners[idx]!.start(request);
      },
      resume: (request) => {
        if (sessionIndex === 0) throw new Error("No session to resume.");
        return activeInners[sessionIndex - 1]!.resume(request);
      },
      steer: async (request) => {
        if (sessionIndex === 0) throw new Error("No session to steer.");
        return activeInners[sessionIndex - 1]!.steer(request);
      },
      cancel: async (request) => {
        if (sessionIndex === 0) throw new Error("No session to cancel.");
        return activeInners[sessionIndex - 1]!.cancel(request);
      }
    };

    const runner = createTestRunner("placeholder");
    const delivery = createFakeDeliveryIntegration({
      now: () => NOW,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });

    // 2. Register all six stations
    registerPipelineStations(registry, {
      dependencies: {
        now: () => NOW,
        random: () => 0.5,
        ids: idFactory,
        harness: dynamicHarness,
        runner: "placeholder" as any, // will be replaced per run
        delivery,
        readRunEvents,
        workspaceId: WORKSPACE_ID,
        actor: { kind: "system", id: "workflow" },
        sourceAuthorizationPolicy: AUTHORIZED_POLICY
      },
      configuration: CONFIGURATION
    });

    // 3. Intake work item: creates run + triage job
    const intake = intakeWorkItem(
      {
        source: { kind: "manual", client: "cli" },
        title: "Fix the parser regression",
        description: "Parsing fails on an empty input file.",
        requester: { externalId: "octocat" },
        priority: "normal",
        labels: [],
        acceptanceContext: [],
        manualIdempotencyKey: "test-e2e-pipeline"
      },
      {
        workspaceId: WORKSPACE_ID,
        actor: { kind: "system", id: "test" },
        correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001"
      },
      { now: () => NOW, ids: idFactory }
    );

    await store.commit({
      idempotency: intake.idempotency,
      appends: intake.appends,
      jobs: intake.jobs
    });

    const runId = intake.run.id;
    const workItemId = intake.workItem.id;

    // The control plane transitions queued -> triaging before the handler runs.
    // intakeWorkItem leaves the run in "queued"; we must add the transition.
    const triagingTransition = transitionRun({
      run: intake.run,
      to: "triaging",
      reason: "Intake queued triage.",
      actor: { kind: "system", id: "test" },
      correlationId: runId.slice(runId.indexOf("_") + 1),
      occurredAt: NOW
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


    // Now fix the runner to use the real run id
    const realRunner = createTestRunner(runId);

    // Re-register with the correct runner. We need to re-do this because
    // the runner was a placeholder. However, registerPipelineStations captures
    // the dependencies at registration time. We need the runner to be correct
    // from the start.
    //
    // Since the registry doesn't support re-registration, let's create a new
    // registry and executor.
    const registry2 = new HandlerRegistry();
    registerPipelineStations(registry2, {
      dependencies: {
        now: () => NOW,
        random: () => 0.5,
        ids: idFactory,
        harness: dynamicHarness,
        runner: realRunner,
        delivery,
        readRunEvents,
        workspaceId: WORKSPACE_ID,
        actor: { kind: "system", id: "workflow" },
        sourceAuthorizationPolicy: AUTHORIZED_POLICY
      },
      configuration: CONFIGURATION
    });

    const errors: SanitizedWorkflowError[] = [];
    const executor = new LocalWorkflowExecutor({
      store,
      registry: registry2,
      workerId: "worker-1",
      now: () => NOW,
      leaseDurationMs: 30_000,
      pollIntervalMs: 100,
      retryAt: () => LATER,
      reportError: (error) => {
        errors.push(error);
      }
    });

    // 4. Drive the pipeline

    // Stage 1: TRIAGE
    const triageResult = await executor.runOnce();
    if (triageResult === "failed") console.error("TRIAGE ERRORS:", JSON.stringify(errors, null, 2));
    expect(triageResult).toBe("completed");

    // Stage 2: PLAN
    const planResult = await executor.runOnce();
    expect(planResult).toBe("completed");

    // After plan: the run is in awaiting_plan_approval with no queued jobs.
    // We need to decide the plan approval.

    // Read events to find the approval and plan document
    const eventsAfterPlan = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const approvalEvent = eventsAfterPlan.find(
      (e) => e.type === "approval.requested" && (e.payload as any).approval.kind === "plan"
    );
    expect(approvalEvent).toBeDefined();

    const planApproval = (approvalEvent!.payload as any).approval;
    const planEvidenceEvent = eventsAfterPlan.find(
      (e) =>
        e.type === "pipeline.evidence_recorded" &&
        (e.payload as any).evidence?.stage === "plan"
    );
    expect(planEvidenceEvent).toBeDefined();
    const planEvidence = (planEvidenceEvent!.payload as any).evidence;
    const planDocument = (planEvidenceEvent!.payload as any).document?.document;
    expect(planDocument).toBeDefined();

    // Find the run.created event to get the run object
    const runCreatedEvent = eventsAfterPlan.find(
      (e) => e.type === "run.created" && (e.payload as any).run.id === runId
    );
    expect(runCreatedEvent).toBeDefined();

    // Reconstruct the current run state by replaying transitions
    let currentRun = (runCreatedEvent!.payload as any).run;
    for (const event of eventsAfterPlan) {
      if (event.type === "run.transitioned" && event.stream.id === runId) {
        currentRun = transitionRun({
          run: currentRun,
          to: (event.payload as any).to,
          reason: (event.payload as any).reason,
          actor: event.actor,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt
        }).run;
      }
    }

    // Build the execution scope for the plan approval decision
    const environmentId = executionEnvironmentForRun(runId);
    const executionScope = buildExecutionScope({
      workspaceId: WORKSPACE_ID,
      runId: runId as any,
      environmentId,
      inspection: INSPECTION,
      configuration: CONFIGURATION,
      allowedCredentialRefIds: planDocument.requiredCredentialRefIds ?? []
    });

    // Compute the run stream version
    const runStreamEvents = eventsAfterPlan.filter(
      (e) => e.stream.kind === "run" && e.stream.id === runId
    );
    const streamVersion = Math.max(...runStreamEvents.map((e) => e.streamVersion));

    // Decide the plan approval using the domain function
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
      {
        now: () => NOW,
        ids: idFactory
      }
    );

    // Commit the plan approval decision
    await store.commit({
      idempotency: planDecision.idempotency,
      appends: planDecision.appends,
      jobs: planDecision.jobs
    });

    // The control plane transitions provisioning -> implementing after the
    // environment is ready. The implement station expects this transition
    // to already exist in the run events.
    const runStreamAfterApproval = (await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 }))
      .filter((e) => e.stream.kind === "run" && e.stream.id === runId);
    const svAfterApproval = Math.max(...runStreamAfterApproval.map((e) => e.streamVersion));
    const implementingTransition = transitionRun({
      run: planDecision.run,
      to: "implementing",
      reason: "Environment provisioned.",
      actor: { kind: "system", id: "workflow" },
      correlationId: runId.slice(runId.indexOf("_") + 1),
      occurredAt: NOW
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

    // Stage 3: IMPLEMENT
    const implementResult = await executor.runOnce();
    if (implementResult === "failed") console.error("IMPLEMENT ERRORS:", JSON.stringify(errors, null, 2));
    expect(implementResult).toBe("completed");

    // Stage 4: VERIFY
    const verifyResult = await executor.runOnce();
    expect(verifyResult).toBe("completed");

    // Before review runs, we need to add the review script to the harness.
    // The review script needs the plan digest from the committed plan document.
    const planDigest = planDocument.planDigest;
    const reviewScriptBuilt = await buildReviewScript(runId, planDigest, workItemId);
    activeInners.push(makeInner(reviewScriptBuilt));

    // Stage 5: REVIEW
    const reviewResult = await executor.runOnce();
    if (reviewResult === "failed") console.error("REVIEW ERRORS:", JSON.stringify(errors, null, 2));
    expect(reviewResult).toBe("completed");

    // After review: run is in awaiting_publish_approval with no queued jobs.
    // We need to decide the publish approval and enqueue the publish job.

    // Read events to find the review evidence and build publish approval
    const eventsAfterReview = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });

    // Reconstruct current run state
    let runAfterReview = (runCreatedEvent!.payload as any).run;
    for (const event of eventsAfterReview) {
      if (event.type === "run.transitioned" && event.stream.id === runId) {
        runAfterReview = transitionRun({
          run: runAfterReview,
          to: (event.payload as any).to,
          reason: (event.payload as any).reason,
          actor: event.actor,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt
        }).run;
      }
    }
    // Debug: show all transitions
    const allTransitions = eventsAfterReview
      .filter((e) => e.type === "run.transitioned" && e.stream.id === runId)
      .map((e) => `${(e.payload as any).from} -> ${(e.payload as any).to}: ${(e.payload as any).reason}`);
    if (runAfterReview.status !== "awaiting_publish_approval") {
      console.error("RUN STATUS:", runAfterReview.status, "\nTRANSITIONS:", allTransitions);
    }
    expect(runAfterReview.status).toBe("awaiting_publish_approval");

    // Find the review evidence
    const reviewEvidenceEvent = eventsAfterReview.find(
      (e) =>
        e.type === "pipeline.evidence_recorded" &&
        (e.payload as any).evidence?.stage === "isolated_review"
    );
    expect(reviewEvidenceEvent).toBeDefined();

    // Build publish scope
    const branch = executionBranchForRun(runId as any);
    const publishScopeBody = {
      schemaVersion: 1 as const,
      workspaceId: WORKSPACE_ID,
      workItemId: workItemId,
      runId: runId,
      repositoryFullName: REPOSITORY_FULL_NAME,
      base: "main",
      head: branch,
      finalDiffDigest: digestOf("d"),
      action: "create_draft_pr" as const,
      scopeDigest: "0".repeat(64),
      createdAt: NOW
    };
    const publishScopeDigest = await digestPublishScope(publishScopeBody);
    const publishScope = { ...publishScopeBody, scopeDigest: publishScopeDigest };

    // Build publish approval evidence
    const publishApprovalEnvelope = {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workItemId: workItemId,
      runId: runId,
      stage: "publish_approval",
      artifactIds: [],
      approvalId: `apr_${idFactory.approval().slice(4)}`,
      decision: "approved",
      approvedEvidenceDigest: publishScopeDigest,
      reviewEvidenceDigest: (reviewEvidenceEvent!.payload as any).evidence.evidenceDigest,
      publishScopeDigest: publishScopeDigest,
      actorId: "local-user",
      producedAt: NOW
    };
    const publishApprovalEvidenceDigest = await digestVersionedValue(
      PIPELINE_EVIDENCE_DIGEST_DOMAIN,
      publishApprovalEnvelope
    );
    const { PipelineEvidenceSchema, PendingDomainEventSchema } = await import(
      "@autostack/contracts"
    );
    const publishApprovalEvidence = PipelineEvidenceSchema.parse({
      ...publishApprovalEnvelope,
      evidenceDigest: publishApprovalEvidenceDigest
    });

    // Build the transition event and publish job
    const publishTransition = transitionRun({
      run: runAfterReview,
      to: "publishing",
      reason: "Publish approved.",
      actor: { kind: "user", id: "local-user" },
      correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000200",
      occurredAt: NOW
    });

    // Get current stream version
    const runStreamAfterReview = eventsAfterReview.filter(
      (e) => e.stream.kind === "run" && e.stream.id === runId
    );
    const streamVersionAfterReview = Math.max(
      ...runStreamAfterReview.map((e) => e.streamVersion)
    );

    const publishJobId = idFactory.job();

    // Commit publish approval events and publish job
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
              occurredAt: NOW,
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
            workItemId: workItemId,
            pipelineStage: "draft_pr",
            attempt: 1,
            inputEvidenceDigests: [publishApprovalEvidenceDigest]
          },
          maxAttempts: 3,
          availableAt: NOW,
          createdAt: NOW
        }
      ]
    });

    // Publish does not use the harness — it uses the delivery integration.

    // Stage 6: PUBLISH
    const publishResult = await executor.runOnce();
    expect(publishResult).toBe("completed");

    // 5. Assert the run reached completed status
    const finalEvents = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    let finalRun = (runCreatedEvent!.payload as any).run;
    for (const event of finalEvents) {
      if (event.type === "run.transitioned" && event.stream.id === runId) {
        finalRun = transitionRun({
          run: finalRun,
          to: (event.payload as any).to,
          reason: (event.payload as any).reason,
          actor: event.actor,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt
        }).run;
      }
    }
    expect(finalRun.status).toBe("completed");

    // Verify no errors were reported
    expect(errors).toEqual([]);

    // Verify a draft PR was created
    expect(delivery.pullRequests).toHaveLength(1);
    expect(delivery.pullRequests[0]!.number).toBe(42);

    await store.close();
  });
});
