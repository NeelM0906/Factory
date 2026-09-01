import { describe, expect, it } from "vitest";

import { AgentSessionDetailEventSchema, digestVersionedValue } from "@autostack/contracts";

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
  createRecordingPersist,
  digestOf,
  flattenBatches,
  lifecycleTerminals,
  waitUntil
} from "./fixtures/supervision-fixture.js";

/**
 * Mirrors `packages/agent-native/src/native-session.ts`: the supervisor's synthesized interruption
 * must digest the partial transcript under the SAME domain with the SAME projection shape, so the
 * two interruption owners agree on what the evidence of a lost session looks like.
 */
const TRANSCRIPT_DIGEST_DOMAIN = "autostack.agent-session-transcript";

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

const deferred = (): { readonly promise: Promise<void>; resolve(): void } => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Lets every queued microtask and timer turn drain so an absent event stays provably absent. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

describe("session interruption", () => {
  it("relays an adapter-emitted interrupted unchanged as the single owner of the interruption (rejects a supervisor that synthesizes a second interrupted or fabricates a lifecycle terminal on top of the adapter's own)", async () => {
    const scriptedDigest = digestOf("1");
    const fake = buildFakeHarness("adapter.interrupted-owned", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "partial evidence" } },
      {
        kind: "emit",
        event: {
          type: "interrupted",
          reason: "The provider connection dropped.",
          retryable: true,
          evidenceDigests: [scriptedDigest]
        }
      }
    ]);
    const recording = createRecordingPersist();
    const supervisor = createAgentSessionSupervisor(
      buildDeps({ registry: buildRegistryWith(fake), persist: recording.persist })
    );
    const invocation = buildInvocation("adapter.interrupted-owned", 301);
    const handle = supervisor.supervise(invocation);

    const events = await collect(handle.events);

    // Mirrors the conformance evidence suite: exactly one interruption, schema-parseable, last in
    // the stream, with readable evidence before it and NO lifecycle terminal after it.
    const interruptions = events.filter((event) => event.type === "interrupted");
    expect(interruptions).toHaveLength(1);
    const interrupted = interruptions[0];
    if (interrupted?.type !== "interrupted") throw new TypeError("unreachable");
    expect(AgentSessionDetailEventSchema.parse(interrupted)).toEqual(interrupted);
    expect(events.at(-1)).toBe(interrupted);
    expect(lifecycleTerminals(events)).toHaveLength(0);

    const before = events.slice(0, events.indexOf(interrupted));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((event) => event.sessionId === invocation.agentSessionId)).toBe(true);

    // Relayed unchanged: the supervisor added nothing to the adapter's own interruption payload.
    expect(interrupted.reason).toBe("The provider connection dropped.");
    expect(interrupted.retryable).toBe(true);
    expect(interrupted.evidenceDigests).toEqual([scriptedDigest]);

    expect(handle.snapshot().state).toBe("interrupted");
    // The durable sink received the interruption, exactly once.
    const persisted = flattenBatches(recording.batches);
    expect(persisted).toContainEqual(interrupted);
    expect(countByType(persisted, "interrupted")).toBe(1);
  });

  it("synthesizes exactly one interrupted carrying the partial-transcript digest when the stream ends with neither a terminal nor an interruption (rejects a supervisor that lets a silent stream end look like clean completion or emits an evidence-free interruption)", async () => {
    const fake = buildFakeHarness("adapter.silent-end", [
      { kind: "emit", event: { type: "started" } },
      { kind: "emit", event: { type: "output", stream: "stdout", text: "work before the loss" } }
    ]);
    const recording = createRecordingPersist();
    const supervisor = createAgentSessionSupervisor(
      buildDeps({ registry: buildRegistryWith(fake), persist: recording.persist })
    );
    const invocation = buildInvocation("adapter.silent-end", 302);
    const handle = supervisor.supervise(invocation);

    const events = await collect(handle.events);

    // Positive companion: the partial work was relayed before the synthesized interruption.
    expect(events.map((event) => event.type)).toEqual(["started", "output", "interrupted"]);
    expect(countByType(events, "interrupted")).toBe(1);
    // The stream ends with NO lifecycle terminal: interruption is its own outcome (spec section 15).
    expect(lifecycleTerminals(events)).toHaveLength(0);

    const interrupted = events.at(-1);
    if (interrupted?.type !== "interrupted") throw new TypeError("unreachable");
    expect(interrupted.evidenceDigests.length).toBeGreaterThan(0);

    // The evidence includes the digest of the partial transcript, computed under the SAME domain
    // and projection shape as the native harness's own interruption evidence.
    const transcriptDigest = await digestVersionedValue(TRANSCRIPT_DIGEST_DOMAIN, {
      sessionId: invocation.agentSessionId,
      events: events.slice(0, -1)
    });
    expect(interrupted.evidenceDigests).toContain(transcriptDigest);

    expect(handle.snapshot().state).toBe("interrupted");
    const persisted = flattenBatches(recording.batches);
    expect(persisted).toContainEqual(interrupted);
    expect(countByType(persisted, "interrupted")).toBe(1);
  });

  it("adds nothing when host loss resolves after the adapter already emitted interrupted (rejects double ownership: supervisor and adapter each marking the same loss)", async () => {
    const hostLoss = deferred();
    const fake = buildFakeHarness("adapter.interrupted-then-host-loss", [
      { kind: "emit", event: { type: "started" } },
      {
        kind: "emit",
        event: {
          type: "interrupted",
          reason: "The provider connection dropped.",
          retryable: true,
          evidenceDigests: [digestOf("2")]
        }
      }
    ]);
    const supervisor = createAgentSessionSupervisor(
      buildDeps({ registry: buildRegistryWith(fake), hostLoss: hostLoss.promise })
    );
    const handle = supervisor.supervise(buildInvocation("adapter.interrupted-then-host-loss", 303));

    await waitUntil(
      () => handle.snapshot().state === "interrupted",
      "the adapter's interruption is relayed"
    );
    const sequenceAtInterruption = handle.snapshot().lastSequence;

    hostLoss.resolve();
    await settle();

    const events = await collect(handle.events);
    // Exactly one interruption — counted, which is the check that catches double-ownership drift.
    expect(countByType(events, "interrupted")).toBe(1);
    expect(lifecycleTerminals(events)).toHaveLength(0);
    expect(handle.snapshot()).toEqual({
      state: "interrupted",
      lastSequence: sequenceAtInterruption
    });
  });

  it("synthesizes once on host loss and adds nothing when host loss resolves again or the stream ends afterwards (rejects a supervisor that re-marks an already-interrupted session)", async () => {
    const hostLoss = deferred();
    const fake = buildFakeHarness("adapter.host-loss-idempotent", [
      { kind: "emit", event: { type: "started" } },
      { kind: "await_steer", reason: "hangs until the host is lost" }
    ]);
    const recording = createRecordingPersist();
    const supervisor = createAgentSessionSupervisor(
      buildDeps({
        registry: buildRegistryWith(fake),
        persist: recording.persist,
        hostLoss: hostLoss.promise
      })
    );
    const handle = supervisor.supervise(buildInvocation("adapter.host-loss-idempotent", 304));

    await waitUntil(
      () => handle.snapshot().lastSequence === 2,
      "the started and waiting events are pumped into the relay"
    );

    // Host loss while the adapter stream is still open: the supervisor owns the interruption.
    hostLoss.resolve();
    await waitUntil(
      () => handle.snapshot().state === "interrupted",
      "the synthesized interruption lands"
    );
    const sequenceAtInterruption = handle.snapshot().lastSequence;

    // Resolving host loss again adds nothing...
    hostLoss.resolve();
    await settle();
    // ...and neither does the adapter stream ending after the synthesized interruption.
    await fake.dispose();
    await settle();

    const events = await collect(handle.events);
    // Positive companion: the interruption exists exactly once, carrying evidence.
    expect(countByType(events, "interrupted")).toBe(1);
    const interrupted = events.at(-1);
    if (interrupted?.type !== "interrupted") throw new TypeError("unreachable");
    expect(interrupted.evidenceDigests.length).toBeGreaterThan(0);
    // Negative: no duplicate interruption and no lifecycle terminal was fabricated afterwards.
    expect(lifecycleTerminals(events)).toHaveLength(0);
    expect(handle.snapshot()).toEqual({
      state: "interrupted",
      lastSequence: sequenceAtInterruption
    });

    // The durable sink received the synthesized interruption, exactly once.
    const persisted = flattenBatches(recording.batches);
    expect(persisted).toContainEqual(interrupted);
    expect(countByType(persisted, "interrupted")).toBe(1);
  });
});
