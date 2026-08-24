// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopRuntimeStatus, ListRunsResponse, RunSummary } from "@autostack/contracts";

import { App } from "../src/app.js";
import type { AutoStackApiClient } from "../src/api-client.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const health = {
  service: "autostack-control-plane" as const,
  version: "0.1.0",
  status: "ok" as const,
  storage: { status: "ok" as const, journalMode: "wal" as const, schemaVersion: 1 },
  executor: { status: "idle" as const }
};

const summary = (
  suffix: number,
  title: string,
  status: RunSummary["status"],
  currentStage?: RunSummary["currentStage"]
): RunSummary => ({
  runId:
    `run_123e4567-e89b-42d3-a456-${String(426614174000 + suffix).padStart(12, "0")}` as RunSummary["runId"],
  workItemId:
    `wi_123e4567-e89b-42d3-a456-${String(426614175000 + suffix).padStart(12, "0")}` as RunSummary["workItemId"],
  title,
  source: "manual",
  status,
  ...(currentStage === undefined ? {} : { currentStage }),
  lastGlobalSequence: suffix,
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: `2026-08-20T12:0${suffix}:00.000Z`
});

const makeClient = (runs: readonly RunSummary[] = []): AutoStackApiClient => ({
  health: vi.fn(async () => health),
  listRuns: vi.fn(async () => ({ items: [...runs] })),
  listRunEvents: vi.fn(async (_runId, afterGlobalSequence = 0) => ({
    events: [],
    nextSequence: afterGlobalSequence
  })),
  createRun: vi.fn()
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AutoStack factory console", () => {
  it("discloses desktop host authority before every writable control", async () => {
    render(<App client={makeClient()} executionAuthorityDisclosure />);

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(
      "Local commands run with your desktop user's host filesystem and network authority. AutoStack path checks protect AutoStack operations; they are not an operating-system sandbox."
    );
    const start = screen.getByRole("button", { name: "Start run" });
    expect(warning.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("announces host loss, recovery, and restored desktop runtime readiness", async () => {
    const listeners = new Set<(status: DesktopRuntimeStatus) => void>();
    const runtimeBridge = {
      runtimeStatus: vi.fn(async (): Promise<DesktopRuntimeStatus> => ({ status: "ready" })),
      subscribeRuntimeStatus: vi.fn((listener: (status: DesktopRuntimeStatus) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      })
    };
    render(<App client={makeClient()} runtimeBridge={runtimeBridge} />);

    expect(await screen.findByRole("status", { name: "Desktop runtime ready." })).toBeVisible();
    act(() => {
      for (const listener of listeners) {
        listener({ status: "degraded", message: "Local runtime is restarting." });
      }
    });
    expect(
      screen.getByRole("alert", {
        name: "Desktop runtime recovering. Local runtime is restarting."
      })
    ).toBeVisible();
    act(() => {
      for (const listener of listeners) listener({ status: "ready" });
    });
    expect(screen.getByRole("status", { name: "Desktop runtime ready." })).toBeVisible();
  });

  it("shows eight lifecycle stages and health-derived run metrics", async () => {
    const client = makeClient([
      summary(1, "Implement agent adapter", "implementing", "implement"),
      summary(2, "Approve release", "waiting_for_user"),
      summary(3, "Repair CI", "failed", "verify"),
      summary(4, "Ship foundation", "completed", "publish")
    ]);

    render(<App client={client} />);

    expect(await screen.findByRole("heading", { name: "AutoStack Factory" })).toBeVisible();
    const lifecycle = screen.getByRole("list", { name: "Software delivery lifecycle" });
    expect(within(lifecycle).getAllByRole("listitem")).toHaveLength(8);
    for (const label of [
      "Signal",
      "Triage",
      "Plan",
      "Implement",
      "Validate",
      "Release",
      "Document",
      "Monitor"
    ]) {
      expect(within(lifecycle).getByText(label)).toBeVisible();
    }
    expect(screen.getByText("Control plane healthy")).toBeVisible();
    expect(screen.getByRole("group", { name: "Active runs: 1, In flight" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Waiting runs: 1, Needs input" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Failed runs: 1, Needs attention" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Completed runs: 1, Delivered" })).toBeVisible();
  });

  it("renders durable run details", async () => {
    render(
      <App
        client={makeClient([summary(1, "Implement agent adapter", "implementing", "implement")])}
      />
    );

    const queue = await screen.findByRole("region", { name: "Run queue" });
    expect(within(queue).getByRole("heading", { name: "Implement agent adapter" })).toBeVisible();
    expect(within(queue).getByText("manual")).toBeVisible();
    expect(within(queue).getByRole("status", { name: "Run status: Implementing" })).toBeVisible();
    expect(within(queue).getByText(/Last update/)).toBeVisible();
  });

  it("shows a disconnected state and stores a connection token only for the session", async () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    };
    const clientFactory = vi.fn(() => makeClient());
    render(<App storage={storage} clientFactory={clientFactory} />);

    expect(screen.getByRole("heading", { name: "Connect this AutoStack session" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Local API token"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(storage.setItem).toHaveBeenCalledWith("autostack.local-api-token", TOKEN);
    expect(clientFactory).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "AutoStack Factory" })).toBeVisible();
  });

  it("creates a manual run and refreshes the durable queue", async () => {
    const created = summary(5, "Add Claude teammate", "queued");
    const client = makeClient();
    vi.mocked(client.listRuns)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [created] });
    vi.mocked(client.createRun).mockResolvedValue({
      replayed: false,
      workItem: {} as never,
      run: {} as never
    });
    render(<App client={client} />);
    await screen.findByText("No runs yet");

    fireEvent.change(screen.getByLabelText("Run title"), {
      target: { value: "Add Claude teammate" }
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Connect the local harness." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByRole("heading", { name: "Add Claude teammate" })).toBeVisible();
    expect(client.createRun).toHaveBeenCalledWith(
      {
        title: "Add Claude teammate",
        description: "Connect the local harness.",
        acceptanceContext: []
      },
      expect.any(AbortSignal)
    );
  });

  it("loads an older run page through the server cursor", async () => {
    const client = makeClient();
    const newestPage = {
      items: [summary(2, "Newest run", "queued")],
      nextCursor: 10
    };
    vi.mocked(client.listRuns)
      .mockResolvedValueOnce(newestPage)
      .mockResolvedValueOnce({ items: [summary(1, "Older run", "completed")] })
      .mockResolvedValueOnce(newestPage);
    render(<App client={client} />);

    expect(await screen.findByRole("heading", { name: "Newest run" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));

    expect(await screen.findByRole("heading", { name: "Older run" })).toBeVisible();
    expect(client.listRuns).toHaveBeenNthCalledWith(2, 10, expect.any(AbortSignal));
    expect(client.listRuns).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Load older runs" })).not.toBeInTheDocument();
  });

  it("preserves loaded pages during polling and labels paginated counts as partial", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.mocked(client.listRuns)
      .mockResolvedValueOnce({
        items: [summary(2, "Newest run", "queued")],
        nextCursor: 10
      })
      .mockResolvedValueOnce({
        items: [summary(1, "Older run", "completed")],
        nextCursor: 5
      })
      .mockResolvedValueOnce({
        items: [summary(3, "Polled newest run", "implementing", "implement")],
        nextCursor: 11
      });
    render(<App client={client} pollIntervalMs={5_000} />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Older run" })).toBeVisible();
    expect(screen.getByText("2 loaded")).toBeVisible();
    expect(screen.getByRole("group", { name: "Loaded active runs: 0, In flight" })).toBeVisible();
    expect(
      screen.getByRole("group", { name: "Loaded completed runs: 1, Delivered" })
    ).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByRole("heading", { name: "Polled newest run" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Newest run" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Older run" })).toBeVisible();
    expect(screen.getByText("3 loaded")).toBeVisible();
    expect(client.listRuns).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal));
  });

  it("restarts pagination from a polled cursor and closes churn gaps across retained pages", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    let firstPageReads = 0;
    vi.mocked(client.listRuns).mockImplementation(async (cursor) => {
      if (cursor === undefined) {
        firstPageReads += 1;
        return firstPageReads === 1
          ? {
              items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
              nextCursor: 5
            }
          : {
              items: [
                {
                  ...summary(4, "Reordered run four", "implementing", "implement"),
                  lastGlobalSequence: 10
                },
                summary(9, "Inserted run nine", "queued")
              ],
              nextCursor: 9
            };
      }
      if (cursor === 9) {
        return {
          items: [
            summary(8, "Inserted run eight", "queued"),
            summary(7, "Inserted run seven", "queued")
          ],
          nextCursor: 7
        };
      }
      if (cursor === 7) {
        return {
          items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
          nextCursor: 5
        };
      }
      if (cursor === 5) {
        return {
          items: [summary(4, "Run four", "queued"), summary(3, "Run three", "completed")],
          nextCursor: 3
        };
      }
      if (cursor === 3) {
        return {
          items: [summary(2, "Run two", "completed"), summary(1, "Run one", "completed")]
        };
      }
      throw new Error(`Unexpected run cursor: ${String(cursor)}`);
    });
    render(<App client={client} pollIntervalMs={60_000} />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Run four" })).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByRole("heading", { name: "Reordered run four" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Run four" })).not.toBeInTheDocument();
    expect(screen.getByText("5 loaded")).toBeVisible();

    for (const expectedCursor of [9, 7, 5, 3]) {
      fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
      expect(client.listRuns).toHaveBeenLastCalledWith(expectedCursor, expect.any(AbortSignal));
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(client.listRuns).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal));
    expect(screen.getAllByRole("article")).toHaveLength(9);
    for (const title of [
      "Reordered run four",
      "Inserted run nine",
      "Inserted run eight",
      "Inserted run seven",
      "Run six",
      "Run five",
      "Run three",
      "Run two",
      "Run one"
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
    }
    expect(
      screen
        .getAllByRole("article")
        .map((article) => within(article).getByRole("heading").textContent)
    ).toEqual([
      "Reordered run four",
      "Inserted run nine",
      "Inserted run eight",
      "Inserted run seven",
      "Run six",
      "Run five",
      "Run three",
      "Run two",
      "Run one"
    ]);
    expect(screen.getByText("9 total")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load older runs" })).not.toBeInTheDocument();
  });

  it("does not start pagination while a head refresh is in flight", async () => {
    let resolveRefresh!: (value: ListRunsResponse) => void;
    const pendingRefresh = new Promise<ListRunsResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    let headReads = 0;
    const client = makeClient();
    vi.mocked(client.listRuns).mockImplementation((cursor) => {
      if (cursor === undefined) {
        headReads += 1;
        return headReads === 1
          ? Promise.resolve({
              items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
              nextCursor: 5
            })
          : pendingRefresh;
      }
      return Promise.resolve({
        items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
        nextCursor: 3
      });
    });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Run six" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));

    expect(client.listRuns).toHaveBeenCalledTimes(2);
    expect(client.listRuns).not.toHaveBeenCalledWith(5, expect.any(AbortSignal));

    await act(async () => {
      resolveRefresh({
        items: [summary(7, "Run seven", "queued"), summary(6, "Run six", "queued")],
        nextCursor: 6
      });
      await pendingRefresh;
    });
    expect(screen.getByRole("heading", { name: "Run seven" })).toBeVisible();
  });

  it("continues a refreshed cursor traversal across later polling intervals", async () => {
    vi.useFakeTimers();
    let headReads = 0;
    const client = makeClient();
    vi.mocked(client.listRuns).mockImplementation(async (cursor) => {
      if (cursor === undefined) {
        headReads += 1;
        if (headReads === 1) {
          return {
            items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
            nextCursor: 5
          };
        }
        if (headReads === 2) {
          return {
            items: [summary(7, "Inserted run seven", "queued"), summary(6, "Run six", "queued")],
            nextCursor: 6
          };
        }
        return {
          items: [
            {
              ...summary(7, "Updated run seven", "implementing", "implement"),
              lastGlobalSequence: 9
            },
            summary(8, "Inserted run eight", "queued")
          ],
          nextCursor: 8
        };
      }
      if (cursor === 5) {
        return {
          items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
          nextCursor: 3
        };
      }
      if (cursor === 6) {
        return {
          items: [summary(5, "Run five", "queued"), summary(4, "Run four", "queued")],
          nextCursor: 4
        };
      }
      if (cursor === 3) {
        return { items: [summary(2, "Run two", "completed"), summary(1, "Run one", "completed")] };
      }
      throw new Error(`Unexpected run cursor: ${String(cursor)}`);
    });
    render(<App client={client} pollIntervalMs={5_000} />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(client.listRuns).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("heading", { name: "Inserted run seven" })).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(client.listRuns).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("heading", { name: "Inserted run eight" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Updated run seven" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    expect(client.listRuns).toHaveBeenLastCalledWith(6, expect.any(AbortSignal));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Run four" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Updated run seven" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Inserted run seven" })).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("article")
        .map((article) => within(article).getByRole("heading").textContent)
    ).toEqual([
      "Updated run seven",
      "Inserted run eight",
      "Run six",
      "Run five",
      "Run four",
      "Run three"
    ]);
  });

  it("keeps health live when an unchanged head poll is discarded during traversal", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.mocked(client.health)
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce(health)
      .mockResolvedValue({ ...health, status: "degraded" });
    let headReads = 0;
    vi.mocked(client.listRuns).mockImplementation(async (cursor) => {
      if (cursor === undefined) {
        headReads += 1;
        return headReads === 1
          ? {
              items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
              nextCursor: 5
            }
          : {
              items: [summary(7, "Run seven", "queued"), summary(6, "Run six", "queued")],
              nextCursor: 6
            };
      }
      return {
        items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
        nextCursor: 3
      };
    });
    render(<App client={client} pollIntervalMs={5_000} />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText("Control plane degraded")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Run six" })).toBeVisible();
    expect(client.listRuns).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal));
  });

  it("marks health unavailable while still applying a successful head poll", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.mocked(client.health)
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce(health)
      .mockRejectedValueOnce(new Error("health offline"));
    vi.mocked(client.listRuns)
      .mockResolvedValueOnce({
        items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
        nextCursor: 5
      })
      .mockResolvedValueOnce({
        items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
        nextCursor: 3
      })
      .mockResolvedValueOnce({
        items: [summary(7, "Run seven", "queued"), summary(6, "Run six", "queued")],
        nextCursor: 6
      })
      .mockResolvedValueOnce({
        items: [summary(8, "Run eight", "queued"), summary(7, "Run seven", "queued")],
        nextCursor: 7
      })
      .mockResolvedValue({
        items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
        nextCursor: 3
      });
    render(<App client={client} pollIntervalMs={5_000} />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByRole("heading", { name: "Run eight" })).toBeVisible();
    expect(screen.getByText("Connecting to control plane")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Factory data is unavailable");
  });

  it("keeps successful health live when a head poll fails during traversal", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.mocked(client.health)
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce({ ...health, status: "degraded" });
    vi.mocked(client.listRuns)
      .mockResolvedValueOnce({
        items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
        nextCursor: 5
      })
      .mockResolvedValueOnce({
        items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
        nextCursor: 3
      })
      .mockResolvedValueOnce({
        items: [summary(7, "Run seven", "queued"), summary(6, "Run six", "queued")],
        nextCursor: 6
      })
      .mockRejectedValueOnce(new Error("run list offline"))
      .mockResolvedValue({
        items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
        nextCursor: 3
      });
    render(<App client={client} pollIntervalMs={5_000} />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText("Control plane degraded")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Run six" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Factory data is unavailable");
  });

  it("revalidates a completed traversal before labeling mutable results as total", async () => {
    let headReads = 0;
    const client = makeClient();
    vi.mocked(client.listRuns).mockImplementation(async (cursor) => {
      if (cursor === undefined) {
        headReads += 1;
        return headReads === 1
          ? {
              items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
              nextCursor: 5
            }
          : {
              items: [
                {
                  ...summary(3, "Reordered run three", "implementing", "implement"),
                  lastGlobalSequence: 7
                },
                summary(6, "Run six", "queued")
              ],
              nextCursor: 6
            };
      }
      if (cursor === 5) {
        return {
          items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
          nextCursor: 3
        };
      }
      if (cursor === 3) {
        return { items: [summary(2, "Run two", "completed"), summary(1, "Run one", "completed")] };
      }
      throw new Error(`Unexpected run cursor: ${String(cursor)}`);
    });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Run six" });
    for (const expectedCursor of [5, 3]) {
      fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
      expect(client.listRuns).toHaveBeenLastCalledWith(expectedCursor, expect.any(AbortSignal));
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(client.listRuns).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal));
    expect(screen.getByRole("heading", { name: "Reordered run three" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Run three" })).not.toBeInTheDocument();
    expect(screen.getByText("6 loaded")).toBeVisible();
    expect(screen.queryByText("6 total")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older runs" })).toBeEnabled();
  });

  it("restarts a completed traversal when a newer head-only poll resolves late", async () => {
    vi.useFakeTimers();
    let resolveTerminalPage!: (value: ListRunsResponse) => void;
    const pendingTerminalPage = new Promise<ListRunsResponse>((resolve) => {
      resolveTerminalPage = resolve;
    });
    let resolveObservedHead!: (value: ListRunsResponse) => void;
    const pendingObservedHead = new Promise<ListRunsResponse>((resolve) => {
      resolveObservedHead = resolve;
    });
    let headReads = 0;
    const client = makeClient();
    vi.mocked(client.listRuns).mockImplementation((cursor) => {
      if (cursor === undefined) {
        headReads += 1;
        if (headReads === 1) {
          return Promise.resolve({
            items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
            nextCursor: 5
          });
        }
        if (headReads === 2 || headReads === 4) {
          return Promise.resolve({
            items: [summary(7, "Run seven", "queued"), summary(6, "Run six", "queued")],
            nextCursor: 6
          });
        }
        return pendingObservedHead;
      }
      if (cursor === 5) {
        return Promise.resolve({
          items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
          nextCursor: 3
        });
      }
      if (cursor === 6) return pendingTerminalPage;
      throw new Error(`Unexpected run cursor: ${String(cursor)}`);
    });
    render(<App client={client} pollIntervalMs={5_000} />);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      resolveTerminalPage({
        items: [
          summary(5, "Run five", "queued"),
          summary(4, "Run four", "queued"),
          summary(3, "Run three", "queued"),
          summary(2, "Run two", "completed"),
          summary(1, "Run one", "completed")
        ]
      });
      await pendingTerminalPage;
      await Promise.resolve();
    });

    expect(screen.getByText("7 total")).toBeVisible();

    await act(async () => {
      resolveObservedHead({
        items: [summary(8, "Late run eight", "queued"), summary(7, "Run seven", "queued")],
        nextCursor: 7
      });
      await pendingObservedHead;
    });

    expect(screen.getByRole("heading", { name: "Late run eight" })).toBeVisible();
    expect(screen.getByText("8 loaded")).toBeVisible();
    expect(screen.queryByText("8 total")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load older runs" })).toBeEnabled();
  });

  it("ignores an older head-only poll that resolves after a newer validation", async () => {
    let resolveTerminalPage!: (value: ListRunsResponse) => void;
    const pendingTerminalPage = new Promise<ListRunsResponse>((resolve) => {
      resolveTerminalPage = resolve;
    });
    let resolveStaleHead!: (value: ListRunsResponse) => void;
    const pendingStaleHead = new Promise<ListRunsResponse>((resolve) => {
      resolveStaleHead = resolve;
    });
    let headReads = 0;
    const client = makeClient();
    vi.mocked(client.listRuns).mockImplementation((cursor) => {
      if (cursor === undefined) {
        headReads += 1;
        if (headReads === 1) {
          return Promise.resolve({
            items: [summary(6, "Run six", "queued"), summary(5, "Run five", "queued")],
            nextCursor: 5
          });
        }
        if (headReads === 2) {
          return Promise.resolve({
            items: [summary(7, "Run seven", "queued"), summary(6, "Run six", "queued")],
            nextCursor: 6
          });
        }
        if (headReads === 3) return pendingStaleHead;
        return Promise.resolve({
          items: [
            summary(8, "Validated run eight", "queued"),
            {
              ...summary(7, "Validated run seven", "implementing", "implement"),
              lastGlobalSequence: 7
            }
          ],
          nextCursor: 7
        });
      }
      if (cursor === 5) {
        return Promise.resolve({
          items: [summary(4, "Run four", "queued"), summary(3, "Run three", "queued")],
          nextCursor: 3
        });
      }
      if (cursor === 6) return pendingTerminalPage;
      throw new Error(`Unexpected run cursor: ${String(cursor)}`);
    });
    render(<App client={client} />);

    await screen.findByRole("heading", { name: "Run six" });
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    await screen.findByRole("heading", { name: "Run four" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("heading", { name: "Run seven" });

    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      resolveTerminalPage({
        items: [
          summary(5, "Run five", "queued"),
          summary(4, "Run four", "queued"),
          summary(3, "Run three", "queued"),
          summary(2, "Run two", "completed"),
          summary(1, "Run one", "completed")
        ]
      });
      await pendingTerminalPage;
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Validated run eight" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Validated run seven" })).toBeVisible();

    await act(async () => {
      resolveStaleHead({
        items: [summary(7, "Stale run seven", "queued"), summary(6, "Run six", "queued")],
        nextCursor: 6
      });
      await pendingStaleHead;
    });

    expect(screen.queryByRole("heading", { name: "Stale run seven" })).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("article")
        .slice(0, 2)
        .map((article) => within(article).getByRole("heading").textContent)
    ).toEqual(["Validated run eight", "Validated run seven"]);
    expect(screen.getByText("8 loaded")).toBeVisible();
  });

  it("allows only one pagination request and merges overlapping pages by run id", async () => {
    const newest = summary(2, "Newest run", "queued");
    let resolvePage!: (value: ListRunsResponse) => void;
    const pendingPage = new Promise<ListRunsResponse>((resolve) => {
      resolvePage = resolve;
    });
    const client = makeClient();
    vi.mocked(client.listRuns)
      .mockResolvedValueOnce({ items: [newest], nextCursor: 10 })
      .mockReturnValueOnce(pendingPage)
      .mockResolvedValueOnce({ items: [newest], nextCursor: 10 });
    render(<App client={client} />);

    const loadMore = await screen.findByRole("button", { name: "Load older runs" });
    fireEvent.click(loadMore);

    const loading = screen.getByRole("button", { name: "Loading older runs…" });
    expect(loading).toBeDisabled();
    fireEvent.click(loading);
    expect(client.listRuns).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvePage({
        items: [{ ...newest, title: "Stale duplicate" }, summary(1, "Older run", "completed")]
      });
      await pendingPage;
    });

    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Newest run" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Stale duplicate" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Older run" })).toBeVisible();
  });

  it("keeps loaded runs visible and reports a recoverable pagination failure", async () => {
    const client = makeClient();
    vi.mocked(client.listRuns)
      .mockResolvedValueOnce({ items: [summary(2, "Newest run", "queued")], nextCursor: 10 })
      .mockRejectedValueOnce(new Error("offline"));
    render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older runs" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Older runs could not be loaded. Try again."
    );
    expect(screen.getByRole("heading", { name: "Newest run" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Load older runs" })).toBeEnabled();
  });

  it("aborts stale pagination when the run list is refreshed", async () => {
    let paginationSignal: AbortSignal | undefined;
    let resolvePage!: (value: ListRunsResponse) => void;
    const pendingPage = new Promise<ListRunsResponse>((resolve) => {
      resolvePage = resolve;
    });
    const client = makeClient();
    vi.mocked(client.listRuns).mockImplementation((cursor, signal) => {
      if (cursor === 10) {
        paginationSignal = signal;
        return pendingPage;
      }
      return Promise.resolve({ items: [summary(2, "Current run", "queued")], nextCursor: 10 });
    });
    render(<App client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older runs" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(paginationSignal?.aborted).toBe(true));
    await act(async () => {
      resolvePage({ items: [summary(1, "Stale older run", "completed")] });
      await pendingPage;
    });
    expect(screen.queryByRole("heading", { name: "Stale older run" })).not.toBeInTheDocument();
  });

  it("aborts pagination when the API client changes and when the view unmounts", async () => {
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    const never = new Promise<ListRunsResponse>(() => undefined);
    const firstClient = makeClient();
    vi.mocked(firstClient.listRuns).mockImplementation((cursor, signal) => {
      if (cursor === 10) {
        firstSignal = signal;
        return never;
      }
      return Promise.resolve({ items: [summary(2, "First client run", "queued")], nextCursor: 10 });
    });
    const secondClient = makeClient();
    vi.mocked(secondClient.listRuns).mockImplementation((cursor, signal) => {
      if (cursor === 20) {
        secondSignal = signal;
        return never;
      }
      return Promise.resolve({
        items: [summary(3, "Second client run", "queued")],
        nextCursor: 20
      });
    });
    const view = render(<App client={firstClient} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older runs" }));
    view.rerender(<App client={secondClient} />);

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(await screen.findByRole("heading", { name: "Second client run" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
    view.unmount();
    expect(secondSignal?.aborted).toBe(true);
  });

  it("shows loading, empty, failure, and retry states", async () => {
    const client = makeClient();
    vi.mocked(client.listRuns)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ items: [] });
    render(<App client={client} />);

    expect(screen.getByRole("status", { name: "Loading factory state" })).toBeVisible();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Factory data is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No runs yet")).toBeVisible();
  });

  it("does not refresh while initially hidden and refreshes when visible", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const client = makeClient();
    render(<App client={client} />);

    await Promise.resolve();
    expect(client.health).not.toHaveBeenCalled();
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));

    expect(await screen.findByText("No runs yet")).toBeVisible();
    expect(client.health).toHaveBeenCalledTimes(1);
  });
});
