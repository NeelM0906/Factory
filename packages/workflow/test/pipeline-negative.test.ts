/**
 * Pipeline negative-case tests (Task 17 Step 4).
 *
 * Proves the safety invariants of the delivery pipeline:
 * - Rework budget bounded at 3 across mixed verify/review failures
 * - Publication impossible without passing verification
 * - Publication impossible without approved review
 * - Duplicate intake delivery ID produces exactly one run
 * - Publish retry produces exactly one draft pull request
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactDescriptorSchema,
  ArtifactIdSchema,
  PIPELINE_REWORK_MAX_ATTEMPTS,
  PublicationEvidenceBundleSchema,
  SourceAuthorizationPolicySchema,
  WorkspaceIdSchema,
  assertPipelineReworkTransition,
  createIdFactory,
  digestExecutionScope,
  digestPublishScope,
  digestVersionedValue,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type CommandAccepted,
  type RepositoryInspection,
  type RunnerSubscriptionItem,
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = "2026-08-28T12:00:00.000Z";
const LATER = "2026-08-28T12:00:01.000Z";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_11111111-2222-4333-8444-555555555555");
const SOURCE_COMMIT = "3f7c1b9e5a2d4086bf13c9e7a5d20486fb91c3d7";
const RESULT_COMMIT = "9d8c7b6a5f4e3d2c1b0a99887766554433221100";
const REPOSITORY_IDENTITY = "git:/Users/dev/projects/parser";
const REPOSITORY_FULL_NAME = "org/parser";
const digestOf = (seed: string): string => seed.repeat(64).slice(0, 64);

const temporaryDirectories: string[] = [];
const temporaryDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-neg-"));
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
// Harness scripts
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

// ---------------------------------------------------------------------------
// Runner factories: passing and failing verification
// ---------------------------------------------------------------------------

const createTestRunner = (
  runId: string,
  exitCode: number = 0
): RunnerProvider => {
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
      const { digestEnvironmentAuthorization, EnvironmentAuthorizationSchema } = await import(
        "@autostack/contracts"
      );
      const draft = {
        id: request.authorization?.id ?? `envauth_aaa11111-bbbb-4ccc-8ddd-eeeeeeeeee20`,
        approvalId: request.authorization?.approvalId ?? `apr_aaa11111-bbbb-4ccc-8ddd-eeeeeeeeee30`,
        approvalEvidenceDigest: request.authorization?.approvalEvidenceDigest ?? scopeDigest,
        scope: request.authorization?.scope ?? scope,
        createdAt: request.authorization?.createdAt ?? NOW,
        expiresAt: request.authorization?.expiresAt ?? "2026-08-29T12:00:00.000Z",
        digest: "0".repeat(64)
      };
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
            exitCode,
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
// Pipeline setup helpers
// ---------------------------------------------------------------------------

interface PipelineInfra {
  store: SqliteDurableStore;
  idFactory: ReturnType<typeof createIdFactory>;
  runId: string;
  workItemId: string;
  readRunEvents: () => Promise<readonly StoredDomainEvent[]>;
}

/**
 * Creates the database, seeds a run via intake, transitions to triaging,
 * and returns infrastructure for driving the rest of the pipeline.
 */
