import { describe, expect, it } from "vitest";

import {
  AgentCancelRequestSchema,
  AgentInvocationRequestSchema,
  MODEL_ROUTING_FAILURE_CODES,
  ModelCatalogEntrySchema,
  ModelRouteSchema,
  WorkflowFailureSchema,
  containsSensitiveMaterial,
  createId,
  normalizeWorkflowFailureCode,
  type AgentCancelRequest,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type ModelInferencePort,
  type ModelRoutingFailureCode
} from "@autostack/contracts";
import {
  createFakeModelInference,
  createFakeModelRouter,
  type FakeModelInferenceOutcome,
  type FakeModelInferenceResultTemplate,
  type FakeModelRouteDeclaration,
  type FakeModelRouter,
  type FakeModelRouterOutcome,
  type FakeModelRoutingFailureTemplate
} from "@autostack/domain/testing";

import { z } from "zod";

import type { NativeContextReader } from "../src/context-assembly.js";
import type { ContextScope } from "../src/context-scope.js";
import { admitStructuredOutput } from "../src/structured-output.js";
import {
  createNativeHarness,
  type NativeAgentHarness,
  type NativeHarnessConfig,
  type NativeRoleInputsProvider
} from "../src/native-harness.js";
import { NATIVE_AGENT_ROLES, type NativeAgentRole } from "../src/prompts/index.js";
import { buildReviewRoleDocuments } from "./fixtures/review-role-documents.js";

/**
 * Task 11: the cross-role failure and routing matrix. One table-driven suite over every native
 * role × every failure mode, so a role added later cannot skip a path:
 *
 * - `ROLE_SPECS` is a `Record<NativeAgentRole, ...>`: a new member of `NATIVE_AGENT_ROLES` that
 *   lacks a matrix row is a compile error, and `describe.each` over the same constant runs every
 *   cell for every declared role.
 * - `ROUTING_FAILURE_ROWS` is pinned exhaustive over `MODEL_ROUTING_FAILURE_CODES` by a guard
 *   test, so a taxonomy code added upstream fails the matrix rather than silently going untested.
 *
 * Depth belongs to the per-role suites (triage-role/plan-role/review-role); the matrix's value is
 * exhaustiveness × roles, so each cell asserts the terminal discipline only: the terminal is the
 * LAST event, the exact code, `retryable` per the taxonomy, the unchanged lift into the
 * workflow-failure alphabet, and that no partial document escaped as evidence.
 */

const FIXED_NOW = "2026-08-30T12:00:00.000Z";

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));
const ENVIRONMENT_ID = createId("environment", uuid(4));
const WORK_ITEM_ID = createId("workItem", uuid(5));
const CREDENTIAL_REF_ID = createId("credentialRef", uuid(6));

const MATRIX_PATH = "docs/matrix-brief.md";
const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };
const ROUTE_REF = "native.matrix.route";
const EVIDENCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** AWS-access-key shaped, built at runtime: the `AKIA` + 16 upper-alphanumeric known spec. */
const AWS_KEY_SHAPED = `AKIA${"A".repeat(16)}`;

const ROUTE_DECLARATION: FakeModelRouteDeclaration = {
  route: ModelRouteSchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    displayName: "Fake matrix route",
    transport: {
      kind: "vercel_ai_gateway",
      gatewayModel: "fake/matrix-model",
      credentialRefId: CREDENTIAL_REF_ID
    },
    enabled: true
  }),
  catalogEntry: ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    providerModel: "fake/matrix-model",
    displayName: "Fake matrix model",
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

const resultTemplate = (content: string): FakeModelInferenceResultTemplate => ({
  content,
  actual: { provider: "fake-provider", model: "fake/matrix-model" },
  tokens: {
    input: { state: "reported", value: 640 },
    output: { state: "reported", value: 220 },
    cachedInput: { state: "unknown" },
    reasoning: { state: "unknown" }
  },
  cost: { state: "unknown" },
  finishReason: "stop",
  latencyMs: 9
});

const completedOutcome = (content: string): FakeModelInferenceOutcome => ({
  kind: "completed",
  result: resultTemplate(content)
});

