import { describe, expect, it } from "vitest";

import {
  AgentInvocationRequestSchema,
  ModelCatalogEntrySchema,
  ModelRouteSchema,
  PlanDocumentSchema,
  StationProvenanceSchema,
  admitPlanDocument,
  digestPlanDocument,
  createId,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type ModelRouteSelection,
  type ModelRouterPort,
  type PlanDocument,
  type StationProvenance
} from "@autostack/contracts";
import {
  createFakeModelInference,
  createFakeModelRouter,
  type FakeModelInference,
  type FakeModelInferenceOutcome,
  type FakeModelInferenceResultTemplate,
  type FakeModelRouteDeclaration,
  type FakeModelRouter,
  type FakeModelRouterOutcome
} from "@autostack/domain/testing";

import type { NativeContextReader } from "../src/context-assembly.js";
import type { ContextScope } from "../src/context-scope.js";
import { admitPlanEvidence, digestPlanEvidence } from "../src/evidence.js";
import {
  createNativeHarness,
  type NativeAgentHarness,
  type NativeHarnessConfig
} from "../src/native-harness.js";
import { NATIVE_PROMPTS } from "../src/prompts/index.js";
import { PLAN_ROLE_CONFIG } from "../src/roles/plan-role.js";

/**
 * Task 9 (plan Step 1): the planner role as DATA, consumed by the generic engine. The digest is
 * the point of this role — S4 verifies approval staleness against `planDigest` — so every case
 * here ultimately defends one rule: the digest is computed by `digestPlanDocument` over the
 * canonical fields and by nothing else.
 *
 * Phase-2 module surface these tests pin:
 *
 * - `src/roles/plan-role.ts` exports `PLAN_ROLE_CONFIG`, the plan entry of `NativeRoleConfig`:
 *   stage `"plan"`, `requiredCapabilities: ["text", "structured_output"]` (the T8-inherited
 *   formalization obligation — the charter default pair, replacing the interim
 *   `["structured_output"]` placeholder pin), `maxOutputTokens: 32_768`, the narrowed
 *   model-authored schema carrying the plan's object-level refinements (at least one
 *   `required: true` command, and the role-added shell-honesty refinement — see below), and an
 *   evidence pipeline over the contracts helpers.
 * - `buildDocument` computes the self-`planDigest` with `digestPlanDocument` before returning;
 *   it is awaited here so a sync or async phase-2 signature both satisfy the pin.
 * - `src/evidence.ts` adds `digestPlanEvidence` (thin over `digestPlanDocument`) and
 *   `admitPlanEvidence` (thin over the ONE-argument `admitPlanDocument`, which recomputes the
 *   digest from canonical fields and rejects a mismatch); NO canonicalization of its own.
 * - `native-session.ts` emits a `plan` detail event — `{planDigest, summary}` from the admitted
 *   document — between the echoed `message` and the `completed` terminal, for the plan role ONLY;
 *   `completed.evidenceDigests` is `[thatSamePlanDigest]`.
 * - The engine rejects a model response naming a `credentialRefId` outside the INVOCATION's
 *   `credentialRefIds` (the authorized set the contract already carries, default `[]`) as
 *   `malformed_model_output`: a plan may request a credential, but never widen the run's grant.
 *
 * Discovery pinned below: `PlanDocumentSchema` itself PERMITS shell syntax inside `executable`
 * regardless of `usesShell` (`SafeMetadataStringSchema` refuses only credential-shaped text), so
 * the usesShell-honesty refusal must be a refinement the ROLE adds to its narrowed schema — the
 * same lead ruling that put triage's duplicates refinement on the narrowed schema in T8.
 */

const FIXED_NOW = "2026-08-30T12:00:00.000Z";

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));
const ENVIRONMENT_ID = createId("environment", uuid(4));
const WORK_ITEM_ID = createId("workItem", uuid(5));
/** The credential the fake ROUTE transport uses; never requested by any plan in this suite. */
const ROUTE_CREDENTIAL_REF_ID = createId("credentialRef", uuid(6));
/** The credential the produced PLAN requests; authorized by the default invocation. */
const PLAN_CREDENTIAL_REF_ID = createId("credentialRef", uuid(7));

