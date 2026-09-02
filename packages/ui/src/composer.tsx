import { useEffect, useId, useState, type FormEvent, type ReactElement } from "react";

export type ComposerMode = "steer" | "answer" | "cancel";

export interface ComposerProps {
  readonly mode: ComposerMode;
  /** Disables submission without removing the control from the accessibility tree. */
  readonly busy?: boolean;
  readonly onSubmit: (content: string) => void;
}

interface ComposerModeCopy {
  readonly fieldLabel: string;
  readonly submitLabel: string;
  readonly confirmLabel: string;
}

const MODE_COPY: Record<ComposerMode, ComposerModeCopy> = {
  steer: {
    fieldLabel: "Steering instruction",
    submitLabel: "Send instruction",
    confirmLabel: "Send instruction"
  },
  answer: {
    fieldLabel: "Answer",
    submitLabel: "Send answer",
    confirmLabel: "Send answer"
  },
  cancel: {
    fieldLabel: "Cancellation reason",
    submitLabel: "Cancel run",
    confirmLabel: "Confirm cancellation"
  }
};

/**
 * The persistent composer: one text field whose label and submit affordance
 * change with `mode`. `busy` disables the submit button (it stays in the
 * accessibility tree, merely `disabled`) rather than unmounting it. Empty or
 * whitespace-only content never reaches `onSubmit`. `cancel` mode is
 * destructive, so a first submit only surfaces a confirm step; `onSubmit`
 * fires only once that step is itself confirmed. The composer owns no
 * network state — it is a pure function of `mode` and `busy`.
 */
export function Composer({ mode, busy = false, onSubmit }: ComposerProps): ReactElement {
  const composerId = useId();
  const [content, setContent] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setContent("");
    setConfirming(false);
  }, [mode]);

  const copy = MODE_COPY[mode];
  const fieldId = `as-composer-field-${composerId}`;
  const trimmed = content.trim();
  const hasContent = trimmed.length > 0;

  // No `!hasContent` guard here: the sole caller gates on it, so the check was unreachable and
  // its coverage gap was real. Keep the invariant at the one boundary that can actually enforce it.
  function commit(): void {
    onSubmit(trimmed);
    setContent("");
    setConfirming(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!hasContent || busy) return;

    if (mode === "cancel" && !confirming) {
      setConfirming(true);
      return;
    }
    commit();
  }

  return (
    <form className="as-composer" data-mode={mode} onSubmit={handleSubmit}>
      <label className="as-composer__label" htmlFor={fieldId}>
        {copy.fieldLabel}
      </label>
      <textarea
        id={fieldId}
        className="as-composer__field"
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
          setConfirming(false);
        }}
      />
      {mode === "cancel" && confirming ? (
        <p className="as-composer__confirm-notice" role="alert">
          This cancels the run and cannot be undone.
        </p>
      ) : null}
      <div className="as-composer__actions">
        {mode === "cancel" && confirming ? (
          <button type="button" className="as-composer__back" onClick={() => setConfirming(false)}>
            Keep the run going
          </button>
        ) : null}
        <button type="submit" className="as-composer__submit" disabled={!hasContent || busy}>
          {mode === "cancel" && confirming ? copy.confirmLabel : copy.submitLabel}
        </button>
      </div>
    </form>
  );
}