/** A schema-valid response the provider nevertheless truncated: `finishReason: "length"`. */
const lengthTruncatedOutcome = (content: string): FakeModelInferenceOutcome => ({
  kind: "completed",
  result: { ...resultTemplate(content), finishReason: "length" }
});

/** The failure arm shared by the router and inference fakes, so one row scripts either origin. */
const routingFailureOutcome = (
  code: ModelRoutingFailureCode,
  retryable: boolean
): { readonly kind: "failure"; readonly failure: FakeModelRoutingFailureTemplate } => ({
  kind: "failure",
  failure: {
    code,
    message: `Scripted ${code} failure raised for the matrix.`,
    retryable
  }
});

/** The per-role data of the matrix: what a well-formed, ill-formed, and unsafe response looks like. */
interface RoleMatrixSpec {
  /** A complete model-authored response the role admits; the happy-path baseline. */
  readonly validModelFields: () => Record<string, unknown>;
  /** One mutation the role's narrowed schema refuses, and the issue path it must surface. */
  readonly schemaInvalidFields: () => Record<string, unknown>;
  readonly schemaInvalidPath: string;
  /** The valid response with a runtime-built AKIA vector planted in a string field. */
  readonly credentialShapedFields: () => Record<string, unknown>;
  readonly roleInputs: NativeRoleInputsProvider;
}

const triageModelFields = (): Record<string, unknown> => ({
  taskType: "bug",
  priority: "high",
  complexity: "small",
  actionable: true,
  rationale:
    "The checkout totals module rounds each discount before summing line items, so invoice totals drift by one cent.",
  duplicates: []
});

const planModelFields = (): Record<string, unknown> => ({
  summary: "Sum the checkout line items first and round the discounted total once.",
  acceptanceCriteria: ["Invoice totals equal the sum of line items to the cent."],
  affectedAreas: ["packages/checkout/src/totals.ts"],
  risks: [],
  verificationCommands: [{ executable: "pnpm", args: ["test"], usesShell: false, required: true }],
  requiredPermissions: [],
  requiredCredentialRefIds: []
});

const reviewModelFields = (): Record<string, unknown> => ({
  verdict: "approved",
  summary: "The prepared change matches the approved plan and carries no blocking findings.",
  findings: []
});

const emptyRoleInputs: NativeRoleInputsProvider = { forInvocation: async () => [] };

const ROLE_SPECS: Readonly<Record<NativeAgentRole, RoleMatrixSpec>> = {
  triage: {
    validModelFields: triageModelFields,
    schemaInvalidFields: () => ({ ...triageModelFields(), priority: "critical" }),
    schemaInvalidPath: "priority",
    credentialShapedFields: () => ({ ...triageModelFields(), clarificationRef: AWS_KEY_SHAPED }),
    roleInputs: emptyRoleInputs
  },
  plan: {
    validModelFields: planModelFields,
    schemaInvalidFields: () => ({ ...planModelFields(), summary: 7 }),
    schemaInvalidPath: "summary",
    credentialShapedFields: () => ({
      ...planModelFields(),
      summary: `Rotate the deploy key ${AWS_KEY_SHAPED} before shipping the rounding fix.`
    }),
    roleInputs: emptyRoleInputs
  },
  review: {
    validModelFields: reviewModelFields,
    schemaInvalidFields: () => ({ ...reviewModelFields(), verdict: "maybe" }),
    schemaInvalidPath: "verdict",
    credentialShapedFields: () => ({
      verdict: "changes_requested",
      summary: "The change leaks an access key into the checkout totals module.",
      findings: [
        {
          findingRef: AWS_KEY_SHAPED,
          severity: "low",
          summary: "A credential-shaped identifier was used as the finding reference.",
          evidenceDigest: "2".repeat(64)
        }
      ]
    }),
    roleInputs: {
      forInvocation: async () =>
        buildReviewRoleDocuments({
          workspaceId: WORKSPACE_ID,
          workItemId: WORK_ITEM_ID,
          runId: RUN_ID
        })
    }
  }
};

