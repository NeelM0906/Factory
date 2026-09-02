import { describe, expect, it } from "vitest";

import type { AgentCancelRequest } from "@autostack/contracts";

import {
  createAgentSessionSupervisor,
  type AgentSessionSupervisorDeps
} from "../src/session-supervisor.js";

import {
  buildFakeHarness,
  buildInvocation,
  buildRegistryWith,
  collect,
  countByType,
  createClock,
  createManualSleep,
  createRecordingPersist,
  digestOf,
  lifecycleTerminals,
  shapeHarnessStream,
  waitUntil
} from "./fixtures/supervision-fixture.js";

const immediateSleep = async (_ms: number): Promise<void> => undefined;

const buildDeps = (
  overrides: Partial<AgentSessionSupervisorDeps> & Pick<AgentSessionSupervisorDeps, "registry">
): AgentSessionSupervisorDeps => ({
  now: createClock(),
  persist: createRecordingPersist().persist,
  cancellationGraceMs: 500,
  sleep: immediateSleep,
  ...overrides
});

describe("session cancellation", () => {
  it("cancel(reason) reaches harness.cancel and relays the adapter's own cancelled terminal within the grace budget (rejects a supervisor that always waits out the full grace before concluding)", async () => {
    const fake = buildFakeHarness("adapter.cancel-graceful", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "partial work" } },
      { kind: "await_steer", reason: "blocked on the operator" }
    ]);
    const cancelRequests: AgentCancelRequest[] = [];
    const harness = shapeHarnessStream(fake, {
      onCancel: (request) => cancelRequests.push(request)
    });
    // The manual sleep is NEVER released: a supervisor that awaits the full grace budget before
    // honouring the adapter's own cancelled event would hang here and time the test out.
    const manual = createManualSleep();
    const supervisor = createAgentSessionSupervisor(
      buildDeps({ registry: buildRegistryWith(harness), sleep: manual.sleep })
    );
    const invocation = buildInvocation("adapter.cancel-graceful", 201);
    const handle = supervisor.supervise(invocation);

    await waitUntil(
      () => handle.snapshot().lastSequence === 3,
      "the pre-cancel events are pumped into the relay"
    );

    await handle.cancel("operator asked to stop");

    // The cancellation crossed the port boundary carrying the session and the reason.
    expect(cancelRequests).toHaveLength(1);
    expect(cancelRequests[0]?.sessionId).toBe(invocation.agentSessionId);
    expect(cancelRequests[0]?.reason).toBe("operator asked to stop");

    const events = await collect(handle.events);
    // Positive companion: the pre-cancel work was relayed, then the adapter's cancelled terminal.
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "output",
      "waiting",
      "cancelled"
    ]);
    expect(countByType(events, "cancelled")).toBe(1);
    expect(handle.snapshot().state).toBe("cancelled");
  });

  it("stops after exactly cancellationGraceMs via the injected sleep when the adapter never emits a terminal, appending its own cancelled event (rejects a hard-coded or unbounded wait and a supervisor stuck on a hanging adapter stream)", async () => {
    const fake = buildFakeHarness("adapter.cancel-hangs", [
      { kind: "emit", event: { type: "started" } },
      { kind: "await_steer", reason: "will hang through cancellation" }
    ]);
    // The wrapper swallows the fake's post-cancel cancelled event and then never ends: an adapter
    // that acknowledges nothing.
    const harness = shapeHarnessStream(fake, {
      drop: (event) => event.type === "cancelled",
      hangWhenStreamEnds: true
    });
    const manual = createManualSleep();
    const supervisor = createAgentSessionSupervisor(
      buildDeps({
        registry: buildRegistryWith(harness),
        // Deliberately not a round default: a supervisor sleeping a hard-coded 500 fails here.
        cancellationGraceMs: 750,
        sleep: manual.sleep
      })
    );
    const handle = supervisor.supervise(buildInvocation("adapter.cancel-hangs", 202));

    await waitUntil(
      () => handle.snapshot().lastSequence === 2,
      "the started and waiting events are pumped into the relay"
    );

    const cancelling = handle.cancel("adapter is stuck");
    await waitUntil(() => manual.calls.length === 1, "the grace wait reaches the injected sleep");
    // The bounded wait is EXACTLY the configured budget, measured via the injected sleep.
    expect(manual.requestedMs).toEqual([750]);
    // Nothing terminal has been appended while the grace budget is still running.
    expect(handle.snapshot().lastSequence).toBe(2);

    const firstCall = manual.calls[0];
    if (firstCall === undefined) throw new TypeError("unreachable");
    firstCall.release();
    await cancelling;

    // The reader completes even though the adapter stream never ends: the supervisor detached
    // from the hanging registration and closed the session itself.
    const events = await collect(handle.events);
    expect(events.map((event) => event.type)).toEqual(["started", "waiting", "cancelled"]);
    expect(countByType(events, "cancelled")).toBe(1);
    expect(handle.snapshot()).toEqual({ state: "cancelled", lastSequence: 3 });
    // No second grace wait was ever requested.
    expect(manual.requestedMs).toEqual([750]);
  });

  it("treats cancellation after a terminal as a no-op that neither throws nor appends a second terminal (rejects a supervisor that lets a late cancel corrupt a finished session)", async () => {
    const fake = buildFakeHarness("adapter.cancel-late", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "completed", evidenceDigests: [digestOf("a")] } }
    ]);
    const supervisor = createAgentSessionSupervisor(
      buildDeps({ registry: buildRegistryWith(fake) })
    );
    const handle = supervisor.supervise(buildInvocation("adapter.cancel-late", 203));

    await waitUntil(() => handle.snapshot().state === "completed", "the session completes");

    // Neither throws nor changes the outcome.
    await handle.cancel("too late to matter");

    const events = await collect(handle.events);
    // Positive companion: the completed terminal is intact and unique.
    expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
    expect(lifecycleTerminals(events)).toHaveLength(1);
    expect(countByType(events, "cancelled")).toBe(0);
    expect(handle.snapshot()).toEqual({ state: "completed", lastSequence: 2 });
  });

  it("drops a completed event that arrives after cancellation was issued so a cancelled session never ends in the success shape (rejects a supervisor that keeps relaying blindly once cancel is in flight)", async () => {
    const fake = buildFakeHarness("adapter.cancel-then-completed", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "work before cancel" } },
      { kind: "await_steer", reason: "blocked until cancelled" }
    ]);
    // After cancel the fake yields its cancelled event; the wrapper reshapes it into a completed
    // terminal, modelling an adapter that races a success report against the cancellation.
    const harness = shapeHarnessStream(fake, {
      reshape: (event) =>
        event.type === "cancelled"
          ? {
              schemaVersion: event.schemaVersion,
              sessionId: event.sessionId,
              sequence: event.sequence,
              occurredAt: event.occurredAt,
              type: "completed",
              evidenceDigests: [digestOf("f")]
            }
          : event
    });
    const supervisor = createAgentSessionSupervisor(
      buildDeps({ registry: buildRegistryWith(harness) })
    );
    const handle = supervisor.supervise(buildInvocation("adapter.cancel-then-completed", 204));

    await waitUntil(
      () => handle.snapshot().lastSequence === 3,
      "the pre-cancel events are pumped into the relay"
    );
    await handle.cancel("stop before the fake success lands");

    const events = await collect(handle.events);
    // Positive companion: everything relayed before the cancellation is preserved.
    expect(events.slice(0, 3).map((event) => event.type)).toEqual(["started", "output", "waiting"]);
    // The post-cancel completed was dropped, and the session ended in the cancelled shape.
    expect(countByType(events, "completed")).toBe(0);
    expect(events.at(-1)?.type).toBe("cancelled");
    expect(lifecycleTerminals(events)).toHaveLength(1);
    expect(handle.snapshot().state).toBe("cancelled");
    expect(handle.snapshot().state).not.toBe("completed");
  });
});
