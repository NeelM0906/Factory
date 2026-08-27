import { describe, expect, it } from "vitest";

import {
  DraftPullRequestResultSchema,
  GitHubProgressCommentResultSchema,
  SlackProgressRequestSchema,
  admitDraftPullRequestRequest,
  digestPublishScope,
  type DraftPullRequestRequest
} from "@autostack/contracts";

import { createFakeDeliveryIntegration } from "../src/testing/fake-delivery-integration.js";

const workspaceId = "ws_123e4567-e89b-42d3-a456-426614174000";
const workItemId = "wi_123e4567-e89b-42d3-a456-426614174000";
const runId = "run_123e4567-e89b-42d3-a456-426614174000";
const repositoryFullName = "autostack/factory";
const digest = (character: string): string => character.repeat(64);
const evidenceContext = { schemaVersion: 1 as const, workspaceId, workItemId, runId };

const createClock = (): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 26, 12, 0, tick)).toISOString();
  };
};

const createCounter = (start: number): (() => number) => {
  let issued = start - 1;
  return () => {
    issued += 1;
    return issued;
  };
};

const publicationEvidence = async (): Promise<Record<string, unknown>> => {
  const publishScope = {
    ...evidenceContext,
    repositoryFullName,
    base: "main",
    head: "autostack/issue-42",
    finalDiffDigest: digest("f"),
    action: "create_draft_pr" as const,
    scopeDigest: digest("6"),
    createdAt: "2026-08-23T12:05:00.000Z"
  };
  const scopeDigest = await digestPublishScope(publishScope);
  return {
    ...evidenceContext,
    plan: {
      ...evidenceContext,
      stage: "plan",
      evidenceDigest: digest("1"),
      artifactIds: [],
      producedAt: "2026-08-23T12:00:00.000Z",
      planDigest: digest("a")
    },
    planApproval: {
      ...evidenceContext,
      stage: "plan_approval",
      evidenceDigest: digest("2"),
      artifactIds: [],
      producedAt: "2026-08-23T12:01:00.000Z",
      approvalId: "apr_123e4567-e89b-42d3-a456-426614174000",
      decision: "approved",
      approvedEvidenceDigest: digest("1"),
      actorId: "local-user"
    },
    implementation: {
      ...evidenceContext,
      stage: "implement",
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
      stage: "verify",
      evidenceDigest: digest("4"),
      artifactIds: [],
      producedAt: "2026-08-23T12:03:00.000Z",
      implementationEvidenceDigest: digest("3"),
      status: "passed"
    },
    review: {
      ...evidenceContext,
      stage: "isolated_review",
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
      verdict: "approved",
      findings: []
    },
    publishScope: { ...publishScope, scopeDigest },
    publishApproval: {
      ...evidenceContext,
      stage: "publish_approval",
      evidenceDigest: digest("7"),
      artifactIds: [],
      producedAt: "2026-08-23T12:06:00.000Z",
      approvalId: "apr_123e4567-e89b-42d3-a456-426614174001",
      decision: "approved",
      approvedEvidenceDigest: scopeDigest,
      reviewEvidenceDigest: digest("5"),
      publishScopeDigest: scopeDigest,
      actorId: "local-user"
    }
  };
};

const draftPullRequestInput = async (): Promise<Record<string, unknown>> => ({
  schemaVersion: 1,
  idempotencyKey: "draft-pr:run:1",
  repositoryFullName,
  head: "autostack/issue-42",
  base: "main",
  title: "Implement issue 42",
  body: "Reviewed implementation",
  draft: true,
  finalDiffDigest: digest("f"),
  publicationEvidence: await publicationEvidence()
});

const draftPullRequest = async (): Promise<DraftPullRequestRequest> =>
  admitDraftPullRequestRequest(await draftPullRequestInput());

const progressComment = SlackProgressRequestSchema.parse({
  schemaVersion: 1,
  idempotencyKey: "slack-progress:run:implement",
  bindingRef: "binding.slack.factory",
  threadTs: "1755950400.000100",
  text: "Implementing the approved plan.",
  evidenceDigest: digest("9")
});

const gitHubComment = {
  schemaVersion: 1 as const,
  idempotencyKey: "github-progress:run:implement",
  bindingRef: "binding.github.factory",
  repositoryFullName,
  issueNumber: 42,
  body: "Implementing the approved plan.",
  evidenceDigest: digest("9")
};

const createIntegration = (
  failures?: Parameters<typeof createFakeDeliveryIntegration>[0]["failures"]
) =>
  createFakeDeliveryIntegration({
    now: createClock(),
    pullRequestNumber: createCounter(101),
    commentId: createCounter(9_001),
    providerEvidenceDigest: () => digest("b"),
    ...(failures === undefined ? {} : { failures })
  });

