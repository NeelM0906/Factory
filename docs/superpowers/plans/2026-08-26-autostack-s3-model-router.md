# AutoStack Stream S3 — Model Plane: Router and Credentials

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revision 2 (2026-08-27)** — applies the orchestrator's plan-review verdict, findings 1–20. The load-bearing changes: a route's eligible capability set is the discovered entry matching its **pinned** model, never a union (findings 1+2); catalog discovery is a **second** credential call site (finding 3); the rejection pipeline is written **once** as an ordered list and both the failure tests and the parity table derive from it (finding 4); resolve **fails closed** for a stage with no configured policy (finding 5); usage records are **per attempt** (finding 6); stale catalogs carry a **ceiling** past which resolve fails closed (finding 7).

**Goal:** Deliver `packages/model-router` — `createModelRouter(deps)` implementing `ModelRouterPort` over three transports (`vercel_ai_gateway`, `openrouter`, `direct` for OpenAI/Anthropic/xAI) with dynamic catalog discovery and capability filtering (spec §10.1), per-station policy evaluation (spec §10.2), ordered fallback recorded as route events (spec §15), per-attempt usage normalization that keeps missing provider data unknown rather than estimated (spec §10.2), a taxonomy-conformant failure surface (`ModelRoutingError`), and a Keychain-pattern `credential-ref-store.ts` that fails closed without OS protection and resolves secrets only at the two transport call sites (spec §14.3).

**Architecture:** The router is a pure resolver plus a thin transport layer. Route configuration and policy come in as validated contract values; nothing is discovered from the network except _capability declarations_ and _pricing_, and every network read goes through an injected `fetch` so the gate suite is fixture-only. A route pins exactly one model — `gatewayModel`, `openRouterModel`, or `providerModel` — so discovery is not a menu the router chooses from but a **validation** of that one pin: a route's eligible capability declaration is the single discovered entry whose `providerModel` equals the pin, and a pin absent from an otherwise successful discovery makes the route offer nothing validatable. Discovery results live in a router-local per-route `CatalogSnapshot` with explicit `fresh | stale` freshness, so a provider outage degrades to a stale-but-present catalog rather than an unresolvable route — bounded by a `maxStaleMs` ceiling past which the router fails closed rather than routing on indefinitely old capability claims. Selection is one ordered rejection pipeline in which each stage owns exactly one taxonomy code, so `capability_unavailable`, `route_disabled`, and `budget_exceeded` are produced by structure rather than by prose, and an out-of-policy route can never be the reason a station reads `capability_unavailable`. Invocation is fallback-aware: a caller-supplied attempt runs against the preferred route and, on a **retryable** failure, against each policy fallback in order, emitting one `ModelRouteFallback` per activation and one `ModelUsageRecord` **per attempt** — a failed attempt that was nonetheless billed must not lose its cost (spec §15) — each attributed from the request and never from the provider response.

