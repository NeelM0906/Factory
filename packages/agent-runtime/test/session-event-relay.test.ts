import { describe, expect, it } from "vitest";

import {
  AgentSessionIdSchema,
  AgentSessionStreamEventSchema,
  WorkflowFailureCodeSchema,
  WorkflowFailureSchema,
  type AgentSessionStreamEvent
} from "@autostack/contracts";

import { createSessionEventRelay, type SessionEventTemplate } from "../src/session-event-relay.js";
import { AGENT_RUNTIME_FAILURES, AgentRuntimeError } from "../src/errors.js";

const digest = (character: string): string => character.repeat(64);

const sessionId = AgentSessionIdSchema.parse("agt_123e4567-e89b-42d3-a456-426614174000");

const createClock = (): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 31, 12, 0, 0, tick)).toISOString();
  };
};

const createRelay = () => createSessionEventRelay({ sessionId, now: createClock() });

const output = (text: string): SessionEventTemplate => ({ type: "output", stream: "stdout", text });

const completed: SessionEventTemplate = {
  type: "completed",
  evidenceDigests: [digest("a")]
};

const interrupted: SessionEventTemplate = {
  type: "interrupted",
  reason: "The provider connection dropped.",
  retryable: true,
  evidenceDigests: [digest("b")]
};

const collect = async (
  stream: AsyncIterable<AgentSessionStreamEvent>
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const expectRuntimeFailure = (run: () => unknown, code: string): AgentRuntimeError => {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentRuntimeError);
  if (!(caught instanceof AgentRuntimeError)) {
    throw new Error("Expected the call to raise an AgentRuntimeError.");
  }
  expect(caught.code).toBe(code);
  return caught;
};

