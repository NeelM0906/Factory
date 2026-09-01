import { describe, expect, it } from "vitest";

import {
  AgentInvocationRequestSchema,
  ModelCatalogEntrySchema,
  ModelInferenceResultSchema,
  ModelRouteSchema,
  StationProvenanceSchema,
  TriageReportSchema,
  admitModelInferenceResult,
  admitTriageReport,
  digestTriageReport,
  createId,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type ModelRouteSelection,
  type ModelRouterPort,
  type StationProvenance,
  type TriageReport
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
import { admitTriageEvidence, digestTriageEvidence } from "../src/evidence.js";
import {
  createNativeHarness,
  type NativeAgentHarness,
  type NativeHarnessConfig
} from "../src/native-harness.js";
import { NATIVE_PROMPTS } from "../src/prompts/index.js";
import { TRIAGE_ROLE_CONFIG } from "../src/roles/triage-role.js";

/**
 * Task 8 (plan Steps 1-2): the triage role as DATA, consumed by the generic engine.
 *
 * Phase-2 module surface these tests pin:
 *
 * - `src/roles/role-config.ts` declares the shared per-role shape `NativeRoleConfig<TDocument>`:
 *   prompt artifact, `ModelRouteContext` stage, `requiredCapabilities`, `maxOutputTokens`, the
 *   narrowed model-authored output schema, `buildDocument` (invocation identity + admitted model
 *   fields + producedAt + producedBy -> the full station document), `digestDocument`, and the
 *   role's admission function — so the three roles differ in data, not control flow.
 * - `src/roles/triage-role.ts` exports `TRIAGE_ROLE_CONFIG`, triage's entry of that shape.
 * - `src/evidence.ts` exports `digestTriageEvidence` and `admitTriageEvidence`, thin wrappers over
 *   the contracts helpers `digestTriageReport` / `admitTriageReport(report, expectedDigest)`; it
 *   defines NO canonicalization of its own.
 * - `native-session.ts` consumes the triage config's evidence pipeline: it builds the report from
 *   the invocation's identity, the admitted model fields, and `producedBy` (adapterId, promptRef,
 *   `String(version)`, resolved routeRef); digests it with `digestTriageReport`; emits `completed`
 *   with `evidenceDigests: [thatDigest]`; and admits via the TWO-argument
 *   `admitTriageReport(report, digest)` before completion. Plan and review follow the same
 *   pipeline; T9/T10 deleted the interim `autostack.native-structured-output` placeholder digest.
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

const IN_SCOPE_PATH = "docs/triage-brief.md";
const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };
const ADAPTER_ID = "native.triage.unit";
const ROUTE_REF = "native.triage.route";
const TRIAGE_PROMPT_REF = "autostack.native.triage";
/** The ceiling `TRIAGE_ROLE_CONFIG.maxOutputTokens` pins; the config test ties the two together. */
const TRIAGE_MAX_OUTPUT_TOKENS = 8_192;
const DUPLICATE_REFERENCE = "tracker:checkout/101";
const CLARIFICATION_REF = "clarify:checkout-rounding";

const ROUTE_DECLARATION: FakeModelRouteDeclaration = {
  route: ModelRouteSchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    displayName: "Fake triage route",
    transport: {
      kind: "vercel_ai_gateway",
      gatewayModel: "fake/triage-model",
      credentialRefId: CREDENTIAL_REF_ID
    },
    enabled: true
  }),
  catalogEntry: ModelCatalogEntrySchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    providerModel: "fake/triage-model",
    displayName: "Fake triage model",
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
  input: { state: "reported", value: 640 },
  output: { state: "reported", value: 220 },
  cachedInput: { state: "unknown" },
  reasoning: { state: "unknown" }
} as const;

