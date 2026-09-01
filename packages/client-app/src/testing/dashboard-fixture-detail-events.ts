import type { DashboardEventStream } from "./dashboard-fixture-support.js";
import { createDeterministicDigestFactory } from "./dashboard-fixture-support.js";
import {
  AGT_ACTIVE_IMPLEMENTING,
  AGT_ACTIVE_REVIEWING,
  AGT_FAST,
  APR_PERMISSION_REVIEWING,
  APR_PLAN_FAST,
  APR_PLAN_PENDING,
  APR_PUBLISH_FAST,
  CMD_ACTIVE_IMPLEMENTING,
  CMD_ACTIVE_REVIEWING,
  CMD_FAILED_IMPLEMENT,
  CMD_FAST_IMPLEMENT,
  CMD_FAST_PUBLISH,
  ENV_ACTIVE_IMPLEMENTING,
  ENV_ACTIVE_REVIEWING,
  ENV_FAILED,
  ENV_FAST,
  RUN_ACTIVE_IMPLEMENTING,
  RUN_ACTIVE_REVIEWING,
  RUN_AWAITING_PLAN_APPROVAL,
  RUN_COMPLETED_FAST,
  RUN_FAILED,
  RUN_NEEDS_CLARIFICATION,
  WI_API_1,
  WORKSPACE_ID
} from "./dashboard-fixture-ids.js";

const nextDigest = createDeterministicDigestFactory();

function seedApprovalRequested(
  stream: DashboardEventStream,
  params: {
    readonly approvalId: string;
    readonly runId: string;
    readonly kind: "plan" | "publish" | "permission";
    readonly requestedAt: string;
    readonly evidenceDigest: string;
  }
): void {
  stream.emit(
    {
      type: "approval.requested",
      payload: {
        approval: {
          schemaVersion: 1,
          id: params.approvalId,
          workspaceId: WORKSPACE_ID,
          runId: params.runId,
          kind: params.kind,
          status: "pending",
          evidenceDigest: params.evidenceDigest,
          eligibleApproverIds: ["fixture-approver-1"],
          createdAt: params.requestedAt,
          updatedAt: params.requestedAt
        }
      }
    },
    { kind: "run", id: params.runId },
    params.requestedAt
  );
}

function seedApprovalDecided(
  stream: DashboardEventStream,
  params: {
    readonly approvalId: string;
    readonly runId: string;
    readonly evidenceDigest: string;
    readonly decidedAt: string;
    readonly origin: "web" | "desktop" | "cli";
  }
): void {
  stream.emit(
    {
      type: "approval.decided",
      payload: {
        approvalId: params.approvalId,
        runId: params.runId,
        decision: "approved",
        evidenceDigest: params.evidenceDigest,
        origin: params.origin,
        decidedAt: params.decidedAt
      }
    },
    { kind: "run", id: params.runId },
    params.decidedAt
  );
}

/**
 * The fixture's 4 approvals, 3 decided with known request -> decide gaps (composition table):
 * request 10:00:15Z -> decide 10:01:15Z = 60s; request 10:04:30Z -> decide 10:05:00Z = 30s;
 * request 09:17:35Z -> decide 09:19:35Z = 120s. Sorted [30s, 60s, 120s] -> median 60s. The fourth
 * approval is requested and never decided — this run is literally "waiting on approval".
 */
