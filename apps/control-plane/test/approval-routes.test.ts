import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalDecisionResponseSchema,
  ApprovalIdSchema,
  CreateRunResponseSchema,
  EventIdSchema,
  ListApprovalsResponseSchema,
  PendingDomainEventSchema,
  RunIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
  createIdFactory
} from "@autostack/contracts";
import { SqliteDurableStore, openDatabase } from "@autostack/db";
import {
  digestApprovalEvidence,
  requestApproval,
  type CommitResult,
  type StreamAppend
} from "@autostack/domain";

import { createApp } from "../src/app.js";

const NOW = "2026-08-20T12:00:00.000Z";
const TOKEN = "0123456789abcdef0123456789abcdef";
const WORKSPACE_ID = WorkspaceIdSchema.parse("ws_123e4567-e89b-42d3-a456-426614174000");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

let eventCounter = 10;
const makeHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "autostack-approval-"));
  temporaryDirectories.push(directory);
  const database = openDatabase({ filePath: join(directory, "autostack.sqlite") });
  eventCounter = 10;
  const store = new SqliteDurableStore(database, {
    eventId: () =>
      EventIdSchema.parse(
        `evt_123e4567-e89b-42d3-a456-${String(426614174000 + eventCounter++).padStart(12, "0")}`
      ),
    leaseToken: () => "lease-token",
    now: () => NOW
  });
  const app = createApp({
    store,
    executor: { getStatus: () => "idle" },
    token: TOKEN,
    workspaceId: WORKSPACE_ID,
    now: () => NOW
  });
  const authenticated = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...init.headers
      }
    });

  /** Creates a run and returns its runId. */
  const createRun = async (title = "Fix the bug"): Promise<{ runId: string; workItemId: string }> => {
    const response = await authenticated("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `run-${title}-${Date.now()}` },
      body: JSON.stringify({ title, description: `Description for ${title}` })
    });
    const body = CreateRunResponseSchema.parse(await response.json());
    return { runId: body.run.id, workItemId: body.workItem.id };
  };

  /** Seeds a pending approval on a run. Returns the approval id and evidence digest. */
  const seedApproval = async (
    runId: string,
    kind: "plan" | "publish" | "permission" = "plan"
  ): Promise<{ approvalId: string; evidenceDigest: string }> => {
    const evidence = { test: "evidence", runId, kind };
    const evidenceDigest = digestApprovalEvidence(evidence, kind);
    const approvalId = ApprovalIdSchema.parse(
      `apr_${crypto.randomUUID()}`
    );
    const result = requestApproval(
      {
        workspaceId: WORKSPACE_ID,
        runId: RunIdSchema.parse(runId),
        kind,
        evidence,
        eligibleApproverIds: ["local-user"],
        actor: { kind: "user", id: "local-user" },
        correlationId: runId.slice(runId.indexOf("_") + 1)
      },
      {
        now: () => NOW,
        approvalId: () => approvalId
      }
    );
    const append: StreamAppend = {
      stream: { kind: "run", id: runId },
      expectedVersion: 0, // Will be wrong, need to find right version
      events: result.events
    };
    // Read the stream to get the current version.
    const events = await store.readStream({ stream: { kind: "run", id: runId } });
    const version = events.length > 0 ? events[events.length - 1]!.streamVersion : 0;
    await store.commit({
      idempotency: {
        scope: `test:seed-approval:${WORKSPACE_ID}`,
        key: `${runId}:${approvalId}`
      },
      appends: [{
        stream: { kind: "run", id: runId },
        expectedVersion: version,
        events: result.events
      }],
      jobs: []
    });
    return { approvalId, evidenceDigest };
  };

  return { app, store, authenticated, createRun, seedApproval };
};

// ---------------------------------------------------------------------------
// Approval list route
// ---------------------------------------------------------------------------

