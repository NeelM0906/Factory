import { useState, type FormEvent, type ReactElement } from "react";

import type { CreateRunRequest, DesktopRuntimeStatus, RunSummary } from "@autostack/contracts";
import {
  AppShell,
  LifecycleStrip,
  MetricCard,
  RunStatusBadge,
  ThemeControl,
  type LifecycleStageView,
  type NavigationDestination
} from "@autostack/ui";

import type { AutoStackApiClient } from "../api-client.js";
import type { FactoryController } from "../use-factory.js";
import { RunSidebar } from "./run-sidebar.js";
import { DISABLED_DESCRIPTIONS, DISABLED_DESTINATIONS } from "./navigation.js";

const ACTIVE_STATUSES: ReadonlySet<RunSummary["status"]> = new Set([
  "triaging",
  "planning",
  "provisioning",
  "implementing",
  "verifying",
  "reviewing",
  "publishing",
  "cancelling"
]);

const WAITING_STATUSES: ReadonlySet<RunSummary["status"]> = new Set([
  "queued",
  "needs_clarification",
  "awaiting_plan_approval",
  "awaiting_publish_approval",
  "waiting_for_user",
  "retry_scheduled"
]);

const LIFECYCLE = [
  { id: "signal", label: "Signal" },
  { id: "triage", label: "Triage" },
  { id: "plan", label: "Plan" },
  { id: "implement", label: "Implement" },
  { id: "validate", label: "Validate" },
  { id: "release", label: "Release" },
  { id: "document", label: "Document" },
  { id: "monitor", label: "Monitor" }
] as const;

const STAGE_LANE: Readonly<Record<NonNullable<RunSummary["currentStage"]>, string>> = {
  triage: "triage",
  plan: "plan",
  implement: "implement",
  verify: "validate",
  review: "validate",
  publish: "release"
};

export interface WorkbenchProps {
  readonly activeDestination: NavigationDestination;
  readonly factory: FactoryController;
  readonly client: AutoStackApiClient;
  readonly executionAuthorityDisclosure?: boolean;
  readonly desktopRuntimeStatus?: DesktopRuntimeStatus | undefined;
}

const lifecycleView = (
  runs: readonly RunSummary[],
  hasMoreRuns: boolean
): readonly LifecycleStageView[] => {
  const firstActive = runs.find(
    (run) => ACTIVE_STATUSES.has(run.status) && run.currentStage !== undefined
  );
  const activeLane =
    firstActive?.currentStage === undefined
      ? runs.length === 0
        ? "signal"
        : "triage"
      : STAGE_LANE[firstActive.currentStage];
  const activeIndex = LIFECYCLE.findIndex((lane) => lane.id === activeLane);

  return LIFECYCLE.map((lane, index) => ({
    ...lane,
    state: index < activeIndex ? "complete" : index === activeIndex ? "active" : "waiting",
    ...(index === activeIndex
      ? { detail: `${runs.length} ${hasMoreRuns ? "loaded" : "total"}` }
      : {})
  }));
};

const runtimeStatusLabel = (status: DesktopRuntimeStatus): string => {
  if (status.status === "ready") return "Desktop runtime ready.";
  if (status.status === "starting") return "Desktop runtime starting.";
  if (status.status === "stopped") return "Desktop runtime stopped.";
  const prefix =
    status.message === "Local runtime is restarting."
      ? "Desktop runtime recovering."
      : "Desktop runtime degraded.";
  return status.message === undefined ? prefix : `${prefix} ${status.message}`;
};

const runInspector = (run: RunSummary | undefined) => (
  <div className="factory-inspector">
    <p className="eyebrow">Inspector</p>
    {run === undefined ? (
      <p className="muted">Select a run to inspect its event stream.</p>
    ) : (
      <dl>
        <dt>Source</dt>
        <dd>{run.source}</dd>
        <dt>Sequence</dt>
        <dd>{run.lastGlobalSequence}</dd>
        <dt>Updated</dt>
        <dd>{new Date(run.updatedAt).toLocaleString()}</dd>
      </dl>
    )}
  </div>
);

function PlaceholderPanel({
  destination
}: {
  readonly destination: NavigationDestination;
}): ReactElement {
  const labels: Record<NavigationDestination, string> = {
    factory: "Factory",
    projects: "Projects",
    automations: "Automations",
    approvals: "Approvals",
    integrations: "Integrations",
    settings: "Settings"
  };
  return (
    <section className="placeholder-panel">
      <h2>{labels[destination]}</h2>
      <p className="muted">This destination is coming soon.</p>
    </section>
  );
}

function SettingsPanel(): ReactElement {
  return (
    <section className="settings-panel">
      <h2>Settings</h2>
      <ThemeControl />
    </section>
  );
}