export function seedDashboardApprovals(stream: DashboardEventStream): void {
  const planFastDigest = nextDigest();
  seedApprovalRequested(stream, {
    approvalId: APR_PLAN_FAST,
    runId: RUN_COMPLETED_FAST,
    kind: "plan",
    requestedAt: "2026-08-20T10:00:15.000Z",
    evidenceDigest: planFastDigest
  });
  seedApprovalDecided(stream, {
    approvalId: APR_PLAN_FAST,
    runId: RUN_COMPLETED_FAST,
    evidenceDigest: planFastDigest,
    decidedAt: "2026-08-20T10:01:15.000Z",
    origin: "web"
  });

  const publishFastDigest = nextDigest();
  seedApprovalRequested(stream, {
    approvalId: APR_PUBLISH_FAST,
    runId: RUN_COMPLETED_FAST,
    kind: "publish",
    requestedAt: "2026-08-20T10:04:30.000Z",
    evidenceDigest: publishFastDigest
  });
  seedApprovalDecided(stream, {
    approvalId: APR_PUBLISH_FAST,
    runId: RUN_COMPLETED_FAST,
    evidenceDigest: publishFastDigest,
    decidedAt: "2026-08-20T10:05:00.000Z",
    origin: "desktop"
  });

  const permissionReviewingDigest = nextDigest();
  seedApprovalRequested(stream, {
    approvalId: APR_PERMISSION_REVIEWING,
    runId: RUN_ACTIVE_REVIEWING,
    kind: "permission",
    requestedAt: "2026-08-20T09:17:35.000Z",
    evidenceDigest: permissionReviewingDigest
  });
  seedApprovalDecided(stream, {
    approvalId: APR_PERMISSION_REVIEWING,
    runId: RUN_ACTIVE_REVIEWING,
    evidenceDigest: permissionReviewingDigest,
    decidedAt: "2026-08-20T09:19:35.000Z",
    origin: "cli"
  });

  seedApprovalRequested(stream, {
    approvalId: APR_PLAN_PENDING,
    runId: RUN_AWAITING_PLAN_APPROVAL,
    kind: "plan",
    requestedAt: "2026-08-20T09:25:30.000Z",
    evidenceDigest: nextDigest()
  });
}

function seedCommandCompleted(
  stream: DashboardEventStream,
  params: {
    readonly commandId: string;
    readonly runId: string;
    readonly environmentId: string;
    readonly terminalSequence: number;
    readonly completedAt: string;
  }
): void {
  stream.emit(
    {
      type: "command.completed",
      payload: {
        runId: params.runId,
        environmentId: params.environmentId,
        commandId: params.commandId,
        terminalSequence: params.terminalSequence,
        terminalDigest: nextDigest(),
        status: "completed",
        completedAt: params.completedAt,
        phaseKey: `command:${params.commandId}:completed`,
        phaseDigest: nextDigest()
      }
    },
    { kind: "run", id: params.runId },
    params.completedAt
  );
}

/** The fixture's 5 `command.completed` events, spread across 4 runs (composition table). */
export function seedDashboardCommands(stream: DashboardEventStream): void {
  seedCommandCompleted(stream, {
    commandId: CMD_FAST_IMPLEMENT,
    runId: RUN_COMPLETED_FAST,
    environmentId: ENV_FAST,
    terminalSequence: 1,
    completedAt: "2026-08-20T10:03:00.000Z"
  });
  seedCommandCompleted(stream, {
    commandId: CMD_FAST_PUBLISH,
    runId: RUN_COMPLETED_FAST,
    environmentId: ENV_FAST,
    terminalSequence: 2,
    completedAt: "2026-08-20T10:05:10.000Z"
  });
  seedCommandCompleted(stream, {
    commandId: CMD_FAILED_IMPLEMENT,
    runId: RUN_FAILED,
    environmentId: ENV_FAILED,
    terminalSequence: 1,
    completedAt: "2026-08-20T09:03:00.000Z"
  });
  seedCommandCompleted(stream, {
    commandId: CMD_ACTIVE_IMPLEMENTING,
    runId: RUN_ACTIVE_IMPLEMENTING,
    environmentId: ENV_ACTIVE_IMPLEMENTING,
    terminalSequence: 1,
    completedAt: "2026-08-20T09:12:45.000Z"
  });
  seedCommandCompleted(stream, {
    commandId: CMD_ACTIVE_REVIEWING,
    runId: RUN_ACTIVE_REVIEWING,
    environmentId: ENV_ACTIVE_REVIEWING,
    terminalSequence: 1,
    completedAt: "2026-08-20T09:18:50.000Z"
  });
}

type ReportedOrUnknown =
  { readonly state: "reported"; readonly value: number } | { readonly state: "unknown" };