const IN_SCOPE_PATH = "docs/plan-brief.md";
const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };
const ADAPTER_ID = "native.plan.unit";
const ROUTE_REF = "native.plan.route";
const PLAN_PROMPT_REF = "autostack.native.plan";
/** The ceiling `PLAN_ROLE_CONFIG.maxOutputTokens` pins; the config test ties the two together. */
const PLAN_MAX_OUTPUT_TOKENS = 32_768;
/** A shell pipeline smuggled into `executable`; only honest under `usesShell: true`. */
const SMUGGLED_SHELL_EXECUTABLE = "pnpm test && pnpm build";

const ROUTE_DECLARATION: FakeModelRouteDeclaration = {
  route: ModelRouteSchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    displayName: "Fake plan route",
    transport: {
      kind: "vercel_ai_gateway",
      gatewayModel: "fake/plan-model",
      credentialRefId: ROUTE_CREDENTIAL_REF_ID
    },
    enabled: true
  }),
  catalogEntry: ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    providerModel: "fake/plan-model",
    displayName: "Fake plan model",
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

const REPORTED_TOKENS = {
  input: { state: "reported", value: 900 },
  output: { state: "reported", value: 410 },
  cachedInput: { state: "unknown" },
  reasoning: { state: "unknown" }
} as const;

const resultTemplate = (content: string): FakeModelInferenceResultTemplate => ({
  content,
  actual: { provider: "fake-provider", model: "fake/plan-model" },
  tokens: {
    input: { ...REPORTED_TOKENS.input },
    output: { ...REPORTED_TOKENS.output },
    cachedInput: { state: "unknown" },
    reasoning: { state: "unknown" }
  },
  cost: { state: "unknown" },
  finishReason: "stop",
  latencyMs: 11
});

const completedOutcome = (content: string): FakeModelInferenceOutcome => ({
  kind: "completed",
  result: resultTemplate(content)
});

/** An honest verification command list: executable + args, no shell, one required check. */
const honestVerificationCommands = (): readonly Record<string, unknown>[] => [
  { executable: "pnpm", args: ["test"], usesShell: false, required: true },
  { executable: "pnpm", args: ["build"], usesShell: false, required: false }
];

/** The model-authored subset the plan prompt asks for; identity and digest are never offered. */
const planModelFields = (): Record<string, unknown> => ({
  summary:
    "Sum the checkout line items first and round the discounted total once, so invoice totals stop drifting by one cent.",
  acceptanceCriteria: ["Invoice totals equal the sum of line items to the cent."],
  affectedAreas: ["src/checkout/totals.ts"],
  risks: [
    {
      severity: "medium",
      summary: "Historical invoices were computed under the drifting rounding rule."
    }
  ],
  verificationCommands: honestVerificationCommands(),
  requiredPermissions: [{ kind: "filesystem_write", detail: "Edit the checkout totals module." }],
  requiredCredentialRefIds: [PLAN_CREDENTIAL_REF_ID]
});

/** A complete, well-formed triage response for the companion triage session in this suite. */
const triageModelFields = (): Record<string, unknown> => ({
  taskType: "bug",
  priority: "high",
  complexity: "small",
  actionable: true,
  rationale: "The checkout totals module rounds each discount before summing line items.",
  duplicates: []
});

const expectedProducedBy = (): StationProvenance =>
  StationProvenanceSchema.parse({
    adapterId: ADAPTER_ID,
    promptRef: PLAN_PROMPT_REF,
    promptVersion: "1",
    routeRef: ROUTE_REF
  });

/**
 * The document the phase-2 engine must produce: invocation identity + admitted model fields +
 * `producedAt` from the injected constant clock + `producedBy` naming prompt, adapter, and route,
 * with `planDigest` computed by `digestPlanDocument` over the canonical fields. The placeholder
 * digest used for the first parse is legitimate because `canonicalizePlanDocumentForDigest`
 * EXCLUDES the self-field — the digest of the canonical fields is the same whatever it holds.
 */
const expectedPlanDocument = async (
  overrides: Record<string, unknown> = {}
): Promise<PlanDocument> => {
  const canonicalSource = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    ...planModelFields(),
    producedAt: FIXED_NOW,
    producedBy: expectedProducedBy(),
    ...overrides,
    planDigest: "0".repeat(64)
  };
  const planDigest = await digestPlanDocument(canonicalSource);
  return PlanDocumentSchema.parse({ ...canonicalSource, planDigest });
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

