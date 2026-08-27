import { expect } from "vitest";

import {
  AgentSessionStreamEventSchema,
  type AgentPermissionResponderPort,
  type AgentSessionId,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

import type { AgentHarnessConformanceSubject } from "./agent-harness-conformance-fixture.js";

/** A session that has not terminated within this many events is not a conformant session. */
const MAX_STREAM_EVENTS = 1_000;
/** Turns of the microtask queue a settling operation is allowed before it counts as blocked. */
const SETTLING_TURNS = 8;
/** Events a paused scenario may emit before it blocks. */
const MAX_EVENTS_BEFORE_PAUSE = 32;

const TERMINAL_EVENT_TYPES: readonly string[] = ["completed", "failed", "cancelled"];

export const isTerminalEvent = (event: AgentSessionStreamEvent): boolean =>
  TERMINAL_EVENT_TYPES.includes(event.type);

export type AgentSessionIterator = AsyncIterator<AgentSessionStreamEvent>;

export const iterate = (stream: AsyncIterable<AgentSessionStreamEvent>): AgentSessionIterator =>
  stream[Symbol.asyncIterator]();

export const drain = async (
  iterator: AgentSessionIterator,
  initial: readonly AgentSessionStreamEvent[] = []
): Promise<AgentSessionStreamEvent[]> => {
  const events = [...initial];
  while (events.length <= MAX_STREAM_EVENTS) {
    const next = await iterator.next();
    if (next.done === true) return events;
    events.push(next.value);
  }
  throw new TypeError("An agent session stream did not terminate within its conformance bound.");
};

export const collect = async (
  stream: AsyncIterable<AgentSessionStreamEvent>
): Promise<AgentSessionStreamEvent[]> => drain(iterate(stream));

export const take = async (
  iterator: AgentSessionIterator,
  count: number
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  while (events.length < count) {
    const next = await iterator.next();
    if (next.done === true) {
      throw new TypeError("An agent session stream ended before the suite could observe it.");
    }
    events.push(next.value);
  }
  return events;
};

/**
 * Whether `promise` is still unsettled after the microtask queue has been drained a bounded number
 * of turns. No wall-clock timer is involved, so the answer is the same under any load.
 */
export const isPending = async (promise: Promise<unknown>): Promise<boolean> => {
  const blocked = Symbol("blocked");
  const settled: unknown = await Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    (async () => {
      for (let turn = 0; turn < SETTLING_TURNS; turn += 1) await Promise.resolve();
      return blocked;
    })()
  ]);
  return settled === blocked;
};

export interface SettledOutcome {
  readonly rejected: boolean;
  readonly reason: unknown;
}

/** Settles `promise` without letting a rejection escape, so a caller can assert on either outcome. */
export const settle = async (promise: Promise<unknown>): Promise<SettledOutcome> => {
  try {
    await promise;
    return { rejected: false, reason: undefined };
  } catch (error: unknown) {
    return { rejected: true, reason: error };
  }
};

export interface PausedSession {
  /** Everything the session emitted before it blocked. */
  readonly events: readonly AgentSessionStreamEvent[];
  /** The pull that is still outstanding because the session is waiting on the consumer. */
  readonly pending: Promise<IteratorResult<AgentSessionStreamEvent>>;
}

/** Pulls events until the session stops producing them, leaving the blocked pull outstanding. */
export const pullUntilPaused = async (iterator: AgentSessionIterator): Promise<PausedSession> => {
  const events: AgentSessionStreamEvent[] = [];
  while (events.length < MAX_EVENTS_BEFORE_PAUSE) {
    const pending = iterator.next();
    if (await isPending(pending)) return { events, pending };
    const next = await pending;
    if (next.done === true) {
      throw new TypeError("An agent session ended instead of waiting for the consumer.");
    }
    events.push(next.value);
  }
  throw new TypeError("An agent session did not pause within its conformance bound.");
};

/** Consumes the rest of a paused session, including the pull that was outstanding. */
export const drainPaused = async (
  paused: PausedSession,
  iterator: AgentSessionIterator
): Promise<AgentSessionStreamEvent[]> => {
  const next = await paused.pending;
  if (next.done === true) return [...paused.events];
  return drain(iterator, [...paused.events, next.value]);
};

export interface SessionStreamExpectation {
  readonly sessionId: AgentSessionId;
  /** Exclusive lower bound on the first sequence number; `0` for a freshly started session. */
  readonly after: number;
}

/**
 * The invariants every conformant stream holds, whatever the adapter: contract-valid events, one
 * session identity, strictly increasing sequence numbers, and nothing after a lifecycle terminal.
 */
export const expectSessionStream = (
  events: readonly AgentSessionStreamEvent[],
  expectation: SessionStreamExpectation
): void => {
  let previous = expectation.after;
  for (const event of events) {
    expect(AgentSessionStreamEventSchema.parse(event)).toEqual(event);
    expect(event.sessionId).toBe(expectation.sessionId);
    expect(event.sequence).toBeGreaterThan(previous);
    previous = event.sequence;
  }
  const terminals = events.filter(isTerminalEvent);
  expect(terminals.length).toBeLessThanOrEqual(1);
  if (terminals.length === 1) expect(events.at(-1)).toBe(terminals[0]);
};

/** The responder a subject must expose, or a failure naming the honesty rule it broke. */
export const requireResponder = (
  subject: AgentHarnessConformanceSubject
): AgentPermissionResponderPort["respondToPermission"] => {
  const respond = subject.harness.respondToPermission;
  if (respond === undefined) {
    throw new TypeError(
      "A harness declaring permission support must implement AgentPermissionResponderPort."
    );
  }
  return respond.bind(subject.harness);
};
