import { describe, expect, it } from "vitest";

import {
  PIPELINE_STAGES,
  PipelineEvidenceSchema,
  PipelineStageRequestSchema,
  PublicationEvidenceBundleSchema,
  ReviewEvidenceSchema,
  assertPipelineTransition
} from "../src/pipeline.js";

const identity = {
  workspaceId: "ws_123e4567-e89b-42d3-a456-426614174000",
  workItemId: "wi_123e4567-e89b-42d3-a456-426614174000",
  runId: "run_123e4567-e89b-42d3-a456-426614174000"
} as const;

const digest = (character: string): string => character.repeat(64);
const publicationEvidence = () => ({
  schemaVersion: 1 as const,
  ...identity,
  plan: {
    schemaVersion: 1 as const,
    ...identity,
    stage: "plan" as const,
    evidenceDigest: digest("1"),
    artifactIds: [],
    producedAt: "2026-08-23T12:00:00.000Z",
    planDigest: digest("a")
  },
  planApproval: {
    schemaVersion: 1 as const,
    ...identity,
    stage: "plan_approval" as const,
    evidenceDigest: digest("2"),
    artifactIds: [],
    producedAt: "2026-08-23T12:01:00.000Z",
    approvalId: "apr_123e4567-e89b-42d3-a456-426614174000",
    decision: "approved" as const,
    approvedEvidenceDigest: digest("1"),
    actorId: "local-user"
  },
  implementation: {
    schemaVersion: 1 as const,
    ...identity,
    stage: "implement" as const,
    evidenceDigest: digest("3"),
    artifactIds: ["art_123e4567-e89b-42d3-a456-426614174000"],
    producedAt: "2026-08-23T12:02:00.000Z",
    planApprovalEvidenceDigest: digest("2"),
    agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174000",
    environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
    sourceCommit: "a".repeat(40),
    resultCommit: "b".repeat(40),
    finalDiffDigest: digest("f")
  },
  verification: {
    schemaVersion: 1 as const,
    ...identity,
    stage: "verify" as const,
    evidenceDigest: digest("4"),
    artifactIds: [],
    producedAt: "2026-08-23T12:03:00.000Z",
    implementationEvidenceDigest: digest("3"),
    status: "passed" as const
  },
  review: {
    schemaVersion: 1 as const,
    ...identity,
    stage: "isolated_review" as const,
    evidenceDigest: digest("5"),
    artifactIds: [],
    producedAt: "2026-08-23T12:04:00.000Z",
    implementationEvidenceDigest: digest("3"),
    verificationEvidenceDigest: digest("4"),
    reviewedDiffDigest: digest("f"),
    implementation: {
      agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174000",
      environmentId: "env_123e4567-e89b-42d3-a456-426614174000"
    },
    reviewer: {
      agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174001",
      environmentId: "env_123e4567-e89b-42d3-a456-426614174001"
    },
    verdict: "approved" as const,
    findings: []
  },
  publishScope: {
    schemaVersion: 1 as const,
    ...identity,
    repositoryFullName: "autostack/factory",
    base: "main",
    head: "autostack/issue-42",
    finalDiffDigest: digest("f"),
    action: "create_draft_pr" as const,
    scopeDigest: digest("6"),
    createdAt: "2026-08-23T12:05:00.000Z"
  },
  publishApproval: {
    schemaVersion: 1 as const,
    ...identity,
    stage: "publish_approval" as const,
    evidenceDigest: digest("7"),
    artifactIds: [],
    producedAt: "2026-08-23T12:06:00.000Z",
    approvalId: "apr_123e4567-e89b-42d3-a456-426614174001",
    decision: "approved" as const,
    approvedEvidenceDigest: digest("6"),
    reviewEvidenceDigest: digest("5"),
    publishScopeDigest: digest("6"),
    actorId: "local-user"
  }
});

