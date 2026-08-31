import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface PaneGroupPane {
  readonly id: string;
  readonly label: string;
  readonly content?: ReactNode;
  readonly emptyStateLabel?: string;
}

export interface PaneGroupProps {
  readonly label: string;
  readonly panes: readonly PaneGroupPane[];
  readonly defaultSelectedId?: string;
}

const DEFAULT_EMPTY_STATE_LABEL = "Nothing recorded yet";

function isSelectionKey(key: string): key is "ArrowRight" | "ArrowLeft" | "Home" | "End" {
  return key === "ArrowRight" || key === "ArrowLeft" || key === "Home" || key === "End";
}

/**
 * A real ARIA tablist: `role="tablist"` with one `role="tab"` per pane and
 * one visible `role="tabpanel"` for the selected pane. Roving tabindex keeps
 * exactly one tab in the Tab order at a time; ArrowRight/ArrowLeft move and
 * wrap, Home/End jump to the ends. A pane with no content renders a named
 * empty state rather than an empty panel.
 */
export function PaneGroup({ label, panes, defaultSelectedId }: PaneGroupProps) {
  const groupId = useId();
  const initialSelectedId =
    defaultSelectedId !== undefined && panes.some((pane) => pane.id === defaultSelectedId)
      ? defaultSelectedId
      : panes[0]?.id;

  const [selectedId, setSelectedId] = useState<string | undefined>(initialSelectedId);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = panes.findIndex((pane) => pane.id === selectedId);
  const activeIndex = selectedIndex === -1 ? 0 : selectedIndex;
  const activePane = panes[activeIndex];

  function selectIndex(index: number, moveFocus: boolean): void {
    const pane = panes[index];
    if (pane === undefined) return;
    setSelectedId(pane.id);
    if (moveFocus) {
      tabRefs.current[index]?.focus();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (panes.length === 0 || !isSelectionKey(event.key)) return;

    event.preventDefault();
    switch (event.key) {
      case "ArrowRight":
        selectIndex((index + 1) % panes.length, true);
        break;
      case "ArrowLeft":
        selectIndex((index - 1 + panes.length) % panes.length, true);
        break;
      case "Home":
        selectIndex(0, true);
        break;
      case "End":
        selectIndex(panes.length - 1, true);
        break;
    }
  }

  return (
    <div className="as-pane-group">
      <div className="as-pane-group__tablist" role="tablist" aria-label={label}>
        {panes.map((pane, index) => {
          const isSelected = index === activeIndex;
          const tabId = `as-pane-tab-${groupId}-${pane.id}`;
          const panelId = `as-pane-panel-${groupId}-${pane.id}`;
          return (
            <button
              key={pane.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              id={tabId}
              className="as-pane-group__tab"
              role="tab"
              aria-selected={isSelected}
              aria-controls={panelId}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => selectIndex(index, false)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {pane.label}
            </button>
          );
        })}
      </div>
      {activePane === undefined ? null : (
        <div
          id={`as-pane-panel-${groupId}-${activePane.id}`}
          className="as-pane-group__panel"
          role="tabpanel"
          aria-labelledby={`as-pane-tab-${groupId}-${activePane.id}`}
          tabIndex={0}
        >
          {activePane.content === undefined ? (
            <p className="as-pane-group__empty">
              {activePane.emptyStateLabel ?? DEFAULT_EMPTY_STATE_LABEL}
            </p>
          ) : (
            activePane.content
          )}
        </div>
      )}
    </div>
  );
}
