import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  DeliveryIntegrationPort,
  DraftPullRequestRequest,
  DraftPullRequestResult,
  GitHubProgressCommentRequest,
  GitHubProgressCommentResult,
  GitHubProgressIntegrationPort
} from "@autostack/contracts";

import { createFakeDeliveryIntegration } from "@autostack/domain/testing";

import { createAppInstallationAuth } from "../src/auth/app-installation.js";
import { createUserTokenAuth } from "../src/auth/user-token.js";
import { createGitHubIntegration } from "../src/integration.js";
import { composeDraftPullRequestBody } from "../src/pull-request-body/compose.js";
import { renderDraftPullRequestBody } from "../src/pull-request-body/render.js";
import * as gitHubIndex from "../src/index.js";
import { buildPublicationEvidenceFixture } from "./fixtures/publication-evidence.js";

const USER_AGENT = "autostack-test/1.0";
const REPOSITORY_FULL_NAME = "autostack/factory";
const ISSUE_NUMBER = 42;
const PR_NUMBER = 77;
const COMMENT_ID = 555;
const PR_CREATED_AT = "2026-08-23T12:10:00.000Z";
const COMMENT_CREATED_AT = "2026-08-23T12:11:00.000Z";
const COMMENT_EDITED_AT = "2026-08-23T12:12:00.000Z";
const CHANGE_SUMMARY = "Backfilled the export-visibility flag for pre-v2 workspaces.";
const RUN_URL = "https://factory.local/runs/run_123e4567-e89b-42d3-a456-426614174000";

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A single fetch stub that answers every REST call this suite's scripted sequence makes: create
 * PR, create comment, edit comment. Anything else throws, so a wrong implementation that issues
 * an unexpected extra call (e.g. re-fetching on a replay) fails loudly instead of getting a
 * coincidentally-plausible response.
 */
