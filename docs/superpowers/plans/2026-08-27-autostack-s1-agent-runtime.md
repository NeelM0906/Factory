# AutoStack Stream S1 — Agent Runtime and Native Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-08-27 · **Revision 3** (rebased onto the Wave 0 tip; R0 enumeration reconciled against the landed contracts)
**Stream:** S1 (Wave 1) · **Worktree:** `/Users/zidane/factory-s1` · **Branch:** `codex/milestone-a-s1-agent-runtime` · **Base:** `71249b3` (Wave 0 + Stream S3 + the control-plane suite-timeout re-budget)

**Charter:** `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md` § "Stream S1: Agent runtime and native agent"
**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` §8.1, §8.2, §8.3, §9.1, §9.4, §10.2, §14.1, §14.4, §15, §16.2
**Contract map:** `docs/development/milestone-a-contract-audit.md` items 1–5, 8–11, 21, plus Wave 0 Task 0.12

> The contract enumeration below was taken against `4bc06ef`. Neither the S3 fold to `f8982ec` (which added `packages/model-router`) nor `71249b3` (which changes only `apps/control-plane/vitest.config.ts`) touches any file under `packages/contracts/src/` or `packages/domain/src/` — verified by diff at each rebase, not assumed — so the enumeration still describes the base exactly.

**Goal:** Deliver the two packages that make an agent teammate a supervised, normalized, evidence-producing session: `@autostack/agent-runtime` (harness registry with installed/authenticated probing, sequence-ordered session relay, interruption marking on host loss, bounded cancellation) and `@autostack/agent-native` (one `AgentHarnessPort` implementation configured into the triage, plan, and review roles, producing schema-valid station evidence from versioned prompts through `ModelRouterPort` and `ModelInferencePort`, with no provider SDK and no credential anywhere in the stream).

**Architecture:** `agent-runtime` consumes `AgentHarnessPort` and never implements it; `agent-native` implements `AgentHarnessPort` and never consumes another adapter. The one shared primitive is the sequence-ordered event relay, which lives in `agent-runtime` and is imported by `agent-native` (direction: `agent-native` → `agent-runtime`, never the reverse, so the supervisor stays adapter-agnostic). A native session is a supervised producer that writes contract-validated `AgentSessionStreamEvent`s into a relay; `start` and `resume` are readers over that relay, which is what lets `resume` continue the _same_ session rather than replay a transcript into a new one (spec §9.1). Every model response is admitted by a Zod schema before it becomes evidence; a response that fails admission is a classified failure with a code from a fixed table, never a crash and never an unbounded re-ask. Every string that leaves the model and enters an event passes the shared redactor first, and a value that cannot be made safe fails the session closed.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`); pnpm 10.27 workspace; Turborepo 2; Zod 4; Vitest 4 with the shared 80% coverage thresholds.

---

## Execution order

Task numbers are stable identities (they are how the orchestrator and this stream refer to work); the document is ordered for reading, and this is the order of execution:

**T1 → T4 → T5 → T7 → T6 → T2 → T3 → T13 → T8 → T9 → T10 → T11 → T12**

The reorder is a required change from the plan review: T7 (context assembly) builds the unit that T6's conformance fixture needs to script a genuine permission gate, so building the harness core first would have meant scripting the gate before the thing that gates. T2/T3 (registry and supervisor) follow the harness because T13's cross-package composition test — the check that catches interruption-ownership drift before I1 — needs all three.

**Unblocked:** all of them — the 0.12 rebase landed on 2026-08-27, so the gates on T6, T8–T11, and T13 are released. The task headings still name the gate for history; it is satisfied.

---

## Contract surface as of the 0.12 rebase (base `4bc06ef`)

Rebased 2026-08-27. **This section is the R0 enumeration — it was written from `git diff 02e5cff..codex/milestone-a-wave0 -- packages/contracts/src/ packages/domain/src/`, not from the shapes this plan proposed.** Where the landed contract differs from revision 2's proposal, the landed contract wins and the difference is called out, because a stale quote in a plan is how a stream builds against a schema that does not exist.

- **`ModelInferencePort`** (E1) — landed as `run(request): Promise<ModelInferenceResult>`, **not `generate`**. The request is `{ schemaVersion, idempotencyKey, selection: ModelRouteSelection, messages, options }`:
  - `selection` carries the **whole `ModelRouteSelection`** the router returned, not a bare `routeRef`. A role therefore threads `router.resolve(...)`'s return value straight through, which is what makes "resolve before you spend" structurally checkable.
  - `messages` are `{ role, content }` — the field is **`content`**, not `text`. A refinement rejects a request made only of system messages, so every prompt render must produce a user message (T4 Step 1.5 already requires one; it is now contract-enforced).
  - `options` is `{ maxOutputTokens (REQUIRED, ≤ 1_000_000), reasoningLevel?, responseFormat: "text" | "json" (default "text") }`. Required rather than optional so an unbounded generation cannot escape `ModelPolicySchema.maxOutputTokens`; each role config therefore declares its own ceiling.
  - `responseFormat: "json"` asks the provider for JSON **text**. Parsing and validating it stays with the caller that owns the document schema — which is exactly T5's job, unchanged.
  - The result is `{ schemaVersion, idempotencyKey, routeRef, content, actual, tokens, cost, finishReason, latencyMs, completedAt }` — the payload field is **`content`**, not `text`. `MODEL_FINISH_REASONS` is `stop | length | content_filter | error`, matching T11's truncation case.
  - `admitModelInferenceResult(request, result)` binds a result to the request and route it claims to answer. Roles call it; `createFakeModelInference` already applies it internally, so a role that skipped it would pass against the fake and fail against S3.
- **`producedBy` provenance** (E2) — `StationProvenanceSchema` is optional on all three station documents. **`promptVersion` is a `StableRefSchema` string, not a number** (revision 2 proposed an integer). Prompt artifacts keep a numeric `version` for the contiguity and ordering assertions in T4; the contract field carries its string form.
  - Digest treatment differs per document and both directions must be pinned: `canonicalizePlanDocumentForDigest` **excludes** `producedBy` (a prompt bump must not revoke outstanding plan approvals), while `digestTriageReport` and `digestReviewReport` **include** it (those are evidence of one execution, and a later reading under a different prompt is a different reading).
