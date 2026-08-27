import {
  ApprovalSchema,
  RUN_STATUSES,
  RunSchema,
  StoredDomainEventSchema,
  WorkItemSchema,
  WorkspaceIdSchema,
  type Approval,
  type IdKind,
  type Run,
  type RunStage,
  type RunStatus,
  type SourceRef,
  type StoredDomainEvent,
  type WorkItem,
  type WorkspaceId
} from "@autostack/contracts";

import {
  buildDeterministicUuid,
  createDeterministicClock,
  createDeterministicIdFactory
} from "./deterministic-ids.js";

/** The world `seedFactoryFixture` produces: every value already validated against its own schema. */
export interface FactoryFixture {
  readonly workspaceId: WorkspaceId;
  readonly workItems: readonly WorkItem[];
  readonly runs: readonly Run[];
  readonly approvals: readonly Approval[];
  readonly events: readonly StoredDomainEvent[];
}

export interface FactoryFixtureOptions {
  readonly workspaceId?: WorkspaceId;
  /** Injected clock. Defaults to a deterministic, incrementing instant — never `Date.now()`. */
  readonly now?: () => string;
  /** Injected ID source. Defaults to a deterministic counter — never `crypto.randomUUID()`. */
  readonly nextId?: (kind: IdKind) => string;
  /** How many synthetic, all-`pending` approvals to generate for pagination scenarios. */
  readonly approvalCount?: number;
  /** Explicit approval candidates, still schema-parsed. Overrides `approvalCount`. */
  readonly approvals?: readonly unknown[];
  /** Explicit run candidates, still schema-parsed. */
  readonly runs?: readonly unknown[];
}

const at = <T>(array: readonly T[], index: number): T => {
  const value = array[index];
  if (value === undefined) throw new RangeError(`Fixture index ${index} is out of bounds.`);
  return value;
};

const SOURCE_REFS: readonly SourceRef[] = [
  { kind: "manual", client: "web" },
  {
    kind: "github",
    repositoryFullName: "autostack/factory",
    issueNumber: 42,
    deliveryId: "fixture-github-delivery-1"
  },
  {
    kind: "slack",
    slackWorkspaceId: "T0FIXTURE1",
    channelId: "C0FIXTURE1",
    threadTs: "1700000000.000100",
    deliveryId: "fixture-slack-delivery-1"
  },
  { kind: "api", clientId: "fixture-api-client", deliveryId: "fixture-api-delivery-1" }
];

const STAGE_BY_STATUS: Readonly<Partial<Record<RunStatus, RunStage>>> = {
  triaging: "triage",
  planning: "plan",
  awaiting_plan_approval: "plan",
  provisioning: "implement",
  implementing: "implement",
  verifying: "verify",
  reviewing: "review",
  awaiting_publish_approval: "publish",
  publishing: "publish"
};

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "cancelled", "failed"]);

const APPROVAL_KINDS = ["plan", "publish", "permission"] as const;
const APPROVAL_STATUSES = ["pending", "approved", "rejected", "stale"] as const;

/**
 * A deterministic, injectable replacement for a SHA-256 hex digest. Not a real hash — a stand-in
 * that satisfies `evidenceDigest`'s `/^[0-9a-f]{64}$/` shape while staying reproducible.
 */
function createDeterministicDigestFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return counter.toString(16).padStart(64, "0");
  };
}

function buildWorkItems(
  workspaceId: WorkspaceId,
  nextId: (kind: IdKind) => string,
  now: () => string
): readonly WorkItem[] {
  return SOURCE_REFS.map((source, index) => {
    const createdAt = now();
    return WorkItemSchema.parse({
      schemaVersion: 1,
      id: nextId("workItem"),
      workspaceId,
      source,
      title: `Fixture work item ${index + 1} (${source.kind})`,
      description: "",
      requester: { externalId: `fixture-requester-${index + 1}` },
      attachments: [],
      priority: "normal",
      labels: [],
      acceptanceContext: [],
      createdAt,
      updatedAt: createdAt
    });
  });
}

function buildRuns(
  workspaceId: WorkspaceId,
  workItems: readonly WorkItem[],
  nextId: (kind: IdKind) => string,
  now: () => string
): readonly Run[] {
  return RUN_STATUSES.map((status, index) => {
    const workItem = at(workItems, index % workItems.length);
    const createdAt = now();
    const stage = STAGE_BY_STATUS[status];
    const isTerminal = TERMINAL_RUN_STATUSES.has(status);
    return RunSchema.parse({
      schemaVersion: 1,
      id: nextId("run"),
      workspaceId,
      workItemId: workItem.id,
      workflowVersion: "fixture-v1",
      status,
      ...(stage === undefined ? {} : { currentStage: stage }),
      createdAt,
      updatedAt: createdAt,
      ...(isTerminal ? { completedAt: createdAt } : {})
    });
  });
}

function buildApproval(params: {
  readonly workspaceId: WorkspaceId;
  readonly runId: string;
  readonly kind: (typeof APPROVAL_KINDS)[number];
  readonly status: (typeof APPROVAL_STATUSES)[number];
  readonly nextId: (kind: IdKind) => string;
  readonly now: () => string;
  readonly nextDigest: () => string;
}): Approval {
  const requestedAt = params.now();
  const isDecided = params.status === "approved" || params.status === "rejected";
  const decidedAt = isDecided ? params.now() : undefined;
  return ApprovalSchema.parse({
    schemaVersion: 1,
    id: params.nextId("approval"),
    workspaceId: params.workspaceId,
    runId: params.runId,
    kind: params.kind,
    status: params.status,
    evidenceDigest: params.nextDigest(),
    eligibleApproverIds: ["fixture-approver"],
    ...(decidedAt === undefined
      ? {}
      : {
          decision: {
            decision: params.status,
            actor: { kind: "system", id: "fixture-seed" },
            origin: "api",
            decidedAt
          }
        }),
    createdAt: requestedAt,
    updatedAt: decidedAt ?? requestedAt
  });
}

