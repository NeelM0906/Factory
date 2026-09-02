/**
 * Session relay (plan Task 10): wraps a harness session to relay events, steer at await points,
 * and gate permissions.
 *
 * Stub — full implementation follows.
 */

import {
  PendingDomainEventSchema,
  redactSensitiveText,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type AgentSteerRequest,
  type PendingDomainEvent,
  type RunId,
  type RunStage,
  type WorkspaceId
} from "@autostack/contracts";

import type { Actor } from "@autostack/contracts";

/** The outcome of a relayed session: structured result (if any), events to commit, or failure. */
export type RelayOutcome =
  | { readonly kind: "completed"; readonly structured: unknown; readonly events: readonly PendingDomainEvent[] }
  | { readonly kind: "failed"; readonly failure: unknown; readonly events: readonly PendingDomainEvent[] };

export interface SessionRelayOptions {
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly stage: RunStage;
  readonly agentSessionId: string;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly now: () => string;
  readonly sensitiveValues?: readonly string[];
  readonly checkpoint: () => void;
}

/**
 * Runs a harness session and collects relayed events. Events are returned, not committed — the
 * station commits them in its single transaction at stage completion (F13).
 */
export const runRelayedSession = async (
  harness: AgentHarnessPort,
  invocation: AgentInvocationRequest,
  options: SessionRelayOptions
): Promise<RelayOutcome> => {
  const relayed: PendingDomainEvent[] = [];
  let structured: unknown;
  let sequence = 0;

  for await (const event of harness.start(invocation)) {
    options.checkpoint();
    sequence += 1;

    // Build a relayed event record.
    const relayEvent = PendingDomainEventSchema.parse({
      workspaceId: options.workspaceId,
      actor: options.actor,
      correlationId: options.correlationId,
      occurredAt: options.now(),
      type: "agent.session_event",
      payload: {
        runId: options.runId,
        stage: options.stage,
        agentSessionId: options.agentSessionId,
        sequence,
        event
      }
    });
    relayed.push(relayEvent);

    if (event.type === "failed") {
      return { kind: "failed", failure: event, events: relayed };
    }
    if (event.type === "output" && event.stream === "structured") {
      structured = JSON.parse(event.text) as unknown;
    }
  }
  return { kind: "completed", structured, events: relayed };
};
