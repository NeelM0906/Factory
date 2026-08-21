export type LifecycleStageState = "complete" | "active" | "waiting" | "failed";

export interface LifecycleStageView {
  readonly id: string;
  readonly label: string;
  readonly state: LifecycleStageState;
  readonly detail?: string;
}

export interface LifecycleStripProps {
  readonly stages: readonly LifecycleStageView[];
}

export function LifecycleStrip({ stages }: LifecycleStripProps) {
  return (
    <ol className="as-lifecycle" aria-label="Software delivery lifecycle">
      {stages.map((stage, index) => (
        <li className="as-lifecycle__stage" data-state={stage.state} key={stage.id}>
          <span className="as-lifecycle__sequence" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="as-lifecycle__copy">
            <span className="as-lifecycle__label">{stage.label}</span>
            {stage.detail === undefined ? null : (
              <span className="as-lifecycle__detail">{stage.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
