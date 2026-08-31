import {
  CredentialRefIdSchema,
  JobIdSchema,
  ModelRoutingError,
  RunIdSchema,
  StoredDomainEventSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  admitPlanDocument,
  createIdFactory,
  digestExecutionScope,
  digestPlanDocument,
  validateRunStreamCoherence,
  type Actor,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type ExecutionScope,
  type InspectRepositoryRequest,
  type PendingDomainEvent,
  type RepositoryInspection,
  type StoredDomainEvent,
  type WorkItem
} from "@autostack/contracts";
import {
  digestApprovalEvidence,
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
import { runPlanStation } from "../../src/stations/plan-station.js";

const NOW = "2026-08-27T12:00:00.000Z";
const LATER = "2026-08-27T13:30:00.000Z";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174002";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174001");
const OTHER_WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174007");
const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174002");
const OTHER_RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174003");
const WORK_ITEM_ID = WorkItemIdSchema.parse("wi_123e4567-e89b-42d3-a456-426614174004");
const OTHER_WORK_ITEM_ID = WorkItemIdSchema.parse("wi_123e4567-e89b-42d3-a456-426614174008");
const JOB_ID = JobIdSchema.parse("job_123e4567-e89b-42d3-a456-426614174005");
const CREDENTIAL_A = CredentialRefIdSchema.parse("cred_123e4567-e89b-42d3-a456-426614174010");
const CREDENTIAL_B = CredentialRefIdSchema.parse("cred_123e4567-e89b-42d3-a456-426614174011");
const CREDENTIAL_C = CredentialRefIdSchema.parse("cred_123e4567-e89b-42d3-a456-426614174012");
const ACTOR: Actor = { kind: "system", id: "workflow" };
const digestOf = (seed: string): string => seed.repeat(64).slice(0, 64);

const SOURCE_COMMIT = "3f7c1b9e5a2d4086bf13c9e7a5d20486fb91c3d7";
const OTHER_COMMIT = "9d8c7b6a5f4e3d2c1b0a99887766554433221100";
const REPOSITORY_IDENTITY = "git:/Users/dev/projects/parser";

const PROVENANCE = {
  adapterId: "fake.agent-harness",
  promptRef: "plan/default",
  promptVersion: "3"
} as const;

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
  allowedCredentialRefIds: [CREDENTIAL_A, CREDENTIAL_B],
  eligibleApproverIds: ["local-user"]
};

const unusedPort = (): never => {
  throw new Error("The plan station does not use this port.");
};

interface RecordingRunner extends RunnerProvider {
  readonly inspections: readonly InspectRepositoryRequest[];
}

const runnerFor = (
  inspection: RepositoryInspection | (() => never) = INSPECTION
): RecordingRunner => {
  const inspections: InspectRepositoryRequest[] = [];
  return {
    capabilities: async () => unusedPort(),
    inspectRepository: async (request) => {
      inspections.push(request);
      return typeof inspection === "function" ? inspection() : inspection;
    },
    prepareEnvironment: async () => unusedPort(),
    listEnvironments: async () => unusedPort(),
    startCommand: async () => unusedPort(),
    readCommandEvents: () => unusedPort(),
    cancelCommand: async () => unusedPort(),
    readArtifactChunk: async () => unusedPort(),
    disposeEnvironment: async () => unusedPort(),
    get inspections() {
      return [...inspections];
    }
  };
};

const plan = {
  summary: "Guard the empty-input path in the reader and cover it with a regression test.",
  acceptanceCriteria: ["Parsing an empty file yields an empty document instead of throwing."],
  affectedAreas: ["packages/parser/src/reader.ts"],
  risks: [{ severity: "low", summary: "The guard could mask a genuine read failure." }],
  verificationCommands: [
    {
      executable: "pnpm",
      args: ["--filter", "@autostack/parser", "test"],
      usesShell: false,
      required: true
    }
  ],
  requiredPermissions: [{ kind: "filesystem_write", detail: "Edit files under packages/parser." }],
  requiredCredentialRefIds: [CREDENTIAL_A]
} as const;

