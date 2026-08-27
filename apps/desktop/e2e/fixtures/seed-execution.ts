import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  ApprovalSchema,
  CommandAuthorizationSchema,
  EnvironmentAuthorizationSchema,
  EventIdSchema,
  PendingDomainEventSchema,
  WorkspaceIdSchema,
  createId,
  digestCommandAuthorization,
  digestCommandScope,
  digestCommandSpec,
  digestEnvironmentAuthorization,
  digestExecutionScope,
  digestLocalExecutionPhase,
  validateRunStreamCoherence,
  type CommandAuthorization,
  type CommandSpec,
  type EnvironmentAuthorization,
  type PendingDomainEvent
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import { createManualRun, transitionRun } from "@autostack/domain";

import type { TestRepositoryScenario } from "./test-repository.js";

const UUIDS = {
  workspace: "123e4567-e89b-42d3-a456-426614174000",
  workItem: "123e4567-e89b-42d3-a456-426614174001",
  run: "123e4567-e89b-42d3-a456-426614174002",
  environment: "123e4567-e89b-42d3-a456-426614174003",
  environmentAuthorization: "123e4567-e89b-42d3-a456-426614174004",
  planApproval: "123e4567-e89b-42d3-a456-426614174005",
  command: "123e4567-e89b-42d3-a456-426614174006",
  commandAuthorization: "123e4567-e89b-42d3-a456-426614174007",
  commandApproval: "123e4567-e89b-42d3-a456-426614174008"
} as const;

export interface SeededExecution {
  readonly workspaceId: ReturnType<typeof createId<"workspace">>;
  readonly runId: ReturnType<typeof createId<"run">>;
  readonly environmentId: ReturnType<typeof createId<"environment">>;
  readonly environmentAuthorizationId: ReturnType<typeof createId<"environmentAuthorization">>;
  readonly commandId: ReturnType<typeof createId<"command">>;
  readonly commandAuthorizationId: ReturnType<typeof createId<"commandAuthorization">>;
  readonly command: CommandSpec;
  readonly branchSlug: string;
}

