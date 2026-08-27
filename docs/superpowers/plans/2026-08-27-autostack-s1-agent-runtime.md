# AutoStack Stream S1 — Agent Runtime and Native Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-08-27
**Stream:** S1 (Wave 1) · **Worktree:** `/Users/zidane/factory-s1` · **Branch:** `codex/milestone-a-s1-agent-runtime` · **Base:** `02e5cff`
**Charter:** `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md` § "Stream S1: Agent runtime and native agent"
**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` §8.2, §8.3, §9.1, §9.4, §10.2, §14.1, §14.4, §15, §16.2
**Contract map:** `docs/development/milestone-a-contract-audit.md` items 1–5, 8–11, 21

**Goal:** Deliver the two packages that make an agent teammate a supervised, normalized, evidence-producing session: `@autostack/agent-runtime` (harness registry with installed/authenticated probing, sequence-ordered session relay, durable interruption marking on host loss, bounded cancellation) and `@autostack/agent-native` (one `AgentHarnessPort` implementation configured into the triage, plan, and review roles, producing schema-valid station evidence from versioned prompts through `ModelRouterPort`, with no provider SDK and no credential anywhere in the stream).

**Architecture:** `agent-runtime` consumes `AgentHarnessPort` and never implements it; `agent-native` implements `AgentHarnessPort` and never consumes another adapter. The one shared primitive is the sequence-ordered event relay, which lives in `agent-runtime` and is imported by `agent-native` (direction: `agent-native` → `agent-runtime`, never the reverse, so the supervisor stays adapter-agnostic). A native session is a supervised producer that writes contract-validated `AgentSessionStreamEvent`s into a relay; `start` and `resume` are readers over that relay, which is what lets `resume` continue the _same_ session rather than replay a transcript into a new one (spec §9.1). Every model response is admitted by a Zod schema before it becomes evidence; a response that fails admission is a classified failure with a code from a fixed table, never a crash and never an unbounded re-ask. Every string that leaves the model and enters an event passes the shared redactor first, and a value that cannot be made safe fails the session closed.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`); pnpm 10.27 workspace; Turborepo 2; Zod 4; Vitest 4 with the shared 80% coverage thresholds.

---

## Escalations — read before Task 6

Per the stream-lead protocol ("if a contract shape blocks you, STOP that task and report"), these are reported with the plan rather than worked around. Tasks 1–5 and 7 are unblocked and proceed regardless; Tasks 6 and 8–11 depend on E1, E2, and E3.

### E1 — BLOCKING, high: no contract port can call a model

`ModelRouterPort` (`packages/contracts/src/model.ts:372`) is `resolve` / `getRoute` / `recordUsage`. It selects a route; nothing in `@autostack/contracts` turns a `routeRef` into a model response. The contract audit's items 6–10 and 21 all describe routing, never inference, and `createFakeModelRouter` (`packages/domain/src/testing/fake-model-router.ts:113`) works around the hole by attaching a scripted `ModelUsageRecord` to `resolve`, as if selecting a route were making a call.

S1 cannot produce a `TriageReport`, `PlanDocument`, or `ReviewReport` without a model response, and turning a `ModelRoute` into a callable model requires the route's `credentialRefId` — which my charter names explicitly as S3's lane ("if you find yourself needing an API key, you have crossed into S3's lane — stop and escalate").

**Proposed append-only addition** to `packages/contracts/src/model.ts`, with a matching `createFakeModelInference` in `@autostack/domain/testing`:

```ts
export const ModelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    text: SafeMetadataStringSchema.max(200_000)
  })
  .strict();

export const ModelResponseFormatSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }).strict(),
  z
    .object({ kind: z.literal("json"), schemaRef: StableRefSchema, jsonSchema: SafeJsonObject })
    .strict()
]);

export const ModelInferenceRequestSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    routeRef: StableRefSchema,
    messages: z.array(ModelMessageSchema).min(1).max(100),
    responseFormat: ModelResponseFormatSchema,
    maxOutputTokens: z.number().int().positive().optional(),
    reasoningLevel: ModelReasoningLevelSchema.optional()
  })
  .strict();

export const ModelInferenceResultSchema = z
  .object({
    schemaVersion: VersionSchema,
    idempotencyKey: IdempotencyKeySchema,
    routeRef: StableRefSchema,
    actual: z
      .object({
        provider: StableRefSchema,
        model: StableRefSchema,
        providerRequestId: StableRefSchema.optional()
      })
      .strict(),
    text: SafeMetadataStringSchema.max(400_000),
    tokens: ModelTokenUsageSchema,
    cost: ModelCostSchema,
    latencyMs: z.number().int().nonnegative(),
    finishReason: z.enum(["stop", "length", "content_filter", "error"]),
    completedAt: TimestampSchema
  })
  .strict();

/** Executes one resolved route. Raises `ModelRoutingError` so the taxonomy survives the call. */
export interface ModelInferencePort {
  generate(request: ModelInferenceRequest): Promise<ModelInferenceResult>;
}
```

Deliberately excluded: model-driven tool calling (see E5) and streaming deltas (no §18 acceptance criterion requires token-level streaming from a native role; the harness streams normalized events, not tokens). `tokens`/`cost` reuse the unknown-preserving unions so §10.2's "missing provider usage is recorded as unknown" holds at the only boundary that knows it.

**If declined:** the fallback is a local `NativeModelInvoker` function type in `agent-native`, wired by I1 to an S3 adapter. That makes an un-reviewed cross-stream interface, which is exactly what the audit's item 21 rationale argues against, so it is the worse option and I am not choosing it unilaterally.

### E2 — BLOCKING for one exit criterion, medium: nothing carries a prompt version into evidence

Spec §16.2 requires a stored version "for every workflow, prompt, policy, adapter, and model route used by a run", and my charter requires "prompts stored as versioned artifacts with a version recorded in produced evidence". `TriageReportSchema`, `PlanDocumentSchema`, and `ReviewReportSchema` are `.strict()` and have no provenance field; `AgentSessionStreamEvent` has none either.

