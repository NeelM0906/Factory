// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApprovalSummarySchema, createId, type ApprovalSummary } from "@autostack/contracts";

import { createApiClient, type AutoStackApiClient } from "../src/api-client.js";
import { createMockApiServer, seedFactoryFixture } from "../src/testing/index.js";
import { useApprovals } from "../src/approvals/use-approvals.js";

const TOKEN = "test-token";
const PAGINATION_FAILURE_MESSAGE = "More approvals could not be loaded. Try again.";

function buildApprovalSummary(overrides: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return ApprovalSummarySchema.parse({
    approvalId: createId("approval"),
    runId: createId("run"),
    workItemId: createId("workItem"),
    title: "Plan approval for run",
    kind: "plan",
    status: "pending",
    evidenceDigest: "1".repeat(64),
    requestedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  });
}

function makeApprovalsClient(): AutoStackApiClient {
  return {
    health: vi.fn(),
    listRuns: vi.fn(),
    listRunEvents: vi.fn(),
    createRun: vi.fn(),
    listApprovals: vi.fn(),
    decideApproval: vi.fn(),
    steerRun: vi.fn(),
    cancelRun: vi.fn(),
    answerClarification: vi.fn()
  };
}

describe("useApprovals: paging", () => {
  it("loads every pending approval past the first window", async () => {
    const fixture = seedFactoryFixture({ approvalCount: 137 });
    const server = createMockApiServer({ fixture });
    const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });
    const { result } = renderHook(() => useApprovals(client));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.state.approvals).toHaveLength(25);
    expect(result.current.state.nextCursor).toBe(25);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.state.approvals).toHaveLength(137);
    expect(result.current.state.nextCursor).toBeUndefined();
  });

  it(
    "does not double-fetch while a pagination request is in flight " +
      "(wrong impl: no in-flight gate would double the request count)",
    async () => {
      const fixture = seedFactoryFixture({ approvalCount: 137 });
      const server = createMockApiServer({ fixture });
      const fetchSpy = vi.fn(server.fetch);
      const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: fetchSpy });
      const { result } = renderHook(() => useApprovals(client));

      await waitFor(() => expect(result.current.state.status).toBe("ready"));
      fetchSpy.mockClear();

      let firstCall!: Promise<void>;
      let secondCall!: Promise<void>;
      act(() => {
        firstCall = result.current.loadMore();
        secondCall = result.current.loadMore();
      });
      await act(async () => {
        await Promise.all([firstCall, secondCall]);
      });
      expect(result.current.state.approvals).toHaveLength(137);

      const approvalRequests = fetchSpy.mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : input.toString();
        return url.includes("/v1/approvals");
      });
      // 5 remaining pages (25 items each) exhaust the other 112 approvals. A second, unguarded
      // loadMore() would double every one of those requests.
      expect(approvalRequests).toHaveLength(5);
    }
  );

  it(
    "keeps loaded approvals visible when a later page fails, and reports a distinct pagination " +
      "message (wrong impl: an error path that clears the list)",
    async () => {
      const fixture = seedFactoryFixture({ approvalCount: 60 });
      const server = createMockApiServer({ fixture });
      let approvalCallCount = 0;
      const flakyFetch: typeof globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/v1/approvals")) {
          approvalCallCount += 1;
          if (approvalCallCount === 2) throw new Error("Simulated network failure.");
        }
        return server.fetch(input, init);
      };
      const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: flakyFetch });
      const { result } = renderHook(() => useApprovals(client));

      await waitFor(() => expect(result.current.state.status).toBe("ready"));
      expect(result.current.state.approvals).toHaveLength(25);

      await act(async () => {
        await result.current.loadMore();
      });

      expect(result.current.state.approvals).toHaveLength(25);
      expect(result.current.state.paginationMessage).toBe(PAGINATION_FAILURE_MESSAGE);
      expect(result.current.state.loadingMore).toBe(false);
    }
  );

  it("de-duplicates approvals across pages by approvalId (wrong impl: naive concat)", async () => {
    const overlapping = buildApprovalSummary({ title: "Overlap approval" });
    const firstPage = [buildApprovalSummary({ title: "First approval" }), overlapping];
    const secondPage = [overlapping, buildApprovalSummary({ title: "Second approval" })];
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals)
      .mockResolvedValueOnce({ items: firstPage, nextCursor: 2 })
      .mockResolvedValueOnce({ items: secondPage });

    const { result } = renderHook(() => useApprovals(client));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.state.approvals).toHaveLength(2);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.state.approvals).toHaveLength(3);
    expect(
      result.current.state.approvals.filter(
        (approval) => approval.approvalId === overlapping.approvalId
      )
    ).toHaveLength(1);
  });

  it("renders a disconnected, empty state when there is no client", () => {
    const { result } = renderHook(() => useApprovals(null));

    expect(result.current.state.status).toBe("disconnected");
    expect(result.current.state.approvals).toEqual([]);
  });

  it("surfaces an error state when the initial load fails", async () => {
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useApprovals(client));

    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.state.approvals).toEqual([]);
    expect(result.current.state.message).toBeTruthy();
  });

  it("aborts the in-flight request when the hook unmounts", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = makeApprovalsClient();
    vi.mocked(client.listApprovals).mockImplementation(
      (_query, signal) =>
        new Promise((_resolve, reject) => {
          requestSignal = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    const { unmount } = renderHook(() => useApprovals(client));

    await waitFor(() => expect(requestSignal).toBeDefined());
    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });
});