describe("delivery pipeline contracts", () => {
  it("locks the human-gated reviewed-draft sequence", () => {
    expect(PIPELINE_STAGES).toEqual([
      "triage",
      "plan",
      "plan_approval",
      "implement",
      "verify",
      "isolated_review",
      "publish_approval",
      "draft_pr"
    ]);
    expect(assertPipelineTransition("plan", "plan_approval")).toBe("plan_approval");
    expect(() => assertPipelineTransition("implement", "draft_pr")).toThrow();
  });

  it("requires idempotency and prior evidence for every stage request", () => {
    const request = PipelineStageRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: "pipeline:run:verify:1",
      ...identity,
      stage: "verify",
      attempt: 1,
      inputEvidenceDigests: ["a".repeat(64)],
      requestedAt: "2026-08-23T12:00:00.000Z"
    });
    expect(request.stage).toBe("verify");
    expect(() => PipelineStageRequestSchema.parse({ ...request, idempotencyKey: "" })).toThrow();
  });

  it("proves review isolation from implementation", () => {
    const review = ReviewEvidenceSchema.parse({
      schemaVersion: 1,
      ...identity,
      stage: "isolated_review",
      evidenceDigest: "b".repeat(64),
      artifactIds: ["art_123e4567-e89b-42d3-a456-426614174000"],
      producedAt: "2026-08-23T12:00:00.000Z",
      implementationEvidenceDigest: digest("3"),
      verificationEvidenceDigest: digest("4"),
      reviewedDiffDigest: digest("f"),
      implementation: {
        agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174000",
        environmentId: "env_123e4567-e89b-42d3-a456-426614174000"
      },
      reviewer: {
        agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174001",
        environmentId: "env_123e4567-e89b-42d3-a456-426614174001"
      },
      verdict: "approved",
      findings: []
    });
    expect(review.verdict).toBe("approved");
    expect(() =>
      ReviewEvidenceSchema.parse({ ...review, reviewer: { ...review.implementation } })
    ).toThrow();
  });

  it("uses a discriminated evidence envelope", () => {
    expect(
      PipelineEvidenceSchema.parse({
        schemaVersion: 1,
        ...identity,
        stage: "plan_approval",
        evidenceDigest: "c".repeat(64),
        artifactIds: [],
        producedAt: "2026-08-23T12:00:00.000Z",
        approvalId: "apr_123e4567-e89b-42d3-a456-426614174000",
        decision: "approved",
        approvedEvidenceDigest: "d".repeat(64),
        actorId: "local-user"
      }).stage
    ).toBe("plan_approval");
  });

  it("binds publication to approved plan, implementation, verification, review, and scope", () => {
    const evidence = PublicationEvidenceBundleSchema.parse(publicationEvidence());
    expect(evidence.publishScope.action).toBe("create_draft_pr");
    expect(evidence.review.verdict).toBe("approved");
  });

  it("rejects a stale review of an earlier diff", () => {
    const evidence = publicationEvidence();
    expect(() =>
      PublicationEvidenceBundleSchema.parse({
        ...evidence,
        review: { ...evidence.review, reviewedDiffDigest: digest("e") }
      })
    ).toThrow();
  });

  it("rejects review evidence from an unrelated run or implementation", () => {
    const evidence = publicationEvidence();
    expect(() =>
      PublicationEvidenceBundleSchema.parse({
        ...evidence,
        review: {
          ...evidence.review,
          runId: "run_123e4567-e89b-42d3-a456-426614174099"
        }
      })
    ).toThrow();
    expect(() =>
      PublicationEvidenceBundleSchema.parse({
        ...evidence,
        review: {
          ...evidence.review,
          implementation: {
            ...evidence.review.implementation,
            agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174099"
          }
        }
      })
    ).toThrow();
  });

  it("rejects a failed or changes-requested review", () => {
    const evidence = publicationEvidence();
    expect(() =>
      PublicationEvidenceBundleSchema.parse({
        ...evidence,
        review: { ...evidence.review, verdict: "changes_requested" }
      })
    ).toThrow();
    expect(() =>
      PublicationEvidenceBundleSchema.parse({
        ...evidence,
        review: { ...evidence.review, verdict: "failed" }
      })
    ).toThrow();
  });
});
