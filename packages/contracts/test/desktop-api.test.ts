import { describe, expect, it } from "vitest";

import {
  ApprovalDecisionResponseSchema,
  CancelRunResponseSchema,
  ListApprovalsResponseSchema,
  SteerRunResponseSchema
} from "../src/api.js";
import {
  DesktopApiOperationMapSchema,
  DesktopApiRequestSchemaByOperation,
  DesktopApiResponseSchemaByOperation
} from "../src/desktop-api.js";

const approvalId = "apr_123e4567-e89b-42d3-a456-426614174000";
const runId = "run_123e4567-e89b-42d3-a456-426614174000";
const digest = "a".repeat(64);

const parseOperation = (request: Record<string, unknown>): unknown =>
  DesktopApiOperationMapSchema.parse(request);

describe("desktop approval and steering operations", () => {
  it("registers every new operation in the request map, the union, and the response map", () => {
    for (const operation of [
      "factory.approvals.list",
      "factory.approvals.decide",
      "factory.runs.steer",
      "factory.runs.cancel"
    ] as const) {
      expect(DesktopApiRequestSchemaByOperation[operation]).toBeDefined();
      expect(DesktopApiResponseSchemaByOperation[operation]).toBeDefined();
    }
    expect(DesktopApiResponseSchemaByOperation["factory.approvals.list"]).toBe(
      ListApprovalsResponseSchema
    );
    expect(DesktopApiResponseSchemaByOperation["factory.approvals.decide"]).toBe(
      ApprovalDecisionResponseSchema
    );
    expect(DesktopApiResponseSchemaByOperation["factory.runs.steer"]).toBe(SteerRunResponseSchema);
    expect(DesktopApiResponseSchemaByOperation["factory.runs.cancel"]).toBe(
      CancelRunResponseSchema
    );
  });

  it("pages the approval inbox with the same defaults and bounds as the HTTP query", () => {
    const listed = DesktopApiRequestSchemaByOperation["factory.approvals.list"].parse({
      operation: "factory.approvals.list"
    });
    expect(listed).toEqual({
      operation: "factory.approvals.list",
      status: "pending",
      limit: 25
    });
    expect(
      DesktopApiRequestSchemaByOperation["factory.approvals.list"].parse({
        operation: "factory.approvals.list",
        status: "approved",
        limit: 100,
        cursor: 7
      }).cursor
    ).toBe(7);
    expect(() => parseOperation({ operation: "factory.approvals.list", limit: 101 })).toThrow();
    expect(() => parseOperation({ operation: "factory.approvals.list", cursor: 0 })).toThrow();
    expect(() =>
      parseOperation({ operation: "factory.approvals.list", unexpected: true })
    ).toThrow();
  });

  it("decides an approval without letting the renderer author identity", () => {
    const decision = DesktopApiRequestSchemaByOperation["factory.approvals.decide"].parse({
      operation: "factory.approvals.decide",
      approvalId,
      decision: "approved",
      evidenceDigest: digest,
      origin: "desktop"
    });
    expect(decision).toMatchObject({ approvalId, decision: "approved", origin: "desktop" });
    expect(decision).not.toHaveProperty("idempotencyKey");
    expect(() =>
      parseOperation({
        operation: "factory.approvals.decide",
        approvalId,
        decision: "approved",
        evidenceDigest: digest,
        origin: "desktop",
        idempotencyKey: "approval:decide:1"
      })
    ).toThrow();
    expect(() =>
      parseOperation({
        operation: "factory.approvals.decide",
        approvalId,
        decision: "approved",
        evidenceDigest: digest,
        origin: "slack"
      })
    ).toThrow();
    expect(() =>
      parseOperation({
        operation: "factory.approvals.decide",
        approvalId,
        decision: "approved",
        origin: "desktop"
      })
    ).toThrow();
  });

  it("steers and cancels a run through the same shapes the HTTP routes accept", () => {
    expect(
      DesktopApiRequestSchemaByOperation["factory.runs.steer"].parse({
        operation: "factory.runs.steer",
        runId,
        instruction: "Prefer the smaller refactor."
      })
    ).toEqual({
      operation: "factory.runs.steer",
      runId,
      instruction: "Prefer the smaller refactor."
    });
    expect(
      DesktopApiRequestSchemaByOperation["factory.runs.cancel"].parse({
        operation: "factory.runs.cancel",
        runId,
        reason: "The operator withdrew the run."
      }).reason
    ).toBe("The operator withdrew the run.");
    expect(() =>
      parseOperation({ operation: "factory.runs.steer", runId, instruction: "" })
    ).toThrow();
    expect(() => parseOperation({ operation: "factory.runs.cancel", runId })).toThrow();
    expect(() =>
      parseOperation({ operation: "factory.runs.cancel", runId: approvalId, reason: "Wrong id." })
    ).toThrow();
  });
});