Secrets have exactly **two** call sites, and the credential store is the only component that ever holds plaintext. Both sites take a `resolveSecret` callback rather than a value: the language-model factory, and — because Gateway, OpenRouter, OpenAI, Anthropic, and xAI all require authentication on their catalog endpoints — **catalog discovery**. Spec §14.3's "exposed only to the process or sandbox step that needs it" is satisfied by keeping resolution at those two sites and nowhere else, not by there being only one; a secret exists as a string only inside a provider factory call or a discovery request's header construction, and never in a router field, event, log line, or serialized structure.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9 strict; pnpm 10.27; Turborepo 2; Zod 4; Vercel AI SDK 5 (`ai`, `@ai-sdk/gateway`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`); Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` §7 (CredentialRef), §10.1, §10.2, §14.1, §14.3, §15, §17.1–17.3; master plan `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md` "Stream S3"; contract map `docs/development/milestone-a-contract-audit.md` items 6–10 and 21.

**Base:** worktree `/Users/zidane/factory-s3`, branch `codex/milestone-a-s3-model-router`, cut from `02e5cff`. Baseline verified before planning: `pnpm install --frozen-lockfile` clean, `pnpm check` 12/12, `pnpm format:check` clean, `pnpm test` 21/21 tasks green (no runner-local flake on this run).

**Rebase status: DONE.** Rebased onto `codex/milestone-a-wave0` @ `4bc06ef` on 2026-08-27, clean, no conflicts. `ModelInferencePort` and the optional `ModelUsageRecordSchema.attempt` ordinal both landed; the attempt field matches DEC-4 exactly. The landed inference shape differs from revision 2's prediction and ESC-1 below now records the **verified** shape — Tasks 9, 10 and 12 are written against that, not against the earlier guess.

---

## Global constraints

Inherited verbatim from the master plan's Global constraints and the stream-lead protocol; restated here as the review checklist for every task.

- **Ownership.** Create/modify only `packages/model-router/**` and this plan document. Never touch `packages/contracts`, `packages/domain`, another stream's package, `apps/desktop`, root config, or CI. A blocking contract shape is an escalation, never a local workaround.
- **Single-committer: the lead commits, task subagents never do.** Task agents leave their work in the working tree, verify it, and report the exact paths they touched; the lead reviews, commits precisely those paths, and records the SHA. Task agents must not run `git add`, `git commit`, `git reset`, `git stash`, or `git checkout`.

  This is not a style preference — it closes a race that bit this stream twice. Parallel agents share one worktree and therefore one git index, and `git add <own paths>` followed by `git commit` commits the **entire index**, including files a sibling staged first. So "add only your own paths" does not scope a commit at all. One agent swept a sibling's staged files into its commit; another had its staged files silently unstaged by a sibling's `git reset`. The `reset --soft` recovery only works while the bad commit is still the branch tip, so two near-simultaneous committers turn a recoverable mistake into a clobber. Pathspec-limited `git commit -- <paths>` would fix the index sweep but not `git reset` interference or `index.lock` contention; removing the second writer removes the whole class. It also makes the lead's review a genuine pre-merge gate rather than a post-hoc audit with fix-loops.

  The commit steps written into each task below are therefore **the lead's**, not the subagent's; a task agent that reaches one stops and reports instead.

- **Fix loops dispatch a fresh agent, never resume the original.** A spawned agent's completion notifies the lead directly; a resumed one can receive instructions but cannot address the lead in return, so its report has to be relayed and can go astray. The cost is re-reading context; the benefit is that no result is lost.

- **Task subagents are package-scoped; protocol files are the lead's.** A task-level subagent writes only under `packages/model-router/**` (plus `pnpm-lock.yaml` where a task adds a dependency). Everything under `.superpowers/sdd/` — `progress.md`, `stream-report.md` — is a protocol file owned by the stream lead. A subagent that has something to record there puts it in its **task report** and the lead transcribes it. This keeps the ledger single-writer, so it stays a reliable recovery map rather than a merge surface.
- **No cross-implementation imports.** Depend on `@autostack/contracts` and `@autostack/domain/testing` only.
- **Security.** No secrets in events, artifacts, logs, error messages, or serialized structures; fail closed when OS protection is unavailable; provider responses are untrusted input (spec §14.1) and never widen a capability, a permission, or a policy ceiling; never a shell string anywhere.
- **TDD.** Failing test first with the stated failure observed, then the minimal implementation, then a focused re-run, then full package verification, then one conventional commit per task.
- **Quality bars.** TypeScript strict; no `any`, non-null assertions, disabled tests, placeholders, or TODOs. `.strict()` on every Zod object. Small files per concern (≤400 lines typical). Injected clocks, ID factories, and `fetch` — no ambient time, randomness, or network in tests. 80% coverage floor on statements/branches/functions/lines.
- **No live network in the gate suite.** Every provider interaction in unit and integration tests goes through recorded HTTP fixtures served by an injected `fetch` double, following `apps/cli/src/http-client.ts` (`readonly fetch: typeof globalThis.fetch` on the options object). Live smoke for all four credential sets is Wave 2's job.
- **RED gates are mandatory, not decorative.** Every test step below names its run command and its expected failure. For the **first** test against a module that does not yet exist, "module not found" is the expected failure. For **every subsequent** test in the same task the module already exists, so the expected failure must be **behavioral** — the named assertion diff — and a step that reports "module not found" where a behavioral failure was specified means the test was not actually exercising the new behavior and must be rewritten before implementing (finding 11).

- **Failure paths are tested in the same task that implements them, and coverage is self-checked before finishing.** Tasks 3 and 11 both landed under the 80% branch floor for the same reason: the required failure paths were implemented correctly but never exercised, so the gap surfaced only in review and cost an extra addendum round each. Every task that performs I/O therefore covers, from the start: a network throw; a malformed non-JSON body (distinct from a well-formed body that fails schema validation); the classified HTTP status paths the task can raise; and any wrong-input guard that raises `TypeError` rather than a `ModelRoutingError`. Before reporting, a task runs its own scoped coverage and adds tests if branches are short of 80 — reaching the floor is the implementer's job, not the reviewer's.

- **Negative assertions name the thing that must be absent.** Where a fail-closed filter drops an input, assert the specific identifier is missing from the output rather than that a count changed. A count-only assertion passes under both the correct implementation and the permissive bug it is meant to catch — the all-unmapped-modality drop in Task 3/4 is the worked example, where a `["text"]`-defaulting implementation would satisfy a count but fail a named-absence check.

- **Write control characters as escape sequences, never as literals.** A typed space silently became a raw `0x00` byte in a Task 11 test file; it was caught only by byte inspection. Use `"\0"`, `"\t"`, and friends, and verify the bytes when a test's whole point is a hostile byte value — the literal looks identical on screen and the test will appear to pass while asserting nothing.

## Contract surface consumed

Read from `@autostack/contracts` (`packages/contracts/src/model.ts` unless noted):

| Symbol                                                                                                                                                                                          | Line                           | Use in S3                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `ModelRouterPort`                                                                                                                                                                               | `:372`                         | The interface `createModelRouter` implements — `resolve`, `getRoute`, `recordUsage`                   |
| `ModelInferencePort`, `ModelInferenceRequestSchema`, `ModelInferenceResultSchema`, `ModelGenerationOptionsSchema`, `ModelMessageSchema`, `ModelFinishReasonSchema`, `admitModelInferenceResult` | `model.ts` (landed `4bc06ef`)  | The invocation seam; Task 10 implements the port. Verified shape in ESC-1                             |
| `ModelRouteSchema` / `ModelTransportSchema`                                                                                                                                                     | `:54` / `:48`                  | Route configuration admitted at construction; the three transport kinds and their pinned model fields |
| `ModelRouteContextSchema`                                                                                                                                                                       | `:64`                          | The resolve request: attribution + `requiredCapabilities`                                             |
| `ModelRouteSelectionSchema`                                                                                                                                                                     | `:76`                          | The resolve result; its `reason` carries catalog freshness and `discoveredAt`                         |
| `ModelCatalogEntrySchema`, `MODEL_MODALITIES`, `MODEL_FEATURES`                                                                                                                                 | `:127`, `:111`, `:114`         | Capability declaration produced by discovery; the closed vocabularies filtering decides over          |
| `ModelPolicySchema`                                                                                                                                                                             | `:318`                         | Per-station constraints: allowed/fallback routes, token and cost ceilings, reasoning level            |
| `ModelRouteFallbackSchema`                                                                                                                                                                      | `:230`                         | One record per fallback activation; `failureCode` is taxonomy-bound                                   |
| `ModelUsageRecordSchema` (+ `attempt`, base Task 0.12), `ModelTokenUsageSchema`, `ModelTokenCountSchema`, `ModelCostSchema`                                                                     | `:185`, `:175`, `:159`, `:164` | Per-attempt normalized usage with `reported` / `unknown` states                                       |
| `ModelUsageSchema`                                                                                                                                                                              | `:86`                          | The flat exact-numbers shape `ModelRouterPort.recordUsage` still takes                                |
| `MODEL_ROUTING_FAILURE_CODES`, `ModelRoutingFailureSchema`, `ModelRoutingError`                                                                                                                 | `:220`, `:264`, `:299`         | The entire failure surface                                                                            |
| `CredentialRefSchema`, `CredentialRefIdSchema`                                                                                                                                                  | `entities.ts:370`, `ids.ts:63` | What the credential store keys on                                                                     |
| `KNOWN_CREDENTIAL_SPECS`                                                                                                                                                                        | `secret-safety.ts:44`          | Drives Task 12c's credential-shaped sweep                                                             |

Read from `@autostack/domain/testing`: `createFakeModelRouter` — the behavioral reference the real router must match (Task 6 asserts parity).

**No S3-originated contract additions.** Three points where S3 works _within_ the existing shapes, recorded so review can check the reasoning rather than rediscover it:

1. **Two usage surfaces, deliberately.** `ModelRouterPort.recordUsage` takes the flat `ModelUsageSchema`, which cannot express "unknown". The normalized `ModelUsageRecord` therefore does not travel through the port; it goes to an injected `ModelUsageSink` owned by this package, exactly as `createFakeModelRouter` splits `recordedUsage` (flat, via the port) from `usageRecords` (normalized, produced internally). S3 implements both surfaces and changes neither contract. The port-side sink is named `ExactUsageSink` — the audit's own framing is that `ModelUsageSchema` "remains valid for callers that genuinely have exact numbers", which is a description of its domain, not of its age (finding 19).
2. **Route events go to an injected sink, not to `EVENT_TYPES`.** The contract audit's deferral table makes appending domain event types an orchestrator-owned change. `ModelRouteFallback` records therefore go to a `ModelRouteEventSink` interface this package owns; Wave 2 (I1) wires it to whatever durable surface exists then.
3. **Pricing is router-local, not a catalog field.** `ModelCatalogEntrySchema` has no pricing field, and the audit explicitly scoped the contract to the capability _declaration_. Cost-ceiling evaluation therefore reads a `RoutePricing` value carried in this package's `CatalogSnapshot`, populated from the discovery responses that report pricing (Gateway, OpenRouter, xAI) and absent for those that do not (OpenAI, Anthropic). See DEC-2 for what "absent" means to a policy that sets `maxCostMicros`.

---

## The rejection pipeline (single source of truth)

Written once here; **Tasks 6, 7, and 12c derive their tests from this list rather than restating it**, and any disagreement between a test and this list is a plan defect, not a test defect (finding 4).

Given a `ModelRouteContext` and the `ModelPolicy` configured for `context.stage`, candidates are eliminated in this exact order. Each stage names the failure raised when it empties the candidate set.

**Sequencing rule (normative, confirmed 2026-08-27).** The stages run in the order numbered, and each stage sees only the candidates the previous stage left. This is not merely an evaluation order — it is a _work_ order: stage 2 reads a catalog snapshot **only for routes that survived stage 1**, so no discovery request, and no credential resolution, ever happens for a route the policy already excluded.

That matters for correctness, not just cost. Discovery failures are raised as `ModelRoutingError` (stage 2), so discovering catalogs for every configured route before applying the allowlist would let a broken, unreachable, or unauthenticated route abort a resolve it was never eligible for — a route the operator deliberately kept out of this stage's policy could take down the stage. Filtering first makes an ineligible route's health irrelevant, which is the only defensible reading of "each surviving route's snapshot" in stage 2.

**Attribution rule (normative).** The raised code is owned by the stage that **empties** the candidate set — the last elimination, never the most sympathetic one. A stage that removes some candidates while others survive contributes nothing to the failure, no matter how actionable its exclusion would have been. There is no override that promotes an earlier stage's code because it reads better. Two reasons: an override would make the reported failure depend on routes that were never viable for this request, and it would have to be re-derived from scratch by every future reader, whereas "last stage to empty the set" is checkable by inspection. Where the prose below and this rule ever disagree, this rule governs.

1. **Policy admission.** No policy configured for `context.stage` → `TypeError` at the call boundary; more than one policy configured for a stage → `TypeError` at construction. Neither is a routing failure — both are composition-root programming errors, and treating "no policy" as "everything permitted" would make the absence of a constraint silently more permissive than any constraint (finding 5). Then: routes absent from `policy.allowedRouteRefs` are excluded **here, first**, so an out-of-policy route can never be the reason a station reads `capability_unavailable`.
2. **Catalog resolution.** Each surviving route's snapshot is read. Discovery failure with no cached snapshot → the classified failure from Task 1 (`provider_error` retryable, or `rate_limited` on 429). A cached snapshot older than `maxStaleMs` → `provider_error` (retryable `true`) — routing on capability claims of unbounded age is a fail-open we decline (finding 7).
3. **Pinned-model resolution.** A route's eligible capability declaration is the **single** discovered entry whose `providerModel` equals the route's pinned model. Never a union across entries: a union would let a route inherit `tool_call` from a sibling model it will never actually invoke, which is precisely the unvalidated claim §10.1 exists to prevent (findings 1+2). A pin absent from an otherwise successful discovery excludes the route, carrying an "pinned model absent from catalog" exclusion reason.
4. **Capability filter.** The effective required set is `context.requiredCapabilities` plus, when `policy.reasoningLevel` is anything other than `none`, the derived `reasoning` feature. Routes whose pinned entry does not declare every member are excluded. **Empty here (or emptied by stage 3) → `capability_unavailable`, `retryable: false`,** with a reason naming the missing capabilities and, separately, any routes excluded for an absent pin — from the requesting station's view a route that cannot validate its own pin offers nothing.
5. **Enabled filter.** Routes with `enabled === false` are excluded. **Empty → `route_disabled`, `retryable: false`,** attributing the first capable-but-disabled route. This runs **after** the capability filter, which is what makes "the required capability is declared only by a disabled route" report `route_disabled` rather than `capability_unavailable`.

   It runs **before** the budget filter, and the consequence is deliberate: when one route is capable-but-disabled and another is capable-but-unaffordable, the disabled route is removed here while the set is still non-empty, so the failure ultimately reported is `budget_exceeded` from stage 6. That is the correct answer. The disabled route was excluded by an explicit administrative act, and naming it as the blocker would tell the operator their own deliberate configuration is at fault when the route they are actually permitted to use failed on cost. Among _usable_ routes, cost was the binding constraint — which is exactly what `budget_exceeded` asserts.

   _(Corrected 2026-08-27. Revision 2 justified this ordering with "the operator is told the actionable thing (turn a route on) rather than the arithmetic" — which describes an outcome this ordering does not produce, since stage 5 cannot fire while stage 6's candidate survives. Task 7's implementer found the contradiction empirically and flagged it rather than quietly picking a side. The prose was wrong; the ordering was right.)_

6. **Budget filter.** Cost ceiling (DEC-2) and resolve-time token ceilings (DEC-3). **Empty → `budget_exceeded`, `retryable: false`.**
7. **Ordering.** Survivors are ordered by their position in `policy.allowedRouteRefs`; the first is the preferred route and the remainder, in `policy.fallbackRouteRefs` order, is the fallback chain. `selection.reason` names the chosen route, the catalog `freshness`, and the snapshot's `discoveredAt` (finding 7).

The parity table in Task 6 exercises stages 3–5 and 7 with no policy ceilings, which is exactly the sub-pipeline `createFakeModelRouter` implements — so parity is a claim about a shared ordering, not a coincidence.

---

## Design decisions

Rulings received are marked **RULED**; the remainder are implemented as written unless the orchestrator says otherwise, and each is isolated to one module.

- **DEC-0 (RULED, findings 1+2) — pinned-model capability, never a union.** Pipeline stage 3 above. The parity fixtures **must** include a multi-entry catalog in which the pinned model is the _least_ capable entry, asserting the route filters out; a union implementation would pass every other row in the table and fail only that one, which is why it is mandatory rather than illustrative.
- **DEC-1 — capability floor for providers that publish no capability metadata.** Spec §10.1 says each route "declares supported modalities and features discovered from the provider", but OpenAI's `/v1/models` and Anthropic's `/v1/models` return ids and display names only. Guessing capabilities from model-name substrings would be exactly the "unvalidated universal list" §10.1 forbids. **Decision:** a discovered model with no provider-published capability metadata gets the conservative floor — `inputModalities: ["text"]`, `outputModalities: ["text"]`, `features: []` — unless the operator has declared capabilities for it in the route's `declaredCapabilities` map (a router-local, versioned configuration input, not a contract change). The effect is fail-closed: an undeclared OpenAI model is simply not offered to a station that requires `tool_call`, rather than being offered and failing at call time. Gateway, OpenRouter, and xAI all publish modality/parameter metadata and need no declaration.
- **DEC-2 — unknown pricing under a cost ceiling.** Spec §10.2 allows a policy to constrain "maximum estimated cost". When `policy.maxCostMicros` is set and a candidate route's pricing is unknown, the router cannot prove the ceiling holds. **Decision:** fail closed — that route is ineligible, and if the ceiling eliminates every candidate the resolve raises `budget_exceeded`. A policy that sets no `maxCostMicros` is unaffected, so the default personal policy keeps working with direct providers.

  **The cost formula (added 2026-08-27; revision 2 left it unspecified, which Task 7's implementer flagged rather than silently choosing).** Cost is evaluated as a **worst case**, not an expectation: for each direction, take the tighter of the policy's token ceiling and the pinned catalog entry's declared bound, and multiply by that direction's price. A route is eligible only if that worst case fits under `maxCostMicros`. If **neither** the policy nor the catalog bounds a direction, the worst case is unbounded and the route is ineligible by the same fail-closed rule that governs unknown pricing — an unbounded direction is indistinguishable from an unknown price for the purpose of proving a ceiling.

  Worst case is the right semantic because the ceiling is a guarantee, not a forecast: if the most the request could possibly cost fits, the request provably fits, and no live outcome can breach the policy. An average- or typical-case estimate would let a request through that the policy forbids, which is the one thing a ceiling exists to prevent.

  **There are deliberately TWO cost formulas, and they must not be reconciled (ruled 2026-08-27, Task 9).** The formula above is **policy-time**: a _worst-case upper bound_, computed before the call, whose only job is to prove a ceiling cannot be breached. Task 9's record-time formula is the opposite: an **exact** value, computed after the call, whose job is to state what was actually billed. Record-time cost is `reported` only when the provider reports a cost — the provider is authoritative for what it charged, so a provider figure always wins — or when `RoutePricing` and **both** directions' _reported_ token counts determine it exactly. Anything else is `unknown`.

  Applying the worst-case formula at record time would record a cost higher than the one actually billed, turning a safety margin into a false financial record; applying the exact formula at policy time would be unable to answer at all before the call, since no tokens have been counted yet. A future reader will be tempted to unify them for consistency — that would break one of the two purposes. `pricing` is therefore an _optional_ input to `normalizeUsage`: without it, exact derivation is impossible and cost stays `unknown` rather than being estimated.

- **DEC-3 (finding 8) — token ceilings, both of them, in both places.** `ModelRouteContext` carries no token demand, so the ceilings cannot be evaluated against a request at resolve time. **Decision — `maxOutputTokens` and `maxInputTokens` get identical dual treatment:**
  - _Resolve time_, as route-capability requirements: a route whose pinned entry declares `maxOutputTokens` below `policy.maxOutputTokens` cannot serve the policy's allowance and is ineligible; symmetrically, a route whose declared `contextWindowTokens` is below `policy.maxInputTokens` cannot accept the policy's allowance and is ineligible. A route declaring neither, under a policy that sets the corresponding ceiling, is ineligible by the same fail-closed rule that governs DEC-2.
  - _Invocation time_, as demand checks: a stated input demand above `policy.maxInputTokens`, or a stated output demand above `policy.maxOutputTokens`, raises `budget_exceeded` before any provider call. Both directions are tested in Task 7 and both appear in Task 12c's taxonomy table.

  **Where the invocation-time check runs (RULED 2026-08-27).** It is enforced by the **caller, above `ModelInferencePort`** — not inside `run()`. This is structural rather than a preference: `ModelInferenceRequestSchema` carries `selection`, `messages`, and `options`, and no policy reference, so `run()` has nothing to check against. Threading a policy through the port would widen the vendor-neutral seam the base deliberately kept narrow — and fallback composes above the port for exactly the same reason. The port executes one already-resolved route and owns neither policy nor orchestration.

  The consequence is a public-surface obligation, not merely a note: `assertWithinInvocationBudget` is exported from the package so consumers can compose it, and S4 — which already holds the policy — is its natural enforcement site. A helper that callers are required to compose but cannot import would be an enforcement gap dressed up as a design.

- **DEC-4 (RULED, finding 6) — usage records are per attempt.** A fallback chain of three attempts emits three `ModelUsageRecord`s under one `idempotencyKey`, distinguished by a zero-based `attempt` ordinal. Recording only the terminal outcome would silently discard billed cost from failed attempts, which §15's "cost reporting reflects the actual provider/model" forbids. The `attempt` field is an append-only optional addition landing in base Task 0.12; this plan is written assuming it.
- **DEC-5 (finding 16) — cache shape and defaults.** Snapshots are pinned **per route**, not per provider: two routes may target the same provider with different credentials, and sharing a snapshot across them would let one route's authorization determine another's visible catalog. Defaults: `catalogTtlMs` **900_000** (15 minutes — short enough that a newly enabled model appears within a working session, long enough that a burst of stage resolutions costs one discovery) and `maxStaleMs` **86_400_000** (24 hours — a provider outage should not stop work for a day, but capability claims older than a day have no business deciding routing). Both are constructor-overridable and both are asserted at their boundary values.

- **DEC-6 (RULED 2026-08-27) — the `CredentialResolver` / `CredentialRefStore` seam.** Tasks 3 and 11 landed two different credential shapes, and both are right for their own side; the gap was that neither owned the join. Recorded here so Tasks 5, 10, and 12a do not diverge.
  - **Consumers take an id.** `CredentialResolver.resolve(credentialRefId: CredentialRefId): Promise<string>` (`src/catalog/catalog-types.ts`). This is the only shape the call sites _can_ take: `ModelTransportSchema` carries a bare `credentialRefId`, never a full `CredentialRef`.
  - **Storage takes the whole ref.** `CredentialRefStore.resolve(ref: CredentialRef): Promise<string>` (`src/credential-ref-store.ts`). This is forced too: the on-disk filename is a digest of `store` + `locator`, so an id alone cannot address a stored secret. Task 11 deviated from the plan's `delete(refId)` wording for exactly this reason and was right to — the plan was imprecise, not the implementation.
  - **The join is composition's.** A `CredentialRefRegistry` (`CredentialRefId → CredentialRef`) is supplied as data by the composition root, and a small adapter — `createCredentialResolver({ registry, store })` — implements `CredentialResolver` over `CredentialRefStore` by looking the ref up and delegating. It lands in **Task 12a**, where the rest of the wiring lives. An unknown id fails closed with the store's unknown-reference error; it never falls through to an unauthenticated request.
  - This keeps the two-call-site invariant intact: the adapter is the only thing that knows both shapes, and it still materializes a secret only inside the call that needs it.

- **DEC-7 (RULED 2026-08-27) — the credential store's write semantics are an atomic upsert.** `put` is an upsert, not a create-only: Wave 2 rotates four real credential sets, so rotation is a requirement rather than a convenience, and a create-only contract would only defer the work. But it must be atomic. The first implementation wrote a temp file, tried `link(temp, path)`, and on `EEXIST` did `unlink(path)` followed by a retried `link` — which leaves a window in which **no credential file exists at all**, so a crash between those two syscalls destroys the stored secret with nothing in its place. That defeats the very atomicity the `link` pattern was borrowed from `apps/desktop/src/main/credential-store.ts` to get, and the `unlink(path).catch(() => undefined)` beside it swallowed a genuine `EPERM` into a confusing downstream `EEXIST`.

  **The rule:** replace the destination with `rename(temp, path)`. POSIX `rename` atomically replaces, the temp file lives in the same directory and therefore the same filesystem, the `0o600` mode rides along on the preserved inode, and no `EEXIST` branch is needed at all. A crash leaves either the old secret or the new one, never neither. Rotation carries its own tests: the secret is replaced; neither old nor new plaintext survives at rest; the mode survives; exactly one `.cred` file remains, so a rotation cannot orphan a stale copy beside the live one; and no `.tmp` is left behind.

- **DEC-8 (RULED 2026-08-27, from a real defect) — `transport.endpoint` is the VERSIONED API ROOT.** e.g. `https://api.anthropic.com/v1`, not `https://api.anthropic.com`. Invocation passes it verbatim as the AI SDK `baseURL` (which the SDKs default to a `/v1`-terminated value), and discovery appends **only** the resource path — `/models`, `/language-models`.

  This was found by Task 12c, not by any unit test, and it is the exact failure class R4 warns about: two modules each locally right, jointly wrong. `direct-catalog.ts` hardcoded a `/v1` segment for anthropic and xai while `language-model-factory.ts` passed the endpoint through untouched, so **no single endpoint value made both discovery and invocation hit correct URLs** for those two providers. The root cause is a plan defect — Task 4's brief specified `{endpoint}/models` for openai but `{endpoint}/v1/models` for anthropic and `{endpoint}/v1/language-models` for xai, writing two conventions into one instruction. OpenAI was self-consistent and therefore never complained.

  It stayed invisible because `test/direct-catalog.test.ts` and `test/language-model-factory.test.ts` each picked a _self-consistent but mutually incompatible_ endpoint value. **A per-module test cannot catch a disagreement between modules.** The standing requirement that follows: where two modules consume the same contract field, at least one test must exercise both against a **single** value of it. That regression test now exists per direct provider — one route, one endpoint, both call sites, both URLs asserted.

---

## Escalations

- **ESC-1 — RESOLVED AND VERIFIED AGAINST THE LANDED CONTRACT (rebase onto `4bc06ef`, 2026-08-27).** `ModelRouterPort` had no invocation surface, so S1's "all model calls through `ModelRouterPort`" was unimplementable. The base resolved it with `ModelInferencePort`, and **the landed shape differs from what revision 2 predicted** — the text below is the verified shape, not the guess:

  ```ts
  interface ModelInferencePort {
    run(request: ModelInferenceRequest): Promise<ModelInferenceResult>;
  }
  ```

  - **`ModelRouteHandle` did NOT land in contracts** — deliberately. Revision 2 asked for it there so S1 could depend on it by type; the base declined, so `runWithRoute` and any handle type stay **S3-internal**, and Task 10 implements `ModelInferencePort` instead of exporting a handle factory. The seam is now a request/result value boundary rather than a shared object, which is stronger: no vendor type and no S3 type crosses to S1 at all.
  - **The request carries an already-resolved `selection: ModelRouteSelection`.** Resolving a route and spending money on it are separate authorities — the pipeline resolves, the adapter invokes. Task 6's selection output feeds this field directly and unchanged.
  - **`ModelGenerationOptionsSchema.maxOutputTokens` is REQUIRED**, not optional. This strengthens DEC-3: the invocation-time output-demand check is now guaranteed an input, so "a stated output demand above `policy.maxOutputTokens`" can never be skipped because a caller omitted it.
  - **`ModelInferenceResult` already carries unknown-preserving `tokens`/`cost`** (`ModelTokenUsageSchema`, `ModelCostSchema`) plus `actual.provider`/`actual.model`/`actual.providerRequestId?` and a closed `finishReason` enum (`stop | length | content_filter | error`). Task 9 normalizes from this shape; Task 10 maps provider finish reasons into that closed enum and must fail closed on an unrecognized one rather than widening it.
  - **`admitModelInferenceResult(request, result)`** validates that the result answers this request (`idempotencyKey`) and came from the route the request resolved (`routeRef`). Task 10 uses it rather than hand-rolling those checks.
  - **`ModelMessageSchema.content` is `SafeMetadataStringSchema`**, so prompt content passes the credential scanner — Task 10's fixtures must use safe content, and a credential-shaped prompt is rejected at the boundary rather than sent.
  - **Fallback stays above the port.** `run` executes one resolved route and knows nothing of fallback, so Task 8's `runWithFallback` composes over it exactly as designed — resolve → run → on retryable failure → next target. No change to Task 8.
  - `createFakeModelInference` in `@autostack/domain/testing` is the reference double for Tasks 10 and 12.

- **ESC-2 (informational) — new dependencies mutate `pnpm-lock.yaml`.** No AI SDK package exists anywhere in the repo today (`grep` over every `package.json`: zero hits for `"ai"`, `@ai-sdk/*`, `@openrouter/*`). Adding them to `packages/model-router/package.json` necessarily rewrites the root `pnpm-lock.yaml`, which the protocol lists under untouchable root config. Read as the mechanical consequence of a package I own. Resolved versions are recorded in the stream report.
- **ESC-3 (informational) — provider catalog fixtures are documentation-derived, not recorded.** Wave 1 forbids live calls, so the five catalog endpoints' responses are hand-authored from each provider's published shape. Mitigation, implemented in Tasks 3–5: every parser is fail-closed — an unrecognized catalog payload produces a classified `provider_error`, never a guessed capability set — so a fixture that drifts from reality degrades to "route unavailable", not to "route silently mis-declared". Wave 2's live smoke proves the shapes; recorded payloads from the user's four credential sets replace the hand-authored fixtures verbatim if the orchestrator can supply them.

## Risks

- **R1 — discovery shape drift** (ESC-3). Contained by fail-closed parsing plus one fixture file per endpoint, so a Wave 2 correction is a fixture edit, not a redesign.
- **R2 — coverage on transport wiring.** The AI SDK provider factories are thin, and thin wiring is where coverage floors are missed. Task 10 drives each factory through the injected `fetch` (all AI SDK providers accept a `fetch` option), so the wiring is executed rather than mocked away.
- **R3 — secret leakage through error paths.** The likeliest leak is not a log line but an exception message or a structured clone of a store handle. Task 11 tests `String(error)`, `JSON.stringify`, and `util.inspect` explicitly; Task 12c sweeps every value the composed router emits against `KNOWN_CREDENTIAL_SPECS`.
- **R4 — the union temptation.** DEC-0's pinned-model rule is the single most reversible-by-accident decision here: a later "simplification" that unions entries per route would restore the bug and pass most tests. The mandatory least-capable-pin parity row is the tripwire.

---

## Task 1: Package scaffold, failure taxonomy builders, and HTTP classification

**Cleared to start before the base rebase.**

**Files:**

- Create: `packages/model-router/package.json`
- Create: `packages/model-router/tsconfig.json`
- Create: `packages/model-router/vitest.config.ts`
- Create: `packages/model-router/src/index.ts`
- Create: `packages/model-router/src/failure/routing-failure.ts`
- Create: `packages/model-router/src/failure/http-classification.ts`
- Test: `packages/model-router/test/routing-failure.test.ts`
- Test: `packages/model-router/test/http-classification.test.ts`

- [ ] **Step 1: Scaffold the package**

`package.json` mirrors `packages/runner-local/package.json` in shape:

```json
{
  "name": "@autostack/model-router",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@autostack/contracts": "workspace:*",
    "ai": "^5.0.0",
    "@ai-sdk/anthropic": "^2.0.0",
    "@ai-sdk/gateway": "^1.0.0",
    "@ai-sdk/openai": "^2.0.0",
    "@openrouter/ai-sdk-provider": "^1.0.0"
  },
  "devDependencies": { "@autostack/domain": "workspace:*" }
}
```

Resolve each caret to the exact installed version after `pnpm install` and **report the resolved set in the task report** — the stream lead records it in `.superpowers/sdd/stream-report.md` (ESC-2). `tsconfig.json` and `vitest.config.ts` are copied from `packages/runner-local` unchanged (`types: ["node", "vitest/globals"]`, `include: ["src/**/*.ts", "test/**/*.ts"]`; the root `vitest.config.ts` supplies the 80% thresholds).

- [ ] **Step 2: Add the failing taxonomy-builder test**

`test/routing-failure.test.ts` asserts one builder per taxonomy member, each admitting through `ModelRoutingFailureSchema`:

```ts
import { MODEL_ROUTING_FAILURE_CODES, ModelRoutingError } from "@autostack/contracts";
import {
  capabilityUnavailable,
  routeDisabled,
  budgetExceeded,
  rateLimited,
  providerError,
  coveredCodes
} from "../src/failure/routing-failure.js";

it("raises a non-retryable error for every deterministic code", () => {
  for (const failure of [
    capabilityUnavailable({ required: ["tool_call"], absentPins: [] }),
    routeDisabled({ routeRef: "route:openai", required: ["text"] }),
    budgetExceeded({ routeRef: "route:openai", ceiling: "maxCostMicros" })
  ]) {
    expect(failure).toBeInstanceOf(ModelRoutingError);
    expect(failure.retryable).toBe(false);
  }
});

it("covers every declared taxonomy code", () => {
  expect(new Set(coveredCodes())).toEqual(new Set(MODEL_ROUTING_FAILURE_CODES));
});
```

`coveredCodes()` is enumerated from the builder table, so adding a taxonomy member to contracts without a builder fails this test rather than silently narrowing S3's failure surface.

Run:

```bash
pnpm --filter @autostack/model-router test -- routing-failure.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/failure/routing-failure.js'`.

- [ ] **Step 3: Implement the builders**

Each builder returns a `ModelRoutingError` constructed from a `ModelRoutingFailureSchema`-shaped object with `schemaVersion: 1`. Retryability is **not a parameter** for the four codes the contract refinement constrains — `capability_unavailable`, `route_disabled`, `budget_exceeded` are hard-coded `false` and `rate_limited` hard-coded `true`, so the refinement can never reject a builder's output. `providerError({ retryable, ... })` is the one builder taking retryability, since only the adapter knows whether a given provider fault was transient. `capabilityUnavailable` takes `absentPins` separately from `required` so pipeline stage 3's and stage 4's exclusions are distinguishable in the message (DEC-0). Operator text is composed from safe values only — route refs, capability names, HTTP status codes — never a response body, header, or URL, any of which could carry a credential.

- [ ] **Step 4: Add the failing HTTP-classification test**

`test/http-classification.test.ts` covers the response → code mapping:

| Condition                              | Code             | `retryable` |
| -------------------------------------- | ---------------- | ----------- |
| 429, or 503 with `retry-after`         | `rate_limited`   | `true`      |
| 500, 502, 503, 504                     | `provider_error` | `true`      |
| network throw / abort / malformed body | `provider_error` | `true`      |
| 400, 401, 403, 404, 422                | `provider_error` | `false`     |

Both `provider_error` rows are mandatory and are the source of Task 12c's dual-state requirement (finding 10): a classifier that hard-codes `retryable: true` passes the 5xx rows and fails only the 4xx row.

Assert also that the produced message contains the status code and the route ref and contains neither the response body nor any header value.

Run:

```bash
pnpm --filter @autostack/model-router test -- http-classification.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/failure/http-classification.js'`.

- [ ] **Step 5: Implement `classifyTransportResponse` and verify**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
pnpm format:check
```

- [ ] **Step 6: Commit**

```bash
git add packages/model-router && git commit -m "feat(model-router): scaffold the package and the routing failure taxonomy"
```

---

## Task 2: Route registry — pinned models, `getRoute`, and `recordUsage`

**Cleared to start before the base rebase.**

**Files:**

- Create: `packages/model-router/src/route-registry.ts`
- Create: `packages/model-router/src/usage/exact-usage-sink.ts`
- Test: `packages/model-router/test/route-registry.test.ts`

- [ ] **Step 1: Add the failing registry test**

Assert that `createRouteRegistry(routes)`:

- admits every route through `ModelRouteSchema.parse` at construction and throws on the first invalid one, naming the index but **not** the transport's `credentialRefId`;
- rejects duplicate `routeRef` values;
- returns a frozen route from `getRoute(routeRef)` and `undefined` for an unknown ref;
- returns routes in declaration order from `list()`, **including disabled ones** — a disabled route must stay in the candidate set through pipeline stage 4, because `route_disabled` is only distinguishable from `capability_unavailable` if the disabled route is still there to be capable;
- exposes `pinnedModel(route)` returning `gatewayModel`, `openRouterModel`, or `providerModel` per transport kind, over an exhaustive switch with a `never`-typed default so a future transport kind is a compile error (DEC-0 stage 3 depends on this being total).

Run:

```bash
pnpm --filter @autostack/model-router test -- route-registry.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/route-registry.js'`.

- [ ] **Step 2: Implement the registry**

Immutable: the constructor deep-freezes the parsed routes and every accessor returns a copy or a frozen value. No route is ever mutated after admission.

- [ ] **Step 3: Add the failing `recordUsage` test**

`recordUsage(usage: ModelUsage)` — the port's flat exact-numbers surface — parses through `ModelUsageSchema` and forwards to an injected `ExactUsageSink` (finding 19). Assert that a valid payload reaches the sink exactly once, that a payload failing the schema is rejected before the sink is touched, and that the rejection message contains no field values.

Run:

```bash
pnpm --filter @autostack/model-router test -- route-registry.test.ts
```

Expected failure (behavioral — the module now exists): `recordUsage is not a function` on the registry object; after it is stubbed, the sink assertion fails with `expected 1 call, received 0`.

- [ ] **Step 4: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): admit and index model routes with pinned models"
```

---

## Task 3: Catalog discovery — aggregator transports (Gateway, OpenRouter)

**Files:**

- Create: `packages/model-router/src/catalog/catalog-types.ts`
- Create: `packages/model-router/src/catalog/gateway-catalog.ts`
- Create: `packages/model-router/src/catalog/openrouter-catalog.ts`
- Create: `packages/model-router/test/fixtures/gateway-models.json`
- Create: `packages/model-router/test/fixtures/openrouter-models.json`
- Create: `packages/model-router/test/support/fixture-fetch.ts`
- Create: `packages/model-router/test/support/fake-credential-resolver.ts`
- Test: `packages/model-router/test/gateway-catalog.test.ts`
- Test: `packages/model-router/test/openrouter-catalog.test.ts`

- [ ] **Step 1: Build the test doubles**

`test/support/fixture-fetch.ts` exports `createFixtureFetch(routes)` returning a `typeof globalThis.fetch` that matches on method + URL and returns a `Response` built from a fixture file, plus a recorded call log of `{ url, method, headerNames }` — **header names only, never values**, so a leaked credential cannot be asserted into existence by a test. Unmatched requests reject with a distinctive error, so an accidental live call fails loudly rather than escaping the suite. Scripted status codes and a `throws` mode cover the failure paths.

`test/support/fake-credential-resolver.ts` exports a `CredentialResolver` double returning a recognizable fixture secret and counting resolutions per `CredentialRefId`, so tests can assert _how many times_ and _at which sites_ a secret was materialized (finding 3).

- [ ] **Step 2: Add the failing Gateway catalog test**

`test/fixtures/gateway-models.json` holds a hand-authored `GET https://ai-gateway.vercel.sh/v1/models` payload with four entries covering: text-only, text+image input, a model declaring tool-calling and structured output, and a reasoning model with pricing. Assert `discoverGatewayCatalog({ route, credentials, fetch, now })`:

- **resolves the route's credential exactly once and uses it to authenticate the request** — this is the second legitimate call site (finding 3). The `Authorization` header's presence is asserted by **name**; its value is never read by the test.
- issues exactly one GET to the gateway models URL;
- returns one `ModelCatalogEntry` per payload entry, each passing `ModelCatalogEntrySchema.parse`, with `routeRef` set from the route and `discoveredAt` from the injected clock;
- maps provider modality strings into `MODEL_MODALITIES` and provider capability strings into `MODEL_FEATURES`, **dropping** unmapped values rather than passing them through — `ModelCatalogEntrySchema` would reject them, and silently widening a closed enum is the drift those enums exist to prevent;
- carries pricing into `RoutePricing` for entries that report it and omits it for those that do not;
- raises `provider_error` (retryable `true`) on a payload whose top-level shape does not parse, and `rate_limited` on HTTP 429;
- **does not** resolve the credential when the route's snapshot is served from cache — asserted in Task 5, noted here so the resolver's call count stays meaningful.

Run:

```bash
pnpm --filter @autostack/model-router test -- gateway-catalog.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/catalog/gateway-catalog.js'`.

- [ ] **Step 3: Implement the Gateway parser**

Parse the response with `.strict()`-per-object Zod schemas local to this module — provider payloads are untrusted input (spec §14.1). Unknown _entries_ are skipped with a counted reason; an unknown _envelope_ is a `provider_error`. Deduplicate by `providerModel`, keeping the first.

- [ ] **Step 4: Add the failing OpenRouter catalog test**

Same assertions against `GET https://openrouter.ai/api/v1/models`, with the fixture exercising OpenRouter's documented shape: `data[].id`, `.name`, `.context_length`, `.architecture.input_modalities`, `.architecture.output_modalities`, `.supported_parameters`, `.top_provider.max_completion_tokens`, `.pricing.prompt` / `.pricing.completion`. Add one case proving `supported_parameters` containing `tools` yields the `tool_call` feature and `reasoning` yields the `reasoning` feature, and one proving an unmapped parameter name is dropped.

Run:

```bash
pnpm --filter @autostack/model-router test -- openrouter-catalog.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/catalog/openrouter-catalog.js'`.

- [ ] **Step 5: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): discover gateway and openrouter model catalogs"
```

---

## Task 4: Catalog discovery — direct transports (OpenAI, Anthropic, xAI) and DEC-1

**Files:**

- Create: `packages/model-router/src/catalog/direct-catalog.ts`
- Create: `packages/model-router/src/catalog/declared-capabilities.ts`
- Create: `packages/model-router/test/fixtures/openai-models.json`
- Create: `packages/model-router/test/fixtures/anthropic-models.json`
- Create: `packages/model-router/test/fixtures/xai-models.json`
- Test: `packages/model-router/test/direct-catalog.test.ts`

- [ ] **Step 1: Add the failing direct-catalog test**

One `describe` per provider, driven from the route's `transport.protocol` + `transport.provider` + `transport.endpoint` (already refined by the contract to carry no credentials). Every block asserts the credential is resolved once and sent under the provider's expected header **name** (finding 3):

- **openai** (`openai_compatible` / `openai`) — `GET {endpoint}/models` returning `{ object: "list", data: [{ id, object, created, owned_by }] }`, `Authorization` header. Assert every entry lands at the DEC-1 conservative floor: `inputModalities: ["text"]`, `outputModalities: ["text"]`, `features: []`.
- **anthropic** (`anthropic` / `anthropic`) — `GET {endpoint}/v1/models` returning `{ data: [{ type, id, display_name, created_at }], has_more, first_id, last_id }`, `x-api-key` header. Assert `displayName` comes from `display_name`, the same capability floor applies, and a `has_more: true` page is followed via `after_id` for at most a bounded number of pages — asserted with a fixture that would otherwise loop forever.
- **xai** (`openai_compatible` / `xai`) — `GET {endpoint}/v1/language-models` returning entries with `input_modalities`, `output_modalities`, and pricing. Assert modalities are read from the provider rather than floored, and pricing lands in `RoutePricing`.

Then the DEC-1 override case: with `declaredCapabilities` supplying an entry for one OpenAI model, that model's catalog entry carries the declared modalities/features while its siblings stay at the floor. Assert a declared capability outside `MODEL_MODALITIES`/`MODEL_FEATURES` is rejected at **construction**, not at discovery, and that a declaration for a model the provider did **not** list cannot resurrect it — the overlay is applied after parsing, never before.

Run:

```bash
pnpm --filter @autostack/model-router test -- direct-catalog.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/catalog/direct-catalog.js'`.