- **Triage and review digest helpers** (E3) — `canonicalizeTriageReportForDigest` / `digestTriageReport` / `admitTriageReport`, and `canonicalizeReviewReportForDigest` / `digestReviewReport`. Note the signature difference: **`admitTriageReport(input, expectedDigest)` takes the digest to compare against**, because triage is the first station and has neither an upstream document to bind to nor a self-digest field. `admitPlanDocument(input)` remains one-argument. Both canonicalizers normalize absent optionals by omission rather than emitting `undefined`.
- **`workItemId` on `AgentInvocationRequestSchema`** (review finding 2a) — optional in the contract, and the landed comment states this stream's obligation verbatim: a station writing a document that carries `workItemId` must fail closed when it is absent. The native roles do.
- **`normalizeWorkflowFailureCode(candidate)`** (new, not requested by this stream) — the shared lift into the failure alphabet, **unchanged-acceptance**: it returns the code only if it is already exactly what the alphabet accepts, and `undefined` otherwise. It exists because `WorkflowFailureCodeSchema` carries `.trim()`, so `" rate_limited"` parses successfully to a _different_ string; trim-then-accept would conjure a code the stream never carried. The conformance evidence module now uses it, and so must T5 and T11 — no locally derived normalizer anywhere in this stream. `WorkflowFailureCode` is now an exported type, so T1's `AgentRuntimeError.code` annotation is real rather than aspirational.
- **`agent.session_event` durable event** (new, not requested by this stream) — carries `{ agentSessionId, sequence, event: AgentSessionStreamEvent }`, and the event-coherence checker requires the envelope sequence to equal the carried event's sequence and to strictly increase per session. This is the eventual backing of T3's `persist` sink, and it is satisfiable only because the supervisor re-stamps sequence numbers rather than trusting the adapter's — T3 Step 1.2 is now load-bearing for a contract rule, not just tidiness. `run.steered` also landed, which is the durable form of the steer the T6 ruling implements.
- **`PipelineStationDocumentSchema`** (new) — a tagged union over `triage | plan | verify | isolated_review`. Same vocabulary as the route stages T8–T10 pin; noted so a later task uses the tag rather than inventing one.
- **`ModelUsageRecordSchema.attempt`** (new, optional) — orders the records a retried request produces. Informational only: per the finding 12 ruling this stream writes no usage records.

**Fakes available:** `createFakeModelInference({ outcomes, now })` in `@autostack/domain/testing`, with `{ kind: "completed", result }` / `{ kind: "failure", failure }` outcomes consumed by a cursor. It throws when a script runs out, and exposes `requests`, so T5's and T8's call-count assertions read `fake.requests.length` rather than a spy.

### Rulings folded into this plan

- **Finding 2b — upstream documents.** The reviewer role receives the `PlanDocument` and `VerificationReport` it reviews through an explicit per-invocation `NativeRoleInputs` provider in `NativeHarnessDeps`. S4 holds those documents at invocation time; the provider is recorded as a Wave 2 I1 composition interface. There is no evidence-retrieval port in Milestone A.
- **Finding 4 — steering.** Ruled as this stream's call within the honesty rule; the decision and its reasoning are in T6 Step 2.
- **Finding 5 — interruption ownership.** Single owner: the adapter emits `interrupted` when it can, and the supervisor synthesizes one **only** when a stream ends with neither a lifecycle terminal nor an `interrupted` event. Idempotence is asserted in T3.
- **Finding 12 — usage.** Unknown-preserving `usage` **events** satisfy §18's live observation. Durable `ModelUsageRecord` persistence is Wave 2 I1's, with S3's `recordUsage` as the sink. This stream does not call `recordUsage` — `ModelUsageSchema` takes exact integers and cannot express `{ state: "unknown" }`, so calling it would mean fabricating zeros.
- **Finding 13 — digest domains.** The two digest domains this stream mints for its own use (`autostack.native-prompt`, `autostack.agent-session-transcript`) are noted in the package READMEs as potential future contract surface.

---

## Global constraints (inherited; every task holds all of them)

- TypeScript strict. No unchecked `any`, no non-null assertions, no `as` casts that bypass validation, no TODO or placeholder implementations, no disabled tests.
- No provider SDK, no credential, no API key, no network call anywhere in either package — including tests.
- Every cross-boundary value is Zod-validated. No new public types outside `@autostack/contracts`; the two packages export functions and their own local option types only.
- Every model-produced string passes `redactSensitiveText` before entering an event or a document, and a string that still trips `containsSensitiveMaterial` fails the session closed rather than being emitted.
- Untrusted input (objective text, repository contents, model output) never grants a permission, never selects a route, never supplies identity, and never changes a capability declaration (spec §14.1).
- Injected clock (`now: () => string`), injected ID factory, injected inference port, injected reader, injected timer. No `Date.now()`, no `crypto.randomUUID()`, no bare `setTimeout` in production code.
- Failure codes come from fixed exported tables and match `^[a-z][a-z0-9_]{0,63}$` so lifting them into `WorkflowFailure` is a no-op. Error classes carry a non-enumerable `cause`; messages and codes come only from the tables.
- Files stay small and single-concern (200–400 lines typical, 800 hard max), matching `packages/runner-local/src/`.
- TDD per step: write the failing test, run it, observe the stated failure, implement minimally, re-run focused, then run the package's full suite before the task's commit. Conventional-commit message per task.
- Ownership: only `packages/agent-runtime/**`, `packages/agent-native/**`, and this plan file. Any other path is an escalation.
- **Every guard test names the wrong implementation it rejects.** "Observed red" has a hole: a test goes red when you delete the component, which proves nothing about the guard. So for each behavioral assertion, write down — in the test name or a comment — the specific defective implementation it is there to reject, and get the red evidence from **that** defect, not from arbitrary breakage. The discovering case: a fallback test could not tell `||` from `=== undefined`, because `undefined` is falsy and both implementations pass; only companion assertions on `0` and `""` gave it teeth. The general shape is that a single happy-path value is usually consistent with several implementations, one of which is wrong — so a guard needs the companion case that splits them. Two places in this plan where the hole is real and the companion is mandatory are called out inline (T5 Step 2.2, T7 Step 1.4).
- **A negative assertion needs a positive companion in the same run.** "X did not happen" passes trivially when nothing happened at all. Any test asserting an absence must also assert that the machinery was alive — that the in-scope work _did_ happen, that the stream _did_ produce events — or it cannot distinguish a working guard from a broken component.
- **Gate evidence: read the task-count line, never the exit code alone.** `turbo` can exit **0 over an incomplete run** — it prints `Force killed Turborepo tasks: …`, finishes far too fast, and still reports success. A gate is green only when the summary reads `Tasks: N successful, N total` with **N equal to M**, and every gate claim in a report, a task brief, or the ledger must **quote that line verbatim**. A bare "tests passed", an exit code, or a `| tail` that scrolled the summary off is not evidence. Expected totals on this base: **22** for `pnpm test`, **13** for `pnpm check`. A run whose total drops below those numbers is incomplete, not green — this is the silent sibling of the `--` flag trap, and strictly more dangerous because nothing fails loudly.
- **Git: single-committer (option A of the 2026-08-27 cross-stream bulletin).** Task subagents never run a mutating git command — no `add`, `commit`, `reset`, `amend`, `stash`, `checkout`, or `restore`. They write code and tests, run the package's own verification, and report through files under `.superpowers/sdd/`; the stream lead reviews the working tree and makes every commit. This stream shares one worktree across potentially parallel implementers (T1, T4, T5, and T7 have no ordering dependency between them), and `git commit` commits the whole index however explicit the `add` was — so a pathspec-limited commit would still leave `index.lock` contention and a sibling's `reset` would still sweep staged work. Option A removes the class rather than narrowing it. The per-task "verify and commit" steps below are therefore lead actions, and the commands in them are run by the lead after review.

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