interface PlanBuildOptions {
  readonly role?: "plan" | "triage";
  readonly inferenceOutcomes?: readonly FakeModelInferenceOutcome[];
  readonly routerOutcomes?: readonly FakeModelRouterOutcome[];
  /** The invocation's authorized credential set; omitted -> the contract's default `[]`. */
  readonly authorizedCredentialRefIds?: readonly string[];
}

interface BuiltPlanHarness {
  readonly harness: NativeAgentHarness;
  readonly invocation: AgentInvocationRequest;
  readonly inference: FakeModelInference;
  readonly router: FakeModelRouter;
  /** Every `ModelRouteSelection` the router RETURNED, captured at the port boundary. */
  readonly selections: readonly ModelRouteSelection[];
}

let issuedSubjects = 0;

const buildPlanHarness = (options: PlanBuildOptions = {}): BuiltPlanHarness => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const role = options.role ?? "plan";
  const now = (): string => FIXED_NOW;
  let issuedRefs = 0;

  const config: NativeHarnessConfig = {
    adapterId: ADAPTER_ID,
    role,
    session: { resumable: false, steerable: false, interactive: false },
    permissioned: false,
    context: {
      paths: [IN_SCOPE_PATH],
      scope: DOCS_SCOPE,
      limits: { maxFiles: 8, maxBytes: 65_536 }
    }
  };

  const inference = createFakeModelInference({
    outcomes: options.inferenceOutcomes ?? [completedOutcome(JSON.stringify(planModelFields()))],
    now
  });
  const router = createFakeModelRouter({
    catalog: [ROUTE_DECLARATION],
    outcomes: options.routerOutcomes ?? [ROUTE_OUTCOME],
    now
  });

  // The fake router records the CONTEXTS it was resolved with (`router.requests`) but not the
  // selections it returned; this delegating port captures those, so the threading assertion can
  // compare the inference request's `selection` to the EXACT object the router handed back.
  const selections: ModelRouteSelection[] = [];
  const observedRouter: ModelRouterPort = {
    resolve: async (context) => {
      const selection = await router.resolve(context);
      selections.push(selection);
      return selection;
    },
    getRoute: (routeRef) => router.getRoute(routeRef),
    recordUsage: (usage) => router.recordUsage(usage)
  };

  const harness = createNativeHarness(config, {
    router: observedRouter,
    inference,
    reader: defaultReader(),
    roleInputs: { forInvocation: async () => [] },
    now,
    newProviderSessionRef: () => `native.session.plan.${subject}`,
    newRef: () => {
      issuedRefs += 1;
      return `native.ref.plan.${subject}.${issuedRefs}`;
    },
    structuredOutput: { maxRepairAttempts: 0 }
  });

  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `plan:${subject}:start`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workItemId: WORK_ITEM_ID,
    stageRunId: STAGE_RUN_ID,
    agentSessionId: createId("agentSession", uuid(7_000 + subject)),
    environmentId: ENVIRONMENT_ID,
    adapterId: ADAPTER_ID,
    objective: "Plan the fix for the reported checkout rounding defect.",
    cwd: "/workspace/factory",
    inputEvidenceDigests: ["2".repeat(64)],
    ...(options.authorizedCredentialRefIds === undefined
      ? {}
      : { credentialRefIds: options.authorizedCredentialRefIds })
  });

  return {
    harness,
    invocation,
    inference,
    router,
    get selections() {
      return [...selections];
    }
  };
};

/** The default completing plan harness: the invocation authorizes the requested credential. */
const buildCompletingPlanHarness = (
  options: Omit<PlanBuildOptions, "authorizedCredentialRefIds"> = {}
): BuiltPlanHarness =>
  buildPlanHarness({ ...options, authorizedCredentialRefIds: [PLAN_CREDENTIAL_REF_ID] });

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

const eventTypes = (events: readonly AgentSessionStreamEvent[]): readonly string[] =>
  events.map((event) => event.type);

const noCompletedWasEmitted = (events: readonly AgentSessionStreamEvent[]): void => {
  expect(events.filter((event) => event.type === "completed")).toEqual([]);
};

const planEventsOf = (
  events: readonly AgentSessionStreamEvent[]
): readonly StreamEventOf<"plan">[] =>
  events.filter((event): event is StreamEventOf<"plan"> => event.type === "plan");

