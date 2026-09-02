import { describe, expect, it, vi } from "vitest";

import { ListApprovalsQuerySchema } from "@autostack/contracts";

import {
  ApiAuthenticationError,
  ApiResponseError,
  createApiClient,
  createDesktopApiClient,
  type AutoStackApiClient
} from "../src/api-client.js";
import {
  ApiConflictError,
  ApiOperationUnavailableError,
  ApiRequestValidationError
} from "../src/api-errors.js";
import { createMockApiServer, seedFactoryFixture } from "../src/testing/index.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const health = {
  service: "autostack-control-plane",
  version: "0.1.0",
  status: "ok",
  storage: { status: "ok", journalMode: "wal", schemaVersion: 1 },
  executor: { status: "idle" }
};
const run = {
  schemaVersion: 1,
  id: "run_123e4567-e89b-42d3-a456-426614174000",
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174001",
  workItemId: "wi_123e4567-e89b-42d3-a456-426614174002",
  workflowVersion: "foundation-v1",
  status: "queued",
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z"
};
const workItem = {
  schemaVersion: 1,
  id: run.workItemId,
  workspaceId: run.workspaceId,
  source: { kind: "manual", client: "web" },
  title: "Build AutoStack",
  description: "Foundation",
  requester: { externalId: "local-user" },
  attachments: [],
  priority: "normal",
  labels: [],
  acceptanceContext: [],
  createdAt: run.createdAt,
  updatedAt: run.updatedAt
};

