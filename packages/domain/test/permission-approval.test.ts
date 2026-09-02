import {
  ApprovalIdSchema,
  ApprovalSchema,
  CommandScopeSchema,
  JobIdSchema,
  RunSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  RunIdSchema,
  digestCommandScope,
  type Actor,
  type Approval,
  type CommandScope,
  type Run
} from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import { StaleApprovalEvidenceError } from "../src/errors.js";
import {
  requestPermissionApproval,
  decidePermissionApproval,
  type PermissionApprovalRequestCommand,
  type PermissionApprovalRequestDependencies,
  type PermissionApprovalDecisionCommand,
  type PermissionApprovalDecisionDependencies,
  type PermissionApprovalDecision
} from "../src/permission-approval.js";

const NOW = "2026-08-28T12:00:00.000Z";
const LATER = "2026-08-28T12:05:00.000Z";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const RUN_ID = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-426614174001");
const WORK_ITEM_ID = WorkItemIdSchema.parse("wi_123e4567-e89b-42d3-a456-426614174002");
const APPROVAL_ID = ApprovalIdSchema.parse("apr_123e4567-e89b-42d3-a456-426614174010");
const JOB_ID = "job_123e4567-e89b-42d3-a456-426614174011";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174012";
const ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };
const STATION_ACTOR: Actor = { kind: "system", id: "station:implement" };

/**
 * A minimal, deterministic command scope. The exact content does not matter for the permission-
 * approval tests — only its DIGEST does, because the approval's evidence digest is derived from
 * the scope's canonical form. Two scopes built from distinct calls produce the same digest only
 * when their fields match byte-for-byte.
 */
const commandScope = (overrides: Partial<CommandScope> = {}): CommandScope =>
  CommandScopeSchema.parse({
    environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174005",
    environmentAuthorizationDigest: "a".repeat(64),
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    environmentId: "env_123e4567-e89b-42d3-a456-426614174006",
    commandId: "cmd_123e4567-e89b-42d3-a456-426614174007",
    action: "implement",
    commandDigest: "b".repeat(64),
    repositoryIdentity: "github.com/autostack/factory",
    sourceCommit: "c".repeat(40),
    branch: "autostack/run/123e4567-e89b-42d3-a456-426614174001",
    cwdRoot: ".",
    networkPolicy: "host",
    filesystemDisclosure: "host_user",
    resourceLimits: { cpu: 2, memoryMb: 4_096, durationSeconds: 1_800 },
    allowedCredentialRefIds: [],
    ...overrides
  });

const runRecord = (overrides: Partial<Run> = {}): Run =>
  RunSchema.parse({
    schemaVersion: 1,
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    workflowVersion: "foundation.v1",
    status: "implementing",
    currentStage: "implement",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  });

const requestDeps = (): PermissionApprovalRequestDependencies => ({
  now: () => NOW,
  approvalId: () => APPROVAL_ID
});

const requestCommand = (
  overrides: Partial<PermissionApprovalRequestCommand> = {}
): PermissionApprovalRequestCommand => ({
  run: runRecord(),
  streamVersion: 5,
  actionScope: commandScope(),
  resumeHandler: "pipeline.implement",
  resumeStage: "implement" as const,
  resumePayload: {
    workItemId: WORK_ITEM_ID,
    pipelineStage: "implement",
    attempt: 1,
    inputEvidenceDigests: ["d".repeat(64)]
  },
  eligibleApproverIds: [ACTOR.id],
  actor: STATION_ACTOR,
  correlationId: CORRELATION_ID,
  ...overrides
});

// ---------------------------------------------------------------------------
// requestPermissionApproval
// ---------------------------------------------------------------------------