describe("plan route discipline", () => {
  it('resolves the plan route with stage "plan" and requiredCapabilities ["text", "structured_output"] — the T8-inherited formalization pin (rejects the interim structured_output-only placeholder capability set and a role that bills routing under another stage)', async () => {
    const built = buildCompletingPlanHarness();
    const events = await collect(built.harness.start(built.invocation));

    // Positive companion: the session is a real completed plan, not an empty stream.
    expect(events.at(-1)?.type).toBe("completed");

    expect(built.router.requests).toHaveLength(1);
    const context = built.router.requests[0];
    expect(context?.stage).toBe("plan");
    expect(context?.requiredCapabilities).toEqual(["text", "structured_output"]);
  });

  it('threads the exact ModelRouteSelection the router returned into the inference request, with responseFormat "json" and the plan output ceiling 32768 (rejects a role that calls inference without resolving first, rebuilds a selection of its own, or borrows another role\'s ceiling)', async () => {
    const built = buildCompletingPlanHarness();
    const events = await collect(built.harness.start(built.invocation));
    expect(events.at(-1)?.type).toBe("completed");

    expect(built.selections).toHaveLength(1);
    expect(built.inference.requests).toHaveLength(1);
    const request = built.inference.requests[0];
    expect(request?.selection).toEqual(built.selections[0]);
    expect(request?.options.responseFormat).toBe("json");
    expect(request?.options.maxOutputTokens).toBe(PLAN_MAX_OUTPUT_TOKENS);
  });
});

