import { describe, expect, it, vi } from "vitest";

import { GitHubBranchPolicyError } from "../../src/errors.js";
import { createChecksClient } from "../../src/client/checks.js";
import { createGitHubTransport } from "../../src/client/transport.js";

const USER_AGENT = "autostack-test/1.0";
const REPOSITORY_FULL_NAME = "autostack/factory";
const FORTY_HEX_SHA = "a".repeat(40);

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

const checkRunsPayload = (checkRuns: readonly Record<string, unknown>[]): unknown => ({
  total_count: checkRuns.length,
  check_runs: checkRuns
});

const buildClient = (fetch: typeof globalThis.fetch) => {
  const transport = createGitHubTransport({
    fetch,
    userAgent: USER_AGENT,
    authorization: async () => "Bearer test-token"
  });
  return createChecksClient(transport);
};

describe("createChecksClient", () => {
  it("lists check runs for a commit SHA, mapping to the narrow {name,status,conclusion,detailsUrl} shape", async () => {
    const recording = createRecordingFetch();
    recording.setHandler(() =>
      jsonResponse(
        checkRunsPayload([
          {
            id: 1,
            name: "lint",
            status: "completed",
            conclusion: "success",
            details_url: "https://ci.example.com/runs/1",
            started_at: "2026-08-23T12:00:00Z"
          },
          {
            id: 2,
            name: "typecheck",
            status: "in_progress",
            conclusion: null,
            details_url: null
          }
        ])
      )
    );
    const client = buildClient(recording.fetch);

    const result = await client.listCheckRuns({
      repositoryFullName: REPOSITORY_FULL_NAME,
      ref: FORTY_HEX_SHA
    });

    expect(recording.calls).toHaveLength(1);
    const call = recording.calls[0];
    if (call === undefined) throw new Error("expected a recorded fetch call");
    expect(call.url).toBe(
      `https://api.github.com/repos/autostack/factory/commits/${FORTY_HEX_SHA}/check-runs`
    );

    expect(result).toEqual([
      {
        name: "lint",
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://ci.example.com/runs/1"
      },
      { name: "typecheck", status: "in_progress", conclusion: null, detailsUrl: null }
    ]);
  });

  it("accepts an autostack/ branch as ref, normalizing a refs/heads/ prefix via assertAutoStackBranch", async () => {
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(checkRunsPayload([])));
    const client = buildClient(recording.fetch);

    await client.listCheckRuns({
      repositoryFullName: REPOSITORY_FULL_NAME,
      ref: "refs/heads/autostack/issue-42"
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.url).toBe(
      "https://api.github.com/repos/autostack/factory/commits/autostack/issue-42/check-runs"
    );
  });

  it("rejects a ref that is neither a 40-hex SHA nor an autostack/ branch, before any fetch call", async () => {
    const { fetch, calls } = createRecordingFetch();
    const client = buildClient(fetch);

    await expect(
      client.listCheckRuns({ repositoryFullName: REPOSITORY_FULL_NAME, ref: "main" })
    ).rejects.toThrow(GitHubBranchPolicyError);
    expect(fetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  // Guard: the wrong implementation is one that, on seeing a red conclusion, issues a repair
  // call (e.g. re-requesting the failed check) instead of merely reporting the data. Asserting
  // the happy-path result alone would not catch that -- a repair call could still leave the
  // reported data correct. The discriminating assertion is that a "failure" conclusion produces
  // exactly the same one-GET-call shape as a "success" conclusion: no second call, and the method
  // of the only call made is GET.
  it("reports a red (failure) conclusion as plain data and issues no repair call", async () => {
    const recording = createRecordingFetch();
    recording.setHandler(() =>
      jsonResponse(
        checkRunsPayload([
          {
            id: 3,
            name: "build",
            status: "completed",
            conclusion: "failure",
            details_url: "https://ci.example.com/runs/3"
          }
        ])
      )
    );
    const client = buildClient(recording.fetch);

    const result = await client.listCheckRuns({
      repositoryFullName: REPOSITORY_FULL_NAME,
      ref: FORTY_HEX_SHA
    });

    expect(result).toEqual([
      {
        name: "build",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://ci.example.com/runs/3"
      }
    ]);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.init.method).toBe("GET");
  });

  // Guard: read-only means no non-GET call is EVER issued by this module. Checking the happy
  // path's call count alone would not catch an implementation that, say, also PATCHes a status
  // check or POSTs a rerun request alongside the read; every recorded call's method must be GET,
  // not merely "the data came back correctly".
  it("issues only GET calls across every scenario exercised in this suite", async () => {
    const recording = createRecordingFetch();
    recording.setHandler(() => jsonResponse(checkRunsPayload([])));
    const client = buildClient(recording.fetch);

    await client.listCheckRuns({ repositoryFullName: REPOSITORY_FULL_NAME, ref: FORTY_HEX_SHA });
    await client.listCheckRuns({
      repositoryFullName: REPOSITORY_FULL_NAME,
      ref: "autostack/issue-7"
    });

    expect(recording.calls.length).toBeGreaterThan(0);
    expect(recording.calls.every((call) => call.init.method === "GET")).toBe(true);
  });
});
