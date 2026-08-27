import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalSchema,
  CommandAuthorizationSchema,
  EnvironmentAuthorizationSchema,
  EventIdSchema,
  PendingDomainEventSchema,
  PrepareEnvironmentRequestSchema,
  RepositoryInspectionSchema,
  StartCommandRequestSchema,
  createId,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  digestLocalExecutionPhase,
  type CommandAuthorization,
  type CommandSpec,
  type EnvironmentAuthorization,
  type PendingDomainEvent,
  type RepositoryInspection
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import { createManualRun, transitionRun, type DurableStore } from "@autostack/domain";

const uuid = (suffix: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + suffix).padStart(12, "0")}`;

export const NOW = "2026-08-21T12:00:00.000Z";
const EXPIRES_AT = "2026-08-21T16:00:00.000Z";
const REPOSITORY_IDENTITY = "local-sha256:" + "d".repeat(64);
const SOURCE_COMMIT = "b".repeat(40);

export interface SeededRun {
  readonly store: DurableStore;
  readonly directory: string;
  readonly workspaceId: ReturnType<typeof createId<"workspace">>;
  readonly runId: ReturnType<typeof createId<"run">>;
  readonly environmentId: ReturnType<typeof createId<"environment">>;
  readonly environmentAuthorization: EnvironmentAuthorization;
  readonly planApprovalId: ReturnType<typeof createId<"approval">>;
  readonly commandId: ReturnType<typeof createId<"command">>;
  readonly commandAuthorization: CommandAuthorization;
  readonly commandApprovalId: ReturnType<typeof createId<"approval">>;
  readonly command: CommandSpec;
  readonly branchSlug: string;
  readonly branch: string;
  readonly inspection: RepositoryInspection;
}

export interface SeedApprovedRunOptions {
  /** Offsets every seeded UUID so several runs can share one store. */
  readonly seedOffset?: number;
  /** Reuse an already-seeded store instead of opening a fresh database. */
  readonly reuse?: SeededRun;
  /** Withhold the `approval.decided` evidence so authorization lookups fail. */
  readonly planApprovalDecision?: "approved" | "rejected";
}

/**
 * Builds the digest-consistent identity and authorization pair a run stream would carry, without
 * touching a store — enough to construct real `PrepareEnvironmentRequest`/`StartCommandRequest`
 * values for components that only parse them.
 */
export const authorizedIdentity = async (offset = 0) => {
  const workspaceId = createId("workspace", uuid(0));
  const runId = createId("run", uuid(offset + 2));
  const workItemId = createId("workItem", uuid(offset + 1));
  const environmentId = createId("environment", uuid(offset + 3));
  const environmentAuthorizationId = createId("environmentAuthorization", uuid(offset + 4));
  const planApprovalId = createId("approval", uuid(offset + 5));
  const commandId = createId("command", uuid(offset + 6));
  const commandAuthorizationId = createId("commandAuthorization", uuid(offset + 7));
  const commandApprovalId = createId("approval", uuid(offset + 8));
  const branchSlug = `slice-${offset}`;
  const branch = `autostack/${branchSlug}`;
  const resourceLimits = { cpu: 2, memoryMb: 2048, durationSeconds: 120 } as const;
  const command = {
    executable: "/usr/bin/true",
    args: [],
    cwd: ".",
    environment: [],
    timeoutSeconds: 30,
    terminal: { columns: 80, rows: 24 }
  } as const satisfies CommandSpec;

  const executionScope = {
    workspaceId,
    runId,
    environmentId,
    repositoryIdentity: REPOSITORY_IDENTITY,
    sourceCommit: SOURCE_COMMIT,
    branch,
    cwdRoot: ".",
    resourceLimits,
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    allowedCredentialRefIds: []
  };
  const environmentEnvelope = {
    id: environmentAuthorizationId,
    digest: "0".repeat(64),
    approvalId: planApprovalId,
    approvalEvidenceDigest: await digestExecutionScope(executionScope),
    scope: executionScope,
    createdAt: NOW,
    expiresAt: EXPIRES_AT
  } as EnvironmentAuthorization;
  const environmentAuthorization = EnvironmentAuthorizationSchema.parse({
    ...environmentEnvelope,
    digest: await digestEnvironmentAuthorization(environmentEnvelope)
  });

  const commandScope = {
    environmentAuthorizationId,
    environmentAuthorizationDigest: environmentAuthorization.digest,
    workspaceId,
    runId,
    environmentId,
    commandId,
    action: "implement" as const,
    commandDigest: await digestCommandSpec(command),
    repositoryIdentity: REPOSITORY_IDENTITY,
    sourceCommit: SOURCE_COMMIT,
    branch,
    cwdRoot: ".",
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    resourceLimits,
    allowedCredentialRefIds: []
  };
  const commandEnvelope = {
    id: commandAuthorizationId,
    digest: "0".repeat(64),
    approvalId: commandApprovalId,
    approvalEvidenceDigest: await digestCommandScope(commandScope),
    scope: commandScope,
    createdAt: NOW,
    expiresAt: EXPIRES_AT
  } as CommandAuthorization;
  const commandAuthorization = CommandAuthorizationSchema.parse({
    ...commandEnvelope,
    digest: await digestCommandAuthorization(commandEnvelope)
  });

  return {
    workspaceId,
    runId,
    workItemId,
    environmentId,
    environmentAuthorization,
    planApprovalId,
    commandId,
    commandAuthorization,
    commandApprovalId,
    command,
    branchSlug,
    branch,
    inspection: RepositoryInspectionSchema.parse({
      repositoryIdentity: REPOSITORY_IDENTITY,
      canonicalSourcePath: "/repo",
      repositoryCommonDirectory: "/repo/.git",
      resolvedBaseRef: "main",
      sourceCommit: SOURCE_COMMIT,
      dirty: false,
      diagnostics: []
    })
  };
};

/**
 * Seeds a durable run whose stream carries an approved plan, an approved command permission and
 * both authorizations — the exact precondition `EventBackedLocalExecutionState` reconciles from.
 */
export const seedApprovedRun = async (options: SeedApprovedRunOptions = {}): Promise<SeededRun> => {
  const offset = options.seedOffset ?? 0;
  const {
    workspaceId,
    runId,
    workItemId,
    environmentId,
    environmentAuthorization,
    planApprovalId,
    commandId,
    commandAuthorization,
    commandApprovalId,
    command,
    branchSlug,
    branch,
    inspection
  } = await authorizedIdentity(offset);

  let directory = options.reuse?.directory;
  let store = options.reuse?.store;
  if (store === undefined) {
    directory = await mkdtemp(join(tmpdir(), "autostack-control-plane-state-"));
    let eventNumber = 500;
    store = new SqliteDurableStore(openDatabase({ filePath: join(directory, "autostack.sqlite") }), {
      eventId: () => EventIdSchema.parse(`evt_${uuid(eventNumber++)}`),
      leaseToken: () => `lease-${eventNumber}`,
      now: () => NOW
    });
  }

  const actor = { kind: "user" as const, id: "local-user" };
  const correlationId = uuid(offset);
  const seed = createManualRun(
    { title: `Seeded run ${offset}`, description: "Seeded approved local execution." },
    { workspaceId, actor, correlationId },
    { now: () => NOW, ids: { workItem: () => workItemId, run: () => runId } }
  );
  await store.commit({
    idempotency: { scope: `seed:${runId}`, key: "creation" },
    appends: seed.appends,
    jobs: []
  });

  let run = seed.run;
  const events: PendingDomainEvent[] = [];
  for (const to of ["triaging", "planning", "awaiting_plan_approval"] as const) {
    const transition = transitionRun({
      run,
      to,
      reason: "Seeded approved execution.",
      actor,
      correlationId,
      occurredAt: NOW
    });
    run = transition.run;
    events.push(...transition.events);
  }

  const approval = (
    id: typeof planApprovalId,
    kind: "plan" | "permission",
    evidenceDigest: string
  ) =>
    ApprovalSchema.parse({
      schemaVersion: 1,
      id,
      workspaceId,
      runId,
      kind,
      status: "pending",
      evidenceDigest,
      eligibleApproverIds: [actor.id],
      createdAt: NOW,
      updatedAt: NOW
    });
  const planApproval = approval(
    planApprovalId,
    "plan",
    environmentAuthorization.approvalEvidenceDigest
  );
  const commandApproval = approval(
    commandApprovalId,
    "permission",
    commandAuthorization.approvalEvidenceDigest
  );
  const event = (type: string, payload: unknown): PendingDomainEvent =>
    PendingDomainEventSchema.parse({
      workspaceId,
      actor,
      correlationId,
      occurredAt: NOW,
      type,
      payload
    });
  const phaseEvent = async (
    type: "environment.authorization_recorded" | "command.authorization_recorded",
    payload: Record<string, unknown>
  ): Promise<PendingDomainEvent> =>
    PendingDomainEventSchema.parse({
      workspaceId,
      actor,
      correlationId,
      occurredAt: NOW,
      type,
      payload: { ...payload, phaseDigest: await digestLocalExecutionPhase(type, payload) }
    });

  events.push(
    event("approval.requested", { approval: planApproval }),
    event("approval.decided", {
      approvalId: planApprovalId,
      runId,
      decision: options.planApprovalDecision ?? "approved",
      evidenceDigest: planApproval.evidenceDigest,
      origin: "desktop",
      decidedAt: NOW
    })
  );
  if ((options.planApprovalDecision ?? "approved") === "approved") {
    events.push(
      await phaseEvent("environment.authorization_recorded", {
        runId,
        environmentId,
        authorization: environmentAuthorization,
        phaseKey: `environment:${environmentId}:authorization`
      }),
      event("approval.requested", { approval: commandApproval }),
      event("approval.decided", {
        approvalId: commandApprovalId,
        runId,
        decision: "approved",
        evidenceDigest: commandApproval.evidenceDigest,
        origin: "desktop",
        decidedAt: NOW
      }),
      await phaseEvent("command.authorization_recorded", {
        runId,
        environmentId,
        commandId,
        authorization: commandAuthorization,
        phaseKey: `command:${commandId}:authorization`
      })
    );
  }
  events.push(
    ...transitionRun({
      run,
      to: "provisioning",
      reason: "Approvals are complete.",
      actor,
      correlationId,
      occurredAt: NOW
    }).events
  );
  await store.commit({
    idempotency: { scope: `seed:${runId}`, key: "authorization" },
    appends: [{ stream: { kind: "run", id: runId }, expectedVersion: 1, events }],
    jobs: []
  });

  return {
    store,
    directory: directory as string,
    workspaceId,
    runId,
    environmentId,
    environmentAuthorization,
    planApprovalId,
    commandId,
    commandAuthorization,
    commandApprovalId,
    command,
    branchSlug,
    branch,
    inspection
  };
};

export const closeSeededRun = async (seeded: SeededRun): Promise<void> => {
  await seeded.store.close();
  await rm(seeded.directory, { recursive: true, force: true });
};

/** A schema-valid prepare/start pair, built without a store, for parse-only collaborators. */
export const localExecutionRequests = async (offset = 0) => {
  const identity = await authorizedIdentity(offset);
  const prepare = PrepareEnvironmentRequestSchema.parse({
    workspaceId: identity.workspaceId,
    runId: identity.runId,
    environmentId: identity.environmentId,
    inspection: identity.inspection,
    sourceCommit: identity.environmentAuthorization.scope.sourceCommit,
    branch: identity.branch,
    authorization: identity.environmentAuthorization,
    idempotency: { key: `prepare-${offset}` }
  });
  const start = StartCommandRequestSchema.parse({
    workspaceId: identity.workspaceId,
    runId: identity.runId,
    environmentId: identity.environmentId,
    commandId: identity.commandId,
    command: identity.command,
    environmentAuthorizationId: identity.environmentAuthorization.id,
    environmentAuthorizationDigest: identity.environmentAuthorization.digest,
    authorization: identity.commandAuthorization,
    idempotency: { key: `start-${offset}` }
  });
  return { identity, prepare, start };
};

/** The prepared-environment body a host returns for a seeded preparation request. */
export const preparedEnvironmentFor = (
  seeded: Pick<
    SeededRun,
    "environmentId" | "workspaceId" | "runId" | "inspection" | "branch" | "environmentAuthorization"
  >
) =>
  ({
    environment: {
      environmentId: seeded.environmentId,
      workspaceId: seeded.workspaceId,
      runId: seeded.runId,
      repositoryIdentity: seeded.inspection.repositoryIdentity,
      sourceCommit: seeded.inspection.sourceCommit,
      branch: seeded.branch,
      authorization: seeded.environmentAuthorization,
      state: "prepared" as const,
      preparedAt: NOW
    },
    replayed: false
  }) as const;