describe("the plan evidence pipeline through the harness", () => {
  it("completes with evidenceDigests [await digestPlanDocument(document)] and a document admitting through the ONE-argument admitPlanDocument, which recomputes the digest from canonical fields (rejects the placeholder native-structured-output digest domain and an engine computing planDigest by any local rule)", async () => {
    const built = buildCompletingPlanHarness();
    const events = await collect(built.harness.start(built.invocation));

    expect(eventTypes(events)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "usage",
      "message",
      "plan",
      "completed"
    ]);

    // Usage is verbatim from the inference result: reported figures kept, unknowns stay unknown.
    const usage = events.find((event) => event.type === "usage");
    if (usage === undefined || usage.type !== "usage") {
      throw new TypeError("The plan session emitted no usage event.");
    }
    expect(usage.tokens).toEqual(REPORTED_TOKENS);
    expect(usage.cost).toEqual({ state: "unknown" });
    expect(usage.model).toBe("fake/plan-model");

    const completed = requireLastEvent(events, "completed");
    const document = await expectedPlanDocument();
    expect(completed.evidenceDigests).toEqual([document.planDigest]);
    expect(completed.evidenceDigests).toEqual([await digestPlanDocument(document)]);

    // The strongest available admission: ONE argument, digest recomputed from canonical fields.
    await expect(admitPlanDocument(document)).resolves.toEqual(document);
  });

  it("emits exactly one plan detail event after the document exists, carrying the SAME planDigest the completion carries and the document's summary, on a harness whose descriptor declares structuredPlans true (rejects an engine that emits no plan event, several, one with a digest of its own, or a summary of its own)", async () => {
    const built = buildCompletingPlanHarness();
    expect(built.harness.descriptor.capabilities.structuredPlans).toBe(true);

    const events = await collect(built.harness.start(built.invocation));
    const completed = requireLastEvent(events, "completed");
    const document = await expectedPlanDocument();

    const planEvents = planEventsOf(events);
    expect(planEvents).toHaveLength(1);
    const planEvent = planEvents[0];
    if (planEvent === undefined) {
      throw new TypeError("The plan session emitted no plan event.");
    }
    expect(planEvent.planDigest).toBe(document.planDigest);
    expect(completed.evidenceDigests).toContain(planEvent.planDigest);
    expect(planEvent.summary).toBe(document.summary);

    // After the echoed document, before the terminal: the event announces evidence that exists.
    const messageIndex = events.findIndex((event) => event.type === "message");
    expect(messageIndex).toBeGreaterThan(-1);
    expect(events.indexOf(planEvent)).toBeGreaterThan(messageIndex);
  });

  it("emits ZERO plan events from a completing TRIAGE session, whose descriptor declares structuredPlans false — the T6 carry-forward companion that keeps the plan-event guard discriminating (rejects an engine that announces a plan for every role)", async () => {
    const built = buildPlanHarness({
      role: "triage",
      inferenceOutcomes: [completedOutcome(JSON.stringify(triageModelFields()))]
    });
    expect(built.harness.descriptor.capabilities.structuredPlans).toBe(false);

    const events = await collect(built.harness.start(built.invocation));
    // Positive companion: a real completed triage session, not an empty or failed stream.
    expect(events.length).toBeGreaterThan(1);
    expect(events.at(-1)?.type).toBe("completed");
    expect(planEventsOf(events)).toEqual([]);
  });

  it("is admission, not trust: mutating one canonical field (summary) after digesting makes admitPlanDocument reject, while the untampered document admits in the same breath (rejects an admission that compares nothing, and a digest that fails to cover the approved content)", async () => {
    const document = await expectedPlanDocument();
    await expect(admitPlanDocument(document)).resolves.toEqual(document);

    const tampered = {
      ...document,
      summary: "Round each discount per line item, exactly as the code does today."
    };
    await expect(admitPlanDocument(tampered)).rejects.toBeInstanceOf(TypeError);
  });

  it("excludes producedAt from the plan digest: re-dating the record leaves the digest unchanged, while an identical fresh document digests identically (rejects a canonicalization that hashes record metadata into what approval staleness is measured against)", async () => {
    const document = await expectedPlanDocument();
    const base = await digestPlanDocument(document);
    // Positive companion: the digest is a function of the canonical fields alone.
    expect(await digestPlanDocument(await expectedPlanDocument())).toBe(base);

    const reDated = { ...document, producedAt: "2026-08-31T09:00:00.000Z" };
    expect(await digestPlanDocument(reDated)).toBe(base);
  });

  it("excludes producedBy from the plan digest — 0.12's ruling, the EXACT OPPOSITE of T8's triage rule and T10's review rule, which both digest provenance: a prompt bump must not revoke an outstanding plan approval (rejects an evidence wrapper that copies the triage rule into the plan domain)", async () => {
    const document = await expectedPlanDocument();
    const base = await digestPlanDocument(document);

    const reProduced = {
      ...document,
      producedBy: { ...expectedProducedBy(), promptVersion: "2" }
    };
    expect(await digestPlanDocument(reProduced)).toBe(base);
    // The re-produced document still ADMITS under its unchanged self-digest: byte-identical
    // content under a new prompt version is the same approved plan.
    await expect(admitPlanDocument(reProduced)).resolves.toEqual(
      PlanDocumentSchema.parse(reProduced)
    );
  });

  it("computes planDigest itself and never accepts one from the model: a response smuggling a planDigest field is rejected as malformed_model_output by the strict narrowed schema (rejects an engine whose output schema offers the self-digest to untrusted output)", async () => {
    const built = buildCompletingPlanHarness({
      inferenceOutcomes: [
        completedOutcome(JSON.stringify({ ...planModelFields(), planDigest: "3".repeat(64) }))
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    // Positive companions: the model was really asked once, in a session that had already
    // streamed its context reads and usage before the rejection.
    expect(built.inference.requests).toHaveLength(1);
    expect(eventTypes(events)).toEqual(["started", "tool_call", "tool_call", "usage", "failed"]);

    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);
    expect(planEventsOf(events)).toEqual([]);
  });
});

describe("plan verification-command honesty", () => {
  it("documents WHY the refusal is the role's: PlanDocumentSchema itself permits shell syntax inside executable under usesShell false, so without a role-level refinement the lie would admit (pins the schema-vs-role discovery that routes this through the T8 narrowed-schema ruling)", () => {
    const dishonest = {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      workItemId: WORK_ITEM_ID,
      runId: RUN_ID,
      ...planModelFields(),
      verificationCommands: [
        { executable: SMUGGLED_SHELL_EXECUTABLE, args: [], usesShell: false, required: true }
      ],
      producedAt: FIXED_NOW,
      producedBy: expectedProducedBy(),
      planDigest: "0".repeat(64)
    };
    // The contract schema is deliberately permissive here; the honesty rule is the role's.
    expect(PlanDocumentSchema.safeParse(dishonest).success).toBe(true);
  });

  it('rejects a response that smuggles shell syntax into executable ("pnpm test && pnpm build") while declaring usesShell false as malformed_model_output — a lie about what will execute (rejects a role that admits the dishonest command because the contract schema permits it)', async () => {
    const built = buildCompletingPlanHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify({
            ...planModelFields(),
            verificationCommands: [
              {
                executable: SMUGGLED_SHELL_EXECUTABLE,
                args: [],
                usesShell: false,
                required: true
              }
            ]
          })
        )
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    expect(built.inference.requests).toHaveLength(1);
    expect(eventTypes(events)).toEqual(["started", "tool_call", "tool_call", "usage", "failed"]);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);
    expect(planEventsOf(events)).toEqual([]);
  });

  it("admits the SAME shell string when the command declares usesShell true — the refusal targets the dishonest declaration, never shell syntax itself (rejects a refinement that blanket-bans metacharacters instead of checking the declaration)", async () => {
    const honestShellCommands = [
      { executable: SMUGGLED_SHELL_EXECUTABLE, args: [], usesShell: true, required: true }
    ];
    const built = buildCompletingPlanHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify({ ...planModelFields(), verificationCommands: honestShellCommands })
        )
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    const completed = requireLastEvent(events, "completed");
    const document = await expectedPlanDocument({ verificationCommands: honestShellCommands });
    expect(completed.evidenceDigests).toEqual([document.planDigest]);
    await expect(admitPlanDocument(document)).resolves.toEqual(document);
  });

  it("rejects a response with no required: true command as malformed_model_output via the carried-over schema refinement, never repairing by promoting one (rejects a narrowed schema that drops PlanDocumentSchema's at-least-one-required refinement, and an engine that silently flips a command to required)", async () => {
    const built = buildCompletingPlanHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify({
            ...planModelFields(),
            verificationCommands: [
              { executable: "pnpm", args: ["test"], usesShell: false, required: false }
            ]
          })
        )
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    // Positive companions: exactly one model call under repair policy 0, after real streamed
    // work; the required-command response elsewhere in this suite completes.
    expect(built.inference.requests).toHaveLength(1);
    expect(eventTypes(events)).toEqual(["started", "tool_call", "tool_call", "usage", "failed"]);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);
  });
});

