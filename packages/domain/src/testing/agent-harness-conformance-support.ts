import { expect } from "vitest";

import {
  AgentSessionStreamEventSchema,
  type AgentPermissionResponderPort,
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

export type Quiesce = () => Promise<void>;

/**
 * The in-process default: drain the microtask queue a bounded number of turns. Enough for a fake
 * that resolves its waiters synchronously, and never enough for a transport that delivers frames on
 * a macrotask — which is why a fixture with such a transport must supply its own.
 */
export const defaultQuiesce: Quiesce = async () => {
  for (let turn = 0; turn < SETTLING_TURNS; turn += 1) await Promise.resolve();
};

export const quiesceOf = (subject: AgentHarnessConformanceSubject): Quiesce => {
  const quiesce = subject.quiesce;
  return quiesce === undefined ? defaultQuiesce : () => quiesce.call(subject);
};

/**
 * Whether `promise` is still unsettled once the adapter has quiesced.
 *
 * Observing first and quiescing second is deliberate: racing the two would make the answer depend
 * on which of them the runtime happened to schedule first, whereas a settlement that lands at any
 * point during the quiesce is recorded before the check reads it.
 */
export const isPending = async (promise: Promise<unknown>, quiesce: Quiesce): Promise<boolean> => {
  let settled = false;
  const observed = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  void observed;
  await quiesce();
  return !settled;
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

/**
 * Pulls events until the session stops producing them, leaving the blocked pull outstanding.
 *
 * Event-driven rather than time-boxed: each pull is judged only once the adapter has quiesced, so a
 * transport that needs a macrotask per frame is followed to its real stopping point instead of
 * being declared paused at the first frame it has not delivered yet.
 */
export const pullUntilPaused = async (
  iterator: AgentSessionIterator,
  quiesce: Quiesce
): Promise<PausedSession> => {
  const events: AgentSessionStreamEvent[] = [];
  while (events.length < MAX_EVENTS_BEFORE_PAUSE) {
    const pending = iterator.next();
    if (await isPending(pending, quiesce)) return { events, pending };
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

/**
 * The invariants every conformant stream holds, whatever the adapter: contract-valid events, one
 * session identity, strictly increasing positive sequence numbers, nothing after a lifecycle
 * terminal, and no capability the descriptor denies.
 *
 * `after` is the exclusive lower bound on the first sequence number — `0` for a freshly started
 * session, the last observed sequence for a resumed one. The contract requires only a positive
 * integer, so no particular starting value is pinned.
 */
export const expectSessionStream = (
  events: readonly AgentSessionStreamEvent[],
  subject: AgentHarnessConformanceSubject,
  after = 0
): void => {
  let previous = after;
  for (const event of events) {
    expect(AgentSessionStreamEventSchema.parse(event)).toEqual(event);
    expect(event.sessionId).toBe(subject.invocation.agentSessionId);
    expect(event.sequence).toBeGreaterThan(previous);
    previous = event.sequence;
  }
  const terminals = events.filter(isTerminalEvent);
  expect(terminals.length).toBeLessThanOrEqual(1);
  if (terminals.length === 1) expect(events.at(-1)).toBe(terminals[0]);
  // One-directional honesty: a denied capability may not appear, but a declared one need not.
  if (!subject.harness.descriptor.capabilities.structuredPlans) {
    expect(events.filter((event) => event.type === "plan")).toEqual([]);
  }
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
