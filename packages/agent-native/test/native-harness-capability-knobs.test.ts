import { describe, expect, it } from "vitest";

import {
  AgentInvocationRequestSchema,
  AgentResumeRequestSchema,
  AgentSteerRequestSchema,
  ModelCatalogEntrySchema,
  ModelRouteSchema,
  createId,
  type AgentInvocationRequest,
  type AgentResumeRequest,
  type AgentSessionStreamEvent,
  type AgentSteerRequest
} from "@autostack/contracts";
import {
  createFakeModelInference,
  createFakeModelRouter,
  type FakeModelInference,
  type FakeModelInferenceOutcome,
  type FakeModelRouteDeclaration,
  type FakeModelRouterOutcome
} from "@autostack/domain/testing";

import type { NativeContextReader } from "../src/context-assembly.js";
import type { ContextScope } from "../src/context-scope.js";
import {
  createNativeHarness,
  type NativeAgentHarness,
  type NativeHarnessConfig,
  type NativeSessionConfig
} from "../src/native-harness.js";
import { buildReviewRoleDocuments } from "./fixtures/review-role-documents.js";

const digest = (character: string): string => character.repeat(64);
const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));
const ENVIRONMENT_ID = createId("environment", uuid(4));
const WORK_ITEM_ID = createId("workItem", uuid(5));
const CREDENTIAL_REF_ID = createId("credentialRef", uuid(6));

const IN_SCOPE_PATH = "docs/review-brief.md";
const OUT_OF_SCOPE_PATH = "config/reviewer-notes.md";
const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };
const STEER_INSTRUCTION = "Prefer the smaller refactor.";

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

const COMPLETED_OUTCOME: FakeModelInferenceOutcome = {
  kind: "completed",
  result: {
    content: JSON.stringify({
      verdict: "approved",
      summary: "The prepared change matches the approved plan.",
      findings: []
    }),
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

const defaultReader = (): NativeContextReader => ({
  list: async () => [IN_SCOPE_PATH],
  read: async ({ path }) => {
    if (path !== IN_SCOPE_PATH) {
      throw new Error(`No workspace file exists at ${path}.`);
    }
    return "The checkout totals module rounds discounts before summing line items.";
  }
});

interface BuildOptions {
  readonly session?: NativeSessionConfig;
  readonly permissioned?: boolean;
  readonly paths?: readonly string[];
  readonly reader?: NativeContextReader;
}

interface BuiltHarness {
  readonly harness: NativeAgentHarness;
  readonly invocation: AgentInvocationRequest;
  readonly steer: AgentSteerRequest;
  readonly resume: AgentResumeRequest;
  readonly inference: FakeModelInference;
}

let issuedSubjects = 0;

const createClock = (subject: number): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 27, 10, subject % 60, tick % 60, tick)).toISOString();
  };
};

