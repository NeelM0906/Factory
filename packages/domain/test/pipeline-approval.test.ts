import { createHash } from "node:crypto";

import {
  ApprovalSchema,
  CommitRequestSchema,
  EnvironmentAuthorizationIdSchema,
  ExecutionScopeSchema,
  JobIdSchema,
  PipelineEvidenceSchema,
  PlanDocumentSchema,
  RunSchema,
  digestExecutionScope,
  digestPlanDocument,
  digestVersionedValue,
  type Actor,
  type Approval,
  type EnvironmentAuthorization,
  type ExecutionScope,
  type PipelineEvidence,
  type PlanDocument,
  type Run
} from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import { ApprovalDecisionConflictError, StaleApprovalEvidenceError } from "../src/errors.js";
import {
  decidePipelineApproval,
  type PipelineApprovalDecision,
  type PipelineApprovalDecisionCommand,
  type PipelineApprovalDecisionDependencies
} from "../src/pipeline-approval.js";

const NOW = "2026-08-26T12:00:00.000Z";
const LATER = "2026-08-26T12:05:00.000Z";
const MUCH_LATER = "2026-08-27T09:30:00.000Z";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "run_123e4567-e89b-42d3-a456-426614174001";
const WORK_ITEM_ID = "wi_123e4567-e89b-42d3-a456-426614174002";
const APPROVAL_ID = "apr_123e4567-e89b-42d3-a456-426614174003";
const JOB_ID = "job_123e4567-e89b-42d3-a456-426614174004";
const AUTHORIZATION_ID = "envauth_123e4567-e89b-42d3-a456-426614174005";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174006";
const MINTED_ENVIRONMENT_ID = "env_123e4567-e89b-42d3-a456-4266141740aa";
const REPOSITORY = "github.com/autostack/factory";
const SOURCE_COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const PLACEHOLDER_DIGEST = "0".repeat(64);
const ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };

/**
 * Mirrors `executionEnvironmentForRun` and `buildExecutionScope` in
 * `packages/workflow/src/stations/execution-scope.ts`. Domain cannot import workflow — workflow
 * depends on domain — so the derivation is restated here rather than shared. What these tests prove
 * is the property the decision owns: two INDEPENDENT derivations over separate input objects digest
 * identically, and any drift in those inputs does not.
 */
