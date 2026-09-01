import { useState, type ReactElement } from "react";

import { Composer, type ComposerMode } from "@autostack/ui";

import type {
  AnswerClarificationResponse,
  CancelRunResponse,
  SteerRunResponse
} from "@autostack/contracts";

import type { FactoryActionState } from "../use-factory-actions.js";

export interface RunComposerProps {
  readonly runId: string;
  readonly actionState: FactoryActionState;
  readonly steer: (runId: string, instruction: string) => Promise<SteerRunResponse>;
  readonly cancel: (runId: string, reason: string) => Promise<CancelRunResponse>;
  readonly answerClarification: (
    runId: string,
    clarificationRef: string,
    answer: string
  ) => Promise<AnswerClarificationResponse>;
  /**
   * The clarification currently pending an answer for this run, or `undefined` when none is
   * pending. `| undefined` rather than `?:` to satisfy `exactOptionalPropertyTypes` and match the
   * existing pane convention (e.g. `RunInspectorProps.environment`): a caller must say "explicitly
   * none" rather than merely omit the prop.
   */
  readonly clarificationRef: string | undefined;
}

const MODES: readonly ComposerMode[] = ["steer", "answer", "cancel"];

const MODE_SWITCH_LABEL: Record<ComposerMode, string> = {
  steer: "Steer",
  answer: "Answer",
  cancel: "Cancel"
};

const NO_PENDING_CLARIFICATION_MESSAGE = "No clarification is pending to answer for this run.";

/**
 * Wires the `@autostack/ui` `Composer` primitive to the step 1/2b factory actions. Presentation
 * and glue only — no network code of its own; `steer`/`cancel`/`answerClarification` (and their
 * busy flags and validation errors) come entirely from `useFactoryActions`.
 */
export function RunComposer({
  runId,
  actionState,
  steer,
  cancel,
  answerClarification,
  clarificationRef
}: RunComposerProps): ReactElement {
  const [mode, setMode] = useState<ComposerMode>("steer");

  const busy =
    mode === "steer"
      ? actionState.steering
      : mode === "cancel"
        ? actionState.cancelling
        : actionState.answering;
  const validationError =
    mode === "steer"
      ? actionState.steerError
      : mode === "cancel"
        ? actionState.cancelError
        : actionState.answerError;

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
    // mode === "answer". This check is type narrowing (`clarificationRef` is `string | undefined`
    // and `answerClarification` needs a `string`), not a re-gate: `Composer` for this mode only
    // ever renders below when `clarificationRef !== undefined`, so `onSubmit` cannot fire while it
    // is `undefined` — the branch exists to satisfy the compiler, not to catch a reachable case.
    if (clarificationRef === undefined) return;
    void answerClarification(runId, clarificationRef, content).catch(() => undefined);
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
      {validationError === undefined ? null : (
        <p className="run-composer__error" role="alert">
          {validationError.message}
        </p>
      )}
      {mode === "answer" && clarificationRef === undefined ? (
        <p className="run-composer__unavailable" role="status">
          {NO_PENDING_CLARIFICATION_MESSAGE}
        </p>
      ) : (
        <Composer mode={mode} busy={busy} onSubmit={handleSubmit} />
      )}
    </div>
  );
}
