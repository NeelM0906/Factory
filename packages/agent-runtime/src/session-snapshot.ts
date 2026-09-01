import type { SessionEventRelay } from "./session-event-relay.js";

export type AgentSessionSnapshotState =
  "running" | "completed" | "failed" | "cancelled" | "interrupted";

/**
 * The supervisor's observable summary of one session. It deliberately carries no
 * `evidenceDigests`: no consumer in this stream reads them, and the digests are already in the
 * relayed events, which is the one place they cannot go stale.
 */
export interface AgentSessionSnapshot {
  readonly state: AgentSessionSnapshotState;
  readonly lastSequence: number;
}

/** The lifecycle terminal kinds a session can end in; `interrupted` is not one of them. */
export type SessionTerminalKind = "completed" | "failed" | "cancelled";

/**
 * Derives the snapshot from the relay's state machine plus the memo of WHICH lifecycle terminal
 * ended the stream. The memo is what keeps `completed` honest: a session may only report success
 * when its terminal was the `completed` event itself. Any ended session without a recorded
 * terminal kind fails closed to `interrupted` — never to success.
 */
export const deriveSessionSnapshot = (
  relay: Pick<SessionEventRelay, "state" | "lastSequence">,
  terminalKind: SessionTerminalKind | undefined
): AgentSessionSnapshot => {
  const state: AgentSessionSnapshotState =
    relay.state === "open"
      ? "running"
      : relay.state === "interrupted"
        ? "interrupted"
        : (terminalKind ?? "interrupted");
  return { state, lastSequence: relay.lastSequence };
};