function buildApprovals(
  workspaceId: WorkspaceId,
  runs: readonly Run[],
  options: Pick<FactoryFixtureOptions, "approvals" | "approvalCount">,
  nextId: (kind: IdKind) => string,
  now: () => string
): readonly Approval[] {
  const nextDigest = createDeterministicDigestFactory();
  const build = (
    index: number,
    kind: (typeof APPROVAL_KINDS)[number],
    status: (typeof APPROVAL_STATUSES)[number]
  ) =>
    buildApproval({
      workspaceId,
      runId: at(runs, index % runs.length).id,
      kind,
      status,
      nextId,
      now,
      nextDigest
    });

  if (options.approvals !== undefined) {
    return options.approvals.map((candidate) => ApprovalSchema.parse(candidate));
  }

  if (options.approvalCount !== undefined) {
    return Array.from({ length: options.approvalCount }, (_unused, index) =>
      build(index, at(APPROVAL_KINDS, index % APPROVAL_KINDS.length), "pending")
    );
  }

  const combinations = APPROVAL_KINDS.flatMap((kind) =>
    APPROVAL_STATUSES.map((status) => ({ kind, status }))
  );
  return combinations.map((combination, index) =>
    build(index, combination.kind, combination.status)
  );
}

interface EventStream {
  readonly events: readonly StoredDomainEvent[];
  workItemCreated(workItem: WorkItem): void;
  runCreated(run: Run): void;
  runTransitioned(run: Run, from: RunStatus): void;
  approvalRequested(approval: Approval): void;
  approvalDecided(approval: Approval): void;
}

function createEventStream(
  workspaceId: WorkspaceId,
  nextId: (kind: IdKind) => string,
  now: () => string
): EventStream {
  const events: StoredDomainEvent[] = [];
  const streamVersions = new Map<string, number>();
  let globalSequence = 0;
  let correlationCounter = 0;

  const nextStreamVersion = (kind: string, id: string): number => {
    const key = `${kind}:${id}`;
    const version = (streamVersions.get(key) ?? 0) + 1;
    streamVersions.set(key, version);
    return version;
  };

  const record = (
    body: { readonly type: string; readonly payload: unknown },
    stream: { readonly kind: "work_item" | "run"; readonly id: string }
  ): void => {
    globalSequence += 1;
    correlationCounter += 1;
    events.push(
      StoredDomainEventSchema.parse({
        workspaceId,
        actor: { kind: "system", id: "fixture-seed" },
        correlationId: buildDeterministicUuid(1_000_000 + correlationCounter),
        occurredAt: now(),
        ...body,
        eventId: nextId("event"),
        stream,
        streamVersion: nextStreamVersion(stream.kind, stream.id),
        globalSequence,
        schemaVersion: 1
      })
    );
  };

  return {
    events,
    workItemCreated(workItem) {
      record(
        { type: "work_item.created", payload: { workItem } },
        { kind: "work_item", id: workItem.id }
      );
    },
    runCreated(run) {
      record({ type: "run.created", payload: { run } }, { kind: "run", id: run.id });
    },
    runTransitioned(run, from) {
      record(
        {
          type: "run.transitioned",
          payload: { runId: run.id, from, to: run.status, reason: "Fixture-seeded transition." }
        },
        { kind: "run", id: run.id }
      );
    },
    approvalRequested(approval) {
      record(
        { type: "approval.requested", payload: { approval } },
        { kind: "run", id: approval.runId }
      );
    },
    approvalDecided(approval) {
      const decision = approval.decision;
      if (decision === undefined) return;
      record(
        {
          type: "approval.decided",
          payload: {
            approvalId: approval.id,
            runId: approval.runId,
            decision: decision.decision,
            evidenceDigest: approval.evidenceDigest,
            origin: decision.origin,
            decidedAt: decision.decidedAt
          }
        },
        { kind: "run", id: approval.runId }
      );
    }
  };
}

/**
 * Builds a deterministic, internally consistent factory world: a workspace, work items covering
 * every `SourceRef` kind, runs spanning every `RUN_STATUSES` member, approvals spanning every
 * `kind` and `status`, and the `StoredDomainEvent` stream that would have produced them.
 *
 * Every produced value is parsed through its own contract schema here, so a malformed fixture
 * (whether generated or passed in via `approvals`/`runs`) fails at construction, not at first use.
 */
export function seedFactoryFixture(options: FactoryFixtureOptions = {}): FactoryFixture {
  const now = options.now ?? createDeterministicClock();
  const defaultNextId = createDeterministicIdFactory();
  const nextId: (kind: IdKind) => string = options.nextId ?? ((kind) => defaultNextId(kind));

  const workspaceId = options.workspaceId ?? WorkspaceIdSchema.parse(nextId("workspace"));

  const workItems = buildWorkItems(workspaceId, nextId, now);
  const runs =
    options.runs === undefined
      ? buildRuns(workspaceId, workItems, nextId, now)
      : options.runs.map((candidate) => RunSchema.parse(candidate));
  const approvals = buildApprovals(workspaceId, runs, options, nextId, now);

  const stream = createEventStream(workspaceId, nextId, now);
  for (const workItem of workItems) stream.workItemCreated(workItem);
  for (const run of runs) {
    stream.runCreated(run);
    if (run.status !== "queued") stream.runTransitioned(run, "queued");
  }
  for (const approval of approvals) {
    stream.approvalRequested(approval);
    stream.approvalDecided(approval);
  }

  return { workspaceId, workItems, runs, approvals, events: stream.events };
}
