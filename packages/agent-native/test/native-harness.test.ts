import { describe, expect, it } from "vitest";

import {
  AgentCancelRequestSchema,
  AgentInvocationRequestSchema,
  AgentPermissionResponseSchema,
  AgentResumeRequestSchema,
  AgentSteerRequestSchema,
  ModelCatalogEntrySchema,
  ModelRouteSchema,
  createId,
  type AgentCancelRequest,
  type AgentInvocationRequest,
  type AgentPermissionResponse,
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
  type FakeModelRouter,
  type FakeModelRouterOutcome
} from "@autostack/domain/testing";

import type { NativeContextReader } from "../src/context-assembly.js";
import type { ContextScope } from "../src/context-scope.js";
import type { NativeAgentRole } from "../src/prompts/index.js";
import {
  createNativeHarness,
  type NativeAgentHarness,
  type NativeHarnessConfig
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
const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };
const ADAPTER_ID = "native.harness.unit";

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
  readonly role?: NativeAgentRole;
  readonly omitWorkItemId?: boolean;
}

interface BuiltHarness {
  readonly harness: NativeAgentHarness;
  readonly invocation: AgentInvocationRequest;
  readonly steer: AgentSteerRequest;
  readonly cancel: AgentCancelRequest;
  readonly resume: AgentResumeRequest;
  readonly permissionResponse: AgentPermissionResponse;
  readonly inference: FakeModelInference;
  readonly router: FakeModelRouter;
}

let issuedSubjects = 0;

const createClock = (subject: number): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 27, 11, subject % 60, tick % 60, tick)).toISOString();
  };
};

const buildHarness = (options: BuildOptions): BuiltHarness => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const now = createClock(subject);
  const providerSessionRef = `native.session.unit.${subject}`;
  let issuedRefs = 0;

  const config: NativeHarnessConfig = {
    adapterId: ADAPTER_ID,
    role: options.role ?? "review",
    session: { resumable: true, steerable: true, interactive: false },
    permissioned: true,
    context: {
      paths: [IN_SCOPE_PATH],
      scope: DOCS_SCOPE,
      limits: { maxFiles: 8, maxBytes: 65_536 }
    }
  };

  const inference = createFakeModelInference({ outcomes: [COMPLETED_OUTCOME], now });
  const router = createFakeModelRouter({
    catalog: [ROUTE_DECLARATION],
    outcomes: [ROUTE_OUTCOME],
    now
  });
  const harness = createNativeHarness(config, {
    router,
    inference,
    reader: defaultReader(),
    // T10: the review role admits TYPED documents before the model call; other roles keep the
    // plain context-entry arm.
    roleInputs: {
      forInvocation: async () =>
        config.role === "review"
          ? buildReviewRoleDocuments({
              workspaceId: WORKSPACE_ID,
              workItemId: WORK_ITEM_ID,
              runId: RUN_ID
            })
          : []
    },
    now,
    newProviderSessionRef: () => providerSessionRef,
    newRef: () => {
      issuedRefs += 1;
      return `native.ref.unit.${subject}.${issuedRefs}`;
    },
    structuredOutput: { maxRepairAttempts: 0 }
  });

  const agentSessionId = createId("agentSession", uuid(4_000 + subject));
  return {
    harness,
    inference,
    router,
    invocation: AgentInvocationRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `unit:${subject}:start`,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      ...(options.omitWorkItemId === true ? {} : { workItemId: WORK_ITEM_ID }),
      stageRunId: STAGE_RUN_ID,
      agentSessionId,
      environmentId: ENVIRONMENT_ID,
      adapterId: ADAPTER_ID,
      objective: "Review the prepared fix for the discount rounding defect.",
      cwd: "/workspace/factory",
      inputEvidenceDigests: [digest("1")]
    }),
    steer: AgentSteerRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `unit:${subject}:steer`,
      sessionId: agentSessionId,
      instruction: "Prefer the smaller refactor.",
      evidenceDigest: digest("6")
    }),
    cancel: AgentCancelRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `unit:${subject}:cancel`,
      sessionId: agentSessionId,
      reason: "The operator withdrew the run."
    }),
    resume: AgentResumeRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `unit:${subject}:resume`,
      sessionId: agentSessionId,
      providerSessionRef,
      objective: "Continue the review of the prepared fix.",
      inputEvidenceDigests: [digest("1")]
    }),
    permissionResponse: AgentPermissionResponseSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `unit:${subject}:permission`,
      sessionId: agentSessionId,
      permissionRef: "workspace.read",
      approvalId: createId("approval", uuid(5_000 + subject)),
      selectedOptionId: "allow-once",
      evidenceDigest: digest("5"),
      decidedAt: "2026-08-27T11:00:00.000Z"
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