describe("plan permission and credential scoping", () => {
  it("carries requiredPermissions and requiredCredentialRefIds through into the digested document when the invocation authorizes the requested credential (rejects an engine that drops or rewrites the plan's declared needs)", async () => {
    const built = buildCompletingPlanHarness();
    expect(built.invocation.credentialRefIds).toEqual([PLAN_CREDENTIAL_REF_ID]);

    const events = await collect(built.harness.start(built.invocation));
    const completed = requireLastEvent(events, "completed");

    const document = await expectedPlanDocument();
    expect(document.requiredCredentialRefIds).toEqual([PLAN_CREDENTIAL_REF_ID]);
    expect(document.requiredPermissions).toEqual([
      { kind: "filesystem_write", detail: "Edit the checkout totals module." }
    ]);
    expect(completed.evidenceDigests).toEqual([document.planDigest]);

    // The carried fields are digest-covered: dropping the credential request would be a
    // DIFFERENT plan, observably.
    const withoutCredential = await expectedPlanDocument({ requiredCredentialRefIds: [] });
    expect(withoutCredential.planDigest).not.toBe(document.planDigest);
  });

  it("rejects a plan requesting a credentialRefId the invocation did not authorize as malformed_model_output — the invocation's credentialRefIds (contract default []) is the authorized set, and untrusted output may not widen it (rejects an engine that trusts the model's credential requests, or reads the authorized set from anywhere but the invocation)", async () => {
    // The SAME model response that completes when authorized; only the invocation shrinks.
    const built = buildPlanHarness({});
    expect(built.invocation.credentialRefIds).toEqual([]);

    const events = await collect(built.harness.start(built.invocation));

    // Positive companions: one real model call in a really-streamed session; the authorized
    // twin of this exact response completes in the carry-through case above.
    expect(built.inference.requests).toHaveLength(1);
    expect(events[0]?.type).toBe("started");
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);
    expect(planEventsOf(events)).toEqual([]);
  });
});

