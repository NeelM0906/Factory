import { describe, expect, it } from "vitest";

import type { AgentHarnessPort, AgentInvocationRequest } from "@autostack/contracts";

import {
  createAgentSessionSupervisor,
  type AgentSessionSupervisionHandle,
  type AgentSessionSupervisor,
  type AgentSessionSupervisorDeps
} from "../src/session-supervisor.js";
import { deriveSessionSnapshot } from "../src/session-snapshot.js";

import {
  buildFakeHarness,
  buildInvocation,
  buildRegistryWith,
  buildSteer,
  collect,
  countByType,
  createClock,
  createGatedPersist,
  createRecordingPersist,
  digestOf,
  expectRuntimeFailure,
  flattenBatches,
  lifecycleTerminals,
  settleState,
  shapeHarnessStream,
  waitUntil,
  withSequence
} from "./fixtures/supervision-fixture.js";

const immediateSleep = async (_ms: number): Promise<void> => undefined;

interface SupervisedWorld {
  readonly supervisor: AgentSessionSupervisor;
  readonly invocation: AgentInvocationRequest;
  readonly handle: AgentSessionSupervisionHandle;
}

const supervise = (
  harness: AgentHarnessPort,
  salt: number,
  overrides?: Partial<AgentSessionSupervisorDeps>
): SupervisedWorld => {
  const deps: AgentSessionSupervisorDeps = {
    registry: buildRegistryWith(harness),
    now: createClock(),
    persist: createRecordingPersist().persist,
    cancellationGraceMs: 500,
    sleep: immediateSleep,
    ...overrides
  };
  const supervisor = createAgentSessionSupervisor(deps);
  const invocation = buildInvocation(harness.descriptor.adapterId, salt);
  return { supervisor, invocation, handle: supervisor.supervise(invocation) };
};

describe("deriveSessionSnapshot", () => {
  it("fails closed to interrupted, never completed, for an ended session with no terminal memo (rejects a snapshot defaulting the missing memo to success — unreachable through the supervisor's own flows, so pinned at the unit)", () => {
    // Supervisor invariants keep the memo set before the relay leaves "open"; this pins the pure
    // function's default for any future caller that cannot prove that invariant.
    expect(deriveSessionSnapshot({ state: "closed", lastSequence: 4 }, undefined)).toEqual({
      state: "interrupted",
      lastSequence: 4
    });
    expect(deriveSessionSnapshot({ state: "terminal", lastSequence: 4 }, undefined).state).not.toBe(
      "completed"
    );
    // Positive companion: with the memo present the terminal kind is reported faithfully.
    expect(deriveSessionSnapshot({ state: "terminal", lastSequence: 4 }, "completed")).toEqual({
      state: "completed",
      lastSequence: 4
    });
  });
});

