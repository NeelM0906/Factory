// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createId, type AgentSessionStreamEvent } from "@autostack/contracts";

import { DiffPane } from "../src/panes/diff-pane.js";

afterEach(cleanup);

const uuid = (counter: number): string => {
  const hex = counter.toString(16).padStart(30, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(12, 15)}`,
    `8${hex.slice(15, 18)}`,
    hex.slice(18, 30)
  ].join("-");
};

const sessionId = createId("agentSession", uuid(1));
const OCCURRED_AT = "2026-08-20T12:00:00.000Z";

const context = (sequence: number) => ({
  schemaVersion: 1 as const,
  sessionId,
  sequence,
  occurredAt: OCCURRED_AT
});

const fileChangeEvent = (
  sequence: number,
  path: string,
  change: "added" | "modified" | "deleted"
): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "file_change",
  path,
  change
});

const messageEvent = (sequence: number, text: string): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "message",
  role: "assistant",
  text
});

describe("DiffPane", () => {
  it("renders a named empty state when there are no file_change events", () => {
    render(<DiffPane events={[]} />);

    expect(screen.getByText(/no file changes/i)).toBeInTheDocument();
  });

  it("renders a named empty state when only non-file_change events are present", () => {
    render(<DiffPane events={[messageEvent(1, "hello")]} />);

    expect(screen.getByText(/no file changes/i)).toBeInTheDocument();
  });

  it("counts every change kind separately for a single path", () => {
    render(
      <DiffPane
        events={[
          fileChangeEvent(1, "src/app.ts", "added"),
          fileChangeEvent(2, "src/app.ts", "added"),
          fileChangeEvent(3, "src/app.ts", "modified"),
          fileChangeEvent(4, "src/app.ts", "deleted"),
          fileChangeEvent(5, "src/app.ts", "deleted"),
          fileChangeEvent(6, "src/app.ts", "deleted")
        ]}
      />
    );

    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("2 added · 1 modified · 3 deleted")).toBeInTheDocument();
  });

  it("aggregates multiple events for the same path rather than overwriting", () => {
    render(
      <DiffPane
        events={[
          fileChangeEvent(1, "src/widget.ts", "modified"),
          fileChangeEvent(2, "src/widget.ts", "modified")
        ]}
      />
    );

    expect(screen.getByText("0 added · 2 modified · 0 deleted")).toBeInTheDocument();
  });

  it("ignores non-file_change events while still rendering file_change events (positive companion)", () => {
    render(
      <DiffPane
        events={[
          messageEvent(1, "Hello there."),
          fileChangeEvent(2, "src/only.ts", "added"),
          messageEvent(3, "Another message.")
        ]}
      />
    );

    // Non-file_change events contribute no path group of their own.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    // The one file_change event is not ignored: its path and counts render.
    expect(screen.getByText("src/only.ts")).toBeInTheDocument();
    expect(screen.getByText("1 added · 0 modified · 0 deleted")).toBeInTheDocument();
  });

  it("groups by path in a deterministic order (lexicographic by path) regardless of input order", () => {
    render(
      <DiffPane
        events={[
          fileChangeEvent(1, "z/last.ts", "added"),
          fileChangeEvent(2, "a/first.ts", "added"),
          fileChangeEvent(3, "m/middle.ts", "added")
        ]}
      />
    );

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("a/first.ts"),
      expect.stringContaining("m/middle.ts"),
      expect.stringContaining("z/last.ts")
    ]);
  });

  it("renders a path as literal text and never as markup, even when it looks like markup", () => {
    const maliciousPath = "src/<img src=x onerror=alert(1)>evil.ts";

    const { container } = render(
      <DiffPane events={[fileChangeEvent(1, maliciousPath, "added")]} />
    );

    // No element was created from the path's contents.
    expect(container.querySelector("img")).toBeNull();
    // The path appears verbatim as text.
    expect(screen.getByText(maliciousPath)).toBeInTheDocument();
    expect(container.textContent).toContain(maliciousPath);
  });
});
