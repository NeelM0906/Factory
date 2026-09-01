import { describe, expect, it } from "vitest";

import {
  AgentInvocationRequestSchema,
  ModelCatalogEntrySchema,
  ModelRouteSchema,
  createId,
  digestVersionedValue,
  type AgentHarnessPort,
  type AgentHarnessProfile,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type ModelInferencePort
} from "@autostack/contracts";
import {
  AgentRuntimeError,
  createAgentHarnessRegistry,
  createAgentSessionSupervisor,
  digestSessionTranscript,
  type AgentHarnessRegistration,
  type AgentHarnessRegistry,
  type AgentSessionSupervisorDeps
} from "@autostack/agent-runtime";
import {
  createFakeModelInference,
  createFakeModelRouter,
  type FakeModelInferenceOutcome,
  type FakeModelRouteDeclaration,
  type FakeModelRouterOutcome
} from "@autostack/domain/testing";

import type { NativeContextReader } from "../src/context-assembly.js";
import type { ContextScope } from "../src/context-scope.js";
import {
  createNativeHarness,
  type NativeAgentHarness,
  type NativeHarnessConfig
} from "../src/native-harness.js";

/**
 * Cross-package composition (plan Task 13): a REAL `createNativeHarness` registered in a REAL
 * `createAgentHarnessRegistry`, supervised by a REAL `createAgentSessionSupervisor`. The only
 * fakes are the leaves the plan allows: inference, router, reader, clocks, id factories, persist,
 * and sleep.
 */

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));
const ENVIRONMENT_ID = createId("environment", uuid(4));
const WORK_ITEM_ID = createId("workItem", uuid(5));
const CREDENTIAL_REF_ID = createId("credentialRef", uuid(6));

const IN_SCOPE_PATH = "docs/review-brief.md";
const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };
const CONTEXT_LIMITS = { maxFiles: 8, maxBytes: 65_536 } as const;
const REVIEW_BRIEF = "The checkout totals module rounds discounts before summing line items.";

const createWorkspaceReader = (): NativeContextReader => ({
  list: async () => [IN_SCOPE_PATH],
  read: async ({ path }) => {
    if (path !== IN_SCOPE_PATH) {
      throw new Error(`No workspace file exists at ${path}.`);
    }
    return REVIEW_BRIEF;
  }
});

const ROUTE_REF = "native.review.route";

const ROUTE_DECLARATION: FakeModelRouteDeclaration = {
  route: ModelRouteSchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    displayName: "Fake review route",
    transport: {
      kind: "vercel_ai_gateway",
      gatewayModel: "fake/review-model",
      credentialRefId: CREDENTIAL_REF_ID
    },
    enabled: true
  }),
  catalogEntry: ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    providerModel: "fake/review-model",
    displayName: "Fake review model",
    inputModalities: ["text"],
    outputModalities: ["text"],
    features: ["structured_output"],
    discoveredAt: "2026-08-26T00:00:00.000Z"
  })
};

const ROUTE_OUTCOME: FakeModelRouterOutcome = {
  kind: "selected",
  routeRef: ROUTE_REF,
  reason: "The only declared route offers every required capability."
};

/** The model-authored subset of `ReviewReportSchema` the review role's prompt asks for. */
const REVIEW_RESPONSE_CONTENT = JSON.stringify({
  verdict: "approved",
  summary: "The prepared change matches the approved plan and carries no blocking findings.",
  findings: []
});

const COMPLETED_OUTCOME: FakeModelInferenceOutcome = {
  kind: "completed",
  result: {
    content: REVIEW_RESPONSE_CONTENT,
    actual: { provider: "fake-provider", model: "fake/review-model" },
    tokens: {
      input: { state: "reported", value: 1_200 },
      output: { state: "reported", value: 340 },
      cachedInput: { state: "unknown" },
      reasoning: { state: "unknown" }
    },
    cost: { state: "unknown" },
    finishReason: "stop",
    latencyMs: 12
  }
};

/**
 * An inference port that accepts the call and never settles it — the session then leaves the
 * model wait only through cancellation or host loss.
 */