- [ ] **Step 2: Implement the direct parsers and the declared-capability overlay**

One small parser per protocol behind a shared shape; same fail-closed envelope handling as Task 3.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): discover direct provider catalogs with a conservative capability floor"
```

---

## Task 5: Catalog cache — per-route snapshots, freshness, and the staleness ceiling

**Files:**

- Create: `packages/model-router/src/catalog/catalog-cache.ts`
- Create: `packages/model-router/src/catalog/catalog-discovery.ts`
- Test: `packages/model-router/test/catalog-cache.test.ts`

- [ ] **Step 1: Add the failing cache test**

`createCatalogCache({ discover, now, ttlMs, maxStaleMs })` with an injected clock, keyed **per route** (DEC-5). Assert:

- a first read discovers and returns `{ freshness: "fresh", entries, discoveredAt }`;
- a read inside `ttlMs` returns the cached snapshot without a second `fetch` **and without a second credential resolution** (asserted from both the fixture-fetch call log and the fake resolver's counter — finding 3);
- a read after `ttlMs` rediscovers and returns `fresh`;
- **a rediscovery failure with a cached snapshot present returns that snapshot with `freshness: "stale"` and does not raise** — the charter's "stale-but-present cached catalog is representable";
- **a stale snapshot older than `maxStaleMs` raises `provider_error` (retryable `true`)** rather than being served, with boundary assertions at exactly `maxStaleMs` (served, stale) and one millisecond past it (raises) — finding 7;
- a rediscovery failure with **no** cached snapshot raises the classified `ModelRoutingError` from Task 1, attributed with `routeRef`;
- two routes sharing a provider but differing in `credentialRefId` keep **independent** snapshots — one route's discovery never populates the other's (DEC-5);
- concurrent reads during an in-flight discovery share one request (single-flight, finding 20), asserted by two awaited reads producing one logged `fetch` call;
- defaults are `ttlMs` 900_000 and `maxStaleMs` 86_400_000 when unspecified;
- a snapshot is never mutated after creation — a caller mutating the returned array cannot affect the next read.

Run:

```bash
pnpm --filter @autostack/model-router test -- catalog-cache.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/catalog/catalog-cache.js'`.

