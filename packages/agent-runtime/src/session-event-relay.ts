import {
  AgentSessionStreamEventSchema,
  type AgentSessionId,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

import { AgentRuntimeError } from "./errors.js";

/** `Omit` that distributes over each member of a union instead of collapsing it to one object. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface SessionEventRelayOptions {
  readonly sessionId: AgentSessionId;
  readonly now: () => string;
}

/**
 * What a producer supplies: the event minus everything the relay stamps itself. Identity
 * (`sessionId`), ordering (`sequence`), and time (`occurredAt`, from the injected clock) come from
 * the relay's construction options so a producer can never forge them.
 */
export type SessionEventTemplate = DistributiveOmit<
  AgentSessionStreamEvent,
  "schemaVersion" | "sessionId" | "sequence" | "occurredAt"
>;

export interface SessionEventRelay {
  readonly state: "open" | "terminal" | "interrupted" | "closed";
  readonly lastSequence: number;
  append(template: SessionEventTemplate): AgentSessionStreamEvent;
  read(options?: { readonly after?: number }): AsyncIterable<AgentSessionStreamEvent>;
  close(): void;
}

/** Bounded so a runaway producer surfaces as a refusal instead of silently dropping evidence. */
const MAX_BUFFERED_EVENTS = 10_000;

const LIFECYCLE_TERMINAL_TYPES: ReadonlySet<AgentSessionStreamEvent["type"]> = new Set([
  "completed",
  "failed",
  "cancelled"
]);

const endsStream = (event: AgentSessionStreamEvent): boolean =>
  LIFECYCLE_TERMINAL_TYPES.has(event.type) || event.type === "interrupted";

/**
 * One producer appends, many readers consume in order, and a late reader replays everything from
 * its cursor: the buffer holds every accepted event (sequence `n` at index `n - 1`), so a resumed
 * session reads the SAME relay from wherever it left off.
 */
export const createSessionEventRelay = (options: SessionEventRelayOptions): SessionEventRelay => {
  const buffer: AgentSessionStreamEvent[] = [];
  const waiters = new Set<() => void>();
  let state: SessionEventRelay["state"] = "open";

  const notify = (): void => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter();
    }
  };

  const waitUntil = async (satisfied: () => boolean): Promise<void> => {
    while (!satisfied()) {
      await new Promise<void>((resolve) => waiters.add(resolve));
    }
  };

  const refuseWhenNotOpen = (): void => {
    if (state === "terminal") throw new AgentRuntimeError("agent_session_already_terminal");
    if (state === "interrupted") throw new AgentRuntimeError("agent_session_interrupted");
    if (state === "closed") throw new AgentRuntimeError("agent_session_disposed");
  };

  const append = (template: SessionEventTemplate): AgentSessionStreamEvent => {
    refuseWhenNotOpen();
    if (buffer.length >= MAX_BUFFERED_EVENTS) {
      throw new AgentRuntimeError("agent_session_stream_overflow");
    }
    // The sequence is derived from the buffer, so a template that fails validation below never
    // advances it: nothing was accepted, nothing was counted.
    const event = AgentSessionStreamEventSchema.parse({
      ...template,
      schemaVersion: 1,
      sessionId: options.sessionId,
      sequence: buffer.length + 1,
      occurredAt: options.now()
    });
    buffer.push(event);
    if (LIFECYCLE_TERMINAL_TYPES.has(event.type)) {
      state = "terminal";
    } else if (event.type === "interrupted") {
      state = "interrupted";
    }
    notify();
    return event;
  };

  const read = (readOptions?: {
    readonly after?: number;
  }): AsyncIterable<AgentSessionStreamEvent> => {
    const after = readOptions?.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError("A read cursor must be a non-negative integer sequence number.");
    }
    return (async function* () {
      let index = after;
      for (;;) {
        while (index < buffer.length) {
          const event = buffer[index];
          if (event === undefined) return;
          index += 1;
          yield event;
          if (endsStream(event)) return;
        }
        if (state !== "open") return;
        await waitUntil(() => buffer.length > index || state !== "open");
      }
    })();
  };

  const close = (): void => {
    if (state === "closed") return;
    state = "closed";
    notify();
  };

  return {
    get state() {
      return state;
    },
    get lastSequence() {
      return buffer.length;
    },
    append,
    read,
    close
  };
};