const resultTemplate = (content: string): FakeModelInferenceResultTemplate => ({
  content,
  actual: { provider: "fake-provider", model: "fake/triage-model" },
  tokens: {
    input: { ...REPORTED_TOKENS.input },
    output: { ...REPORTED_TOKENS.output },
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

/** The model-authored subset the triage prompt asks for; identity is never offered to the model. */
const triageModelFields = (): Record<string, unknown> => ({
  taskType: "bug",
  priority: "high",
  complexity: "small",
  actionable: true,
  rationale:
    "The checkout totals module rounds each discount before summing line items, so invoice totals drift by one cent.",
  duplicates: [
    {
      kind: "issue",
      reference: DUPLICATE_REFERENCE,
      url: "https://tracker.example/checkout/101",
      confidence: 0.75
    }
  ]
});

const expectedProducedBy = (): StationProvenance =>
  StationProvenanceSchema.parse({
    adapterId: ADAPTER_ID,
    promptRef: TRIAGE_PROMPT_REF,
    promptVersion: "1",
    routeRef: ROUTE_REF
  });

/**
 * The report the phase-2 engine must digest: invocation identity + admitted model fields +
 * `producedAt` from the injected constant clock + `producedBy` naming prompt, adapter, and route.
 */
const expectedTriageReport = (overrides: Record<string, unknown> = {}): TriageReport =>
  TriageReportSchema.parse({
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    ...triageModelFields(),
    producedAt: FIXED_NOW,
    producedBy: expectedProducedBy(),
    ...overrides
  });

const defaultReader = (): NativeContextReader => ({
  list: async () => [IN_SCOPE_PATH],
  read: async ({ path }) => {
    if (path !== IN_SCOPE_PATH) {
      throw new Error(`No workspace file exists at ${path}.`);
    }
    return "The checkout totals module rounds discounts before summing line items.";
  }
});

interface TriageBuildOptions {
  readonly inferenceOutcomes?: readonly FakeModelInferenceOutcome[];
  readonly routerOutcomes?: readonly FakeModelRouterOutcome[];
  readonly maxRepairAttempts?: 0 | 1;
  readonly omitWorkItemId?: boolean;
}

interface BuiltTriageHarness {
  readonly harness: NativeAgentHarness;
  readonly invocation: AgentInvocationRequest;
  readonly inference: FakeModelInference;
  readonly router: FakeModelRouter;
  /** Every `ModelRouteSelection` the router RETURNED, captured at the port boundary. */
  readonly selections: readonly ModelRouteSelection[];
}

let issuedSubjects = 0;

const buildTriageHarness = (options: TriageBuildOptions = {}): BuiltTriageHarness => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const now = (): string => FIXED_NOW;
  let issuedRefs = 0;

  const config: NativeHarnessConfig = {
    adapterId: ADAPTER_ID,
    role: "triage",
    session: { resumable: false, steerable: false, interactive: false },
    permissioned: false,
    context: {
      paths: [IN_SCOPE_PATH],
      scope: DOCS_SCOPE,
      limits: { maxFiles: 8, maxBytes: 65_536 }
    }
  };

  const inference = createFakeModelInference({
    outcomes: options.inferenceOutcomes ?? [completedOutcome(JSON.stringify(triageModelFields()))],
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
    newProviderSessionRef: () => `native.session.triage.${subject}`,
    newRef: () => {
      issuedRefs += 1;
      return `native.ref.triage.${subject}.${issuedRefs}`;
    },
    structuredOutput: { maxRepairAttempts: options.maxRepairAttempts ?? 0 }
  });

  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `triage:${subject}:start`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    ...(options.omitWorkItemId === true ? {} : { workItemId: WORK_ITEM_ID }),
    stageRunId: STAGE_RUN_ID,
    agentSessionId: createId("agentSession", uuid(6_000 + subject)),
    environmentId: ENVIRONMENT_ID,
    adapterId: ADAPTER_ID,
    objective: "Triage the reported checkout rounding defect.",
    cwd: "/workspace/factory",
    inputEvidenceDigests: ["1".repeat(64)]
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

describe("triage route discipline", () => {
  it('resolves the triage route with stage "triage" and requiredCapabilities ["text", "structured_output"] (rejects the interim structured_output-only capability pin and a role that bills routing under another stage)', async () => {
    const built = buildTriageHarness();
    const events = await collect(built.harness.start(built.invocation));

    // Positive companion: the session is a real completed triage, not an empty stream.
    expect(events.at(-1)?.type).toBe("completed");

    expect(built.router.requests).toHaveLength(1);
    const context = built.router.requests[0];
    expect(context?.stage).toBe("triage");
    expect(context?.requiredCapabilities).toEqual(["text", "structured_output"]);
  });

  it('threads the exact ModelRouteSelection the router returned into the inference request, with responseFormat "json" and the triage output ceiling (rejects a role that calls inference without resolving first, rebuilds a selection of its own, or borrows another role\'s ceiling)', async () => {
    const built = buildTriageHarness();
    const events = await collect(built.harness.start(built.invocation));
    expect(events.at(-1)?.type).toBe("completed");

    expect(built.selections).toHaveLength(1);
    expect(built.inference.requests).toHaveLength(1);
    const request = built.inference.requests[0];
    expect(request?.selection).toEqual(built.selections[0]);
    expect(request?.options.responseFormat).toBe("json");
    expect(request?.options.maxOutputTokens).toBe(TRIAGE_MAX_OUTPUT_TOKENS);
  });

  it("records a (request, result) pair admitModelInferenceResult accepts, and admission rejects the same result rebound to a route the request did not resolve (pins the admission the fake applies before content parsing; rejects a role that would accept a cross-route result)", async () => {
    const built = buildTriageHarness();
    const events = await collect(built.harness.start(built.invocation));
    expect(events.at(-1)?.type).toBe("completed");

    const request = built.inference.requests[0];
    if (request === undefined) {
      throw new TypeError("The triage session recorded no inference request.");
    }
    // Reconstruct the exact result the fake returned for this request: the template plus the
    // identity the fake stamps from the request itself and the constant injected clock.
    const result = ModelInferenceResultSchema.parse({
      ...resultTemplate(JSON.stringify(triageModelFields())),
      schemaVersion: 1,
      idempotencyKey: request.idempotencyKey,
      routeRef: request.selection.routeRef,
      completedAt: FIXED_NOW
    });
    // Positive: the recorded binding is one admission accepts.
    expect(admitModelInferenceResult(request, result)).toEqual(result);
    // Negative companion: rebound to a route the request did not resolve, admission refuses.
    expect(() =>
      admitModelInferenceResult(request, { ...result, routeRef: "native.other.route" })
    ).toThrow(TypeError);
  });
});

describe("triage evidence pipeline through the harness", () => {
  it("emits started, the context-read tool_call pair, verbatim usage, message, then completed whose evidenceDigests is [await digestTriageReport(report)] admitted by the two-argument admitTriageReport (rejects the placeholder native-structured-output digest domain and an engine that digests model fields without identity or provenance)", async () => {
    const built = buildTriageHarness();
    const events = await collect(built.harness.start(built.invocation));

    expect(eventTypes(events)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "usage",
      "message",
      "completed"
    ]);

    // Usage is verbatim from the inference result: reported figures kept, unknowns stay unknown.
    const usage = events.find((event) => event.type === "usage");
    if (usage === undefined || usage.type !== "usage") {
      throw new TypeError("The triage session emitted no usage event.");
    }
    expect(usage.tokens).toEqual(REPORTED_TOKENS);
    expect(usage.cost).toEqual({ state: "unknown" });
    expect(usage.model).toBe("fake/triage-model");

    const completed = requireLastEvent(events, "completed");
    const report = expectedTriageReport();
    expect(completed.evidenceDigests).toEqual([await digestTriageReport(report)]);

    // The report admits through the digest-compare form against the EMITTED digest.
    const emitted = completed.evidenceDigests[0];
    if (emitted === undefined) {
      throw new TypeError("The completed event carried no evidence digest.");
    }
    await expect(admitTriageReport(report, emitted)).resolves.toEqual(report);
  });

  it("takes workspaceId, workItemId, and runId from the invocation alone: a response supplying any identity field is rejected as malformed_model_output (rejects an engine whose narrowed schema lets model-supplied identity through to be merged)", async () => {
    const built = buildTriageHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify({ ...triageModelFields(), workspaceId: WORKSPACE_ID, runId: RUN_ID })
        )
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    // Positive companions: the rejection came from admission, after a real model call, in a
    // session that had already streamed its context reads.
    expect(built.inference.requests).toHaveLength(1);
    expect(eventTypes(events)).toEqual(["started", "tool_call", "tool_call", "usage", "failed"]);

    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);
  });

  it("fails closed with native_invocation_incomplete before any route resolution or model call when the invocation lacks workItemId (rejects an engine that resolves or invokes first, and a report builder that invents identity)", async () => {
    const built = buildTriageHarness({ omitWorkItemId: true });
    expect(built.invocation.workItemId).toBeUndefined();

    const events = await collect(built.harness.start(built.invocation));
    expect(events).toHaveLength(1);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("native_invocation_incomplete");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);

    expect(built.router.requests).toHaveLength(0);
    expect(built.inference.requests).toHaveLength(0);
  });

  it("rejects a response naming the same duplicate reference twice as malformed_model_output (rejects a narrowed model-authored schema that drops TriageReportSchema's duplicates refinement and an engine that silently deduplicates)", async () => {
    const fields = triageModelFields();
    const built = buildTriageHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify({
            ...fields,
            duplicates: [
              { kind: "issue", reference: DUPLICATE_REFERENCE, confidence: 0.75 },
              { kind: "work_item", reference: DUPLICATE_REFERENCE, confidence: 0.5 }
            ]
          })
        )
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    // Positive companion: the model was really asked once and the session streamed real work
    // before the rejection; the well-formed single-duplicate response in this suite completes.
    expect(built.inference.requests).toHaveLength(1);
    expect(events.length).toBeGreaterThan(1);
    expect(events[0]?.type).toBe("started");

    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);
  });

  it('treats actionable: false as a successful triage: a complete report, a completed terminal, and evidence digested over the not-actionable report (rejects an engine that classifies "not actionable" as a failure)', async () => {
    const built = buildTriageHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify({
            ...triageModelFields(),
            actionable: false,
            clarificationRef: CLARIFICATION_REF
          })
        )
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    // Positive shape first: the session COMPLETED; no failed event exists anywhere.
    expect(events.filter((event) => event.type === "failed")).toEqual([]);
    const completed = requireLastEvent(events, "completed");

    const report = expectedTriageReport({
      actionable: false,
      clarificationRef: CLARIFICATION_REF
    });
    const digest = await digestTriageReport(report);
    expect(completed.evidenceDigests).toEqual([digest]);
    await expect(admitTriageReport(report, digest)).resolves.toEqual(report);
  });

  it("carries a clarificationRef through unchanged into the digested report (rejects an engine that drops or rewrites the model's clarificationRef)", async () => {
    const built = buildTriageHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify({ ...triageModelFields(), clarificationRef: CLARIFICATION_REF })
        )
      ]
    });
    const events = await collect(built.harness.start(built.invocation));
    const completed = requireLastEvent(events, "completed");

    const withRef = expectedTriageReport({ clarificationRef: CLARIFICATION_REF });
    const withoutRef = expectedTriageReport();
    const digestWith = await digestTriageReport(withRef);
    // Positive/negative pairing: the ref is digest-covered, so carrying it and dropping it are
    // observably different documents.
    expect(digestWith).not.toBe(await digestTriageReport(withoutRef));
    expect(completed.evidenceDigests).toEqual([digestWith]);
  });
});