function FactoryPanel({
  factory,
  executionAuthorityDisclosure = false,
  desktopRuntimeStatus
}: {
  readonly factory: FactoryController;
  readonly executionAuthorityDisclosure?: boolean;
  readonly desktopRuntimeStatus?: DesktopRuntimeStatus | undefined;
}): ReactElement {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const runs = factory.state.runs;
  const active = runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length;
  const waiting = runs.filter((run) => WAITING_STATUSES.has(run.status)).length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const completed = runs.filter((run) => run.status === "completed").length;
  const partialMetrics = factory.state.nextCursor !== undefined;

  const submitRun = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const input: CreateRunRequest = { title, description, acceptanceContext: [] };
    void factory
      .createRun(input)
      .then(() => {
        setTitle("");
        setDescription("");
      })
      .catch(() => undefined);
  };

  return (
    <>
      <header className="factory-header">
        <div>
          <p className="eyebrow">Personal factory · live operations</p>
          <h1>AutoStack Factory</h1>
        </div>
        <span className="health-indicator" data-status={factory.state.health?.status ?? "unknown"}>
          <span aria-hidden="true" />
          {factory.state.health?.status === "ok"
            ? "Control plane healthy"
            : factory.state.health?.status === "degraded"
              ? "Control plane degraded"
              : "Connecting to control plane"}
        </span>
      </header>

      <LifecycleStrip stages={lifecycleView(runs, factory.state.nextCursor !== undefined)} />

      {desktopRuntimeStatus === undefined ? null : (
        <div
          className="desktop-runtime-status"
          data-status={desktopRuntimeStatus.status}
          role={desktopRuntimeStatus.status === "degraded" ? "alert" : "status"}
          aria-label={runtimeStatusLabel(desktopRuntimeStatus)}
          aria-live="polite"
        >
          <span aria-hidden="true" />
          {runtimeStatusLabel(desktopRuntimeStatus)}
        </div>
      )}

      {executionAuthorityDisclosure ? (
        <div className="execution-authority-warning" role="alert">
          Local commands run with your desktop user's host filesystem and network authority.
          AutoStack path checks protect AutoStack operations; they are not an operating-system
          sandbox.
        </div>
      ) : null}

      <section className="factory-metrics" aria-label="Factory metrics">
        <MetricCard
          label={partialMetrics ? "Loaded active runs" : "Active runs"}
          value={String(active)}
          detail="In flight"
          tone="neutral"
        />
        <MetricCard
          label={partialMetrics ? "Loaded waiting runs" : "Waiting runs"}
          value={String(waiting)}
          detail="Needs input"
          tone={waiting > 0 ? "attention" : "neutral"}
        />
        <MetricCard
          label={partialMetrics ? "Loaded failed runs" : "Failed runs"}
          value={String(failed)}
          detail="Needs attention"
          tone={failed > 0 ? "attention" : "neutral"}
        />
        <MetricCard
          label={partialMetrics ? "Loaded completed runs" : "Completed runs"}
          value={String(completed)}
          detail="Delivered"
          tone={completed > 0 ? "good" : "neutral"}
        />
      </section>

      <p className="muted supervision-notice">
        Run supervision is not served by this build. Detailed session events, plan documents, and
        verification reports require the supervision source.
      </p>

      <div className="factory-grid">
        <section className="run-queue" aria-label="Run queue">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Durable queue</p>
              <h2>Factory runs</h2>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void factory.refresh()}
            >
              Refresh
            </button>
          </div>

          {factory.state.status === "loading" ? (
            <p role="status" aria-label="Loading factory state">
              Loading factory state…
            </p>
          ) : factory.state.status === "error" ? (
            <div className="error-state" role="alert">
              <p>{factory.state.message}</p>
              <button type="button" onClick={() => void factory.refresh()}>
                Retry
              </button>
            </div>
          ) : runs.length === 0 ? (
            <div className="empty-state">
              <strong>No runs yet</strong>
              <p>Start a manual run to create the first durable factory record.</p>
            </div>
          ) : (
            <>
              <div className="run-list">
                {runs.map((run) => (
                  <article id={`run-${run.runId}`} className="run-row" key={run.runId}>
                    <div>
                      <h3>{run.title}</h3>
                      <p className="run-meta">
                        <span>{run.source}</span>
                        <span>Last update {new Date(run.updatedAt).toLocaleString()}</span>
                      </p>
                    </div>
                    <RunStatusBadge status={run.status} />
                  </article>
                ))}
              </div>
              {factory.state.paginationMessage === undefined ? null : (
                <p className="error-state" role="alert">
                  {factory.state.paginationMessage}
                </p>
              )}
              {factory.state.nextCursor === undefined ? null : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={factory.state.loadingMore}
                  onClick={() => void factory.loadMore()}
                >
                  {factory.state.loadingMore ? "Loading older runs…" : "Load older runs"}
                </button>
              )}
            </>
          )}
        </section>

        <section className="manual-run" aria-labelledby="manual-run-title">
          <p className="eyebrow">New signal</p>
          <h2 id="manual-run-title">Start a run</h2>
          <form onSubmit={submitRun}>
            <label htmlFor="run-title">Run title</label>
            <input
              id="run-title"
              value={title}
              maxLength={240}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
            <label htmlFor="run-description">Description</label>
            <textarea
              id="run-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={6}
            />
            <button type="submit" disabled={factory.state.creating}>
              {factory.state.creating ? "Starting…" : "Start run"}
            </button>
          </form>
        </section>
      </div>
    </>
  );
}

export function Workbench({
  activeDestination,
  factory,
  executionAuthorityDisclosure = false,
  desktopRuntimeStatus
}: WorkbenchProps): ReactElement {
  const runs = factory.state.runs;
  const sidebar = <RunSidebar runs={runs} />;

  const panel =
    activeDestination === "factory" ? (
      <FactoryPanel
        factory={factory}
        executionAuthorityDisclosure={executionAuthorityDisclosure}
        {...(desktopRuntimeStatus !== undefined ? { desktopRuntimeStatus } : {})}
      />
    ) : activeDestination === "settings" ? (
      <SettingsPanel />
    ) : (
      <PlaceholderPanel destination={activeDestination} />
    );

  return (
    <AppShell
      activeDestination={activeDestination}
      sidebar={sidebar}
      inspector={activeDestination === "factory" ? runInspector(runs[0]) : undefined}
      disabledDestinations={DISABLED_DESTINATIONS}
      disabledDescriptions={DISABLED_DESCRIPTIONS}
    >
      {panel}
    </AppShell>
  );
}
