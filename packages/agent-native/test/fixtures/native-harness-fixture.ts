import {
  AgentCancelRequestSchema,
  AgentInvocationRequestSchema,
  AgentPermissionResponseSchema,
  AgentResumeRequestSchema,
  AgentSteerRequestSchema,
  ModelCatalogEntrySchema,
  ModelRouteSchema,
  createId,
  type AgentPermissionRequest,
  type AgentSessionStreamEvent,
  type ModelInferencePort
} from "@autostack/contracts";
import {
  createFakeModelInference,
  createFakeModelRouter,
  type AgentHarnessConformanceFixture,
  type AgentHarnessConformanceScenario,
  type AgentHarnessConformanceSubject,
  type AgentHarnessMinimalScenario,
  type FakeModelInferenceOutcome,
  type FakeModelRouteDeclaration,
  type FakeModelRouterOutcome
} from "@autostack/domain/testing";

import type { NativeContextReader } from "../../src/context-assembly.js";
import type { ContextScope } from "../../src/context-scope.js";
import {
  createNativeHarness,
  type NativeHarnessConfig,
  type NativeHarnessDeps,
  type NativeRoleInputsProvider
} from "../../src/native-harness.js";
import { buildReviewRoleDocuments } from "./review-role-documents.js";

const digest = (character: string): string => character.repeat(64);

const INPUT_DIGEST = digest("1");
const STEER_DIGEST = digest("6");

const STEER_INSTRUCTION = "Prefer the smaller refactor.";

/** In scope for every scenario: the declared documentation prefix. */
const IN_SCOPE_PATH = "docs/review-brief.md";
/**
 * Outside the declared scope, and sorted BEFORE the in-scope path (context assembly reads in
 * code-unit sorted order), so the permission gate fires before any read emits `tool_call`
 * evidence — the suite requires no side-effect event before `permission_requested`.
 */
const OUT_OF_SCOPE_PATH = "config/reviewer-notes.md";

const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };

const CONTEXT_LIMITS = { maxFiles: 8, maxBytes: 65_536 } as const;

const WORKSPACE_FILES: Readonly<Record<string, string>> = {
  [IN_SCOPE_PATH]: "The checkout totals module rounds discounts before summing line items.",
  [OUT_OF_SCOPE_PATH]: "Reviewer notes kept outside the declared documentation scope."
};

const createWorkspaceReader = (): NativeContextReader => ({
  list: async ({ prefix }) =>
    Object.keys(WORKSPACE_FILES).filter((path) => path === prefix || path.startsWith(`${prefix}/`)),
  read: async ({ path }) => {
    const content = WORKSPACE_FILES[path];
    if (content === undefined) {
      throw new Error(`No workspace file exists at ${path}.`);
    }
    return content;
  }
});

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));
const ENVIRONMENT_ID = createId("environment", uuid(4));
const WORK_ITEM_ID = createId("workItem", uuid(5));
const CREDENTIAL_REF_ID = createId("credentialRef", uuid(6));

const ROUTE_REF = "native.review.route";

/** One enabled route declaring every capability, so any required-capability set is eligible. */
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
    inputModalities: ["text", "image", "audio", "video", "pdf"],
    outputModalities: ["text"],
    features: ["tool_call", "structured_output", "streaming", "reasoning", "prompt_caching"],
    discoveredAt: "2026-08-26T00:00:00.000Z"
  })
};

const ROUTE_OUTCOME: FakeModelRouterOutcome = {
  kind: "selected",
  routeRef: ROUTE_REF,
  reason: "The only declared route offers every required capability."
};

/** The model-authored subset of `ReviewReportSchema` for the review role, as JSON text. */
const REVIEW_RESPONSE_CONTENT = JSON.stringify({
  verdict: "approved",
  summary: "The prepared change matches the approved plan and carries no blocking findings.",
  findings: []
});

/** The invocation identity every scenario's typed review documents must carry (T10). */
const REVIEW_DOCUMENTS_IDENTITY = {
  workspaceId: WORKSPACE_ID,
  workItemId: WORK_ITEM_ID,
  runId: RUN_ID
} as const;

