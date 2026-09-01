import { describe, expect, it, vi } from "vitest";

import type { GitHubProgressCommentRequest } from "@autostack/contracts";

import { GitHubRequestError } from "../../src/errors.js";
import { createProgressCommentsClient } from "../../src/client/progress-comments.js";
import { createMemoryIdempotencyStore } from "../../src/idempotency.js";
import { createGitHubTransport } from "../../src/client/transport.js";

const USER_AGENT = "autostack-test/1.0";

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

const commentPayload = (overrides: Partial<Record<string, unknown>> = {}): unknown => ({
  id: 555,
  html_url: "https://github.com/autostack/factory/issues/42#issuecomment-555",
  updated_at: "2026-08-23T12:10:00Z",
  ...overrides
});

const buildClient = (fetch: typeof globalThis.fetch) => {
  const transport = createGitHubTransport({
    fetch,
    userAgent: USER_AGENT,
    authorization: async () => "Bearer test-token"
  });
  return createProgressCommentsClient({
    transport,
    idempotencyStore: createMemoryIdempotencyStore()
  });
};

const buildRequest = (
  overrides: Partial<GitHubProgressCommentRequest> = {}
): GitHubProgressCommentRequest => ({
  schemaVersion: 1,
  idempotencyKey: "run-idempotency-1",
  bindingRef: "binding-ref-1",
  repositoryFullName: "autostack/factory",
  issueNumber: 42,
  body: "Stage: planning complete. Moving to implementation.",
  evidenceDigest: hex("1"),
  ...overrides
});

describe("createProgressCommentsClient", () => {
  it("creates a comment via POST when commentId is absent, returning updated:false", async () => {
    const request = buildRequest();
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(commentPayload()));
    const client = buildClient(recording.fetch);

    const result = await client.upsertProgressComment(request);

    expect(recording.calls).toHaveLength(1);
    const call = recording.calls[0];
    if (call === undefined) throw new Error("expected a recorded fetch call");
    expect(call.url).toBe("https://api.github.com/repos/autostack/factory/issues/42/comments");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({ body: request.body });

    expect(result.updated).toBe(false);
    expect(result.commentId).toBe(555);
    expect(result.url).toBe("https://github.com/autostack/factory/issues/42#issuecomment-555");
  });

  // Guard: the wrong implementation is one that POSTs on every call, including when a commentId
  // was supplied to edit an existing comment. A stubbed `updated: true` result field proves
  // nothing about what request was actually sent (a broken client could hard-code that field), so
  // this asserts the HTTP method AND path of the call itself: PATCH against the specific comment
  // id, never POST against the issue's comments collection.
  it("edits the comment in place via PATCH when commentId is supplied, never creating a second comment", async () => {
    const request = buildRequest({ commentId: 555 });
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(commentPayload({ id: 555 })));
    const client = buildClient(recording.fetch);

    const result = await client.upsertProgressComment(request);

    expect(recording.calls).toHaveLength(1);
    const call = recording.calls[0];
    if (call === undefined) throw new Error("expected a recorded fetch call");
    expect(call.url).toBe("https://api.github.com/repos/autostack/factory/issues/comments/555");
    expect(call.init.method).toBe("PATCH");
    expect(JSON.parse(String(call.init.body))).toEqual({ body: request.body });

    expect(result.updated).toBe(true);
    expect(result.commentId).toBe(555);
  });

  it("replays the recorded result for a repeated idempotency key, performing no second fetch call", async () => {
    const request = buildRequest();
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(commentPayload()));
    const client = buildClient(recording.fetch);

    const first = await client.upsertProgressComment(request);

    // Guard: distinguishes a real replay table from an implementation that simply re-executes
    // and happens to return an equal value. Stubbing the transport to explode on any further
    // call means a re-executing implementation fails loudly here rather than silently passing.
    recording.setHandler(() => {
      throw new Error("must not be reached: replay must short-circuit before this handler runs");
    });
    const second = await client.upsertProgressComment(request);

    expect(second).toEqual(first);
    expect(recording.calls).toHaveLength(1);
  });

  it("fails closed with not_found when the edited comment was deleted by a human, without recreating it", async () => {
    const request = buildRequest({ commentId: 555 });
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse({ message: "Not Found" }, 404));
    const client = buildClient(recording.fetch);

    const failure = await client.upsertProgressComment(request).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubRequestError);
    expect((failure as GitHubRequestError).status).toBe(404);
    expect((failure as GitHubRequestError).code).toBe("not_found");
    // No fallback POST was attempted after the PATCH 404 -- exactly one call total.
    expect(recording.calls).toHaveLength(1);
  });

  describe("the body gate", () => {
    it("rejects a body containing sensitive material before any fetch call", async () => {
      const request = buildRequest({ body: `Token leaked: ghp_${"A".repeat(20)}` });
      const { fetch, calls } = createRecordingFetch();
      const client = buildClient(fetch);

      await expect(client.upsertProgressComment(request)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });

    it("rejects a body over the schema maximum (60000 characters) before any fetch call", async () => {
      const request = buildRequest({ body: "a".repeat(60_001) });
      const { fetch, calls } = createRecordingFetch();
      const client = buildClient(fetch);

      await expect(client.upsertProgressComment(request)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });

    // Guard (accept-case companion): `containsSensitiveMaterial` returns `true` from its own
    // internal catch block, so a BROKEN gate (one that always throws, or one wired to reject
    // unconditionally) would also make both reject-case tests above pass -- "reject every body"
    // satisfies "reject a sensitive body" and "reject an over-budget body" equally well. This
    // proves the gate lets an ordinary, in-budget, non-sensitive body through and the call is
    // actually made.
    it("accepts an ordinary body at exactly the schema maximum and posts it", async () => {
      const request = buildRequest({ body: "a".repeat(60_000) });
      const recording = createRecordingFetch();
      recording.setHandler(() => jsonResponse(commentPayload()));
      const client = buildClient(recording.fetch);

      const result = await client.upsertProgressComment(request);

      expect(recording.calls).toHaveLength(1);
      expect(result.commentId).toBe(555);
    });
  });

  it("runs GitHubProgressCommentRequestSchema.parse first, rejecting an unknown extra field via .strict()", async () => {
    const request = { ...buildRequest(), unknownField: "not allowed" };
    const { fetch, calls } = createRecordingFetch();
    const client = buildClient(fetch);

    await expect(
      client.upsertProgressComment(request as unknown as GitHubProgressCommentRequest)
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