describe("AutoStack web API client", () => {
  it("maps factory calls onto named desktop operations without a token, URL, or headers", async () => {
    const requests: unknown[] = [];
    const bridge = {
      request: async (input: unknown) => {
        requests.push(input);
        const operation = (input as { operation: string }).operation;
        if (operation === "factory.health") return health;
        if (operation === "factory.runs.list") return { items: [] };
        if (operation === "factory.runs.events") return { events: [], nextSequence: 4 };
        return { workItem, run, replayed: false };
      }
    };
    const client = createDesktopApiClient({
      bridge: bridge as never,
      createIdempotencyKey: () => "desktop-request-1"
    });

    await client.health();
    await client.listRuns(42);
    await client.listRunEvents(run.id, 4);
    await client.createRun({ title: "Build AutoStack", description: "", acceptanceContext: [] });
    expect(requests).toEqual([
      { operation: "factory.health" },
      { operation: "factory.runs.list", cursor: 42 },
      { operation: "factory.runs.events", runId: run.id, after: 4 },
      {
        operation: "factory.runs.create",
        request: { title: "Build AutoStack", description: "", acceptanceContext: [] },
        idempotencyKey: "desktop-request-1"
      }
    ]);
    expect(JSON.stringify(requests)).not.toContain("Authorization");
  });

  it("validates public health without attaching credentials", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return Response.json(health);
    });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch });

    await expect(client.health()).resolves.toEqual(health);
    expect(fetch).toHaveBeenCalledWith("/v1/health", expect.any(Object));
  });

  it("authenticates and validates run listing using the current token", async () => {
    const getToken = vi.fn(() => TOKEN);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBe("/v1/runs?cursor=42");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
      return Response.json({ items: [], nextCursor: 21 });
    });

    await expect(createApiClient({ baseUrl: "/", getToken, fetch }).listRuns(42)).resolves.toEqual({
      items: [],
      nextCursor: 21
    });
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("requests one validated run-event page with a global cursor", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBe(`/v1/runs/${run.id}/events?after=42`);
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
      return Response.json({ events: [], nextSequence: 42 });
    });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch });

    await expect(client.listRunEvents(run.id, 42)).resolves.toEqual({
      events: [],
      nextSequence: 42
    });
  });

  it("creates a run with a fresh UUID idempotency key", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(String(init?.body))).toMatchObject({ title: "Build AutoStack" });
      return Response.json({ workItem, run, replayed: false }, { status: 201 });
    });
    const client = createApiClient({
      baseUrl: "http://127.0.0.1:4318/",
      getToken: () => TOKEN,
      fetch
    });

    await expect(
      client.createRun({
        title: "Build AutoStack",
        description: "Foundation",
        acceptanceContext: []
      })
    ).resolves.toMatchObject({ replayed: false, run: { id: run.id } });
  });

  it("uses a named authentication error for missing or rejected credentials", async () => {
    const missing = createApiClient({ baseUrl: "", getToken: () => null, fetch: vi.fn() });
    const rejected = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => new Response(null, { status: 401 }))
    });

    await expect(missing.listRuns()).rejects.toBeInstanceOf(ApiAuthenticationError);
    await expect(rejected.listRuns()).rejects.toBeInstanceOf(ApiAuthenticationError);
  });

  it("rejects empty credentials and non-success API responses", async () => {
    const empty = createApiClient({ baseUrl: "", getToken: () => "", fetch: vi.fn() });
    const unavailable = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => new Response(null, { status: 500 }))
    });

    await expect(empty.listRuns()).rejects.toBeInstanceOf(ApiAuthenticationError);
    await expect(unavailable.listRuns()).rejects.toBeInstanceOf(ApiResponseError);
    await expect(
      unavailable.createRun({
        title: "Build AutoStack",
        description: "",
        acceptanceContext: []
      })
    ).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("normalizes network failures and unexpected health status", async () => {
    const networkFailure = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => Promise.reject(new Error("offline")))
    });
    const badStatus = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => new Response(null, { status: 404 }))
    });

    await expect(networkFailure.health()).rejects.toBeInstanceOf(ApiResponseError);
    await expect(badStatus.health()).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("rejects malformed server data without reflecting it", async () => {
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: vi.fn(async () => Response.json({ token: TOKEN }))
    });

    const error = await client.health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("propagates AbortSignal to fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("Aborted", "AbortError");
    });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch });
    controller.abort();

    await expect(client.health(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/**
 * Wraps a fetch implementation to record every outbound request's method, URL, headers, and
 * parsed JSON body (`undefined` for a GET with no body) — the body capture is what lets a guard
 * assert on the request's own key set, not merely that some request happened.
 */
function recording(
  fetchImpl: typeof globalThis.fetch,
  sent: RecordedRequest[]
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string" && rawBody.length > 0
        ? (JSON.parse(rawBody) as unknown)
        : undefined;
    sent.push({ url, method, headers, body });
    return fetchImpl(input, init);
  };
}

function findPendingApproval(fixture: ReturnType<typeof seedFactoryFixture>) {
  const approval = fixture.approvals.find((candidate) => candidate.status === "pending");
  if (approval === undefined) throw new Error("Fixture has no pending approval to decide.");
  return approval;
}

function firstRun(fixture: ReturnType<typeof seedFactoryFixture>) {
  const run = fixture.runs[0];
  if (run === undefined) throw new Error("Fixture has no runs.");
  return run;
}

describe("approvals, steering, and cancellation", () => {
  it("pages the approval inbox past the first window", async () => {
    const server = createMockApiServer({ fixture: seedFactoryFixture({ approvalCount: 137 }) });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });

    const first = await client.listApprovals({ status: "pending", limit: 100 });
    expect(first.items).toHaveLength(100);
    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error("Expected a nextCursor after the first page.");

    const second = await client.listApprovals({ status: "pending", limit: 100, cursor });
    expect(second.items).toHaveLength(37);
    expect(second.nextCursor).toBeUndefined();

    const allIds = new Set([...first.items, ...second.items].map((item) => item.approvalId));
    expect(allIds.size).toBe(137);
  });

  it("sends no Idempotency-Key on an approval decision, because the server derives its own", async () => {
    const fixture = seedFactoryFixture();
    const approval = findPendingApproval(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });

    await client.decideApproval(approval.runId, approval.id, {
      decision: "approved",
      evidenceDigest: approval.evidenceDigest,
      origin: "web"
    });

    expect(sent.at(-1)?.headers.has("Idempotency-Key")).toBe(false);
  });

  it("sends a UUID Idempotency-Key on steer and cancel", async () => {
    const fixture = seedFactoryFixture();
    const run = firstRun(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });

    await client.steerRun(run.id, { instruction: "narrow the diff" });
    expect(sent.at(-1)?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);

    await client.cancelRun(run.id, { reason: "duplicate work" });
    expect(sent.at(-1)?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives steer a fresh key on every call, from the injected factory", async () => {
    const fixture = seedFactoryFixture();
    const run = firstRun(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });

    await client.steerRun(run.id, { instruction: "narrow the diff" });
    const firstKey = sent.at(-1)?.headers.get("Idempotency-Key");
    await client.steerRun(run.id, { instruction: "narrow the diff again" });
    const secondKey = sent.at(-1)?.headers.get("Idempotency-Key");

    expect(firstKey).not.toBe(secondKey);
  });

  it("replays an identical decision rather than deciding twice", async () => {
    const fixture = seedFactoryFixture();
    const approval = findPendingApproval(fixture);
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });
    const input = {
      decision: "approved" as const,
      evidenceDigest: approval.evidenceDigest,
      origin: "web" as const
    };

    const once = await client.decideApproval(approval.runId, approval.id, input);
    const twice = await client.decideApproval(approval.runId, approval.id, input);

    expect(twice.replayed).toBe(true);
    expect(twice.decidedAt).toBe(once.decidedAt);
  });

  it("surfaces a stale approval decision as a conflict rather than a generic failure", async () => {
    const fixture = seedFactoryFixture();
    const approval = findPendingApproval(fixture);
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });

    await expect(
      client.decideApproval(approval.runId, approval.id, {
        decision: "approved",
        evidenceDigest: "f".repeat(64),
        origin: "web"
      })
    ).rejects.toBeInstanceOf(ApiConflictError);
  });

  it("surfaces a conflicting decision on the same approval the same way", async () => {
    const fixture = seedFactoryFixture();
    const approval = findPendingApproval(fixture);
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });

    await client.decideApproval(approval.runId, approval.id, {
      decision: "approved",
      evidenceDigest: approval.evidenceDigest,
      origin: "web"
    });

    // Same evidence, opposite decision: a 409 from the server. The client must not distinguish
    // this from a stale-digest conflict — both surface as the same ApiConflictError (D2).
    await expect(
      client.decideApproval(approval.runId, approval.id, {
        decision: "rejected",
        evidenceDigest: approval.evidenceDigest,
        origin: "web"
      })
    ).rejects.toBeInstanceOf(ApiConflictError);
  });

  it("refuses to send an operator note containing credential material, before any network call", async () => {
    const fixture = seedFactoryFixture();
    const approval = findPendingApproval(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });

    await expect(
      client.decideApproval(approval.runId, approval.id, {
        decision: "approved",
        evidenceDigest: approval.evidenceDigest,
        origin: "web",
        // Runtime-built to keep credential-pattern bytes out of the source (fixture doctrine).
        note: ["gh", "p_"].join("") + "a".repeat(36)
      })
    ).rejects.toBeInstanceOf(ApiRequestValidationError);

    expect(sent).toHaveLength(0);
  });

  it("refuses to send a steer instruction containing credential material, before any network call", async () => {
    const fixture = seedFactoryFixture();
    const run = firstRun(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });

    // Runtime-built so the file's bytes never contain a real credential prefix (fixture
    // credential doctrine): "gh" and "p_" are separate literals, never adjacent in the source.
    const credentialLookingInstruction = ["gh", "p_"].join("") + "a".repeat(36);
    await expect(
      client.steerRun(run.id, { instruction: credentialLookingInstruction })
    ).rejects.toBeInstanceOf(ApiRequestValidationError);

    expect(sent).toHaveLength(0);
  });

  it("uses the named authentication error for a 401 on the approvals route", async () => {
    const fixture = seedFactoryFixture();
    const server = createMockApiServer({ fixture, failures: { listApprovals: "unauthorized" } });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });

    await expect(client.listApprovals()).rejects.toBeInstanceOf(ApiAuthenticationError);
  });

  it("uses the named response error for a malformed approvals response", async () => {
    const fixture = seedFactoryFixture();
    const server = createMockApiServer({ fixture, failures: { listApprovals: "malformed" } });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });

    await expect(client.listApprovals()).rejects.toBeInstanceOf(ApiResponseError);
  });

  // `ListApprovalsQueryInput` is declared locally in api-client.ts rather than imported, because
  // contracts exports the schema but not its input type and client-app declares no zod dependency.
  // That is a drift risk: a field added to the contract schema would go unnoticed. This pins the
  // schema's own key set, so such an addition fails here instead of silently going unsupported.
  it("supports every field the approvals query contract declares", () => {
    expect(Object.keys(ListApprovalsQuerySchema.shape).sort()).toEqual([
      "cursor",
      "limit",
      "status"
    ]);
  });

  // Only the decision route produces a 409 from real business logic, so without injected conflicts
  // these three branches were unreachable and could have mapped 409 to the wrong error unnoticed.
  it.each([
    ["listApprovals", (client: AutoStackApiClient, _runId: string) => client.listApprovals()],
    [
      "steerRun",
      (client: AutoStackApiClient, runId: string) =>
        client.steerRun(runId, { instruction: "Narrow the diff." })
    ],
    [
      "cancelRun",
      (client: AutoStackApiClient, runId: string) =>
        client.cancelRun(runId, { reason: "No longer needed." })
    ],
    [
      "answerClarification",
      (client: AutoStackApiClient, runId: string) =>
        client.answerClarification(runId, "clarify_narrow_scope", {
          answer: "Use the existing token schema.",
          origin: "web"
        })
    ]
  ] as const)("maps a 409 on the %s route to the shared conflict error", async (route, call) => {
    const fixture = seedFactoryFixture();
    const run = fixture.runs[0];
    if (run === undefined) throw new Error("Fixture has no runs.");
    const server = createMockApiServer({ fixture, failures: { [route]: "conflict" } });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });

    await expect(call(client, run.id)).rejects.toBeInstanceOf(ApiConflictError);
  });

  // A 401 mis-mapped to ApiResponseError would leave the UI showing "unavailable" instead of
  // re-prompting for authentication, so each mutating route's auth mapping is pinned too.
  it.each([
    [
      "steerRun",
      (client: AutoStackApiClient, runId: string) =>
        client.steerRun(runId, { instruction: "Narrow the diff." })
    ],
    [
      "cancelRun",
      (client: AutoStackApiClient, runId: string) =>
        client.cancelRun(runId, { reason: "No longer needed." })
    ],
    [
      "answerClarification",
      (client: AutoStackApiClient, runId: string) =>
        client.answerClarification(runId, "clarify_narrow_scope", {
          answer: "Use the existing token schema.",
          origin: "web"
        })
    ]
  ] as const)("maps 401 and a malformed body on the %s route", async (route, call) => {
    const fixture = seedFactoryFixture();
    const run = fixture.runs[0];
    if (run === undefined) throw new Error("Fixture has no runs.");
    const client = (mode: "unauthorized" | "malformed"): AutoStackApiClient =>
      createApiClient({
        baseUrl: "",
        getToken: () => TOKEN,
        fetch: createMockApiServer({ fixture, failures: { [route]: mode } }).fetch
      });

    await expect(call(client("unauthorized"), run.id)).rejects.toBeInstanceOf(
      ApiAuthenticationError
    );
    await expect(call(client("malformed"), run.id)).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("rejects an already-aborted decision with AbortError and issues no request", async () => {
    const fixture = seedFactoryFixture();
    const approval = findPendingApproval(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.decideApproval(
        approval.runId,
        approval.id,
        { decision: "approved", evidenceDigest: approval.evidenceDigest, origin: "web" },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(sent).toHaveLength(0);
  });

  it("propagates an active (non-aborted) signal through every new route", async () => {
    const fixture = seedFactoryFixture();
    const approval = findPendingApproval(fixture);
    const run = firstRun(fixture);
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });
    const controller = new AbortController();

    await expect(
      client.listApprovals({ status: "pending" }, controller.signal)
    ).resolves.toBeDefined();
    await expect(
      client.decideApproval(
        approval.runId,
        approval.id,
        { decision: "approved", evidenceDigest: approval.evidenceDigest, origin: "web" },
        controller.signal
      )
    ).resolves.toBeDefined();
    await expect(
      client.steerRun(run.id, { instruction: "narrow the diff" }, controller.signal)
    ).resolves.toBeDefined();
    await expect(
      client.cancelRun(run.id, { reason: "duplicate work" }, controller.signal)
    ).resolves.toBeDefined();
  });
});