describe("requestPermissionApproval", () => {
  it("parks the run at waiting_for_user with resumeStatus pointing back to the station's status", async () => {
    const result = await requestPermissionApproval(requestCommand(), requestDeps());

    expect(result.run.status).toBe("waiting_for_user");
    expect(result.run.resumeStatus).toBe("implementing");
    // The current stage survives the parking — the run machine keeps it when transitioning to a
    // resumable status.
    expect(result.run.currentStage).toBe("implement");
  });

  it("creates a permission approval whose evidence digest matches the action scope", async () => {
    const scope = commandScope();
    const result = await requestPermissionApproval(requestCommand({ actionScope: scope }), requestDeps());

    expect(result.approval.kind).toBe("permission");
    expect(result.approval.status).toBe("pending");
    expect(result.approval.evidenceDigest).toBe(await digestCommandScope(scope));
    expect(result.approval.workspaceId).toBe(WORKSPACE_ID);
    expect(result.approval.runId).toBe(RUN_ID);
    expect(result.approval.eligibleApproverIds).toContain(ACTOR.id);
  });

  it("enqueues nothing — the decision route creates the resume job (D2)", async () => {
    const result = await requestPermissionApproval(requestCommand(), requestDeps());

    expect(result.jobs).toEqual([]);
  });

  it("appends the approval request and transition events to the run stream", async () => {
    const result = await requestPermissionApproval(requestCommand(), requestDeps());

    expect(result.appends).toHaveLength(1);
    const append = result.appends[0]!;
    expect(append.stream).toEqual({ kind: "run", id: RUN_ID });
    expect(append.expectedVersion).toBe(5);

    const types = append.events.map((e) => e.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("run.transitioned");
  });
});

// ---------------------------------------------------------------------------
// decidePermissionApproval — approved
// ---------------------------------------------------------------------------

describe("decidePermissionApproval — approved", () => {
  const decisionDeps = (): PermissionApprovalDecisionDependencies => ({
    now: () => LATER,
    ids: { job: () => JobIdSchema.parse(JOB_ID) }
  });

  const approvedApproval = async (scope: CommandScope = commandScope()): Promise<Approval> =>
    ApprovalSchema.parse({
      schemaVersion: 1,
      id: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "permission",
      status: "pending",
      evidenceDigest: await digestCommandScope(scope),
      eligibleApproverIds: [ACTOR.id],
      createdAt: NOW,
      updatedAt: NOW
    });

  const waitingRun = (): Run =>
    runRecord({ status: "waiting_for_user", resumeStatus: "implementing" });

  const decisionCommand = async (
    overrides: Partial<PermissionApprovalDecisionCommand> = {}
  ): Promise<PermissionApprovalDecisionCommand> => {
    const scope = commandScope();
    return {
      approval: await approvedApproval(scope),
      decision: "approved",
      run: waitingRun(),
      streamVersion: 8,
      actionScope: scope,
      resumeHandler: "pipeline.implement",
      resumeStage: "implement" as const,
      resumePayload: {
        workItemId: WORK_ITEM_ID,
        pipelineStage: "implement",
        attempt: 1,
        inputEvidenceDigests: ["d".repeat(64)]
      },
      actor: ACTOR,
      origin: "desktop",
      correlationId: CORRELATION_ID,
      ...overrides
    };
  };

  it("enqueues the resume job carrying the granted action digest", async () => {
    const scope = commandScope();
    const decision = await decidePermissionApproval(await decisionCommand({ actionScope: scope }), decisionDeps());

    expect(decision.jobs).toHaveLength(1);
    const job = decision.jobs[0]!;
    expect(job.handler).toBe("pipeline.implement");
    expect(job.stage).toBe("implement");
    // The resume job's payload must name the same action digest the approval accepted.
    expect(job.payload.grantedActionDigest).toBe(await digestCommandScope(scope));
  });

  it("resumes the run back to its prior status", async () => {
    const decision = await decidePermissionApproval(await decisionCommand(), decisionDeps());

    // The run was at waiting_for_user with resumeStatus "implementing".
    // After approval the run transitions back to "implementing".
    expect(decision.run.status).toBe("implementing");
  });

  it("appends decision and transition events in one atomic batch", async () => {
    const decision = await decidePermissionApproval(await decisionCommand(), decisionDeps());

    expect(decision.appends).toHaveLength(1);
    const append = decision.appends[0]!;
    expect(append.expectedVersion).toBe(8);
    const types = append.events.map((e) => e.type);
    expect(types).toContain("approval.decided");
    expect(types).toContain("run.transitioned");
  });
});

// ---------------------------------------------------------------------------
// decidePermissionApproval — rejected
// ---------------------------------------------------------------------------

describe("decidePermissionApproval — rejected", () => {
  const decisionDeps = (): PermissionApprovalDecisionDependencies => ({
    now: () => LATER,
    ids: { job: () => JobIdSchema.parse(JOB_ID) }
  });

  const pendingApproval = async (): Promise<Approval> =>
    ApprovalSchema.parse({
      schemaVersion: 1,
      id: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "permission",
      status: "pending",
      evidenceDigest: await digestCommandScope(commandScope()),
      eligibleApproverIds: [ACTOR.id],
      createdAt: NOW,
      updatedAt: NOW
    });

  const waitingRun = (): Run =>
    runRecord({ status: "waiting_for_user", resumeStatus: "implementing" });

  const rejectedCommand = async (): Promise<PermissionApprovalDecisionCommand> => ({
    approval: await pendingApproval(),
    decision: "rejected",
    run: waitingRun(),
    streamVersion: 8,
    actionScope: commandScope(),
    resumeHandler: "pipeline.implement",
    resumeStage: "implement" as const,
    resumePayload: {
      workItemId: WORK_ITEM_ID,
      pipelineStage: "implement",
      attempt: 1,
      inputEvidenceDigests: ["d".repeat(64)]
    },
    actor: ACTOR,
    origin: "desktop",
    correlationId: CORRELATION_ID
  });

  it("fails the run and enqueues nothing — the action is never performed", async () => {
    // This is the test that matters most (plan Task 8 Step 1): a rejected permission
    // NEVER executes the action. The plan says "replans or fails", but from implementing
    // there is no declared edge to planning, so the run fails.
    const decision = await decidePermissionApproval(await rejectedCommand(), decisionDeps());

    expect(decision.run.status).toBe("failed");
    expect(decision.jobs).toEqual([]);
  });

  it("records the rejection event on the run stream", async () => {
    const decision = await decidePermissionApproval(await rejectedCommand(), decisionDeps());

    const types = decision.appends.flatMap((a) => a.events.map((e) => e.type));
    expect(types).toContain("approval.decided");
    expect(types).toContain("run.transitioned");
  });
});

// ---------------------------------------------------------------------------
// decidePermissionApproval — staleness
// ---------------------------------------------------------------------------

describe("decidePermissionApproval — staleness", () => {
  const decisionDeps = (): PermissionApprovalDecisionDependencies => ({
    now: () => LATER,
    ids: { job: () => JobIdSchema.parse(JOB_ID) }
  });

  it("refuses a decision whose action scope digest no longer matches", async () => {
    const original = commandScope();
    const mutated = commandScope({ commandDigest: "f".repeat(64) });

    expect(await digestCommandScope(original)).not.toBe(await digestCommandScope(mutated));

    const command: PermissionApprovalDecisionCommand = {
      approval: ApprovalSchema.parse({
        schemaVersion: 1,
        id: APPROVAL_ID,
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        kind: "permission",
        status: "pending",
        evidenceDigest: await digestCommandScope(original),
        eligibleApproverIds: [ACTOR.id],
        createdAt: NOW,
        updatedAt: NOW
      }),
      decision: "approved",
      run: runRecord({ status: "waiting_for_user", resumeStatus: "implementing" }),
      streamVersion: 8,
      actionScope: mutated,
      resumeHandler: "pipeline.implement",
      resumeStage: "implement" as const,
      resumePayload: {
        workItemId: WORK_ITEM_ID,
        pipelineStage: "implement",
        attempt: 1,
        inputEvidenceDigests: ["d".repeat(64)]
      },
      actor: ACTOR,
      origin: "desktop",
      correlationId: CORRELATION_ID
    };

    await expect(decidePermissionApproval(command, decisionDeps())).rejects.toBeInstanceOf(
      StaleApprovalEvidenceError
    );
  });
});

// ---------------------------------------------------------------------------
// decidePermissionApproval — idempotency (D9)
// ---------------------------------------------------------------------------

describe("decidePermissionApproval — idempotency", () => {
  const decisionDeps = (): PermissionApprovalDecisionDependencies => ({
    now: () => LATER,
    ids: { job: () => JobIdSchema.parse(JOB_ID) }
  });

  it("derives the idempotency key from the approval, decision, and evidence digest", async () => {
    const scope = commandScope();
    const approval = ApprovalSchema.parse({
      schemaVersion: 1,
      id: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "permission",
      status: "pending",
      evidenceDigest: await digestCommandScope(scope),
      eligibleApproverIds: [ACTOR.id],
      createdAt: NOW,
      updatedAt: NOW
    });

    const command: PermissionApprovalDecisionCommand = {
      approval,
      decision: "approved",
      run: runRecord({ status: "waiting_for_user", resumeStatus: "implementing" }),
      streamVersion: 8,
      actionScope: scope,
      resumeHandler: "pipeline.implement",
      resumeStage: "implement" as const,
      resumePayload: {
        workItemId: WORK_ITEM_ID,
        pipelineStage: "implement",
        attempt: 1,
        inputEvidenceDigests: ["d".repeat(64)]
      },
      actor: ACTOR,
      origin: "desktop",
      correlationId: CORRELATION_ID
    };

    const decision = await decidePermissionApproval(command, decisionDeps());

    expect(decision.idempotency).toEqual({
      scope: `api:approval-decision:${WORKSPACE_ID}`,
      key: `${APPROVAL_ID}:approved:${approval.evidenceDigest}`
    });
  });

  it("replays an identical re-decision at the original instant and enqueues nothing", async () => {
    const scope = commandScope();
    const approval = ApprovalSchema.parse({
      schemaVersion: 1,
      id: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "permission",
      status: "pending",
      evidenceDigest: await digestCommandScope(scope),
      eligibleApproverIds: [ACTOR.id],
      createdAt: NOW,
      updatedAt: NOW
    });

    const command: PermissionApprovalDecisionCommand = {
      approval,
      decision: "approved",
      run: runRecord({ status: "waiting_for_user", resumeStatus: "implementing" }),
      streamVersion: 8,
      actionScope: scope,
      resumeHandler: "pipeline.implement",
      resumeStage: "implement" as const,
      resumePayload: {
        workItemId: WORK_ITEM_ID,
        pipelineStage: "implement",
        attempt: 1,
        inputEvidenceDigests: ["d".repeat(64)]
      },
      actor: ACTOR,
      origin: "desktop",
      correlationId: CORRELATION_ID
    };

    const first = await decidePermissionApproval(command, decisionDeps());
    // Now replay: the approval already has a decision, so pass the decided approval.
    const replay = await decidePermissionApproval(
      { ...command, approval: first.approval },
      { ...decisionDeps(), now: () => "2026-08-29T00:00:00.000Z" }
    );

    expect(replay.replayed).toBe(true);
    expect(replay.decidedAt).toBe(first.decidedAt);
    expect(replay.appends).toEqual([]);
    expect(replay.jobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// decidePermissionApproval — identity
// ---------------------------------------------------------------------------

describe("decidePermissionApproval — identity", () => {
  const decisionDeps = (): PermissionApprovalDecisionDependencies => ({
    now: () => LATER,
    ids: { job: () => JobIdSchema.parse(JOB_ID) }
  });

  it("refuses an approval that is not a permission approval", async () => {
    const scope = commandScope();
    const approval = ApprovalSchema.parse({
      schemaVersion: 1,
      id: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "plan",
      status: "pending",
      evidenceDigest: await digestCommandScope(scope),
      eligibleApproverIds: [ACTOR.id],
      createdAt: NOW,
      updatedAt: NOW
    });

    const command: PermissionApprovalDecisionCommand = {
      approval,
      decision: "approved",
      run: runRecord({ status: "waiting_for_user", resumeStatus: "implementing" }),
      streamVersion: 8,
      actionScope: scope,
      resumeHandler: "pipeline.implement",
      resumeStage: "implement" as const,
      resumePayload: {
        workItemId: WORK_ITEM_ID,
        pipelineStage: "implement",
        attempt: 1,
        inputEvidenceDigests: ["d".repeat(64)]
      },
      actor: ACTOR,
      origin: "desktop",
      correlationId: CORRELATION_ID
    };

    await expect(decidePermissionApproval(command, decisionDeps())).rejects.toThrow(
      /permission approval/
    );
  });

  it("refuses an approval recorded against another run", async () => {
    const scope = commandScope();
    const otherRunId = RunIdSchema.parse("run_123e4567-e89b-42d3-a456-4266141740bb");
    const approval = ApprovalSchema.parse({
      schemaVersion: 1,
      id: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: otherRunId,
      kind: "permission",
      status: "pending",
      evidenceDigest: await digestCommandScope(scope),
      eligibleApproverIds: [ACTOR.id],
      createdAt: NOW,
      updatedAt: NOW
    });

    const command: PermissionApprovalDecisionCommand = {
      approval,
      decision: "approved",
      run: runRecord({ status: "waiting_for_user", resumeStatus: "implementing" }),
      streamVersion: 8,
      actionScope: scope,
      resumeHandler: "pipeline.implement",
      resumeStage: "implement" as const,
      resumePayload: {
        workItemId: WORK_ITEM_ID,
        pipelineStage: "implement",
        attempt: 1,
        inputEvidenceDigests: ["d".repeat(64)]
      },
      actor: ACTOR,
      origin: "desktop",
      correlationId: CORRELATION_ID
    };

    await expect(decidePermissionApproval(command, decisionDeps())).rejects.toThrow(
      /different run/
    );
  });
});