const environmentFor = (runId: string): string => {
  const characters = createHash("sha256")
    .update(`autostack.run-environment:${runId}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  characters[12] = "4";
  characters[16] = "8";
  const value = characters.join("");
  return `env_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
const branchFor = (runId: string): string => `autostack/run/${runId.slice(runId.indexOf("_") + 1)}`;

interface ScopeInput {
  readonly repositoryIdentity: string;
  readonly sourceCommit: string;
  readonly environmentId: string;
  readonly branch: string;
}

/** Called once per derivation, so no two derivations can share an input object. */
const scopeInput = (): ScopeInput => ({
  repositoryIdentity: REPOSITORY,
  sourceCommit: SOURCE_COMMIT,
  environmentId: environmentFor(RUN_ID),
  branch: branchFor(RUN_ID)
});

const deriveScope = (input: ScopeInput): ExecutionScope =>
  ExecutionScopeSchema.parse({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    environmentId: input.environmentId,
    repositoryIdentity: input.repositoryIdentity,
    sourceCommit: input.sourceCommit,
    branch: input.branch,
    cwdRoot: ".",
    resourceLimits: { cpu: 2, memoryMb: 4_096, durationSeconds: 1_800 },
    networkPolicy: "host",
    filesystemDisclosure: "host_user",
    allowedCredentialRefIds: []
  });

const planDocumentFor = async (
  summary = "Gate implementation on a fresh approval."
): Promise<PlanDocument> => {
  const body = {
    schemaVersion: 1 as const,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    summary,
    acceptanceCriteria: ["A stale approval never provisions an environment."],
    affectedAreas: [],
    risks: [],
    verificationCommands: [
      { executable: "pnpm", args: ["test"], usesShell: false, required: true }
    ],
    requiredPermissions: [],
    requiredCredentialRefIds: [],
    producedAt: NOW
  };
  const planDigest = await digestPlanDocument({ ...body, planDigest: PLACEHOLDER_DIGEST });
  return PlanDocumentSchema.parse({ ...body, planDigest });
};

const sealEvidence = async (
  draft: Readonly<Record<string, unknown>>
): Promise<PipelineEvidence> => {
  const envelope = {
    ...draft,
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    producedAt: NOW
  };
  const evidenceDigest = await digestVersionedValue("autostack.pipeline-evidence", envelope);
  return PipelineEvidenceSchema.parse({ ...envelope, evidenceDigest });
};

const planEvidenceFor = async (document: PlanDocument): Promise<PipelineEvidence> =>
  sealEvidence({ stage: "plan", artifactIds: [], planDigest: document.planDigest });

const approvalFor = async (scope: ExecutionScope, status = "pending"): Promise<Approval> =>
  ApprovalSchema.parse({
    schemaVersion: 1,
    id: APPROVAL_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    kind: "plan",
    status,
    evidenceDigest: await digestExecutionScope(scope),
    eligibleApproverIds: [ACTOR.id],
    createdAt: NOW,
    updatedAt: NOW
  });

const runRecord = (): Run =>
  RunSchema.parse({
    schemaVersion: 1,
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    workflowVersion: "foundation.v1",
    status: "awaiting_plan_approval",
    currentStage: "plan",
    createdAt: NOW,
    updatedAt: NOW
  });

const dependencies = (now: () => string = () => LATER): PipelineApprovalDecisionDependencies => ({
  now,
  ids: {
    job: () => JobIdSchema.parse(JOB_ID),
    environmentAuthorization: () => EnvironmentAuthorizationIdSchema.parse(AUTHORIZATION_ID)
  }
});

const commandFor = async (
  overrides: Partial<PipelineApprovalDecisionCommand> = {}
): Promise<PipelineApprovalDecisionCommand> => {
  const document = await planDocumentFor();
  return {
    approval: await approvalFor(deriveScope(scopeInput())),
    decision: "approved",
    run: runRecord(),
    streamVersion: 7,
    planEvidence: await planEvidenceFor(document),
    planDocument: document,
    executionScope: deriveScope(scopeInput()),
    actor: ACTOR,
    origin: "desktop",
    correlationId: CORRELATION_ID,
    ...overrides
  };
};

const decide = async (
  overrides: Partial<PipelineApprovalDecisionCommand> = {},
  now?: () => string
): Promise<PipelineApprovalDecision> =>
  decidePipelineApproval(await commandFor(overrides), dependencies(now));

const eventTypesOf = (decision: PipelineApprovalDecision): readonly string[] =>
  decision.appends.flatMap((append) => append.events.map((event) => event.type));

const authorizationOf = (decision: PipelineApprovalDecision): EnvironmentAuthorization => {
  for (const append of decision.appends) {
    for (const event of append.events) {
      if (event.type === "environment.authorization_recorded") return event.payload.authorization;
    }
  }
  throw new Error("The decision recorded no environment authorization.");
};

const approvalEvidenceOf = (decision: PipelineApprovalDecision): PipelineEvidence => {
  for (const append of decision.appends) {
    for (const event of append.events) {
      if (event.type === "pipeline.evidence_recorded") return event.payload.evidence;
    }
  }
  throw new Error("The decision recorded no pipeline evidence.");
};

describe("plan approval decisions", () => {
  it("authorizes the environment over a scope re-derived from separate inputs", async () => {
    // The central problem: the plan station digested ITS scope into the approval and discarded the
    // object, so the decision only ever sees a digest. Both scopes here are derived independently —
    // separate input objects, separate `ExecutionScopeSchema.parse` calls — because an assertion
    // over one shared object would hold for an implementation that could never re-derive anything.
    const approvedScope = deriveScope(scopeInput());
    const rederivedScope = deriveScope(scopeInput());
    expect(rederivedScope).not.toBe(approvedScope);

    const decision = await decide({
      approval: await approvalFor(approvedScope),
      executionScope: rederivedScope
    });

    const authorization = authorizationOf(decision);
    expect(await digestExecutionScope(rederivedScope)).toBe(
      await digestExecutionScope(approvedScope)
    );
    expect(authorization.approvalEvidenceDigest).toBe(await digestExecutionScope(approvedScope));
    expect(authorization.scope.environmentId).toBe(environmentFor(RUN_ID));
    expect(authorization.scope.branch).toBe(branchFor(RUN_ID));
  });

  // The companion that pins the boundary the assertion above sits on: the two derivations agree
  // only because their inputs do. A digest that ignored the repository, the commit, or the branch
  // would make the pair above vacuous, and each of these changes exactly one of them.
  it.each([
    ["repository", { repositoryIdentity: "github.com/attacker/factory" }],
    ["source commit", { sourceCommit: OTHER_COMMIT }],
    ["branch", { branch: "autostack/run/other" }],
    ["environment id", { environmentId: MINTED_ENVIRONMENT_ID }]
  ])("derives a different digest when the %s changes", async (_name, change) => {
    const approvedScope = deriveScope(scopeInput());
    const drifted = deriveScope({ ...scopeInput(), ...change });

    expect(await digestExecutionScope(drifted)).not.toBe(await digestExecutionScope(approvedScope));
  });

  // Rejects an implementation that mints `ids.environment()` for the authorization instead of
  // re-deriving `executionEnvironmentForRun(runId)`. A minted id is well-formed and unique, so only
  // the digest comparison catches it — and catching it is why the helper exists.
  it("refuses a scope whose environment id was minted rather than derived", async () => {
    const approvedScope = deriveScope(scopeInput());

    await expect(
      decide({
        approval: await approvalFor(approvedScope),
        executionScope: deriveScope({ ...scopeInput(), environmentId: MINTED_ENVIRONMENT_ID })
      })
    ).rejects.toThrow(/evidence/i);
  });

  it("commits the decision, the evidence, the authorization and the transition together", async () => {
    const decision = await decide();

    expect(decision.appends).toHaveLength(1);
    expect(decision.appends[0]).toMatchObject({
      stream: { kind: "run", id: RUN_ID },
      expectedVersion: 7
    });
    expect(eventTypesOf(decision)).toEqual([
      "approval.decided",
      "pipeline.evidence_recorded",
      "environment.authorization_recorded",
      "run.transitioned"
    ]);
    expect(decision.run.status).toBe("provisioning");
  });

  it("binds the plan approval evidence to the plan evidence it approved", async () => {
    const command = await commandFor();
    const decision = await decidePipelineApproval(command, dependencies());

    expect(approvalEvidenceOf(decision)).toMatchObject({
      stage: "plan_approval",
      approvalId: APPROVAL_ID,
      decision: "approved",
      approvedEvidenceDigest: command.planEvidence.evidenceDigest,
      actorId: ACTOR.id
    });
  });

  it("enqueues one implement job on its first rework attempt", async () => {
    const decision = await decide();

    expect(decision.jobs).toEqual([
      {
        jobId: JOB_ID,
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        stage: "implement",
        handler: "pipeline.implement",
        payload: {
          workItemId: WORK_ITEM_ID,
          pipelineStage: "implement",
          attempt: 1,
          inputEvidenceDigests: [approvalEvidenceOf(decision).evidenceDigest]
        },
        maxAttempts: 3,
        availableAt: LATER,
        createdAt: LATER
      }
    ]);
  });

  it("returns a rejected run to planning and enqueues nothing", async () => {
    const decision = await decide({ decision: "rejected" });

    expect(eventTypesOf(decision)).toEqual(["approval.decided", "run.transitioned"]);
    expect(decision.run.status).toBe("planning");
    expect(decision.jobs).toEqual([]);
  });
});

describe("plan approval idempotency", () => {
  it("derives the key from the approval, the decision and the evidence digest", async () => {
    const command = await commandFor();
    const approved = await decidePipelineApproval(command, dependencies());
    const rejected = await decidePipelineApproval(
      { ...command, decision: "rejected" },
      dependencies()
    );

    expect(approved.idempotency).toEqual({
      scope: `api:approval-decision:${WORKSPACE_ID}`,
      key: `${APPROVAL_ID}:approved:${command.approval.evidenceDigest}`
    });
    // The two decisions land on different keys, which is what stops the second from replaying the
    // first instead of reaching the conflict below.
    expect(rejected.idempotency.key).not.toBe(approved.idempotency.key);
    expect(() =>
      CommitRequestSchema.parse({
        idempotency: approved.idempotency,
        appends: approved.appends,
        jobs: approved.jobs
      })
    ).not.toThrow();
  });

  // Rejects an implementation that stamps `dependencies.now()` onto every decision it returns. A
  // replay is the report of a decision already taken, so recomputing its timestamp would let one
  // approval carry two different decision instants depending on when it was resubmitted.
  it("replays an identical re-decision at the original instant and enqueues nothing", async () => {
    const command = await commandFor();
    const first = await decidePipelineApproval(command, dependencies());
    const replay = await decidePipelineApproval(
      { ...command, approval: first.approval },
      dependencies(() => MUCH_LATER)
    );

    expect(replay.replayed).toBe(true);
    expect(replay.decidedAt).toBe(first.decidedAt);
    expect(replay.decidedAt).toBe(LATER);
    expect(replay.appends).toEqual([]);
    expect(replay.jobs).toEqual([]);
    expect(replay.idempotency).toEqual(first.idempotency);
  });

  // Rejects an implementation that treats "already decided" as "replay" without comparing the
  // decision: a different verdict derives a different key, so the store never suppresses it and it
  // must be refused here instead of overwriting a decision a human already made.
  it("refuses a second, different decision on an approval already decided", async () => {
    const command = await commandFor();
    const first = await decidePipelineApproval(command, dependencies());

    await expect(
      decidePipelineApproval(
        { ...command, approval: first.approval, decision: "rejected" },
        dependencies()
      )
    ).rejects.toBeInstanceOf(ApprovalDecisionConflictError);
  });
});

describe("plan approval staleness", () => {
  // Rejects an implementation that only re-checks the plan document: the scope is the half of the
  // approval that names the repository, the commit and the branch the run will write to.
  it.each([
    ["target repository", { repositoryIdentity: "github.com/attacker/factory" }],
    ["base commit", { sourceCommit: OTHER_COMMIT }],
    ["branch", { branch: "autostack/run/other" }]
  ])("refuses a decision whose %s moved since the approval", async (_name, change) => {
    const approval = await approvalFor(deriveScope(scopeInput()));

    await expect(
      decide({ approval, executionScope: deriveScope({ ...scopeInput(), ...change }) })
    ).rejects.toBeInstanceOf(StaleApprovalEvidenceError);
  });

  // Rejects an implementation that binds only to the approval id: the plan document is the thing a
  // human read, and a run whose plan changed under it must ask again (spec §14.2).
  it("refuses a decision whose plan document was materially mutated after approval", async () => {
    const recorded = await planDocumentFor();
    const mutated = await planDocumentFor("Also publish the credentials to a gist.");

    expect(await digestPlanDocument(recorded)).toBe(recorded.planDigest);
    expect(await digestPlanDocument(mutated)).not.toBe(recorded.planDigest);
    await expect(
      decide({ planDocument: mutated, planEvidence: await planEvidenceFor(recorded) })
    ).rejects.toBeInstanceOf(StaleApprovalEvidenceError);
  });

  // Rejects an implementation whose guard reads `recorded !== undefined && recorded !== computed`.
  // Triage evidence is a well-formed `PipelineEvidence` that simply has no `planDigest`, so such a
  // guard compares nothing and passes — the absent value must refuse, not match.
  it("refuses a decision whose recorded evidence carries no plan digest at all", async () => {
    const triage = await sealEvidence({
      stage: "triage",
      artifactIds: [],
      summary: "The work item is actionable."
    });

    await expect(decide({ planEvidence: triage })).rejects.toBeInstanceOf(
      StaleApprovalEvidenceError
    );
  });

  it("writes nothing on refusal, leaving a later correct decision unaffected", async () => {
    const approval = await approvalFor(deriveScope(scopeInput()));

    // The refusal happens before this function returns anything to commit, so no idempotency
    // record can exist to poison the correct submission that follows.
    await expect(
      decide({
        approval,
        executionScope: deriveScope({ ...scopeInput(), sourceCommit: OTHER_COMMIT })
      })
    ).rejects.toBeInstanceOf(StaleApprovalEvidenceError);

    const decision = await decide({ approval });
    expect(decision.replayed).toBe(false);
    expect(decision.jobs).toHaveLength(1);
    expect(decision.run.status).toBe("provisioning");
  });
});
