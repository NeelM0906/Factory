import type { ReactNode } from "react";

import type { RunnerStreamEvent } from "@autostack/contracts";

export interface TerminalPaneProps {
  readonly events: readonly RunnerStreamEvent[];
}

interface EventPresentation {
  readonly label: string;
  readonly body: ReactNode;
  /** Marks a `<li>` as ending the transcript — nothing after it is implied to be complete output. */
  readonly terminal?: true;
}

/**
 * Maps every member of the `RunnerStreamEvent` union to a visible label and body. No `default`
 * case: a member added to the contract's union without a case added here fails at compile time.
 */
function presentEvent(event: RunnerStreamEvent): EventPresentation {
  switch (event.type) {
    case "command.started":
      return { label: "Command started", body: null };
    case "terminal.output":
      return { label: "Output", body: <pre>{event.text}</pre> };
    case "terminal.truncated":
      // Never filtered out: a dropped-bytes marker is evidence of loss, and omitting it would
      // make the loss silent rather than visible.
      return {
        label: "Output truncated",
        body: <p>{event.droppedBytes} byte(s) of output were dropped.</p>
      };
    case "artifact.created":
      return {
        label: "Artifact created",
        body: (
          <p>
            {event.artifact.kind} · {event.artifact.byteSize} byte(s)
          </p>
        )
      };
    case "command.completed":
      return {
        label: "Command completed",
        body: (
          <p>
            {event.exitCode === null ? `Signal: ${event.signal}` : `Exit code ${event.exitCode}`}
            {event.cancelled ? " · Cancelled" : ""}
            {event.interrupted ? " · Interrupted" : ""}
          </p>
        )
      };
    case "stream.error":
      // Terminal: this marks the end of the transcript, since nothing after a stream error is
      // implied to be complete output.
      return {
        label: "Stream error",
        body: (
          <p>
            {event.code}: {event.message}
          </p>
        ),
        terminal: true
      };
  }
}

/**
 * Renders a command's runner evidence stream (spec §14.4-adjacent execution evidence). Pure
 * presentational: it trusts nothing about caller ordering and re-sorts by `sequence` itself, and
 * `terminal.truncated` always renders its own visible list entry rather than being folded away.
 */
export function TerminalPane({ events }: TerminalPaneProps) {
  if (events.length === 0) {
    return <p className="terminal-pane__empty">No terminal output recorded yet.</p>;
  }

  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  return (
    <ol className="terminal-pane" aria-label="Terminal">
      {ordered.map((event) => {
        const { label, body, terminal } = presentEvent(event);
        return (
          <li
            className="terminal-pane__event"
            data-event-type={event.type}
            {...(terminal === true ? { "data-stream-terminal": "true" } : {})}
            key={event.sequence}
          >
            <p className="terminal-pane__event-label">{label}</p>
            {body}
          </li>
        );
      })}
    </ol>
  );
}
