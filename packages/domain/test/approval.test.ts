import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  ApprovalSchema,
  digestCommandScope,
  digestExecutionScope,
  type Actor
} from "@autostack/contracts";

import {
  ApprovalDecisionConflictError,
  IneligibleApproverError,
  StaleApprovalEvidenceError,
  decideApproval,
  digestApprovalEvidence,
  requestApproval
} from "../src/approval.js";
import { canonicalJson } from "../src/canonical-json.js";

const NOW = "2026-08-20T12:00:00.000Z";
const LATER = "2026-08-20T12:01:00.000Z";
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const WORKSPACE_ID = "ws_123e4567-e89b-42d3-a456-426614174000";
const RUN_ID = "run_123e4567-e89b-42d3-a456-426614174000";
const APPROVAL_ID = "apr_123e4567-e89b-42d3-a456-426614174000";
const ACTOR: Actor = { kind: "user", id: "local-user", displayName: "Local User" };
const EVIDENCE = { branch: "autostack/run-1", plan: { steps: ["change", "test"] } };

describe("approval evidence", () => {
  it("canonicalizes object keys before hashing", () => {
    expect(digestApprovalEvidence({ b: 2, a: 1 })).toBe(
      "6d7a6a5c154a744a14f69f70bd0fef33c78db0d2fdad1b80274224521df9213e"
    );
    expect(digestApprovalEvidence({ b: 2, a: 1 })).toBe(digestApprovalEvidence({ a: 1, b: 2 }));
  });

  it("preserves array ordering in the digest", () => {
    expect(digestApprovalEvidence({ steps: ["one", "two"] })).not.toBe(
      digestApprovalEvidence({ steps: ["two", "one"] })
    );
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n])(
    "rejects non-JSON approval evidence %s",
    (value) => {
      expect(() => digestApprovalEvidence(value)).toThrow();
    }
  );
});

