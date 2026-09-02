import { describe, expect, it } from "vitest";

import {
  AgentInvocationRequestSchema,
  ModelCatalogEntrySchema,
  ModelRouteContextSchema,
  ModelRouteSchema,
  PlanDocumentSchema,
  ReviewReportSchema,
  StationProvenanceSchema,
  VerificationReportSchema,
  admitReviewReport,
  digestPlanDocument,
  digestReviewReport,
  digestVerificationReport,
  createId,
  type AgentInvocationRequest,
  type AgentSessionStreamEvent,
  type ModelRouteSelection,
  type ModelRouterPort,
  type PlanDocument,
  type ReviewReport,
  type StationProvenance,
  type VerificationReport
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
import { admitReviewEvidence, digestReviewEvidence } from "../src/evidence.js";
import {
  createNativeHarness,
  type NativeAgentHarness,
  type NativeHarnessConfig,
  type NativeRoleInputsProvider
} from "../src/native-harness.js";
import { NATIVE_PROMPTS } from "../src/prompts/index.js";
import { pickModelAuthoredShape } from "../src/prompts/prompt-artifact.js";
import { REVIEW_ROLE_CONFIG } from "../src/roles/review-role.js";
import type { ReviewRoleDocuments } from "../src/roles/role-inputs.js";

/**
 * Task 10 (plan Step 1): the reviewer role as DATA, consumed by the generic engine. The binding is
 * the point of this role — `ReviewReportSchema` ties the review to one exact plan, one exact
 * verification report, and one exact reviewed diff — so every case here ultimately defends one
 * rule: the reviewer reads ADMITTED evidence of THIS run in an ISOLATED session, and its report
 * admits through the three-argument `admitReviewReport(review, plan, verification)`.
 *
 * Phase-2 module surface these tests pin:
 *
 * - `src/roles/role-inputs.ts` (new): `ReviewRoleDocuments` — the WIDENING of the provider inputs
 *   review finding 2b called for. `NativeRoleInputs` becomes the union
 *   `readonly NativeRoleInput[] | ReviewRoleDocuments`, discriminated by `Array.isArray`: the
 *   bare-array arm is the committed `{label, content}` form the conformance fixture and
 *   runtime-composition already use, so they keep compiling until their phase-2 swap to real
 *   documents. `ReviewRoleDocuments` is `{kind: "review_documents", plan: PlanDocument,
 *   verification: VerificationReport, reviewedDiff: {digest, paths}, context?: NativeRoleInput[]}`.
 *   `reviewedDiff.digest` becomes `reviewedDiffDigest` verbatim; `reviewedDiff.paths` is the run's
 *   touched files — DISCOVERY pinned below: `ReviewReportSchema` carries only the diff's DIGEST
 *   and no path list, so the reviewed-diff paths can only come from the role inputs, which makes
 *   finding-location scoping invocation/input-scoped checking in `validateModelAuthored` style.
 *   `context` entries are extra untyped blobs a composer may carry along; the review role NEVER
 *   renders them (spec §8.2 isolation) — the decoy-transcript test below is their pin.
 * - `harness-config.ts`: `NativeRoleInputsProvider.forInvocation` widens its result to
 *   `Promise<NativeRoleInputs>`; the method name `forInvocation` stays (published to I1).
 * - `role-config.ts`: a new optional config hook `admitRoleInputs(inputs, invocation) =>
 *   Promise<NativeRoleInputs>` — pre-model admission the engine awaits AFTER
 *   `roleInputs.forInvocation` and BEFORE prompt render, route resolution, and the model call.
 *   Any rejection fails the session closed as `native_context_unavailable` with ZERO inference
 *   requests. The review hook admits the plan and verification transitively via the contracts
 *   helpers and refuses documents whose identity is not the INVOCATION's run.
 *   `NativeRoleDocumentInput` gains optional `roleInputs` (the ADMITTED inputs, threaded into
 *   `buildDocument`), and `validateModelAuthored` gains an optional third `roleInputs` parameter
 *   (triage and plan ignore it).
 * - `src/roles/review-role.ts` exports `REVIEW_ROLE_CONFIG`: stage `"isolated_review"`,
 *   `requiredCapabilities: ["text", "structured_output"]` (the T8-inherited formalization,
 *   replacing the interim `["structured_output"]` placeholder pin), `maxOutputTokens: 16_384`,
 *   the narrowed model-authored schema RE-ADDING the two contract refinements
 *   (`pickModelAuthoredShape` drops object-level refinements — T8 lead ruling), and
 *   `buildDocument` copying `planDigest`, `reviewedDiffDigest`, and `verificationReportDigest`
 *   from the ADMITTED inputs, never from model output.
 * - `src/evidence.ts` adds `digestReviewEvidence` (thin over `digestReviewReport` — `producedBy`
 *   INCLUDED, 0.12) and `admitReviewEvidence(report, expectedDigest)` — the TWO-argument
 *   digest-compare form, like triage. That is how the registry's two-argument `admitDocument`
 *   gate composes with the THREE-argument contracts admission: the registry gate re-checks the
 *   recorded digest, while the full transitive admission runs where the inputs live —
 *   `admitRoleInputs` before the model call and `buildDocument` when the report is assembled.
 * - Phase 2 swaps the conformance fixture and runtime-composition placeholder inputs to real
 *   documents in the SAME change as the implementation (the review role stops admitting bare
 *   `{label, content}` entries — pinned below).
 */

const FIXED_NOW = "2026-08-31T12:00:00.000Z";
const PLAN_PRODUCED_AT = "2026-08-31T11:40:00.000Z";
const VERIFICATION_STARTED_AT = "2026-08-31T11:50:00.000Z";
const VERIFICATION_PRODUCED_AT = "2026-08-31T11:55:00.000Z";

const uuid = (value: number): string =>
  `123e4567-e89b-42d3-a456-${String(value).padStart(12, "0")}`;

const WORKSPACE_ID = createId("workspace", uuid(1));
const RUN_ID = createId("run", uuid(2));
const STAGE_RUN_ID = createId("stageRun", uuid(3));
const ENVIRONMENT_ID = createId("environment", uuid(4));
const WORK_ITEM_ID = createId("workItem", uuid(5));
/** The credential the fake ROUTE transport uses; the review role itself requests none. */
const ROUTE_CREDENTIAL_REF_ID = createId("credentialRef", uuid(6));
/** A run this reviewer was NOT invoked for; documents carrying it must be refused. */
const FOREIGN_RUN_ID = createId("run", uuid(20));

const IN_SCOPE_PATH = "docs/review-brief.md";
const DOCS_SCOPE: ContextScope = { includePrefixes: ["docs"] };
const ADAPTER_ID = "native.review.unit";
const ROUTE_REF = "native.review.unit.route";
const REVIEW_PROMPT_REF = "autostack.native.review";
/** The ceiling `REVIEW_ROLE_CONFIG.maxOutputTokens` pins; the config test ties the two together. */
const REVIEW_MAX_OUTPUT_TOKENS = 16_384;

/** The reviewed diff: its digest and the ONLY files this run touched. */
const REVIEWED_DIFF_DIGEST = "5".repeat(64);
const REVIEWED_PATH = "packages/checkout/src/totals.ts";
const REVIEWED_TEST_PATH = "packages/checkout/test/totals.test.ts";
const REVIEWED_DIFF_PATHS = [REVIEWED_PATH, REVIEWED_TEST_PATH] as const;
/** A real-looking workspace path the run never touched; findings may not point at it. */
const OUT_OF_DIFF_PATH = "packages/billing/src/invoice.ts";

/** The plan summary; the isolation test asserts this DID reach the rendered context. */
const PLAN_SUMMARY = "Sum the checkout line items first and round the discounted total once.";
/** Distinctive marker for the decoy implementer transcript; must reach NO rendered message. */
const DECOY_TRANSCRIPT_MARKER = "REVIEW_ISOLATION_DECOY_c4a1";

const ROUTE_DECLARATION: FakeModelRouteDeclaration = {
  route: ModelRouteSchema.parse({
    schemaVersion: 1,
    routeRef: ROUTE_REF,
    displayName: "Fake review route",
    transport: {
      kind: "vercel_ai_gateway",
      gatewayModel: "fake/review-model",
      credentialRefId: ROUTE_CREDENTIAL_REF_ID
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

const resultTemplate = (content: string): FakeModelInferenceResultTemplate => ({
  content,
  actual: { provider: "fake-provider", model: "fake/review-model" },
  tokens: {
    input: { state: "reported", value: 1_400 },
    output: { state: "reported", value: 380 },
    cachedInput: { state: "unknown" },
    reasoning: { state: "unknown" }
  },
  cost: { state: "unknown" },
  finishReason: "stop",
  latencyMs: 13
});

const completedOutcome = (content: string): FakeModelInferenceOutcome => ({
  kind: "completed",
  result: resultTemplate(content)
});

/** A finding WITHOUT a location — the schema permits that, and location scoping must too. */
const unlocatedFinding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  findingRef: "review.finding.rounding-drift",
  severity: "low",
  summary: "The rounding helper still truncates half-cent values on legacy invoices.",
  evidenceDigest: "7".repeat(64),
  ...overrides
});

/** The default finding: low severity, located inside the reviewed diff. */
const reviewFinding = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  unlocatedFinding({
    location: { path: REVIEWED_PATH, startLine: 12, endLine: 18 },
    ...overrides
  });

/** The model-authored subset the review prompt asks for; identity and digests are never offered. */
const reviewModelFields = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  verdict: "approved",
  summary: "The prepared change matches the approved plan; one low-severity nit is recorded.",
  findings: [reviewFinding()],
  ...overrides
});

interface StationRunIdentity {
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly runId: string;
}

const SAME_RUN: StationRunIdentity = {
  workspaceId: WORKSPACE_ID,
  workItemId: WORK_ITEM_ID,
  runId: RUN_ID
};

const FOREIGN_RUN: StationRunIdentity = {
  workspaceId: WORKSPACE_ID,
  workItemId: WORK_ITEM_ID,
  runId: FOREIGN_RUN_ID
};

/** The upstream plan under review, self-digested by the contracts helper so it ADMITS. */
const inputPlanDocument = async (
  identity: StationRunIdentity = SAME_RUN
): Promise<PlanDocument> => {
  const canonicalSource = PlanDocumentSchema.parse({
    schemaVersion: 1,
    ...identity,
    summary: PLAN_SUMMARY,
    acceptanceCriteria: ["Invoice totals equal the sum of line items to the cent."],
    affectedAreas: [REVIEWED_PATH],
    risks: [],
    verificationCommands: [
      { executable: "pnpm", args: ["test"], usesShell: false, required: true }
    ],
    requiredPermissions: [],
    requiredCredentialRefIds: [],
    producedAt: PLAN_PRODUCED_AT,
    planDigest: "0".repeat(64)
  });
  const planDigest = await digestPlanDocument(canonicalSource);
  return PlanDocumentSchema.parse({ ...canonicalSource, planDigest });
};

/** The upstream verification report, bound to the plan it names. */
const inputVerificationReport = (
  plan: PlanDocument,
  overrides: Record<string, unknown> = {}
): VerificationReport =>
  VerificationReportSchema.parse({
    schemaVersion: 1,
    workspaceId: plan.workspaceId,
    workItemId: plan.workItemId,
    runId: plan.runId,
    planDigest: plan.planDigest,
    status: "passed",
    results: [
      {
        command: { executable: "pnpm", args: ["test"], usesShell: false, required: true },
        status: "passed",
        exitCode: 0,
        durationMs: 1_240,
        startedAt: VERIFICATION_STARTED_AT,
        outputDigest: "4".repeat(64)
      }
    ],
    producedAt: VERIFICATION_PRODUCED_AT,
    ...overrides
  });

/** The honest typed documents the provider hands the reviewer for this invocation's run. */
const reviewDocuments = async (
  identity: StationRunIdentity = SAME_RUN
): Promise<ReviewRoleDocuments> => {
  const plan = await inputPlanDocument(identity);
  return {
    kind: "review_documents",
    plan,
    verification: inputVerificationReport(plan),
    reviewedDiff: { digest: REVIEWED_DIFF_DIGEST, paths: [...REVIEWED_DIFF_PATHS] }
  };
};

const expectedProducedBy = (): StationProvenance =>
  StationProvenanceSchema.parse({
    adapterId: ADAPTER_ID,
    promptRef: REVIEW_PROMPT_REF,
    promptVersion: "1",
    routeRef: ROUTE_REF
  });

/**
 * The report the phase-2 engine must produce: invocation identity + admitted model fields +
 * binding digests copied from the ADMITTED inputs (`planDigest` from the plan,
 * `reviewedDiffDigest` from the reviewed diff descriptor, `verificationReportDigest` recomputed
 * by the contracts helper) + `producedAt` from the injected constant clock + `producedBy` naming
 * prompt, adapter, and route.
 */
const expectedReviewReport = async (
  overrides: Record<string, unknown> = {}
): Promise<ReviewReport> => {
  const plan = await inputPlanDocument();
  const verification = inputVerificationReport(plan);
  return ReviewReportSchema.parse({
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    workItemId: WORK_ITEM_ID,
    runId: RUN_ID,
    planDigest: plan.planDigest,
    reviewedDiffDigest: REVIEWED_DIFF_DIGEST,
    verificationReportDigest: await digestVerificationReport(verification),
    ...reviewModelFields(),
    producedAt: FIXED_NOW,
    producedBy: expectedProducedBy(),
    ...overrides
  });
};

const defaultReader = (): NativeContextReader => ({
  list: async () => [IN_SCOPE_PATH],
  read: async ({ path }) => {
    if (path !== IN_SCOPE_PATH) {
      throw new Error(`No workspace file exists at ${path}.`);
    }
    return "The prepared change reworks the checkout discount rounding order.";
  }
});

interface ReviewBuildOptions {
  readonly inferenceOutcomes?: readonly FakeModelInferenceOutcome[];
  readonly roleInputs?: NativeRoleInputsProvider;
}

interface BuiltReviewHarness {
  readonly harness: NativeAgentHarness;
  readonly invocation: AgentInvocationRequest;
  readonly inference: FakeModelInference;
  readonly router: FakeModelRouter;
  /** Every `ModelRouteSelection` the router RETURNED, captured at the port boundary. */
  readonly selections: readonly ModelRouteSelection[];
}

let issuedSubjects = 0;

const buildReviewHarness = (options: ReviewBuildOptions = {}): BuiltReviewHarness => {
  issuedSubjects += 1;
  const subject = issuedSubjects;
  const now = (): string => FIXED_NOW;
  let issuedRefs = 0;

  const config: NativeHarnessConfig = {
    adapterId: ADAPTER_ID,
    role: "review",
    session: { resumable: false, steerable: false, interactive: false },
    permissioned: false,
    context: {
      paths: [IN_SCOPE_PATH],
      scope: DOCS_SCOPE,
      limits: { maxFiles: 8, maxBytes: 65_536 }
    }
  };

  const inference = createFakeModelInference({
    outcomes: options.inferenceOutcomes ?? [completedOutcome(JSON.stringify(reviewModelFields()))],
    now
  });
  const router = createFakeModelRouter({
    catalog: [ROUTE_DECLARATION],
    outcomes: [ROUTE_OUTCOME],
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
    roleInputs: options.roleInputs ?? { forInvocation: async () => reviewDocuments() },
    now,
    newProviderSessionRef: () => `native.session.review.${subject}`,
    newRef: () => {
      issuedRefs += 1;
      return `native.ref.review.${subject}.${issuedRefs}`;
    },
    structuredOutput: { maxRepairAttempts: 0 }
  });

  const invocation = AgentInvocationRequestSchema.parse({
    schemaVersion: 1,
    idempotencyKey: `review:${subject}:start`,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workItemId: WORK_ITEM_ID,
    stageRunId: STAGE_RUN_ID,
    agentSessionId: createId("agentSession", uuid(7_000 + subject)),
    environmentId: ENVIRONMENT_ID,
    adapterId: ADAPTER_ID,
    objective: "Review the prepared fix for the checkout rounding defect.",
    cwd: "/workspace/factory",
    inputEvidenceDigests: ["2".repeat(64)]
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

/** All message contents the fake inference port was actually asked with, across every attempt. */
const renderedMessageContents = (inference: FakeModelInference): readonly string[] =>
  inference.requests.flatMap((request) => request.messages.map((message) => message.content));

describe("review route discipline", () => {
  it('resolves the review route with stage "isolated_review" — the stage that EXISTS on ModelRouteContextSchema, whose enum has no "review"; the name is the point, spec §8.2 isolation — and requiredCapabilities ["text", "structured_output"], the T8-inherited formalization pin (rejects the interim structured_output-only placeholder capability set and a role that bills routing under a stage the contract does not define)', async () => {
    const built = buildReviewHarness();
    const events = await collect(built.harness.start(built.invocation));

    // Positive companion: the session is a real completed review, not an empty stream.
    expect(events.at(-1)?.type).toBe("completed");

    expect(built.router.requests).toHaveLength(1);
    const context = built.router.requests[0];
    expect(context?.stage).toBe("isolated_review");
    expect(context?.requiredCapabilities).toEqual(["text", "structured_output"]);

    // Discovery pin: "review" is not a route stage the contract admits; "isolated_review" is.
    const routeContext = {
      schemaVersion: 1,
      idempotencyKey: "review:stage:discovery",
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      stageRunId: STAGE_RUN_ID,
      requiredCapabilities: []
    };
    expect(
      ModelRouteContextSchema.safeParse({ ...routeContext, stage: "isolated_review" }).success
    ).toBe(true);
    expect(ModelRouteContextSchema.safeParse({ ...routeContext, stage: "review" }).success).toBe(
      false
    );
  });

  it('threads the exact ModelRouteSelection the router returned into the inference request, with responseFormat "json" and the review output ceiling 16384 (rejects a role that calls inference without resolving first, rebuilds a selection of its own, or borrows another role\'s ceiling)', async () => {
    const built = buildReviewHarness();
    const events = await collect(built.harness.start(built.invocation));
    expect(events.at(-1)?.type).toBe("completed");

    expect(built.selections).toHaveLength(1);
    expect(built.inference.requests).toHaveLength(1);
    const request = built.inference.requests[0];
    expect(request?.selection).toEqual(built.selections[0]);
    expect(request?.options.responseFormat).toBe("json");
    expect(request?.options.maxOutputTokens).toBe(REVIEW_MAX_OUTPUT_TOKENS);
  });
});

describe("the review evidence pipeline through the harness", () => {
  it("completes with evidenceDigests [await digestReviewReport(report)] and a report admitting through the THREE-argument admitReviewReport(review, plan, verificationReport), which transitively re-admits both inputs and checks the verification digest — the strongest assertion available (rejects the T6 placeholder native-structured-output digest domain, an engine that lets the model author the binding digests, and a review of stale evidence)", async () => {
    const built = buildReviewHarness();
    const events = await collect(built.harness.start(built.invocation));

    expect(eventTypes(events)).toEqual([
      "started",
      "tool_call",
      "tool_call",
      "usage",
      "message",
      "completed"
    ]);

    const completed = requireLastEvent(events, "completed");
    const report = await expectedReviewReport();
    expect(completed.evidenceDigests).toEqual([await digestReviewReport(report)]);

    // The strongest admission: three arguments, both inputs re-admitted, verification digest
    // recomputed and held against the report's binding field.
    const plan = await inputPlanDocument();
    const verification = inputVerificationReport(plan);
    await expect(admitReviewReport(report, plan, verification)).resolves.toEqual(report);

    // The binding fields came from the ADMITTED inputs, not from model output: the model-authored
    // subset in this run carried no digest at all.
    expect(report.planDigest).toBe(plan.planDigest);
    expect(report.reviewedDiffDigest).toBe(REVIEWED_DIFF_DIGEST);
    expect(report.verificationReportDigest).toBe(await digestVerificationReport(verification));
  });

  it("INCLUDES producedBy in the review digest: re-producing the same reading under a new prompt version CHANGES the digest — the mirror of T9's plan-document exclusion, named as such: a later reading under a different prompt is a different reading (rejects an evidence wrapper that copies the plan rule and strips provenance before hashing)", async () => {
    const report = await expectedReviewReport();
    const base = await digestReviewReport(report);
    // Positive companion: an identical fresh report digests identically.
    expect(await digestReviewReport(await expectedReviewReport())).toBe(base);

    const reProduced = {
      ...report,
      producedBy: { ...expectedProducedBy(), promptVersion: "2" }
    };
    expect(await digestReviewReport(reProduced)).not.toBe(base);
  });
});

describe("pre-model admission of the reviewer's inputs", () => {
  it("admits the provider's documents BEFORE the model call: a provider returning a plan whose digest does not admit fails the session closed with native_context_unavailable and the inference fake received ZERO requests, while the honest provider's session reaches the model once and completes in the same run (rejects an engine that renders unadmitted evidence into the prompt and lets the model call proceed on a tampered plan)", async () => {
    const tampered = buildReviewHarness({
      roleInputs: {
        forInvocation: async () => {
          const documents = await reviewDocuments();
          return {
            ...documents,
            plan: PlanDocumentSchema.parse({
              ...documents.plan,
              summary: "A plan the recorded digest never covered."
            })
          };
        }
      }
    });
    const events = await collect(tampered.harness.start(tampered.invocation));

    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("native_context_unavailable");
    expect(failed.retryable).toBe(false);
    expect(tampered.inference.requests).toHaveLength(0);
    expect(eventTypes(events)).not.toContain("usage");
    noCompletedWasEmitted(events);

    // Positive companion in the same run: the honest provider reaches the model and completes.
    const honest = buildReviewHarness();
    const honestEvents = await collect(honest.harness.start(honest.invocation));
    expect(honestEvents.at(-1)?.type).toBe("completed");
    expect(honest.inference.requests).toHaveLength(1);
  });

  it("refuses a verification report that is not bound to the provided plan (a foreign planDigest) the same way — the pre-model admission is TRANSITIVE over both inputs, exactly as admitReviewReport is (rejects a hook that parses the two documents independently without checking the binding between them)", async () => {
    const built = buildReviewHarness({
      roleInputs: {
        forInvocation: async () => {
          const documents = await reviewDocuments();
          return {
            ...documents,
            verification: inputVerificationReport(documents.plan, { planDigest: "6".repeat(64) })
          };
        }
      }
    });
    const events = await collect(built.harness.start(built.invocation));

    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("native_context_unavailable");
    expect(failed.retryable).toBe(false);
    expect(built.inference.requests).toHaveLength(0);
    noCompletedWasEmitted(events);
  });

  it("refuses documents that belong to a DIFFERENT run — internally consistent, digest-admissible evidence whose identity mismatches the invocation — with native_context_unavailable and zero model calls: the reviewer will not review another run's evidence (rejects a hook that admits the documents against each other but never against the invocation's identity)", async () => {
    const built = buildReviewHarness({
      roleInputs: { forInvocation: async () => reviewDocuments(FOREIGN_RUN) }
    });

    // Discovery companion: the foreign documents ARE mutually admissible — only the run is wrong.
    const foreign = await reviewDocuments(FOREIGN_RUN);
    expect(foreign.plan.runId).not.toBe(RUN_ID);

    const events = await collect(built.harness.start(built.invocation));
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("native_context_unavailable");
    expect(failed.retryable).toBe(false);
    expect(built.inference.requests).toHaveLength(0);
    noCompletedWasEmitted(events);
  });

  it("refuses bare {label, content} context entries for the review role — the reviewer's inputs are TYPED documents, and untyped blobs cannot be admitted as a plan or a verification report (rejects the T6 placeholder wiring the committed conformance fixture still uses; its phase-2 swap to real documents lands with the implementation)", async () => {
    const built = buildReviewHarness({
      roleInputs: {
        forInvocation: async () => [
          {
            label: "prepared-change-summary",
            content: "The prepared change touches packages/checkout/src/totals.ts only."
          }
        ]
      }
    });
    const events = await collect(built.harness.start(built.invocation));

    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("native_context_unavailable");
    expect(failed.retryable).toBe(false);
    expect(built.inference.requests).toHaveLength(0);
    noCompletedWasEmitted(events);
  });
});

describe("review verdict and finding discipline", () => {
  it('rejects verdict "approved" alongside a critical finding as malformed_model_output via the carried-over schema refinement, and NEVER fixes the verdict in either direction: the adjacent changes_requested-with-critical-finding response COMPLETES with its verdict intact (rejects a role that silently downgrades an approval or silently marks a failed review passed — spec §8.2 in both directions)', async () => {
    const criticalFinding = reviewFinding({
      findingRef: "review.finding.dropped-rounding-guard",
      severity: "critical",
      summary: "The change deletes the guard that kept totals from drifting."
    });

    const contradictory = buildReviewHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify(reviewModelFields({ verdict: "approved", findings: [criticalFinding] }))
        )
      ]
    });
    const events = await collect(contradictory.harness.start(contradictory.invocation));

    expect(contradictory.inference.requests).toHaveLength(1);
    expect(eventTypes(events)).toEqual(["started", "tool_call", "tool_call", "usage", "failed"]);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);

    // The adjacent vector: the SAME critical finding under changes_requested is a coherent
    // review and must complete — with the verdict the model authored, not a repaired one.
    const coherentFields = reviewModelFields({
      verdict: "changes_requested",
      findings: [criticalFinding]
    });
    const coherent = buildReviewHarness({
      inferenceOutcomes: [completedOutcome(JSON.stringify(coherentFields))]
    });
    const coherentEvents = await collect(coherent.harness.start(coherent.invocation));
    const completed = requireLastEvent(coherentEvents, "completed");
    const report = await expectedReviewReport(coherentFields);
    expect(report.verdict).toBe("changes_requested");
    expect(completed.evidenceDigests).toEqual([await digestReviewReport(report)]);
  });

  it("rejects duplicate findingRefs as malformed_model_output via the carried-over uniqueness refinement, while two findings under DISTINCT refs complete in the same run (rejects a narrowed schema that dropped ReviewReportSchema's object-level refinements when pickModelAuthoredShape rebuilt it from .shape)", async () => {
    const secondFinding = reviewFinding({
      findingRef: "review.finding.rounding-drift",
      summary: "A second finding smuggled under the first finding's ref.",
      location: { path: REVIEWED_TEST_PATH, startLine: 4, endLine: 9 }
    });
    const duplicated = buildReviewHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify(reviewModelFields({ findings: [reviewFinding(), secondFinding] }))
        )
      ]
    });
    const events = await collect(duplicated.harness.start(duplicated.invocation));

    expect(duplicated.inference.requests).toHaveLength(1);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);

    // Positive companion: the same two findings under distinct refs are a valid report.
    const distinctFields = reviewModelFields({
      findings: [
        reviewFinding(),
        reviewFinding({
          findingRef: "review.finding.test-gap",
          summary: "The new rounding branch has no failing-case test.",
          location: { path: REVIEWED_TEST_PATH, startLine: 4, endLine: 9 }
        })
      ]
    });
    const distinct = buildReviewHarness({
      inferenceOutcomes: [completedOutcome(JSON.stringify(distinctFields))]
    });
    const distinctEvents = await collect(distinct.harness.start(distinct.invocation));
    const completed = requireLastEvent(distinctEvents, "completed");
    expect(completed.evidenceDigests).toEqual([
      await digestReviewReport(await expectedReviewReport(distinctFields))
    ]);
  });

  it("rejects a finding whose location names a file OUTSIDE the reviewed diff's paths as malformed_model_output — the model may not attribute a finding to a file the run never touched, and the path list comes from the ROLE INPUTS' reviewedDiff, the discovery pinned here: ReviewReportSchema carries only the diff's digest, no paths, so this is input-scoped checking the static schema cannot express (rejects a role that trusts model-attributed locations, and one that reads the diff's scope from anywhere but the admitted inputs)", async () => {
    // Discovery: the contract schema itself admits the out-of-diff location — the scoping rule
    // can only live where the reviewed diff's paths live, on the role inputs.
    const strayReport = await expectedReviewReport(
      reviewModelFields({
        findings: [
          reviewFinding({ location: { path: OUT_OF_DIFF_PATH, startLine: 1, endLine: 2 } })
        ]
      })
    );
    expect(ReviewReportSchema.safeParse(strayReport).success).toBe(true);

    const stray = buildReviewHarness({
      inferenceOutcomes: [
        completedOutcome(
          JSON.stringify(
            reviewModelFields({
              findings: [
                reviewFinding({ location: { path: OUT_OF_DIFF_PATH, startLine: 1, endLine: 2 } })
              ]
            })
          )
        )
      ]
    });
    const events = await collect(stray.harness.start(stray.invocation));

    expect(stray.inference.requests).toHaveLength(1);
    const failed = requireLastEvent(events, "failed");
    expect(failed.code).toBe("malformed_model_output");
    expect(failed.retryable).toBe(false);
    noCompletedWasEmitted(events);

    // Positive companion: the SAME finding located inside the reviewed diff completes.
    const inDiff = buildReviewHarness();
    const inDiffEvents = await collect(inDiff.harness.start(inDiff.invocation));
    expect(inDiffEvents.at(-1)?.type).toBe("completed");
  });
});