Mirror `packages/domain/package.json` exactly in shape. `@autostack/agent-runtime` declares `exports: { ".": "./src/index.ts" }`, dependency `@autostack/contracts` (workspace), devDependency `@autostack/domain` (workspace — its `./testing` entry supplies `createFakeAgentHarness` and the conformance suite, which are test-only and must not become a runtime dependency). `@autostack/agent-native` declares `exports: { ".": "./src/index.ts" }`, dependencies `@autostack/contracts` and `@autostack/agent-runtime`, devDependency `@autostack/domain` for the same reason.

Both get the four standard scripts (`build`, `check`, `test`, `test:coverage`) with `tsc -p tsconfig.json --noEmit` for build and check, a `tsconfig.json` extending `../../tsconfig.base.json` with `"types": ["node", "vitest/globals"]` and `include: ["src/**/*.ts", "test/**/*.ts"]`, and a `vitest.config.ts` that re-exports the root shared config unchanged (no `fileParallelism: false` — neither package touches machine-wide resources).

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
6. `interrupted` does **not** close the relay as a lifecycle terminal, but does mark it interrupted: readers end after the `interrupted` event with no lifecycle terminal, and **after `interrupted`, every further append raises** `agent_session_interrupted` (spec §15, and the conformance suite's evidence case).
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

There is deliberately no `startAfter` construction option: a resumed session reads the _same_ relay from a cursor (`read({ after })`), so a second relay that starts mid-sequence would only exist to serve a resume this design does not perform.

Buffer every appended event (bounded at 10_000; exceeding it raises `agent_session_stream_overflow` rather than dropping evidence silently). Readers are async generators over the buffer plus a waiter set, exactly the notify/`waitUntil` shape `createFakeAgentHarness` uses (`packages/domain/src/testing/fake-agent-harness.ts:94`) — that shape is already proven against the conformance suite's pause detection.

- [ ] **Step 4: Implement the error table**

`src/errors.ts` exports `AgentRuntimeError extends Error` with `readonly code: WorkflowFailureCode` and `readonly retryable: boolean`, constructed only from a frozen `AGENT_RUNTIME_FAILURES` table keyed by code, each entry giving `{ message, retryable }`. `cause` is attached non-enumerably. Codes in this task: `agent_session_already_terminal`, `agent_session_interrupted`, `agent_session_stream_overflow`, `agent_session_disposed`. Assert in the test that every table key matches `WorkflowFailureCodeSchema` and that `WorkflowFailureSchema.parse` accepts the lifted form of each.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-runtime test && pnpm check --filter @autostack/agent-runtime && pnpm format:check
```

Commit: `feat(agent-runtime): scaffold the package and its sequence-ordered session relay`

---

## Task 4: Versioned prompt artifacts

**Files:**

- Create: `packages/agent-native/src/prompts/prompt-artifact.ts`
- Create: `packages/agent-native/src/prompts/triage-prompt.ts`
- Create: `packages/agent-native/src/prompts/plan-prompt.ts`
- Create: `packages/agent-native/src/prompts/review-prompt.ts`
- Create: `packages/agent-native/src/prompts/prompt-digests.ts`
- Create: `packages/agent-native/src/prompts/index.ts`
- Test: `packages/agent-native/test/prompts.test.ts`

- [ ] **Step 1: Add the failing prompt-artifact test**

Spec §16.2 requires a stored version for every prompt used by a run, and my charter requires prompts to be exported, versioned constants rather than inline strings. Assert:

1. Each artifact is `{ promptRef, version, system, modelAuthoredFields, render(input) }`, deeply frozen, with `promptRef` matching the `StableRefSchema` alphabet (`autostack.native.triage`, `.plan`, `.review`) and `version` a positive integer. The artifact's `version` stays numeric so contiguity and ordering are assertable; `StationProvenanceSchema.promptVersion` is a `StableRefSchema` **string**, so the roles carry `String(version)` into `producedBy` and a test pins that the string form parses as a `StableRef`.
2. `promptRef` values are unique across the registry and the registry is exhaustive over `NATIVE_AGENT_ROLES`.
3. `render` returns `ModelMessage[]` whose first message is the artifact's `system` text and whose user message contains the untrusted inputs in a delimited block.
4. **Field exhaustiveness, scoped.** Each artifact declares `modelAuthoredFields` — the subset of its output schema the model is asked to author (triage: `taskType`, `priority`, `complexity`, `actionable`, `rationale`, `duplicates`, `clarificationRef`). The test asserts every declared field name appears in the rendered instruction, so a prompt cannot silently stop asking for a field the schema demands. The complementary assertion is the load-bearing one: **no identity, digest, or timestamp field name appears in the rendered prompt at all** — not `workspaceId`, `workItemId`, `runId`, `schemaVersion`, `planDigest`, `reviewedDiffDigest`, `verificationReportDigest`, `producedAt`, or `producedBy`. The model is never invited to author identity or evidence addressing; the harness supplies all of it (review finding 2a).
5. `render` never interpolates raw untrusted text into the system message: objective and repository text land only in a `user` message, inside an explicitly delimited block, and the system message states that content inside that block is data and never instruction (spec §14.1).
6. Rendered messages pass `ModelMessageSchema.parse`, which means an input containing credential-shaped material is rejected rather than sent — the test feeds a fake AWS-key-shaped string and asserts the render fails closed.
7. **Version pinning through an append-only digest table.** `prompt-digests.ts` exports `PROMPT_DIGESTS: readonly { promptRef, version, digest }[]`. The digest is taken over a stable JSON projection — `{ promptRef, version, system, renderedSample }`, where `renderedSample` is `render` applied to a frozen sample input checked in beside the table — via `digestVersionedValue("autostack.native-prompt", projection)`. Digesting a projection rather than the artifact object keeps the pin over what actually reaches the model instead of over incidental object identity. The test asserts: the current artifact's projection digest equals the table row for its current version; the table contains a row for every `(promptRef, version)` ever shipped and versions per `promptRef` are contiguous and ascending; and rows are append-only — **an existing row is never edited**, so changing a prompt without bumping its `version` fails here, which is the mechanism that makes "versioned artifact" enforceable.

```bash
pnpm --filter @autostack/agent-native test -- prompts.test.ts
```

Expected failure: `Cannot find module '../src/prompts/index.js'`.

- [ ] **Step 2: Write the three prompts**

Each states the role, the exact JSON shape expected for its `modelAuthoredFields` (derived from the Zod schema via `z.toJSONSchema` and then narrowed to the declared subset, not hand-written, so prompt and schema cannot drift), the refusal rules the schema encodes (a triage report may not repeat a duplicate reference; a plan must name at least one required verification command; an approved review may contain no critical or high finding), and the untrusted-data framing from Step 1.5.

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
2. `retryable` is preserved from the `ModelRoutingError`, never recomputed. **Wrong implementation this rejects:** one that re-derives `retryable` from a local code→boolean table instead of reading the error. A single `rate_limited` case cannot detect it — a local table would guess `true` and pass. The companion that splits them is a `provider_error`, whose `retryable` the taxonomy leaves free: the test raises two `provider_error`s that differ **only** in `retryable`, and asserts the classification differs accordingly. A local table returns the same answer for both and fails. Red evidence must come from a deliberately re-deriving implementation, not from deleting the classifier.
3. Every native code round-trips through **`normalizeWorkflowFailureCode` unchanged** — `normalizeWorkflowFailureCode(code) === code`, never `undefined` — and `WorkflowFailureSchema.parse` accepts its lifted form. The helper is imported from `@autostack/contracts`; this stream derives no normalizer of its own, because the whole point of the shared rule is that the classifier and the retry policy branch on the same one. The test also pins the sharp edge the helper exists for: a table entry keyed `" rate_limited"` with a leading space must be rejected, not silently trimmed into acceptance.
4. A non-`ModelRoutingError` throwable classifies as `native_agent_internal_error`, `retryable: false`, with its message drawn from the table and never from the throwable — and with the original attached as a non-enumerable `cause`.
5. Codes are distinct from messages (the conformance suite asserts `code !== message`).

Native codes: `malformed_model_output`, `model_output_unsafe`, `native_agent_internal_error`, `native_context_unavailable`, `native_permission_denied`, `native_invocation_incomplete` (the fail-closed code for a missing `workItemId`), plus the five taxonomy codes carried through unchanged.

- [ ] **Step 3: Implement both, then verify and commit**

Commit: `feat(agent-native): admit structured model output and classify native failures`

---

## Task 7: Bounded context assembly with permission gating

Moved ahead of T6 per the plan review: T6's conformance fixture scripts a genuine permission gate, and this is the unit that gates. Built standalone against injected `emit` and `requestPermission` callbacks, so it is fully testable before the harness exists.

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

export interface ContextAssemblyDeps {
  readonly reader: NativeContextReader;
  readonly emit: (template: SessionEventTemplate) => void;
  /** Absent when the configuration is unpermissioned; an out-of-scope read is then denied. */
  readonly requestPermission?: (request: OutOfScopeRead) => Promise<"allow" | "deny">;
  readonly limits: { readonly maxFiles: number; readonly maxBytes: number };
}
```

Assert:

1. Every path the reader is asked for passes `RelativeWorkspacePathSchema` first; an absolute path, a traversal, or a NUL byte is rejected before the reader is called at all (the reader is never the security boundary).
2. Each read emits a `tool_call` pair — `phase: "started"` then `"completed"` — with a stable `toolCallRef` and `name: "read_file"`; a failing read emits `phase: "failed"` and classifies as `native_context_unavailable`.
3. A read inside the declared scope proceeds without a permission request. A read outside it, **when `requestPermission` is supplied**, emits `permission_requested` with an `allow_once`/`deny_once` option pair and blocks until the decision arrives; an allow proceeds and emits `permission_resolved`; a deny skips the read, emits `permission_resolved`, and continues with the context it has — a denied permission is a normal outcome, not a failure (spec §14.1: untrusted input never grants permission, and denial must be safe).
4. **When `requestPermission` is absent, an out-of-scope read is denied deterministically** — no permission event is emitted, no decision is awaited, assembly continues with the in-scope context it has, and the omission is recorded in the assembled context so the prompt can say the context is partial. This is the behavioral half of the unpermissioned configuration (review required change 3); the structural half is asserted in T6.

   **Wrong implementation this rejects, and its mandatory companion.** Asserting only "the out-of-scope file was not read" is satisfied by a context assembler that reads _nothing_ — a broken component passes the guard. So the same run must assert the positive half: the in-scope files **were** read, their `tool_call` pairs were emitted, and the assembled context contains their (redacted) content. The pair — in-scope present, out-of-scope absent, one run — is what distinguishes a working deny from a dead reader. Red evidence comes from an assembler that reads the out-of-scope path anyway, not from disabling reads.

5. Assembly is bounded: at most `maxFiles` reads and `maxBytes` total; exceeding either truncates deterministically (sorted path order, never reader order) and records the truncation in the assembled context. Two runs over the same reader produce byte-identical context.
6. Every file's content passes `redactSensitiveText` before entering the assembled context.

- [ ] **Step 2: Implement, verify, commit**

Commit: `feat(agent-native): assemble bounded role context behind the permission gate`

---

## Task 6 — GATED ON THE 0.12 REBASE: native harness core and the conformance suite

**Files:**

- Create: `packages/agent-native/src/native-harness.ts`
- Create: `packages/agent-native/src/native-session.ts`
- Create: `packages/agent-native/src/harness-config.ts`
- Modify: `packages/agent-native/src/index.ts`
- Test: `packages/agent-native/test/fixtures/native-harness-fixture.ts`
- Test: `packages/agent-native/test/fixtures/async-native-harness-fixture.ts`
- Test: `packages/agent-native/test/native-harness-conformance.test.ts`
- Test: `packages/agent-native/test/native-harness.test.ts`
- Test: `packages/agent-native/test/native-harness-capability-knobs.test.ts`

Rebase onto the base branch carrying Task 0.12 and re-run `pnpm check` before Step 1.

- [ ] **Step 1: Add the conformance fixture and the failing suite run**

This is the exit criterion, so it lands with the harness core rather than at the end. Write `test/native-harness-conformance.test.ts` as:

```ts
describeAgentHarnessConformance("native agent harness", nativeHarnessConformanceFixture);
describeAgentHarnessConformance(
  "native agent harness over an asynchronous transport",
  asyncNativeHarnessConformanceFixture
);
```

The async fixture is a macrotask decorator over the in-process one, mirroring `packages/domain/test/fixtures/async-agent-harness.ts` (it is a test fixture in another package, so it is re-implemented rather than imported; the duplication is deliberate and noted in a comment). The suite must pass identically against both — that is the standing guard that the harness's pause behaviour is event-driven rather than calibrated to microtask timing.

The fixture builds each of the five scenarios from a _scripted inference fake_, not from a scripted harness:

- `completes` — one successful structured response whose usage leaves `cachedInput`, `reasoning`, and `cost` unknown.
- `fails` — a `ModelRoutingError` with code `provider_error`.
- `pauses` — for the full subject, the interactive pre-call wait described in Step 2, released by a steer whose text becomes observable in a later `message`; for the minimal subject, an inference fake that never resolves, released only by cancel. Both are the engine's real wait states, not scripted stalls.
- `requests_permission` — a context read outside the declared scope on a permissioned configuration, so T7's gate is exercised through the port.
- `interrupted` — the injected host-loss signal resolves after the first evidence-bearing event.

The full-capability subject configures `{ resumable: true, steerable: true, permissioned: true }`; the minimal one configures all three false and declares no out-of-scope reads.

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
  /** Per-invocation upstream documents (review finding 2b); an I1 composition interface. */
  readonly roleInputs: NativeRoleInputsProvider;
  readonly now: () => string;
  readonly newProviderSessionRef: () => string;
  readonly structuredOutput: StructuredOutputPolicy;
  readonly hostLoss?: Promise<void>;
}
```

The descriptor is _derived_, never handed in: `kind: "native"`, `capabilities: { resume: config.session.resumable, steering: config.session.steerable, permissions: config.permissioned, structuredPlans: config.role === "plan" }`. `respondToPermission` is spread onto the returned object only when `config.permissioned` is true, exactly as the reference fake does (`packages/domain/src/testing/fake-agent-harness.ts:292`), so descriptor honesty is structural.

`start` creates the session's relay and returns `relay.read()`; the session engine runs as a supervised producer independent of the reader. `resume` requires `capabilities.resume`, requires the same `sessionId`, requires the session to be neither cancelled nor disposed, and returns `relay.read({ after: <last sequence the caller observed> })` over the _same_ relay — the continuation of one session, not a replay into a new one (spec §9.1). This is why `resume: true` is honest here and only here: it serves spec §15's "client disconnection never cancels a run; clients resume from event sequence". It is **not** a claim to survive host loss — host loss produces `interrupted`, which is precisely the outcome that says the session cannot be resumed.

**Steering — finding 4 ruling, this stream's call.** _(Amended at T6 GREEN, lead-ratified: one `steerable` knob proved empirically unsatisfiable against the conformance suite — a subject steerable in all scenarios must still complete unattended, and no timer may release the wait. The knobs split: `steerable` is the descriptor capability — `steer` is accepted, and a steer arriving before the model call is folded in without blocking; `session.interactive` opts into the blocking wait below and requires `steerable` at construction. The full conformance subject is interactive only in the pauses scenario; every subject config remains a supported real behaviour, which is the condition the ruling attaches.)_ The engine has a real wait state for steering: when `interactive: true` the session pauses after context assembly and before the model call, emits `waiting`, and blocks for an operator instruction, which is folded into the prompt and echoed in a `message` event. That is interactive mode — the workbench's steer affordance (spec §4.1) applied to the expensive step, where an operator who has just seen what context was gathered can narrow it before it is spent. **Shipped pipeline role configurations set `steerable: false`** (a pipeline stage has no operator standing by, and a stage that blocked forever waiting for one would be a defect); the workbench-driven interactive planner sets it `true`. Both map to real engine behaviour, so the full-capability conformance subject is a supported configuration rather than a conformance prop, which is the condition the ruling attaches. The alternative wait — a clarification round trip (`ClarificationRequestSchema`, spec §8.2) — is genuinely S4's, and is not built here.

- [ ] **Step 3: Add the per-knob disable invariant tests**

Required change 3: each knob's `false` must be a structural absence, not a runtime refusal that could drift.

1. `permissioned: false` — the harness object has no `respondToPermission`; `createNativeHarness` **throws at construction** when the configuration also declares any out-of-scope read source, mirroring the reference fake's construction-time refusal (`packages/domain/src/testing/fake-agent-harness.ts:72`); a `permission_requested` event is unconstructable because the session engine passes no `requestPermission` into context assembly at all; and an out-of-scope read is denied deterministically (T7 Step 1.4) rather than escalated.
2. `steerable: false` — no steer queue and no pause state exist; `steer` rejects; the session never emits `waiting`; and the test asserts the engine reaches its model call without an intervening wait.
3. `resumable: false` — `resume` rejects; the relay is still readable from a cursor internally, but no port surface exposes it.
4. For each knob, the descriptor bit and the port surface are asserted together, so a descriptor that claims a capability the surface lacks (or the reverse) fails here rather than at registration.

- [ ] **Step 4: Add the harness unit tests the conformance suite does not reach**

`start` twice on one harness raises; `steer` on a terminated session raises; a disposed harness refuses `start`, `resume`, `steer`, `cancel`, and `respondToPermission`; the descriptor for each of the three roles is asserted field by field (in particular `structuredPlans` false for triage and review, with a corresponding assertion that neither ever emits a `plan` event); and an invocation lacking `workItemId` fails closed with `native_invocation_incomplete` before any model call.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-native test && pnpm check --filter @autostack/agent-native
```

