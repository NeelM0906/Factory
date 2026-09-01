import {
  AnswerClarificationRequestSchema,
  AnswerClarificationResponseSchema,
  ApprovalDecisionRequestSchema,
  ApprovalDecisionResponseSchema,
  ApprovalSchema,
  CancelRunRequestSchema,
  CancelRunResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  HealthResponseSchema,
  ListApprovalsQuerySchema,
  ListApprovalsResponseSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  RunSchema,
  SteerRunRequestSchema,
  SteerRunResponseSchema,
  WorkItemSchema,
  createId
} from "@autostack/contracts";

import { createDeterministicClock } from "./deterministic-ids.js";
import {
  buildInitialState,
  errorResponse,
  extractBearerToken,
  matchRoute,
  parseNonNegativeIntQuery,
  toApprovalSummary,
  toRunSummary,
  type MockApiRequest,
  type MockApiServer,
  type MockApiServerOptions,
  type ResolvedResponse
} from "./mock-api-server-support.js";

export type {
  MockApiFailureMode,
  MockApiRequest,
  MockApiRoute,
  MockApiServer,
  MockApiServerFailures,
  MockApiServerOptions
} from "./mock-api-server-support.js";

const RUNS_PAGE_SIZE = 50;

/**
 * A mock API server derived entirely from `@autostack/contracts`. Every request body is validated
 * with its request schema; every response is validated with its response schema before it leaves
 * `resolveRequest`. `handle` exposes the response body directly; `fetch` wraps the same resolution
 * in a real `Response`, so it can be handed straight to `createApiClient({ fetch })`.
 */
