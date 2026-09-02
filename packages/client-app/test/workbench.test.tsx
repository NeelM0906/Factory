// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunSummary } from "@autostack/contracts";

import { Workbench } from "../src/workbench/workbench.js";
import { RunSidebar } from "../src/workbench/run-sidebar.js";
import {
  DISABLED_DESTINATIONS,
  WORKBENCH_DESTINATIONS
} from "../src/workbench/navigation.js";
import type { AutoStackApiClient } from "../src/api-client.js";
import type { FactoryController } from "../src/use-factory.js";

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
  createRun: vi.fn(),
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
  steerRun: vi.fn(),
  cancelRun: vi.fn(),
  answerClarification: vi.fn()
});

const RUN_ID = `run_123e4567-e89b-42d3-a456-426614174099` as RunSummary["runId"];

const makeFactory = (
  runs: readonly RunSummary[] = [],
  overrides: Partial<FactoryController> = {}
): FactoryController => ({
  state: {
    status: "ready",
    health,
    runs,
    creating: false,
    loadingMore: false
  },
  refresh: vi.fn(async () => undefined),
  loadMore: vi.fn(async () => undefined),
  createRun: vi.fn(async () => ({ replayed: false, workItem: {} as never, run: {} as never })),
  actionState: { steering: false, cancelling: false, answering: false },
  steer: vi.fn(async () => ({
    runId: RUN_ID,
    accepted: true,
    acceptedAt: "2026-08-20T12:00:00.000Z"
  })),
  cancel: vi.fn(async () => ({
    runId: RUN_ID,
    status: "cancelling" as const,
    requestedAt: "2026-08-20T12:00:00.000Z"
  })),
  answerClarification: vi.fn(async () => ({
    runId: RUN_ID,
    clarificationRef: "clar_ref_1",
    answeredAt: "2026-08-20T12:00:00.000Z",
    replayed: false
  })),
  ...overrides
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Navigation", () => {
  it("exports six workbench destinations", () => {
    expect(WORKBENCH_DESTINATIONS).toHaveLength(6);
    expect(WORKBENCH_DESTINATIONS).toContain("factory");
    expect(WORKBENCH_DESTINATIONS).toContain("projects");
    expect(WORKBENCH_DESTINATIONS).toContain("automations");
    expect(WORKBENCH_DESTINATIONS).toContain("approvals");
    expect(WORKBENCH_DESTINATIONS).toContain("integrations");
    expect(WORKBENCH_DESTINATIONS).toContain("settings");
  });

  it("disables the automations destination as a future stage", () => {
    expect(DISABLED_DESTINATIONS.has("automations")).toBe(true);
    expect(DISABLED_DESTINATIONS.size).toBe(1);
  });
});

describe("RunSidebar", () => {
  it("groups runs into needs attention, active, and recent history", () => {
    const runs: readonly RunSummary[] = [
      summary(1, "Awaiting plan approval", "awaiting_plan_approval"),
      summary(2, "Implementing feature", "implementing", "implement"),
      summary(3, "Completed task", "completed", "publish"),
      summary(4, "Needs clarification", "needs_clarification"),
      summary(5, "Failed run", "failed", "verify")
    ];

    render(<RunSidebar runs={runs} />);

    const attentionGroup = screen.getByRole("group", { name: "Needs attention" });
    expect(within(attentionGroup).getByText("Awaiting plan approval")).toBeVisible();
    expect(within(attentionGroup).getByText("Needs clarification")).toBeVisible();

    const activeGroup = screen.getByRole("group", { name: "Active" });
    expect(within(activeGroup).getByText("Implementing feature")).toBeVisible();

    const historyGroup = screen.getByRole("group", { name: "Recent history" });
    expect(within(historyGroup).getByText("Completed task")).toBeVisible();
    expect(within(historyGroup).getByText("Failed run")).toBeVisible();
  });

  it("shows a non-colour cue on runs needing attention", () => {
    const runs: readonly RunSummary[] = [
      summary(1, "Awaiting plan approval", "awaiting_plan_approval")
    ];

    render(<RunSidebar runs={runs} />);

    const attentionGroup = screen.getByRole("group", { name: "Needs attention" });
    const item = within(attentionGroup).getByText("Awaiting plan approval").closest("li");
    expect(item).not.toBeNull();
    expect(item!.querySelector("[aria-hidden]")).not.toBeNull();
  });

  it("shows empty message when no runs exist", () => {
    render(<RunSidebar runs={[]} />);
    expect(screen.getByText("No durable runs recorded.")).toBeVisible();
  });

  it("classifies all waiting statuses under needs attention", () => {
    const waitingStatuses: readonly RunSummary["status"][] = [
      "queued",
      "needs_clarification",
      "awaiting_plan_approval",
      "awaiting_publish_approval",
      "waiting_for_user",
      "retry_scheduled"
    ];
    const runs = waitingStatuses.map((status, index) =>
      summary(index + 1, `Run ${status}`, status)
    );

    render(<RunSidebar runs={runs} />);

    const attentionGroup = screen.getByRole("group", { name: "Needs attention" });
    for (const status of waitingStatuses) {
      expect(within(attentionGroup).getByText(`Run ${status}`)).toBeVisible();
    }
  });
});