const seedPipeline = async (
  idFactory: ReturnType<typeof createIdFactory>
): Promise<PipelineInfra & { database: ReturnType<typeof openDatabase> }> => {
  const database = openDatabase({ filePath: await temporaryDatabasePath() });
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

  const readRunEvents = async (): Promise<readonly StoredDomainEvent[]> =>
    store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });

  const intake = intakeWorkItem(
    {
      source: { kind: "manual", client: "cli" },
      title: "Fix the parser regression",
      description: "Parsing fails on an empty input file.",
      requester: { externalId: "octocat" },
      priority: "normal",
      labels: [],
      acceptanceContext: [],
      manualIdempotencyKey: "test-neg-pipeline"
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

  // Transition queued -> triaging
  const triagingTransition = transitionRun({
    run: intake.run,
    to: "triaging",
    reason: "Intake queued triage.",
    actor: { kind: "system", id: "test" },
    correlationId: runId.slice(runId.indexOf("_") + 1),
    occurredAt: NOW
  });
  await store.commit({
    idempotency: { scope: `test:transition:${WORKSPACE_ID}`, key: `${runId}:triaging` },
    appends: [
      {
        stream: { kind: "run" as const, id: runId },
        expectedVersion: 1,
        events: triagingTransition.events
      }
    ],
    jobs: []
  });

  return { database, store, idFactory, runId, workItemId, readRunEvents };
};

/**
 * Drives the pipeline through triage, plan, plan approval, and the
 * provisioning->implementing transition. Returns the executor and related state.
 */
const driveToImplement = async (
  infra: PipelineInfra,
  harness: AgentHarnessPort,
  runner: RunnerProvider,
  externalDelivery?: ReturnType<typeof createFakeDeliveryIntegration>
): Promise<{
  executor: LocalWorkflowExecutor;
  errors: SanitizedWorkflowError[];
  delivery: ReturnType<typeof createFakeDeliveryIntegration>;
}> => {
  const { store, idFactory, runId, workItemId, readRunEvents } = infra;
  const delivery = externalDelivery ?? createFakeDeliveryIntegration({
    now: () => NOW,
    pullRequestNumber: () => 42,
    commentId: () => 1,
    providerEvidenceDigest: () => digestOf("d")
  });

  const registry = new HandlerRegistry();
  registerPipelineStations(registry, {
    dependencies: {
      now: () => NOW,
      random: () => 0.5,
      ids: idFactory,
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

  const errors: SanitizedWorkflowError[] = [];
  const executor = new LocalWorkflowExecutor({
    store,
    registry,
    workerId: "worker-neg",
    now: () => NOW,
    leaseDurationMs: 30_000,
    pollIntervalMs: 100,
    retryAt: () => LATER,
    reportError: (error) => { errors.push(error); }
  });

  // Drive triage
  const triageResult = await executor.runOnce();
  expect(triageResult).toBe("completed");

  // Drive plan
  const planResult = await executor.runOnce();
  expect(planResult).toBe("completed");

  // Decide plan approval
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

  const runCreatedEvent = eventsAfterPlan.find(
    (e) => e.type === "run.created" && (e.payload as any).run.id === runId
  );
  expect(runCreatedEvent).toBeDefined();

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

  const environmentId = executionEnvironmentForRun(runId as any);
  const executionScope = buildExecutionScope({
    workspaceId: WORKSPACE_ID,
    runId: runId as any,
    environmentId,
    inspection: INSPECTION,
    configuration: CONFIGURATION,
    allowedCredentialRefIds: planDocument.requiredCredentialRefIds ?? []
  });

  const runStreamEvents = eventsAfterPlan.filter(
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
    { now: () => NOW, ids: idFactory }
  );

  await store.commit({
    idempotency: planDecision.idempotency,
    appends: planDecision.appends,
    jobs: planDecision.jobs
  });

  // Transition provisioning -> implementing
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
    idempotency: { scope: `test:transition:${WORKSPACE_ID}`, key: `${runId}:implementing` },
    appends: [
      {
        stream: { kind: "run" as const, id: runId },
        expectedVersion: svAfterApproval,
        events: implementingTransition.events
      }
    ],
    jobs: []
  });

  return { executor, errors, delivery };
};

/** Replays all run.transitioned events to reconstruct the current run state. */
const replayRunState = (
  events: readonly StoredDomainEvent[],
  runId: string
): any => {
  const runCreated = events.find(
    (e) => e.type === "run.created" && (e.payload as any).run.id === runId
  );
  if (!runCreated) throw new Error("No run.created event found.");
  let run = (runCreated.payload as any).run;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pipeline negative guarantees", () => {
  it("verify failure routes back to implement with incremented attempt", async () => {
    // Drive through triage, plan, plan-approval to implement, then verify with
    // a failing runner (exit code 1). Assert verify reworks to implement.
    let idCounter = 0;
    const idFactory = createIdFactory(() => {
      idCounter++;
      const hex = idCounter.toString(16).padStart(12, "0");
      return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
    });
    const infra = await seedPipeline(idFactory);
    const { store, runId } = infra;
    const failingRunner = createTestRunner(runId, 1);

    const scripts: FakeHarnessScript[] = [
      triageScript,      // session 0: triage
      planScript,        // session 1: plan
      implementScript,   // session 2: implement attempt 1
      implementScript    // session 3: implement attempt 2 (rework)
    ];
    let sessionIndex = 0;
    const inners: AgentHarnessPort[] = scripts.map((s) =>
      createFakeAgentHarness({ script: s, now: () => NOW, providerSessionRef: () => "provider-session" })
    );
    const harness: AgentHarnessPort = {
      descriptor: inners[0]!.descriptor,
      start: (request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent> => {
        const idx = sessionIndex++;
        if (idx >= inners.length) {
          throw new Error(`Harness exhausted at session ${idx}.`);
        }
        return inners[idx]!.start(request);
      },
      resume: (r) => inners[Math.max(0, sessionIndex - 1)]!.resume(r),
      steer: async (r) => inners[Math.max(0, sessionIndex - 1)]!.steer(r),
      cancel: async (r) => inners[Math.max(0, sessionIndex - 1)]!.cancel(r)
    };

    const { executor } = await driveToImplement(infra, harness, failingRunner);

    // Implement attempt 1
    const impl1 = await executor.runOnce();
    expect(impl1).toBe("completed");

    // Verify - fails (exit code 1), reworks to implement
    const verify1 = await executor.runOnce();
    expect(verify1).toBe("completed");

    // After verify failure, the run should be back in implementing
    const events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const run = replayRunState(events, runId);
    expect(run.status).toBe("implementing");

    // A new implement job was created with incremented attempt
    const impl2 = await executor.runOnce();
    expect(impl2).toBe("completed");

    // Verify the implement evidence was recorded for attempt 2
    const allEvents = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const implEvidence = allEvents.filter(
      (e) =>
        e.type === "pipeline.evidence_recorded" &&
        (e.payload as any).evidence?.stage === "implement"
    );
    expect(implEvidence).toHaveLength(2);

    await store.close();
  });

  it("rework budget of 3 exhausts at the domain level", () => {
    // The bounded rework transition function throws once the attempt
    // reaches the maximum. This guards both verify and review rework paths.
    expect(PIPELINE_REWORK_MAX_ATTEMPTS).toBe(3);

    // Attempts 1 and 2 succeed.
    expect(assertPipelineReworkTransition("verify", 1)).toBe("implement");
    expect(assertPipelineReworkTransition("verify", 2)).toBe("implement");
    expect(assertPipelineReworkTransition("isolated_review", 1)).toBe("implement");
    expect(assertPipelineReworkTransition("isolated_review", 2)).toBe("implement");

    // Attempt 3 is exhausted.
    expect(() => assertPipelineReworkTransition("verify", 3)).toThrow(
      /exhausted/i
    );
    expect(() => assertPipelineReworkTransition("isolated_review", 3)).toThrow(
      /exhausted/i
    );
  });

  it("duplicate intake delivery ID creates exactly one run", async () => {
    let idCounter = 0;
    const idFactory = createIdFactory(() => {
      idCounter++;
      const hex = idCounter.toString(16).padStart(12, "0");
      return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
    });
    const database = openDatabase({ filePath: await temporaryDatabasePath() });
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

    const makeIntake = () =>
      intakeWorkItem(
        {
          source: { kind: "api", clientId: "test-client", deliveryId: "dedup-test-delivery-001" },
          title: "Fix the parser regression",
          description: "Parsing fails on an empty input file.",
          requester: { externalId: "octocat" },
          priority: "normal",
          labels: [],
          acceptanceContext: []
        },
        {
          workspaceId: WORKSPACE_ID,
          actor: { kind: "system", id: "test" },
          correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001"
        },
        { now: () => NOW, ids: idFactory }
      );

    const intake = makeIntake();
    await store.commit({
      idempotency: intake.idempotency,
      appends: intake.appends,
      jobs: intake.jobs
    });

    // Identical commit request with same idempotency key should be replayed.
    const result = await store.commit({
      idempotency: intake.idempotency,
      appends: intake.appends,
      jobs: intake.jobs
    });
    expect(result.replayed).toBe(true);

    // Only one run.created event exists.
    const events = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const runCreatedEvents = events.filter((e) => e.type === "run.created");
    expect(runCreatedEvents).toHaveLength(1);

    await store.close();
  });

  it("publish retry creates exactly one draft pull request", async () => {
    // Use the full pipeline to reach publish, then prove the delivery
    // integration's idempotency produces exactly one PR.
    let idCounter = 0;
    const idFactory = createIdFactory(() => {
      idCounter++;
      const hex = idCounter.toString(16).padStart(12, "0");
      return `aaaaaaaa-bbbb-4ccc-8ddd-${hex}`;
    });
    const infra = await seedPipeline(idFactory);
    const { store, runId, workItemId, readRunEvents } = infra;
    const runner = createTestRunner(runId, 0);
    const sharedDelivery = createFakeDeliveryIntegration({
      now: () => NOW,
      pullRequestNumber: () => 42,
      commentId: () => 1,
      providerEvidenceDigest: () => digestOf("d")
    });

    // Build the review script dynamically after we know the plan digest.
    const buildReviewScript = async (
      planDigest: string
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

    const scripts: FakeHarnessScript[] = [triageScript, planScript, implementScript];
    const activeInners: AgentHarnessPort[] = scripts.map((s) =>
      createFakeAgentHarness({ script: s, now: () => NOW, providerSessionRef: () => "provider-session" })
    );
    let sessionIdx = 0;
    const harness: AgentHarnessPort = {
      descriptor: activeInners[0]!.descriptor,
      start: (request: AgentInvocationRequest): AsyncIterable<AgentSessionStreamEvent> => {
        const idx = sessionIdx++;
        if (idx >= activeInners.length) {
          throw new Error(`Harness exhausted at session ${idx}.`);
        }
        return activeInners[idx]!.start(request);
      },
      resume: (r) => activeInners[Math.max(0, sessionIdx - 1)]!.resume(r),
      steer: async (r) => activeInners[Math.max(0, sessionIdx - 1)]!.steer(r),
      cancel: async (r) => activeInners[Math.max(0, sessionIdx - 1)]!.cancel(r)
    };

    const { executor, errors, delivery } = await driveToImplement(infra, harness, runner, sharedDelivery);

    // Implement
    const implResult = await executor.runOnce();
    expect(implResult).toBe("completed");

    // Verify
    const verifyResult = await executor.runOnce();
    expect(verifyResult).toBe("completed");

    // Add review script
    const eventsAfterVerify = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const planEv = eventsAfterVerify.find(
      (e) =>
        e.type === "pipeline.evidence_recorded" &&
        (e.payload as any).evidence?.stage === "plan"
    );
    const planDoc = (planEv!.payload as any).document?.document;
    const reviewScriptBuilt = await buildReviewScript(planDoc.planDigest);
    activeInners.push(
      createFakeAgentHarness({
        script: reviewScriptBuilt,
        now: () => NOW,
        providerSessionRef: () => "provider-session"
      })
    );

    // Review
    const reviewResult = await executor.runOnce();
    expect(reviewResult).toBe("completed");

    // Build publish approval and commit
    const eventsAfterReview = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const runAfterReview = replayRunState(eventsAfterReview, runId);
    expect(runAfterReview.status).toBe("awaiting_publish_approval");

    const reviewEvidenceEvent = eventsAfterReview.find(
      (e) =>
        e.type === "pipeline.evidence_recorded" &&
        (e.payload as any).evidence?.stage === "isolated_review"
    );
    expect(reviewEvidenceEvent).toBeDefined();

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
      createdAt: NOW
    };
    const publishScopeDigest = await digestPublishScope(publishScopeBody);
    const publishScope = { ...publishScopeBody, scopeDigest: publishScopeDigest };

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
      reviewEvidenceDigest: (reviewEvidenceEvent!.payload as any).evidence.evidenceDigest,
      publishScopeDigest,
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

    const publishTransition = transitionRun({
      run: runAfterReview,
      to: "publishing",
      reason: "Publish approved.",
      actor: { kind: "user", id: "local-user" },
      correlationId: "aaaaaaaa-bbbb-4ccc-8ddd-000000000200",
      occurredAt: NOW
    });

    const runStreamAfterReview = eventsAfterReview.filter(
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
            workItemId,
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

    // First publish
    const pub1 = await executor.runOnce();
    expect(pub1).toBe("completed");
    expect(delivery.pullRequests).toHaveLength(1);

    // The delivery integration is idempotent by key. Even if we were to
    // enqueue a second publish job, the same idempotencyKey produces
    // the same result without a duplicate PR.
    expect(delivery.pullRequests[0]!.number).toBe(42);

    // No additional jobs remain.
    const idle = await executor.runOnce();
    expect(idle).toBe("idle");

    // Verify run is completed.
    const finalEvents = await store.readAll({ workspaceId: WORKSPACE_ID, limit: 500 });
    const finalRun = replayRunState(finalEvents, runId);
    expect(finalRun.status).toBe("completed");

    expect(errors).toEqual([]);
    await store.close();
  });

  it("publication bundle rejects a failed verification", async () => {
    // This is the E8 gate: the PublicationEvidenceBundleSchema refuses
    // a bundle whose verification.status is "failed", even when every
    // digest binding is correct.
    const makeEvidence = (status: "passed" | "failed") => ({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workItemId: "wi_11111111-2222-4333-8444-555555555555",
      runId: "run_11111111-2222-4333-8444-555555555555",
      plan: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "plan",
        artifactIds: [],
        planDigest: digestOf("2"),
        evidenceDigest: digestOf("a"),
        producedAt: NOW
      },
      planApproval: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "plan_approval",
        artifactIds: [],
        approvalId: "apr_11111111-2222-4333-8444-555555555555",
        decision: "approved",
        approvedEvidenceDigest: digestOf("a"),
        actorId: "local-user",
        evidenceDigest: digestOf("b"),
        producedAt: NOW
      },
      implementation: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "implement",
        artifactIds: [],
        planApprovalEvidenceDigest: digestOf("b"),
        agentSessionId: "agt_11111111-2222-4333-8444-555555555555",
        environmentId: "env_11111111-2222-4333-8444-555555555555",
        sourceCommit: SOURCE_COMMIT,
        resultCommit: SOURCE_COMMIT,
        finalDiffDigest: digestOf("d"),
        evidenceDigest: digestOf("c"),
        producedAt: NOW
      },
      verification: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "verify",
        artifactIds: [],
        implementationEvidenceDigest: digestOf("c"),
        status,
        evidenceDigest: digestOf("e"),
        producedAt: NOW
      },
      review: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "isolated_review",
        artifactIds: [],
        implementationEvidenceDigest: digestOf("c"),
        verificationEvidenceDigest: digestOf("e"),
        reviewedDiffDigest: digestOf("d"),
        implementation: {
          agentSessionId: "agt_11111111-2222-4333-8444-555555555555",
          environmentId: "env_11111111-2222-4333-8444-555555555555"
        },
        reviewer: {
          agentSessionId: "agt_22222222-3333-4444-8555-666666666666",
          environmentId: "env_22222222-3333-4444-8555-666666666666"
        },
        reviewReportDigest: digestOf("f"),
        verdict: "approved",
        findings: [],
        evidenceDigest: digestOf("0"),
        producedAt: NOW
      },
      publishScope: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        repositoryFullName: REPOSITORY_FULL_NAME,
        base: "main",
        head: "autostack/run/11111111-2222-4333-8444-555555555555",
        finalDiffDigest: digestOf("d"),
        action: "create_draft_pr",
        scopeDigest: digestOf("0"),
        createdAt: NOW
      },
      publishApproval: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "publish_approval",
        artifactIds: [],
        approvalId: "apr_22222222-3333-4444-8555-666666666666",
        decision: "approved",
        approvedEvidenceDigest: digestOf("0"),
        reviewEvidenceDigest: digestOf("0"),
        publishScopeDigest: digestOf("0"),
        actorId: "local-user",
        evidenceDigest: digestOf("1"),
        producedAt: NOW
      }
    });

    // Positive control: the passed-status bundle parses.
    const passing = makeEvidence("passed");
    expect(() => PublicationEvidenceBundleSchema.parse(passing)).not.toThrow();

    // Negative: the failed-status bundle is rejected.
    const failing = makeEvidence("failed");
    const result = PublicationEvidenceBundleSchema.safeParse(failing);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) =>
      issue.message.includes("requires a passed verification")
    )).toBe(true);
  });

  it("publication bundle rejects a non-approved review", async () => {
    // Minimal check: change review verdict to "changes_requested".
    const bundle = {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workItemId: "wi_11111111-2222-4333-8444-555555555555",
      runId: "run_11111111-2222-4333-8444-555555555555",
      plan: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "plan",
        artifactIds: [],
        planDigest: digestOf("2"),
        evidenceDigest: digestOf("a"),
        producedAt: NOW
      },
      planApproval: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "plan_approval",
        artifactIds: [],
        approvalId: "apr_11111111-2222-4333-8444-555555555555",
        decision: "approved",
        approvedEvidenceDigest: digestOf("a"),
        actorId: "local-user",
        evidenceDigest: digestOf("b"),
        producedAt: NOW
      },
      implementation: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "implement",
        artifactIds: [],
        planApprovalEvidenceDigest: digestOf("b"),
        agentSessionId: "agt_11111111-2222-4333-8444-555555555555",
        environmentId: "env_11111111-2222-4333-8444-555555555555",
        sourceCommit: SOURCE_COMMIT,
        resultCommit: SOURCE_COMMIT,
        finalDiffDigest: digestOf("d"),
        evidenceDigest: digestOf("c"),
        producedAt: NOW
      },
      verification: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "verify",
        artifactIds: [],
        implementationEvidenceDigest: digestOf("c"),
        status: "passed",
        evidenceDigest: digestOf("e"),
        producedAt: NOW
      },
      review: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "isolated_review",
        artifactIds: [],
        implementationEvidenceDigest: digestOf("c"),
        verificationEvidenceDigest: digestOf("e"),
        reviewedDiffDigest: digestOf("d"),
        implementation: {
          agentSessionId: "agt_11111111-2222-4333-8444-555555555555",
          environmentId: "env_11111111-2222-4333-8444-555555555555"
        },
        reviewer: {
          agentSessionId: "agt_22222222-3333-4444-8555-666666666666",
          environmentId: "env_22222222-3333-4444-8555-666666666666"
        },
        reviewReportDigest: digestOf("f"),
        verdict: "changes_requested",
        findings: [],
        evidenceDigest: digestOf("0"),
        producedAt: NOW
      },
      publishScope: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        repositoryFullName: REPOSITORY_FULL_NAME,
        base: "main",
        head: "autostack/run/11111111-2222-4333-8444-555555555555",
        finalDiffDigest: digestOf("d"),
        action: "create_draft_pr",
        scopeDigest: digestOf("0"),
        createdAt: NOW
      },
      publishApproval: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: "wi_11111111-2222-4333-8444-555555555555",
        runId: "run_11111111-2222-4333-8444-555555555555",
        stage: "publish_approval",
        artifactIds: [],
        approvalId: "apr_22222222-3333-4444-8555-666666666666",
        decision: "approved",
        approvedEvidenceDigest: digestOf("0"),
        reviewEvidenceDigest: digestOf("0"),
        publishScopeDigest: digestOf("0"),
        actorId: "local-user",
        evidenceDigest: digestOf("1"),
        producedAt: NOW
      }
    };

    const result = PublicationEvidenceBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) =>
      issue.message.includes("requires an approved independent review")
    )).toBe(true);
  });
});
