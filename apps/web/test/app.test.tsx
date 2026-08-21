// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunSummary } from "@autostack/contracts";

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
  createRun: vi.fn()
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("AutoStack factory console", () => {
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
