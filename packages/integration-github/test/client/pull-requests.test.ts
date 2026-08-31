import { describe, expect, it, vi } from "vitest";

import { digestVersionedValue, type DraftPullRequestRequest } from "@autostack/contracts";

import { GitHubBranchPolicyError, GitHubRequestError } from "../../src/errors.js";
import {
  PULL_REQUEST_EVIDENCE_DIGEST_DOMAIN,
  createDraftPullRequestsClient
} from "../../src/client/pull-requests.js";
import { createMemoryIdempotencyStore } from "../../src/idempotency.js";
import { createGitHubTransport } from "../../src/client/transport.js";
import { composeDraftPullRequestBody } from "../../src/pull-request-body/compose.js";
import { renderDraftPullRequestBody } from "../../src/pull-request-body/render.js";
import {
  buildPublicationEvidenceFixture,
  type PublicationEvidenceFixture,
  type PublicationEvidenceOverrides
} from "../fixtures/publication-evidence.js";

const USER_AGENT = "autostack-test/1.0";
const RUN_URL = "https://factory.local/runs/run_123e4567-e89b-42d3-a456-426614174000";
const CHANGE_SUMMARY = "Backfilled the export-visibility flag for pre-v2 workspaces.";
const CREATED_AT = "2026-08-23T12:10:00.000Z";

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

type FetchHandler = (call: RecordedCall, callIndex: number) => Response | Promise<Response>;