- [ ] **Step 2: Implement the cache and the per-transport discovery dispatcher**

`catalog-discovery.ts` switches on `route.transport.kind` (and, for `direct`, on `protocol`/`provider`) and delegates to Tasks 3–4, threading the `CredentialResolver` through. The switch is exhaustive over `ModelTransportSchema`'s discriminated union with a `never`-typed default.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): cache per-route catalogs with an explicit staleness ceiling"
```

---

## Task 6: Pinned-model capability filtering, selection, and parity with the shared fake

**Files:**

- Create: `packages/model-router/src/catalog/capability-filter.ts`
- Create: `packages/model-router/src/selection/select-route.ts`
- Test: `packages/model-router/test/capability-filter.test.ts`
- Test: `packages/model-router/test/selection-parity.test.ts`

- [ ] **Step 1: Add the failing capability-filter test (DEC-0)**

A route's eligible capability set is the union of `inputModalities`, `outputModalities`, and `features` **of the single entry whose `providerModel` equals the route's pinned model** — never a union across entries (pipeline stage 3). Assert:

- a single-entry catalog matching the pin behaves as `declaredCapabilities` in `packages/domain/src/testing/fake-model-router.ts:67` does;
- **a multi-entry catalog in which a sibling entry declares `tool_call` and the pinned entry does not excludes the route** for a `tool_call` station — the union bug's dedicated tripwire;
- a pin absent from a successful discovery excludes the route with the "pinned model absent" reason, distinct from the missing-capability reason;
- one missing capability drops the route; an empty `requiredCapabilities` keeps every route whose pin resolves;
- the filter reads only from `ModelCatalogEntry` values, never from route display names or transport fields.

Run:

```bash
pnpm --filter @autostack/model-router test -- capability-filter.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/catalog/capability-filter.js'`.

