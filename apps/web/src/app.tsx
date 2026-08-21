import { useMemo, useState, type FormEvent } from "react";

import type { CreateRunRequest, RunSummary } from "@autostack/contracts";
import {
  AppShell,
  LifecycleStrip,
  MetricCard,
  RunStatusBadge,
  type LifecycleStageView
} from "@autostack/ui";

import { createApiClient, type AutoStackApiClient } from "./api-client.js";
import { useFactory } from "./use-factory.js";

const TOKEN_KEY = "autostack.local-api-token";

const ACTIVE_STATUSES = new Set([
  "triaging",
  "planning",
  "provisioning",
  "implementing",
  "verifying",
  "reviewing",
  "publishing",
  "cancelling"
]);
const WAITING_STATUSES = new Set([
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

interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AppProps {
  readonly client?: AutoStackApiClient;
  readonly storage?: SessionStorage;
  readonly clientFactory?: (getToken: () => string | null) => AutoStackApiClient;
  readonly pollIntervalMs?: number;
}

const defaultClientFactory = (getToken: () => string | null): AutoStackApiClient =>
  createApiClient({ baseUrl: "", getToken });

const lifecycleView = (runs: readonly RunSummary[]): readonly LifecycleStageView[] => {
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
    ...(index === activeIndex ? { detail: `${runs.length} total` } : {})
  }));
};

const runNavigation = (runs: readonly RunSummary[]) => (
  <div className="factory-sidebar">
    <p className="eyebrow">Local workspace</p>
    <h2>Run history</h2>
    {runs.length === 0 ? (
      <p className="muted">No durable runs recorded.</p>
    ) : (
      <ul className="sidebar-runs">
        {runs.map((run) => (
          <li key={run.runId}>
            <a href={`#run-${run.runId}`}>{run.title}</a>
          </li>
        ))}
      </ul>
    )}
  </div>
);

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

export function App({
  client,
  storage = window.sessionStorage,
  clientFactory = defaultClientFactory,
  pollIntervalMs = 5_000
}: AppProps) {
  const [token, setToken] = useState<string | null>(() => storage.getItem(TOKEN_KEY));
  const [tokenInput, setTokenInput] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const internalClient = useMemo(
    () => (token === null ? null : clientFactory(() => token)),
    [clientFactory, token]
  );
  const activeClient = client ?? internalClient;
  const factory = useFactory(activeClient, pollIntervalMs);

  const connect = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (tokenInput.length === 0) return;
    storage.setItem(TOKEN_KEY, tokenInput);
    setToken(tokenInput);
    setTokenInput("");
  };

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

  if (activeClient === null) {
    return (
      <AppShell activeDestination="factory" sidebar={runNavigation([])}>
        <section className="connection-panel" aria-labelledby="connection-title">
          <p className="eyebrow">Personal · local first</p>
          <h1 id="connection-title">Connect this AutoStack session</h1>
          <p>
            Enter the local control-plane token. It remains in this browser session and is cleared
            when the session closes.
          </p>
          <form onSubmit={connect}>
            <label htmlFor="local-token">Local API token</label>
            <input
              id="local-token"
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              required
            />
            <button type="submit">Connect</button>
          </form>
        </section>
      </AppShell>
    );
  }

  const runs = factory.state.runs;
  const active = runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length;
  const waiting = runs.filter((run) => WAITING_STATUSES.has(run.status)).length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const completed = runs.filter((run) => run.status === "completed").length;

  return (
    <AppShell
      activeDestination="factory"
      sidebar={runNavigation(runs)}
      inspector={runInspector(runs[0])}
    >
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

      <LifecycleStrip stages={lifecycleView(runs)} />

      <section className="factory-metrics" aria-label="Factory metrics">
        <MetricCard label="Active runs" value={String(active)} detail="In flight" tone="neutral" />
        <MetricCard
          label="Waiting runs"
          value={String(waiting)}
          detail="Needs input"
          tone={waiting > 0 ? "attention" : "neutral"}
        />
        <MetricCard
          label="Failed runs"
          value={String(failed)}
          detail="Needs attention"
          tone={failed > 0 ? "attention" : "neutral"}
        />
        <MetricCard
          label="Completed runs"
          value={String(completed)}
          detail="Delivered"
          tone={completed > 0 ? "good" : "neutral"}
        />
      </section>

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
    </AppShell>
  );
}
