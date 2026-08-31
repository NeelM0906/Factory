import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from "react";

export interface CommandPaletteCommand {
  readonly id: string;
  readonly title: string;
  /** Present iff the command is unavailable for the current selection. The command still renders. */
  readonly disabledReason?: string;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  /** The dialog's accessible name. */
  readonly label: string;
  readonly commands: readonly CommandPaletteCommand[];
  readonly onClose: () => void;
  readonly onInvoke: (commandId: string) => void;
}

function optionId(paletteId: string, commandId: string): string {
  return `as-command-option-${paletteId}-${commandId}`;
}

/**
 * A modal command palette: `role="dialog"` with `aria-modal`, a filter input
 * that keeps DOM focus for its whole lifetime, and a `role="listbox"` of
 * `role="option"` rows driven by `aria-activedescendant` rather than roving
 * DOM focus. Focus moves to the filter on open and is trapped between the
 * filter and the close button while the dialog is open; Escape closes it and
 * restores focus to whatever had it before the palette opened. A command
 * unavailable for the current selection stays visible, `aria-disabled`, and
 * is never invoked by Enter — an operator needs to see it exists.
 */
export function CommandPalette({
  open,
  label,
  commands,
  onClose,
  onInvoke
}: CommandPaletteProps): ReactElement | null {
  const paletteId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [filterText, setFilterText] = useState("");
  const [activeId, setActiveId] = useState<string | undefined>(undefined);

  const filtered = useMemo(() => {
    const needle = filterText.toLowerCase();
    return commands.filter((command) => command.title.toLowerCase().includes(needle));
  }, [commands, filterText]);

  // Reset the filter on every open, and restore focus to whatever invoked the
  // palette when it closes (Escape, or the parent flipping `open` any other
  // way). The cleanup runs on the `open` transition, not only on unmount.
  useEffect(() => {
    if (!open) return undefined;
    setFilterText("");
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      invoker?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (filtered.length === 0) {
      setActiveId(undefined);
      return;
    }
    if (!filtered.some((command) => command.id === activeId)) {
      setActiveId(filtered[0]?.id);
    }
  }, [filtered, activeId]);

  if (!open) return null;

  function moveActive(delta: number): void {
    if (filtered.length === 0) return;
    const currentIndex = filtered.findIndex((command) => command.id === activeId);
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = Math.min(Math.max(baseIndex + delta, 0), filtered.length - 1);
    setActiveId(filtered[nextIndex]?.id);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = filtered.find((command) => command.id === activeId);
      if (active !== undefined && active.disabledReason === undefined) {
        onInvoke(active.id);
      }
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const first = inputRef.current;
    const last = closeButtonRef.current;
    if (first === null || last === null) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const titleId = `as-command-palette-title-${paletteId}`;
  const listboxId = `as-command-palette-listbox-${paletteId}`;

  return (
    <div
      className="as-command-palette"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={handleDialogKeyDown}
    >
      <h2 id={titleId} className="as-command-palette__title">
        {label}
      </h2>
      <input
        ref={inputRef}
        className="as-command-palette__filter"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId === undefined ? undefined : optionId(paletteId, activeId)}
        value={filterText}
        onChange={(event) => setFilterText(event.target.value)}
        onKeyDown={handleInputKeyDown}
      />
      <ul id={listboxId} className="as-command-palette__list" role="listbox">
        {filtered.map((command) => {
          const isActive = command.id === activeId;
          const isDisabled = command.disabledReason !== undefined;
          return (
            <li
              key={command.id}
              id={optionId(paletteId, command.id)}
              className="as-command-palette__option"
              role="option"
              aria-selected={isActive}
              aria-disabled={isDisabled ? "true" : undefined}
              data-active={isActive ? "true" : undefined}
            >
              <span className="as-command-palette__option-title">{command.title}</span>
              {command.disabledReason === undefined ? null : (
                <span className="as-command-palette__option-reason">{command.disabledReason}</span>
              )}
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li className="as-command-palette__empty" role="presentation">
            No matching commands
          </li>
        ) : null}
      </ul>
      <button
        ref={closeButtonRef}
        type="button"
        className="as-command-palette__close"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}