/** A session that starts, reports each structured result in order, and completes. */
const scriptFor = (...results: readonly Readonly<Record<string, unknown>>[]): FakeHarnessScript => [
  { kind: "emit", event: { type: "started" } },
  ...results.map(
    (result) =>
      ({
        kind: "emit",
        event: { type: "output", stream: "structured", text: JSON.stringify(result) }
      }) as const
  ),
  { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
];

interface RecordingHarness extends AgentHarnessPort {
  readonly requests: readonly AgentInvocationRequest[];
}

const harnessFor = (script: FakeHarnessScript = scriptFor(plan)): RecordingHarness => {
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

const workItem = (overrides: Partial<WorkItem> = {}): Readonly<Record<string, unknown>> => ({
  schemaVersion: 1,
  id: WORK_ITEM_ID,
  workspaceId: WORKSPACE_ID,
  source: { kind: "manual", client: "cli" },
  title: "Fix the parser regression",
  description: "Parsing fails on an empty input file.",
  requester: { externalId: "octocat" },
  attachments: [],
  priority: "normal",
  labels: [],
  acceptanceContext: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides
});

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

const planningRun = (
  item: Readonly<Record<string, unknown>> = workItem()
): readonly StoredDomainEvent[] => [
  stored("work_item.created", { workItem: item }, { kind: "work_item", id: String(item.id) }, 1),
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
  )
];

/** The same run, with the triage judgement that sent it here already on the stream. */
const triagedRun = (item: Readonly<Record<string, unknown>>): readonly StoredDomainEvent[] => [
  ...planningRun(item),
  stored(
    "pipeline.evidence_recorded",
    {
      runId: RUN_ID,
      jobId: JOB_ID,
      attempt: 1,
      evidence: {
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        workItemId: WORK_ITEM_ID,
        runId: RUN_ID,
        stage: "triage",
        evidenceDigest: digestOf("b"),
        artifactIds: [],
        summary: "A reproducible parser regression with a failing input.",
        producedAt: NOW
      },
      document: {
        kind: "triage",
        report: {
          schemaVersion: 1,
          workspaceId: WORKSPACE_ID,
          workItemId: WORK_ITEM_ID,
          runId: RUN_ID,
          taskType: "bug",
          priority: "normal",
          complexity: "small",
          actionable: true,
          rationale: "A reproducible parser regression with a failing input.",
          duplicates: [],
          producedAt: NOW
        }
      }
    },
    { kind: "run", id: RUN_ID },
    4
  )
];

const job = (overrides: Partial<LeasedWorkflowJob> = {}): LeasedWorkflowJob => ({
  jobId: JOB_ID,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  stage: "plan",
  handler: "pipeline.plan",
  payload: {
    workItemId: WORK_ITEM_ID,
    pipelineStage: "plan",
    attempt: 1,
    inputEvidenceDigests: [digestOf("a")]
  },
  maxAttempts: 3,
  availableAt: NOW,
  createdAt: NOW,
  attempt: 1,
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
  harness: harnessFor(),
  runner: runnerFor(),
  delivery: createFakeDeliveryIntegration({
    now: () => NOW,
    pullRequestNumber: () => 1,
    commentId: () => 1,
    providerEvidenceDigest: () => digestOf("d")
  }),
  readRunEvents: async () => planningRun(),
  workspaceId: WORKSPACE_ID,
  actor: ACTOR,
  ...overrides
});

const runPlan = async (
  overrides: Partial<StationDependencies> = {},
  configuration: ProjectExecutionConfiguration = CONFIGURATION,
  leased: LeasedWorkflowJob = job()
): Promise<WorkflowHandlerResult> => {
  const injected = dependencies(overrides);
  return runPlanStation(
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

const findEvent = (result: WorkflowHandlerResult, type: string): PendingDomainEvent => {
  const event = eventsOf(result).find((candidate) => candidate.type === type);
  if (event === undefined) throw new Error(`The station emitted no ${type} event.`);
  return event;
};

const evidenceOf = (result: WorkflowHandlerResult) => {
  const event = findEvent(result, "pipeline.evidence_recorded");
  if (event.type !== "pipeline.evidence_recorded") throw new Error("Unreachable.");
  if (event.payload.evidence.stage !== "plan") throw new Error("The envelope is not the plan's.");
  return event.payload.evidence;
};

const documentOf = (result: WorkflowHandlerResult) => {
  const event = findEvent(result, "pipeline.evidence_recorded");
  if (event.type !== "pipeline.evidence_recorded") throw new Error("Unreachable.");
  const document = event.payload.document;
  if (document?.kind !== "plan") throw new Error("The station recorded no plan document.");
  return document.document;
};

const approvalOf = (result: WorkflowHandlerResult) => {
  const event = findEvent(result, "approval.requested");
  if (event.type !== "approval.requested") throw new Error("Unreachable.");
  return event.payload.approval;
};

/** The scope the station must have built: everything comes from the inspection and configuration. */
const expectedScope = (
  overrides: Partial<Pick<ExecutionScope, "allowedCredentialRefIds">> = {}
): ExecutionScope =>
  buildExecutionScope({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    // Derived, not minted: the id is inside the digested scope, so the plan-approval decision must
    // re-derive this exact scope later. Pinning the id factory's value here would assert the very
    // behaviour that breaks `admitPrepareEnvironment` on a valid approval.
    environmentId: executionEnvironmentForRun(RUN_ID),
    inspection: INSPECTION,
    configuration: CONFIGURATION,
    allowedCredentialRefIds: plan.requiredCredentialRefIds,
    ...overrides
  });

describe("the plan station on a plannable run", () => {
  it("records an admissible plan, waits for approval, and enqueues nothing", async () => {
    const result = await runPlan();
    const document = documentOf(result);

    expect(result.appends).toHaveLength(1);
    expect(result.appends[0]).toMatchObject({
      stream: { kind: "run", id: RUN_ID },
      expectedVersion: 3
    });
    expect(typesOf(result)).toEqual([
      "stage.queued",
      "stage.leased",
      "pipeline.evidence_recorded",
      "approval.requested",
      "stage.succeeded",
      "run.transitioned"
    ]);
    expect(findEvent(result, "run.transitioned").payload).toMatchObject({
      from: "planning",
      to: "awaiting_plan_approval"
    });
    await expect(admitPlanDocument(document)).resolves.toEqual(document);
    expect(evidenceOf(result).planDigest).toBe(document.planDigest);
    // Plan D2: a run waiting on a human holds no lease and no queued job.
    expect(result.jobs).toEqual([]);
  });

  it("emits evidence, a plan document, and an approval the run stream accepts together", async () => {
    const result = await runPlan();

    await expect(
      validateRunStreamCoherence(
        eventsOf(result).filter(
          (event) =>
            event.type === "pipeline.evidence_recorded" || event.type === "approval.requested"
        )
      )
    ).resolves.toHaveLength(2);
  });

  it("asks the runner to inspect exactly the configured source and base ref", async () => {
    const runner = runnerFor();
    await runPlan({ runner });

    expect(runner.inspections).toEqual([CONFIGURATION.inspection]);
  });
});

describe("the plan digest, which is what §14.2 staleness is measured against", () => {
  // The pair is the point. On its own, "a different producedAt yields the same digest" passes
  // against an implementation that digests a constant, or one that ignores the document entirely;
  // the changed-criterion half is what proves the digest still tracks approved content. Rejects an
  // implementation that hand-rolls the canonicalization and leaves `producedAt` inside it.
  it("excludes producedAt while still moving on a changed acceptance criterion", async () => {
    const first = await runPlan();
    const replanned = await runPlan({ now: () => LATER });
    const changed = await runPlan({
      harness: harnessFor(
        scriptFor({ ...plan, acceptanceCriteria: ["Parsing an empty file raises a typed error."] })
      )
    });

    expect(documentOf(replanned).producedAt).not.toBe(documentOf(first).producedAt);
    expect(documentOf(replanned).planDigest).toBe(documentOf(first).planDigest);
    expect(documentOf(changed).planDigest).not.toBe(documentOf(first).planDigest);
  });

  // Plan D12: the plan canonicalization excludes `producedBy`, so **a human's plan approval
  // survives a change of producing adapter** — §14.2 invalidates an approval only on material
  // change to approved *content*, and which model wrote the plan is not that content. Paired with a
  // content change for the same reason as the test above.
  it("excludes producedBy while still moving on changed content", async () => {
    const authored = await runPlan({
      harness: harnessFor(scriptFor({ ...plan, producedBy: PROVENANCE }))
    });
    const reauthored = await runPlan({
      harness: harnessFor(
        scriptFor({
          ...plan,
          producedBy: { ...PROVENANCE, adapterId: "other.adapter", promptVersion: "9" }
        })
      )
    });
    const changed = await runPlan({
      harness: harnessFor(
        scriptFor({ ...plan, producedBy: PROVENANCE, summary: "A different plan summary." })
      )
    });

    expect(documentOf(reauthored).producedBy).not.toEqual(documentOf(authored).producedBy);
    expect(documentOf(reauthored).planDigest).toBe(documentOf(authored).planDigest);
    expect(documentOf(changed).planDigest).not.toBe(documentOf(authored).planDigest);
  });

  // Rejects an implementation that computes `planDigest` itself — over the envelope, or with a
  // hand-rolled `digestVersionedValue(...)` over fields it chose. Only `digestPlanDocument`
  // produces a digest `admitPlanDocument` accepts.
  it("names the contracts digest of the exact document it recorded", async () => {
    const document = documentOf(await runPlan());

    expect(document.planDigest).toBe(await digestPlanDocument(document));
    await expect(
      admitPlanDocument({ ...document, summary: "A different plan summary." })
    ).rejects.toThrow(/digest/i);
  });
});

describe("the execution scope that carries the plan approval", () => {
  // Plan D1: the whole plan-approval gate rests on this equality. It is what lets one human
  // approval satisfy both the pipeline gate and `admitPrepareEnvironment`, which recomputes
  // `digestExecutionScope(authorization.scope)` and compares it to `approval.evidenceDigest`.
  it("digests as approval evidence exactly as it digests as an execution scope", async () => {
    const scope = expectedScope();

    expect(digestApprovalEvidence(scope, "plan")).toBe(await digestExecutionScope(scope));
    expect(approvalOf(await runPlan()).evidenceDigest).toBe(await digestExecutionScope(scope));
  });

  it("requests a pending plan approval from the configured approvers", async () => {
    const approval = approvalOf(await runPlan());

    expect(approval).toMatchObject({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "plan",
      status: "pending",
      eligibleApproverIds: CONFIGURATION.eligibleApproverIds
    });
  });

  // Rejects an implementation that builds repository identity, the base ref, or the commit from
  // work-item text instead of the runner's inspection. The discriminating vector is work-item text
  // that *looks* like a repository identity and a commit: an implementation that scraped it would
  // bind the scope to attacker-chosen values, and the digest would move away from the inspection's.
  it("binds the scope to the inspected repository, never to work-item text", async () => {
    const scope = expectedScope();
    const misleading = workItem({
      title: `Fix git:/Users/evil/other at ${OTHER_COMMIT}`,
      description: `Work on git:/Users/evil/other, base ref refs/heads/evil, commit ${OTHER_COMMIT}.`
    });

    expect(scope).toMatchObject({
      repositoryIdentity: REPOSITORY_IDENTITY,
      sourceCommit: SOURCE_COMMIT
    });
    expect(scope.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    const result = await runPlan({ readRunEvents: async () => planningRun(misleading) });
    expect(approvalOf(result).evidenceDigest).toBe(await digestExecutionScope(scope));
  });

  // Rejects an implementation that derives the branch from the work item, the repository, or the
  // model's output. The discriminating pair: identical work-item text under two run ids must give
  // two branches, and different work-item text under one run id must give one.
  it("derives an autostack branch from the run id alone", async () => {
    const scope = expectedScope();
    const otherRun = buildExecutionScope({
      workspaceId: WORKSPACE_ID,
      runId: OTHER_RUN_ID,
      environmentId: executionEnvironmentForRun(OTHER_RUN_ID),
      inspection: INSPECTION,
      configuration: CONFIGURATION,
      allowedCredentialRefIds: plan.requiredCredentialRefIds
    });

    expect(scope.branch.startsWith("autostack/")).toBe(true);
    expect(scope.branch).toContain(RUN_ID.slice(RUN_ID.indexOf("_") + 1));
    expect(otherRun.branch).not.toBe(scope.branch);
    const retitled = await runPlan({
      readRunEvents: async () => planningRun(workItem({ title: "An entirely different title" }))
    });
    expect(approvalOf(retitled).evidenceDigest).toBe(await digestExecutionScope(scope));
  });

  // A station never widens a scope. The scope grants what the plan asked for, not everything the
  // project allows. Rejects an implementation that passes `configuration.allowedCredentialRefIds`
  // straight through — which would hand the environment credential B the plan never named.
  it("grants only the credentials the plan required", async () => {
    expect(expectedScope().allowedCredentialRefIds).toEqual([CREDENTIAL_A]);
    expect(approvalOf(await runPlan()).evidenceDigest).toBe(
      await digestExecutionScope(expectedScope())
    );
    expect(await digestExecutionScope(expectedScope())).not.toBe(
      await digestExecutionScope(
        expectedScope({ allowedCredentialRefIds: CONFIGURATION.allowedCredentialRefIds })
      )
    );
  });
});

describe("the plan station failing closed on a scope it cannot grant", () => {
  // Both halves are needed. A permission the configuration allows must pass, or the guard is
  // rejecting everything; a permission it does not allow must fail, or the guard is decorative.
  // Rejects an implementation that validates only against `PlanPermissionKindSchema` — the schema
  // admits all four kinds, so the enum is exactly the "default that happens to satisfy" trap.
  it("refuses a permission the project configuration does not allow", async () => {
    const allowed = await runPlan({
      harness: harnessFor(
        scriptFor({
          ...plan,
          requiredPermissions: [{ kind: "network_egress", detail: "Fetch the package registry." }]
        })
      )
    });
    const refused = await runPlan({
      harness: harnessFor(
        scriptFor({
          ...plan,
          requiredPermissions: [{ kind: "destructive_action", detail: "Force-push the branch." }]
        })
      )
    });

    expect(findEvent(allowed, "run.transitioned").payload).toMatchObject({
      to: "awaiting_plan_approval"
    });
    expect(typesOf(refused)).toEqual(["stage.failed", "run.transitioned"]);
    expect(findEvent(refused, "run.transitioned").payload).toMatchObject({ to: "failed" });
    expect(refused.jobs).toEqual([]);
  });

  it("refuses a credential reference the project configuration does not allow", async () => {
    const allowed = await runPlan({
      harness: harnessFor(
        scriptFor({ ...plan, requiredCredentialRefIds: [CREDENTIAL_A, CREDENTIAL_B] })
      )
    });
    const refused = await runPlan({
      harness: harnessFor(
        scriptFor({ ...plan, requiredCredentialRefIds: [CREDENTIAL_A, CREDENTIAL_C] })
      )
    });

    expect(findEvent(allowed, "run.transitioned").payload).toMatchObject({
      to: "awaiting_plan_approval"
    });
    expect(typesOf(refused)).toEqual(["stage.failed", "run.transitioned"]);
    expect(refused.jobs).toEqual([]);
  });
});

describe("the plan station on provenance and identity", () => {
  // Rejects an implementation that synthesizes `producedBy` from `harness.descriptor` when the
  // model reported none (plan D12: false provenance is worse than absent provenance). The absent
  // case is the discriminating one — the fake's descriptor would supply `fake.agent-harness`.
  it("passes producedBy through and never invents one", async () => {
    const withProvenance = await runPlan({
      harness: harnessFor(scriptFor({ ...plan, producedBy: PROVENANCE }))
    });
    const without = await runPlan();

    expect(documentOf(withProvenance).producedBy).toEqual(PROVENANCE);
    expect(documentOf(without).producedBy).toBeUndefined();
    expect(Object.keys(documentOf(without))).not.toContain("producedBy");
    await expect(admitPlanDocument(documentOf(without))).resolves.toBeDefined();
  });

  // Plan D13: the leased job is the only source of `workspaceId`, `workItemId`, and `runId`.
  // Rejects `PlanDocumentSchema.parse({ ...identity, ...modelResult })`, where a well-formed
  // `workItemId` in the model's body displaces the station's own.
  it("takes identity from the leased job even when the model supplies its own", async () => {
    const result = await runPlan({
      harness: harnessFor(
        scriptFor({
          ...plan,
          workspaceId: OTHER_WORKSPACE_ID,
          workItemId: OTHER_WORK_ITEM_ID,
          runId: OTHER_RUN_ID,
          planDigest: digestOf("f")
        })
      )
    });

    expect(documentOf(result)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      workItemId: WORK_ITEM_ID,
      runId: RUN_ID
    });
    expect(evidenceOf(result)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      workItemId: WORK_ITEM_ID,
      runId: RUN_ID
    });
    expect(documentOf(result).planDigest).toBe(await digestPlanDocument(documentOf(result)));
  });

  it("puts the work item, its acceptance context, the triage judgement, and the inspected tree into the objective", async () => {
    const harness = harnessFor();
    await runPlan({
      harness,
      readRunEvents: async () =>
        triagedRun(workItem({ acceptanceContext: ["Empty files must round-trip."] }))
    });
    const objective = harness.requests[0]?.objective ?? "";

    expect(harness.requests[0]?.workItemId).toBe(WORK_ITEM_ID);
    expect(objective).toContain("Fix the parser regression");
    expect(objective).toContain("Empty files must round-trip.");
    expect(objective).toContain("A reproducible parser regression with a failing input.");
    // The tree the plan is written against is the runner's answer, not a ref the model picked.
    expect(objective).toContain(REPOSITORY_IDENTITY);
    expect(objective).toContain(SOURCE_COMMIT);
  });

  // `AgentInvocationRequestSchema.environmentId` is optional, so an id minted only to fill it is
  // fabricated identity — it reaches an adapter and no durable event. Planning runs before
  // provisioning, so it must be absent. The paired half is the discriminating one: the station
  // *does* mint an environment id, for the scope the approval authorizes, so a test that only
  // asserted absence would also pass against a station that minted none at all.
  it("names no environment on a session that runs before provisioning", async () => {
    const harness = harnessFor();
    await runPlan({ harness });

    // Both halves, because absence alone would also pass against a station that names no
    // environment anywhere. The invocation omits it (nothing is provisioned yet, E10); the scope
    // still names the future environment the approval authorizes — same word, two different things.
    expect(harness.requests[0]?.environmentId).toBeUndefined();
    expect(expectedScope().environmentId).toBe(executionEnvironmentForRun(RUN_ID));
  });
});

describe("the plan station on failure and abandonment", () => {
  it("raises a transient harness failure and commits a deterministic one", async () => {
    const transient = new ModelRoutingError({
      schemaVersion: 1,
      code: "rate_limited",
      message: "The provider is rate limited.",
      retryable: true
    });

    await expect(
      runPlan({ harness: harnessFor([{ kind: "throw", error: transient }]) })
    ).rejects.toBeInstanceOf(RetryableJobError);

    const deterministic = await runPlan({
      harness: harnessFor([
        {
          kind: "throw",
          error: new ModelRoutingError({
            schemaVersion: 1,
            code: "budget_exceeded",
            message: "The run is over budget.",
            retryable: false
          })
        }
      ])
    });
    expect(typesOf(deterministic)).toEqual(["stage.failed", "run.transitioned"]);
  });

  it("commits the deterministic failure outcome when the repository cannot be inspected", async () => {
    const result = await runPlan({
      runner: runnerFor(() => {
        throw new TypeError("The source path is not a Git repository.");
      })
    });

    expect(typesOf(result)).toEqual(["stage.failed", "run.transitioned"]);
    expect(result.jobs).toEqual([]);
  });

  it("classifies a reported session failure through the code the harness gave it", async () => {
    const reported = (retryable: boolean): FakeHarnessScript => [
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: {
          type: "failed",
          code: "agent_error",
          message: "The agent stopped early.",
          retryable
        }
      }
    ];

    await expect(runPlan({ harness: harnessFor(reported(true)) })).rejects.toBeInstanceOf(
      RetryableJobError
    );
    const stopped = await runPlan({ harness: harnessFor(reported(false)) });
    const failed = findEvent(stopped, "stage.failed");
    if (failed.type !== "stage.failed") throw new Error("Unreachable.");
    expect(failed.payload.error).toMatchObject({ code: "agent_error", retryable: false });
  });

  it("fails deterministically when the session produced no structured result", async () => {
    const result = await runPlan({
      harness: harnessFor([
        { kind: "emit", event: { type: "started" } },
        { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("e")] } }
      ])
    });

    expect(typesOf(result)).toEqual(["stage.failed", "run.transitioned"]);
  });

  // Rejects an implementation that swallows the abandonment sentinel into an empty commit, and one
  // that hand-builds the D10 `{ stage.failed, run.transitioned -> failed }` append instead of going
  // through `failDeterministically` — which is how a station slips past the kernel's own guard. An
  // aborted lease must unwind with the sentinel and commit nothing, so lease expiry recovers the
  // run instead of marking it permanently failed. The second vector is the discriminating one: the
  // lease aborts *inside* the session, where the station's own catch can see the sentinel.
  //
  // What this does NOT reject, verified by mutation: dropping the station's own
  // `if (error instanceof StageAbandoned) throw error` rethrow. `failDeterministically` re-reads
  // the same `signal.aborted` and raises the sentinel itself, so the kernel is the load-bearing
  // guard and the station's rethrow is defence in depth kept in step with the triage station.
  it("abandons an aborted lease without committing anything", async () => {
    const before = new AbortController();
    before.abort();
    await expect(runPlan({ signal: before.signal })).rejects.toBeInstanceOf(StageAbandoned);

    const during = new AbortController();
    const inner = harnessFor();
    const aborting: typeof inner = {
      descriptor: inner.descriptor,
      start: (request) => {
        during.abort();
        return inner.start(request);
      },
      resume: (request) => inner.resume(request),
      steer: (request) => inner.steer(request),
      cancel: (request) => inner.cancel(request),
      requests: inner.requests
    };

    await expect(runPlan({ signal: during.signal, harness: aborting })).rejects.toBeInstanceOf(
      StageAbandoned
    );
  });

  it("refuses to plan a run or a work item its event read never carried", async () => {
    await expect(runPlan({ readRunEvents: async () => [] })).rejects.toThrow(/recorded/i);

    const missing = await runPlan({
      readRunEvents: async () => planningRun(workItem({ id: OTHER_WORK_ITEM_ID }))
    });
    expect(typesOf(missing)).toEqual(["stage.failed", "run.transitioned"]);
  });
});