describe("approval decisions", () => {
  const pendingApproval = () =>
    ApprovalSchema.parse({
      schemaVersion: 1,
      id: APPROVAL_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      kind: "plan",
      status: "pending",
      evidenceDigest: digestApprovalEvidence(EVIDENCE),
      eligibleApproverIds: [ACTOR.id],
      createdAt: NOW,
      updatedAt: NOW
    });

  it("requests approval with a validated evidence digest and event", () => {
    const result = requestApproval(
      {
        workspaceId: pendingApproval().workspaceId,
        runId: pendingApproval().runId,
        kind: "plan",
        evidence: EVIDENCE,
        eligibleApproverIds: [ACTOR.id],
        actor: { kind: "system", id: "autostack" },
        correlationId: CORRELATION_ID
      },
      {
        now: () => NOW,
        approvalId: () => pendingApproval().id
      }
    );

    expect(result.approval.evidenceDigest).toBe(digestApprovalEvidence(EVIDENCE));
    expect(result.events[0]).toMatchObject({ type: "approval.requested" });
  });

  it("approves matching evidence and emits one decision event", () => {
    const result = decideApproval({
      approval: pendingApproval(),
      decision: "approved",
      evidence: EVIDENCE,
      actor: ACTOR,
      origin: "desktop",
      occurredAt: LATER,
      correlationId: CORRELATION_ID
    });

    expect(result.approval).toMatchObject({ status: "approved" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "approval.decided",
      payload: { decision: "approved", origin: "desktop" }
    });
  });

  it("returns the original decision without a second event on exact repetition", () => {
    const first = decideApproval({
      approval: pendingApproval(),
      decision: "approved",
      evidence: EVIDENCE,
      actor: ACTOR,
      origin: "desktop",
      occurredAt: LATER,
      correlationId: CORRELATION_ID
    });
    const replay = decideApproval({
      approval: first.approval,
      decision: "approved",
      evidence: EVIDENCE,
      actor: ACTOR,
      origin: "desktop",
      occurredAt: LATER,
      correlationId: CORRELATION_ID
    });

    expect(replay.approval).toEqual(first.approval);
    expect(replay.events).toEqual([]);
  });

  it("rejects changed evidence as stale", () => {
    expect(() =>
      decideApproval({
        approval: pendingApproval(),
        decision: "approved",
        evidence: { ...EVIDENCE, branch: "autostack/changed" },
        actor: ACTOR,
        origin: "desktop",
        occurredAt: LATER,
        correlationId: CORRELATION_ID
      })
    ).toThrow(StaleApprovalEvidenceError);
  });

  it("rejects a conflicting second decision", () => {
    const first = decideApproval({
      approval: pendingApproval(),
      decision: "approved",
      evidence: EVIDENCE,
      actor: ACTOR,
      origin: "desktop",
      occurredAt: LATER,
      correlationId: CORRELATION_ID
    });

    expect(() =>
      decideApproval({
        approval: first.approval,
        decision: "rejected",
        evidence: EVIDENCE,
        actor: ACTOR,
        origin: "desktop",
        occurredAt: LATER,
        correlationId: CORRELATION_ID
      })
    ).toThrow(ApprovalDecisionConflictError);
  });

  it("rejects an actor outside the eligible approver set", () => {
    expect(() =>
      decideApproval({
        approval: pendingApproval(),
        decision: "approved",
        evidence: EVIDENCE,
        actor: { kind: "user", id: "other-user" },
        origin: "desktop",
        occurredAt: LATER,
        correlationId: CORRELATION_ID
      })
    ).toThrow(IneligibleApproverError);
  });

  it("creates plan and permission evidence that exactly matches runner scope digests", async () => {
    const planScope = {
      workspaceId: pendingApproval().workspaceId,
      runId: pendingApproval().runId,
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
      repositoryIdentity: "github:autostack/contracts",
      sourceCommit: "a".repeat(40),
      branch: "autostack/approval-compatibility",
      cwdRoot: ".",
      resourceLimits: { cpu: 1, memoryMb: 1, durationSeconds: 1 },
      networkPolicy: "host" as const,
      filesystemDisclosure: "host_user" as const,
      allowedCredentialRefIds: [
        "cred_123e4567-e89b-42d3-a456-426614174001",
        "cred_123e4567-e89b-42d3-a456-426614174000"
      ]
    };
    const plan = requestApproval(
      {
        workspaceId: pendingApproval().workspaceId,
        runId: pendingApproval().runId,
        kind: "plan",
        evidence: planScope,
        eligibleApproverIds: [ACTOR.id],
        actor: ACTOR,
        correlationId: CORRELATION_ID
      },
      { now: () => NOW, approvalId: () => pendingApproval().id }
    ).approval;
    expect(plan.evidenceDigest).toBe(await digestExecutionScope(planScope));
    expect(plan.evidenceDigest).toBe(
      await digestExecutionScope({
        ...planScope,
        allowedCredentialRefIds: [...planScope.allowedCredentialRefIds].reverse()
      })
    );
    expect(() =>
      decideApproval({
        approval: plan,
        decision: "approved",
        evidence: { ...planScope, branch: "autostack/substituted" },
        actor: ACTOR,
        origin: "desktop",
        occurredAt: LATER,
        correlationId: CORRELATION_ID
      })
    ).toThrow(StaleApprovalEvidenceError);

    const commandScope = {
      environmentAuthorizationId: "envauth_123e4567-e89b-42d3-a456-426614174000",
      environmentAuthorizationDigest: "a".repeat(64),
      workspaceId: pendingApproval().workspaceId,
      runId: pendingApproval().runId,
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
      commandId: "cmd_123e4567-e89b-42d3-a456-426614174000",
      action: "implement" as const,
      commandDigest: "a".repeat(64),
      repositoryIdentity: planScope.repositoryIdentity,
      sourceCommit: planScope.sourceCommit,
      branch: planScope.branch,
      cwdRoot: ".",
      networkPolicy: "host" as const,
      filesystemDisclosure: "host_user" as const,
      resourceLimits: planScope.resourceLimits,
      allowedCredentialRefIds: planScope.allowedCredentialRefIds
    };
    const permission = requestApproval(
      {
        workspaceId: pendingApproval().workspaceId,
        runId: pendingApproval().runId,
        kind: "permission",
        evidence: commandScope,
        eligibleApproverIds: [ACTOR.id],
        actor: ACTOR,
        correlationId: CORRELATION_ID
      },
      { now: () => NOW, approvalId: () => pendingApproval().id }
    ).approval;
    expect(permission.evidenceDigest).toBe(await digestCommandScope(commandScope));
    expect(permission.evidenceDigest).toBe(
      await digestCommandScope({
        ...commandScope,
        allowedCredentialRefIds: [...commandScope.allowedCredentialRefIds].reverse()
      })
    );
  });

  it("decides persisted legacy schema-v1 evidence only when its original evidence still matches", () => {
    const legacyEvidence = { branch: "autostack/legacy", plan: { steps: ["change", "test"] } };
    const legacyDigest = createHash("sha256")
      .update(canonicalJson(legacyEvidence), "utf8")
      .digest("hex");
    const legacyApproval = ApprovalSchema.parse({
      ...pendingApproval(),
      evidenceDigest: legacyDigest
    });

    expect(
      decideApproval({
        approval: legacyApproval,
        decision: "approved",
        evidence: legacyEvidence,
        actor: ACTOR,
        origin: "desktop",
        occurredAt: LATER,
        correlationId: CORRELATION_ID
      }).approval
    ).toMatchObject({ status: "approved" });
    expect(() =>
      decideApproval({
        approval: legacyApproval,
        decision: "approved",
        evidence: { ...legacyEvidence, branch: "autostack/substituted" },
        actor: ACTOR,
        origin: "desktop",
        occurredAt: LATER,
        correlationId: CORRELATION_ID
      })
    ).toThrow(StaleApprovalEvidenceError);
  });
});
