import { useId } from "react";
import type { ReactNode } from "react";

import type { PlanDocument } from "@autostack/contracts";

export interface PlanPaneProps {
  // `PlanDocument["requiredCredentialRefIds"]` is `CredentialRefId[]` — branded ID strings only.
  // There is no field on `PlanDocument` that carries a credential *value*, so a raw secret is
  // structurally unrenderable here: using the real contract type, not a widened one, is what makes
  // this true. See `requiredCredentialRefIds` below — it renders IDs, because IDs are all it has.
  readonly plan: PlanDocument | undefined;
}

interface PlanSectionProps {
  readonly headingId: string;
  readonly title: string;
  readonly children: ReactNode;
}

/**
 * A visible `<h3>` wired by `aria-labelledby` (Task 4a ruling 3), not an invisible `aria-label` —
 * an operator reviewing a plan approval needs to see every section name.
 */
function PlanSection({ headingId, title, children }: PlanSectionProps) {
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {children}
    </section>
  );
}

/**
 * Renders a station plan document (spec §8.2, §14.4) for approval review. Pure presentational: an
 * absent plan (the plan station has not produced one yet) renders a named state, never invented
 * data. A `usesShell: true` verification command renders a visible, labelled marker — spec §14.4
 * requires shell interpretation to be visible at plan approval — and only when it is actually true.
 */
export function PlanPane({ plan }: PlanPaneProps) {
  const baseId = useId();

  if (plan === undefined) {
    return <p className="plan-pane__empty">No plan recorded yet.</p>;
  }

  return (
    <div className="plan-pane">
      <p className="plan-pane__summary">{plan.summary}</p>

      <PlanSection headingId={`${baseId}-criteria`} title="Acceptance criteria">
        <ol className="plan-pane__acceptance-criteria">
          {plan.acceptanceCriteria.map((criterion, index) => (
            <li key={index}>{criterion}</li>
          ))}
        </ol>
      </PlanSection>

      <PlanSection headingId={`${baseId}-areas`} title="Affected areas">
        <ul className="plan-pane__affected-areas">
          {plan.affectedAreas.map((area, index) => (
            <li key={index}>{area}</li>
          ))}
        </ul>
      </PlanSection>

      <PlanSection headingId={`${baseId}-risks`} title="Risks">
        <ul className="plan-pane__risks">
          {plan.risks.map((risk, index) => (
            <li key={index} data-severity={risk.severity}>
              {risk.severity}: {risk.summary}
            </li>
          ))}
        </ul>
      </PlanSection>

      <PlanSection headingId={`${baseId}-commands`} title="Verification commands">
        <ul className="plan-pane__verification-commands">
          {plan.verificationCommands.map((command, index) => (
            <li key={index}>
              <code>{[command.executable, ...command.args].join(" ")}</code>
              {command.required ? <span> (required)</span> : null}
              {command.usesShell ? (
                <span className="plan-pane__shell-marker"> Runs via shell</span>
              ) : null}
            </li>
          ))}
        </ul>
      </PlanSection>

      <PlanSection headingId={`${baseId}-permissions`} title="Required permissions">
        <ul className="plan-pane__permissions">
          {plan.requiredPermissions.map((permission, index) => (
            <li key={index}>
              {permission.kind}: {permission.detail}
            </li>
          ))}
        </ul>
      </PlanSection>

      <PlanSection headingId={`${baseId}-credentials`} title="Required credentials">
        <ul className="plan-pane__credential-refs">
          {plan.requiredCredentialRefIds.map((refId) => (
            <li key={refId}>{refId}</li>
          ))}
        </ul>
      </PlanSection>
    </div>
  );
}