function seedUsageEvent(
  stream: DashboardEventStream,
  params: {
    readonly runId: string;
    readonly agentSessionId: string;
    readonly occurredAt: string;
    readonly tokens: {
      readonly input: ReportedOrUnknown;
      readonly output: ReportedOrUnknown;
      readonly cachedInput: ReportedOrUnknown;
      readonly reasoning: ReportedOrUnknown;
    };
    readonly cost:
      | { readonly state: "reported"; readonly currency: "USD"; readonly micros: number }
      | { readonly state: "unknown" };
  }
): void {
  stream.emit(
    {
      type: "agent.session_event",
      payload: {
        runId: params.runId,
        stage: "implement",
        agentSessionId: params.agentSessionId,
        sequence: 1,
        event: {
          schemaVersion: 1,
          sessionId: params.agentSessionId,
          sequence: 1,
          occurredAt: params.occurredAt,
          type: "usage",
          tokens: params.tokens,
          cost: params.cost
        }
      }
    },
    { kind: "run", id: params.runId },
    params.occurredAt
  );
}

/**
 * The fixture's 3 `agent.session_event` usage detail events (D4 revised). Reported sums and
 * unknown counts, hand-computed here and re-derived by the fixture-integrity test directly from
 * these three events:
 *
 * U1 (run_completed_fast): every field reported, none zero -> the "fully reported" run.
 * U2 (run_active_implementing): output/cachedInput unknown, reasoning reported 0 -> unknown
 *   members AND a reported-zero in the same event.
 * U3 (run_active_reviewing): input/cachedInput/reasoning reported 0, cost reported 0 -> the
 *   falsy-zero trap in isolation (nothing here is unknown).
 *
 * reported input sum  = 1000 (U1) +  800 (U2) +   0 (U3) = 1800
 * reported output sum =  500 (U1) +    - (U2, unknown) + 200 (U3) =  700
 * reported cachedInput = 100 (U1) +    - (U2, unknown) +   0 (U3) =  100
 * reported reasoning   =  50 (U1) +    0 (U2) +   0 (U3) =   50
 * token-field unknown count = 2 (U2's output + cachedInput)
 * reported cost sum (micros) = 300_000 (U1) + 0 (U3) = 300_000; cost unknown count = 1 (U2)
 */
export function seedDashboardUsageEvents(stream: DashboardEventStream): void {
  seedUsageEvent(stream, {
    runId: RUN_COMPLETED_FAST,
    agentSessionId: AGT_FAST,
    occurredAt: "2026-08-20T10:02:40.000Z",
    tokens: {
      input: { state: "reported", value: 1000 },
      output: { state: "reported", value: 500 },
      cachedInput: { state: "reported", value: 100 },
      reasoning: { state: "reported", value: 50 }
    },
    cost: { state: "reported", currency: "USD", micros: 300_000 }
  });
  seedUsageEvent(stream, {
    runId: RUN_ACTIVE_IMPLEMENTING,
    agentSessionId: AGT_ACTIVE_IMPLEMENTING,
    occurredAt: "2026-08-20T09:12:30.000Z",
    tokens: {
      input: { state: "reported", value: 800 },
      output: { state: "unknown" },
      cachedInput: { state: "unknown" },
      reasoning: { state: "reported", value: 0 }
    },
    cost: { state: "unknown" }
  });
  seedUsageEvent(stream, {
    runId: RUN_ACTIVE_REVIEWING,
    agentSessionId: AGT_ACTIVE_REVIEWING,
    occurredAt: "2026-08-20T09:17:50.000Z",
    tokens: {
      input: { state: "reported", value: 0 },
      output: { state: "reported", value: 200 },
      cachedInput: { state: "reported", value: 0 },
      reasoning: { state: "reported", value: 0 }
    },
    cost: { state: "reported", currency: "USD", micros: 0 }
  });
}

/** The fixture's 1 `clarification.requested` event — unanswered, matching run_needs_clarification. */
export function seedDashboardClarification(stream: DashboardEventStream): void {
  stream.emit(
    {
      type: "clarification.requested",
      payload: {
        runId: RUN_NEEDS_CLARIFICATION,
        request: {
          schemaVersion: 1,
          workspaceId: WORKSPACE_ID,
          workItemId: WI_API_1,
          runId: RUN_NEEDS_CLARIFICATION,
          clarificationRef: "clarify.scope.1",
          stage: "triage",
          question: "Which repository branch should this change target?",
          evidenceDigest: nextDigest(),
          requestedAt: "2026-08-20T09:31:00.000Z"
        }
      }
    },
    { kind: "run", id: RUN_NEEDS_CLARIFICATION },
    "2026-08-20T09:31:00.000Z"
  );
}
