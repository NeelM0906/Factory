import type { ReviewReport } from "@autostack/contracts";

export interface FindingsPaneProps {
  readonly report: ReviewReport | undefined;
}

/**
 * Renders a station review report (spec §8.2). Findings render labelled by severity (`data-severity`
 * plus a visible severity prefix) in the report's own order — the same "array order is the intended
 * order" convention `PlanPane` uses for its own severity-carrying list, `risks` (Task 5a): a review
 * report's `findings` array is already an authored, ordered list, not a raw event stream needing an
 * invented ordering rule the way `DiffPane`'s aggregated groups do, so there is nothing to resequence.
 *
 * A `location` renders only when present (`=== undefined`, never a fabricated placeholder for an
 * absent one). The verdict renders as visible text plus a `data-verdict` attribute — never
 * color-only — so `changes_requested` is legible without relying on color perception, and prominently
 * (its own top-level paragraph, always first) regardless of whether any finding is critical.
 *
 * An absent report ("the review station has not produced one yet") and a present report with zero
 * findings ("a clean review") are two different states and must not render alike: the contract
 * distinguishes "no evidence recorded" from "evidence of a clean pass," and collapsing both into one
 * empty-looking view would erase that distinction for an operator relying on it.
 */
export function FindingsPane({ report }: FindingsPaneProps) {
  if (report === undefined) {
    return (
      <p className="findings-pane__empty" data-findings-state="no-report">
        No review report recorded yet.
      </p>
    );
  }

  return (
    <div className="findings-pane">
      <p className="findings-pane__verdict" data-verdict={report.verdict}>
        Verdict: {report.verdict === "approved" ? "Approved" : "Changes requested"}
      </p>

      {report.findings.length === 0 ? (
        <p className="findings-pane__no-findings" data-findings-state="clean">
          No findings recorded.
        </p>
      ) : (
        <ul className="findings-pane__findings" aria-label="Findings">
          {report.findings.map((finding) => (
            <li
              className="findings-pane__finding"
              data-severity={finding.severity}
              key={finding.findingRef}
            >
              <p className="findings-pane__finding-summary">
                {finding.severity}: {finding.summary}
              </p>
              {finding.location === undefined ? null : (
                <p className="findings-pane__finding-location">
                  {finding.location.path}:{finding.location.startLine}-{finding.location.endLine}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