describe("native harness unit behaviour", () => {
  it("raises when started twice on one harness", async () => {
    const built = buildHarness({});
    const events = await collect(built.harness.start(built.invocation));
    expect(events.at(-1)?.type).toBe("completed");
    expect(() => built.harness.start(built.invocation)).toThrow(TypeError);
  });

  it("raises when steered after the session terminated", async () => {
    const built = buildHarness({});
    const events = await collect(built.harness.start(built.invocation));
    expect(events.at(-1)?.type).toBe("completed");
    await expect(built.harness.steer(built.steer)).rejects.toBeInstanceOf(TypeError);
  });

  it("refuses every operation on a disposed harness", async () => {
    const built = buildHarness({});
    await expect(built.harness.dispose()).resolves.toBeUndefined();

    expect(() => built.harness.start(built.invocation)).toThrow(TypeError);
    await expect(collect(built.harness.resume(built.resume))).rejects.toBeInstanceOf(TypeError);
    await expect(built.harness.steer(built.steer)).rejects.toBeInstanceOf(TypeError);
    await expect(built.harness.cancel(built.cancel)).rejects.toBeInstanceOf(TypeError);

    const respond = built.harness.respondToPermission;
    if (respond === undefined) {
      throw new TypeError("A permissioned harness must expose the permission responder.");
    }
    await expect(respond.call(built.harness, built.permissionResponse)).rejects.toBeInstanceOf(
      TypeError
    );
  });

  it("derives each role's descriptor field by field", () => {
    for (const role of ["triage", "plan", "review"] as const) {
      const built = buildHarness({ role });
      expect(built.harness.descriptor).toEqual({
        schemaVersion: 1,
        adapterId: ADAPTER_ID,
        kind: "native",
        displayName: `AutoStack native ${role} harness`,
        capabilities: {
          resume: true,
          steering: true,
          permissions: true,
          structuredPlans: role === "plan"
        }
      });
    }
  });

  it("completes a review session without ever emitting a plan event", async () => {
    const built = buildHarness({ role: "review" });
    expect(built.harness.descriptor.capabilities.structuredPlans).toBe(false);

    const events = await collect(built.harness.start(built.invocation));
    expect(events.filter((event) => event.type === "plan")).toEqual([]);
    // Positive companion: the stream is a real completed session, not an empty one.
    expect(events.length).toBeGreaterThan(1);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("fails closed on a missing workItemId before any model call", async () => {
    const built = buildHarness({ omitWorkItemId: true });
    expect(built.invocation.workItemId).toBeUndefined();

    const events = await collect(built.harness.start(built.invocation));
    expect(events).toHaveLength(1);
    const terminal = events[0];
    expect(terminal?.type).toBe("failed");
    if (terminal?.type !== "failed") {
      throw new TypeError("unreachable");
    }
    expect(terminal.code).toBe("native_invocation_incomplete");
    expect(terminal.retryable).toBe(false);

    // Before ANY model call: neither the router nor the inference port was ever consulted.
    expect(built.router.requests).toHaveLength(0);
    expect(built.inference.requests).toHaveLength(0);
  });
});