const buildHarness = (options: BuildOptions): BuiltHarness => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const now = createClock(subject);
  const providerSessionRef = `native.session.knobs.${subject}`;
  let issuedRefs = 0;

  const config: NativeHarnessConfig = {
    adapterId: "native.review.knobs",
    role: "review",
    session: options.session ?? { resumable: true, steerable: true, interactive: false },
    permissioned: options.permissioned ?? true,
    context: {
      paths: options.paths ?? [IN_SCOPE_PATH],
      scope: DOCS_SCOPE,
      limits: { maxFiles: 8, maxBytes: 65_536 }
    }
  };

  const inference = createFakeModelInference({ outcomes: [COMPLETED_OUTCOME], now });
  const harness = createNativeHarness(config, {
    router: createFakeModelRouter({ catalog: [ROUTE_DECLARATION], outcomes: [ROUTE_OUTCOME], now }),
    inference,
    reader: options.reader ?? defaultReader(),
    // T10: every knob subject runs the review role, whose typed documents are admitted before
    // the model call.
    roleInputs: {
      forInvocation: async () =>
        buildReviewRoleDocuments({
          workspaceId: WORKSPACE_ID,
          workItemId: WORK_ITEM_ID,
          runId: RUN_ID
        })
    },
    now,
    newProviderSessionRef: () => providerSessionRef,
    newRef: () => {
      issuedRefs += 1;
      return `native.ref.knobs.${subject}.${issuedRefs}`;
    },
    structuredOutput: { maxRepairAttempts: 0 }
  });

  const agentSessionId = createId("agentSession", uuid(3_000 + subject));
  return {
    harness,
    inference,
    invocation: AgentInvocationRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `knobs:${subject}:start`,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      workItemId: WORK_ITEM_ID,
      stageRunId: STAGE_RUN_ID,
      agentSessionId,
      environmentId: ENVIRONMENT_ID,
      adapterId: "native.review.knobs",
      objective: "Review the prepared fix for the discount rounding defect.",
      cwd: "/workspace/factory",
      inputEvidenceDigests: [digest("1")]
    }),
    steer: AgentSteerRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `knobs:${subject}:steer`,
      sessionId: agentSessionId,
      instruction: STEER_INSTRUCTION,
      evidenceDigest: digest("6")
    }),
    resume: AgentResumeRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `knobs:${subject}:resume`,
      sessionId: agentSessionId,
      providerSessionRef,
      objective: "Continue the review of the prepared fix.",
      inputEvidenceDigests: [digest("1")]
    })
  };
};

const collect = async (
  stream: AsyncIterable<AgentSessionStreamEvent>
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (events.length > 1_000) {
      throw new TypeError("The agent session stream did not terminate.");
    }
  }
  return events;
};

const take = async (
  iterator: AsyncIterator<AgentSessionStreamEvent>,
  count: number
): Promise<AgentSessionStreamEvent[]> => {
  const events: AgentSessionStreamEvent[] = [];
  while (events.length < count) {
    const next = await iterator.next();
    if (next.done === true) {
      throw new TypeError("The agent session stream ended early.");
    }
    events.push(next.value);
  }
  return events;
};

const drain = async (
  iterator: AsyncIterator<AgentSessionStreamEvent>,
  initial: readonly AgentSessionStreamEvent[]
): Promise<AgentSessionStreamEvent[]> => {
  const events = [...initial];
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      return events;
    }
    events.push(next.value);
    if (events.length > 1_000) {
      throw new TypeError("The agent session stream did not terminate.");
    }
  }
};

const PERMISSION_EVENT_TYPES: readonly string[] = ["permission_requested", "permission_resolved"];