describe("the plan role configuration module (phase-2 surface)", () => {
  it("declares route discipline, output ceiling, and the registered prompt artifact as data on PLAN_ROLE_CONFIG (rejects a role left on the placeholder configuration and an engine that keeps routing and ceilings hardcoded in control flow)", () => {
    const config = PLAN_ROLE_CONFIG;
    expect(config.role).toBe("plan");
    expect(config.stage).toBe("plan");
    expect(config.requiredCapabilities).toEqual(["text", "structured_output"]);
    expect(config.maxOutputTokens).toBe(PLAN_MAX_OUTPUT_TOKENS);
    expect(config.prompt).toBe(NATIVE_PROMPTS.plan);
    expect(config.prompt.promptRef).toBe(PLAN_PROMPT_REF);
    expect(config.prompt.version).toBe(1);
  });

  it("refuses every harness-owned field at the narrowed schema while admitting the exact model-authored subset (rejects a schema that lets the model supply identity, the self-digest, provenance, or the record timestamp)", () => {
    const config = PLAN_ROLE_CONFIG;

    // Positive: the exact model-authored subset admits.
    expect(config.outputSchema.safeParse(planModelFields()).success).toBe(true);
    // Negative companions: each harness-owned key is refused by strictness.
    for (const ownedKey of ["workspaceId", "workItemId", "runId", "producedAt", "producedBy"]) {
      expect(
        config.outputSchema.safeParse({ ...planModelFields(), [ownedKey]: "run_forged" }).success
      ).toBe(false);
    }
    expect(
      config.outputSchema.safeParse({ ...planModelFields(), planDigest: "3".repeat(64) }).success
    ).toBe(false);
  });

  it("buildDocument assembles identity from the invocation, content from the admitted model fields, and provenance from the harness, computing the self-planDigest with digestPlanDocument so the result admits one-argument (rejects a builder that leaves the placeholder digest, invents a local rule, or merges model identity)", async () => {
    const config = PLAN_ROLE_CONFIG;
    const document = await config.buildDocument({
      identity: { workspaceId: WORKSPACE_ID, workItemId: WORK_ITEM_ID, runId: RUN_ID },
      modelAuthored: planModelFields(),
      producedAt: FIXED_NOW,
      producedBy: expectedProducedBy()
    });

    expect(PlanDocumentSchema.parse(document)).toEqual(await expectedPlanDocument());
    await expect(admitPlanDocument(document)).resolves.toEqual(document);
  });

  it("digestDocument agrees with digestPlanDocument and EXCLUDES producedBy — the mirror image of the triage config's inclusion test (rejects an evidence wrapper that re-canonicalizes locally or hashes provenance into approval staleness)", async () => {
    const config = PLAN_ROLE_CONFIG;
    const document = await expectedPlanDocument();
    const base = await config.digestDocument(document);

    expect(base).toBe(await digestPlanDocument(document));
    // Positive companion: an identical fresh document digests identically.
    expect(await config.digestDocument(await expectedPlanDocument())).toBe(base);
    // The 0.12 ruling from the plan side: new provenance is the SAME approved plan.
    const reProduced = PlanDocumentSchema.parse({
      ...document,
      producedBy: { ...expectedProducedBy(), promptVersion: "2" }
    });
    expect(await config.digestDocument(reProduced)).toBe(base);
  });

  it("admitDocument recomputes the digest from canonical fields AND holds it against the recorded expectation (rejects an admission that trusts the document's own planDigest without recomputing, or ignores what the completion actually recorded)", async () => {
    const config = PLAN_ROLE_CONFIG;
    const document = await expectedPlanDocument();

    await expect(config.admitDocument(document, document.planDigest)).resolves.toEqual(document);
    // A recorded digest that is not this document's: refused.
    await expect(config.admitDocument(document, "0".repeat(64))).rejects.toBeInstanceOf(TypeError);
    // A tampered document under its stated self-digest: refused by recomputation.
    await expect(
      config.admitDocument(
        { ...document, summary: "A different plan entirely." },
        document.planDigest
      )
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("evidence.ts wraps the contracts plan digest and ONE-argument admission without canonicalizing on its own (rejects a local re-canonicalization that could drift from station-evidence, and a wrapper that demands an upstream digest plan admission does not need)", async () => {
    const document = await expectedPlanDocument();

    expect(await digestPlanEvidence(document)).toBe(await digestPlanDocument(document));
    await expect(admitPlanEvidence(document)).resolves.toEqual(document);
    await expect(
      admitPlanEvidence({ ...document, planDigest: "0".repeat(64) })
    ).rejects.toBeInstanceOf(TypeError);
  });
});
