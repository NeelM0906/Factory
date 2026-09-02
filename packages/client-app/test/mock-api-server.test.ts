import { describe, expect, it } from "vitest";
import {
  AnswerClarificationResponseSchema,
  ApiErrorSchema,
  ApprovalDecisionResponseSchema,
  CancelRunResponseSchema,
  CreateRunResponseSchema,
  EVENT_TYPES,
  HealthResponseSchema,
  ListApprovalsResponseSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  RUN_STATUSES,
  SteerRunResponseSchema,
  type Approval
} from "@autostack/contracts";

import {
  createMockApiServer,
  seedFactoryFixture,
  type FactoryFixture
} from "../src/testing/index.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const authHeaders = { authorization: `Bearer ${TOKEN}` };

const firstPendingApproval = (fixture: FactoryFixture): Approval => {
  const found = fixture.approvals.find((approval) => approval.status === "pending");
  if (found === undefined) throw new Error("Fixture has no pending approval to decide.");
  return found;
};

async function fetchJson(
  server: ReturnType<typeof createMockApiServer>,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  const response = await server.fetch(path, init);
  return { status: response.status, body: await response.json() };
}

describe("contract-derived mock API server", () => {
  it("refuses to seed a response its contract schema would reject", () => {
    expect(() =>
      createMockApiServer({
        fixture: seedFactoryFixture({ approvals: [{ approvalId: "not-an-approval-id" } as never] })
      })
    ).toThrow(/approval/i);
  });

  it("pages approvals past the first window with a cursor the query schema accepts", async () => {
    const server = createMockApiServer({ fixture: seedFactoryFixture({ approvalCount: 137 }) });
    const first = ListApprovalsResponseSchema.parse(
      await server.handle({ path: "/v1/approvals", query: { status: "pending", limit: "100" } })
    );
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeDefined();
    const second = ListApprovalsResponseSchema.parse(
      await server.handle({
        path: "/v1/approvals",
        query: { status: "pending", limit: "100", cursor: String(first.nextCursor) }
      })
    );
    expect(second.items).toHaveLength(37);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((i) => i.approvalId)).size).toBe(137);
  });

  describe("seedFactoryFixture", () => {
    it("is deterministic: two calls with the same options produce byte-identical output", () => {
      expect(JSON.stringify(seedFactoryFixture())).toBe(JSON.stringify(seedFactoryFixture()));
      expect(JSON.stringify(seedFactoryFixture({ approvalCount: 9 }))).toBe(
        JSON.stringify(seedFactoryFixture({ approvalCount: 9 }))
      );
    });

    it("covers every SourceRef kind, every RUN_STATUSES member, and every approval kind and status", () => {
      const fixture = seedFactoryFixture();
      expect(new Set(fixture.workItems.map((item) => item.source.kind))).toEqual(
        new Set(["manual", "github", "slack", "api"])
      );
      expect(new Set(fixture.runs.map((run) => run.status))).toEqual(new Set(RUN_STATUSES));
      expect(new Set(fixture.approvals.map((approval) => approval.kind))).toEqual(
        new Set(["plan", "publish", "permission"])
      );
      expect(new Set(fixture.approvals.map((approval) => approval.status))).toEqual(
        new Set(["pending", "approved", "rejected", "stale"])
      );
    });

    it("builds a coherent event stream: increasing global sequence, per-stream version from 1", () => {
      const fixture = seedFactoryFixture();
      expect(fixture.events.length).toBeGreaterThan(0);
      const sequences = fixture.events.map((event) => event.globalSequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);

      const versionsByStream = new Map<string, number[]>();
      for (const event of fixture.events) {
        const key = `${event.stream.kind}:${event.stream.id}`;
        versionsByStream.set(key, [...(versionsByStream.get(key) ?? []), event.streamVersion]);
      }
      for (const versions of versionsByStream.values()) {
        expect(versions).toEqual(
          Array.from({ length: versions.length }, (_unused, index) => index + 1)
        );
      }
      for (const type of ["work_item.created", "run.created"] satisfies Array<
        (typeof EVENT_TYPES)[number]
      >) {
        expect(fixture.events.some((event) => event.type === type)).toBe(true);
      }
    });
  });

  describe("route behavior", () => {
    it("serves an authenticated lifecycle: health, run creation, run listing, and its events", async () => {
      const server = createMockApiServer({ fixture: seedFactoryFixture() });

      const health = await fetchJson(server, "/v1/health");
      expect(health.status).toBe(200);
      expect(HealthResponseSchema.parse(health.body).status).toBe("ok");

      const created = await fetchJson(server, "/v1/runs", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ship the workbench",
          description: "",
          acceptanceContext: []
        })
      });
      expect(created.status).toBe(201);
      const run = CreateRunResponseSchema.parse(created.body);
      expect(run.replayed).toBe(false);
      expect(run.run.status).toBe("queued");

      const listed = await fetchJson(server, "/v1/runs", { headers: authHeaders });
      expect(listed.status).toBe(200);
      const runs = ListRunsResponseSchema.parse(listed.body);
      expect(runs.items.some((item) => item.runId === run.run.id)).toBe(true);

      const events = await fetchJson(server, `/v1/runs/${run.run.id}/events`, {
        headers: authHeaders
      });
      expect(events.status).toBe(200);
      ListEventsResponseSchema.parse(events.body);
    });

    it("rejects a request body its request schema would reject, with 400 and never a thrown error", async () => {
      const server = createMockApiServer({ fixture: seedFactoryFixture() });
      const result = await fetchJson(server, "/v1/runs", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ description: "Missing a title" })
      });
      expect(result.status).toBe(400);
      const error = ApiErrorSchema.parse(result.body);
      expect(error.error.code).toBe("invalid_request");
    });

    it("returns 404 with ApiErrorSchema for an unknown route, honestly coded as invalid_request", async () => {
      // No run lookup happened here — the path itself matched no route — so the code must not
      // claim a run was searched for and missing (that's `run_not_found`, reserved for routes
      // that actually looked one up).
      const server = createMockApiServer({ fixture: seedFactoryFixture() });
      const result = await fetchJson(server, "/v1/does-not-exist", { headers: authHeaders });
      expect(result.status).toBe(404);
      expect(ApiErrorSchema.parse(result.body).error.code).toBe("invalid_request");
    });

    it("returns 401 unauthorized for a missing or blank bearer token, but never for health", async () => {
      const server = createMockApiServer({ fixture: seedFactoryFixture() });

      const missing = await fetchJson(server, "/v1/runs");
      expect(missing.status).toBe(401);
      expect(ApiErrorSchema.parse(missing.body).error.code).toBe("unauthorized");

      const blank = await fetchJson(server, "/v1/runs", {
        headers: { authorization: "Bearer   " }
      });
      expect(blank.status).toBe(401);

      const health = await fetchJson(server, "/v1/health");
      expect(health.status).toBe(200);
    });

    it("applies ListApprovalsQuerySchema to raw string query values, defaulting status and limit", async () => {
      const server = createMockApiServer({ fixture: seedFactoryFixture() });
      const body = ListApprovalsResponseSchema.parse(
        await server.handle({ path: "/v1/approvals" })
      );
      expect(body.items.every((item) => item.status === "pending")).toBe(true);
      expect(body.items.length).toBeLessThanOrEqual(25);
    });

    it("steers and cancels a known run, and reports 404 for an unknown one", async () => {
      const fixture = seedFactoryFixture();
      const server = createMockApiServer({ fixture });
      const run = fixture.runs[0];
      if (run === undefined) throw new Error("Fixture has no runs.");

      const steered = await fetchJson(server, `/v1/runs/${run.id}/steer`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ instruction: "Focus on the failing suite first." })
      });
      expect(steered.status).toBe(200);
      expect(SteerRunResponseSchema.parse(steered.body).accepted).toBe(true);

      const cancelled = await fetchJson(server, `/v1/runs/${run.id}/cancel`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ reason: "No longer needed." })
      });
      expect(cancelled.status).toBe(200);
      expect(CancelRunResponseSchema.parse(cancelled.body).status).toBe("cancelling");

      const unknownRunId = "run_ffffffff-ffff-4fff-8fff-ffffffffffff";
      const notFound = await fetchJson(server, `/v1/runs/${unknownRunId}/cancel`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ reason: "No longer needed." })
      });
      expect(notFound.status).toBe(404);
    });

    it("answers a clarification on a known run, and reports 404 for an unknown one", async () => {
      const fixture = seedFactoryFixture();
      const server = createMockApiServer({ fixture });
      const run = fixture.runs[0];
      if (run === undefined) throw new Error("Fixture has no runs.");

      const answered = await fetchJson(
        server,
        `/v1/runs/${run.id}/clarifications/clarify_ref/answer`,
        {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ answer: "Use the existing token schema.", origin: "web" })
        }
      );
      expect(answered.status).toBe(200);
      const parsed = AnswerClarificationResponseSchema.parse(answered.body);
      expect(parsed.replayed).toBe(false);
      expect(parsed.clarificationRef).toBe("clarify_ref");

      const unknownRunId = "run_ffffffff-ffff-4fff-8fff-ffffffffffff";
      const notFound = await fetchJson(
        server,
        `/v1/runs/${unknownRunId}/clarifications/clarify_ref/answer`,
        {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({ answer: "Use the existing token schema.", origin: "web" })
        }
      );
      expect(notFound.status).toBe(404);
    });
  });

  describe("clarification answer idempotency (server-derived, no client key)", () => {
    it("replays the same (runId, clarificationRef, answer) with the original answeredAt", async () => {
      const fixture = seedFactoryFixture();
      const server = createMockApiServer({ fixture });
      const run = fixture.runs[0];
      if (run === undefined) throw new Error("Fixture has no runs.");
      const path = `/v1/runs/${run.id}/clarifications/clarify_ref/answer`;
      const body = JSON.stringify({ answer: "Use the existing token schema.", origin: "web" });
      const headers = { ...authHeaders, "content-type": "application/json" };

      const once = AnswerClarificationResponseSchema.parse(
        (await fetchJson(server, path, { method: "POST", headers, body })).body
      );
      const twice = AnswerClarificationResponseSchema.parse(
        (await fetchJson(server, path, { method: "POST", headers, body })).body
      );

      expect(twice.replayed).toBe(true);
      expect(twice.answeredAt).toBe(once.answeredAt);
    });

    it("treats a different answer to the same clarificationRef as a fresh answer, not a replay", async () => {
      const fixture = seedFactoryFixture();
      const server = createMockApiServer({ fixture });
      const run = fixture.runs[0];
      if (run === undefined) throw new Error("Fixture has no runs.");
      const path = `/v1/runs/${run.id}/clarifications/clarify_ref/answer`;
      const headers = { ...authHeaders, "content-type": "application/json" };

      const first = AnswerClarificationResponseSchema.parse(
        (
          await fetchJson(server, path, {
            method: "POST",
            headers,
            body: JSON.stringify({ answer: "Use the existing token schema.", origin: "web" })
          })
        ).body
      );
      const second = AnswerClarificationResponseSchema.parse(
        (
          await fetchJson(server, path, {
            method: "POST",
            headers,
            body: JSON.stringify({ answer: "Use a new schema instead.", origin: "web" })
          })
        ).body
      );

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(false);
    });
  });

  describe("server clock determinism", () => {
    it("stamps mutations from the injected clock, not the wall clock", async () => {
      const fixture = seedFactoryFixture();
      const approval = firstPendingApproval(fixture);
      const run = fixture.runs[0];
      if (run === undefined) throw new Error("Fixture has no runs.");
      const server = createMockApiServer({ fixture });
      const decidePath = `/v1/runs/${approval.runId}/approvals/${approval.id}/decision`;
      const decision = ApprovalDecisionResponseSchema.parse(
        await server.handle({
          method: "POST",
          path: decidePath,
          body: { decision: "approved", evidenceDigest: approval.evidenceDigest, origin: "web" }
        })
      );
      const steered = SteerRunResponseSchema.parse(
        await server.handle({
          method: "POST",
          path: `/v1/runs/${run.id}/steer`,
          body: { instruction: "Focus on the failing suite first." }
        })
      );
      const cancelled = CancelRunResponseSchema.parse(
        await server.handle({
          method: "POST",
          path: `/v1/runs/${run.id}/cancel`,
          body: { reason: "No longer needed." }
        })
      );
      // Absolute values, not equality between two runs. `createDeterministicClock` starts at a
      // fixed epoch and advances one second per call, so these are knowable constants. A wall
      // clock returns today's date and fails every time; comparing two servers to each other
      // would NOT catch it, because both finish inside the same millisecond and agree.
      expect({
        decidedAt: decision.decidedAt,
        acceptedAt: steered.acceptedAt,
        requestedAt: cancelled.requestedAt
      }).toEqual({
        decidedAt: "2026-08-20T12:00:00.000Z",
        acceptedAt: "2026-08-20T12:00:01.000Z",
        requestedAt: "2026-08-20T12:00:02.000Z"
      });
    });
  });

  describe("approval decision idempotency (D2: server-derived, no client key)", () => {
    it("ignores any client-supplied Idempotency-Key header entirely", async () => {
      const fixture = seedFactoryFixture();
      const server = createMockApiServer({ fixture });
      const approval = firstPendingApproval(fixture);
      const body = { decision: "approved", evidenceDigest: approval.evidenceDigest, origin: "web" };
      const path = `/v1/runs/${approval.runId}/approvals/${approval.id}/decision`;

      const first = ApprovalDecisionResponseSchema.parse(
        await server.handle({ method: "POST", path, body })
      );
      expect(first.replayed).toBe(false);

      const second = ApprovalDecisionResponseSchema.parse(
        await server.handle({
          method: "POST",
          path,
          headers: { "idempotency-key": "client-supplied-key-should-be-ignored" },
          body
        })
      );
      expect(second.replayed).toBe(true);
      expect(second.decidedAt).toBe(first.decidedAt);
    });

    it("rejects a stale evidenceDigest with 409 before writing any record", async () => {
      const fixture = seedFactoryFixture();
      const server = createMockApiServer({ fixture });
      const approval = firstPendingApproval(fixture);
      const path = `/v1/runs/${approval.runId}/approvals/${approval.id}/decision`;
      const staleDigest = approval.evidenceDigest.replace(
        /^./,
        approval.evidenceDigest[0] === "0" ? "1" : "0"
      );
      const staleBody = { decision: "approved", evidenceDigest: staleDigest, origin: "web" };

      const rejected = await server.handle({ method: "POST", path, body: staleBody });
      const error = ApiErrorSchema.parse(rejected);
      expect(error.error.code).toBe("version_conflict");

      const stillPending = ApprovalDecisionResponseSchema.safeParse(
        await server.handle({ method: "POST", path, body: staleBody })
      );
      expect(stillPending.success).toBe(false);

      const listed = ListApprovalsResponseSchema.parse(
        await server.handle({ path: "/v1/approvals", query: { status: "pending" } })
      );
      expect(listed.items.some((item) => item.approvalId === approval.id)).toBe(true);
    });

    it("replays the same (approvalId, decision, evidenceDigest) with the original decidedAt", async () => {
      const fixture = seedFactoryFixture();
      const server = createMockApiServer({ fixture });
      const approval = firstPendingApproval(fixture);
      const path = `/v1/runs/${approval.runId}/approvals/${approval.id}/decision`;
      const body = { decision: "rejected", evidenceDigest: approval.evidenceDigest, origin: "cli" };

      const first = ApprovalDecisionResponseSchema.parse(
        await server.handle({ method: "POST", path, body })
      );
      const second = ApprovalDecisionResponseSchema.parse(
        await server.handle({ method: "POST", path, body })
      );

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.decidedAt).toBe(first.decidedAt);
      expect(second.status).toBe(first.status);
    });

    it("returns 409 idempotency_conflict for a different decision on an already-decided approval", async () => {
      const fixture = seedFactoryFixture();
      const server = createMockApiServer({ fixture });
      const approval = firstPendingApproval(fixture);
      const path = `/v1/runs/${approval.runId}/approvals/${approval.id}/decision`;

      await server.handle({
        method: "POST",
        path,
        body: { decision: "approved", evidenceDigest: approval.evidenceDigest, origin: "web" }
      });
      const conflicting = await server.handle({
        method: "POST",
        path,
        body: { decision: "rejected", evidenceDigest: approval.evidenceDigest, origin: "web" }
      });
      expect(ApiErrorSchema.parse(conflicting).error.code).toBe("idempotency_conflict");
    });
  });

  describe("failures injection", () => {
    it("forces 401 for a route with an 'unauthorized' failure even with a valid token", async () => {
      const server = createMockApiServer({
        fixture: seedFactoryFixture(),
        failures: { listRuns: "unauthorized" }
      });
      const result = await fetchJson(server, "/v1/runs", { headers: authHeaders });
      expect(result.status).toBe(401);
    });

    it("rejects the fetch adapter for a route with a 'network' failure", async () => {
      const server = createMockApiServer({
        fixture: seedFactoryFixture(),
        failures: { health: "network" }
      });
      // `network` is a transport-level fault: it simulates the control plane being unreachable,
      // so only `fetch` (the HTTP boundary) rejects. `handle` is the direct business-logic path
      // and is unaffected — asserted by the "health" case in the lifecycle test above.
      await expect(server.fetch("/v1/health")).rejects.toThrow(/network/i);
    });

    it("serves a body the response schema rejects for a route with a 'malformed' failure", async () => {
      const server = createMockApiServer({
        fixture: seedFactoryFixture(),
        failures: { health: "malformed" }
      });
      const result = await fetchJson(server, "/v1/health");
      expect(result.status).toBe(200);
      expect(HealthResponseSchema.safeParse(result.body).success).toBe(false);
    });
  });
});
