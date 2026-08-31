// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PaneGroup, type PaneGroupPane } from "../src/pane-group.js";

afterEach(cleanup);

const THREE_PANES: readonly PaneGroupPane[] = [
  { id: "conversation", label: "Conversation", content: <p>Conversation content</p> },
  { id: "plan", label: "Plan", content: <p>Plan content</p> },
  { id: "terminal", label: "Terminal", content: <p>Terminal content</p> }
];

describe("PaneGroup — structure", () => {
  it("renders a tablist with an aria-label and one tab per pane", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} />);

    const tablist = screen.getByRole("tablist", { name: "Workspace panes" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Conversation", "Plan", "Terminal"]);
  });

  it("wires aria-selected, aria-controls, and a matching tabpanel with aria-labelledby", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} />);

    const firstTab = screen.getByRole("tab", { name: "Conversation" });
    expect(firstTab).toHaveAttribute("aria-selected", "true");
    const controlsId = firstTab.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", controlsId);
    expect(panel).toHaveAttribute("aria-labelledby", firstTab.id);
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(within(panel).getByText("Conversation content")).toBeVisible();

    const secondTab = screen.getByRole("tab", { name: "Plan" });
    expect(secondTab).toHaveAttribute("aria-selected", "false");
  });

  it("selects a non-default pane via defaultSelectedId", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} defaultSelectedId="plan" />);

    expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Plan content");
  });

  it("renders a named empty state for a pane with no content, never an empty panel", () => {
    const panesWithEmpty: readonly PaneGroupPane[] = [
      { id: "findings", label: "Findings", emptyStateLabel: "No findings recorded yet" }
    ];
    render(<PaneGroup label="Workspace panes" panes={panesWithEmpty} />);

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("No findings recorded yet");
    expect(panel.textContent).not.toBe("");
  });

  it("falls back to a default empty-state message when none is supplied", () => {
    const panesWithEmpty: readonly PaneGroupPane[] = [{ id: "evidence", label: "Evidence" }];
    render(<PaneGroup label="Workspace panes" panes={panesWithEmpty} />);

    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).not.toBe("");
  });

  it("renders an empty tablist and no panel when given zero panes, without crashing", () => {
    render(<PaneGroup label="Workspace panes" panes={[]} />);

    expect(screen.getByRole("tablist", { name: "Workspace panes" })).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });
});

describe("PaneGroup — roving tabindex (guard)", () => {
  it("keeps exactly one tab tabbable at a time, and it is the selected one", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} />);

    const tabs = screen.getAllByRole("tab");
    const tabbable = tabs.filter((tab) => tab.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(screen.getByRole("tab", { name: "Conversation" }));

    const others = tabs.filter((tab) => tab.getAttribute("aria-selected") === "false");
    expect(others).toHaveLength(2);
    for (const tab of others) {
      expect(tab.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("moves the roving tabindex when selection changes via click", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} />);

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));

    const tabs = screen.getAllByRole("tab");
    const tabbable = tabs.filter((tab) => tab.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(screen.getByRole("tab", { name: "Plan" }));
  });
});

describe("PaneGroup — keyboard navigation", () => {
  it("ArrowRight moves selection to the next tab", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Conversation" }), { key: "ArrowRight" });

    expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Plan" }));
  });

  it("ArrowRight wraps from the last tab to the first", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} defaultSelectedId="terminal" />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Terminal" }), { key: "ArrowRight" });

    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("ArrowLeft wraps from the first tab to the last (guard)", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Conversation" }), { key: "ArrowLeft" });

    const lastTab = screen.getByRole("tab", { name: "Terminal" });
    expect(lastTab).toHaveAttribute("aria-selected", "true");
    expect(lastTab).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(lastTab);

    const firstTab = screen.getByRole("tab", { name: "Conversation" });
    expect(firstTab).toHaveAttribute("aria-selected", "false");
    expect(firstTab).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowLeft from the second tab moves to the first tab (no wrap)", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} defaultSelectedId="plan" />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Plan" }), { key: "ArrowLeft" });

    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("Home jumps to the first tab and End jumps to the last tab", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} defaultSelectedId="plan" />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Plan" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Terminal" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("ignores unrelated keys", () => {
    render(<PaneGroup label="Workspace panes" panes={THREE_PANES} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Conversation" }), { key: "a" });

    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});
