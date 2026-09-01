import { useEffect, useState } from "react";

import type { CommandPaletteCommand } from "@autostack/ui";

import type { RunStatus } from "@autostack/contracts";

/**
 * The selection state the palette's availability decisions are a pure function of. Deliberately
 * narrow — only `selectedRunStatus` (not a full `RunSummary`) and `creating` (mirroring
 * `FactoryState.creating`) are what any of the six commands' availability actually depends on.
 */
export interface CommandSelection {
  readonly selectedRunStatus: RunStatus | undefined;
  readonly creating: boolean;
}

const NOT_CANCELLABLE_STATUSES = new Set<RunStatus>([
  "completed",
  "cancelled",
  "failed",
  "cancelling"
]);

/**
 * Statuses with no transferable work left. Hand-off means handing the run's work to another
 * coding-agent teammate (spec §4.1 — "teammate" is an agent adapter throughout that spec, lines
 * 16/42/635), so it is available whenever work remains transferable and unavailable only once the
 * work is finished or being torn down. `failed` deliberately ADMITS hand-off: a failed run is the
 * natural moment to pick a different agent instead of retrying the same one — which is why the
 * spec lists retry and hand-off as separate commands. (Lead ruling at Task 7 step 3 review,
 * replacing an implementer guess of "blocked on a human decision".)
 */
const HAND_OFF_UNAVAILABLE_STATUSES = new Set<RunStatus>(["completed", "cancelling", "cancelled"]);

const buildCommand = (
  id: string,
  title: string,
  disabledReason: string | undefined
): CommandPaletteCommand =>
  disabledReason === undefined ? { id, title } : { id, title, disabledReason };

/**
 * Produces every palette command from the current selection, in a stable order. Every command is
 * always emitted — an unavailable one carries `disabledReason` rather than being filtered out, so
 * `CommandPalette` (which already renders a `disabledReason`-carrying command as `aria-disabled`,
 * never silently missing — Task 4b) has something to show. Availability is a pure function of
 * `selection`: no I/O, no randomness, no clock.
 */
export function buildCommandRegistry(
  selection: CommandSelection
): readonly CommandPaletteCommand[] {
  const { selectedRunStatus, creating } = selection;
  const noSelectionReason = (verb: string): string | undefined =>
    selectedRunStatus === undefined ? `Select a run to ${verb} it.` : undefined;

  return [
    buildCommand(
      "create-run",
      "Create run",
      creating ? "A run is already being created." : undefined
    ),
    buildCommand("locate-run", "Locate run", noSelectionReason("locate")),
    buildCommand("open-run", "Open run", noSelectionReason("open")),
    buildCommand(
      "cancel-run",
      "Cancel run",
      noSelectionReason("cancel") ??
        (selectedRunStatus !== undefined && NOT_CANCELLABLE_STATUSES.has(selectedRunStatus)
          ? "This run can no longer be cancelled."
          : undefined)
    ),
    buildCommand(
      "retry-run",
      "Retry run",
      noSelectionReason("retry") ??
        (selectedRunStatus !== undefined && selectedRunStatus !== "failed"
          ? "Only a failed run can be retried."
          : undefined)
    ),
    buildCommand(
      "hand-off-run",
      "Hand off run",
      noSelectionReason("hand off") ??
        (selectedRunStatus !== undefined && HAND_OFF_UNAVAILABLE_STATUSES.has(selectedRunStatus)
          ? "This run's work is finished — nothing to hand off."
          : undefined)
    )
  ];
}

export interface CommandPaletteShortcut {
  readonly open: boolean;
  readonly closePalette: () => void;
}

/**
 * `Cmd/Ctrl+K` opens the palette from anywhere in the shell. `Escape`-close and focus restoration
 * to the invoker are entirely `CommandPalette`'s own responsibility (Task 4b) — this hook owns
 * only the open/closed boolean and the global keydown listener, and reuses the primitive rather
 * than reimplementing any part of its focus handling.
 *
 * The keybinding only ever *opens* — it never toggles closed. A naive `setOpen((current) =>
 * !current)` would let a habitual second `Cmd/Ctrl+K` close the palette and a third one reopen
 * it; `CommandPalette`'s own invoker-capture effect (keyed on `open`) would then capture whatever
 * has focus at *that* moment — not the element that triggered the very first open — clobbering
 * the stored focus-return target. The `if (open) return;` guard below is what this stream calls
 * out by name: the keybinding must not fire (must not re-open or toggle) while already open.
 */
export function useCommandPaletteShortcut(): CommandPaletteShortcut {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) return;
      event.preventDefault();
      if (open) return;
      setOpen(true);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return { open, closePalette: () => setOpen(false) };
}