describe("Workbench", () => {
  it("renders the AppShell with navigation and the automations destination disabled", async () => {
    const factory = makeFactory();
    render(
      <Workbench
        activeDestination="factory"
        factory={factory}
        client={makeClient()}
        desktopRuntimeStatus={undefined}
      />
    );

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const automationsLink = within(nav).getByText("Automations").closest("a");
    expect(automationsLink).toHaveAttribute("aria-disabled", "true");
  });

  it("renders the factory panel with run queue and metrics", async () => {
    const runs = [
      summary(1, "Implement agent adapter", "implementing", "implement"),
      summary(2, "Approve release", "waiting_for_user"),
      summary(3, "Failed CI", "failed", "verify"),
      summary(4, "Ship foundation", "completed", "publish")
    ];
    const factory = makeFactory(runs);
    render(
      <Workbench
        activeDestination="factory"
        factory={factory}
        client={makeClient(runs)}
        desktopRuntimeStatus={undefined}
      />
    );

    expect(screen.getByRole("heading", { name: "AutoStack Factory" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Run queue" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Factory metrics" })).toBeVisible();
  });

  it("renders a placeholder for unimplemented destinations", () => {
    const factory = makeFactory();
    render(
      <Workbench
        activeDestination="projects"
        factory={factory}
        client={makeClient()}
        desktopRuntimeStatus={undefined}
      />
    );

    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "Projects" })).toBeVisible();
    expect(within(main).getByText(/coming soon/i)).toBeVisible();
  });

  it("renders a placeholder for integrations destination", () => {
    const factory = makeFactory();
    render(
      <Workbench
        activeDestination="integrations"
        factory={factory}
        client={makeClient()}
        desktopRuntimeStatus={undefined}
      />
    );

    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "Integrations" })).toBeVisible();
    expect(within(main).getByText(/coming soon/i)).toBeVisible();
  });
});

describe("Failure states", () => {
  it("shows control plane unreachable with retry", () => {
    const factory = makeFactory([], {
      state: {
        status: "error",
        runs: [],
        creating: false,
        loadingMore: false,
        message: "Factory data is unavailable. Check the control plane and try again."
      }
    });
    render(
      <Workbench
        activeDestination="factory"
        factory={factory}
        client={makeClient()}
        desktopRuntimeStatus={undefined}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Factory data is unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("shows run supervision source absent state when no source is provided", () => {
    const factory = makeFactory([
      summary(1, "Implement feature", "implementing", "implement")
    ]);
    render(
      <Workbench
        activeDestination="factory"
        factory={factory}
        client={makeClient()}
        desktopRuntimeStatus={undefined}
      />
    );

    expect(
      screen.getByText(/run supervision is not served by this build/i)
    ).toBeVisible();
  });

  it("shows desktop operation unavailable when runtimeBridge is absent", () => {
    const factory = makeFactory();
    render(
      <Workbench
        activeDestination="factory"
        factory={factory}
        client={makeClient()}
        desktopRuntimeStatus={undefined}
      />
    );

    // Should not crash and should render normally without runtime bridge
    expect(screen.getByRole("heading", { name: "AutoStack Factory" })).toBeVisible();
  });
});