describe("createSessionEventRelay", () => {
  it("stamps schemaVersion, sessionId, sequence, and occurredAt onto appended templates", () => {
    const relay = createRelay();

    const first = relay.append({ type: "started", providerSessionRef: "provider.session.1" });
    const second = relay.append(output("hello"));

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(relay.lastSequence).toBe(2);
    expect(first.schemaVersion).toBe(1);
    expect(first.sessionId).toBe(sessionId);
    // The injected clock is the only time source: one tick per append, in order.
    expect(first.occurredAt).toBe("2026-08-31T12:00:00.001Z");
    expect(second.occurredAt).toBe("2026-08-31T12:00:00.002Z");
    // The returned value is the parsed contract event, not the raw template.
    expect(AgentSessionStreamEventSchema.parse(first)).toEqual(first);
    expect(AgentSessionStreamEventSchema.parse(second)).toEqual(second);
  });

  it("rejects an invalid template without advancing the sequence counter (rejects an implementation that increments before validating)", () => {
    const relay = createRelay();
    relay.append(output("first"));

    // An empty output text violates SafeMetadataStringSchema's min(1).
    expect(() => relay.append(output(""))).toThrow();

    expect(relay.lastSequence).toBe(1);
    // Positive companion: the next successful append takes sequence 2, proving the
    // failed append left no gap behind.
    expect(relay.append(output("second")).sequence).toBe(2);
  });

  it("read({ after }) yields only events with sequence greater than the cursor (rejects an implementation that treats `after` as an array index)", async () => {
    const relay = createRelay();
    relay.append(output("one"));
    relay.append(output("two"));
    relay.append(output("three"));
    relay.append(completed);

    const everything = await collect(relay.read({ after: 0 }));
    expect(everything.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);

    const fromCursor = await collect(relay.read({ after: 2 }));
    expect(fromCursor.map((event) => event.sequence)).toEqual([3, 4]);

    const pastEnd = await collect(relay.read({ after: 4 }));
    expect(pastEnd).toEqual([]);
  });

  it("a late reader still sees every buffered event from its cursor", async () => {
    const relay = createRelay();
    relay.append(output("early"));
    relay.append(output("later"));
    relay.append(completed);

    const late = await collect(relay.read());
    expect(late.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("a reader attached before any append stays pending until an append arrives (rejects a relay whose empty read ends immediately)", async () => {
    const relay = createRelay();
    const iterator = relay.read({ after: 0 })[Symbol.asyncIterator]();
    const first = iterator.next();

    const settled = await Promise.race([
      first.then(() => "delivered"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("pending"), 10);
      })
    ]);
    expect(settled).toBe("pending");

    const appended = relay.append(output("wakes the reader"));
    const result = await first;
    expect(result.done).toBe(false);
    expect(result.value).toEqual(appended);

    relay.close();
    const end = await iterator.next();
    expect(end.done).toBe(true);
  });

  it.each([
    ["completed", completed],
    [
      "failed",
      {
        type: "failed",
        code: "provider_error",
        message: "The provider failed.",
        retryable: false
      } satisfies SessionEventTemplate
    ],
    ["cancelled", { type: "cancelled" } satisfies SessionEventTemplate]
  ] as const)(
    "a %s lifecycle terminal closes the relay: readers end after it and further appends raise agent_session_already_terminal",
    async (kind, terminal) => {
      const relay = createRelay();
      relay.append(output("work"));
      relay.append(terminal);

      expect(relay.state).toBe("terminal");
      const events = await collect(relay.read({ after: 0 }));
      expect(events.map((event) => event.type)).toEqual(["output", kind]);

      expectRuntimeFailure(
        () => relay.append(output("too late")),
        "agent_session_already_terminal"
      );
      expect(relay.lastSequence).toBe(2);
    }
  );

  it("interrupted ends readers without a lifecycle terminal and refuses further appends with agent_session_interrupted (rejects treating interrupted as a plain terminal)", async () => {
    const relay = createRelay();
    relay.append(output("work"));
    relay.append(interrupted);

    expect(relay.state).toBe("interrupted");

    const events = await collect(relay.read({ after: 0 }));
    // Positive companion: the stream carries the work and the interruption...
    expect(events.map((event) => event.type)).toEqual(["output", "interrupted"]);
    // ...and the negative: no lifecycle terminal was fabricated after it.
    const lifecycleTerminals = events.filter(
      (event) => event.type === "completed" || event.type === "failed" || event.type === "cancelled"
    );
    expect(lifecycleTerminals).toEqual([]);

    expectRuntimeFailure(
      () => relay.append(output("after interrupt")),
      "agent_session_interrupted"
    );
  });

  it("two concurrent readers observe identical sequences", async () => {
    const relay = createRelay();
    const firstReader = collect(relay.read({ after: 0 }));
    const secondReader = collect(relay.read({ after: 0 }));

    relay.append(output("one"));
    relay.append(output("two"));
    relay.append(completed);

    const [first, second] = await Promise.all([firstReader, secondReader]);
    expect(first.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(second.map((event) => event.sequence)).toEqual(first.map((event) => event.sequence));
  });

  it("close() is idempotent, ends open readers, and further appends raise agent_session_disposed", async () => {
    const relay = createRelay();
    relay.append(output("kept"));
    const reader = collect(relay.read({ after: 0 }));

    relay.close();
    relay.close();

    expect(relay.state).toBe("closed");
    const events = await reader;
    expect(events.map((event) => event.sequence)).toEqual([1]);

    expectRuntimeFailure(() => relay.append(output("after close")), "agent_session_disposed");
  });

  it(
    "refuses the append that would exceed the 10_000 event bound with agent_session_stream_overflow (rejects an implementation that silently drops evidence)",
    { timeout: 60_000 },
    () => {
      const relay = createRelay();
      for (let index = 0; index < 10_000; index += 1) {
        relay.append(output("x"));
      }
      expect(relay.lastSequence).toBe(10_000);

      expectRuntimeFailure(() => relay.append(output("overflow")), "agent_session_stream_overflow");
      // Positive companion: the buffer kept everything it accepted.
      expect(relay.lastSequence).toBe(10_000);
    }
  );
});

describe("AGENT_RUNTIME_FAILURES", () => {
  it("carries exactly this task's codes in a frozen table", () => {
    expect(Object.isFrozen(AGENT_RUNTIME_FAILURES)).toBe(true);
    expect(Object.keys(AGENT_RUNTIME_FAILURES).sort()).toEqual([
      "agent_harness_already_registered",
      "agent_harness_capability_mismatch",
      "agent_harness_not_registered",
      "agent_harness_probe_failed",
      "agent_session_already_terminal",
      "agent_session_disposed",
      "agent_session_interrupted",
      "agent_session_stream_overflow"
    ]);
  });

  it("pins the retryable split: only the re-runnable probe failure invites a retry", () => {
    // Rejects an implementation that defaults every entry to one retryable value: the probe is
    // environmental and re-runnable (a workbench refresh IS the retry), while the three
    // registration failures and the four session failures are deterministic.
    expect(AGENT_RUNTIME_FAILURES.agent_harness_probe_failed.retryable).toBe(true);
    const deterministic = Object.entries(AGENT_RUNTIME_FAILURES)
      .filter(([code]) => code !== "agent_harness_probe_failed")
      .map(([, entry]) => entry.retryable);
    expect(deterministic).toHaveLength(7);
    expect(deterministic.every((retryable) => retryable === false)).toBe(true);
  });

  it("every code parses under WorkflowFailureCodeSchema and lifts into WorkflowFailureSchema", () => {
    for (const [code, entry] of Object.entries(AGENT_RUNTIME_FAILURES)) {
      expect(WorkflowFailureCodeSchema.parse(code)).toBe(code);
      const lifted = WorkflowFailureSchema.parse({
        code,
        name: "AgentRuntimeError",
        message: entry.message,
        retryable: entry.retryable
      });
      expect(lifted.code).toBe(code);
      // The message must explain the failure, never merely restate the code.
      expect(entry.message).not.toBe(code);
    }
  });

  it("constructs AgentRuntimeError from the table with a non-enumerable cause", () => {
    const cause = new Error("underlying transport failure");
    const error = new AgentRuntimeError("agent_session_stream_overflow", cause);

    expect(error.name).toBe("AgentRuntimeError");
    expect(error.code).toBe("agent_session_stream_overflow");
    expect(error.message).toBe(AGENT_RUNTIME_FAILURES.agent_session_stream_overflow.message);
    expect(error.retryable).toBe(AGENT_RUNTIME_FAILURES.agent_session_stream_overflow.retryable);
    expect(error.cause).toBe(cause);
    // `cause` must not leak through enumeration (e.g. JSON.stringify of the error).
    expect(Object.prototype.propertyIsEnumerable.call(error, "cause")).toBe(false);
  });
});