const createHangingInference = (onRun?: () => void): ModelInferencePort => ({
  run: () => {
    onRun?.();
    return new Promise(() => {
      // Never settles.
    });
  }
});

/** One ticking clock per lane; `at(tick)` reconstructs the stamp of the lane's nth call. */
interface TickClock {
  now(): string;
  at(tick: number): string;
}

let issuedLanes = 0;

const createTickClock = (): TickClock => {
  issuedLanes += 1;
  const lane = issuedLanes;
  let tick = 0;
  const at = (value: number): string =>
    new Date(Date.UTC(2026, 7, 30, 10, lane % 60, value % 60, value % 1_000)).toISOString();
  return {
    at,
    now: () => {
      tick += 1;
      return at(tick);
    }
  };
};

interface SubjectOptions {
  readonly inference: ModelInferencePort;
  readonly permissioned?: boolean;
  readonly hostLoss?: Promise<void>;
}

interface Subject {
  readonly adapterId: string;
  readonly harness: NativeAgentHarness;
  readonly invocation: AgentInvocationRequest;
  /** The clock the harness's OWN relay stamps with; `at` reconstructs its transcript stamps. */
  readonly harnessClock: TickClock;
}

let issuedSubjects = 0;

/** One REAL native harness plus the invocation that starts its session. */
const buildSubject = (options: SubjectOptions): Subject => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const adapterId = `native.composition.${subject}`;
  const harnessClock = createTickClock();
  let issuedRefs = 0;

  const config: NativeHarnessConfig = {
    adapterId,
    role: "review",
    session: { resumable: false, steerable: false, interactive: false },
    permissioned: options.permissioned ?? false,
    context: { paths: [IN_SCOPE_PATH], scope: DOCS_SCOPE, limits: CONTEXT_LIMITS }
  };

  const harness = createNativeHarness(config, {
    router: createFakeModelRouter({
      catalog: [ROUTE_DECLARATION],
      outcomes: [ROUTE_OUTCOME],
      now: createTickClock().now
    }),
    inference: options.inference,
    reader: createWorkspaceReader(),
    roleInputs: {
      forInvocation: async () => [
        {
          label: "prepared-change-summary",
          content: "The prepared change touches packages/checkout/src/totals.ts only."
        }
      ]
    },
    now: harnessClock.now,
    newProviderSessionRef: () => `native.session.${subject}`,
    newRef: () => {
      issuedRefs += 1;
      return `native.ref.${subject}.${issuedRefs}`;
    },
    structuredOutput: { maxRepairAttempts: 0 },
    ...(options.hostLoss === undefined ? {} : { hostLoss: options.hostLoss })
  });

  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `composition:${subject}:start`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workItemId: WORK_ITEM_ID,
    stageRunId: STAGE_RUN_ID,
    agentSessionId: createId("agentSession", uuid(1_000 + subject)),
    environmentId: ENVIRONMENT_ID,
    adapterId,
    objective: "Review the prepared fix for the discount rounding defect.",
    cwd: "/workspace/factory",
    inputEvidenceDigests: ["1".repeat(64)]
  });

  return { adapterId, harness, invocation, harnessClock };
};

const SELECTION: AgentHarnessProfile["selection"] = {
  modelSelection: true,
  reasoningSelection: false,
  permissionModes: []
};

const registrationOf = (
  harness: AgentHarnessRegistration["harness"],
  probe?: AgentHarnessRegistration["probe"]
): AgentHarnessRegistration => ({
  harness,
  selection: SELECTION,
  probe: probe ?? (async () => ({ installed: true, authenticated: true }))
});

const buildRegistryWith = (
  ...registrations: readonly AgentHarnessRegistration[]
): AgentHarnessRegistry => {
  const registry = createAgentHarnessRegistry({
    now: createTickClock().now,
    // A budget that never elapses: only a probe that answers on its own can ever win the race.
    probeTimeout: () => new Promise<void>(() => undefined)
  });
  for (const registration of registrations) {
    registry.register(registration);
  }
  return registry;
};

interface RecordingPersist {
  readonly batches: readonly (readonly AgentSessionStreamEvent[])[];
  persist(events: readonly AgentSessionStreamEvent[]): Promise<void>;
}

