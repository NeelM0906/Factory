import type { VerificationReport } from "@autostack/contracts";

export interface VerificationPaneProps {
  readonly report: VerificationReport | undefined;
}

/**
 * Renders a station verification report (spec §8.2, §14.4): every check's exact command, status,
 * exit code, and duration are retained and shown, never summarized away. A `usesShell: true` command
 * renders the same visible, labelled marker convention `PlanPane` uses for the same field. Exit code
 * is compared `=== undefined`, never falsy-checked — a passed check's exit code `0` is a real,
 * meaningful value, and a `value || fallback` implementation would wrongly show it as absent.
 *
 * The pane trusts a `VerificationReport` it is handed to already satisfy the contract's invariants
 * (`VerificationReportSchema`'s `superRefine` — e.g. "a passed report cannot contain a skipped
 * required check") rather than re-checking them: an object that violates those invariants cannot be
 * constructed as a `VerificationReport` in the first place, so there is nothing for this component to
 * re-validate.
 */
export function VerificationPane({ report }: VerificationPaneProps) {
  if (report === undefined) {
    return <p className="verification-pane__empty">No verification report recorded yet.</p>;
  }

  return (
    <ol className="verification-pane" aria-label="Verification checks">
      {report.results.map((result, index) => (
        <li className="verification-pane__check" data-status={result.status} key={index}>
          <code className="verification-pane__command">
            {[result.command.executable, ...result.command.args].join(" ")}
          </code>
          {result.command.usesShell ? (
            <span className="verification-pane__shell-marker"> Runs via shell</span>
          ) : null}
          <p className="verification-pane__status">Status: {result.status}</p>
          <p className="verification-pane__exit-code">
            Exit code: {result.exitCode === undefined ? "Not applicable" : result.exitCode}
          </p>
          <p className="verification-pane__duration">Duration: {result.durationMs}ms</p>
        </li>
      ))}
    </ol>
  );
}
