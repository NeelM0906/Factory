import { describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  ApprovalDecisionRequestSchema,
  ApprovalDecisionResponseSchema,
  CancelRunRequestSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  HealthResponseSchema,
  ListApprovalsQuerySchema,
  ListApprovalsResponseSchema,
  ListEventsResponseSchema,
  ListRunsResponseSchema,
  SteerRunRequestSchema,
  SteerRunResponseSchema
} from "../src/api.js";

const NOW = "2026-08-20T12:00:00.000Z";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174000";
const WORK_ITEM_ID = "wi_123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "run_123e4567-e89b-42d3-a456-426614174000";

describe("HTTP contracts", () => {
  it("normalizes a manual create-run request", () => {
    expect(
      CreateRunRequestSchema.parse({
        title: "  Add local durability  ",
        description: "Persist events",
        acceptanceContext: ["Survives restart"]
      })
    ).toEqual({
      title: "Add local durability",
      description: "Persist events",
      acceptanceContext: ["Survives restart"]
    });
  });

  it("rejects an empty run title", () => {
    expect(() => CreateRunRequestSchema.parse({ title: "   " })).toThrow();
  });

  it("bounds acceptance context count and aggregate size", () => {
    expect(() =>
      CreateRunRequestSchema.parse({
        title: "Too many acceptance items",
        acceptanceContext: Array.from({ length: 51 }, (_, index) => `item-${index}`)
      })
    ).toThrow();
    expect(() =>
      CreateRunRequestSchema.parse({
        title: "Too much aggregate context",
        acceptanceContext: Array.from({ length: 11 }, () => "x".repeat(2_000))
      })
    ).toThrow();
  });

  it("validates health without exposing paths or credentials", () => {
    const health = HealthResponseSchema.parse({
      service: "autostack-control-plane",
      version: "0.1.0",
      status: "ok",
      storage: { status: "ok", journalMode: "wal", schemaVersion: 1 },
      executor: { status: "idle" }
    });

    expect(health.storage.journalMode).toBe("wal");
    expect(health).not.toHaveProperty("dataDirectory");
  });

  it("validates create and list responses", () => {
    const workItem = {
      schemaVersion: 1,
      id: WORK_ITEM_ID,
      workspaceId: WORKSPACE_ID,
      source: { kind: "manual", client: "web" },
      title: "Add local durability",
      description: "Persist events",
      requester: { externalId: "local-user" },
      attachments: [],
      priority: "normal",
      labels: [],
      acceptanceContext: ["Survives restart"],
      createdAt: NOW,
      updatedAt: NOW
    } as const;
    const run = {
      schemaVersion: 1,
      id: RUN_ID,
      workspaceId: WORKSPACE_ID,
      workItemId: WORK_ITEM_ID,
      workflowVersion: "foundation.v1",
      status: "queued",
      createdAt: NOW,
      updatedAt: NOW
    } as const;

    expect(CreateRunResponseSchema.parse({ workItem, run, replayed: false }).run.id).toBe(RUN_ID);
    expect(
      ListRunsResponseSchema.parse({
        items: [
          {
            runId: RUN_ID,
            workItemId: WORK_ITEM_ID,
            title: "Add local durability",
            source: "manual",
            status: "queued",
            lastGlobalSequence: 2,
            createdAt: NOW,
            updatedAt: NOW
          }
        ]
      }).items
    ).toHaveLength(1);
  });

  it("rejects event-list data that is not a stored domain event", () => {
    expect(() => ListEventsResponseSchema.parse({ events: [{ type: "run.created" }] })).toThrow();
  });

  it("keeps API errors stable and free of stack fields", () => {
    expect(
      ApiErrorSchema.parse({
        error: { code: "invalid_request", message: "The request body is invalid." },
        requestId: "request-1"
      })
    ).toEqual({
      error: { code: "invalid_request", message: "The request body is invalid." },
      requestId: "request-1"
    });
    expect(() =>
      ApiErrorSchema.parse({
        error: { code: "internal_error", message: "Failed", stack: "secret stack" }
      })
    ).toThrow();
  });
});

describe("approval and steering HTTP contracts", () => {
  const APPROVAL_ID = "apr_123e4567-e89b-42d3-a456-426614174000";
  const DIGEST = "a".repeat(64);

  it("defaults the approval inbox to pending work", () => {
    expect(ListApprovalsQuerySchema.parse({})).toEqual({ status: "pending", limit: 25 });
    expect(ListApprovalsQuerySchema.parse({ status: "stale", limit: "50" })).toEqual({
      status: "stale",
      limit: 50
    });
    expect(() => ListApprovalsQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => ListApprovalsQuerySchema.parse({ status: "unknown" })).toThrow();
  });

  it("summarizes pending approvals with the evidence a reviewer must see", () => {
    const response = ListApprovalsResponseSchema.parse({
      items: [
        {
          approvalId: APPROVAL_ID,
          runId: RUN_ID,
          workItemId: WORK_ITEM_ID,
          title: "Add local durability",
          kind: "plan",
          status: "pending",
          evidenceDigest: DIGEST,
          requestedAt: NOW,
          updatedAt: NOW
        }
      ]
    });
    expect(response.items[0]?.kind).toBe("plan");
    expect(response.nextCursor).toBeUndefined();
  });

  it("binds an approval decision to the evidence it approves", () => {
    const request = ApprovalDecisionRequestSchema.parse({
      decision: "approved",
      evidenceDigest: DIGEST,
      origin: "desktop"
    });
    expect(request.decision).toBe("approved");
    expect(
      ApprovalDecisionResponseSchema.parse({
        approvalId: APPROVAL_ID,
        runId: RUN_ID,
        status: "approved",
        decidedAt: NOW,
        replayed: false
      }).replayed
    ).toBe(false);
    expect(() =>
      ApprovalDecisionRequestSchema.parse({
        decision: "approved",
        evidenceDigest: "not-a-digest",
        origin: "desktop"
      })
    ).toThrow();
    expect(() =>
      ApprovalDecisionRequestSchema.parse({ decision: "approved", origin: "desktop" })
    ).toThrow();
  });

  it("steers and cancels a live run through bounded instructions", () => {
    expect(
      SteerRunRequestSchema.parse({ instruction: "  Focus on the failing test  " }).instruction
    ).toBe("Focus on the failing test");
    expect(
      SteerRunResponseSchema.parse({ runId: RUN_ID, accepted: true, acceptedAt: NOW }).accepted
    ).toBe(true);
    expect(() => SteerRunRequestSchema.parse({ instruction: "   " })).toThrow();
    expect(CancelRunRequestSchema.parse({ reason: "No longer needed" }).reason).toBe(
      "No longer needed"
    );
    expect(() => CancelRunRequestSchema.parse({ reason: "" })).toThrow();
  });
});
