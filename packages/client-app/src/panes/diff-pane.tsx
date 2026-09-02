import type { AgentSessionStreamEvent } from "@autostack/contracts";

export interface DiffPaneProps {
  readonly events: readonly AgentSessionStreamEvent[];
}

interface PathDiffSummary {
  readonly path: string;
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
}

/**
 * Aggregates `file_change` events by path, counting each `change` kind. Every other event type in
 * the union is ignored — this pane renders only file-change evidence, never a generic fallback for
 * the rest. Grouping order is lexicographic by path (`localeCompare`), so the same input set renders
 * identically regardless of event arrival order — a stated ordering rule, not Map insertion
 * happenstance.
 */
function summarizeFileChanges(
  events: readonly AgentSessionStreamEvent[]
): readonly PathDiffSummary[] {
  const counts = new Map<string, PathDiffSummary>();

  for (const event of events) {
    if (event.type !== "file_change") continue;
    const existing = counts.get(event.path) ?? {
      path: event.path,
      added: 0,
      modified: 0,
      deleted: 0
    };
    counts.set(event.path, { ...existing, [event.change]: existing[event.change] + 1 });
  }

  return [...counts.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Renders `file_change` events (spec §9.1) grouped by path with per-kind added/modified/deleted
 * counts. Pure presentational: a path is untrusted repository content — it comes from an agent
 * session, not this application — and is rendered exclusively as a React text child, never via
 * `dangerouslySetInnerHTML` or any other markup-producing path, so a path containing HTML-like text
 * can never create an element.
 */
export function DiffPane({ events }: DiffPaneProps) {
  const summaries = summarizeFileChanges(events);

  if (summaries.length === 0) {
    return <p className="diff-pane__empty">No file changes recorded yet.</p>;
  }

  return (
    <ul className="diff-pane" aria-label="File changes">
      {summaries.map((summary) => (
        <li className="diff-pane__path" key={summary.path}>
          <p className="diff-pane__path-text">{summary.path}</p>
          <p className="diff-pane__counts">
            {summary.added} added · {summary.modified} modified · {summary.deleted} deleted
          </p>
        </li>
      ))}
    </ul>
  );
}