/**
 * One successful structured response. `cachedInput`, `reasoning`, and `cost` stay unknown, so the
 * suite can tell an unreported figure from a fabricated zero in the harness's `usage` event.
 */
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

const PROVIDER_FAILURE_OUTCOME: FakeModelInferenceOutcome = {
  kind: "failure",
  failure: {
    code: "provider_error",
    message: "The upstream provider returned HTTP 500 for the routed request.",
    retryable: false
  }
};

/**
 * An inference port that accepts the call and never settles it. This is still a scripted
 * inference fake, not a scripted harness: `createFakeModelInference` can only script outcomes
 * that settle, and these two scenarios need the engine's own wait on an in-flight call —
 * released only by cancel (minimal `pauses`) or by host loss (`interrupted`).
 */
const createHangingInference = (onRun?: () => void): ModelInferencePort => ({
  run: () => {
    onRun?.();
    return new Promise(() => {
      // Never settles: the session leaves this wait through cancel or host loss alone.
    });
  }
});

/** Everything one scenario scripts: the inference behaviour, its context, and any host loss. */
interface ScenarioWiring {
  readonly inference: ModelInferencePort;
  readonly contextPaths: readonly string[];
  readonly hostLoss?: Promise<void>;
}

const wireScenario = (
  scenario: AgentHarnessConformanceScenario,
  full: boolean,
  now: () => string
): ScenarioWiring => {
  switch (scenario) {
    case "completes":
      return {
        inference: createFakeModelInference({ outcomes: [COMPLETED_OUTCOME], now }),
        contextPaths: [IN_SCOPE_PATH]
      };
    case "fails":
      return {
        inference: createFakeModelInference({ outcomes: [PROVIDER_FAILURE_OUTCOME], now }),
        contextPaths: [IN_SCOPE_PATH]
      };
    case "pauses":
      // Full subject: the engine's steerable pre-model-call wait, released by a steer whose
      // instruction is echoed in a later `message` event before the scripted completion.
      // Minimal subject: no steer wait exists, so the pause is an inference call that never
      // resolves, released only by cancel.
      return full
        ? {
            inference: createFakeModelInference({ outcomes: [COMPLETED_OUTCOME], now }),
            contextPaths: [IN_SCOPE_PATH]
          }
        : { inference: createHangingInference(), contextPaths: [IN_SCOPE_PATH] };
    case "requests_permission":
      // The out-of-scope path exercises T7's gate through the port; sorted first, it blocks the
      // session before any read, and the allow decision releases the read and the completion.
      return {
        inference: createFakeModelInference({ outcomes: [COMPLETED_OUTCOME], now }),
        contextPaths: [OUT_OF_SCOPE_PATH, IN_SCOPE_PATH]
      };
    case "interrupted": {
      // Host loss fires at the model call — after the context reads have produced the session's
      // first evidence-bearing events — and the call itself never settles, so `interrupted` is
      // the only outcome the session can reach.
      let releaseHostLoss = (): void => {};
      const hostLoss = new Promise<void>((resolve) => {
        releaseHostLoss = resolve;
      });
      return {
        inference: createHangingInference(() => {
          releaseHostLoss();
        }),
        contextPaths: [IN_SCOPE_PATH],
        hostLoss
      };
    }
  }
};

/** Distinct identities and timestamps per subject, so no behaviour can observe another's state. */
let issuedSubjects = 0;

const createClock = (subject: number): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 26, 12, subject % 60, tick % 60, tick)).toISOString();
  };
};

const providerSessionRefIn = (observed: readonly AgentSessionStreamEvent[]): string | undefined => {
  for (const event of observed) {
    if (event.type === "started" && event.providerSessionRef !== undefined) {
      return event.providerSessionRef;
    }
  }
  return undefined;
};