const matrixReader = (): NativeContextReader => ({
  list: async () => [MATRIX_PATH],
  read: async ({ path }) => {
    if (path !== MATRIX_PATH) {
      throw new Error(`No workspace file exists at ${path}.`);
    }
    return "The checkout totals module rounds discounts before summing line items.";
  }
});

interface MatrixBuildOptions {
  readonly routerOutcomes?: readonly FakeModelRouterOutcome[];
  readonly inferenceOutcomes?: readonly FakeModelInferenceOutcome[];
  readonly omitWorkItemId?: boolean;
  /** Replaces the scripted inference with a call that never settles (cancel / host-loss rows). */
  readonly hangInference?: boolean;
  readonly hostLoss?: Promise<void>;
}

interface BuiltMatrixSubject {
  readonly harness: NativeAgentHarness;
  readonly invocation: AgentInvocationRequest;
  readonly cancelRequest: AgentCancelRequest;
  readonly router: FakeModelRouter;
  readonly inferenceCalls: () => number;
  /** Registers a callback fired synchronously at each inference call (mid-role triggers). */
  readonly onInferenceRun: (callback: () => void) => void;
}

let issuedSubjects = 0;

const buildMatrixSubject = (
  role: NativeAgentRole,
  options: MatrixBuildOptions = {}
): BuiltMatrixSubject => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const spec = ROLE_SPECS[role];
  const now = (): string => FIXED_NOW;
  const adapterId = `native.${role}.matrix`;
  let issuedRefs = 0;
  let inferenceCalls = 0;
  let onRun: () => void = () => {};

  const scripted = createFakeModelInference({
    outcomes: options.inferenceOutcomes ?? [
      completedOutcome(JSON.stringify(spec.validModelFields()))
    ],
    now
  });
  const inference: ModelInferencePort = {
    run: (request) => {
      inferenceCalls += 1;
      onRun();
      if (options.hangInference === true) {
        return new Promise(() => {
          // Never settles: the session leaves this wait through cancel or host loss alone.
        });
      }
      return scripted.run(request);
    }
  };

  const router = createFakeModelRouter({
    catalog: [ROUTE_DECLARATION],
    outcomes: options.routerOutcomes ?? [ROUTE_OUTCOME],
    now
  });

  const config: NativeHarnessConfig = {
    adapterId,
    role,
    session: { resumable: false, steerable: false, interactive: false },
    permissioned: false,
    context: {
      paths: [MATRIX_PATH],
      scope: DOCS_SCOPE,
      limits: { maxFiles: 8, maxBytes: 65_536 }
    }
  };

  const harness = createNativeHarness(config, {
    router,
    inference,
    reader: matrixReader(),
    roleInputs: spec.roleInputs,
    now,
    newProviderSessionRef: () => `native.session.matrix.${subject}`,
    newRef: () => {
      issuedRefs += 1;
      return `native.ref.matrix.${subject}.${issuedRefs}`;
    },
    structuredOutput: { maxRepairAttempts: 0 },
    ...(options.hostLoss === undefined ? {} : { hostLoss: options.hostLoss })
  });

  const agentSessionId = createId("agentSession", uuid(6_000 + subject));
  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `matrix:${role}:${subject}:start`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    ...(options.omitWorkItemId === true ? {} : { workItemId: WORK_ITEM_ID }),
    stageRunId: STAGE_RUN_ID,
    agentSessionId,
    environmentId: ENVIRONMENT_ID,
    adapterId,
    objective: `Exercise the ${role} role's failure matrix.`,
    cwd: "/workspace/factory",
    inputEvidenceDigests: ["1".repeat(64)]
  });
  const cancelRequest = AgentCancelRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `matrix:${role}:${subject}:cancel`,
    sessionId: agentSessionId,
    reason: "The operator withdrew the run."
  });

  return {
    harness,
    invocation,
    cancelRequest,
    router,
    inferenceCalls: () => inferenceCalls,
    onInferenceRun: (callback) => {
      onRun = callback;
    }
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

type StreamEventOf<Type extends AgentSessionStreamEvent["type"]> = Extract<
  AgentSessionStreamEvent,
  { type: Type }
>;

const requireLastEvent = <Type extends AgentSessionStreamEvent["type"]>(
  events: readonly AgentSessionStreamEvent[],
  type: Type
): StreamEventOf<Type> => {
  const last = events.at(-1);
  expect(last?.type).toBe(type);
  if (last === undefined || last.type !== type) {
    throw new TypeError(`The session did not end in a ${type} event.`);
  }
  return last as StreamEventOf<Type>;
};

const ofType = <Type extends AgentSessionStreamEvent["type"]>(
  events: readonly AgentSessionStreamEvent[],
  type: Type
): readonly AgentSessionStreamEvent[] => events.filter((event) => event.type === type);

/**
 * The shared per-cell assertion: the failed terminal is the LAST event, carries the exact code
 * and retryability, the code survives `normalizeWorkflowFailureCode` unchanged AND lifts into
 * `WorkflowFailureSchema`, and no partial document escaped — no completion, no plan detail
 * event, and no evidence digest on the terminal itself.
 */
const expectFailureTerminal = (
  events: readonly AgentSessionStreamEvent[],
  expected: {
    readonly code: string;
    readonly retryable: boolean;
    readonly messageIncludes?: readonly string[];
  }
): StreamEventOf<"failed"> => {
  const failed = requireLastEvent(events, "failed");
  expect(failed.code).toBe(expected.code);
  expect(failed.retryable).toBe(expected.retryable);
  for (const fragment of expected.messageIncludes ?? []) {
    expect(failed.message).toContain(fragment);
  }
  expect(normalizeWorkflowFailureCode(failed.code)).toBe(expected.code);
  const lifted = WorkflowFailureSchema.parse({
    code: failed.code,
    name: "NativeAgentSessionFailure",
    message: failed.message,
    retryable: failed.retryable
  });
  expect(lifted.code).toBe(expected.code);
  expect(lifted.retryable).toBe(expected.retryable);
  expect(ofType(events, "completed")).toEqual([]);
  expect(ofType(events, "plan")).toEqual([]);
  expect(failed.evidenceDigest).toBeUndefined();
  return failed;
};

/**
 * Every routing-taxonomy code with its permitted retryability: `rate_limited` is transient
 * (retryable true), the deterministic codes describe the request (retryable false), and
 * `provider_error` leaves retryable caller-supplied, so the matrix scripts BOTH values.
 */
interface RoutingFailureRow {
  readonly code: ModelRoutingFailureCode;
  readonly retryable: boolean;
}

const ROUTING_FAILURE_ROWS: readonly RoutingFailureRow[] = [
  { code: "capability_unavailable", retryable: false },
  { code: "route_disabled", retryable: false },
  { code: "provider_error", retryable: false },
  { code: "provider_error", retryable: true },
  { code: "rate_limited", retryable: true },
  { code: "budget_exceeded", retryable: false }
];

describe("matrix coverage guards", () => {
  it("the routing rows cover every ModelRoutingFailureCode, so a taxonomy code added upstream fails the matrix instead of going untested", () => {
    expect(new Set(ROUTING_FAILURE_ROWS.map((row) => row.code))).toEqual(
      new Set(MODEL_ROUTING_FAILURE_CODES)
    );
  });

  it("the role specs cover every declared native role, so a role added later cannot skip a failure path", () => {
    expect(Object.keys(ROLE_SPECS).sort()).toEqual([...NATIVE_AGENT_ROLES].sort());
  });

  it("the planted credential vector is credential-shaped under the shared detector", () => {
    expect(containsSensitiveMaterial(AWS_KEY_SHAPED)).toBe(true);
  });
});

describe.each([...NATIVE_AGENT_ROLES])("cross-role failure matrix: %s", (role) => {
  it("completes on the happy path — the live-session baseline every failure row is a negative of", async () => {
    const built = buildMatrixSubject(role);
    const events = await collect(built.harness.start(built.invocation));

    const completed = requireLastEvent(events, "completed");
    expect(completed.evidenceDigests).toHaveLength(1);
    expect(completed.evidenceDigests[0]).toMatch(EVIDENCE_DIGEST_PATTERN);
    expect(ofType(events, "failed")).toEqual([]);
    expect(built.router.requests).toHaveLength(1);
    expect(built.inferenceCalls()).toBe(1);
  });

  describe("routing failures raised from router.resolve", () => {
    it.each(ROUTING_FAILURE_ROWS)(
      "terminates failed with $code (retryable $retryable) and zero inference calls",
      async ({ code, retryable }) => {
        const built = buildMatrixSubject(role, {
          routerOutcomes: [routingFailureOutcome(code, retryable)],
          inferenceOutcomes: []
        });
        const events = await collect(built.harness.start(built.invocation));

        expectFailureTerminal(events, { code, retryable });
        expect(built.router.requests).toHaveLength(1);
        expect(built.inferenceCalls()).toBe(0);
      }
    );
  });

  describe("routing failures raised from inference.run", () => {
    it.each(ROUTING_FAILURE_ROWS)(
      "terminates failed with $code (retryable $retryable) after exactly one model call",
      async ({ code, retryable }) => {
        const built = buildMatrixSubject(role, {
          inferenceOutcomes: [routingFailureOutcome(code, retryable)]
        });
        const events = await collect(built.harness.start(built.invocation));

        expectFailureTerminal(events, { code, retryable });
        expect(built.inferenceCalls()).toBe(1);
      }
    );
  });

  describe("model output admission", () => {
    it("classifies a non-JSON response as malformed_model_output", async () => {
      const built = buildMatrixSubject(role, {
        inferenceOutcomes: [
          completedOutcome("The rounding defect narrative, with no JSON object at all.")
        ]
      });
      const events = await collect(built.harness.start(built.invocation));

      expectFailureTerminal(events, {
        code: "malformed_model_output",
        retryable: false,
        messageIncludes: ["no complete JSON object"]
      });
      expect(built.inferenceCalls()).toBe(1);
    });

    it("classifies a double-object response as malformed_model_output rather than guessing which object was meant", async () => {
      const spec = ROLE_SPECS[role];
      const object = JSON.stringify(spec.validModelFields());
      const built = buildMatrixSubject(role, {
        inferenceOutcomes: [completedOutcome(`${object} ${object}`)]
      });
      const events = await collect(built.harness.start(built.invocation));

      expectFailureTerminal(events, {
        code: "malformed_model_output",
        retryable: false,
        messageIncludes: ["top-level JSON objects"]
      });
      expect(built.inferenceCalls()).toBe(1);
    });

    it("classifies a schema-invalid response as malformed_model_output naming the failed schema path", async () => {
      const spec = ROLE_SPECS[role];
      const built = buildMatrixSubject(role, {
        inferenceOutcomes: [completedOutcome(JSON.stringify(spec.schemaInvalidFields()))]
      });
      const events = await collect(built.harness.start(built.invocation));

      expectFailureTerminal(events, {
        code: "malformed_model_output",
        retryable: false,
        messageIncludes: ["failed schema admission at", spec.schemaInvalidPath]
      });
      expect(built.inferenceCalls()).toBe(1);
    });

    it("fails closed on a credential-shaped response without echoing the vector — refused at the PORT boundary, because a contracts-conformant inference result cannot carry credential-shaped content at all (rejects an engine that completes, echoes the vector, or emits partial evidence when the port refuses the provider's result)", async () => {
      // T11 matrix finding, lead-ruled: `ModelInferenceResultSchema.content` is a
      // SafeMetadataString, so the credential-shaped text never reaches structured-output
      // admission through a conformant port — the port's own result validation throws inside
      // `inference.run` and the engine classifies the throw. The surfaced code is therefore the
      // classifier's `native_agent_internal_error` (fail-closed, retryable false), NOT
      // `model_output_unsafe`; whether a port-boundary result refusal deserves its own taxonomy
      // code (`provider_error` is the natural candidate) is recorded in the stream report as an
      // S3/I1-facing question, never worked around locally. The `model_output_unsafe` sweep
      // remains live defense-in-depth, pinned below through direct admission.
      const spec = ROLE_SPECS[role];
      const built = buildMatrixSubject(role, {
        inferenceOutcomes: [completedOutcome(JSON.stringify(spec.credentialShapedFields()))]
      });
      const events = await collect(built.harness.start(built.invocation));

      const failed = expectFailureTerminal(events, {
        code: "native_agent_internal_error",
        retryable: false
      });
      expect(failed.message).not.toContain(AWS_KEY_SHAPED);
      expect(built.inferenceCalls()).toBe(1);

      // Positive companion: when credential-shaped content DOES reach admission (the layer the
      // port cannot express), the sweep still refuses it as model_output_unsafe.
      const sweep = await admitStructuredOutput({
        role,
        schema: z.object({ note: z.string() }).strict(),
        responseText: JSON.stringify({ note: `leaked ${AWS_KEY_SHAPED}` }),
        policy: { maxRepairAttempts: 0 },
        reask: async () => {
          throw new Error("The sweep must not re-ask over unsafe output.");
        }
      });
      expect(sweep.kind).toBe("rejected");
      if (sweep.kind !== "rejected") throw new TypeError("unreachable");
      expect(sweep.failure.code).toBe("model_output_unsafe");
      expect(sweep.failure.message).not.toContain(AWS_KEY_SHAPED);
    });

    it('classifies a schema-valid response the provider truncated (finishReason "length") as malformed_model_output, never a partial document', async () => {
      const spec = ROLE_SPECS[role];
      const built = buildMatrixSubject(role, {
        inferenceOutcomes: [lengthTruncatedOutcome(JSON.stringify(spec.validModelFields()))]
      });
      const events = await collect(built.harness.start(built.invocation));

      expectFailureTerminal(events, { code: "malformed_model_output", retryable: false });
      expect(built.inferenceCalls()).toBe(1);
    });
  });

  it("fails closed with native_invocation_incomplete before any route resolution or model call when workItemId is missing", async () => {
    const built = buildMatrixSubject(role, { omitWorkItemId: true });
    expect(built.invocation.workItemId).toBeUndefined();

    const events = await collect(built.harness.start(built.invocation));

    expect(events).toHaveLength(1);
    expectFailureTerminal(events, { code: "native_invocation_incomplete", retryable: false });
    expect(built.router.requests).toHaveLength(0);
    expect(built.inferenceCalls()).toBe(0);
  });

  it("ends in exactly one interrupted event on host loss mid-role, evidence digests preserved, no lifecycle terminal", async () => {
    let releaseHostLoss = (): void => {};
    const hostLoss = new Promise<void>((resolve) => {
      releaseHostLoss = resolve;
    });
    const built = buildMatrixSubject(role, { hangInference: true, hostLoss });
    built.onInferenceRun(() => {
      releaseHostLoss();
    });

    const events = await collect(built.harness.start(built.invocation));

    const interrupted = requireLastEvent(events, "interrupted");
    expect(ofType(events, "interrupted")).toHaveLength(1);
    expect(interrupted.retryable).toBe(true);
    expect(interrupted.evidenceDigests.length).toBeGreaterThan(0);
    for (const digest of interrupted.evidenceDigests) {
      expect(digest).toMatch(EVIDENCE_DIGEST_PATTERN);
    }
    expect(ofType(events, "completed")).toEqual([]);
    expect(ofType(events, "failed")).toEqual([]);
    expect(ofType(events, "cancelled")).toEqual([]);
    expect(built.inferenceCalls()).toBe(1);
  });

  it("ends in a cancelled terminal on cancellation mid-role, with no completed event", async () => {
    const built = buildMatrixSubject(role, { hangInference: true });
    built.onInferenceRun(() => {
      void built.harness.cancel(built.cancelRequest);
    });

    const events = await collect(built.harness.start(built.invocation));

    requireLastEvent(events, "cancelled");
    expect(ofType(events, "cancelled")).toHaveLength(1);
    expect(ofType(events, "completed")).toEqual([]);
    expect(ofType(events, "failed")).toEqual([]);
    expect(built.inferenceCalls()).toBe(1);
  });
});
