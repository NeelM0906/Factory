import {
  ApiErrorSchema,
  type AnswerClarificationResponse,
  type ApiError,
  type Approval,
  type ApprovalDecisionResponse,
  type Run,
  type WorkItem,
  type WorkspaceId
} from "@autostack/contracts";

import type { FactoryFixture } from "./factory-fixture.js";

export type MockApiRoute =
  | "health"
  | "listRuns"
  | "listRunEvents"
  | "createRun"
  | "listApprovals"
  | "decideApproval"
  | "steerRun"
  | "cancelRun"
  | "answerClarification";

/**
 * `conflict` exists because three of the client's four 409 branches are otherwise unreachable:
 * only the approval-decision route produces a 409 from real business logic (stale evidence or a
 * conflicting decision), so `listApprovals`, `steerRun`, and `cancelRun` could map 409 to
 * `ApiConflictError` incorrectly and no test would notice. A 409 on those routes is real — the
 * control plane can return `idempotency_conflict` for a reused key — so the branch is worth
 * keeping, and worth being able to exercise.
 */
export type MockApiFailureMode = "unauthorized" | "network" | "malformed" | "conflict";

export type MockApiServerFailures = Readonly<Partial<Record<MockApiRoute, MockApiFailureMode>>>;

export interface MockApiRequest {
  readonly method?: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: HeadersInit;
  readonly body?: unknown;
}

export interface MockApiServerOptions {
  readonly fixture: FactoryFixture;
  readonly failures?: MockApiServerFailures;
  /**
   * Injected clock for every timestamp the server mints on a mutating route (run creation,
   * approval decision, steer, cancel). Defaults to a fresh deterministic clock — never
   * `Date.now()` — so two servers built from the same options and driven through the same
   * request sequence produce byte-identical timestamps, which is what makes the D2 replay
   * assertion ("the original `decidedAt`") a real check rather than one that can pass by
   * millisecond coincidence.
   */
  readonly now?: () => string;
}

export interface MockApiServer {
  handle(request: MockApiRequest): Promise<unknown>;
  readonly fetch: typeof globalThis.fetch;
}

export type ApiErrorCode = ApiError["error"]["code"];

export interface ResolvedResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ServerState {
  readonly workspaceId: WorkspaceId;
  readonly workItems: ReadonlyMap<string, WorkItem>;
  readonly runs: ReadonlyMap<string, Run>;
  readonly approvals: ReadonlyMap<string, Approval>;
  readonly events: FactoryFixture["events"];
  readonly decisionReplays: ReadonlyMap<string, ApprovalDecisionResponse>;
  /** Keyed `${runId}:${clarificationRef}:${answer}` — server-derived, same shape as decisions. */
  readonly answerReplays: ReadonlyMap<string, AnswerClarificationResponse>;
}

export type RouteMatch =
  | { readonly route: "health" }
  | { readonly route: "listRuns" }
  | { readonly route: "listRunEvents"; readonly runId: string }
  | { readonly route: "createRun" }
  | { readonly route: "listApprovals" }
  | { readonly route: "decideApproval"; readonly runId: string; readonly approvalId: string }
  | { readonly route: "steerRun"; readonly runId: string }
  | { readonly route: "cancelRun"; readonly runId: string }
  | {
      readonly route: "answerClarification";
      readonly runId: string;
      readonly clarificationRef: string;
    };

export const errorResponse = (
  status: number,
  code: ApiErrorCode,
  message: string
): ResolvedResponse => ({
  status,
  body: ApiErrorSchema.parse({ error: { code, message } })
});

const capitalize = (value: string): string => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

export function matchRoute(method: string, path: string): RouteMatch | undefined {
  if (method === "GET" && path === "/v1/health") return { route: "health" };
  if (method === "GET" && path === "/v1/runs") return { route: "listRuns" };
  if (method === "POST" && path === "/v1/runs") return { route: "createRun" };
  if (method === "GET" && path === "/v1/approvals") return { route: "listApprovals" };

  const eventsMatch = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
  if (method === "GET" && eventsMatch)
    return { route: "listRunEvents", runId: eventsMatch[1] ?? "" };

  const decisionMatch = /^\/v1\/runs\/([^/]+)\/approvals\/([^/]+)\/decision$/.exec(path);
  if (method === "POST" && decisionMatch) {
    return {
      route: "decideApproval",
      runId: decisionMatch[1] ?? "",
      approvalId: decisionMatch[2] ?? ""
    };
  }

  const steerMatch = /^\/v1\/runs\/([^/]+)\/steer$/.exec(path);
  if (method === "POST" && steerMatch) return { route: "steerRun", runId: steerMatch[1] ?? "" };

  const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
  if (method === "POST" && cancelMatch) return { route: "cancelRun", runId: cancelMatch[1] ?? "" };

  const answerMatch = /^\/v1\/runs\/([^/]+)\/clarifications\/([^/]+)\/answer$/.exec(path);
  if (method === "POST" && answerMatch) {
    return {
      route: "answerClarification",
      runId: answerMatch[1] ?? "",
      clarificationRef: answerMatch[2] ?? ""
    };
  }

  return undefined;
}

export function extractBearerToken(headers: HeadersInit | undefined): string | undefined {
  const raw = new Headers(headers).get("authorization");
  if (raw === null) return undefined;
  const token = /^Bearer\s+(.+)$/.exec(raw)?.[1];
  return token === undefined ? undefined : token.trim();
}

export type ParsedQueryInt = { readonly ok: true; readonly value: number } | { readonly ok: false };

/** A non-negative integer query value (`cursor` offset or `after` sequence), defaulting to 0. */
export function parseNonNegativeIntQuery(value: string | undefined): ParsedQueryInt {
  if (value === undefined) return { ok: true, value: 0 };
  if (!/^[0-9]+$/.test(value)) return { ok: false };
  return { ok: true, value: Number(value) };
}

export function toRunSummary(run: Run, state: ServerState): unknown {
  const workItem = state.workItems.get(run.workItemId);
  if (workItem === undefined) {
    throw new Error(`Fixture is missing work item ${run.workItemId} for run ${run.id}.`);
  }
  const lastEvent = state.events
    .filter((event) => event.stream.kind === "run" && event.stream.id === run.id)
    .at(-1);
  return {
    runId: run.id,
    workItemId: run.workItemId,
    title: workItem.title,
    source: workItem.source.kind,
    status: run.status,
    ...(run.currentStage === undefined ? {} : { currentStage: run.currentStage }),
    lastGlobalSequence: lastEvent?.globalSequence ?? 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

export function toApprovalSummary(approval: Approval, state: ServerState): unknown {
  const run = state.runs.get(approval.runId);
  if (run === undefined) {
    throw new Error(`Fixture is missing run ${approval.runId} for approval ${approval.id}.`);
  }
  return {
    approvalId: approval.id,
    runId: approval.runId,
    workItemId: run.workItemId,
    title: `${capitalize(approval.kind)} approval for run ${approval.runId}`,
    kind: approval.kind,
    status: approval.status,
    evidenceDigest: approval.evidenceDigest,
    requestedAt: approval.createdAt,
    updatedAt: approval.updatedAt
  };
}

export function buildInitialState(fixture: FactoryFixture): ServerState {
  return {
    workspaceId: fixture.workspaceId,
    workItems: new Map(fixture.workItems.map((item) => [item.id, item])),
    runs: new Map(fixture.runs.map((run) => [run.id, run])),
    approvals: new Map(fixture.approvals.map((approval) => [approval.id, approval])),
    events: fixture.events,
    decisionReplays: new Map(),
    answerReplays: new Map()
  };
}
