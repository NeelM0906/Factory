// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createId, type RunnerStreamEvent } from "@autostack/contracts";

import { TerminalPane } from "../src/panes/terminal-pane.js";

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

const workspaceId = createId("workspace", uuid(1));
const runId = createId("run", uuid(2));
const commandId = createId("command", uuid(3));
const artifactId = createId("artifact", uuid(4));
const OCCURRED_AT = "2026-08-20T12:00:00.000Z";

const context = (sequence: number) => ({
  workspaceId,
  runId,
  commandId,
  sequence,
  occurredAt: OCCURRED_AT
});

const outputEvent = (sequence: number, text: string): RunnerStreamEvent => ({
  ...context(sequence),
  type: "terminal.output",
  stream: "pty",
  text
});

const truncatedEvent = (sequence: number, droppedBytes: number): RunnerStreamEvent => ({
  ...context(sequence),
  type: "terminal.truncated",
  stream: "pty",
  droppedBytes
});

const streamErrorEvent = (
  sequence: number,
  code: "protocol_failure" | "output_quarantined" | "guardian_lost",
  message: string
): RunnerStreamEvent => ({
  ...context(sequence),
  type: "stream.error",
  code,
  message
});

describe("TerminalPane", () => {
  it("renders events ordered by sequence, even when the input array is out of order", () => {
    render(
      <TerminalPane
        events={[outputEvent(3, "Gamma"), outputEvent(1, "Alpha"), outputEvent(2, "Beta")]}
      />
    );

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Beta"),
      expect.stringContaining("Gamma")
    ]);
  });

  it("renders terminal.truncated as visible evidence alongside surrounding output, never silently", () => {
    render(
      <TerminalPane
        events={[outputEvent(1, "line one"), truncatedEvent(2, 4_096), outputEvent(3, "line two")]}
      />
    );

    expect(screen.getByText("line one")).toBeInTheDocument();
    expect(screen.getByText("line two")).toBeInTheDocument();
    expect(screen.getByText(/4096 byte/)).toBeInTheDocument();
    // The truncation marker must not be merely present in the data — it must render as its own
    // visible list entry, not folded silently into a neighboring output entry.
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("renders stream.error as a terminal marker, with its code and message", () => {
    render(
      <TerminalPane
        events={[
          outputEvent(1, "line one"),
          streamErrorEvent(2, "guardian_lost", "The guardian process was lost.")
        ]}
      />
    );

    const errorItem = screen.getByText("Stream error").closest("li");
    expect(errorItem).not.toBeNull();
    expect(errorItem).toHaveAttribute("data-stream-terminal", "true");
    expect(screen.getByText(/guardian_lost/)).toBeInTheDocument();
    expect(screen.getByText(/The guardian process was lost\./)).toBeInTheDocument();
  });

  it.each<readonly [string, RunnerStreamEvent, readonly string[]]>([
    ["command.started", { ...context(1), type: "command.started", pty: true }, ["Command started"]],
    [
      "artifact.created",
      {
        ...context(1),
        type: "artifact.created",
        artifact: {
          artifactId,
          workspaceId,
          runId,
          commandId,
          kind: "command_output",
          mediaType: "text/plain",
          digest: "a".repeat(64),
          byteSize: 2_048,
          createdAt: OCCURRED_AT
        }
      },
      ["Artifact created", "command_output", "2048 byte(s)"]
    ],
    [
      "command.completed (exit code)",
      {
        ...context(1),
        type: "command.completed",
        exitCode: 0,
        signal: null,
        durationMs: 1_500,
        cancelled: false,
        interrupted: false,
        transcript: {
          artifactId,
          workspaceId,
          runId,
          commandId,
          kind: "command_transcript",
          mediaType: "text/plain",
          digest: "b".repeat(64),
          byteSize: 512,
          createdAt: OCCURRED_AT
        }
      },
      ["Command completed", "Exit code 0"]
    ],
    [
      "command.completed (signal, interrupted)",
      {
        ...context(1),
        type: "command.completed",
        exitCode: null,
        signal: "SIGTERM",
        durationMs: 900,
        cancelled: false,
        interrupted: true,
        transcript: {
          artifactId,
          workspaceId,
          runId,
          commandId,
          kind: "command_transcript",
          mediaType: "text/plain",
          digest: "c".repeat(64),
          byteSize: 128,
          createdAt: OCCURRED_AT
        }
      },
      ["Command completed", "Signal: SIGTERM", "Interrupted"]
    ],
    [
      "command.completed (cancelled)",
      {
        ...context(1),
        type: "command.completed",
        exitCode: null,
        signal: "SIGKILL",
        durationMs: 300,
        cancelled: true,
        interrupted: false,
        transcript: {
          artifactId,
          workspaceId,
          runId,
          commandId,
          kind: "command_transcript",
          mediaType: "text/plain",
          digest: "d".repeat(64),
          byteSize: 64,
          createdAt: OCCURRED_AT
        }
      },
      ["Command completed", "Signal: SIGKILL", "Cancelled"]
    ]
  ])("renders the %s event with its own label and payload", (_name, event, expectedTexts) => {
    render(<TerminalPane events={[event]} />);

    for (const text of expectedTexts) {
      expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
    }
  });

  it("renders a named empty state when there are no events", () => {
    render(<TerminalPane events={[]} />);

    expect(screen.getByText(/no terminal output/i)).toBeInTheDocument();
  });
});