describe("fake delivery integration draft pull requests", () => {
  it("admits the publication evidence before recording a contract-valid draft PR", async () => {
    const integration = createIntegration();

    const result = await integration.createDraftPullRequest(await draftPullRequest());

    expect(DraftPullRequestResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      repositoryFullName,
      number: 101,
      draft: true,
      providerEvidenceDigest: digest("b")
    });
    expect(integration.pullRequests).toEqual([result]);
    expect(integration.branches).toEqual([
      { repositoryFullName, base: "main", head: "autostack/issue-42" }
    ]);
  });

  it("refuses a request whose publish scope digest does not cover its own fields", async () => {
    const integration = createIntegration();
    const request = await draftPullRequestInput();
    const evidence = request["publicationEvidence"] as Record<string, unknown>;
    const scope = evidence["publishScope"] as Record<string, unknown>;

    await expect(
      integration.createDraftPullRequest({
        ...request,
        publicationEvidence: { ...evidence, publishScope: { ...scope, base: "release" } }
      } as unknown as DraftPullRequestRequest)
    ).rejects.toThrow();
    expect(integration.pullRequests).toEqual([]);
    expect(integration.branches).toEqual([]);
  });

  it("returns the recorded pull request for a repeated idempotency key", async () => {
    const integration = createIntegration();
    const request = await draftPullRequest();

    const first = await integration.createDraftPullRequest(request);
    const replay = await integration.createDraftPullRequest(request);

    expect(replay).toEqual(first);
    expect(integration.pullRequests).toHaveLength(1);
    expect(integration.branches).toHaveLength(1);
  });
});

describe("fake delivery integration progress comments", () => {
  it("creates one comment and edits it in place under the same identity", async () => {
    const integration = createIntegration();

    const created = await integration.upsertProgressComment(gitHubComment);
    expect(GitHubProgressCommentResultSchema.parse(created)).toEqual(created);
    expect(created).toMatchObject({ commentId: 9_001, updated: false });

    const edited = await integration.upsertProgressComment({
      ...gitHubComment,
      idempotencyKey: "github-progress:run:verify",
      commentId: created.commentId,
      body: "Verification passed."
    });

    expect(edited).toMatchObject({ commentId: 9_001, updated: true });
    expect(integration.comments).toEqual([
      {
        repositoryFullName,
        issueNumber: 42,
        commentId: 9_001,
        body: "Verification passed.",
        evidenceDigest: digest("9"),
        updatedAt: edited.postedAt
      }
    ]);
  });

  it("returns the existing comment for a repeated idempotency key", async () => {
    const integration = createIntegration();

    const created = await integration.upsertProgressComment(gitHubComment);
    const replay = await integration.upsertProgressComment(gitHubComment);

    expect(replay).toEqual(created);
    expect(integration.comments).toHaveLength(1);
  });

  it("refuses to edit a comment identity it never created", async () => {
    const integration = createIntegration();

    await expect(
      integration.upsertProgressComment({ ...gitHubComment, commentId: 4_242 })
    ).rejects.toThrow();
    expect(integration.comments).toEqual([]);
  });

  it("deduplicates Slack progress by idempotency key", async () => {
    const integration = createIntegration();

    await integration.postSlackProgress(progressComment);
    await integration.postSlackProgress(progressComment);
    await integration.postSlackProgress({
      ...progressComment,
      idempotencyKey: "slack-progress:run:verify"
    });

    expect(integration.slackProgress.map((post) => post.idempotencyKey)).toEqual([
      "slack-progress:run:implement",
      "slack-progress:run:verify"
    ]);
  });
});

describe("fake delivery integration failure injection", () => {
  it("fails a declared operation once and records nothing until the retry succeeds", async () => {
    const injected = new Error("The provider returned 502.");
    const integration = createIntegration({ createDraftPullRequest: [injected] });
    const request = await draftPullRequest();

    await expect(integration.createDraftPullRequest(request)).rejects.toBe(injected);
    expect(integration.pullRequests).toEqual([]);

    const retried = await integration.createDraftPullRequest(request);

    expect(retried).toMatchObject({ number: 101 });
    expect(integration.pullRequests).toHaveLength(1);
  });

  it("replays a recorded pull request without consuming a queued failure", async () => {
    const injected = new Error("The provider returned 502.");
    const integration = createIntegration({ createDraftPullRequest: [undefined, injected] });
    const request = await draftPullRequest();

    const first = await integration.createDraftPullRequest(request);
    const replay = await integration.createDraftPullRequest(request);

    expect(replay).toEqual(first);
    expect(integration.pullRequests).toHaveLength(1);

    const second = await admitDraftPullRequestRequest({
      ...(await draftPullRequestInput()),
      idempotencyKey: "draft-pr:run:2"
    });
    await expect(integration.createDraftPullRequest(second)).rejects.toBe(injected);
  });

  it("hands out copies so a consumer cannot mutate recorded state", async () => {
    const integration = createIntegration();
    await integration.postSlackProgress(progressComment);
    await integration.upsertProgressComment(gitHubComment);
    await integration.createDraftPullRequest(await draftPullRequest());

    for (const view of [
      integration.slackProgress,
      integration.comments,
      integration.pullRequests,
      integration.branches
    ]) {
      expect(view).toHaveLength(1);
    }
    expect(integration.slackProgress).not.toBe(integration.slackProgress);
    expect(integration.comments).not.toBe(integration.comments);
    expect(integration.pullRequests).not.toBe(integration.pullRequests);
    expect(integration.branches).not.toBe(integration.branches);
  });

  it("injects failures independently per operation", async () => {
    const slackFailure = new Error("Slack rate limited the workspace.");
    const integration = createIntegration({ postSlackProgress: [slackFailure] });

    await expect(integration.postSlackProgress(progressComment)).rejects.toBe(slackFailure);
    await expect(integration.upsertProgressComment(gitHubComment)).resolves.toMatchObject({
      updated: false
    });
    expect(integration.slackProgress).toEqual([]);
  });
});
