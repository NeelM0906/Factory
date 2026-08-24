import { describe, expect, it } from "vitest";

import {
  ChannelBindingSchema,
  DraftPullRequestRequestSchema,
  IngressDeliverySchema,
  admitDraftPullRequestRequest
} from "../src/integration.js";
import { digestPublishScope } from "../src/pipeline.js";

const workspaceId = "ws_123e4567-e89b-42d3-a456-426614174000";
const projectId = "prj_123e4567-e89b-42d3-a456-426614174000";
const credentialRefId = "cred_123e4567-e89b-42d3-a456-426614174000";
const workItemId = "wi_123e4567-e89b-42d3-a456-426614174000";
const runId = "run_123e4567-e89b-42d3-a456-426614174000";
const digest = (character: string): string => character.repeat(64);
const evidenceContext = { schemaVersion: 1 as const, workspaceId, workItemId, runId };
const publicationEvidence = () => ({
  ...evidenceContext,
  plan: {
    ...evidenceContext,
    stage: "plan" as const,
    evidenceDigest: digest("1"),
    artifactIds: [],
    producedAt: "2026-08-23T12:00:00.000Z",
    planDigest: digest("a")
  },
  planApproval: {
    ...evidenceContext,
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
    ...evidenceContext,
    stage: "implement" as const,
    evidenceDigest: digest("3"),
    artifactIds: [],
    producedAt: "2026-08-23T12:02:00.000Z",
    planApprovalEvidenceDigest: digest("2"),
    agentSessionId: "agt_123e4567-e89b-42d3-a456-426614174000",
    environmentId: "env_123e4567-e89b-42d3-a456-426614174000",
    sourceCommit: "a".repeat(40),
    resultCommit: "b".repeat(40),
    finalDiffDigest: digest("f")
  },
  verification: {
    ...evidenceContext,
    stage: "verify" as const,
    evidenceDigest: digest("4"),
    artifactIds: [],
    producedAt: "2026-08-23T12:03:00.000Z",
    implementationEvidenceDigest: digest("3"),
    status: "passed" as const
  },
  review: {
    ...evidenceContext,
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
    ...evidenceContext,
    repositoryFullName: "autostack/factory",
    base: "main",
    head: "autostack/issue-42",
    finalDiffDigest: digest("f"),
    action: "create_draft_pr" as const,
    scopeDigest: digest("6"),
    createdAt: "2026-08-23T12:05:00.000Z"
  },
  publishApproval: {
    ...evidenceContext,
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

describe("integration contracts", () => {
  it("normalizes GitHub and Slack ingress with stable deduplication keys", () => {
    const github = IngressDeliverySchema.parse({
      schemaVersion: 1,
      provider: "github",
      deliveryId: "gh-delivery-1",
      deduplicationKey: "github:installation-1:gh-delivery-1",
      receivedAt: "2026-08-23T12:00:00.000Z",
      event: "issues.opened",
      repository: { id: "repo-1", fullName: "autostack/factory" },
      issue: { number: 42, title: "Ship it", body: "Acceptance", authorId: "user-1" }
    });
    const slack = IngressDeliverySchema.parse({
      schemaVersion: 1,
      provider: "slack",
      deliveryId: "slack-event-1",
      deduplicationKey: "slack:T01:slack-event-1",
      receivedAt: "2026-08-23T12:00:00.000Z",
      event: "app_mention",
      slackWorkspaceId: "T01",
      channelId: "C01",
      threadTs: "1755950400.000100",
      messageTs: "1755950400.000100",
      userId: "U01",
      text: "Please implement issue 42"
    });
    expect([github.provider, slack.provider]).toEqual(["github", "slack"]);
    expect(() => IngressDeliverySchema.parse({ ...github, extra: true })).toThrow();
  });

  it("binds repositories and channels using only credential references", () => {
    expect(
      ChannelBindingSchema.parse({
        schemaVersion: 1,
        bindingRef: "binding.github.factory",
        workspaceId,
        projectId,
        provider: "github",
        installationId: "installation-1",
        repositoryId: "repo-1",
        repositoryFullName: "autostack/factory",
        credentialRefId,
        enabled: true
      }).provider
    ).toBe("github");
    expect(
      ChannelBindingSchema.parse({
        schemaVersion: 1,
        bindingRef: "binding.slack.factory",
        workspaceId,
        projectId,
        provider: "slack",
        slackWorkspaceId: "T01",
        channelId: "C01",
        botCredentialRefId: credentialRefId,
        signingCredentialRefId: credentialRefId,
        enabled: true
      }).provider
    ).toBe("slack");
  });

  it("only permits evidence-backed draft pull requests", async () => {
    const evidence = publicationEvidence();
    const scopeDigest = await digestPublishScope(evidence.publishScope);
    evidence.publishScope.scopeDigest = scopeDigest;
    evidence.publishApproval.approvedEvidenceDigest = scopeDigest;
    evidence.publishApproval.publishScopeDigest = scopeDigest;
    const input = {
      schemaVersion: 1,
      idempotencyKey: "draft-pr:run:1",
      repositoryFullName: "autostack/factory",
      head: "autostack/issue-42",
      base: "main",
      title: "Implement issue 42",
      body: "Reviewed implementation",
      draft: true,
      finalDiffDigest: digest("f"),
      publicationEvidence: evidence
    } as const;
    const request = await admitDraftPullRequestRequest(input);
    expect(request.draft).toBe(true);
    expect(() => DraftPullRequestRequestSchema.parse({ ...request, draft: false })).toThrow();
    expect(() =>
      DraftPullRequestRequestSchema.parse({ ...request, head: "autostack/unapproved-head" })
    ).toThrow();

    const alteredScope = {
      ...evidence.publishScope,
      repositoryFullName: "autostack/unapproved"
    };
    await expect(
      admitDraftPullRequestRequest({
        ...input,
        repositoryFullName: alteredScope.repositoryFullName,
        publicationEvidence: { ...evidence, publishScope: alteredScope }
      })
    ).rejects.toThrow("Publish scope digest");
  });
});
