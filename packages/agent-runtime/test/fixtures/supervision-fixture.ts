import { expect } from "vitest";

import {
  AgentInvocationRequestSchema,
  AgentSteerRequestSchema,
  type AgentCancelRequest,
  type AgentHarnessPort,
  type AgentHarnessProfile,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type AgentSteerRequest
} from "@autostack/contracts";

import {
  createFakeAgentHarness,
  type FakeAgentHarness,
  type FakeHarnessScript
} from "@autostack/domain/testing";

import { AgentRuntimeError } from "../../src/errors.js";
import type { AgentHarnessAvailabilityFacts } from "../../src/harness-availability.js";
import {
  createAgentHarnessRegistry,
  type AgentHarnessRegistry
} from "../../src/harness-registry.js";

export const digestOf = (character: string): string => character.repeat(64);

/** One tick per call so `occurredAt` stamps are distinct and ordered. */
export const createClock = (): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 31, 12, 0, 0, tick)).toISOString();
  };
};

const uuidAt = (salt: number): string =>
  `00000000-0000-4000-8000-${salt.toString(16).padStart(12, "0")}`;

/** Every id the invocation needs, derived from one salt so tests never collide on a session. */
export const buildInvocation = (adapterId: string, salt: number): AgentInvocationRequest =>
  AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `supervision:${salt}:start`,
    workspaceId: `ws_${uuidAt(salt)}`,
    runId: `run_${uuidAt(salt)}`,
    stageRunId: `stage_${uuidAt(salt)}`,
    agentSessionId: `agt_${uuidAt(salt)}`,
    adapterId,
    objective: "Exercise the session supervisor against the reference fake harness.",
    cwd: "/workspace/factory",
    inputEvidenceDigests: [digestOf("0")]
  });

export const buildSteer = (
  invocation: AgentInvocationRequest,
  instruction: string
): AgentSteerRequest =>
  AgentSteerRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `supervision:${invocation.agentSessionId}:steer`,
    sessionId: invocation.agentSessionId,
    instruction,
    evidenceDigest: digestOf("e")
  });

/**
 * The reference fake, built WITHOUT the permission capability: the stream-shaping wrappers below
 * present a bare `AgentHarnessPort` (no `respondToPermission`), and the registry rejects a
 * permissions-declaring descriptor whose surface lacks the responder. None of these scripts open a
 * permission round trip, so nothing is lost.
 */
export const buildFakeHarness = (adapterId: string, script: FakeHarnessScript): FakeAgentHarness =>
  createFakeAgentHarness({
    script,
    now: createClock(),
    providerSessionRef: () => "provider.session.fake",
    descriptor: { adapterId, capabilities: { permissions: false } }
  });

/**
 * Reshapes a harness's event stream on the way out. `createFakeAgentHarness` always stamps clean
 * monotonically increasing sequences and schema-valid payloads, so a misnumbered or invalid
 * adapter cannot be scripted — it is built by wrapping the fake's stream and reshaping each event
 * after the fake has produced it. The wrapper stays a plain `AgentHarnessPort`.
 */
export interface HarnessStreamShaping {
  readonly reshape?: (event: AgentSessionStreamEvent, index: number) => AgentSessionStreamEvent;
  readonly drop?: (event: AgentSessionStreamEvent) => boolean;
  /** After the inner stream ends, never end: models an adapter that hangs instead of terminating. */
  readonly hangWhenStreamEnds?: boolean;
  readonly onCancel?: (request: AgentCancelRequest) => void;
}

export const shapeHarnessStream = (
  inner: AgentHarnessPort,
  shaping: HarnessStreamShaping
): AgentHarnessPort => {
  const shape = (
    source: AsyncIterable<AgentSessionStreamEvent>
  ): AsyncIterable<AgentSessionStreamEvent> =>
    (async function* () {
      let index = 0;
      for await (const event of source) {
        const reshaped = shaping.reshape?.(event, index) ?? event;
        index += 1;
        if (shaping.drop?.(reshaped) === true) continue;
        yield reshaped;
      }
      if (shaping.hangWhenStreamEnds === true) {
        await new Promise<never>(() => undefined);
      }
    })();

  return {
    descriptor: inner.descriptor,
    start: (request) => shape(inner.start(request)),
    resume: (request) => shape(inner.resume(request)),
    steer: (request) => inner.steer(request),
    cancel: async (request) => {
      shaping.onCancel?.(request);
      await inner.cancel(request);
    }
  };
};

