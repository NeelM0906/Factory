import type { ReactElement } from "react";

import type { RunSummary } from "@autostack/contracts";

export interface RunSidebarProps {
  readonly runs: readonly RunSummary[];
}

const WAITING_STATUSES: ReadonlySet<RunSummary["status"]> = new Set([
  "queued",
  "needs_clarification",
  "awaiting_plan_approval",
  "awaiting_publish_approval",
  "waiting_for_user",
  "retry_scheduled"
]);

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

interface RunGroup {
  readonly label: string;
  readonly runs: readonly RunSummary[];
}

const groupRuns = (runs: readonly RunSummary[]): readonly RunGroup[] => {
  const attention: RunSummary[] = [];
  const active: RunSummary[] = [];
  const history: RunSummary[] = [];

  for (const run of runs) {
    if (WAITING_STATUSES.has(run.status)) {
      attention.push(run);
    } else if (ACTIVE_STATUSES.has(run.status)) {
      active.push(run);
    } else {
      history.push(run);
    }
  }

  return [
    { label: "Needs attention", runs: attention },
    { label: "Active", runs: active },
    { label: "Recent history", runs: history }
  ];
};

export function RunSidebar({ runs }: RunSidebarProps): ReactElement {
  if (runs.length === 0) {
    return (
      <div className="factory-sidebar">
        <p className="eyebrow">Local workspace</p>
        <h2>Run history</h2>
        <p className="muted">No durable runs recorded.</p>
      </div>
    );
  }

  const groups = groupRuns(runs);

  return (
    <div className="factory-sidebar">
      <p className="eyebrow">Local workspace</p>
      <h2>Run history</h2>
      {groups.map((group) =>
        group.runs.length === 0 ? null : (
          <fieldset key={group.label} className="sidebar-group" role="group" aria-label={group.label}>
            <legend className="sidebar-group-legend">{group.label}</legend>
            <ul className="sidebar-runs">
              {group.runs.map((run) => (
                <li key={run.runId}>
                  {group.label === "Needs attention" ? (
                    <span className="attention-cue" aria-hidden="true">
                      ●
                    </span>
                  ) : null}
                  <a href={`#run-${run.runId}`}>{run.title}</a>
                </li>
              ))}
            </ul>
          </fieldset>
        )
      )}
    </div>
  );
}