Expected: both conformance runs green, unmodified suite.

Commit: `feat(agent-native): implement the native agent harness against the conformance suite`

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
2. Sequence numbers in the relayed stream are strictly increasing and the adapter's own numbering is _not_ trusted: the supervisor re-stamps, so two adapters with different numbering conventions are indistinguishable downstream. This is now load-bearing for a contract rule rather than tidiness — the `agent.session_event` envelope that eventually carries these events requires its sequence to equal the carried event's and to strictly increase per session, which an adapter's own numbering cannot be relied on to satisfy. The test asserts the relayed sequences against an adapter that deliberately numbers from 100 and skips values.
3. `persist` is called with each batch before the events are visible to readers; a rejecting `persist` ends the session `interrupted` (evidence preserved, not `completed`) — "artifact upload failure prevents a stage from reporting success when that artifact is required evidence" (spec §15).
4. `snapshot()` reports `{ state, lastSequence }` where state is one of `running | completed | failed | cancelled | interrupted`, and never reports `completed` for a session whose terminal was anything else. It deliberately does not carry `evidenceDigests`: no consumer in this stream reads them, and the digests are already in the relayed events, which is the one place they cannot go stale.
5. A second `supervise` call for the same `agentSessionId` raises `agent_session_already_supervised`.

- [ ] **Step 2: Add the failing cancellation test**