const createRecordingPersist = (): RecordingPersist => {
  const batches: (readonly AgentSessionStreamEvent[])[] = [];
  return {
    get batches() {
      return [...batches];
    },
    persist: async (events) => {
      batches.push([...events]);
    }
  };
};

/** An injected sleep that records the requested budgets and resolves only when released. */
interface ManualSleep {
  readonly requestedMs: readonly number[];
  sleep(ms: number): Promise<void>;
}

const createManualSleep = (): ManualSleep => {
  const requestedMs: number[] = [];
  return {
    get requestedMs() {
      return [...requestedMs];
    },
    sleep: (ms) =>
      new Promise<void>(() => {
        requestedMs.push(ms);
      })
  };
};

const immediateSleep = async (_ms: number): Promise<void> => undefined;

const buildSupervisorDeps = (
  registry: AgentHarnessRegistry,
  overrides?: Partial<AgentSessionSupervisorDeps>
): AgentSessionSupervisorDeps => ({
  registry,
  now: createTickClock().now,
  persist: createRecordingPersist().persist,
  cancellationGraceMs: 500,
  sleep: immediateSleep,
  ...overrides
});

const collect = async (
  stream: AsyncIterable<AgentSessionStreamEvent>
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

type StreamEventOf<Type extends AgentSessionStreamEvent["type"]> = Extract<
  AgentSessionStreamEvent,
  { type: Type }
>;

const eventsOfType = <Type extends AgentSessionStreamEvent["type"]>(
  events: readonly AgentSessionStreamEvent[],
  type: Type
): readonly StreamEventOf<Type>[] =>
  events.filter((event): event is StreamEventOf<Type> => event.type === type);

const lifecycleTerminals = (
  events: readonly AgentSessionStreamEvent[]
): readonly AgentSessionStreamEvent[] =>
  events.filter(
    (event) => event.type === "completed" || event.type === "failed" || event.type === "cancelled"
  );

/** Waits for an observable condition through the real timer queue, bounded. */
const waitUntil = async (satisfied: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (satisfied()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error(`Timed out waiting until ${what}.`);
};

/**
 * T6 placeholder-by-design (see `native-session.ts`): the completed terminal's evidence digest is
 * the admitted document digested under this INTERNAL domain. The test recomputes the SAME digest
 * so drift between the composed terminal and the harness's construction is caught; T8-T10 replace
 * both sides together with the per-role evidence digest functions.
 */
const NATIVE_STRUCTURED_OUTPUT_DIGEST_DOMAIN = "autostack.native-structured-output";

describe("runtime composition of the native harness, registry, and supervisor", () => {
  it("relays a completing native session to exactly one completed terminal whose evidence digests match the digest recomputed from the role's admitted document, with re-stamped sequences persisted event by event (rejects a supervisor that drops, duplicates, or re-derives the adapter's completion evidence, and one that appends without persisting)", async () => {
    const subject = buildSubject({
      inference: createFakeModelInference({
        outcomes: [COMPLETED_OUTCOME],
        now: createTickClock().now
      })
    });
    const persist = createRecordingPersist();
    const supervisor = createAgentSessionSupervisor(
      buildSupervisorDeps(buildRegistryWith(registrationOf(subject.harness)), {
        persist: persist.persist
      })
    );

    const handle = supervisor.supervise(subject.invocation);
    const events = await collect(handle.events);

    // Positive shape of the whole composed session: context reads under tool_call evidence, the
    // verbatim usage report, the echoed document, then the completion.
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "usage",
      "message",
      "completed"
    ]);
    expect(eventsOfType(events, "completed")).toHaveLength(1);
    expect(lifecycleTerminals(events)).toHaveLength(1);
    expect(eventsOfType(events, "interrupted")).toHaveLength(0);

    // The composed terminal's evidence digest is the digest the native harness produced for the
    // admitted document — recomputed here under the shared placeholder domain.
    const document: unknown = JSON.parse(REVIEW_RESPONSE_CONTENT);
    const expectedDigest = await digestVersionedValue(NATIVE_STRUCTURED_OUTPUT_DIGEST_DOMAIN, {
      role: "review",
      document
    });
    const completed = eventsOfType(events, "completed")[0];
    expect(completed?.evidenceDigests).toEqual([expectedDigest]);

    // The supervisor re-stamped identity and order: sequences are strictly 1..n on ITS stream.
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event) => event.sessionId === subject.invocation.agentSessionId)).toBe(
      true
    );

    // Persist-before-visibility: every relayed event reached the sink, as single-event batches,
    // and nothing was persisted that was not relayed.
    expect(persist.batches.every((batch) => batch.length === 1)).toBe(true);
    expect(persist.batches.flat()).toEqual(events);

    expect(handle.snapshot()).toEqual({ state: "completed", lastSequence: events.length });
  });

  it("relays a harness-marked host loss as exactly one interrupted whose digest the HARNESS computed over its own transcript (rejects a supervisor that synthesizes a second interruption on top of the adapter's own — the double-emit)", async () => {
    // Host loss is injected at the HARNESS: its own watcher marks the loss; the supervisor's
    // hostLoss dep is absent, so any interruption in the composed stream is the adapter's.
    let releaseHostLoss = (): void => undefined;
    const hostLoss = new Promise<void>((resolve) => {
      releaseHostLoss = resolve;
    });
    const subject = buildSubject({
      inference: createHangingInference(() => {
        releaseHostLoss();
      }),
      hostLoss
    });
    const supervisor = createAgentSessionSupervisor(
      buildSupervisorDeps(buildRegistryWith(registrationOf(subject.harness)))
    );

    const handle = supervisor.supervise(subject.invocation);
    const events = await collect(handle.events);

    // Positive companion: the pre-loss work crossed the boundary intact.
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "interrupted"
    ]);
    // The interruption crossed the boundary EXACTLY once, and no lifecycle terminal exists: an
    // interrupted session is neither completed, failed, nor cancelled.
    expect(eventsOfType(events, "interrupted")).toHaveLength(1);
    expect(lifecycleTerminals(events)).toHaveLength(0);
    expect(handle.snapshot()).toEqual({ state: "interrupted", lastSequence: events.length });

    const interrupted = eventsOfType(events, "interrupted")[0];
    expect(interrupted?.reason).toBe("The agent host was lost before the session finished.");
    // The digest is the HARNESS's, over the harness-stamped transcript. The supervisor re-stamps
    // occurredAt when relaying, so the harness's transcript is reconstructed by restoring the
    // harness clock's stamps (one tick per append) onto the relayed prefix. A supervisor that
    // replaced the adapter's interruption with its own synthesis would digest ITS prefix instead
    // and fail here.
    const harnessTranscript = events
      .slice(0, -1)
      .map((event, index) => ({ ...event, occurredAt: subject.harnessClock.at(index + 1) }));
    const expectedDigest = await digestSessionTranscript({
      sessionId: subject.invocation.agentSessionId,
      events: harnessTranscript
    });
    expect(interrupted?.evidenceDigests).toEqual([expectedDigest]);

    await subject.harness.dispose();
  });

  it("synthesizes exactly one supervisor-owned interrupted for a host loss the adapter never marked, digesting the relayed prefix (rejects a supervisor that stays silent, double-emits, or ends a lost session in a lifecycle terminal)", async () => {
    // Host loss is injected at the SUPERVISOR only: the harness's inference hangs and its stream
    // stays open with no terminal, so the supervisor's own hostLoss watcher must own the marking.
    let releaseHostLoss = (): void => undefined;
    const hostLoss = new Promise<void>((resolve) => {
      releaseHostLoss = resolve;
    });
    const subject = buildSubject({ inference: createHangingInference() });
    const supervisor = createAgentSessionSupervisor(
      buildSupervisorDeps(buildRegistryWith(registrationOf(subject.harness)), { hostLoss })
    );

    const handle = supervisor.supervise(subject.invocation);
    // started + tool_call started + tool_call completed are everything the harness appends before
    // the model call it never leaves.
    await waitUntil(
      () => handle.snapshot().lastSequence === 3,
      "the pre-loss events are relayed through the supervisor"
    );

    releaseHostLoss();
    const events = await collect(handle.events);

    // Positive companion: the relayed prefix survives; then the single synthesized interruption.
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "interrupted"
    ]);
    expect(eventsOfType(events, "interrupted")).toHaveLength(1);
    expect(lifecycleTerminals(events)).toHaveLength(0);
    expect(handle.snapshot()).toEqual({ state: "interrupted", lastSequence: events.length });

    // The synthesized event digests the SUPERVISOR's relayed prefix under the shared transcript
    // authority — recomputed from the composed stream itself.
    const interrupted = eventsOfType(events, "interrupted")[0];
    const expectedDigest = await digestSessionTranscript({
      sessionId: subject.invocation.agentSessionId,
      events: events.slice(0, -1)
    });
    expect(interrupted?.evidenceDigests).toEqual([expectedDigest]);
    expect(interrupted?.reason).toBe("The agent host was lost before the session finished.");

    await subject.harness.dispose();
  });

  it("rejects registering a native harness whose descriptor claims the permission capability its surface no longer exposes, while both honest surfaces register (rejects a registry that trusts the capability bit without checking the port surface)", () => {
    const permissioned = buildSubject({
      inference: createHangingInference(),
      permissioned: true
    });
    const unpermissioned = buildSubject({ inference: createHangingInference() });

    // Positive companion: both honest native harnesses are admitted and retrievable.
    const registry = buildRegistryWith(
      registrationOf(permissioned.harness),
      registrationOf(unpermissioned.harness)
    );
    expect(registry.get(permissioned.adapterId)).toBe(permissioned.harness);
    expect(registry.get(unpermissioned.adapterId)).toBe(unpermissioned.harness);
    expect(typeof permissioned.harness.respondToPermission).toBe("function");
    expect(unpermissioned.harness.respondToPermission).toBeUndefined();

    // Reshape a fresh permissioned harness's surface: the descriptor still declares permissions,
    // but the responder is dropped by spread — descriptor and port surface now disagree.
    const dishonest = buildSubject({ inference: createHangingInference(), permissioned: true });
    const { respondToPermission: _droppedResponder, ...surfaceWithoutResponder } =
      dishonest.harness;
    const lying: AgentHarnessPort = surfaceWithoutResponder;

    let thrown: unknown;
    try {
      registry.register(registrationOf(lying));
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof AgentRuntimeError)) {
      throw new Error("Registering the reshaped harness did not raise an AgentRuntimeError.");
    }
    expect(thrown.code).toBe("agent_harness_capability_mismatch");
    // The dishonest registration never entered the registry.
    expect(() => registry.get(dishonest.adapterId)).toThrowError(AgentRuntimeError);
  });

  it("profiles() reports the registered native harnesses installed and authenticated from the pure constant probe alone (rejects an availability layer that goes looking for a CLI on disk or the network — a native harness has no CLI to find)", async () => {
    const permissioned = buildSubject({
      inference: createHangingInference(),
      permissioned: true
    });
    const unpermissioned = buildSubject({ inference: createHangingInference() });

    // The probes are pure constants entirely in the test's control: no filesystem, no network,
    // no child process. The registry's probeTimeout NEVER elapses (see buildRegistryWith), so
    // profiles() can only resolve because these constants answered on their own — an availability
    // layer that reached for anything external would lose a race that never ends.
    let permissionedProbeCalls = 0;
    let unpermissionedProbeCalls = 0;
    const registry = buildRegistryWith(
      registrationOf(permissioned.harness, async () => {
        permissionedProbeCalls += 1;
        return { installed: true, authenticated: true };
      }),
      registrationOf(unpermissioned.harness, async () => {
        unpermissionedProbeCalls += 1;
        return { installed: true, authenticated: true };
      })
    );

    const profiles = await registry.profiles();

    expect(profiles.map((profile) => profile.descriptor.adapterId)).toEqual([
      permissioned.adapterId,
      unpermissioned.adapterId
    ]);
    // The profiles carry the harnesses' own derived descriptors, unaltered.
    expect(profiles[0]?.descriptor).toEqual(permissioned.harness.descriptor);
    expect(profiles[1]?.descriptor).toEqual(unpermissioned.harness.descriptor);
    // The constant facts came through verbatim: installed and authenticated, with no fail-closed
    // detail — a probe that had been timed out or refused would report neither.
    for (const profile of profiles) {
      expect(profile.availability.installed).toBe(true);
      expect(profile.availability.authenticated).toBe(true);
      expect(profile.availability.detail).toBeUndefined();
      expect(typeof profile.availability.checkedAt).toBe("string");
    }
    // Each probe was consulted exactly once — and it is the ONLY availability source there is.
    expect(permissionedProbeCalls).toBe(1);
    expect(unpermissionedProbeCalls).toBe(1);
  });

  it("delivers a supervisor-issued cancellation to the harness and ends the composed stream in the cancelled shape within the injected grace budget (rejects a supervisor that waits out the full grace before honouring the adapter's own cancelled terminal, and one that never asks the adapter at all)", async () => {
    const subject = buildSubject({ inference: createHangingInference() });
    // The manual sleep is NEVER released: the only way this session can end inside the grace
    // budget is the harness acknowledging the cancel with its OWN cancelled terminal — which is
    // exactly the proof the cancellation crossed the port boundary.
    const manual = createManualSleep();
    const supervisor = createAgentSessionSupervisor(
      buildSupervisorDeps(buildRegistryWith(registrationOf(subject.harness)), {
        cancellationGraceMs: 350,
        sleep: manual.sleep
      })
    );

    const handle = supervisor.supervise(subject.invocation);
    await waitUntil(
      () => handle.snapshot().lastSequence === 3,
      "the pre-cancel events are relayed through the supervisor"
    );

    await handle.cancel("The operator withdrew the run.");

    // The grace wait was requested from the injected sleep with EXACTLY the configured budget.
    expect(manual.requestedMs).toEqual([350]);

    const events = await collect(handle.events);
    // Positive companion: the pre-cancel work is preserved, then the adapter's cancelled arrives
    // and is relayed as the single terminal.
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "cancelled"
    ]);
    expect(eventsOfType(events, "cancelled")).toHaveLength(1);
    expect(lifecycleTerminals(events)).toHaveLength(1);
    expect(eventsOfType(events, "completed")).toHaveLength(0);
    expect(handle.snapshot()).toEqual({ state: "cancelled", lastSequence: events.length });

    await subject.harness.dispose();
  });

  it("keeps a concluded session's agentSessionId reserved: re-supervising it raises agent_session_already_supervised while a fresh session still supervises (pins the T3 carry-forward reservation semantics; rejects a supervisor that releases the guard on conclusion)", async () => {
    const first = buildSubject({
      inference: createFakeModelInference({
        outcomes: [COMPLETED_OUTCOME],
        now: createTickClock().now
      })
    });
    const second = buildSubject({
      inference: createFakeModelInference({
        outcomes: [COMPLETED_OUTCOME],
        now: createTickClock().now
      })
    });
    const supervisor = createAgentSessionSupervisor(
      buildSupervisorDeps(
        buildRegistryWith(registrationOf(first.harness), registrationOf(second.harness))
      )
    );

    const firstHandle = supervisor.supervise(first.invocation);
    const firstEvents = await collect(firstHandle.events);
    expect(firstEvents.at(-1)?.type).toBe("completed");
    expect(firstHandle.snapshot().state).toBe("completed");

    // Positive companion: a FRESH session id supervises fine after the first concluded.
    const secondHandle = supervisor.supervise(second.invocation);
    const secondEvents = await collect(secondHandle.events);
    expect(secondEvents.at(-1)?.type).toBe("completed");

    // T3 carry-forward (plan Task 13 note): the duplicate-session guard never releases an entry —
    // a concluded session's id stays reserved for the supervisor's lifetime, because releasing it
    // would let a re-supervise of a finished session masquerade as a resume. This composition
    // relies on exactly those semantics and pins them here.
    let thrown: unknown;
    try {
      supervisor.supervise(first.invocation);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof AgentRuntimeError)) {
      throw new Error("Re-supervising the concluded session did not raise an AgentRuntimeError.");
    }
    expect(thrown.code).toBe("agent_session_already_supervised");
  });
});
