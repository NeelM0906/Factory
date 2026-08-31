import type { ReactNode } from "react";

import type { AgentSessionStreamEvent } from "@autostack/contracts";

export interface ConversationPaneProps {
  readonly events: readonly AgentSessionStreamEvent[];
}

interface EventPresentation {
  readonly label: string;
  readonly body: ReactNode;
}

/**
 * Maps every member of the `AgentSessionStreamEvent` union to a visible label and body. The
 * switch has no `default` case, so a member added to the contract's union without a case added
 * here fails at compile time rather than being silently dropped from the conversation.
 */
function presentEvent(event: AgentSessionStreamEvent): EventPresentation {
  switch (event.type) {
    case "started":
      return {
        label: "Session started",
        body:
          event.providerSessionRef === undefined ? null : (
            <p>Provider session: {event.providerSessionRef}</p>
          )
      };
    case "output":
      return { label: `Output · ${event.stream}`, body: <p>{event.text}</p> };
    case "permission_requested":
      // This lifecycle event carries no `options` field (`AgentSessionEventSchema` in
      // `@autostack/contracts`) — the option set lives in the separate `AgentPermissionRequestSchema`
      // used by the permission-response channel, not in the session stream. Rendering the summary
      // and reference is everything this event actually carries.
      return {
        label: "Permission requested",
        body: (
          <p>
            {event.summary} (ref: {event.permissionRef})
          </p>
        )
      };
    case "waiting":
      return { label: "Waiting", body: <p>{event.reason}</p> };
    case "completed":
      return {
        label: "Session completed",
        body: <p>{event.evidenceDigests.length} evidence record(s) recorded.</p>
      };
    case "failed":
      return { label: "Failed", body: <p>{event.message}</p> };
    case "cancelled":
      return { label: "Cancelled", body: null };
    case "message":
      return { label: `Message · ${event.role}`, body: <p>{event.text}</p> };
    case "thought_summary":
      return { label: "Thought summary", body: <p>{event.text}</p> };
    case "plan":
      return { label: "Plan", body: <p>{event.summary}</p> };
    case "tool_call":
      return {
        label: `Tool call · ${event.name} (${event.phase})`,
        body: event.detail === undefined ? null : <p>{event.detail}</p>
      };
    case "file_change":
      return { label: `File ${event.change}`, body: <p>{event.path}</p> };
    case "permission_resolved":
      return {
        label: "Permission resolved",
        body: <p>Chosen option: {event.selectedOptionId}</p>
      };
    case "usage":
      return { label: "Usage recorded", body: null };
    case "interrupted":
      return { label: "Interrupted", body: <p>{event.reason}</p> };
  }
}

/**
 * Renders an agent session's event stream (spec §9.1). Pure presentational: it trusts nothing
 * about caller ordering and re-sorts by `sequence` itself, and every event type in the contract's
 * union renders with its own visible, non-color-only label — never collapsed into a generic entry.
 */
export function ConversationPane({ events }: ConversationPaneProps) {
  if (events.length === 0) {
    return <p className="conversation-pane__empty">No conversation events recorded yet.</p>;
  }

  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  return (
    <ol className="conversation-pane" aria-label="Conversation">
      {ordered.map((event) => {
        const { label, body } = presentEvent(event);
        return (
          <li
            className="conversation-pane__event"
            data-event-type={event.type}
            key={event.sequence}
          >
            <p className="conversation-pane__event-label">{label}</p>
            {body}
          </li>
        );
      })}
    </ol>
  );
}