describe("approval inbox (GET /v1/approvals)", () => {
  it("requires authentication", async () => {
    const { app, store } = await makeHarness();
    const response = await app.request("/v1/approvals");
    expect(response.status).toBe(401);
    await store.close();
  });

  it("returns empty items when no approvals exist", async () => {
    const { authenticated, store } = await makeHarness();
    const response = await authenticated("/v1/approvals");
    expect(response.status).toBe(200);
    const body = ListApprovalsResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(0);
    expect(body.nextCursor).toBeUndefined();
    await store.close();
  });

  it("defaults to pending status and lists pending approvals", async () => {
    const { authenticated, store, createRun, seedApproval } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    await seedApproval(runId, "plan");

    const response = await authenticated("/v1/approvals");
    const body = ListApprovalsResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.status).toBe("pending");
    expect(body.items[0]!.kind).toBe("plan");
    await store.close();
  });

  it("excludes decided approvals from pending list", async () => {
    const { authenticated, store, createRun, seedApproval } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    const { approvalId, evidenceDigest } = await seedApproval(runId, "plan");

    // Decide the approval.
    await authenticated(`/v1/runs/${runId}/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        evidenceDigest,
        origin: "desktop"
      })
    });

    const response = await authenticated("/v1/approvals?status=pending");
    const body = ListApprovalsResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(0);
    await store.close();
  });

  it("shows decided approvals when filtering by approved status", async () => {
    const { authenticated, store, createRun, seedApproval } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    const { approvalId, evidenceDigest } = await seedApproval(runId, "plan");

    await authenticated(`/v1/runs/${runId}/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        evidenceDigest,
        origin: "desktop"
      })
    });

    const response = await authenticated("/v1/approvals?status=approved");
    const body = ListApprovalsResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.status).toBe("approved");
    await store.close();
  });

  it("includes permission approvals alongside plan approvals", async () => {
    const { authenticated, store, createRun, seedApproval } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    await seedApproval(runId, "plan");
    await seedApproval(runId, "permission");

    const response = await authenticated("/v1/approvals?status=pending");
    const body = ListApprovalsResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(2);
    const kinds = body.items.map((item) => item.kind).sort();
    expect(kinds).toEqual(["permission", "plan"]);
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Approval decision route
// ---------------------------------------------------------------------------

describe("approval decision (POST /v1/runs/:runId/approvals/:approvalId/decision)", () => {
  it("requires authentication", async () => {
    const { app, store } = await makeHarness();
    const response = await app.request(
      "/v1/runs/run_123e4567-e89b-42d3-a456-426614174099/approvals/apr_123e4567-e89b-42d3-a456-426614174099/decision",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          evidenceDigest: "a".repeat(64),
          origin: "desktop"
        })
      }
    );
    expect(response.status).toBe(401);
    await store.close();
  });

  it("returns 404 for an unknown run", async () => {
    const { authenticated, store } = await makeHarness();
    const response = await authenticated(
      "/v1/runs/run_00000000-0000-4000-8000-000000000000/approvals/apr_00000000-0000-4000-8000-000000000001/decision",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          evidenceDigest: "a".repeat(64),
          origin: "desktop"
        })
      }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "run_not_found" } });
    await store.close();
  });

  it("returns 400 for malformed body", async () => {
    const { authenticated, store, createRun } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    const response = await authenticated(
      `/v1/runs/${runId}/approvals/apr_00000000-0000-4000-8000-000000000001/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{invalid"
      }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    await store.close();
  });

  it("returns 413 for oversized body", async () => {
    const { authenticated, store, createRun } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    const response = await authenticated(
      `/v1/runs/${runId}/approvals/apr_00000000-0000-4000-8000-000000000001/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "200000"
        },
        body: JSON.stringify({
          decision: "approved",
          evidenceDigest: "a".repeat(64),
          origin: "desktop",
          note: "x".repeat(180_000)
        })
      }
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
    await store.close();
  });

  it("does NOT require Idempotency-Key (D9)", async () => {
    const { authenticated, store, createRun, seedApproval } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    const { approvalId, evidenceDigest } = await seedApproval(runId, "plan");

    // Request without Idempotency-Key should succeed.
    const response = await authenticated(
      `/v1/runs/${runId}/approvals/${approvalId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          evidenceDigest,
          origin: "desktop"
        })
      }
    );
    expect(response.status).toBe(200);
    const body = ApprovalDecisionResponseSchema.parse(await response.json());
    expect(body.status).toBe("approved");
    expect(body.replayed).toBe(false);
    await store.close();
  });

  it("replays the same decision with identical decidedAt (D9)", async () => {
    const { authenticated, store, createRun, seedApproval } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    const { approvalId, evidenceDigest } = await seedApproval(runId, "plan");

    const request: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "approved",
        evidenceDigest,
        origin: "desktop"
      })
    };

    const first = await authenticated(
      `/v1/runs/${runId}/approvals/${approvalId}/decision`,
      request
    );
    const firstBody = ApprovalDecisionResponseSchema.parse(await first.json());
    expect(firstBody.replayed).toBe(false);

    const second = await authenticated(
      `/v1/runs/${runId}/approvals/${approvalId}/decision`,
      request
    );
    const secondBody = ApprovalDecisionResponseSchema.parse(await second.json());
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.decidedAt).toBe(firstBody.decidedAt);
    await store.close();
  });

  it("returns 409 for the opposite decision (D9)", async () => {
    const { authenticated, store, createRun, seedApproval } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    const { approvalId, evidenceDigest } = await seedApproval(runId, "plan");

    await authenticated(
      `/v1/runs/${runId}/approvals/${approvalId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          evidenceDigest,
          origin: "desktop"
        })
      }
    );

    const oppositeResponse = await authenticated(
      `/v1/runs/${runId}/approvals/${approvalId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "rejected",
          evidenceDigest,
          origin: "desktop"
        })
      }
    );
    expect(oppositeResponse.status).toBe(409);
    expect(await oppositeResponse.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    await store.close();
  });

  it("returns 404 for cross-run approval access", async () => {
    const { authenticated, store, createRun, seedApproval } = await makeHarness();
    const { runId: runId1 } = await createRun("Run 1");
    const { runId: runId2 } = await createRun("Run 2");
    const { approvalId, evidenceDigest } = await seedApproval(runId1, "plan");

    // Try to decide approval from run1 using run2's route.
    const response = await authenticated(
      `/v1/runs/${runId2}/approvals/${approvalId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          evidenceDigest,
          origin: "desktop"
        })
      }
    );
    expect(response.status).toBe(404);
    await store.close();
  });

  it("errors never contain a stack trace or the bearer token", async () => {
    const { authenticated, store, createRun } = await makeHarness();
    const { runId } = await createRun("Build the foundation");
    const response = await authenticated(
      `/v1/runs/${runId}/approvals/apr_00000000-0000-4000-8000-000000000001/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          evidenceDigest: "a".repeat(64),
          origin: "desktop"
        })
      }
    );
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("at ");
    expect(text).not.toContain(TOKEN);
    await store.close();
  });
});