export const seedApprovedExecution = async (
  scenario: TestRepositoryScenario
): Promise<SeededExecution> => {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 4 * 60 * 60 * 1_000).toISOString();
  const workspaceId = createId("workspace", UUIDS.workspace);
  const workItemId = createId("workItem", UUIDS.workItem);
  const runId = createId("run", UUIDS.run);
  const environmentId = createId("environment", UUIDS.environment);
  const environmentAuthorizationId = createId(
    "environmentAuthorization",
    UUIDS.environmentAuthorization
  );
  const planApprovalId = createId("approval", UUIDS.planApproval);
  const commandId = createId("command", UUIDS.command);
  const commandAuthorizationId = createId("commandAuthorization", UUIDS.commandAuthorization);
  const commandApprovalId = createId("approval", UUIDS.commandApproval);
  const branchSlug = "task10-local-slice";
  const branch = `autostack/${branchSlug}`;
  const commonDirectory = await realpath(join(scenario.source, ".git"));
  const repositoryIdentity = `local-sha256:${createHash("sha256")
    .update(commonDirectory)
    .digest("hex")}`;
  const resourceLimits = { cpu: 2, memoryMb: 2048, durationSeconds: 120 } as const;
  const command = {
    executable: process.execPath,
    args: ["fixture-command.mjs", "produce"],
    cwd: ".",
    environment: [],
    timeoutSeconds: 30,
    terminal: { columns: 80, rows: 24 }
  } as const satisfies CommandSpec;
  const executionScope = {
    workspaceId,
    runId,
    environmentId,
    repositoryIdentity,
    sourceCommit: scenario.initial.head,
    branch,
    cwdRoot: ".",
    resourceLimits,
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    allowedCredentialRefIds: []
  };
  let environmentAuthorization = {
    id: environmentAuthorizationId,
    digest: "0".repeat(64),
    approvalId: planApprovalId,
    approvalEvidenceDigest: await digestExecutionScope(executionScope),
    scope: executionScope,
    createdAt: now,
    expiresAt
  } as EnvironmentAuthorization;
  environmentAuthorization = EnvironmentAuthorizationSchema.parse({
    ...environmentAuthorization,
    digest: await digestEnvironmentAuthorization(environmentAuthorization)
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
    repositoryIdentity,
    sourceCommit: scenario.initial.head,
    branch,
    cwdRoot: ".",
    networkPolicy: "host" as const,
    filesystemDisclosure: "host_user" as const,
    resourceLimits,
    allowedCredentialRefIds: []
  };
  let commandAuthorization = {
    id: commandAuthorizationId,
    digest: "0".repeat(64),
    approvalId: commandApprovalId,
    approvalEvidenceDigest: await digestCommandScope(commandScope),
    scope: commandScope,
    createdAt: now,
    expiresAt
  } as CommandAuthorization;
  commandAuthorization = CommandAuthorizationSchema.parse({
    ...commandAuthorization,
    digest: await digestCommandAuthorization(commandAuthorization)
  });
  const actor = { kind: "user" as const, id: "local-user" };
  const correlationId = UUIDS.workspace;
  const context = { workspaceId, actor, correlationId };
  const seed = createManualRun(
    { title: "Task 10 local execution", description: "Seeded approved local execution." },
    context,
    {
      now: () => now,
      ids: { workItem: () => workItemId, run: () => runId }
    }
  );
  const controlPlaneRoot = join(scenario.userData, "private", "control-plane");
  await mkdir(controlPlaneRoot, { recursive: true, mode: 0o700 });
  const database = openDatabase({ filePath: join(controlPlaneRoot, "autostack.sqlite") });
  let eventNumber = 100;
  const store = new SqliteDurableStore(database, {
    eventId: () =>
      EventIdSchema.parse(
        `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventNumber++).padStart(12, "0")}`
      ),
    leaseToken: () => `task10-lease-${eventNumber}`,
    now: () => now
  });
  await store.commit({
    idempotency: { scope: "task10:seed", key: "creation" },
    appends: seed.appends,
    jobs: []
  });

  let run = seed.run;
  const events: PendingDomainEvent[] = [];
  for (const to of ["triaging", "planning", "awaiting_plan_approval"] as const) {
    const transition = transitionRun({
      run,
      to,
      reason: "Task 10 approved execution seed.",
      actor,
      correlationId,
      occurredAt: now
    });
    run = transition.run;
    events.push(...transition.events);
  }
  const planApproval = ApprovalSchema.parse({
    schemaVersion: 1,
    id: planApprovalId,
    workspaceId,
    runId,
    kind: "plan",
    status: "pending",
    evidenceDigest: environmentAuthorization.approvalEvidenceDigest,
    eligibleApproverIds: [actor.id],
    createdAt: now,
    updatedAt: now
  });
  const commandApproval = ApprovalSchema.parse({
    schemaVersion: 1,
    id: commandApprovalId,
    workspaceId,
    runId,
    kind: "permission",
    status: "pending",
    evidenceDigest: commandAuthorization.approvalEvidenceDigest,
    eligibleApproverIds: [actor.id],
    createdAt: now,
    updatedAt: now
  });
  const event = (type: string, payload: unknown): PendingDomainEvent =>
    PendingDomainEventSchema.parse({
      workspaceId,
      actor,
      correlationId,
      occurredAt: now,
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
      occurredAt: now,
      type,
      payload: { ...payload, phaseDigest: await digestLocalExecutionPhase(type, payload) }
    });
  events.push(
    event("approval.requested", { approval: planApproval }),
    event("approval.decided", {
      approvalId: planApprovalId,
      runId,
      decision: "approved",
      evidenceDigest: planApproval.evidenceDigest,
      origin: "desktop",
      decidedAt: now
    }),
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
      decidedAt: now
    }),
    await phaseEvent("command.authorization_recorded", {
      runId,
      environmentId,
      commandId,
      authorization: commandAuthorization,
      phaseKey: `command:${commandId}:authorization`
    })
  );
  const provisioning = transitionRun({
    run,
    to: "provisioning",
    reason: "Task 10 approvals are complete.",
    actor,
    correlationId,
    occurredAt: now
  });
  events.push(...provisioning.events);
  await store.commit({
    idempotency: { scope: "task10:seed", key: "authorization" },
    appends: [{ stream: { kind: "run", id: runId }, expectedVersion: 1, events }],
    jobs: []
  });
  await validateRunStreamCoherence(
    await store.readRunEvents({
      workspaceId: WorkspaceIdSchema.parse(workspaceId),
      runId,
      limit: 100
    })
  );
  await store.close();
  return {
    workspaceId,
    runId,
    environmentId,
    environmentAuthorizationId,
    commandId,
    commandAuthorizationId,
    command,
    branchSlug
  };
};