const createSubject = (
  scenario: AgentHarnessConformanceScenario,
  capabilities: { readonly full: boolean }
): AgentHarnessConformanceSubject => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const now = createClock(subject);
  const providerSessionRef = `native.session.${subject}`;
  const adapterId = capabilities.full ? "native.review" : "native.review.minimal";
  const wiring = wireScenario(scenario, capabilities.full, now);
  let issuedRefs = 0;

  const config: NativeHarnessConfig = {
    adapterId,
    role: "review",
    // GREEN-phase defect fix (lead re-review): `interactive` opts into the engine's pre-model-call
    // operator wait, separately from the `steerable` capability bit. Only the pauses scenario runs
    // interactively — a steerable subject that always blocked for an operator could never satisfy
    // the suite's unattended `completes` obligation, so one fixed config cannot serve both unless
    // the capability and the wait are distinct knobs.
    session: {
      resumable: capabilities.full,
      steerable: capabilities.full,
      interactive: capabilities.full && scenario === "pauses"
    },
    permissioned: capabilities.full,
    context: {
      paths: wiring.contextPaths,
      scope: DOCS_SCOPE,
      limits: CONTEXT_LIMITS
    }
  };

  // The provider method is `forInvocation` — the name this stream already published to I1 as the
  // composition interface (stream-report, review finding 2b); T10 widened the returned inputs to
  // the reviewer's typed documents, which the role admits BEFORE the model call.
  const roleInputs: NativeRoleInputsProvider = {
    forInvocation: async () => buildReviewRoleDocuments(REVIEW_DOCUMENTS_IDENTITY)
  };

  const deps: NativeHarnessDeps = {
    router: createFakeModelRouter({
      catalog: [ROUTE_DECLARATION],
      outcomes: [ROUTE_OUTCOME],
      now
    }),
    inference: wiring.inference,
    reader: createWorkspaceReader(),
    roleInputs,
    now,
    newProviderSessionRef: () => providerSessionRef,
    newRef: () => {
      issuedRefs += 1;
      return `native.ref.${subject}.${issuedRefs}`;
    },
    structuredOutput: { maxRepairAttempts: 0 },
    ...(wiring.hostLoss === undefined ? {} : { hostLoss: wiring.hostLoss })
  };

  const harness = createNativeHarness(config, deps);

  const agentSessionId = createId("agentSession", uuid(1_000 + subject));
  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `conformance:${subject}:start`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workItemId: WORK_ITEM_ID,
    stageRunId: STAGE_RUN_ID,
    agentSessionId,
    environmentId: ENVIRONMENT_ID,
    adapterId,
    objective: "Review the prepared fix for the discount rounding defect.",
    cwd: "/workspace/factory",
    inputEvidenceDigests: [INPUT_DIGEST]
  });

  let decisions = 0;

  return {
    harness,
    invocation,
    steer: AgentSteerRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `conformance:${subject}:steer`,
      sessionId: agentSessionId,
      instruction: STEER_INSTRUCTION,
      evidenceDigest: STEER_DIGEST
    }),
    cancel: AgentCancelRequestSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `conformance:${subject}:cancel`,
      sessionId: agentSessionId,
      reason: "The operator withdrew the run."
    }),
    resumeRequest: (observed) =>
      AgentResumeRequestSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `conformance:${subject}:resume`,
        sessionId: agentSessionId,
        providerSessionRef: providerSessionRefIn(observed) ?? providerSessionRef,
        objective: "Continue the review of the prepared fix.",
        inputEvidenceDigests: [INPUT_DIGEST]
      }),
    pendingPermission: async () => harness.pendingPermission,
    permissionResponse: (request: AgentPermissionRequest, selectedOptionId: string) => {
      decisions += 1;
      return AgentPermissionResponseSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `conformance:${subject}:permission:${decisions}`,
        sessionId: request.sessionId,
        permissionRef: request.permissionRef,
        approvalId: createId("approval", uuid(2_000 + decisions * 100 + subject)),
        selectedOptionId,
        evidenceDigest: request.evidenceDigest,
        decidedAt: now()
      });
    },
    dispose: () => harness.dispose()
  };
};

export const nativeHarnessConformanceFixture: AgentHarnessConformanceFixture = {
  createFullCapabilityHarness: (scenario: AgentHarnessConformanceScenario) =>
    Promise.resolve(createSubject(scenario, { full: true })),
  createMinimalCapabilityHarness: (scenario: AgentHarnessMinimalScenario) =>
    Promise.resolve(createSubject(scenario, { full: false }))
};