describe("triage failure paths", () => {
  it("terminates failed with the exact capability_unavailable code and retryable false when resolve refuses (rejects an engine that renames the taxonomy code, invents retryability, or completes without a route)", async () => {
    const built = buildTriageHarness({
      routerOutcomes: [
        {
          kind: "failure",
          failure: {
            code: "capability_unavailable",
            message: "No declared route offers every required capability.",
            retryable: false
          }
        }
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    // Positive companion: real prior events existed — the failure came after context assembly.
    expect(eventTypes(events)).toEqual(["started", "tool_call", "tool_call", "failed"]);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("capability_unavailable");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);
    expect(built.inference.requests).toHaveLength(0);
  });

  it("terminates failed with retryable true when inference.run is rate limited (rejects an engine that marks a retryable provider limit terminal, or retries past the scripted outcome)", async () => {
    const built = buildTriageHarness({
      inferenceOutcomes: [
        {
          kind: "failure",
          failure: {
            code: "rate_limited",
            message: "The upstream provider rate limited the routed request.",
            retryable: true
          }
        }
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    expect(eventTypes(events)).toEqual(["started", "tool_call", "tool_call", "failed"]);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("rate_limited");
    expect(failed.retryable).toBe(true);
    noCompletedWasEmitted(events);
    expect(built.inference.requests).toHaveLength(1);
  });

  it("re-asks exactly once under maxRepairAttempts 1 — two recorded inference requests — then fails malformed_model_output (rejects a repair loop that never re-asks or re-asks unbounded; the fake's script exhaustion makes over-asking loud)", async () => {
    const built = buildTriageHarness({
      maxRepairAttempts: 1,
      inferenceOutcomes: [
        completedOutcome("The rounding defect narrative, with no JSON object at all."),
        completedOutcome("Still prose; still no JSON object.")
      ]
    });
    const events = await collect(built.harness.start(built.invocation));

    expect(built.inference.requests).toHaveLength(2);
    // Positive companion: both model calls really ran — each reported its usage verbatim.
    expect(eventTypes(events)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "usage",
      "usage",
      "failed"
    ]);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);
  });
});

describe("the triage role configuration module (phase-2 surface)", () => {
  it("declares route discipline, output ceiling, and the registered prompt artifact as data on TRIAGE_ROLE_CONFIG (rejects an engine that keeps routing and ceilings hardcoded in control flow, so the roles differ in code instead of data)", async () => {
    const config = TRIAGE_ROLE_CONFIG;
    expect(config.role).toBe("triage");
    expect(config.stage).toBe("triage");
    expect(config.requiredCapabilities).toEqual(["text", "structured_output"]);
    expect(config.maxOutputTokens).toBe(TRIAGE_MAX_OUTPUT_TOKENS);
    expect(config.prompt).toBe(NATIVE_PROMPTS.triage);
    expect(config.prompt.promptRef).toBe(TRIAGE_PROMPT_REF);
    expect(config.prompt.version).toBe(1);
  });

  it("builds the report from invocation identity, admitted model fields, and provenance, while the narrowed schema refuses model-supplied identity keys (rejects a builder that merges model identity and a schema that lets identity through)", async () => {
    const config = TRIAGE_ROLE_CONFIG;

    // Positive: the exact model-authored subset admits.
    expect(config.outputSchema.safeParse(triageModelFields()).success).toBe(true);
    // Negative companions: each identity key the harness owns is refused by strictness.
    for (const identityKey of ["workspaceId", "workItemId", "runId"]) {
      expect(
        config.outputSchema.safeParse({ ...triageModelFields(), [identityKey]: "run_forged" })
          .success
      ).toBe(false);
    }

    const document = config.buildDocument({
      identity: { workspaceId: WORKSPACE_ID, workItemId: WORK_ITEM_ID, runId: RUN_ID },
      modelAuthored: triageModelFields(),
      producedAt: FIXED_NOW,
      producedBy: expectedProducedBy()
    });
    expect(TriageReportSchema.parse(document)).toEqual(expectedTriageReport());
  });

  it("digestDocument covers producedBy: mutating provenance changes the digest — the mirror of T9's plan-document exclusion (rejects an evidence wrapper that copies the plan rule and strips provenance before hashing)", async () => {
    const config = TRIAGE_ROLE_CONFIG;
    const report = expectedTriageReport();
    const base = await config.digestDocument(report);

    // The wrapper defines no canonicalization of its own: it agrees with the contracts helper.
    expect(base).toBe(await digestTriageReport(report));
    // Positive companion: an identical fresh report digests identically.
    expect(await config.digestDocument(expectedTriageReport())).toBe(base);
    // The 0.12 ruling: producedBy is INSIDE the triage digest, so new provenance is new evidence.
    const reProduced = expectedTriageReport({
      producedBy: { ...expectedProducedBy(), promptVersion: "2" }
    });
    expect(await config.digestDocument(reProduced)).not.toBe(base);
  });

  it("admitDocument is the two-argument digest-compare admission (rejects an admission that trusts the report without recomputing its digest, or one that binds triage to an upstream document it does not have)", async () => {
    const config = TRIAGE_ROLE_CONFIG;
    const report = expectedTriageReport();
    const digest = await digestTriageReport(report);

    await expect(config.admitDocument(report, digest)).resolves.toEqual(report);
    await expect(config.admitDocument(report, "0".repeat(64))).rejects.toBeInstanceOf(TypeError);
  });

  it("evidence.ts wraps the contracts triage digest and admission without canonicalizing on its own (rejects a local re-canonicalization that could drift from station-evidence)", async () => {
    const report = expectedTriageReport();
    const digest = await digestTriageReport(report);

    expect(await digestTriageEvidence(report)).toBe(digest);
    await expect(admitTriageEvidence(report, digest)).resolves.toEqual(report);
    await expect(admitTriageEvidence(report, "0".repeat(64))).rejects.toBeInstanceOf(TypeError);
  });
});
