// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createId, type AgentSessionStreamEvent } from "@autostack/contracts";

import { ConversationPane } from "../src/panes/conversation-pane.js";

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

const messageEvent = (sequence: number, text: string): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "message",
  role: "assistant",
  text
});

const thoughtSummaryEvent = (sequence: number, text: string): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "thought_summary",
  text
});

const toolCallEvent = (sequence: number, name: string): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "tool_call",
  toolCallRef: "call-1",
  name,
  phase: "started"
});

const permissionRequestedEvent = (sequence: number, summary: string): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "permission_requested",
  permissionRef: "perm-1",
  summary,
  evidenceDigest: "a".repeat(64)
});

const permissionResolvedEvent = (
  sequence: number,
  selectedOptionId: string
): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "permission_resolved",
  permissionRef: "perm-1",
  selectedOptionId
});

const interruptedEvent = (sequence: number, reason: string): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "interrupted",
  reason,
  retryable: true,
  evidenceDigests: ["a".repeat(64)]
});

const failedEvent = (sequence: number, message: string): AgentSessionStreamEvent => ({
  ...context(sequence),
  type: "failed",
  code: "internal_error",
  message,
  retryable: false
});

describe("ConversationPane", () => {
  it("renders events ordered by sequence, even when the input array is out of order", () => {
    render(
      <ConversationPane
        events={[messageEvent(3, "Gamma"), messageEvent(1, "Alpha"), messageEvent(2, "Beta")]}
      />
    );

    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Beta"),
      expect.stringContaining("Gamma")
    ]);
  });

  it("groups message, thought_summary, and tool_call events under distinct accessible labels", () => {
    render(
      <ConversationPane
        events={[
          messageEvent(1, "Hello there."),
          thoughtSummaryEvent(2, "Considering the approach."),
          toolCallEvent(3, "run_tests")
        ]}
      />
    );

    expect(screen.getByText("Message · assistant")).toBeInTheDocument();
    expect(screen.getByText("Thought summary")).toBeInTheDocument();
    expect(screen.getByText("Tool call · run_tests (started)")).toBeInTheDocument();
  });

  it("renders permission_requested's summary and reference, and permission_resolved's chosen option", () => {
    // NOTE: `AgentSessionEventSchema`'s `permission_requested` variant carries no `options` field
    // — that set lives in the separate `AgentPermissionRequestSchema`, not the session stream
    // (see the comment in conversation-pane.tsx). This asserts what the event actually carries.
    render(
      <ConversationPane
        events={[
          permissionRequestedEvent(1, "May I write this file?"),
          permissionResolvedEvent(2, "allow")
        ]}
      />
    );

    expect(screen.getByText("May I write this file? (ref: perm-1)")).toBeInTheDocument();
    expect(screen.getByText("Chosen option: allow")).toBeInTheDocument();
  });

  it("renders interrupted as a distinct, non-color-only state from failed, and both render their own marker", () => {
    render(
      <ConversationPane
        events={[
          interruptedEvent(1, "The operator paused the run."),
          failedEvent(2, "Command exited 1.")
        ]}
      />
    );

    const interrupted = screen.getByText("Interrupted");
    const failed = screen.getByText("Failed");

    // Positive companion: both markers are actually present (not merely unequal-because-absent).
    expect(interrupted).toBeInTheDocument();
    expect(failed).toBeInTheDocument();
    expect(interrupted.closest("li")).toHaveAttribute("data-event-type", "interrupted");
    expect(failed.closest("li")).toHaveAttribute("data-event-type", "failed");
    expect(screen.getByText("The operator paused the run.")).toBeInTheDocument();
    expect(screen.getByText("Command exited 1.")).toBeInTheDocument();
  });

  it("renders a named empty state when there are no events", () => {
    render(<ConversationPane events={[]} />);

    expect(screen.getByText(/no conversation events/i)).toBeInTheDocument();
  });

  // The exhaustive switch guarantees every union member HAS an arm at compile time; these vectors
  // guard what each remaining arm actually renders — an arm showing the wrong field (or nothing)
  // would otherwise pass every other test in this file.
  it.each<readonly [string, AgentSessionStreamEvent, readonly string[]]>([
    [
      "started",
      { ...context(1), type: "started", providerSessionRef: "sess-9" },
      ["Session started", "Provider session: sess-9"]
    ],
    [
      "output",
      { ...context(1), type: "output", stream: "stderr", text: "warning: deprecated" },
      ["Output · stderr", "warning: deprecated"]
    ],
    [
      "waiting",
      { ...context(1), type: "waiting", reason: "Awaiting plan approval." },
      ["Waiting", "Awaiting plan approval."]
    ],
    [
      "completed",
      { ...context(1), type: "completed", evidenceDigests: ["a".repeat(64), "b".repeat(64)] },
      ["Session completed", "2 evidence record(s) recorded."]
    ],
    ["cancelled", { ...context(1), type: "cancelled" }, ["Cancelled"]],
    [
      "plan",
      { ...context(1), type: "plan", planDigest: "c".repeat(64), summary: "Do the thing." },
      ["Plan", "Do the thing."]
    ],
    [
      "file_change",
      { ...context(1), type: "file_change", path: "src/app.ts", change: "modified" },
      ["File modified", "src/app.ts"]
    ],
    [
      "usage",
      {
        ...context(1),
        type: "usage",
        tokens: {
          input: { state: "reported", value: 10 },
          output: { state: "reported", value: 5 },
          cachedInput: { state: "unknown" },
          reasoning: { state: "unknown" }
        },
        cost: { state: "unknown" }
      },
      ["Usage recorded"]
    ]
  ])("renders the %s event with its own label and payload", (_type, event, expectedTexts) => {
    render(<ConversationPane events={[event]} />);

    for (const text of expectedTexts) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it("omits the optional bodies when absent and renders tool_call detail when present", () => {
    render(
      <ConversationPane
        events={[
          { ...context(1), type: "started" },
          {
            ...context(2),
            type: "tool_call",
            toolCallRef: "call-2",
            name: "read_file",
            phase: "completed",
            detail: "Read 12 lines."
          }
        ]}
      />
    );

    // `providerSessionRef` is optional and absent: no fabricated provider line.
    expect(screen.queryByText(/Provider session:/)).not.toBeInTheDocument();
    expect(screen.getByText("Session started")).toBeInTheDocument();
    expect(screen.getByText("Read 12 lines.")).toBeInTheDocument();
  });
});