**Proposed append-only addition** to `packages/contracts/src/station-evidence.ts`: an optional `producedBy` on all three documents —

```ts
const StationProvenanceSchema = z
  .object({
    adapterId: StableRefSchema,
    promptRef: StableRefSchema,
    promptVersion: z.number().int().positive(),
    routeRef: StableRefSchema.optional()
  })
  .strict();
```

— left **out** of `canonicalizePlanDocumentForDigest`, on the same reasoning the existing comment gives for `producedAt`: §14.2 invalidates an approval on _material_ change, and re-planning byte-identical content under a new prompt version is not a material change to what the human approved. Adding an optional field to a `.strict()` object is append-only and breaks no existing parse.

**If declined:** I record the provenance in a `structured` `output` event at session start and note the §16.2 obligation as met at the stream level but not on the documents.

### E3 — BLOCKING for triage/review evidence digests, medium: two of the four station documents have no digest helper

`station-evidence.ts` exports `canonicalize`/`digest`/`admit` for `PlanDocument` and `VerificationReport` only. But `AgentSessionEvent.completed.evidenceDigests` requires at least one digest per session, and `ReviewReportSchema` requires a `verificationReportDigest`, so triage and review both need addressable digests. My dispatch is explicit that I must not re-derive canonicalization rules locally.

**Proposed append-only addition:** `canonicalizeTriageReportForDigest` / `digestTriageReport` / `admitTriageReport`, and `canonicalizeReviewReportForDigest` / `digestReviewReport`, mirroring the verification-report rule (cover every field including `producedAt`, since both are evidence of one execution rather than approved content).

**If declined or deferred:** Task 8 and Task 10 stop at the digest step and the roles ship producing documents without self-addressing digests, which would fail my exit criterion. I would rather wait than invent domains.

### E4 — informational: schema names in the charter do not exist

The master plan's S1 exit criteria name `TriageEvidenceSchema`, `PlanEvidenceSchema`, `ReviewEvidenceSchema`. The real exports are `TriageReportSchema`, `PlanDocumentSchema`, `ReviewReportSchema` (`packages/contracts/src/station-evidence.ts:44`, `:90`, `:216`). My dispatch already uses two of the three correct names. This plan binds to the real exports; no action needed beyond noting the drift.

### E5 — design ruling requested, medium: deterministic context assembly instead of model-driven tool calling

Spec §9.4 says the native adapter gives "direct access to AutoStack tools". Milestone A's native roles are all _analysis_ roles (§8.2: triage classifies, plan inspects a read-only checkout, review reads the diff and verification evidence); the role that actually edits a repository is the CLI harness in S2. Supporting model-driven tool calls would require a tool-definition and tool-result round trip in E1's inference contract — a large surface that no §18 acceptance criterion exercises for a native role.

**Proposed:** the harness performs its own bounded, deterministic context assembly through an injected read-only reader, emits a real `tool_call` event pair per read, gates any read outside the declared scope behind a `permission_requested`, and then makes one structured-output model call. The `tool_call` events are honest — the harness did call a tool — and the permission round trip is genuine, not staged for the conformance suite. Requesting confirmation before Task 7.

### E6 — informational: intra-stream package dependency

`@autostack/agent-native` will depend on `@autostack/agent-runtime` for the session relay primitive. `agent-runtime` will never import `agent-native`; the registry is populated by injection, so composition (I1) is the only place the two meet. The alternative — duplicating the relay in both — was rejected as the worse trade.

### E7 — informational: `recordUsage` cannot express unknown usage

`ModelRouterPort.recordUsage` takes `ModelUsageSchema`, whose token counts and cost are exact non-negative integers. The conformance suite requires the harness to emit `usage` events in which unreported figures are `{ state: "unknown" }`, and §10.2 forbids estimating them. The native harness therefore emits unknown-preserving `usage` events and does **not** call `recordUsage`; writing `ModelUsageRecord` (which _can_ express unknowns) is left to whoever owns persistence. Flagging so S3/S4 do not assume S1 writes usage.

---

## Global constraints (inherited; every task holds all of them)

- TypeScript strict. No unchecked `any`, no non-null assertions, no `as` casts that bypass validation, no TODO or placeholder implementations, no disabled tests.
- No provider SDK, no credential, no API key, no network call anywhere in either package — including tests. If a task seems to need one, stop and escalate (E1).
- Every cross-boundary value is Zod-validated. No new public types outside `@autostack/contracts`; the two packages export functions and their own local option types only.
- Every model-produced string passes `redactSensitiveText` before entering an event or a document, and a string that still trips `containsSensitiveMaterial` fails the session closed rather than being emitted.
- Untrusted input (objective text, repository contents, model output) never grants a permission, never selects a route, and never changes a capability declaration (spec §14.1).
- Injected clock (`now: () => string`), injected ID factory, injected inference port, injected reader. No `Date.now()`, no `crypto.randomUUID()`, no `setTimeout` outside an injected timer in production code.
- Failure codes come from fixed exported tables and match `^[a-z][a-z0-9_]{0,63}$` so lifting them into `WorkflowFailure` is a no-op. Error classes carry a non-enumerable `cause`; messages and codes come only from the tables.
- Files stay small and single-concern (200–400 lines typical, 800 hard max), matching `packages/runner-local/src/`.
- TDD per step: write the failing test, run it, observe the stated failure, implement minimally, re-run focused, then run the package's full suite before the task's commit. Conventional-commit message per task.
- Ownership: only `packages/agent-runtime/**`, `packages/agent-native/**`, and this plan file. Any other path is an escalation.

---

## Task 1: Scaffold both packages and build the sequence-ordered session relay

**Files:**