Spec §15: "sends a graceful adapter cancellation, waits a bounded interval, terminates the process or sandbox, records partial artifacts, and marks the run cancelled." Assert:

1. `cancel(reason)` calls `harness.cancel` and, when the adapter emits `cancelled` within the grace budget, the relayed terminal is that `cancelled` event and `snapshot().state === "cancelled"`.
2. When the adapter never emits a terminal, the supervisor stops waiting after exactly `cancellationGraceMs` (measured against the injected `sleep`, not a real timer), appends its own `cancelled` event, and disposes the registration. The test asserts the injected sleep was awaited with exactly the configured budget — a hard-coded or unbounded wait fails here.
3. Cancellation after a terminal is a no-op that neither throws nor appends a second terminal.
4. A `completed` event that arrives after cancellation was issued is dropped, not relayed: a cancelled session must never end in the success shape.

- [ ] **Step 3: Add the failing interruption test — single ownership**

Finding 5 ruling: the adapter owns `interrupted` when it can emit one; the supervisor synthesizes one **only** when a stream ends with neither a lifecycle terminal nor an `interrupted` event. Assert:

1. **Adapter-emitted.** A subject whose stream ends with its own `interrupted` event is relayed unchanged: exactly one `interrupted` event reaches readers, the supervisor adds nothing, and `snapshot().state === "interrupted"`.
2. **Supervisor-synthesized.** A stream that simply ends — no terminal, no `interrupted` — gets exactly one synthesized `interrupted` carrying the digests of the evidence observed so far (`evidenceDigests` has `min(1)`, so a session with no evidence yet contributes the digest of its own partial transcript via `digestVersionedValue("autostack.agent-session-transcript", …)`), and the stream ends with **no** lifecycle terminal.
3. **Idempotence.** Host loss resolving after the adapter has already emitted `interrupted` adds nothing; host loss resolving twice adds nothing; a stream ending after a synthesized `interrupted` adds nothing. In every case exactly one `interrupted` event exists — asserted by counting, which is the check that catches double-ownership drift.
4. `persist` received the `interrupted` event in all cases.