/** Generic sequence override that keeps the event's own discriminated member type. */
export const withSequence = <Event extends AgentSessionStreamEvent>(
  event: Event,
  sequence: number
): Event => Object.assign({}, event, { sequence });

const selection: AgentHarnessProfile["selection"] = {
  modelSelection: true,
  reasoningSelection: false,
  permissionModes: []
};

const availableFacts: AgentHarnessAvailabilityFacts = { installed: true, authenticated: true };

export const buildRegistryWith = (
  ...harnesses: readonly AgentHarnessPort[]
): AgentHarnessRegistry => {
  const registry = createAgentHarnessRegistry({
    now: createClock(),
    probeTimeout: () => new Promise<void>(() => undefined)
  });
  for (const harness of harnesses) {
    registry.register({ harness, selection, probe: async () => availableFacts });
  }
  return registry;
};

/** A persist sink that records every batch; resolves immediately. */
export interface RecordingPersist {
  readonly batches: readonly (readonly AgentSessionStreamEvent[])[];
  persist(events: readonly AgentSessionStreamEvent[]): Promise<void>;
}

export const createRecordingPersist = (options?: {
  readonly rejectWhen?: (batch: readonly AgentSessionStreamEvent[]) => boolean;
}): RecordingPersist => {
  const batches: (readonly AgentSessionStreamEvent[])[] = [];
  return {
    get batches() {
      return [...batches];
    },
    persist: async (events) => {
      if (options?.rejectWhen?.(events) === true) {
        throw new Error("The durable sink refused this batch.");
      }
      batches.push([...events]);
    }
  };
};

/** A persist sink whose every call blocks until the test releases it, in call order. */
export interface GatedPersist {
  readonly gates: readonly {
    readonly batch: readonly AgentSessionStreamEvent[];
    release(): void;
  }[];
  persist(events: readonly AgentSessionStreamEvent[]): Promise<void>;
}

export const createGatedPersist = (): GatedPersist => {
  const gates: { batch: readonly AgentSessionStreamEvent[]; release(): void }[] = [];
  return {
    get gates() {
      return [...gates];
    },
    persist: (events) =>
      new Promise<void>((resolve) => {
        gates.push({ batch: [...events], release: resolve });
      })
  };
};

/** An injected sleep that records the requested budgets and resolves only when released. */
export interface ManualSleep {
  readonly calls: readonly { readonly ms: number; release(): void }[];
  readonly requestedMs: readonly number[];
  sleep(ms: number): Promise<void>;
}

export const createManualSleep = (): ManualSleep => {
  const calls: { ms: number; release(): void }[] = [];
  return {
    get calls() {
      return [...calls];
    },
    get requestedMs() {
      return calls.map((call) => call.ms);
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        calls.push({ ms, release: resolve });
      })
  };
};

export const flattenBatches = (
  batches: readonly (readonly AgentSessionStreamEvent[])[]
): readonly AgentSessionStreamEvent[] => batches.flat();

export const collect = async (
  stream: AsyncIterable<AgentSessionStreamEvent>
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

export const countByType = (
  events: readonly AgentSessionStreamEvent[],
  type: AgentSessionStreamEvent["type"]
): number => events.filter((event) => event.type === type).length;

export const lifecycleTerminals = (
  events: readonly AgentSessionStreamEvent[]
): readonly AgentSessionStreamEvent[] =>
  events.filter(
    (event) => event.type === "completed" || event.type === "failed" || event.type === "cancelled"
  );

/** Waits for an observable condition through the real microtask/macrotask queue, bounded. */
export const waitUntil = async (satisfied: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (satisfied()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error(`Timed out waiting until ${what}.`);
};

/** Resolves "pending" when the probe has not settled within one short real-timer window. */
export const settleState = async (probe: Promise<unknown>): Promise<"settled" | "pending"> =>
  Promise.race([
    probe.then(
      () => "settled" as const,
      () => "settled" as const
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 10);
    })
  ]);

export const expectRuntimeFailure = (run: () => unknown, code: string): AgentRuntimeError => {
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