describe("answering a clarification", () => {
  const CLARIFICATION_REF = "clarify_narrow_scope";

  it("sends only answer and origin — no idempotencyKey, no actorId keys on the request body", async () => {
    const fixture = seedFactoryFixture();
    const run = firstRun(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });

    await client.answerClarification(run.id, CLARIFICATION_REF, {
      answer: "Use the existing token schema.",
      origin: "web"
    });

    const body = sent.at(-1)?.body;
    expect(body).toBeDefined();
    expect(Object.keys(body as object).sort()).toEqual(["answer", "origin"]);
    expect(sent.at(-1)?.headers.has("Idempotency-Key")).toBe(false);
  });

  it("refuses to send an answer containing credential material, before any network call", async () => {
    const fixture = seedFactoryFixture();
    const run = firstRun(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });

    // Runtime-built so the file's bytes never contain a real credential prefix (fixture
    // credential doctrine): "gh" and "p_" are separate literals, never adjacent in the source.
    const credentialLookingAnswer = ["gh", "p_"].join("") + "a".repeat(36);
    await expect(
      client.answerClarification(run.id, CLARIFICATION_REF, {
        answer: credentialLookingAnswer,
        origin: "web"
      })
    ).rejects.toBeInstanceOf(ApiRequestValidationError);

    expect(sent).toHaveLength(0);
  });

  it("replays an identical answer rather than sending twice, and does not branch into a second send", async () => {
    const fixture = seedFactoryFixture();
    const run = firstRun(fixture);
    const server = createMockApiServer({ fixture });
    const sent: RecordedRequest[] = [];
    const client = createApiClient({
      baseUrl: "",
      getToken: () => TOKEN,
      fetch: recording(server.fetch, sent)
    });
    const input = { answer: "Use the existing token schema.", origin: "web" as const };

    const once = await client.answerClarification(run.id, CLARIFICATION_REF, input);
    const twice = await client.answerClarification(run.id, CLARIFICATION_REF, input);

    expect(twice.replayed).toBe(true);
    expect(twice.answeredAt).toBe(once.answeredAt);
    // Exactly one network request per call — the client neither dedupes the second call away nor
    // fires an extra corrective request after seeing `replayed: true`.
    expect(sent).toHaveLength(2);
  });

  it("reports 404 for an unknown run", async () => {
    const fixture = seedFactoryFixture();
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });

    await expect(
      client.answerClarification("run_00000000-0000-4000-8000-000000000000", CLARIFICATION_REF, {
        answer: "Use the existing token schema.",
        origin: "web"
      })
    ).rejects.toBeInstanceOf(ApiResponseError);
  });
});