describe("native harness capability knobs", () => {
  it("permissioned:false leaves no permission surface and completes with zero permission events", async () => {
    const built = buildHarness({
      permissioned: false,
      session: { resumable: false, steerable: false, interactive: false }
    });

    // Structural absence, not an undefined-valued property.
    expect("respondToPermission" in built.harness).toBe(false);
    expect(built.harness.descriptor.capabilities.permissions).toBe(false);

    const events = await collect(built.harness.start(built.invocation));
    expect(events.filter((event) => PERMISSION_EVENT_TYPES.includes(event.type))).toEqual([]);
    // Positive companion: the in-scope context WAS read and the session really completed, so the
    // absence of permission events is a working configuration rather than a dead session.
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("permissioned:false refuses construction when an out-of-scope source is declared", () => {
    expect(() =>
      buildHarness({
        permissioned: false,
        session: { resumable: false, steerable: false, interactive: false },
        paths: [OUT_OF_SCOPE_PATH, IN_SCOPE_PATH]
      })
    ).toThrow(TypeError);
    // The same sources are a legitimate PERMISSIONED configuration, so the refusal above is the
    // knob's doing rather than a general rejection of the paths.
    expect(() =>
      buildHarness({ permissioned: true, paths: [OUT_OF_SCOPE_PATH, IN_SCOPE_PATH] })
    ).not.toThrow();
  });

  it("steerable:false rejects steering and reaches the model call without any wait", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedReader: NativeContextReader = {
      list: async () => [IN_SCOPE_PATH],
      read: async () => {
        await gate;
        return "The checkout totals module rounds discounts before summing line items.";
      }
    };
    const built = buildHarness({
      permissioned: false,
      session: { resumable: false, steerable: false, interactive: false },
      reader: gatedReader
    });
    expect(built.harness.descriptor.capabilities.steering).toBe(false);

    // Refused while the session is LIVE, so only the capability check can be the refuser —
    // a steer sent before start would be rejected for the wrong reason (no session yet).
    const iterator = built.harness.start(built.invocation)[Symbol.asyncIterator]();
    const observed = await take(iterator, 1);
    expect(observed[0]?.type).toBe("started");
    await expect(built.harness.steer(built.steer)).rejects.toBeInstanceOf(TypeError);
    release();

    const events = await drain(iterator, observed);
    expect(events.some((event) => event.type === "waiting")).toBe(false);
    // The engine reached its model call: usage follows the context tool_calls directly.
    const lastToolCall = events.map((event) => event.type).lastIndexOf("tool_call");
    const usageIndex = events.findIndex((event) => event.type === "usage");
    expect(lastToolCall).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBe(lastToolCall + 1);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("interactive:false never blocks for an operator", async () => {
    const built = buildHarness({
      session: { resumable: true, steerable: true, interactive: false }
    });
    const events = await collect(built.harness.start(built.invocation));
    expect(events.some((event) => event.type === "waiting")).toBe(false);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("interactive:false still accepts a steer and folds one that arrives before the model call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedReader: NativeContextReader = {
      list: async () => [IN_SCOPE_PATH],
      read: async () => {
        await gate;
        return "The checkout totals module rounds discounts before summing line items.";
      }
    };
    const built = buildHarness({
      session: { resumable: true, steerable: true, interactive: false },
      reader: gatedReader
    });

    const iterator = built.harness.start(built.invocation)[Symbol.asyncIterator]();
    const observed = await take(iterator, 1);
    expect(observed[0]?.type).toBe("started");

    // The capability is honestly declared: the steer is ACCEPTED while the session runs.
    await expect(built.harness.steer(built.steer)).resolves.toBeUndefined();
    release();

    const events = await drain(iterator, observed);
    expect(events.some((event) => event.type === "waiting")).toBe(false);
    expect(events.some((event) => "text" in event && event.text.includes(STEER_INSTRUCTION))).toBe(
      true
    );
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("resumable:false rejects resume while the same configuration still completes", async () => {
    const built = buildHarness({
      permissioned: false,
      session: { resumable: false, steerable: false, interactive: false }
    });
    expect(built.harness.descriptor.capabilities.resume).toBe(false);

    const events = await collect(built.harness.start(built.invocation));
    expect(events.at(-1)?.type).toBe("completed");

    await expect(collect(built.harness.resume(built.resume))).rejects.toBeInstanceOf(TypeError);
  });

  it("keeps every descriptor bit and its port surface together", () => {
    const full = buildHarness({
      session: { resumable: true, steerable: true, interactive: false },
      permissioned: true
    });
    const minimal = buildHarness({
      session: { resumable: false, steerable: false, interactive: false },
      permissioned: false
    });

    for (const built of [full, minimal]) {
      expect("respondToPermission" in built.harness).toBe(
        built.harness.descriptor.capabilities.permissions
      );
    }
    expect(full.harness.descriptor.capabilities).toEqual({
      resume: true,
      steering: true,
      permissions: true,
      structuredPlans: false
    });
    expect(minimal.harness.descriptor.capabilities).toEqual({
      resume: false,
      steering: false,
      permissions: false,
      structuredPlans: false
    });
  });

  it("refuses an interactive session without steering at construction", () => {
    expect(() =>
      buildHarness({ session: { resumable: true, steerable: false, interactive: true } })
    ).toThrow(TypeError);
  });
});
