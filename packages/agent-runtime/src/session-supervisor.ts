import {
  AgentCancelRequestSchema,
  AgentInvocationRequestSchema,
  AgentSessionStreamEventSchema,
  type AgentHarnessPort,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

import { AGENT_RUNTIME_FAILURES, AgentRuntimeError } from "./errors.js";
import type { AgentHarnessRegistry } from "./harness-registry.js";
import { createSessionEventRelay, type SessionEventTemplate } from "./session-event-relay.js";
import { buildInterruptionTemplate } from "./session-interruption.js";
import {
  deriveSessionSnapshot,
  type AgentSessionSnapshot,
  type SessionTerminalKind
} from "./session-snapshot.js";

export interface AgentSessionSupervisorDeps {
  readonly registry: AgentHarnessRegistry;
  readonly now: () => string;
  /** Durable sink; a rejection marks the session interrupted rather than reporting success. */
  readonly persist: (events: readonly AgentSessionStreamEvent[]) => Promise<void>;
  readonly cancellationGraceMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Resolves when the host that owns the adapter process is lost (spec section 15). */
  readonly hostLoss?: Promise<void>;
}

export interface AgentSessionSupervisionHandle {
  /** Each iteration attaches a FRESH reader replaying the whole session from sequence 1. */
  readonly events: AsyncIterable<AgentSessionStreamEvent>;
  snapshot(): AgentSessionSnapshot;
  cancel(reason: string): Promise<void>;
}

export interface AgentSessionSupervisor {
  supervise(invocation: AgentInvocationRequest): AgentSessionSupervisionHandle;
}

/** Context stamped onto a template purely to VALIDATE its payload; never relayed or persisted. */
const VALIDATION_OCCURRED_AT = "2026-01-01T00:00:00.000Z";

/** Strips the relay-owned context so the supervisor re-stamps identity, order, and time itself. */
const toTemplate = (event: AgentSessionStreamEvent): SessionEventTemplate => {
  const { schemaVersion: _v, sessionId: _s, sequence: _n, occurredAt: _o, ...template } = event;
  return template;
};

const SILENT_END_REASON =
  "The adapter stream ended without a lifecycle terminal or an interruption.";
const SINK_FAILURE_REASON = "The durable sink refused the session's events.";
const TRANSPORT_FAILURE_REASON = "The adapter stream failed before the session finished.";
const HOST_LOSS_REASON = "The agent host was lost before the session finished.";

const createSupervisedSession = (
  deps: AgentSessionSupervisorDeps,
  invocation: AgentInvocationRequest,
  harness: AgentHarnessPort
): AgentSessionSupervisionHandle => {
  const sessionId = invocation.agentSessionId;

  // The relay's clock reads whatever the supervisor staged for the append in flight, so the event
  // handed to `persist` and the event the relay stamps are the same value.
  let stagedOccurredAt = VALIDATION_OCCURRED_AT;
  const relay = createSessionEventRelay({ sessionId, now: () => stagedOccurredAt });

  const transcript: AgentSessionStreamEvent[] = [];
  let terminalKind: SessionTerminalKind | undefined;
  let cancelRequested = false;
  let detached = false;
  let cancelInFlight: Promise<void> | undefined;

  let resolveConcluded = (): void => undefined;
  const concluded = new Promise<void>((resolve) => {
    resolveConcluded = resolve;
  });

  // Append lock: stage -> persist -> append runs atomically relative to every other append, so
  // concurrent writers (producer, cancellation grace, host-loss synthesis) can never interleave a
  // persist with someone else's stamping, and at most one of them concludes the session.
  let appendTail: Promise<void> = Promise.resolve();
  const withAppendLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = appendTail.then(task);
    appendTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  /** Caller holds the lock and has verified the relay is open. Persist-before-visibility. */
  const stampPersistAppend = async (
    template: SessionEventTemplate,
    options: { readonly tolerateSinkFailure: boolean }
  ): Promise<AgentSessionStreamEvent> => {
    stagedOccurredAt = deps.now();
    const stamped = AgentSessionStreamEventSchema.parse({
      ...template,
      schemaVersion: 1,
      sessionId,
      sequence: relay.lastSequence + 1,
      occurredAt: stagedOccurredAt
    });
    try {
      await deps.persist([stamped]);
    } catch (thrown) {
      // Only the interruption itself may outlive a refusing sink: readers must still learn of
      // the loss, and the alternative is a session that can never conclude at all.
      if (!options.tolerateSinkFailure) throw thrown;
    }
    const event = relay.append(template);
    transcript.push(event);
    if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
      terminalKind = event.type;
    }
    if (relay.state !== "open") resolveConcluded();
    return event;
  };

  /** Persists then relays one event; resolves undefined when the session already concluded. */
  const appendDurably = (
    template: SessionEventTemplate
  ): Promise<AgentSessionStreamEvent | undefined> =>
    withAppendLock(async () => {
      if (relay.state !== "open") return undefined;
      return stampPersistAppend(template, { tolerateSinkFailure: false });
    });

  /** Synthesizes the single supervisor-owned interruption iff the session is still open. */
  const concludeInterrupted = (reason: string): Promise<void> =>
    withAppendLock(async () => {
      if (relay.state !== "open") return;
      const template = await buildInterruptionTemplate({
        sessionId,
        transcript: [...transcript],
        reason
      });
      await stampPersistAppend(template, { tolerateSinkFailure: true });
    });

  const concludeOwnCancelled = async (): Promise<void> => {
    try {
      await appendDurably({ type: "cancelled" });
    } catch {
      await concludeInterrupted(SINK_FAILURE_REASON);
    }
  };

  /** Re-validates one adapter event's payload; identity, order, and time are the relay's. */
  const validateAdapterTemplate = (template: SessionEventTemplate): void => {
    AgentSessionStreamEventSchema.parse({
      ...template,
      schemaVersion: 1,
      sessionId,
      sequence: 1,
      occurredAt: VALIDATION_OCCURRED_AT
    });
  };

  const concludeInvalidEvent = async (): Promise<void> => {
    try {
      await appendDurably({
        type: "failed",
        code: "agent_event_invalid",
        message: AGENT_RUNTIME_FAILURES.agent_event_invalid.message,
        retryable: false
      });
    } catch {
      await concludeInterrupted(SINK_FAILURE_REASON);
    }
  };

  /** Eager producer: adapter events land in the relay whether or not any reader is pulling. */
  const pump = async (): Promise<void> => {
    try {
      for await (const adapterEvent of harness.start(invocation)) {
        if (detached || relay.state !== "open") return;
        const template = toTemplate(adapterEvent);
        // A completed racing an issued cancellation is dropped: a cancelled session must never
        // end in the success shape.
        if (cancelRequested && template.type === "completed") continue;
        try {
          validateAdapterTemplate(template);
        } catch {
          await concludeInvalidEvent();
          return;
        }
        try {
          const appended = await appendDurably(template);
          if (appended === undefined) return;
        } catch {
          await concludeInterrupted(SINK_FAILURE_REASON);
          return;
        }
      }
      if (relay.state !== "open") return;
      if (cancelRequested) {
        await concludeOwnCancelled();
      } else {
        await concludeInterrupted(SILENT_END_REASON);
      }
    } catch {
      if (relay.state === "open" && !detached) {
        await concludeInterrupted(TRANSPORT_FAILURE_REASON);
      }
    }
  };

  const cancel = (reason: string): Promise<void> => {
    if (relay.state !== "open") return Promise.resolve();
    if (cancelInFlight !== undefined) return cancelInFlight;
    cancelRequested = true;
    cancelInFlight = (async () => {
      const request = AgentCancelRequestSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `${sessionId}:cancel`,
        sessionId,
        reason
      });
      await harness.cancel(request);
      let graceExpired = false;
      await Promise.race([
        concluded,
        deps.sleep(deps.cancellationGraceMs).then(() => {
          graceExpired = true;
        })
      ]);
      if (graceExpired && relay.state === "open") {
        // The adapter never acknowledged within the grace budget: detach from its stream and
        // conclude the session ourselves.
        detached = true;
        await concludeOwnCancelled();
      }
    })();
    return cancelInFlight;
  };

  const watchHostLoss = (): void => {
    if (deps.hostLoss === undefined) return;
    void deps.hostLoss.then(
      () => concludeInterrupted(HOST_LOSS_REASON).catch(() => undefined),
      () => undefined
    );
  };

  void pump();
  watchHostLoss();

  return {
    events: {
      [Symbol.asyncIterator]: () => relay.read()[Symbol.asyncIterator]()
    },
    snapshot: () => deriveSessionSnapshot(relay, terminalKind),
    cancel
  };
};

/**
 * Supervises agent sessions over any registered `AgentHarnessPort`: relays and re-validates every
 * adapter event through the session relay, persists each event before it becomes visible, bounds
 * cancellation by the injected sleep, and owns interruption synthesis only when the adapter did
 * not mark the loss itself. No timers beyond `deps.sleep`, no adapter-specific knowledge.
 */
export const createAgentSessionSupervisor = (
  deps: AgentSessionSupervisorDeps
): AgentSessionSupervisor => {
  const supervised = new Set<string>();

  const supervise = (invocation: AgentInvocationRequest): AgentSessionSupervisionHandle => {
    const parsed = AgentInvocationRequestSchema.parse(invocation);
    if (supervised.has(parsed.agentSessionId)) {
      throw new AgentRuntimeError("agent_session_already_supervised");
    }
    const harness = deps.registry.get(parsed.adapterId);
    const handle = createSupervisedSession(deps, parsed, harness);
    supervised.add(parsed.agentSessionId);
    return handle;
  };

  return { supervise };
};