- Create: `packages/agent-runtime/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/agent-native/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/agent-runtime/src/index.ts`
- Create: `packages/agent-runtime/src/errors.ts`
- Create: `packages/agent-runtime/src/session-event-relay.ts`
- Test: `packages/agent-runtime/test/session-event-relay.test.ts`

- [ ] **Step 1: Scaffold the two packages**

Mirror `packages/domain/package.json` exactly in shape. `@autostack/agent-runtime` declares `exports: { ".": "./src/index.ts", "./session": "./src/session/index.ts" }`, dependencies `@autostack/contracts` (workspace) only. `@autostack/agent-native` declares `exports: { ".": "./src/index.ts" }`, dependencies `@autostack/contracts` and `@autostack/agent-runtime` (both workspace). Both get the four standard scripts (`build`, `check`, `test`, `test:coverage`) with `tsc -p tsconfig.json --noEmit` for build and check, `tsconfig.json` extending `../../tsconfig.base.json` with `"types": ["node", "vitest/globals"]` and `include: ["src/**/*.ts", "test/**/*.ts"]`, and a `vitest.config.ts` that re-exports the root shared config unchanged (no `fileParallelism: false` — neither package touches machine-wide resources).

Both are picked up automatically: `pnpm-workspace.yaml` globs `packages/*`, `turbo.json` defines the tasks generically, and CI's ubuntu job uses exclusion filters (`.github/workflows/ci.yml:73`, `:85`), so no root or CI file changes. Verify that claim:

```bash
cd /Users/zidane/factory-s1 && pnpm install && pnpm check --filter @autostack/agent-runtime --filter @autostack/agent-native
```

Expected: both packages resolve and typecheck (empty `index.ts` files).

- [ ] **Step 2: Add the failing relay test**

The relay is the primitive both the supervisor and the native harness need: one producer appends events, many readers consume them in order, and a reader that attaches after the fact still sees everything from its cursor. This is what makes spec §15's "clients resume from event sequence" and §9.1's non-emulated resume implementable.

Write `test/session-event-relay.test.ts` asserting:

1. `append` assigns strictly increasing positive sequence numbers starting at 1 and returns the parsed `AgentSessionStreamEvent`; the caller supplies the event template without `sequence`, `sessionId`, or `occurredAt`, and the relay stamps all three from its construction options.
2. Every appended event is `AgentSessionStreamEventSchema.parse`d — appending a template that fails validation raises and does **not** advance the sequence counter.
3. `read({ after: 0 })` yields every event; `read({ after: n })` yields only events with `sequence > n`.
4. A reader attached before any append blocks (its `next()` stays pending) until an append arrives, then yields it.
5. Appending a lifecycle terminal (`completed` / `failed` / `cancelled`) closes the relay: every open reader ends after delivering the terminal, and a further `append` raises `agent_session_already_terminal`.
6. `interrupted` does **not** close the relay as a terminal, but does mark it interrupted; a subsequent `append` of anything other than nothing raises `agent_session_interrupted`, and readers end after the `interrupted` event with no lifecycle terminal (spec §15, and the conformance suite's evidence case).
7. Two concurrent readers observe identical sequences.
8. `close()` is idempotent and ends open readers.

```bash
pnpm --filter @autostack/agent-runtime test -- session-event-relay.test.ts
```

Expected failure: `Cannot find module '../src/session-event-relay.js'`.

- [ ] **Step 3: Implement the relay**

```ts
export interface SessionEventRelayOptions {
  readonly sessionId: AgentSessionId;
  readonly now: () => string;
  /** Exclusive lower bound on the first sequence number; a resumed session passes its last. */
  readonly startAfter?: number;
}

export type SessionEventTemplate = DistributiveOmit<
  AgentSessionStreamEvent,
  "schemaVersion" | "sessionId" | "sequence" | "occurredAt"
>;

export interface SessionEventRelay {
  readonly state: "open" | "terminal" | "interrupted" | "closed";
  readonly lastSequence: number;
  append(template: SessionEventTemplate): AgentSessionStreamEvent;
  read(options?: { readonly after?: number }): AsyncIterable<AgentSessionStreamEvent>;
  close(): void;
}
```

Buffer every appended event (bounded at 10_000; exceeding it raises `agent_session_stream_overflow` rather than dropping evidence silently). Readers are async generators over the buffer plus a waiter set, exactly the notify/`waitUntil` shape `createFakeAgentHarness` uses (`packages/domain/src/testing/fake-agent-harness.ts:94`) — that shape is already proven against the conformance suite's pause detection.

- [ ] **Step 4: Implement the error table**

`src/errors.ts` exports `AgentRuntimeError extends Error` with `readonly code: WorkflowFailureCode` and `readonly retryable: boolean`, constructed only from a frozen `AGENT_RUNTIME_FAILURES` table keyed by code, each entry giving `{ message, retryable }`. `cause` is attached non-enumerably. Codes in this task: `agent_session_already_terminal`, `agent_session_interrupted`, `agent_session_stream_overflow`, `agent_session_disposed`. Assert in the test that every table key matches `WorkflowFailureCodeSchema` and that `WorkflowFailureSchema.parse` accepts the lifted form of each.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-runtime test && pnpm check --filter @autostack/agent-runtime && pnpm format:check
```

Commit: `feat(agent-runtime): scaffold the package and its sequence-ordered session relay`

---

## Task 2: Harness registry with installed/authenticated probing

**Files:**

- Create: `packages/agent-runtime/src/harness-registration.ts`
- Create: `packages/agent-runtime/src/harness-availability.ts`
- Create: `packages/agent-runtime/src/harness-registry.ts`
- Modify: `packages/agent-runtime/src/index.ts`, `src/errors.ts`
- Test: `packages/agent-runtime/test/harness-registry.test.ts`, `test/harness-availability.test.ts`

- [ ] **Step 1: Add the failing availability test**

A probe reports facts; the registry turns facts into a schema-valid `AgentHarnessProfile`. Assert:

1. A probe returning `{ installed: true, authenticated: true }` produces a profile that `AgentHarnessProfileSchema.parse` accepts, with `checkedAt` from the injected clock.
2. A probe returning the impossible `{ installed: false, authenticated: true }` (which `AgentHarnessProfileSchema`'s refinement rejects, `packages/contracts/src/agent.ts:191`) does not throw out of the registry and does not surface an unvalidated profile: it **fails closed** to `{ installed: false, authenticated: false }` with a `detail` naming the contradiction. A harness lying about itself must not become unusable-by-exception for the whole workbench, and it must never be treated as authenticated.
3. A probe that throws fails closed the same way, with the thrown error's classification in `detail` and the raw error text redacted through `redactSensitiveText` before it reaches `SafeMetadataStringSchema` (a CLI probe's stderr is a classic place for a token to appear).
4. A probe that exceeds its injected timeout budget fails closed with `detail` naming the timeout; the timer is injected, so the test does not sleep.
5. `selection.permissionModes` is empty whenever `descriptor.capabilities.permissions` is false — the schema refuses the alternative, so the registry must not be able to construct it.

```bash
pnpm --filter @autostack/agent-runtime test -- harness-availability.test.ts
```

Expected failure: `Cannot find module '../src/harness-availability.js'`.

- [ ] **Step 2: Add the failing registry test**

```ts
export interface AgentHarnessRegistration {
  readonly harness: AgentHarnessPort & Partial<AgentPermissionResponderPort>;
  readonly selection: AgentHarnessProfile["selection"];
  probe(): Promise<AgentHarnessAvailabilityFacts>;
}

export interface AgentHarnessRegistry {
  register(registration: AgentHarnessRegistration): void;
  get(adapterId: string): AgentHarnessPort & Partial<AgentPermissionResponderPort>;
  listByKind(kind: AgentHarnessKind): readonly AgentHarnessDescriptor[];
  profiles(): Promise<readonly AgentHarnessProfile[]>;
}
```

Assert: registration validates the descriptor and rejects a duplicate `adapterId` (`agent_harness_already_registered`); `get` on an unknown id raises `agent_harness_not_registered`; `listByKind` returns descriptors keyed by `AgentHarnessKind` in registration order and is empty (not an error) for a kind with no adapters; `profiles()` probes every registration concurrently and one failing probe does not prevent the others from reporting; a registration whose harness declares `capabilities.permissions: true` but does not expose `respondToPermission` is rejected at registration time (`agent_harness_capability_mismatch`) — the structural contract rule from `packages/contracts/src/agent.ts:419` becomes a registry invariant, so a dishonest adapter cannot enter the runtime at all; and the mirror case, an adapter exposing `respondToPermission` while declaring `permissions: false`, is rejected too.

Drive all of it with `createFakeAgentHarness` from `@autostack/domain/testing`, configured through its `descriptor` overrides — never a hand-rolled stub, so the registry is tested against the reference implementation.

- [ ] **Step 3: Implement registration, availability, and registry**

Three small files, no cleverness. New failure codes: `agent_harness_already_registered`, `agent_harness_not_registered`, `agent_harness_capability_mismatch`, `agent_harness_probe_failed`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/agent-runtime test && pnpm check --filter @autostack/agent-runtime
```

Commit: `feat(agent-runtime): register harnesses by kind with fail-closed availability probing`

---

## Task 3: Session supervisor — relay, interruption, bounded cancellation

**Files:**

- Create: `packages/agent-runtime/src/session-supervisor.ts`
- Create: `packages/agent-runtime/src/session-interruption.ts`
- Create: `packages/agent-runtime/src/session-snapshot.ts`
- Modify: `packages/agent-runtime/src/index.ts`, `src/errors.ts`
- Test: `packages/agent-runtime/test/session-supervisor.test.ts`, `test/session-cancellation.test.ts`, `test/session-interruption.test.ts`

- [ ] **Step 1: Add the failing supervision test**

```ts
export interface AgentSessionSupervisorDeps {
  readonly registry: AgentHarnessRegistry;
  readonly now: () => string;
  /** Durable sink; a rejection marks the session interrupted rather than reporting success. */
  readonly persist: (events: readonly AgentSessionStreamEvent[]) => Promise<void>;
  readonly cancellationGraceMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Resolves when the host that owns the adapter process is lost (spec §15). */
  readonly hostLoss?: Promise<void>;
}
```

Assert against a `createFakeAgentHarness` subject:

1. `supervise(invocation)` relays every adapter event into the relay, re-validating each through `AgentSessionStreamEventSchema` — an adapter that emits an invalid event terminates the session `failed` with code `agent_event_invalid`, and the invalid event never reaches a reader.
2. Sequence numbers in the relayed stream are strictly increasing and the adapter's own numbering is _not_ trusted: the supervisor re-stamps, so two adapters with different numbering conventions are indistinguishable downstream.
3. `persist` is called with each batch before the events are visible to readers; a rejecting `persist` ends the session `interrupted` (evidence preserved, not `completed`) — "artifact upload failure prevents a stage from reporting success when that artifact is required evidence" (spec §15).
4. `snapshot()` reports `{ state, lastSequence, evidenceDigests }` where state is one of `running | completed | failed | cancelled | interrupted`, and never reports `completed` for a session whose terminal was anything else.
5. A second `supervise` call for the same `agentSessionId` raises `agent_session_already_supervised`.

- [ ] **Step 2: Add the failing cancellation test**

Spec §15: "sends a graceful adapter cancellation, waits a bounded interval, terminates the process or sandbox, records partial artifacts, and marks the run cancelled." Assert:

1. `cancel(reason)` calls `harness.cancel` and, when the adapter emits `cancelled` within the grace budget, the relayed terminal is that `cancelled` event and `snapshot().state === "cancelled"`.
2. When the adapter never emits a terminal, the supervisor stops waiting after exactly `cancellationGraceMs` (measured against the injected `sleep`, not a real timer), appends its own `cancelled` event, and disposes the registration. The test asserts the injected sleep was awaited with exactly the configured budget — a hard-coded or unbounded wait fails here.
3. Cancellation after a terminal is a no-op that neither throws nor appends a second terminal.
4. A `completed` event that arrives after cancellation was issued is dropped, not relayed: a cancelled session must never end in the success shape.

- [ ] **Step 3: Add the failing interruption test**

Assert: when `hostLoss` resolves mid-session, the supervisor appends exactly one `interrupted` event carrying the digests of the evidence observed so far (`evidenceDigests` has `min(1)`, so a session with no evidence yet contributes the digest of its own partial transcript, computed with `digestVersionedValue("autostack.agent-session-transcript", …)`); the stream then ends with **no** lifecycle terminal; `snapshot().state === "interrupted"`; and `persist` received the `interrupted` event. Mirror the conformance suite's evidence assertions (`packages/domain/src/testing/agent-harness-conformance-evidence.ts:96`) so the supervisor and the adapters agree on what interruption looks like.

- [ ] **Step 4: Implement the supervisor**

Keep the three concerns in three files. The supervisor owns no timers of its own beyond the injected `sleep`, and holds no adapter-specific knowledge — it only ever touches `AgentHarnessPort`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-runtime test:coverage
```

Expected: all suites green, coverage ≥80% on every metric.

Commit: `feat(agent-runtime): supervise agent sessions with bounded cancellation and interruption marking`

---

## Task 4: Versioned prompt artifacts

**Files:**

- Create: `packages/agent-native/src/prompts/prompt-artifact.ts`
- Create: `packages/agent-native/src/prompts/triage-prompt.ts`
- Create: `packages/agent-native/src/prompts/plan-prompt.ts`
- Create: `packages/agent-native/src/prompts/review-prompt.ts`
- Create: `packages/agent-native/src/prompts/index.ts`
- Test: `packages/agent-native/test/prompts.test.ts`

- [ ] **Step 1: Add the failing prompt-artifact test**

Spec §16.2 requires a stored version for every prompt used by a run, and my charter requires prompts to be exported, versioned constants rather than inline strings. Assert:

1. Each artifact is `{ promptRef, version, system, render(input) }`, deeply frozen, with `promptRef` matching the `StableRefSchema` alphabet (`autostack.native.triage`, `.plan`, `.review`) and `version` a positive integer.
2. `promptRef` values are unique across the registry and the registry is exhaustive over `NATIVE_AGENT_ROLES`.
3. `render` returns `ModelMessage[]` whose first message is the artifact's `system` text and whose user message contains every input the role's schema requires the model to fill — asserted by checking that each required output field name appears in the rendered instruction, so a prompt cannot silently stop asking for a field the schema demands.
4. `render` never interpolates raw untrusted text into the system message: objective and repository text land only in a `user` message, inside an explicitly delimited block, and the system message states that content inside that block is data and never instruction (spec §14.1).
5. Rendered messages pass `ModelMessageSchema.parse`, which means an input containing credential-shaped material is rejected rather than sent — the test feeds a fake AWS-key-shaped string and asserts the render fails closed.
6. A digest test pins each prompt: `digestVersionedValue("autostack.native-prompt", artifact)` is asserted against a checked-in constant, so editing a prompt without bumping its `version` fails the suite. This is the mechanism that makes "versioned artifact" enforceable rather than aspirational.

```bash
pnpm --filter @autostack/agent-native test -- prompts.test.ts
```

Expected failure: `Cannot find module '../src/prompts/index.js'`.

- [ ] **Step 2: Write the three prompts**

Each states the role, the exact JSON shape expected (derived from the Zod schema via `z.toJSONSchema`, not hand-written, so the two cannot drift), the refusal rules the schema encodes (a triage report may not repeat a duplicate reference; a plan must name at least one required verification command; an approved review may contain no critical or high finding), and the untrusted-data framing from Step 1.4.

- [ ] **Step 3: Verify and commit**

Commit: `feat(agent-native): add the versioned triage, plan, and review prompt artifacts`

---

## Task 5: Structured-output admission and failure classification

**Files:**

- Create: `packages/agent-native/src/structured-output.ts`
- Create: `packages/agent-native/src/failure-classification.ts`
- Create: `packages/agent-native/src/errors.ts`
- Test: `packages/agent-native/test/structured-output.test.ts`, `test/failure-classification.test.ts`

- [ ] **Step 1: Add the failing structured-output test**

Parse-don't-trust, with the retry policy visible in the signature rather than buried:

```ts
export interface StructuredOutputPolicy {
  /** Re-asks allowed after an admission failure. 0 or 1; the policy is a ceiling, not a loop. */
  readonly maxRepairAttempts: 0 | 1;
}

export type StructuredOutputOutcome<T> =
  | { readonly kind: "admitted"; readonly value: T; readonly attempts: number }
  | { readonly kind: "rejected"; readonly failure: NativeAgentFailure; readonly attempts: number };
```

Assert:

1. Well-formed JSON matching the schema is admitted on attempt 1.
2. Text that is not JSON at all is rejected with code `malformed_model_output`, `retryable: false`, and the failure message names the role and the parse position — never the model's raw text, which is untrusted and may be enormous.
3. Valid JSON that fails the Zod schema is rejected with the same code, and the failure carries the _schema paths_ that failed (`issue.path.join(".")`), not the offending values.
4. A response wrapped in a markdown fence is admitted after fence stripping; a response with prose before and after a single JSON object is admitted; a response with two top-level JSON objects is **rejected**, because guessing which one the model meant is exactly the trust this discipline exists to withhold.
5. With `maxRepairAttempts: 1`, one admission failure triggers exactly one re-ask carrying the schema paths that failed, and a second failure is terminal — asserted by counting inference calls, so a silent retry loop cannot pass.
6. With `maxRepairAttempts: 0`, no re-ask happens at all.
7. An admitted value whose string fields trip `containsSensitiveMaterial` is rejected with `model_output_unsafe`, not sanitized into acceptance.

- [ ] **Step 2: Add the failing classification test**

A frozen table maps every `ModelRoutingFailureCode` to a native failure. Assert:

1. The table is exhaustive over `MODEL_ROUTING_FAILURE_CODES` — a test iterates the exported const array, so adding a taxonomy code makes this fail rather than fall through to a default.
2. `retryable` is preserved from the `ModelRoutingError`, never recomputed: the taxonomy's refinement (`packages/contracts/src/model.ts:274`) already forbids a retryable `budget_exceeded`, and re-deriving it locally would be a second source of truth.
3. Every native code matches `^[a-z][a-z0-9_]{0,63}$` and `WorkflowFailureSchema.parse` accepts its lifted form — the same normalization identity the conformance suite asserts.
4. A non-`ModelRoutingError` throwable classifies as `native_agent_internal_error`, `retryable: false`, with its message drawn from the table and never from the throwable — and with the original attached as a non-enumerable `cause`.
5. Codes are distinct from messages (the conformance suite asserts `code !== message`).

Native codes: `malformed_model_output`, `model_output_unsafe`, `native_agent_internal_error`, `native_context_unavailable`, `native_permission_denied`, plus the five taxonomy codes carried through unchanged.

- [ ] **Step 3: Implement both, then verify and commit**

Commit: `feat(agent-native): admit structured model output and classify native failures`

---

## Task 6 — GATED ON E1: native harness core and the conformance suite

**Files:**

- Create: `packages/agent-native/src/native-harness.ts`
- Create: `packages/agent-native/src/native-session.ts`
- Create: `packages/agent-native/src/harness-config.ts`
- Modify: `packages/agent-native/src/index.ts`
- Test: `packages/agent-native/test/fixtures/native-harness-fixture.ts`
- Test: `packages/agent-native/test/fixtures/async-native-harness-fixture.ts`
- Test: `packages/agent-native/test/native-harness-conformance.test.ts`
- Test: `packages/agent-native/test/native-harness.test.ts`

Do not start until E1 is resolved and the base branch carries the inference contract (or its ruled alternative). If it is resolved as proposed, rebase first and re-run `pnpm check` before Step 1.

- [ ] **Step 1: Add the conformance fixture and the failing suite run**

This is the exit criterion, so it lands here rather than at the end. Write `test/native-harness-conformance.test.ts` as:

```ts
describeAgentHarnessConformance("native agent harness", nativeHarnessConformanceFixture);
describeAgentHarnessConformance(
  "native agent harness over an asynchronous transport",
  asyncNativeHarnessConformanceFixture
);
```

The async fixture is a macrotask decorator over the in-process one, mirroring `packages/domain/test/fixtures/async-agent-harness.ts` (it is a test fixture in another package, so it is re-implemented rather than imported; the duplication is deliberate and noted in a comment). The suite must pass identically against both — that is the standing guard that the harness's pause behaviour is event-driven rather than calibrated to microtask timing.

The fixture builds each of the five scenarios from a _scripted inference fake_, not from a scripted harness: `completes` scripts one successful structured response whose usage leaves `cachedInput`, `reasoning`, and `cost` unknown; `fails` scripts a `ModelRoutingError` with code `provider_error`; `pauses` scripts a role whose context assembly needs a steer before it proceeds; `requests_permission` scripts a context read outside the declared scope, so the permission gate is genuine; `interrupted` resolves the injected host-loss signal after the first evidence-bearing event. The full-capability subject configures `{ resumable: true, steerable: true, permissioned: true }`; the minimal one configures all three false and gets no permissioned tool.

```bash
pnpm --filter @autostack/agent-native test -- native-harness-conformance.test.ts
```

Expected failure: `Cannot find module '../src/native-harness.js'`.

- [ ] **Step 2: Implement the harness core**

```ts
export interface NativeHarnessConfig {
  readonly adapterId: string;
  readonly role: NativeAgentRole;
  readonly session: { readonly resumable: boolean; readonly steerable: boolean };
  readonly permissioned: boolean;
}

export interface NativeHarnessDeps {
  readonly router: ModelRouterPort;
  readonly inference: ModelInferencePort;
  readonly reader: NativeContextReader;
  readonly now: () => string;
  readonly newProviderSessionRef: () => string;
  readonly structuredOutput: StructuredOutputPolicy;
  readonly hostLoss?: Promise<void>;
}

export const createNativeHarness: (
  config: NativeHarnessConfig,
  deps: NativeHarnessDeps
) => AgentHarnessPort & Partial<AgentPermissionResponderPort>;
```

The descriptor is _derived_, never handed in: `kind: "native"`, `capabilities: { resume: config.session.resumable, steering: config.session.steerable, permissions: config.permissioned, structuredPlans: config.role === "plan" }`. `respondToPermission` is spread onto the returned object only when `config.permissioned` is true, exactly as the reference fake does (`packages/domain/src/testing/fake-agent-harness.ts:292`), so descriptor honesty is structural.

`start` creates the session's relay and returns `relay.read()`; the session engine runs as a supervised producer independent of the reader. `resume` requires `capabilities.resume`, requires the same `sessionId`, requires the session to be neither cancelled nor disposed, and returns `relay.read({ after: <last sequence the caller observed> })` over the _same_ relay — the continuation of one session, not a replay into a new one (spec §9.1). `steer` requires `capabilities.steering` and pushes the instruction into the engine's queue; the engine makes the instruction text observable in a later event, which is what the capability suite asserts (`agent-harness-conformance-capabilities.ts:100`).

- [ ] **Step 3: Add the harness unit tests the conformance suite does not reach**

`start` twice on one harness raises; `steer` on a session that has terminated raises; a disposed harness refuses `start`, `resume`, `steer`, `cancel`, and `respondToPermission`; the descriptor for each of the three roles is asserted field by field (in particular `structuredPlans` false for triage and review, and a corresponding assertion that neither ever emits a `plan` event).

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/agent-native test && pnpm check --filter @autostack/agent-native
```

Expected: both conformance runs green, unmodified suite.

Commit: `feat(agent-native): implement the native agent harness against the conformance suite`

---

## Task 7 — GATED ON E5: bounded context assembly with permission gating

**Files:**

- Create: `packages/agent-native/src/context-assembly.ts`
- Create: `packages/agent-native/src/context-scope.ts`
- Test: `packages/agent-native/test/context-assembly.test.ts`

- [ ] **Step 1: Add the failing context test**

```ts
export interface NativeContextReader {
  list(request: { readonly prefix: string }): Promise<readonly string[]>;
  read(request: { readonly path: string }): Promise<string>;
}
```

Assert:

1. Every path the reader is asked for passes `RelativeWorkspacePathSchema` first; an absolute path, a traversal, or a NUL byte is rejected before the reader is called at all (the reader is never the security boundary).
2. Each read emits a `tool_call` pair — `phase: "started"` then `"completed"` — with a stable `toolCallRef` and `name: "read_file"`; a failing read emits `phase: "failed"` and classifies as `native_context_unavailable`.
3. A read inside the invocation's declared scope proceeds without a permission request; a read outside it emits `permission_requested` with an `allow_once`/`deny_once` option pair and blocks until the decision arrives. An `allow` proceeds and emits `permission_resolved`; a `deny` skips the read, emits `permission_resolved`, and continues with the context it has — a denied permission is a normal outcome, not a failure (spec §14.1: untrusted input never grants permission, and denial must be safe).
4. Assembly is bounded: at most `maxFiles` reads and `maxBytes` total; exceeding either truncates deterministically (sorted path order, never reader order) and records the truncation in the assembled context so the prompt can say the context is partial. Two runs over the same reader produce byte-identical context.
5. Every file's content passes `redactSensitiveText` before entering the prompt.

- [ ] **Step 2: Implement, verify, commit**

Commit: `feat(agent-native): assemble bounded role context behind the permission gate`

---

## Task 8 — GATED ON E1/E2/E3: the triage role

**Files:**

- Create: `packages/agent-native/src/roles/role-config.ts`
- Create: `packages/agent-native/src/roles/triage-role.ts`
- Create: `packages/agent-native/src/evidence.ts`
- Test: `packages/agent-native/test/triage-role.test.ts`

- [ ] **Step 1: Add the failing triage test**

Assert, with a scripted inference fake and the Wave 0 `createFakeModelRouter`:

1. The role resolves its route through `ModelRouterPort.resolve` with `stage: "triage"` and `requiredCapabilities: ["text", "structured_output"]`, and calls `inference.generate` with the resolved `routeRef` — a role that calls inference without resolving first fails the test.
2. A well-formed model response becomes a `TriageReportSchema`-valid `TriageReport` carrying the run identity from the invocation (never from the model — a model that returns a different `runId` is rejected, because untrusted output must not redirect evidence to another run).
3. `producedBy` records the triage prompt's `promptRef` and `version` and the resolved `routeRef` (E2).
4. The session emits, in order: `started`, `message`, `tool_call` pairs for any context reads, `usage` (unknown-preserving, taken from the inference result verbatim), and `completed` whose `evidenceDigests` contains `await digestTriageReport(report)` (E3).
5. Duplicate detection round-trips: a response naming two duplicates with the same `reference` is rejected by the schema refinement and classified `malformed_model_output`, not silently deduplicated.
6. `actionable: false` still produces a complete report and a `completed` terminal; triage deciding "not actionable" is a successful triage.
7. A `clarificationRef` in the response is carried through unchanged.

- [ ] **Step 2: Add the failing failure-path tests**

A `capability_unavailable` from `resolve` terminates the session `failed` with that exact code and `retryable: false`; a `rate_limited` from `generate` terminates `failed` with `retryable: true`; a malformed response with `maxRepairAttempts: 1` produces exactly two `inference.generate` calls and then a `failed` terminal with `malformed_model_output`. Each asserts the terminal is the last event and that no `completed` was emitted.

- [ ] **Step 3: Implement `role-config.ts`, `triage-role.ts`, `evidence.ts`; verify; commit**

`role-config.ts` holds the shared shape (prompt artifact, `ModelRouteContext` stage, output schema, admission function, digest function) so the three roles differ in data, not in control flow. `evidence.ts` wraps the contracts' digest helpers — it defines no canonicalization of its own.

Commit: `feat(agent-native): produce triage reports through the routed native role`

---

## Task 9 — GATED ON E1/E2: the planner role

**Files:**

- Create: `packages/agent-native/src/roles/plan-role.ts`
- Test: `packages/agent-native/test/plan-role.test.ts`

- [ ] **Step 1: Add the failing planner test**

The digest is the point of this role: S4 verifies approval staleness against it.

1. The produced document admits through `admitPlanDocument` — the strongest available assertion, since it recomputes the digest from the canonical fields and rejects a mismatch.
2. The role computes `planDigest` with `digestPlanDocument` and never with a local rule; a test mutates one canonical field (`summary`) and asserts admission now fails, and mutates one excluded field (`producedAt`) and asserts the digest is **unchanged** — pinning the material-change semantics the contract comment describes (`packages/contracts/src/station-evidence.ts:280`).
3. A `plan` detail event is emitted carrying that same `planDigest` and a summary; this is the only role whose descriptor declares `structuredPlans: true`.
4. `verificationCommands` are `executable` + `args`; a response whose command carries a shell string in `executable` (`"pnpm test && pnpm build"`) is rejected — the schema permits `usesShell`, but a command that smuggles shell syntax into `executable` while declaring `usesShell: false` is a lie about what will execute, and the role rejects it as `malformed_model_output`.
5. A response with no `required: true` command is rejected by the schema refinement and classified, not repaired by promoting one.
6. `requiredPermissions` and `requiredCredentialRefIds` are carried through; a `credentialRefId` the invocation did not authorize is rejected — a plan may _request_ a credential, but the request is scoped to what the run was given, and untrusted output may not widen it.
7. `completed.evidenceDigests` contains the `planDigest`.

- [ ] **Step 2: Implement, verify, commit**

Commit: `feat(agent-native): produce digest-admissible plan documents from the planner role`

---

## Task 10 — GATED ON E1/E2/E3: the reviewer role

**Files:**

- Create: `packages/agent-native/src/roles/review-role.ts`
- Test: `packages/agent-native/test/review-role.test.ts`

- [ ] **Step 1: Add the failing reviewer test**

`ReviewReportSchema` binds the review to a plan and a verification report, so the role's inputs include both.

1. The produced report admits through `admitReviewReport(review, plan, verificationReport)` — which transitively re-admits both inputs and checks the verification digest, so a review of stale evidence cannot pass.
2. `verdict: "approved"` alongside a `critical` or `high` finding is rejected by the schema refinement and classified `malformed_model_output`. The role does not "fix" the verdict — spec §8.2: a failed review "never silently marks itself passed", and its inverse (silently downgrading an approval) is the same defect.
3. Duplicate `findingRef`s are rejected.
4. A finding `location` outside the reviewed diff's paths is rejected; the model may not attribute a finding to a file the run never touched.
5. The reviewer's session carries no input from the implementer's hidden reasoning — asserted structurally: the role's context assembly is given only the plan, the diff, the verification report, and repository context, and the test asserts the rendered prompt contains none of the implementer transcript it is also handed as a decoy (spec §8.2, "a session isolated from the implementer's hidden reasoning").
6. `completed.evidenceDigests` contains `await digestReviewReport(report)`.

- [ ] **Step 2: Implement, verify, commit**

Commit: `feat(agent-native): produce isolated review reports bound to plan and verification evidence`

---

## Task 11: Cross-role failure and routing matrix

**Files:**

- Test: `packages/agent-native/test/role-failure-matrix.test.ts`

- [ ] **Step 1: Add the failing matrix test**

One table-driven suite over `["triage", "plan", "review"]` × every failure mode, so a role added later cannot skip a path:

- each `ModelRoutingFailureCode` raised from `resolve` and again from `generate`;
- non-JSON output, schema-invalid output, double-object output, credential-shaped output;
- `finishReason: "length"` (a truncated structured response classifies as `malformed_model_output`, never as a partial document);
- host loss mid-role → exactly one `interrupted` event, evidence digests preserved, no lifecycle terminal;
- cancellation mid-role → `cancelled` terminal, no `completed`.

Every case asserts the terminal type, the code, `retryable`, that the code lifts into `WorkflowFailureSchema` unchanged, and that no partial document was emitted as evidence.

- [ ] **Step 2: Fix whatever it catches, verify, commit**

Commit: `test(agent-native): pin the routing and malformed-output matrix across all three roles`

---

## Task 12: Package exports, documentation, and the full gate suite

**Files:**

- Modify: `packages/agent-runtime/src/index.ts`, `packages/agent-native/src/index.ts`
- Create: `packages/agent-runtime/README.md`, `packages/agent-native/README.md` (short: what the package is, what it refuses to do)

- [ ] **Step 1: Curate the public surface**

Export only what a consumer needs: `createAgentHarnessRegistry`, `createAgentSessionSupervisor`, the relay factory and its types, the runtime error class and failure table; `createNativeHarness`, `NATIVE_AGENT_ROLES`, the prompt registry, the native failure table. Nothing internal. Assert the surface in a test that imports the package root and compares `Object.keys` against a checked-in list, so an accidental export is a failing test rather than a review catch.

- [ ] **Step 2: Run the full gate suite**

```bash
cd /Users/zidane/factory-s1
pnpm format:check
pnpm check
pnpm build --filter='!@autostack/desktop'
pnpm --filter @autostack/agent-runtime test:coverage
pnpm --filter @autostack/agent-native test:coverage
pnpm test
```

Expected: all green; coverage ≥80% on statements, branches, functions, and lines for both owned packages; the known runner-local flake re-run once and noted if it trips.

- [ ] **Step 3: Self-review pass**

Re-read every file added by this stream against: scope creep (anything not traceable to the charter), TODO/placeholder code, disabled or weakened tests, `any`/non-null assertions, hand-rolled canonicalization, any string interpolation of untrusted text into a system prompt, any timer or clock that is not injected, any export that leaks an internal type. Record the pass in `.superpowers/sdd/stream-report.md`.

Commit: `docs(agent-runtime,agent-native): document the stream's public surface`

---

## Definition of done

- Native harness passes `describeAgentHarnessConformance` unmodified, in both the in-process and the macrotask-transport runs.
- Triage, plan, and review outputs validate against `TriageReportSchema`, `PlanDocumentSchema`, `ReviewReportSchema`; the plan document admits through `admitPlanDocument`; the review admits through `admitReviewReport`.
- Fixture-driven tests cover all three roles including every malformed-model-output and routing-failure path.
- The registry probes installed/authenticated status and fails closed; the supervisor marks interruption on host loss and cancels within a bounded, injected budget.
- No provider SDK, credential, API key, network call, or shell string anywhere in either package.
- `pnpm format:check`, `pnpm check`, `pnpm build --filter='!@autostack/desktop'`, both `test:coverage` runs, and full `pnpm test` green.

## Ledger

Task-by-task status, commits, and review outcomes are recorded in `.superpowers/sdd/progress.md` in this worktree.