- [ ] **Step 2: Add the failing selection-parity test**

This is the charter's "swapping fake→real changes nothing for S1/S4", made mechanical. A table of scenarios — each a set of `{ route, catalogEntry }` declarations plus a `ModelRouteContext` — runs through **both** `createFakeModelRouter` from `@autostack/domain/testing` **and** the real selection function, asserting identical outcomes. Rows (findings 9 and DEC-0):

| Scenario                                                            | Expected from both                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Every capable route enabled                                         | same `routeRef` selected                                                                        |
| No route declares a required capability                             | `capability_unavailable`, `retryable: false`                                                    |
| Capable routes exist, all `enabled: false`                          | `route_disabled`, `retryable: false`, `routeRef` attributed                                     |
| Capable+enabled route alongside a capable+disabled one              | selected, no failure                                                                            |
| Required capability declared only by a disabled route               | `route_disabled`, **not** `capability_unavailable`                                              |
| **Multi-entry catalog where the pinned model is the least capable** | route filters out → `capability_unavailable` (DEC-0, mandatory)                                 |
| Selection echoes the request's `idempotencyKey`                     | identical `idempotencyKey` on both selections                                                   |
| `selectedAt` comes from the injected clock                          | identical timestamp, and not `Date.now()`                                                       |
| Attribution overrides any scripted value                            | `workspaceId`/`runId`/`stageRunId`/`stage` from the context, not the script                     |
| `getRoute` on an unknown ref                                        | `undefined` from both, not a throw                                                              |
| `recordUsage` isolation                                             | the flat sink receives the payload; **no** `ModelUsageRecord` is emitted by `recordUsage` alone |