describe("executionEnvironmentForRun", () => {
  // The wrong implementation this rejects is `ids.environment()` — a fresh mint per call. The id
  // sits inside `ExecutionScopeShape`, and `digestExecutionScope` covers every field, so the plan
  // station digests it into the approval and discards the scope; the plan-approval decision must
  // then re-derive the SAME scope to record the environment authorization whose
  // `approvalEvidenceDigest` must equal that digest. Under a mint the second derivation differs and
  // a perfectly valid approval fails `admitPrepareEnvironment` — a stale-approval error with no
  // stale approval. A single-call test cannot see that; only re-derivation can.
  it("derives the same environment for a run every time, and a different one per run", () => {
    expect(executionEnvironmentForRun(RUN_ID)).toBe(executionEnvironmentForRun(RUN_ID));
    // Boundary companion: without this, an implementation returning one constant also passes.
    expect(executionEnvironmentForRun(RUN_ID)).not.toBe(executionEnvironmentForRun(OTHER_RUN_ID));
  });

  it("never reuses the run's own uuid, so the two ids cannot be aliased", () => {
    // Rejects a `env_${runUuid}` derivation — deterministic, but it collides an EnvironmentId with
    // a RunId for anything correlating by uuid. That is the defect fixed in the triage station's
    // `stage_${sessionUuid}`, and re-introducing it here would be the same bug in a new place.
    const runUuid = RUN_ID.slice(RUN_ID.indexOf("_") + 1);
    expect(executionEnvironmentForRun(RUN_ID)).not.toBe(`env_${runUuid}`);
  });

  it("keeps the scope digest stable across re-derivation", async () => {
    const scopeFor = (): ExecutionScope =>
      buildExecutionScope({
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        environmentId: executionEnvironmentForRun(RUN_ID),
        inspection: INSPECTION,
        configuration: CONFIGURATION,
        allowedCredentialRefIds: []
      });
    expect(await digestExecutionScope(scopeFor())).toBe(await digestExecutionScope(scopeFor()));
  });
});