Mirror the conformance suite's evidence assertions (`packages/domain/src/testing/agent-harness-conformance-evidence.ts:96`) so the supervisor and the adapters agree on what interruption looks like.

- [ ] **Step 4: Implement the supervisor**

Keep the three concerns in three files. The supervisor owns no timers of its own beyond the injected `sleep`, and holds no adapter-specific knowledge — it only ever touches `AgentHarnessPort`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-runtime test:coverage
```

Expected: all suites green, coverage ≥80% on every metric.

Commit: `feat(agent-runtime): supervise agent sessions with bounded cancellation and interruption marking`

---

## Task 13: Cross-package composition test

Required change 6, and the reason T2/T3 follow T6: this is what catches interruption-ownership drift and descriptor/registry disagreement before I1 ever composes the two packages.

**Files:**

- Test: `packages/agent-native/test/runtime-composition.test.ts`

- [ ] **Step 1: Add the failing composition test**

Register a real `createNativeHarness` in a real `createAgentHarnessRegistry`, supervise it with a real `createAgentSessionSupervisor`, and drive a full role session end to end through the supervisor's relay — no fakes except the inference port, the reader, the clock, and the ID factory. Assert:

1. A completing session yields one `completed` terminal through the supervisor, and the evidence digests in it match the role's document digest.
2. **Interruption crosses the boundary exactly once.** With host loss injected at the harness, the harness emits `interrupted`, the supervisor relays it, and the composed stream contains exactly one. With host loss injected at the supervisor only (the harness stream ending silently), the supervisor synthesizes exactly one. Both paths are asserted in the same test file, which is the pairing that makes the double-emit regression impossible to miss.
3. Registration rejects a native harness whose descriptor and port surface disagree — driven by constructing a permissioned and an unpermissioned harness and registering both.
4. `profiles()` reports the native harness as installed and authenticated without probing anything external (a native harness has no CLI to find; its probe is a constant, and the test pins that it does not reach for the filesystem or the network).
5. Cancellation issued at the supervisor reaches the harness and terminates the composed stream in the `cancelled` shape within the injected grace budget.

The test lives in `agent-native` because that is the package that depends on both; `agent-runtime` must not import `agent-native`, not even in tests.

- [ ] **Step 2: Fix whatever it catches, verify, commit**

Commit: `test(agent-native): compose the native harness with the runtime registry and supervisor`

---

## Task 8 — GATED ON THE 0.12 REBASE: the triage role

**Files:**

- Create: `packages/agent-native/src/roles/role-config.ts`
- Create: `packages/agent-native/src/roles/triage-role.ts`
- Create: `packages/agent-native/src/evidence.ts`
- Test: `packages/agent-native/test/triage-role.test.ts`

- [ ] **Step 1: Add the failing triage test**

Assert, with a scripted inference fake and the Wave 0 `createFakeModelRouter`:

1. The role resolves its route through `ModelRouterPort.resolve` with **`stage: "triage"`** and `requiredCapabilities: ["text", "structured_output"]`, then calls **`inference.run`** with that exact `ModelRouteSelection` threaded into the request's `selection` field, `options.responseFormat: "json"`, and the role's declared `options.maxOutputTokens`. Asserted by reading `fake.requests[0].selection` and comparing it to the selection the router returned — a role that calls inference without resolving first, or that rebuilds a selection of its own, fails here. The result is admitted through `admitModelInferenceResult` before its `content` is parsed.
2. A well-formed model response becomes a `TriageReportSchema`-valid `TriageReport` whose `workspaceId`, `workItemId`, and `runId` come from the invocation and never from the model; a response that supplies any of them is rejected rather than merged, and an invocation missing `workItemId` fails closed with `native_invocation_incomplete` before the model call.
3. `producedBy` records the triage prompt's `promptRef` and its `version` in string form, the `adapterId`, and the resolved `routeRef`. Because `digestTriageReport` **includes** `producedBy`, a companion case mutates it and asserts the digest **changes** — the mirror of T9's plan-document case, and the pairing is what stops the two opposite rules being conflated.
4. The session emits, in order: `started`, `message`, `tool_call` pairs for any context reads, `usage` (unknown-preserving, taken from the inference result's `tokens`/`cost` verbatim), and `completed` whose `evidenceDigests` contains `await digestTriageReport(report)`. The report then admits through **`admitTriageReport(report, thatDigest)`** — the two-argument digest-compare form, since triage has no upstream document to bind to.
5. Duplicate detection round-trips: a response naming two duplicates with the same `reference` is rejected by the schema refinement and classified `malformed_model_output`, not silently deduplicated.
6. `actionable: false` still produces a complete report and a `completed` terminal; triage deciding "not actionable" is a successful triage.
7. A `clarificationRef` in the response is carried through unchanged.

- [ ] **Step 2: Add the failing failure-path tests**

A `capability_unavailable` from `resolve` terminates the session `failed` with that exact code and `retryable: false`; a `rate_limited` from `inference.run` terminates `failed` with `retryable: true`; a malformed response with `maxRepairAttempts: 1` produces exactly two entries in `fake.requests` and then a `failed` terminal with `malformed_model_output`. Each asserts the terminal is the last event and that no `completed` was emitted. Note the fake throws a `TypeError` when a script runs out of outcomes, so an implementation that re-asks more often than the policy allows fails loudly rather than silently exhausting the script.

- [ ] **Step 3: Implement `role-config.ts`, `triage-role.ts`, `evidence.ts`; verify; commit**

`role-config.ts` holds the shared shape (prompt artifact, `ModelRouteContext` stage, `modelAuthoredFields`, output schema, admission function, digest function) so the three roles differ in data, not in control flow. `evidence.ts` wraps the contracts' digest helpers — it defines no canonicalization of its own.

Commit: `feat(agent-native): produce triage reports through the routed native role`

---

## Task 9 — GATED ON THE 0.12 REBASE: the planner role

**Files:**

- Create: `packages/agent-native/src/roles/plan-role.ts`
- Test: `packages/agent-native/test/plan-role.test.ts`

- [ ] **Step 1: Add the failing planner test**

The digest is the point of this role: S4 verifies approval staleness against it. The route stage is **`"plan"`**.

1. The produced document admits through `admitPlanDocument` — the strongest available assertion, since it recomputes the digest from the canonical fields and rejects a mismatch.
2. The role computes `planDigest` with `digestPlanDocument` and never with a local rule; a test mutates one canonical field (`summary`) and asserts admission now fails, and mutates one excluded field (`producedAt`) and asserts the digest is **unchanged** — pinning the material-change semantics the contract comment describes. A third case mutates `producedBy` and asserts the plan digest is likewise **unchanged**, pinning 0.12's exclusion decision: a prompt bump must not revoke an outstanding plan approval. This is the exact opposite of the triage and review rule (T8 Step 1.3, T10 Step 1.7), and the two are asserted in both directions on purpose.
3. A `plan` detail event is emitted carrying that same `planDigest` and a summary; this is the only role whose descriptor declares `structuredPlans: true`.
4. `verificationCommands` are `executable` + `args`; a response whose command carries a shell string in `executable` (`"pnpm test && pnpm build"`) is rejected — the schema permits `usesShell`, but a command that smuggles shell syntax into `executable` while declaring `usesShell: false` is a lie about what will execute, and the role rejects it as `malformed_model_output`.
5. A response with no `required: true` command is rejected by the schema refinement and classified, not repaired by promoting one.
6. `requiredPermissions` and `requiredCredentialRefIds` are carried through; a `credentialRefId` the invocation did not authorize is rejected — a plan may _request_ a credential, but the request is scoped to what the run was given, and untrusted output may not widen it.
7. `completed.evidenceDigests` contains the `planDigest`.

- [ ] **Step 2: Implement, verify, commit**

Commit: `feat(agent-native): produce digest-admissible plan documents from the planner role`

---

## Task 10 — GATED ON THE 0.12 REBASE: the reviewer role

**Files:**

- Create: `packages/agent-native/src/roles/review-role.ts`
- Create: `packages/agent-native/src/roles/role-inputs.ts`
- Test: `packages/agent-native/test/review-role.test.ts`

- [ ] **Step 1: Add the failing reviewer test**

`ReviewReportSchema` binds the review to a plan and a verification report. Per finding 2b those arrive through `NativeRoleInputsProvider` — a per-invocation provider supplied by composition, not a retrieval port:

```ts
export interface NativeRoleInputsProvider {
  forInvocation(request: AgentInvocationRequest): Promise<NativeRoleInputs>;
}
```

The route stage is **`"isolated_review"`** — `ModelRouteContextSchema` has no `"review"` stage, and the name is the point: spec §8.2 requires a session isolated from the implementer's hidden reasoning.

Assert:

1. The produced report admits through `admitReviewReport(review, plan, verificationReport)` — which transitively re-admits both inputs and checks the verification digest, so a review of stale evidence cannot pass.
2. The provider's documents are admitted **before** the model call; a provider returning a plan whose digest does not admit fails the session closed with `native_context_unavailable` and never reaches the model.
3. A provider whose documents belong to a different run (identity mismatch against the invocation) fails closed — the reviewer will not review another run's evidence.
4. `verdict: "approved"` alongside a `critical` or `high` finding is rejected by the schema refinement and classified `malformed_model_output`. The role does not "fix" the verdict — spec §8.2: a failed review "never silently marks itself passed", and its inverse, silently downgrading an approval, is the same defect.
5. Duplicate `findingRef`s are rejected; a finding `location` outside the reviewed diff's paths is rejected, since the model may not attribute a finding to a file the run never touched.
6. The reviewer's context carries no implementer transcript: the test hands the provider one as a decoy and asserts it appears in no rendered message.
7. `completed.evidenceDigests` contains `await digestReviewReport(report)`, and — because `canonicalizeReviewReportForDigest` **includes** `producedBy` — mutating `producedBy` **changes** the digest, the mirror of T9 Step 1.2's plan-document case.

- [ ] **Step 2: Implement, verify, commit**

Commit: `feat(agent-native): produce isolated review reports bound to plan and verification evidence`

---

## Task 11: Cross-role failure and routing matrix

**Files:**

- Test: `packages/agent-native/test/role-failure-matrix.test.ts`

- [ ] **Step 1: Add the failing matrix test**

One table-driven suite over `["triage", "plan", "review"]` × every failure mode, so a role added later cannot skip a path:

- each `ModelRoutingFailureCode` raised from `router.resolve` and again from `inference.run`;
- non-JSON output, schema-invalid output, double-object output, credential-shaped output;
- `finishReason: "length"` (a truncated structured response classifies as `malformed_model_output`, never as a partial document);
- a missing `workItemId` on the invocation (`native_invocation_incomplete`);
- host loss mid-role → exactly one `interrupted` event, evidence digests preserved, no lifecycle terminal;
- cancellation mid-role → `cancelled` terminal, no `completed`.

Every case asserts the terminal type, the code, `retryable`, that the code lifts into `WorkflowFailureSchema` unchanged, and that no partial document was emitted as evidence.

- [ ] **Step 2: Fix whatever it catches, verify, commit**

Commit: `test(agent-native): pin the routing and malformed-output matrix across all three roles`

---

## Task 12: Package exports, documentation, and the full gate suite

**Files:**

- Modify: `packages/agent-runtime/src/index.ts`, `packages/agent-native/src/index.ts`
- Create: `packages/agent-runtime/README.md`, `packages/agent-native/README.md`

- [ ] **Step 1: Curate the public surface**

Export only what a consumer needs: `createAgentHarnessRegistry`, `createAgentSessionSupervisor`, the relay factory and its types, the runtime error class and failure table; `createNativeHarness`, `NATIVE_AGENT_ROLES`, the prompt registry, the `NativeRoleInputsProvider` type, the native failure table. Nothing internal. Assert the surface in a test that imports the package root and compares `Object.keys` against a checked-in list, so an accidental export is a failing test rather than a review catch.

- [ ] **Step 2: Write the two READMEs**

Each says what the package is and what it refuses to do. Both record, per finding 13, the two digest domains this stream mints for its own use — `autostack.native-prompt` (T4's version pin) and `autostack.agent-session-transcript` (T3's partial-evidence digest) — as **potential future contract surface**: they are internal today because no other stream reads them, and the moment one does they belong in `@autostack/contracts` alongside the station-evidence helpers.

- [ ] **Step 3: Run the full gate suite**

```bash
cd /Users/zidane/factory-s1
pnpm format:check
pnpm check
pnpm build --filter='!@autostack/desktop'
pnpm --filter @autostack/agent-runtime test:coverage
pnpm --filter @autostack/agent-native test:coverage
pnpm test
```

Expected: coverage ≥80% on statements, branches, functions, and lines for both owned packages; the known runner-local flake re-run once and noted if it trips.

**Do not report this gate from an exit code.** Capture and quote the summary line of each turbo-driven command and confirm the counts match: `pnpm test` must read `Tasks: 22 successful, 22 total` (24 once this stream's two packages land) and `pnpm check` must read `Tasks: 13 successful, 13 total` (15 with the new packages). If the total is lower than expected, or the output contains `Force killed Turborepo tasks`, the run was **incomplete and is not evidence of anything** — regardless of exit status. Never pipe these through `tail` alone, which is how the summary gets scrolled away; capture the full output and grep the summary out of it.

- [ ] **Step 4: Self-review pass**

Re-read every file added by this stream against: scope creep, TODO/placeholder code, disabled or weakened tests, `any`/non-null assertions, hand-rolled canonicalization, any string interpolation of untrusted text into a system prompt, any timer or clock that is not injected, any export that leaks an internal type. Record the pass in `.superpowers/sdd/stream-report.md`.

Commit: `docs(agent-runtime,agent-native): document the stream's public surface`