describe("createAgentSessionSupervisor", () => {
  it("relays every adapter event and terminates an invalid one as failed with agent_event_invalid before it reaches a reader (rejects a supervisor that trusts adapter output and forwards events without re-validating them through AgentSessionStreamEventSchema)", async () => {
    // The fake only produces schema-valid events, so the invalid adapter is built by wrapping the
    // fake's stream: the third event is reshaped into an empty output text, which is type-valid in
    // TypeScript but violates SafeMetadataStringSchema's min(1) at parse time.
    const fake = buildFakeHarness("adapter.invalid-event", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "healthy output" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "will be corrupted" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "after the poison" } }
    ]);
    const harness = shapeHarnessStream(fake, {
      reshape: (event, index) =>
        event.type === "output" && index === 2 ? { ...event, text: "" } : event
    });

    const { handle } = supervise(harness, 101);
    const events = await collect(handle.events);

    // Positive companion: every valid event before the poison was relayed in order.
    expect(events.map((event) => event.type)).toEqual(["started", "output", "failed"]);
    const healthy = events[1];
    if (healthy?.type !== "output") throw new TypeError("unreachable");
    expect(healthy.text).toBe("healthy output");

    // The invalid event never reaches a reader, and nothing after it does either.
    expect(events.some((event) => event.type === "output" && event.text === "")).toBe(false);
    expect(
      events.some((event) => event.type === "output" && event.text === "after the poison")
    ).toBe(false);

    const terminal = events.at(-1);
    if (terminal?.type !== "failed") throw new TypeError("unreachable");
    expect(terminal.code).toBe("agent_event_invalid");
    expect(terminal.retryable).toBe(false);
    expect(handle.snapshot().state).toBe("failed");
  });

  it("re-stamps sequences strictly from 1 instead of trusting adapter numbering (rejects a supervisor that forwards an adapter's own sequence numbers, which the agent.session_event envelope coherence rule cannot tolerate)", async () => {
    const fake = buildFakeHarness("adapter.misnumbered", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "first" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "second" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("a")] } }
    ]);
    // The adapter numbers from 100 and skips values; the fake cannot script that, so the wrapper
    // re-stamps the fake's clean sequences on the way out and records what it actually emitted.
    const emittedSequences: number[] = [];
    const harness = shapeHarnessStream(fake, {
      reshape: (event, index) => {
        const misnumbered = withSequence(event, 100 + index * 3);
        emittedSequences.push(misnumbered.sequence);
        return misnumbered;
      }
    });

    const { handle } = supervise(harness, 102);
    const events = await collect(handle.events);

    // Positive companion: the adapter really did emit the hostile numbering...
    expect(emittedSequences).toEqual([100, 103, 106, 109]);
    // ...and the relayed stream is strictly 1, 2, 3, ... regardless.
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.type)).toEqual(["started", "output", "output", "completed"]);
    expect(handle.snapshot()).toEqual({ state: "completed", lastSequence: 4 });
  });

  it("persists each single-event batch before that event becomes visible to a reader (rejects a supervisor that appends first and persists as an afterthought)", async () => {
    const fake = buildFakeHarness("adapter.persist-first", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "durable" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("b")] } }
    ]);
    const gated = createGatedPersist();
    const { handle } = supervise(fake, 103, { persist: gated.persist });

    const iterator = handle.events[Symbol.asyncIterator]();
    const firstDelivery = iterator.next();

    await waitUntil(() => gated.gates.length >= 1, "the first batch reaches the durable sink");
    const firstGate = gated.gates[0];
    if (firstGate === undefined) throw new TypeError("unreachable");
    expect(firstGate.batch.map((event) => event.type)).toEqual(["started"]);
    // The reader must still be pending: the batch has not been durably accepted yet.
    expect(await settleState(firstDelivery)).toBe("pending");

    firstGate.release();
    const delivered = await firstDelivery;
    expect(delivered.done).toBe(false);
    if (delivered.done === true || delivered.value.type !== "started") {
      throw new TypeError("unreachable");
    }

    // Release every subsequent batch as it arrives and let the session finish.
    let released = 1;
    await waitUntil(() => {
      for (const gate of gated.gates.slice(released)) {
        gate.release();
        released += 1;
      }
      return handle.snapshot().state === "completed";
    }, "every batch is released and the session completes");

    // Success path: events persisted == events relayed, delivered as one-event batches in order.
    const events = await collect(handle.events);
    const batches = gated.gates.map((gate) => gate.batch);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
    expect(flattenBatches(batches)).toEqual(events);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("ends the session interrupted when persist rejects, preserving prior evidence and never reporting success (rejects a supervisor that swallows the sink failure and completes anyway)", async () => {
    const fake = buildFakeHarness("adapter.sink-failure", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "unpersistable" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "never seen" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("c")] } }
    ]);
    const recording = createRecordingPersist({
      rejectWhen: (batch) =>
        batch.some((event) => event.type === "output" && event.text === "unpersistable")
    });
    const { handle } = supervise(fake, 104, { persist: recording.persist });

    const events = await collect(handle.events);

    // Positive companion: everything durably accepted before the rejection stays visible.
    expect(events.map((event) => event.type)).toEqual(["started", "interrupted"]);
    // The rejected event never became visible, and neither did anything after it.
    expect(countByType(events, "output")).toBe(0);
    expect(countByType(events, "completed")).toBe(0);
    expect(lifecycleTerminals(events)).toEqual([]);

    const interrupted = events.at(-1);
    if (interrupted?.type !== "interrupted") throw new TypeError("unreachable");
    expect(interrupted.evidenceDigests.length).toBeGreaterThan(0);
    // The interruption itself reached the durable sink.
    expect(flattenBatches(recording.batches)).toContainEqual(interrupted);

    expect(handle.snapshot().state).toBe("interrupted");
    expect(handle.snapshot().state).not.toBe("completed");
  });

  it("snapshot() reports running mid-stream and completed after the terminal, pumping the adapter without any reader attached (rejects a lazy supervisor that only consumes the adapter when a reader pulls)", async () => {
    const fake = buildFakeHarness("adapter.snapshot", [
      { kind: "emit", event: { type: "started" } },
      { kind: "await_steer", reason: "holding for the operator" },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("d")] } }
    ]);
    const { handle, invocation } = supervise(fake, 105);

    // No reader is attached; the supervisor must be pumping on its own.
    await waitUntil(
      () => handle.snapshot().lastSequence === 2,
      "the started and waiting events are pumped without a reader"
    );
    expect(handle.snapshot()).toEqual({ state: "running", lastSequence: 2 });

    await fake.steer(buildSteer(invocation, "carry on"));
    await waitUntil(() => handle.snapshot().state === "completed", "the session completes");
    expect(handle.snapshot()).toEqual({ state: "completed", lastSequence: 3 });

    // A late reader replays the whole stream, and a second iteration replays it again.
    const events = await collect(handle.events);
    expect(events.map((event) => event.type)).toEqual(["started", "waiting", "completed"]);
    expect(await collect(handle.events)).toEqual(events);
  });

  it("snapshot() never reports completed for a session whose terminal was failed (rejects a snapshot that collapses every ended session into the success state)", async () => {
    const fake = buildFakeHarness("adapter.failed-terminal", [
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: {
          type: "failed",
          code: "provider_error",
          message: "The provider refused the request.",
          retryable: false
        }
      }
    ]);
    const { handle } = supervise(fake, 106);

    const events = await collect(handle.events);
    // Positive companion: the failed terminal itself was relayed.
    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
    expect(handle.snapshot().state).toBe("failed");
    expect(handle.snapshot().state).not.toBe("completed");
  });

  it("raises agent_session_already_supervised for a second supervise of the same agentSessionId (rejects a supervisor that leans on the adapter's own double-start refusal instead of guarding its own registry of live sessions)", async () => {
    const first = buildFakeHarness("adapter.supervised-once", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("a")] } }
    ]);
    const other = buildFakeHarness("adapter.supervised-other", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("b")] } }
    ]);
    const deps: AgentSessionSupervisorDeps = {
      registry: buildRegistryWith(first, other),
      now: createClock(),
      persist: createRecordingPersist().persist,
      cancellationGraceMs: 500,
      sleep: immediateSleep
    };
    const supervisor = createAgentSessionSupervisor(deps);
    const invocation = buildInvocation("adapter.supervised-once", 107);

    const handle = supervisor.supervise(invocation);
    expectRuntimeFailure(
      () => supervisor.supervise(invocation),
      "agent_session_already_supervised"
    );

    // Positive companions: the first supervision is unharmed, and a different session id under
    // the same supervisor is admitted.
    const otherHandle = supervisor.supervise(buildInvocation("adapter.supervised-other", 108));
    const [events, otherEvents] = await Promise.all([
      collect(handle.events),
      collect(otherHandle.events)
    ]);
    expect(events.at(-1)?.type).toBe("completed");
    expect(otherEvents.at(-1)?.type).toBe("completed");
  });
});