The fake's catalog is one entry per route, so the multi-entry row is driven against the real router with a fake declaration set constructed to match — the assertion is that the real router reaches the same _outcome_ the fake reaches for the equivalent single-entry pin, which is what makes the union bug visible.

Run:

```bash
pnpm --filter @autostack/model-router test -- selection-parity.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/selection/select-route.js'`.

- [ ] **Step 3: Implement `selectRoute`**

Implements pipeline stages 2–5 and 7 (stage 1 policy admission arrives in Task 7, stage 6 budget likewise). The result is a `ModelRouteSelectionSchema`-parsed value whose `reason` names the chosen route, the catalog `freshness`, and the snapshot's `discoveredAt` (finding 7), composed from safe values only, and whose `selectedAt` comes from the injected clock.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): select on the pinned model's declared capabilities"
```

---

## Task 7: Policy evaluation — admission, ordering, reasoning, and ceilings

**Files:**

- Create: `packages/model-router/src/policy/policy-registry.ts`
- Create: `packages/model-router/src/policy/evaluate-policy.ts`
- Create: `packages/model-router/src/policy/budget.ts`
- Test: `packages/model-router/test/evaluate-policy.test.ts`
- Test: `packages/model-router/test/budget.test.ts`

- [ ] **Step 1: Add the failing policy-admission test (finding 5, pipeline stage 1)**

Assert:

- `createPolicyRegistry` throws a `TypeError` when two policies declare the same `stage` — a stage with two policies has no defined constraint, and picking one silently would make the router's behavior depend on array order;
- evaluating a context whose `stage` has **no** configured policy throws a `TypeError` at the call boundary and **never** falls back to "all routes allowed" — a missing constraint must never be more permissive than any constraint;
- neither is a `ModelRoutingError`: both are composition-root programming errors, not conditions a station retries;
- a policy whose `stage` differs from the context's `stage` is likewise a `TypeError`.

Run:

```bash
pnpm --filter @autostack/model-router test -- evaluate-policy.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/policy/policy-registry.js'`.

- [ ] **Step 2: Add the failing policy-filtering test**

Assert:

- only routes in `allowedRouteRefs` are candidates, excluded at pipeline **stage 1** — a route absent from the policy is gone before the capability filter runs, so an out-of-policy route can never be the reason a station reads `capability_unavailable` (finding 4). Test this directly: a policy excluding the only `tool_call`-capable route yields `capability_unavailable` whose reason names the _allowed_ routes' missing capabilities and does not mention the excluded route.
- the preferred route is the first surviving `allowedRouteRefs` entry, and `fallbackRouteRefs` supplies the ordered remainder (the contract already refines fallbacks to be a subset of allowed);
- `reasoningLevel` other than `none` contributes the `reasoning` feature to the effective required set at stage 4, so routes without it are excluded there and an emptied set reports `capability_unavailable` rather than needing a code the taxonomy does not have.

Run:

```bash
pnpm --filter @autostack/model-router test -- evaluate-policy.test.ts
```

Expected failure (behavioral — the module now exists): the allowed-route filter is not applied, so the excluded route is selected and the assertion reads `expected "capability_unavailable", received a selection for route:excluded`.

- [ ] **Step 3: Add the failing budget test (DEC-2, DEC-3)**

Cost ceiling:

- `maxCostMicros` set, pricing known and under the ceiling → eligible;
- known and over → ineligible; all candidates over → `budget_exceeded`, `retryable: false`;
- pricing **unknown** → ineligible (DEC-2, fail closed); all unknown → `budget_exceeded`;
- `maxCostMicros` unset with unknown pricing → eligible.

Token ceilings, both directions and both times (finding 8, DEC-3):

- `maxOutputTokens` set above a route's declared `maxOutputTokens` → route ineligible;
- `maxInputTokens` set above a route's declared `contextWindowTokens` → route ineligible;
- a route declaring neither, under a policy setting the corresponding ceiling → ineligible;
- invocation-time stated **output** demand above `policy.maxOutputTokens` → `budget_exceeded`, `retryable: false`, raised before any provider call;
- invocation-time stated **input** demand above `policy.maxInputTokens` → same;
- the `budget_exceeded` message names the ceiling and the route ref and contains no pricing arithmetic that could be mistaken for a quote.

Run:

```bash
pnpm --filter @autostack/model-router test -- budget.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/policy/budget.js'`.

- [ ] **Step 4: Implement, re-run the Task 6 parity table, verify, commit**

