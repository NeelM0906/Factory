import { useState, type ReactElement } from "react";

import { Composer, type ComposerMode } from "@autostack/ui";

import type { CancelRunResponse, SteerRunResponse } from "@autostack/contracts";

import type { FactoryActionState } from "../use-factory-actions.js";

export interface RunComposerProps {
  readonly runId: string;
  readonly actionState: FactoryActionState;
  readonly steer: (runId: string, instruction: string) => Promise<SteerRunResponse>;
  readonly cancel: (runId: string, reason: string) => Promise<CancelRunResponse>;
}

const MODES: readonly ComposerMode[] = ["steer", "answer", "cancel"];

const MODE_SWITCH_LABEL: Record<ComposerMode, string> = {
  steer: "Steer",
  answer: "Answer",
  cancel: "Cancel"
};

/**
 * No HTTP route, control-plane handler, or `AutoStackApiClient` method exists for submitting a
 * clarification answer — see the Task 7 report escalation (E1). Per the interim ruling, `answer`
 * mode stays selectable and visible rather than disappearing (D1/D3 precedent: a missing backend
 * renders a typed, named unavailable state, never a silent gap), and its submit control stays in
 * the accessibility tree, permanently disabled, rather than looking live while doing nothing.
 */
const ANSWER_UNAVAILABLE_MESSAGE = "Answering clarifications is not served by this build.";

/**
 * Wires the `@autostack/ui` `Composer` primitive to the step 1 factory actions. Presentation and
 * glue only — no network code of its own; `steer`/`cancel` (and their busy flags and validation
 * errors) come entirely from `useFactoryActions`.
 */
export function RunComposer({ runId, actionState, steer, cancel }: RunComposerProps): ReactElement {
  const [mode, setMode] = useState<ComposerMode>("steer");

  const busy =
    mode === "steer" ? actionState.steering : mode === "cancel" ? actionState.cancelling : true;
  const validationError =
    mode === "steer"
      ? actionState.steerError
      : mode === "cancel"
        ? actionState.cancelError
        : undefined;

  // No `content.trim().length === 0` re-check here: `Composer` already gates on empty/whitespace
  // content before ever calling `onSubmit` (Task 4b's dead-guard removal precedent — a caller-side
  // duplicate of a gate the callee already owns is unreachable, not defense in depth).
  function handleSubmit(content: string): void {
    if (mode === "steer") {
      void steer(runId, content).catch(() => undefined);
      return;
    }
    if (mode === "cancel") {
      void cancel(runId, content).catch(() => undefined);
      return;
    }
    // mode === "answer": no backing action exists — see `ANSWER_UNAVAILABLE_MESSAGE`. `busy` is
    // permanently `true` in this mode, so `Composer` never actually invokes this branch; it exists
    // only so every mode is handled explicitly.
  }

  return (
    <div className="run-composer">
      <div className="run-composer__mode-switch">
        {MODES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={mode === candidate}
            className="run-composer__mode-button"
            onClick={() => setMode(candidate)}
          >
            {MODE_SWITCH_LABEL[candidate]}
          </button>
        ))}
      </div>
      {mode === "answer" ? (
        <p className="run-composer__unavailable" role="status">
          {ANSWER_UNAVAILABLE_MESSAGE}
        </p>
      ) : null}
      {validationError === undefined ? null : (
        <p className="run-composer__error" role="alert">
          {validationError.message}
        </p>
      )}
      <Composer mode={mode} busy={busy} onSubmit={handleSubmit} />
    </div>
  );
}