const createRecordingFetch = (): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: RecordedCall[];
  setHandler(handler: FetchHandler): void;
} => {
  const calls: RecordedCall[] = [];
  let handler: FetchHandler = () => {
    throw new Error("no fetch handler configured for this test");
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    setHandler: (nextHandler) => {
      handler = nextHandler;
    }
  };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const pullRequestPayload = (overrides: Partial<Record<string, unknown>> = {}): unknown => ({
  number: 42,
  html_url: "https://github.com/autostack/factory/pull/42",
  draft: true,
  created_at: CREATED_AT,
  head: { sha: "head-sha-value" },
  ...overrides
});

const buildClient = (fetch: typeof globalThis.fetch) => {
  const transport = createGitHubTransport({
    fetch,
    userAgent: USER_AGENT,
    authorization: async () => "Bearer test-token"
  });
  return createDraftPullRequestsClient({
    transport,
    idempotencyStore: createMemoryIdempotencyStore()
  });
};

const buildRequest = async (
  overrides: PublicationEvidenceOverrides = {},
  fieldOverrides: Partial<{ idempotencyKey: string; title: string }> = {}
): Promise<{ request: DraftPullRequestRequest; fixture: PublicationEvidenceFixture }> => {
  const fixture = await buildPublicationEvidenceFixture(overrides);
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

  const request: DraftPullRequestRequest = {
    schemaVersion: 1,
    idempotencyKey: fieldOverrides.idempotencyKey ?? "run-idempotency-1",
    repositoryFullName: fixture.publishScopeFields.repositoryFullName,
    head: fixture.publishScopeFields.head,
    base: fixture.publishScopeFields.base,
    title: fieldOverrides.title ?? "Restore export button for pre-v2 workspaces",
    body,
    draft: true,
    finalDiffDigest: fixture.publishScopeFields.finalDiffDigest,
    publicationEvidence: fixture.bundle
  };

  return { request, fixture };
};

describe("createDraftPullRequestsClient", () => {
  // Guard: distinguishes "admits before calling" from "calls then validates". An implementation
  // that POSTs first and only checks admission afterward (e.g. catching a GitHub error and then
  // separately validating) would still throw here, but it would have invoked fetch once. The
  // discriminating assertion is fetchStub-never-called, not merely the rejection.
  it("admits the request first: a broken publish-scope digest chain rejects with zero fetch calls", async () => {
    const { request } = await buildRequest();
    const tampered: DraftPullRequestRequest = {
      ...request,
      publicationEvidence: {
        ...request.publicationEvidence,
        publishScope: {
          ...request.publicationEvidence.publishScope,
          // Breaks admitPublicationEvidenceBundle's own scopeDigest recomputation check, without
          // touching any field DraftPullRequestRequestSchema's binding superRefine compares --
          // this is specifically the "publish-scope digest chain" admission does, not a schema
          // shape error.
          scopeDigest: hex("9")
        }
      }
    };
    const { fetch, calls } = createRecordingFetch();
    const client = buildClient(fetch);

    await expect(client.createDraftPullRequest(tampered)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses a head outside autostack/ before any network call, even when the approved publish scope names it", async () => {
    const { request } = await buildRequest({ publishScope: { head: "feature/not-autostack" } });
    const { fetch } = createRecordingFetch();
    const client = buildClient(fetch);

    await expect(client.createDraftPullRequest(request)).rejects.toThrow(GitHubBranchPolicyError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates the draft PR with draft:true and the scope's head/base, producing a schema-valid result with a digest computed by the contracts' own helper", async () => {
    const { request } = await buildRequest();
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(pullRequestPayload()));
    const client = buildClient(recording.fetch);

    const result = await client.createDraftPullRequest(request);

    expect(recording.calls).toHaveLength(1);
    const call = recording.calls[0];
    if (call === undefined) throw new Error("expected a recorded fetch call");
    expect(call.url).toBe("https://api.github.com/repos/autostack/factory/pulls");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({
      title: request.title,
      body: request.body,
      head: "autostack/issue-42",
      base: "main",
      draft: true
    });

    expect(result.draft).toBe(true);
    expect(result.number).toBe(42);
    expect(result.url).toBe("https://github.com/autostack/factory/pull/42");
    expect(result.repositoryFullName).toBe("autostack/factory");
    expect(result.idempotencyKey).toBe(request.idempotencyKey);

    const expectedDigest = await digestVersionedValue(PULL_REQUEST_EVIDENCE_DIGEST_DOMAIN, {
      number: 42,
      url: "https://github.com/autostack/factory/pull/42",
      headSha: "head-sha-value",
      createdAt: CREATED_AT
    });
    expect(result.providerEvidenceDigest).toBe(expectedDigest);
  });

  it("replays an identical result for a repeated idempotency key, performing no second fetch call", async () => {
    const { request } = await buildRequest();
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(pullRequestPayload()));
    const client = buildClient(recording.fetch);

    const first = await client.createDraftPullRequest(request);
    const second = await client.createDraftPullRequest(request);

    expect(second).toEqual(first);
    // Guard: distinguishes a real replay table from an implementation that simply re-executes and
    // happens to return an equal value (e.g. because the stub is deterministic). Only a call-count
    // assertion catches that -- an equality-only assertion would pass either way.
    expect(recording.calls).toHaveLength(1);
  });

  it("replay precedes failure injection: a replayed key still returns the recorded result even when the transport is now stubbed to fail (fake parity)", async () => {
    const { request } = await buildRequest();
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(pullRequestPayload()));
    const client = buildClient(recording.fetch);

    const first = await client.createDraftPullRequest(request);

    recording.setHandler(() => {
      throw new Error("must not be reached: replay must short-circuit before this handler runs");
    });
    const second = await client.createDraftPullRequest(request);

    expect(second).toEqual(first);
    expect(recording.calls).toHaveLength(1);
  });

  describe("duplicate recovery on a 422", () => {
    it("looks up the existing PR with the exact query head={owner}:{branch}&state=all&base={base}, never a bare branch", async () => {
      const { request } = await buildRequest();
      const recording = createRecordingFetch();
      recording.setHandler((_call, index) => {
        if (index === 0) return jsonResponse({ message: "A pull request already exists" }, 422);
        return jsonResponse([
          pullRequestPayload({
            number: 99,
            html_url: "https://github.com/autostack/factory/pull/99"
          })
        ]);
      });
      const client = buildClient(recording.fetch);

      const result = await client.createDraftPullRequest(request);

      expect(recording.calls).toHaveLength(2);
      expect(recording.calls[0]?.init.method).toBe("POST");
      const lookupCall = recording.calls[1];
      if (lookupCall === undefined) throw new Error("expected a recorded lookup call");
      expect(lookupCall.init.method).toBe("GET");
      expect(lookupCall.url).toBe(
        "https://api.github.com/repos/autostack/factory/pulls?head=autostack%3Aautostack%2Fissue-42&state=all&base=main"
      );
      expect(result.number).toBe(99);
    });

    // Guard: distinguishes head={owner}:{branch}&state=all from a bare-branch head or state=open.
    // The stub only returns the existing PR when the query string contains "state=all"; a
    // state=open implementation would receive an empty array here (a closed PR never matches
    // state=open) and would then wrongly rethrow the original 422 instead of resolving. This is
    // the only one of these tests where a state=open regression produces observably different,
    // discriminating red evidence rather than passing by coincidence.
    it("finds a CLOSED existing PR, which only a state=all query can return", async () => {
      const { request } = await buildRequest();
      const closedPr = pullRequestPayload({
        number: 55,
        html_url: "https://github.com/autostack/factory/pull/55"
      });
      const recording = createRecordingFetch();
      recording.setHandler((call, index) => {
        if (index === 0) return jsonResponse({ message: "A pull request already exists" }, 422);
        const query = new URL(call.url).search;
        return query.includes("state=all") ? jsonResponse([closedPr]) : jsonResponse([]);
      });
      const client = buildClient(recording.fetch);

      const result = await client.createDraftPullRequest(request);

      expect(result.number).toBe(55);
      expect(recording.calls).toHaveLength(2);
    });

    it("rethrows the original 422 rather than inventing a result when the lookup finds nothing", async () => {
      const { request } = await buildRequest();
      const recording = createRecordingFetch();
      recording.setHandler((_call, index) => {
        if (index === 0) return jsonResponse({ message: "A pull request already exists" }, 422);
        return jsonResponse([]);
      });
      const client = buildClient(recording.fetch);

      const failure = await client.createDraftPullRequest(request).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GitHubRequestError);
      expect((failure as GitHubRequestError).status).toBe(422);
      expect(recording.calls).toHaveLength(2);
    });
  });

  it("rejects a provider response reporting draft:false rather than accepting it", async () => {
    const { request } = await buildRequest();
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(pullRequestPayload({ draft: false })));
    const client = buildClient(recording.fetch);

    await expect(client.createDraftPullRequest(request)).rejects.toThrow(GitHubRequestError);
  });
});