The parity table must still pass **unchanged**: it configures a permissive policy listing every route and setting no ceilings, so stages 1 and 6 are no-ops and the real router's remaining stages are exactly the fake's.

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): evaluate per-station policy and budget ceilings"
```

---

## Task 8: Fallback runner and route-event recording

**Cleared to start before the base rebase.** The `attempt` callback is a plain higher-order function, so this task is provider- and contract-independent.

**Files:**

- Create: `packages/model-router/src/fallback/fallback-runner.ts`
- Create: `packages/model-router/src/fallback/route-event-sink.ts`
- Test: `packages/model-router/test/fallback-runner.test.ts`

- [ ] **Step 1: Add the failing fallback test**

`runWithFallback({ order, context, attempt, sink, now })` where `attempt` is an injected `(target: ModelRouteTarget, ordinal: number) => Promise<T>`. Assert:

- a first-attempt success records **no** fallback and calls `attempt` once with ordinal `0`;
- a retryable failure on the first target advances to the second and records exactly one `ModelRouteFallback`, parsed through `ModelRouteFallbackSchema`, with `from`/`to` set to the two targets, `failureCode` set to the raised `ModelRoutingError.code` (taxonomy-bound), attribution copied from the context, and `occurredAt` from the injected clock;
- a **non-retryable** failure does not advance and records no fallback — falling back after `budget_exceeded` or `capability_unavailable` would spend money on a request the policy already refused;
- ordinals increment across attempts, so DEC-4's per-attempt usage records have a stable key;
- exhausting the order re-raises the **last** failure, preserving its code and retryability;
- two fallbacks produce two records in activation order;
- the sink receiving a record is awaited, and a sink rejection **propagates** rather than being swallowed — spec §15 requires the route event to exist, so losing it silently is not acceptable;
- a degenerate order where two adjacent targets share route+model raises **before** calling `attempt` — the contract refinement would reject the record, and discovering that at record time would mean the attempt already ran.

Run:

```bash
pnpm --filter @autostack/model-router test -- fallback-runner.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/fallback/fallback-runner.js'`.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): record ordered fallback activations as route events"
```

---

## Task 9: Per-attempt usage normalization

**Assumes the post-rebase `ModelUsageRecordSchema.attempt` field (DEC-4).**

**Files:**

- Create: `packages/model-router/src/usage/normalize-usage.ts`
- Create: `packages/model-router/src/usage/usage-sink.ts`
- Test: `packages/model-router/test/normalize-usage.test.ts`

- [ ] **Step 1: Add the failing normalization test**

`normalizeUsage({ context, adapterId, attempt, requested, actual, providerUsage, latencyMs, outcome, now })` → `ModelUsageRecord`. Assert:

- **attribution is derived from the request, never from the provider response** — `workspaceId`, `runId`, `stageRunId`, `stage`, and `idempotencyKey` come from the context, and a `providerUsage` payload carrying conflicting values for any of them is ignored, not merged (spec §10.2);
- **`routeRef` is an explicit top-level input, NOT read from the context** (corrected 2026-08-27). Revision 2 listed it among the context-derived fields, which was simply wrong — `ModelRouteContextSchema` has no `routeRef`; the route is chosen by selection, not stated by the request. It also _must_ be explicit for correctness: after a fallback, the record has to name the route of the attempt it describes, not the route originally selected, and only a per-attempt input can express that. This mirrors `runWithFallback`, which likewise takes the context and the target separately;
- a provider reporting all four token counts yields four `{ state: "reported", value }` entries;
- a provider reporting **none** yields four `{ state: "unknown" }` entries and `cost: { state: "unknown" }` — never zeros, which is exactly what the flat `ModelUsageSchema` would silently have produced;
- a provider reporting input and output but not cached/reasoning yields two `reported` and two `unknown` — partial data stays partial;
- a negative, non-integer, or non-numeric provider count becomes `unknown` rather than being coerced or clamped;
- `cost` is `reported` only when the provider reports a cost **or** the route's `RoutePricing` and the reported token counts together determine it exactly; a cost derived from an `unknown` token count is `unknown`;
- `requested.model` differs from `actual.model` after a fallback and both survive into the record — this is what makes §15's "cost reporting reflects the actual provider/model" true;
- **`attempt` is the zero-based ordinal**, and a three-attempt chain under one `idempotencyKey` yields three records with ordinals `0, 1, 2` (DEC-4);
- **a failed attempt still produces a record** with `outcome: "failed"` and whatever the provider billed, so a billed failure is never dropped;
- `outcome` covers `succeeded | failed | cancelled`;
- every produced record passes `ModelUsageRecordSchema.parse`;
- the record contains no provider response text, no request id from an untrusted field that fails `StableRefSchema`, and no header value.

Run:

```bash
pnpm --filter @autostack/model-router test -- normalize-usage.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/usage/normalize-usage.js'`.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): normalize per-attempt usage without estimating unknowns"
```

---

## Task 10: Transport clients over the Vercel AI SDK

**Rebase landed; unblocked.** Implements `ModelInferencePort` as verified in ESC-1.

**Files:**

- Create: `packages/model-router/src/transport/transport-client.ts`
- Create: `packages/model-router/src/transport/language-model-factory.ts`
- Test: `packages/model-router/test/language-model-factory.test.ts`

- [ ] **Step 1: Add the failing factory test**

**Revised at rebase (see ESC-1).** Task 10 implements `ModelInferencePort` — `run(request: ModelInferenceRequest): Promise<ModelInferenceResult>` — over an internal `createLanguageModelFactory({ credentials, fetch })`. `ModelRouteHandle` stays S3-internal and is not exported. `run` reads `request.selection.routeRef` to find the route, builds the language model for its transport, issues one `generateText`, maps the provider finish reason into `ModelFinishReasonSchema` (failing closed on an unrecognized value rather than widening the enum), preserves unreported token counts and cost as `unknown`, and returns a result admitted through `admitModelInferenceResult(request, result)`. Every failure is raised as `ModelRoutingError` so the taxonomy survives the call.

Using the fixture-fetch double as the AI SDK provider's `fetch` option, assert for each of the five transport configurations (gateway, openrouter, direct-openai, direct-anthropic, direct-xai):

- a language model is produced whose `provider` and `model` match the route's transport fields, with `model` equal to the **pinned** model (DEC-0);
- driving a minimal `generateText` through it issues exactly one request to the expected provider URL, carrying an `Authorization` (or `x-api-key`, for Anthropic) header whose **name** is asserted and whose value is never read (finding 14 — `generateText` only; streaming is S1's concern and appears nowhere in this package);
- the secret is resolved from the credential store **at this call** — `credentials.resolve` is called once per model construction, and the factory holds no secret field afterwards, asserted by `JSON.stringify(factory)` and `util.inspect(handle, { depth: null })` containing no fragment of the fixture secret;
- **this and catalog discovery are the only two sites that resolve a credential** — the fake resolver's per-site counter is asserted, so a third call site added later fails this test (finding 3);
- an unknown `transport.kind` is a compile error via the exhaustive switch and, defensively, a `TypeError` at runtime;
- a provider HTTP error surfaces through `classifyTransportResponse` as a `ModelRoutingError`, not as a raw AI SDK error, so callers only ever see the taxonomy.

Run:

```bash
pnpm --filter @autostack/model-router test -- language-model-factory.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/transport/language-model-factory.js'`.

- [ ] **Step 2: Implement the factory**

One small module per transport kind, each a call to the corresponding AI SDK provider factory with `{ apiKey, baseURL, fetch }`. `apiKey` is read from the injected credential resolver **inside the factory call expression** and is never assigned to a variable that outlives it.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): build language models per transport over the AI SDK"
```

---

## Task 11: Credential reference store

**Cleared to start before the base rebase.**

**Files:**

- Create: `packages/model-router/src/credential/secret-protector.ts`
- Create: `packages/model-router/src/credential/credential-file-layout.ts`
- Create: `packages/model-router/src/credential-ref-store.ts`
- Test: `packages/model-router/test/credential-ref-store.test.ts`

Follows `apps/desktop/src/main/credential-store.ts` — the same `SecretProtector` shape, the same `0o600` file / `0o700` directory modes, the same ownership and symlink checks, the same atomic `open(..., "wx")` + `link` write. **`apps/desktop` is not modified.**

- [ ] **Step 1: Re-declare `SecretProtector` locally with its reconciliation note (finding 18)**

`src/credential/secret-protector.ts` declares the interface again rather than importing it:

```ts
/**
 * Structurally identical to `apps/desktop/src/main/credential-store.ts`'s `SecretProtector`, and
 * deliberately re-declared: `packages/model-router` must not import from `apps/desktop`, and hoisting
 * the interface into `@autostack/contracts` is not S3's to do. Wave 2 wires the desktop main process
 * to this store and reconciles the two declarations into one; until then the duplication is the
 * boundary, not an oversight. Electron `safeStorage` satisfies this shape as-is.
 */
export interface SecretProtector {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
```

`credential-file-layout.ts` carries the locator-semantics comment (finding 18): a `macos_keychain` `CredentialRef`'s `locator` is a _reference_ — a service/account pair naming where the Keychain holds the secret — and this file-backed, `safeStorage`-protected store is Milestone A's local realization of that reference, not a second source of truth. The on-disk filename is a digest of `store` + `locator`, so the locator is never interpreted as a path.

- [ ] **Step 2: Add the failing round-trip test**

`createCredentialRefStore({ root, protector })` over a disposable temp directory and a fake protector (a reversible transform plus a toggleable `isAvailable`). Assert:

- `put(ref, secret)` then `resolve(ref)` returns the exact secret;
- `resolve` on an unknown `CredentialRefId` throws a store error naming the id and nothing else;
- only the `macos_keychain` variant of `CredentialRefSchema` is accepted; `vercel`, `server_encrypted`, and `external_vault` refs are refused with an "unsupported credential store" error — spec §14.3 scopes Milestone A local secrets to the Keychain, and silently accepting a store we do not implement is the opposite of fail-closed;
- the digest-derived filename contains a hostile locator safely — asserted with a `service`/`account` containing `../`, a NUL byte, and a path separator, verifying nothing is written outside `root` and that two distinct locators never collide.

Run:

```bash
pnpm --filter @autostack/model-router test -- credential-ref-store.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/credential-ref-store.js'`.

- [ ] **Step 3: Add the failing fail-closed test**

With `protector.isAvailable()` returning `false`, assert `put`, `resolve`, **and** store construction all throw, that nothing is written to the root, and that the thrown message contains no secret. Then the same for a protector whose `encrypt` returns an empty buffer and one whose `decrypt` throws — both are "protection unavailable", not "credential missing", because reporting a protection failure as an absence would invite a caller to re-create the credential.

Run:

```bash
pnpm --filter @autostack/model-router test -- credential-ref-store.test.ts
```

Expected failure (behavioral — the module now exists): construction succeeds with an unavailable protector, so the assertion reads `expected function to throw, but it did not`.

- [ ] **Step 4: Add the failing no-plaintext-at-rest and no-leak test**

- Read the raw file bytes after `put` and assert they contain no substring of the plaintext secret — checked at every offset, not as a whole-buffer compare.
- Assert directory mode `0o700` and file mode `0o600`, and that a pre-existing file with wider modes or foreign ownership is refused rather than read.
- Assert `JSON.stringify(store)`, `util.inspect(store, { depth: null })`, `String(store)`, and the message **and stack** of every error the store can throw contain no fragment of the secret (R3).
- Assert the store exposes no accessor returning a cached plaintext — `resolve` reads and decrypts from disk each time, so there is no in-memory secret to leak.
- Assert `delete(refId)` removes the file and a subsequent `resolve` throws the unknown-id error.

Run:

```bash
pnpm --filter @autostack/model-router test -- credential-ref-store.test.ts
```

Expected failure (behavioral): the raw-bytes assertion reads `expected ciphertext not to contain the plaintext secret` against the identity-transform fake protector until the real encrypt path is wired.

- [ ] **Step 5: Implement, verify, commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): store credential references behind an injected protector"
```

---

## Task 12a: Compose `createModelRouter(deps)`

**Files:**

- Create: `packages/model-router/src/model-router.ts`
- Modify: `packages/model-router/src/index.ts`
- Test: `packages/model-router/test/model-router.test.ts`

- [ ] **Step 1: Add the failing composition test**

```ts
export interface ModelRouterDependencies {
  readonly routes: readonly ModelRoute[];
  readonly policies: readonly ModelPolicy[];
  readonly credentials: CredentialResolver;
  readonly routeEvents: ModelRouteEventSink;
  readonly usage: ModelUsageSink;
  readonly exactUsage: ExactUsageSink;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => string;
  readonly catalogTtlMs?: number;
  readonly maxStaleMs?: number;
  readonly declaredCapabilities?: DeclaredCapabilityMap;
}
export const createModelRouter: (deps: ModelRouterDependencies) => ModelRouter;
```

Assert `createModelRouter(deps)` satisfies `ModelRouterPort` structurally (a `const port: ModelRouterPort = router` assignment compiles) and, post-rebase, `ModelInferencePort` likewise; that `resolve`/`getRoute`/`recordUsage` behave as Tasks 2, 6, and 7 specify when driven through the composed object; and that pipeline stage 1's two `TypeError`s (duplicate policy at construction, missing policy at resolve) fire through the composed surface, not only through the registry unit (finding 5).

`deps.policies` is **explicit** — composition supplies the spec §10.2 default personal policy (low-cost route for `triage`, higher-quality for `plan` and `isolated_review`) as data. There is no implicit default inside the router.

Run:

```bash
pnpm --filter @autostack/model-router test -- model-router.test.ts
```

Expected failure (first test against a new module): `Cannot find module '../src/model-router.js'`.

- [ ] **Step 2: Implement the composition root, verify, commit**

`model-router.ts` wires the registry, policy registry, cache, selection, budget, fallback runner, factory, and sinks; it contains no logic of its own beyond wiring, so the coverage floor is met by the units.

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "feat(model-router): compose the router from its evaluated stages"
```