describe("reviewer isolation from the implementer", () => {
  it("renders NO implementer transcript into the model context: a decoy transcript handed along by the provider (distinctive marker, carried as an untyped context entry) appears in no rendered message, while the plan's summary DID reach the rendered context — the reviewer reads typed admitted documents, never the implementer's hidden reasoning, spec §8.2 (rejects an engine that renders every provider input verbatim the way the context arm does)", async () => {
    const built = buildReviewHarness({
      roleInputs: {
        forInvocation: async () => {
          const documents = await reviewDocuments();
          return {
            ...documents,
            context: [
              {
                label: "implementer-transcript",
                content: `The implementer privately weighed deleting the rounding helper before patching it. ${DECOY_TRANSCRIPT_MARKER}`
              }
            ]
          };
        }
      }
    });
    const events = await collect(built.harness.start(built.invocation));

    // Positive companion: a real completed review whose model call actually happened.
    expect(events.at(-1)?.type).toBe("completed");
    expect(built.inference.requests).toHaveLength(1);

    const contents = renderedMessageContents(built.inference);
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.some((content) => content.includes(DECOY_TRANSCRIPT_MARKER))).toBe(false);
    expect(contents.some((content) => content.includes(PLAN_SUMMARY))).toBe(true);
  });
});

describe("the review role configuration module (phase-2 surface)", () => {
  it("declares route discipline, output ceiling, and the registered prompt artifact as data on REVIEW_ROLE_CONFIG (rejects a role left on the placeholder configuration and an engine that keeps routing and ceilings hardcoded in control flow)", () => {
    const config = REVIEW_ROLE_CONFIG;
    expect(config.role).toBe("review");
    expect(config.stage).toBe("isolated_review");
    expect(config.requiredCapabilities).toEqual(["text", "structured_output"]);
    expect(config.maxOutputTokens).toBe(REVIEW_MAX_OUTPUT_TOKENS);
    expect(config.prompt).toBe(NATIVE_PROMPTS.review);
    expect(config.prompt.promptRef).toBe(REVIEW_PROMPT_REF);
    expect(config.prompt.version).toBe(1);
  });

  it("refuses every harness-owned field at the narrowed schema while admitting the exact model-authored subset (rejects a schema that lets the model supply identity, any of the three binding digests, provenance, or the record timestamp)", () => {
    const config = REVIEW_ROLE_CONFIG;

    // Positive: the exact model-authored subset admits.
    expect(config.outputSchema.safeParse(reviewModelFields()).success).toBe(true);
    // Negative companions: each harness-owned key is refused by strictness.
    for (const ownedKey of ["workspaceId", "workItemId", "runId", "producedAt", "producedBy"]) {
      expect(
        config.outputSchema.safeParse({ ...reviewModelFields(), [ownedKey]: "run_forged" }).success
      ).toBe(false);
    }
    for (const digestKey of ["planDigest", "reviewedDiffDigest", "verificationReportDigest"]) {
      expect(
        config.outputSchema.safeParse({ ...reviewModelFields(), [digestKey]: "3".repeat(64) })
          .success
      ).toBe(false);
    }
  });

  it("documents WHY the verdict and uniqueness refusals are the role's to carry: pickModelAuthoredShape rebuilds from ReviewReportSchema.shape, which DROPS the contract's object-level refinements, so the raw picked shape admits both contradictions and the role's narrowed schema must re-add them — the T8 lead ruling applied to review (rejects a narrowed schema that assumes the contract refinements survived the rebuild)", () => {
    const rawPicked = pickModelAuthoredShape(ReviewReportSchema.shape, [
      "verdict",
      "summary",
      "findings"
    ]);
    const approvedWithCritical = reviewModelFields({
      verdict: "approved",
      findings: [reviewFinding({ severity: "critical" })]
    });
    const duplicatedRefs = reviewModelFields({
      findings: [reviewFinding(), reviewFinding()]
    });

    // Discovery: the rebuild silently sheds both contract refinements.
    expect(rawPicked.safeParse(approvedWithCritical).success).toBe(true);
    expect(rawPicked.safeParse(duplicatedRefs).success).toBe(true);
    // The role's schema carries them back.
    expect(REVIEW_ROLE_CONFIG.outputSchema.safeParse(approvedWithCritical).success).toBe(false);
    expect(REVIEW_ROLE_CONFIG.outputSchema.safeParse(duplicatedRefs).success).toBe(false);
    // Positive companion: the coherent subset still admits through the role's schema.
    expect(REVIEW_ROLE_CONFIG.outputSchema.safeParse(reviewModelFields()).success).toBe(true);
  });

  it("admitRoleInputs admits the honest documents and refuses a tampered plan and a foreign run — the pre-model gate as a config method, receiving the invocation so identity is checked against THIS run (rejects a config without the hook, a hook that trusts the provider, and one that never reads the invocation)", async () => {
    const admitInputs = REVIEW_ROLE_CONFIG.admitRoleInputs;
    if (admitInputs === undefined) {
      throw new Error("The review role must declare pre-model input admission.");
    }
    const { invocation } = buildReviewHarness();
    const documents = await reviewDocuments();

    await expect(admitInputs(documents, invocation)).resolves.toEqual(documents);
    await expect(
      admitInputs(
        {
          ...documents,
          plan: PlanDocumentSchema.parse({
            ...documents.plan,
            summary: "A plan the recorded digest never covered."
          })
        },
        invocation
      )
    ).rejects.toThrow();
    await expect(admitInputs(await reviewDocuments(FOREIGN_RUN), invocation)).rejects.toThrow();
  });

  it("validateModelAuthored scopes finding locations to the admitted reviewedDiff paths as a SET — an unlocated finding and an in-diff finding pass, an out-of-diff location returns the frozen malformed_model_output failure (rejects a validator that requires a location on every finding, reads paths from the report, or surfaces model-supplied text in the failure)", async () => {
    const validate = REVIEW_ROLE_CONFIG.validateModelAuthored;
    if (validate === undefined) {
      throw new Error("The review role must declare input-scoped location validation.");
    }
    const { invocation } = buildReviewHarness();
    const documents = await reviewDocuments();

    expect(validate(reviewModelFields(), invocation, documents)).toBeUndefined();
    expect(
      validate(reviewModelFields({ findings: [unlocatedFinding()] }), invocation, documents)
    ).toBeUndefined();

    const stray = validate(
      reviewModelFields({
        findings: [
          reviewFinding({ location: { path: OUT_OF_DIFF_PATH, startLine: 1, endLine: 2 } })
        ]
      }),
      invocation,
      documents
    );
    expect(stray?.code).toBe("malformed_model_output");
    expect(stray?.retryable).toBe(false);
    expect(stray?.message.includes(OUT_OF_DIFF_PATH)).toBe(false);
  });

  it("buildDocument assembles identity from the invocation, content from the admitted model fields, provenance from the harness, and the three binding digests from the ADMITTED roleInputs, so the result admits three-argument (rejects a builder that leaves the placeholder pipeline, invents digests locally, or lets model fields collide with the bindings)", async () => {
    const config = REVIEW_ROLE_CONFIG;
    const documents = await reviewDocuments();
    const document = await config.buildDocument({
      identity: { workspaceId: WORKSPACE_ID, workItemId: WORK_ITEM_ID, runId: RUN_ID },
      modelAuthored: reviewModelFields(),
      producedAt: FIXED_NOW,
      producedBy: expectedProducedBy(),
      roleInputs: documents
    });

    expect(ReviewReportSchema.parse(document)).toEqual(await expectedReviewReport());
    await expect(
      admitReviewReport(document, documents.plan, documents.verification)
    ).resolves.toEqual(await expectedReviewReport());
  });

  it("digestDocument agrees with digestReviewReport and INCLUDES producedBy — the mirror of T9's plan-config exclusion test (rejects an evidence wrapper that re-canonicalizes locally, keeps the placeholder digest domain, or strips provenance before hashing)", async () => {
    const config = REVIEW_ROLE_CONFIG;
    const report = await expectedReviewReport();
    const base = await config.digestDocument(report);

    expect(base).toBe(await digestReviewReport(report));
    // Positive companion: an identical fresh report digests identically.
    expect(await config.digestDocument(await expectedReviewReport())).toBe(base);
    // The 0.12 ruling from the review side: new provenance is a NEW reading.
    const reProduced = ReviewReportSchema.parse({
      ...report,
      producedBy: { ...expectedProducedBy(), promptVersion: "2" }
    });
    expect(await config.digestDocument(reProduced)).not.toBe(base);
  });

  it("admitDocument keeps the registry's TWO-argument digest-compare shape — recompute digestReviewReport and hold it against the recorded expectation, like triage — because the THREE-argument contracts admission needs the upstream inputs, which live at admitRoleInputs and buildDocument, not at the registry gate (rejects an admission that trusts the document without recomputing, ignores the recorded digest, or demands inputs the gate does not have)", async () => {
    const config = REVIEW_ROLE_CONFIG;
    const report = await expectedReviewReport();
    const recorded = await digestReviewReport(report);

    await expect(config.admitDocument(report, recorded)).resolves.toEqual(report);
    // A recorded digest that is not this report's: refused.
    await expect(config.admitDocument(report, "0".repeat(64))).rejects.toBeInstanceOf(TypeError);
    // A tampered report under the honestly recorded digest: refused by recomputation.
    await expect(
      config.admitDocument({ ...report, summary: "A different reading entirely." }, recorded)
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("evidence.ts wraps the contracts review digest and TWO-argument admission without canonicalizing on its own (rejects a local re-canonicalization that could drift from station-evidence, and a wrapper still on the T6 placeholder native-structured-output domain)", async () => {
    const report = await expectedReviewReport();
    const recorded = await digestReviewReport(report);

    expect(await digestReviewEvidence(report)).toBe(recorded);
    await expect(admitReviewEvidence(report, recorded)).resolves.toEqual(report);
    await expect(admitReviewEvidence(report, "0".repeat(64))).rejects.toBeInstanceOf(TypeError);
  });
});