describe("desktop client honesty for approvals, steer, and cancel (D1)", () => {
  function createRecordingBridge() {
    const calls: unknown[] = [];
    const bridge = {
      request: async (input: unknown) => {
        calls.push(input);
        throw new Error("bridge.request must never be called for an unmodelled operation.");
      }
    };
    return { bridge, calls };
  }

  it("throws ApiOperationUnavailableError for listApprovals and never touches bridge.request", async () => {
    const { bridge, calls } = createRecordingBridge();
    const client = createDesktopApiClient({ bridge: bridge as never });

    await expect(client.listApprovals()).rejects.toBeInstanceOf(ApiOperationUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("throws ApiOperationUnavailableError for decideApproval and never touches bridge.request", async () => {
    const { bridge, calls } = createRecordingBridge();
    const client = createDesktopApiClient({ bridge: bridge as never });

    await expect(
      client.decideApproval("run_1", "apr_1", {
        decision: "approved",
        evidenceDigest: "a".repeat(64),
        origin: "web"
      })
    ).rejects.toBeInstanceOf(ApiOperationUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("throws ApiOperationUnavailableError for steerRun and never touches bridge.request", async () => {
    const { bridge, calls } = createRecordingBridge();
    const client = createDesktopApiClient({ bridge: bridge as never });

    await expect(
      client.steerRun("run_1", { instruction: "narrow the diff" })
    ).rejects.toBeInstanceOf(ApiOperationUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it("throws ApiOperationUnavailableError for cancelRun and never touches bridge.request", async () => {
    const { bridge, calls } = createRecordingBridge();
    const client = createDesktopApiClient({ bridge: bridge as never });

    await expect(client.cancelRun("run_1", { reason: "duplicate work" })).rejects.toBeInstanceOf(
      ApiOperationUnavailableError
    );
    expect(calls).toHaveLength(0);
  });

  // No `factory.runs.answer` member exists in `DesktopApiOperationMap` — same D1 shape as the
  // other four operations above.
  it("throws ApiOperationUnavailableError for answerClarification and never touches bridge.request", async () => {
    const { bridge, calls } = createRecordingBridge();
    const client = createDesktopApiClient({ bridge: bridge as never });

    await expect(
      client.answerClarification("run_1", "clarify_narrow_scope", {
        answer: "Use the existing token schema.",
        origin: "web"
      })
    ).rejects.toBeInstanceOf(ApiOperationUnavailableError);
    expect(calls).toHaveLength(0);
  });
});