---

## Task 12b: Per-transport integration matrix

**Files:**

- Test: `packages/model-router/test/transport-integration.test.ts`

- [ ] **Step 1: Add the failing per-transport test**

The charter's headline exit criterion: **catalog, selection, capability filtering, fallback-with-route-event, policy ceilings, and usage normalization each tested on fixtures for ALL THREE transports.** One `describe.each` over the five transport configurations — `vercel_ai_gateway`, `openrouter`, and `direct` × (openai, anthropic, xai) — each running the same assertions against that configuration's fixtures:

1. discovery populates the catalog from the fixture and the entries pass `ModelCatalogEntrySchema`;
2. the route's **pinned** model resolves against the fixture and a station requiring a capability that entry declares resolves to it (DEC-0);
3. a station requiring a capability declared only by a **sibling** entry raises `capability_unavailable` — the union tripwire, per transport;
4. a first-choice route failing with `rate_limited` falls back to the policy's next route, emitting exactly one taxonomy-coded `ModelRouteFallback`;
5. a policy cost ceiling below every candidate raises `budget_exceeded`, non-retryable;
6. a two-attempt chain emits **two** `ModelUsageRecord`s with ordinals `0` and `1`, the first `outcome: "failed"` and the second `succeeded`, the second's `actual` naming the fallback route, and unreported counts `unknown` (DEC-4);
7. **staleness:** a fresh snapshot yields a `selection.reason` naming `fresh` and the snapshot's `discoveredAt`; a rediscovery failure inside `maxStaleMs` yields a selection naming `stale` and still resolves; past `maxStaleMs` the resolve raises `provider_error` (finding 7).

Run:

```bash
pnpm --filter @autostack/model-router test -- transport-integration.test.ts
```

Expected failure (behavioral — the router exists after 12a): the first configuration's assertion 3 reads `expected ModelRoutingError capability_unavailable, received a selection` until the pinned-model filter is exercised through the composed path.

- [ ] **Step 2: Fix through, verify, commit**

```bash
pnpm --filter @autostack/model-router test
git add packages/model-router && git commit -m "test(model-router): prove every transport across catalog, policy, fallback, and usage"
```

---

## Task 12c: Taxonomy completeness and the credential-shaped sweep

**Files:**

- Test: `packages/model-router/test/taxonomy-completeness.test.ts`
- Test: `packages/model-router/test/credential-sweep.test.ts`

- [ ] **Step 1: Add the failing taxonomy-completeness test**

A table driven off `MODEL_ROUTING_FAILURE_CODES` itself — not a hand-maintained list — asserting every member is reachable **through the composed router** with the correct `retryable` value, each row's scenario derived from the rejection pipeline stage that owns it:

| Code                     | Pipeline stage | Scenario                                                           | `retryable` |
| ------------------------ | -------------- | ------------------------------------------------------------------ | ----------- |
| `capability_unavailable` | 4              | required capability absent from every allowed route's pinned entry | `false`     |
| `capability_unavailable` | 3              | pinned model absent from a successful discovery                    | `false`     |
| `route_disabled`         | 5              | the only capable route is `enabled: false`                         | `false`     |
| `budget_exceeded`        | 6              | cost ceiling below every candidate                                 | `false`     |
| `budget_exceeded`        | invocation     | stated output demand above `maxOutputTokens`                       | `false`     |
| `rate_limited`           | 2              | catalog fetch returns 429 with no cached snapshot                  | `true`      |
| `provider_error`         | 2              | catalog fetch returns 503, no cached snapshot                      | **`true`**  |
| `provider_error`         | 2              | catalog fetch returns 401, no cached snapshot                      | **`false`** |
| `provider_error`         | 2              | cached snapshot older than `maxStaleMs`                            | `true`      |

Both `provider_error` retryability states are mandatory rows (finding 10): the contract deliberately leaves that code either-way, so a router that hard-codes one is conformant to the schema and wrong in practice. The test asserts the union of observed `(code, retryable)` pairs covers every code in the enum, so a taxonomy member added upstream without an S3 path fails here.

Run:

```bash
pnpm --filter @autostack/model-router test -- taxonomy-completeness.test.ts
```

Expected failure (behavioral): the 401 row reads `expected retryable false, received true`.

- [ ] **Step 2: Add the failing credential-shaped sweep (finding 12)**

At the **composed router boundary** — not per unit — drive a full resolve → fallback → usage sequence with a fixture credential shaped like each entry in `KNOWN_CREDENTIAL_SPECS` (`sk-`, `xai-`, `Bearer …`, `eyJ…`, and the rest), then sweep every value the router emitted: the `ModelRouteSelection`, every `ModelRouteFallback`, every `ModelUsageRecord`, every `ModelRoutingError` message **and stack**, and the serialized router object. Assert none contains the fixture secret or matches a `KNOWN_CREDENTIAL_SPECS` pattern.

The sweep runs over the router's real emissions rather than a curated sample, so a field added later to any of those shapes is covered without the test being updated. Also assert the fake resolver recorded exactly two call sites (discovery, factory) across the whole sequence (finding 3).

Run:

```bash
pnpm --filter @autostack/model-router test -- credential-sweep.test.ts
```

Expected failure (behavioral): the `Bearer`-shaped fixture appears in the classified provider-error message until Task 1's "status code and route ref only" rule is enforced on every construction path.

- [ ] **Step 3: Fix through, verify, commit**

```bash
pnpm --filter @autostack/model-router test
pnpm --filter @autostack/model-router check
git add packages/model-router && git commit -m "test(model-router): cover the failure taxonomy and sweep for credential-shaped leaks"
```

---

## Task 13: Gate pass, coverage, and stream report

- [ ] **Step 1: Full gate suite from the worktree root**

```bash
pnpm format:check
pnpm check
pnpm build --filter '!@autostack/desktop'
pnpm --filter @autostack/model-router test:coverage
pnpm test
```

All green; coverage ≥80% on statements, branches, functions, and lines for `@autostack/model-router`. If `pnpm test` trips the known runner-local load flake, re-run once and note it (it did not trip on the pre-plan baseline).

- [ ] **Step 2: Self-review pass**

Against the charter and the global constraints: no scope creep beyond `packages/model-router/**`; no TODO/placeholder/disabled test; no `any` or non-null assertion; no secret reachable from any event, log, error, or serialized value; every provider payload parsed as untrusted input; exactly two credential call sites; no shell string anywhere; pristine test output (no unhandled rejections, no stray console writes); `git diff --stat <base>..HEAD` touches only `packages/model-router/**`, this plan, and `pnpm-lock.yaml` (ESC-2).

Re-read the rejection pipeline list and confirm the implementation's stage order matches it exactly — R4's union temptation and a reordered enabled/budget pair are the two regressions that would pass most of the suite.

- [ ] **Step 3: Write `.superpowers/sdd/stream-report.md` and reply MERGE_READY**

Report carries: exit-criterion-by-exit-criterion evidence, resolved dependency versions, DEC-0 through DEC-5 as implemented, the rebase outcome for `ModelInferencePort` and `ModelUsageRecordSchema.attempt`, coverage numbers, and full gate output.

---

## Exit criteria (charter, restated as a checklist)

- [ ] Catalog, selection, capability filtering, fallback-with-route-event, policy ceilings, usage normalization, **and catalog staleness** each tested on fixtures for all five transport configurations (Task 12b).
- [ ] Every member of `MODEL_ROUTING_FAILURE_CODES` reachable through the composed router with the correct `retryable` value, `provider_error` in **both** states (Task 12c).
- [ ] Selection parity with `createFakeModelRouter`, including the `capability_unavailable` vs `route_disabled` distinction and the mandatory least-capable-pin row (Task 6).
- [ ] A route's capabilities come from its pinned model's entry alone; a union is caught by a dedicated test at both the unit and integration levels (Tasks 6, 12b).
- [ ] Resolve fails closed for a stage with no configured policy; construction rejects duplicate policies (Tasks 7, 12a).
- [ ] Usage records are per attempt, and a billed failed attempt is never dropped (Tasks 9, 12b).
- [ ] Credential store: protector round-trip, fail-closed without OS protection, no plaintext at rest, no leak through serialization or error text; exactly two resolution call sites (Tasks 11, 12c).
- [ ] `apps/desktop` untouched.
- [ ] `pnpm format:check`, `pnpm check`, `pnpm build` (excluding desktop), `pnpm --filter @autostack/model-router test:coverage` ≥80%, and root `pnpm test` all green (Task 13).
