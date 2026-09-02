import { createId } from "@autostack/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureRunSupervisionSource } from "../src/testing/index.js";

const uuid = (counter: number): string => {
  const hex = counter.toString(16).padStart(30, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(12, 15)}`,
    `8${hex.slice(15, 18)}`,
    hex.slice(18, 30)
  ].join("-");
};

const runId = createId("run", uuid(1));
const otherRunId = createId("run", uuid(2));
const sessionId = createId("agentSession", uuid(3));
const workspaceId = createId("workspace", uuid(4));
const workItemId = createId("workItem", uuid(5));

const OCCURRED_AT = "2026-08-20T12:00:00.000Z";
const PLAN_DIGEST = "a".repeat(64);

function messageEvent(sequence: number, text = "Hello from the fixture."): unknown {
  return {
    schemaVersion: 1,
    sessionId,
    sequence,
    occurredAt: OCCURRED_AT,
    type: "message",
    role: "assistant",
    text
  };
}

function validPlanDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workspaceId,
    workItemId,
    runId,
    planDigest: PLAN_DIGEST,
    summary: "Implement the thing.",
    acceptanceCriteria: ["It works."],
    affectedAreas: ["packages/client-app"],
    risks: [],
    verificationCommands: [
      { executable: "pnpm", args: ["test"], usesShell: false, required: true }
    ],
    requiredPermissions: [],
    requiredCredentialRefIds: [],
    producedAt: OCCURRED_AT
  };
}

function validVerificationReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workspaceId,
    workItemId,
    runId,
    planDigest: PLAN_DIGEST,
    status: "passed",
    results: [
      {
        command: { executable: "pnpm", args: ["test"], usesShell: false, required: true },
        status: "passed",
        exitCode: 0,
        durationMs: 1_200,
        startedAt: OCCURRED_AT,
        outputDigest: "b".repeat(64)
      }
    ],
    producedAt: OCCURRED_AT
  };
}

function validReviewReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workspaceId,
    workItemId,
    runId,
    planDigest: PLAN_DIGEST,
    reviewedDiffDigest: "c".repeat(64),
    verificationReportDigest: "b".repeat(64),
    verdict: "approved",
    summary: "Looks good.",
    findings: [],
    producedAt: OCCURRED_AT
  };
}

describe("createFixtureRunSupervisionSource", () => {
  it("returns only session events after the given sequence, parsed through the contract schema", async () => {
    const source = createFixtureRunSupervisionSource({
      sessionEvents: { [runId]: [messageEvent(1, "first"), messageEvent(3, "third")] }
    });

    const events = await source.sessionEvents(runId, 1);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: 3, text: "third" });
  });

  it("returns no session events for a run the fixture never mentions", async () => {
    const source = createFixtureRunSupervisionSource({});

    await expect(source.sessionEvents(otherRunId, 0)).resolves.toEqual([]);
  });

  it("returns the fixtured plan document parsed through its contract schema", async () => {
    const source = createFixtureRunSupervisionSource({
      planDocuments: { [runId]: validPlanDocument() }
    });

    await expect(source.planDocument(runId)).resolves.toMatchObject({ planDigest: PLAN_DIGEST });
  });

  it("returns undefined for a plan document the fixture never mentions", async () => {
    const source = createFixtureRunSupervisionSource({});

    await expect(source.planDocument(runId)).resolves.toBeUndefined();
  });

  it("returns the fixtured verification report parsed through its contract schema", async () => {
    const source = createFixtureRunSupervisionSource({
      verificationReports: { [runId]: validVerificationReport() }
    });

    await expect(source.verificationReport(runId)).resolves.toMatchObject({ status: "passed" });
  });

  it("returns undefined for a verification report the fixture never mentions", async () => {
    const source = createFixtureRunSupervisionSource({});

    await expect(source.verificationReport(runId)).resolves.toBeUndefined();
  });

  it("returns the fixtured review report parsed through its contract schema", async () => {
    const source = createFixtureRunSupervisionSource({
      reviewReports: { [runId]: validReviewReport() }
    });

    await expect(source.reviewReport(runId)).resolves.toMatchObject({ verdict: "approved" });
  });

  it("returns undefined for a review report the fixture never mentions", async () => {
    const source = createFixtureRunSupervisionSource({});

    await expect(source.reviewReport(runId)).resolves.toBeUndefined();
  });

  it("rejects with AbortError when the signal is already aborted, and serves a live signal", async () => {
    const source = createFixtureRunSupervisionSource({
      sessionEvents: { [runId]: [messageEvent(1)] }
    });
    const aborted = new AbortController();
    aborted.abort();

    // Rejection must be the abort, not a lookup failure: assert the DOMException name.
    await expect(source.sessionEvents(runId, 0, aborted.signal)).rejects.toMatchObject({
      name: "AbortError"
    });
    // Positive companion: a not-aborted signal must not trip the same check.
    await expect(
      source.sessionEvents(runId, 0, new AbortController().signal)
    ).resolves.toHaveLength(1);
  });

  it("throws at construction when a fixture session event does not satisfy the contract schema", () => {
    expect(() =>
      createFixtureRunSupervisionSource({
        // Missing the required `text` field a "message" event must carry.
        sessionEvents: {
          [runId]: [
            {
              schemaVersion: 1,
              sessionId,
              sequence: 1,
              occurredAt: OCCURRED_AT,
              type: "message",
              role: "assistant"
            }
          ]
        }
      })
    ).toThrow();
  });

  it("throws at construction when a fixture plan document does not satisfy the contract schema", () => {
    expect(() =>
      createFixtureRunSupervisionSource({
        planDocuments: { [runId]: { ...validPlanDocument(), planDigest: "not-a-digest" } }
      })
    ).toThrow();
  });
});