---

## Pending assignment — clarification answer route (2026-08-31, awaiting ownership ruling)

The orchestrator assigned `POST /v1/runs/:runId/clarifications/:clarificationRef/answer`
(`AnswerClarificationRequestSchema` / `AnswerClarificationResponseSchema`, landed at `105db8e`)
to this lane. No task T1–T13 touches `apps/control-plane`, and this plan's ownership rule makes
any other path an escalation — so the route is RECORDED here to keep it from falling between
tasks, and carrying it requires either an explicit ownership expansion (a new T14: control-plane
run-action route, server-derived idempotency from clarificationRef + answer content, actorId from
authenticated context, `replayed: true` on idempotent re-answer, durable record
`ClarificationResponseSchema`) or re-routing to the stream that owns run-action routes. Do not
start it without that ruling.

## Definition of done

- Native harness passes `describeAgentHarnessConformance` unmodified, in both the in-process and the macrotask-transport runs.
- Triage, plan, and review outputs validate against `TriageReportSchema`, `PlanDocumentSchema`, `ReviewReportSchema`; the plan document admits through `admitPlanDocument`; the review admits through `admitReviewReport`.
- Fixture-driven tests cover all three roles including every malformed-model-output and routing-failure path.
- The registry probes installed/authenticated status and fails closed; the supervisor marks interruption on host loss exactly once and cancels within a bounded, injected budget; the cross-package composition test pins both.
- No provider SDK, credential, API key, network call, or shell string anywhere in either package.
- `pnpm format:check`, `pnpm check`, `pnpm build --filter='!@autostack/desktop'`, both `test:coverage` runs, and full `pnpm test` green.

## Ledger

Task-by-task status, commits, and review outcomes are recorded in `.superpowers/sdd/progress.md` in this worktree; the stream's running status, including the export-name drift I1 composes against, is in `.superpowers/sdd/stream-report.md`.