export function createMockApiServer(options: MockApiServerOptions): MockApiServer {
  const failures = options.failures ?? {};
  const now = options.now ?? createDeterministicClock();
  let state = buildInitialState(options.fixture);

  /**
   * The server's business logic only: routing, request/query validation, and route behavior.
   * `failures` and bearer-token authentication are HTTP-transport concerns, applied only by
   * `fetch` below — `handle` is the direct, already-authenticated path later tasks use to assert
   * business behavior without constructing headers for every call.
   */
  async function resolveRequest(request: MockApiRequest): Promise<ResolvedResponse> {
    const method = (request.method ?? "GET").toUpperCase();
    const match = matchRoute(method, request.path);
    if (match === undefined) {
      // No lookup happened here — nothing was "not found", the path itself didn't match any
      // route — so the code stays `invalid_request` even though the status is 404.
      return errorResponse(404, "invalid_request", "No route matches this request.");
    }

    switch (match.route) {
      case "health":
        return {
          status: 200,
          body: HealthResponseSchema.parse({
            service: "autostack-control-plane",
            version: "0.1.0",
            status: "ok",
            storage: { status: "ok", journalMode: "wal", schemaVersion: 1 },
            executor: { status: "idle" }
          })
        };

      case "listRuns": {
        const cursor = parseNonNegativeIntQuery(request.query?.cursor);
        if (!cursor.ok) return errorResponse(400, "invalid_request", "The cursor is invalid.");
        const all = Array.from(state.runs.values());
        const page = all.slice(cursor.value, cursor.value + RUNS_PAGE_SIZE);
        const nextOffset = cursor.value + page.length;
        return {
          status: 200,
          body: ListRunsResponseSchema.parse({
            items: page.map((run) => toRunSummary(run, state)),
            ...(nextOffset < all.length ? { nextCursor: nextOffset } : {})
          })
        };
      }

      case "listRunEvents": {
        const after = parseNonNegativeIntQuery(request.query?.after);
        if (!after.ok) return errorResponse(400, "invalid_request", "The after cursor is invalid.");
        const matching = state.events.filter(
          (event) =>
            event.stream.kind === "run" &&
            event.stream.id === match.runId &&
            event.globalSequence > after.value
        );
        const page = matching.slice(0, 100);
        const last = page.at(-1);
        return {
          status: 200,
          body: ListEventsResponseSchema.parse({
            events: page,
            nextSequence: last === undefined ? after.value : last.globalSequence
          })
        };
      }

      case "createRun": {
        const parsedBody = CreateRunRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          return errorResponse(400, "invalid_request", "The run request is invalid.");
        }
        // This route mutates state but does not append to `state.events` — the visible event
        // log is fixture-seeded only. A later task that needs a live event trail for a
        // dynamically-created run must add that bookkeeping itself.
        const nowIso = now();
        const workItem = WorkItemSchema.parse({
          schemaVersion: 1,
          id: createId("workItem"),
          workspaceId: state.workspaceId,
          source: { kind: "manual", client: "api" },
          title: parsedBody.data.title,
          description: parsedBody.data.description,
          requester: { externalId: "mock-api-server" },
          attachments: [],
          priority: "normal",
          labels: [],
          acceptanceContext: parsedBody.data.acceptanceContext,
          createdAt: nowIso,
          updatedAt: nowIso
        });
        const run = RunSchema.parse({
          schemaVersion: 1,
          id: createId("run"),
          workspaceId: state.workspaceId,
          workItemId: workItem.id,
          workflowVersion: "fixture-v1",
          status: "queued",
          createdAt: nowIso,
          updatedAt: nowIso
        });
        state = {
          ...state,
          workItems: new Map(state.workItems).set(workItem.id, workItem),
          runs: new Map(state.runs).set(run.id, run)
        };
        return {
          status: 201,
          body: CreateRunResponseSchema.parse({ workItem, run, replayed: false })
        };
      }

      case "listApprovals": {
        const parsedQuery = ListApprovalsQuerySchema.safeParse(request.query ?? {});
        if (!parsedQuery.success) {
          return errorResponse(400, "invalid_request", "The approvals query is invalid.");
        }
        const { status, limit, cursor } = parsedQuery.data;
        const matching = Array.from(state.approvals.values()).filter(
          (approval) => approval.status === status
        );
        const offset = cursor ?? 0;
        const page = matching.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          status: 200,
          body: ListApprovalsResponseSchema.parse({
            items: page.map((approval) => toApprovalSummary(approval, state)),
            ...(nextOffset < matching.length ? { nextCursor: nextOffset } : {})
          })
        };
      }

      case "decideApproval": {
        const parsedBody = ApprovalDecisionRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          return errorResponse(400, "invalid_request", "The approval decision is invalid.");
        }
        const approval = state.approvals.get(match.approvalId);
        if (approval === undefined || approval.runId !== match.runId) {
          return errorResponse(
            404,
            "run_not_found",
            "No matching approval was found for this run."
          );
        }
        const { decision, evidenceDigest, origin } = parsedBody.data;

        // D2: the staleness check runs first, ahead of the replay store, so a stale decision can
        // never leave a record behind.
        if (evidenceDigest !== approval.evidenceDigest) {
          return errorResponse(409, "version_conflict", "The approval evidence has changed.");
        }

        // Idempotency is derived from the body alone; any Idempotency-Key header is ignored.
        const derivedKey = `${approval.id}:${decision}:${evidenceDigest}`;
        const replay = state.decisionReplays.get(derivedKey);
        if (replay !== undefined) {
          return {
            status: 200,
            body: ApprovalDecisionResponseSchema.parse({ ...replay, replayed: true })
          };
        }

        if (approval.status !== "pending") {
          return errorResponse(
            409,
            "idempotency_conflict",
            "This approval was already decided differently."
          );
        }

        // This route mutates state but does not append to `state.events` — see the note in
        // "createRun" above; the same limit applies to every mutating route in this file.
        const decidedAt = now();
        const updatedApproval = ApprovalSchema.parse({
          ...approval,
          status: decision,
          decision: { decision, actor: { kind: "user", id: origin }, origin, decidedAt },
          updatedAt: decidedAt
        });
        const response = ApprovalDecisionResponseSchema.parse({
          approvalId: approval.id,
          runId: approval.runId,
          status: decision,
          decidedAt,
          replayed: false
        });
        state = {
          ...state,
          approvals: new Map(state.approvals).set(updatedApproval.id, updatedApproval),
          decisionReplays: new Map(state.decisionReplays).set(derivedKey, response)
        };
        return { status: 200, body: response };
      }

      case "steerRun": {
        const parsedBody = SteerRunRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          return errorResponse(400, "invalid_request", "The steer instruction is invalid.");
        }
        const run = state.runs.get(match.runId);
        if (run === undefined)
          return errorResponse(404, "run_not_found", "No matching run was found.");
        // This route does not append to `state.events` — see the note in "createRun" above.
        return {
          status: 200,
          body: SteerRunResponseSchema.parse({
            runId: run.id,
            accepted: true,
            acceptedAt: now()
          })
        };
      }

      case "cancelRun": {
        const parsedBody = CancelRunRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          return errorResponse(400, "invalid_request", "The cancel reason is invalid.");
        }
        const run = state.runs.get(match.runId);
        if (run === undefined)
          return errorResponse(404, "run_not_found", "No matching run was found.");
        // This route does not append to `state.events` — see the note in "createRun" above.
        const updatedRun = RunSchema.parse({
          ...run,
          status: "cancelling",
          updatedAt: now()
        });
        state = { ...state, runs: new Map(state.runs).set(updatedRun.id, updatedRun) };
        return {
          status: 200,
          body: CancelRunResponseSchema.parse({
            runId: updatedRun.id,
            status: updatedRun.status,
            requestedAt: updatedRun.updatedAt
          })
        };
      }

      case "answerClarification": {
        const parsedBody = AnswerClarificationRequestSchema.safeParse(request.body);
        if (!parsedBody.success) {
          return errorResponse(400, "invalid_request", "The clarification answer is invalid.");
        }
        const run = state.runs.get(match.runId);
        if (run === undefined)
          return errorResponse(404, "run_not_found", "No matching run was found.");

        // Server-derived, same shape as the approval-decision idempotency key (D2): a client
        // cannot mint two distinct acts out of one answer by resubmitting it.
        const derivedKey = `${match.runId}:${match.clarificationRef}:${parsedBody.data.answer}`;
        const replay = state.answerReplays.get(derivedKey);
        if (replay !== undefined) {
          return {
            status: 200,
            body: AnswerClarificationResponseSchema.parse({ ...replay, replayed: true })
          };
        }

        // This route does not append to `state.events` — see the note in "createRun" above.
        const response = AnswerClarificationResponseSchema.parse({
          runId: run.id,
          clarificationRef: match.clarificationRef,
          answeredAt: now(),
          replayed: false
        });
        state = { ...state, answerReplays: new Map(state.answerReplays).set(derivedKey, response) };
        return { status: 200, body: response };
      }
    }
  }

  /**
   * The HTTP-transport layer: bearer-token authentication and `failures` fault injection, both of
   * which are meaningless to `handle`'s direct business-logic calls and apply only here, ahead of
   * `resolveRequest`.
   */
  async function resolveHttp(request: MockApiRequest): Promise<ResolvedResponse> {
    const method = (request.method ?? "GET").toUpperCase();
    const match = matchRoute(method, request.path);
    const failure = match === undefined ? undefined : failures[match.route];

    if (failure === "network") {
      throw new Error("Simulated network failure: the control plane is unreachable.");
    }
    if (failure === "malformed") {
      return { status: 200, body: { malformed: true, route: match?.route } };
    }
    if (failure === "unauthorized") {
      return errorResponse(401, "unauthorized", "Authentication is required.");
    }
    if (failure === "conflict") {
      return errorResponse(409, "idempotency_conflict", "The request conflicts with a prior one.");
    }
    if (match?.route !== "health") {
      const token = extractBearerToken(request.headers);
      if (token === undefined || token.length === 0) {
        return errorResponse(401, "unauthorized", "Authentication is required.");
      }
    }

    return resolveRequest(request);
  }

  const fetchAdapter: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const rawUrl = request !== undefined ? request.url : input.toString();
    const url = new URL(rawUrl, "http://mock-api-server.invalid");
    const method = init?.method ?? request?.method ?? "GET";
    const headers = new Headers(init?.headers ?? request?.headers);
    const bodyText =
      init?.body !== undefined
        ? String(init.body)
        : request !== undefined
          ? await request.text()
          : "";
    const { status, body } = await resolveHttp({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: bodyText.length === 0 ? undefined : (JSON.parse(bodyText) as unknown)
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  };

  return {
    async handle(request) {
      const { body } = await resolveRequest(request);
      return body;
    },
    fetch: fetchAdapter
  };
}