const buildRestFetchStub = (): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: RecordedCall[];
} => {
  const calls: RecordedCall[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const method = call.init.method ?? "GET";
    const path = new URL(call.url).pathname;

    if (method === "POST" && path === `/repos/${REPOSITORY_FULL_NAME}/pulls`) {
      return jsonResponse({
        number: PR_NUMBER,
        html_url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${PR_NUMBER}`,
        draft: true,
        created_at: PR_CREATED_AT,
        head: { sha: "head-sha-value" }
      });
    }
    if (
      method === "POST" &&
      path === `/repos/${REPOSITORY_FULL_NAME}/issues/${ISSUE_NUMBER}/comments`
    ) {
      return jsonResponse({
        id: COMMENT_ID,
        html_url: `https://github.com/${REPOSITORY_FULL_NAME}/issues/${ISSUE_NUMBER}#issuecomment-${COMMENT_ID}`,
        updated_at: COMMENT_CREATED_AT
      });
    }
    if (
      method === "PATCH" &&
      path === `/repos/${REPOSITORY_FULL_NAME}/issues/comments/${COMMENT_ID}`
    ) {
      return jsonResponse({
        id: COMMENT_ID,
        html_url: `https://github.com/${REPOSITORY_FULL_NAME}/issues/${ISSUE_NUMBER}#issuecomment-${COMMENT_ID}`,
        updated_at: COMMENT_EDITED_AT
      });
    }
    throw new Error(`unexpected fetch call: ${method} ${call.url}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

/** Answers only the app-installation JWT-for-installation-token exchange, on its own transport. */
const buildAuthExchangeFetchStub = (): typeof globalThis.fetch =>
  vi.fn(async () =>
    jsonResponse({ token: "installation-token-value", expires_at: "2030-01-01T00:00:00.000Z" })
  ) as unknown as typeof globalThis.fetch;

const buildDraftPullRequestRequest = async (
  idempotencyKey: string
): Promise<DraftPullRequestRequest> => {
  const fixture = await buildPublicationEvidenceFixture();
  const composed = await composeDraftPullRequestBody({
    bundle: fixture.bundle,
    triage: fixture.triage,
    plan: fixture.plan,
    verification: fixture.verification,
    review: fixture.review,
    changeSummary: CHANGE_SUMMARY,
    runUrl: RUN_URL
  });
  const body = renderDraftPullRequestBody(composed);

  return {
    schemaVersion: 1,
    idempotencyKey,
    repositoryFullName: fixture.publishScopeFields.repositoryFullName,
    head: fixture.publishScopeFields.head,
    base: fixture.publishScopeFields.base,
    title: "Restore export button for pre-v2 workspaces",
    body,
    draft: true,
    finalDiffDigest: fixture.publishScopeFields.finalDiffDigest,
    publicationEvidence: fixture.bundle
  };
};

const buildCommentCreateRequest = (idempotencyKey: string): GitHubProgressCommentRequest => ({
  schemaVersion: 1,
  idempotencyKey,
  bindingRef: "binding-ref-1",
  repositoryFullName: REPOSITORY_FULL_NAME,
  issueNumber: ISSUE_NUMBER,
  body: "Stage: planning complete. Moving to implementation.",
  evidenceDigest: hex("1")
});

const buildCommentEditRequest = (
  idempotencyKey: string,
  commentId: number
): GitHubProgressCommentRequest => ({
  schemaVersion: 1,
  idempotencyKey,
  bindingRef: "binding-ref-1",
  repositoryFullName: REPOSITORY_FULL_NAME,
  issueNumber: ISSUE_NUMBER,
  commentId,
  body: "Stage: implementation complete. Moving to review.",
  evidenceDigest: hex("2")
});

type ScriptableIntegration = Pick<DeliveryIntegrationPort, "createDraftPullRequest"> &
  GitHubProgressIntegrationPort;

interface ScriptedResults {
  readonly created: DraftPullRequestResult;
  readonly replayedCreated: DraftPullRequestResult;
  readonly commentCreated: GitHubProgressCommentResult;
  readonly commentEdited: GitHubProgressCommentResult;
  readonly replayedEdited: GitHubProgressCommentResult;
}

/** The one scripted sequence run against every implementation in this file: create PR, replay
 * create PR, create comment, edit comment, replay edit. */
const runScriptedSequence = async (
  integration: ScriptableIntegration,
  prRequest: DraftPullRequestRequest,
  commentCreateRequest: GitHubProgressCommentRequest,
  buildEditRequest: (commentId: number) => GitHubProgressCommentRequest
): Promise<ScriptedResults> => {
  const created = await integration.createDraftPullRequest(prRequest);
  const replayedCreated = await integration.createDraftPullRequest(prRequest);
  const commentCreated = await integration.upsertProgressComment(commentCreateRequest);
  const editRequest = buildEditRequest(commentCreated.commentId);
  const commentEdited = await integration.upsertProgressComment(editRequest);
  const replayedEdited = await integration.upsertProgressComment(editRequest);
  return { created, replayedCreated, commentCreated, commentEdited, replayedEdited };
};

describe("createGitHubIntegration", () => {
  it("satisfies the GitHub half of DeliveryIntegrationPort plus GitHubProgressIntegrationPort (decision D1)", () => {
    const auth = createUserTokenAuth({ readToken: async () => "ghp_test-token" });
    const integration = createGitHubIntegration({
      auth,
      fetch: buildRestFetchStub().fetch,
      now: () => 1_700_000_000_000,
      userAgent: USER_AGENT
      // idempotency deliberately omitted: this also proves the default-store wiring doesn't throw.
    }) satisfies Pick<DeliveryIntegrationPort, "createDraftPullRequest"> &
      GitHubProgressIntegrationPort;

    expect(typeof integration.createDraftPullRequest).toBe("function");
    expect(typeof integration.upsertProgressComment).toBe("function");
    expect(typeof integration.getRef).toBe("function");
    expect(typeof integration.createBranch).toBe("function");
    expect(typeof integration.deleteBranch).toBe("function");
    expect(typeof integration.putFileOnBranch).toBe("function");
    expect(typeof integration.listCheckRuns).toBe("function");
  });

  describe("fake parity", () => {
    it("agrees with createFakeDeliveryIntegration on updated flags, id stability across replays, and no duplicate side effects", async () => {
      const auth = createUserTokenAuth({ readToken: async () => "ghp_test-token" });
      const restStub = buildRestFetchStub();
      const realIntegration = createGitHubIntegration({
        auth,
        fetch: restStub.fetch,
        now: () => 1_700_000_000_000,
        userAgent: USER_AGENT
      });

      const nowSpy = vi.fn(() => PR_CREATED_AT);
      const pullRequestNumberSpy = vi.fn(() => PR_NUMBER);
      const commentIdSpy = vi.fn(() => COMMENT_ID);
      const fakeIntegration = createFakeDeliveryIntegration({
        now: nowSpy,
        pullRequestNumber: pullRequestNumberSpy,
        commentId: commentIdSpy,
        providerEvidenceDigest: () => hex("9")
      });

      const prRequest = await buildDraftPullRequestRequest("pr-idempotency-1");
      const commentCreateRequest = buildCommentCreateRequest("comment-idempotency-1");
      const buildEdit = (commentId: number): GitHubProgressCommentRequest =>
        buildCommentEditRequest("comment-idempotency-2", commentId);

      const realResults = await runScriptedSequence(
        realIntegration,
        prRequest,
        commentCreateRequest,
        buildEdit
      );
      const fakeResults = await runScriptedSequence(
        fakeIntegration,
        prRequest,
        commentCreateRequest,
        buildEdit
      );

      // Guard-test doctrine: a concrete expected value on each side, not solely a real/fake
      // comparison -- both implementations wrongly returning `updated: true` on create (or vice
      // versa for the edit) would still pass an equality-only assertion between them.
      expect(realResults.commentCreated.updated).toBe(false);
      expect(realResults.commentEdited.updated).toBe(true);
      expect(fakeResults.commentCreated.updated).toBe(false);
      expect(fakeResults.commentEdited.updated).toBe(true);

      // Observable agreement: updated flags.
      expect(realResults.commentCreated.updated).toBe(fakeResults.commentCreated.updated);
      expect(realResults.commentEdited.updated).toBe(fakeResults.commentEdited.updated);
      expect(realResults.replayedEdited.updated).toBe(fakeResults.replayedEdited.updated);

      // Observable agreement: number/commentId stability across replays (each implementation's
      // replayed call returns the same identity as its original call).
      expect(realResults.replayedCreated.number).toBe(realResults.created.number);
      expect(fakeResults.replayedCreated.number).toBe(fakeResults.created.number);
      expect(realResults.commentEdited.commentId).toBe(realResults.commentCreated.commentId);
      expect(fakeResults.commentEdited.commentId).toBe(fakeResults.commentCreated.commentId);
      expect(realResults.replayedEdited.commentId).toBe(realResults.commentEdited.commentId);
      expect(fakeResults.replayedEdited.commentId).toBe(fakeResults.commentEdited.commentId);

      // Observable agreement: draft is always true (spec: AutoStack never opens a ready-for-review
      // PR on its own).
      expect(realResults.created.draft).toBe(true);
      expect(fakeResults.created.draft).toBe(true);

      // Replay short-circuiting / no-duplicate-side-effect property, proven by COUNTING calls, not
      // by comparing returned values -- an implementation that re-executes the side effect on
      // every call but happens to be deterministic would still pass an equality-only check here.
      // Sequence performs exactly 3 real side effects (create PR, create comment, edit comment);
      // both replays must short-circuit before triggering a 4th/5th.
      expect(restStub.calls).toHaveLength(3);
      expect(pullRequestNumberSpy).toHaveBeenCalledTimes(1);
      expect(commentIdSpy).toHaveBeenCalledTimes(1);
      expect(nowSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("auth strategy parity", () => {
    it("drives an identical sequence via createUserTokenAuth and createAppInstallationAuth, with differing describe().kind", async () => {
      const userTokenAuth = createUserTokenAuth({ readToken: async () => "ghp_test-token" });

      // Generated fresh inside the test process, never persisted or committed.
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
      });
      const appInstallationAuth = createAppInstallationAuth({
        appId: "123456",
        privateKeyPem: privateKey,
        installationId: "987654",
        fetch: buildAuthExchangeFetchStub(),
        userAgent: USER_AGENT,
        now: () => 1_700_000_000_000
      });

      expect(userTokenAuth.describe().kind).toBe("user_token");
      expect(appInstallationAuth.describe().kind).toBe("app_installation");
      expect(userTokenAuth.describe().kind).not.toBe(appInstallationAuth.describe().kind);

      const prRequest = await buildDraftPullRequestRequest("pr-idempotency-auth");
      const commentCreateRequest = buildCommentCreateRequest("comment-idempotency-auth-1");
      const buildEdit = (commentId: number): GitHubProgressCommentRequest =>
        buildCommentEditRequest("comment-idempotency-auth-2", commentId);

      const userTokenRestStub = buildRestFetchStub();
      const userTokenIntegration = createGitHubIntegration({
        auth: userTokenAuth,
        fetch: userTokenRestStub.fetch,
        now: () => 1_700_000_000_000,
        userAgent: USER_AGENT
      });
      const userTokenResults = await runScriptedSequence(
        userTokenIntegration,
        prRequest,
        commentCreateRequest,
        buildEdit
      );

      const appInstallationRestStub = buildRestFetchStub();
      const appInstallationIntegration = createGitHubIntegration({
        auth: appInstallationAuth,
        fetch: appInstallationRestStub.fetch,
        now: () => 1_700_000_000_000,
        userAgent: USER_AGENT
      });
      const appInstallationResults = await runScriptedSequence(
        appInstallationIntegration,
        prRequest,
        commentCreateRequest,
        buildEdit
      );

      // Identical canned REST responses drive both auth strategies to identical observable
      // results -- the auth strategy affects only the Authorization header value, never the
      // business outcome recorded from the (identical) response bodies.
      expect(userTokenResults).toEqual(appInstallationResults);
      // Guard: distinguishes "both strategies actually issued the REST calls" from a
      // vacuously-true comparison of two integrations that both did nothing (e.g. both replayed
      // from a shared store, or both never invoked the client at all).
      expect(userTokenRestStub.calls).toHaveLength(3);
      expect(appInstallationRestStub.calls).toHaveLength(3);
    });
  });

  describe("index.ts export surface", () => {
    it("exports exactly the composition-root surface -- every factory, parser, and error class the orchestrator needs, no more, no less", () => {
      const actualExportNames = new Set(Object.keys(gitHubIndex));

      // Set equality, not `toContain` per name (guard-test doctrine): `toContain` passes for any
      // superset, which would let an accidental internal export (e.g. `createGitHubTransport`,
      // `createBranchRefsClient`, `buildGitHubDeliveryDeduplicationKey`) leak onto the public
      // surface forever, undetected. Only set equality rejects both a missing export and an
      // unintended extra one.
      const expectedExportNames = new Set([
        "createGitHubIntegration",
        "createUserTokenAuth",
        "createAppInstallationAuth",
        "verifyGitHubSignature",
        "parseGitHubDelivery",
        "createDeliveryReplayGuard",
        "composeDraftPullRequestBody",
        "renderDraftPullRequestBody",
        "createMemoryIdempotencyStore",
        "assertAutoStackBranch",
        "classifyGitHubFailure",
        "GitHubRequestError",
        "GitHubBranchPolicyError",
        "GitHubBranchConflictError",
        "DraftPullRequestBodyMismatchError",
        "GitHubSignatureError",
        "GitHubUnsupportedEventError"
      ]);

      expect(actualExportNames).toEqual(expectedExportNames);
    });
  });
});
