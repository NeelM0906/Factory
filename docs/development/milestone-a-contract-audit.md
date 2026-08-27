# Milestone A contract gap audit

**Task:** Wave 0 / Task 0.1 of `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md`
**Date:** 2026-08-26
**Scope:** `@autostack/contracts` audited against `docs/superpowers/specs/2026-08-20-autostack-design.md`
§8.2, §9.1–9.3, §10, §13, §15, and the six Wave 1 stream charters.
**Rule applied:** append-only. No existing export was renamed, removed, or changed in shape or
semantics; every pre-existing test passes unmodified.

Wave 1 stream leads: read the **Additions** section for the new shapes you are expected to build
against, and the **Resolved escalations** section for the two ingress-enum changes the orchestrator
approved after the first review pass.

**Revision 4 (Task 0.12 — the consolidated Wave 1 batch):** the six stream plans were written against
revision 3 and surfaced nine further gaps between them. Items 22–29 record them. Every change is
append-only on an existing export — new schemas, new optional fields, new `EVENT_TYPES` members with
their coherence rules — with one orchestrator-approved exception noted in item 27.

**Revision 3 (post Task 0.2):** building the shared fakes exercised these contracts against real
consumers for the first time and surfaced two gaps the audit had missed. Both were escalated and
approved before the change: `AgentHarnessPort` could not carry the detail events item 2 added
(see item 2 below), and `ModelRouterPort` had no vocabulary for the failure it raises (new item 21).

**Revision 2 (post-review):** adds the station-evidence digest contract (item 11), applies the two
orchestrator-approved ingress-enum widenings (item 15 / E1 / E2, now resolved), and adds approval
inbox paging (item 20).

## Verdict summary

| #   | Item                                                    | Verdict                                                |
| --- | ------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Harness capability declaration (§9.1)                   | GAP — fixed                                            |
| 2   | Session event union coverage + sequencing (§9.1, §13.3) | GAP — fixed                                            |
| 3   | Permission request/response round trip                  | GAP — fixed                                            |
| 4   | Installed vs authenticated status                       | GAP — fixed                                            |
| 5   | Session interruption on host loss (§15)                 | GAP — fixed                                            |
| 6   | Route transports gateway/openrouter/direct (§10.1)      | SUFFICIENT                                             |
| 7   | Discovered modalities/features (§10.1)                  | GAP — fixed                                            |
| 8   | Usage normalization with unknowns (§10.2)               | GAP — fixed                                            |
| 9   | Provider fallback as a route event (§15)                | GAP — fixed                                            |
| 10  | Model policy shape (§10.2)                              | GAP — fixed (belongs in contracts)                     |
| 11  | Per-station evidence content (§8.2)                     | GAP — fixed                                            |
| 12  | Bounded implement→review rework (§8.3)                  | GAP — fixed (counter was sufficient; the edge was not) |
| 13  | Clarification question/answer                           | GAP — fixed                                            |
| 14  | `PublishScope` binds branch + repo + diff (§14.2)       | SUFFICIENT                                             |
| 15  | Ingress delivery identifiers (§15)                      | SUFFICIENT — event coverage widened, see E1/E2         |
| 16  | Editable GitHub progress comments (§4.4)                | GAP — fixed                                            |
| 17  | Draft-PR body content (§4.4)                            | GAP — fixed                                            |
| 18  | Slack approval interactivity (§4.3)                     | GAP — fixed                                            |
| 19  | `WorkItem` intake with source references (§7)           | SUFFICIENT                                             |
| 20  | Approval/steer/cancel HTTP schemas                      | GAP — fixed                                            |
| 21  | Model routing failure taxonomy (§8.3, §10.1)            | GAP — fixed (revision 3)                               |
| 22  | Model invocation seam (§10.1)                           | GAP — fixed (revision 4)                               |
| 23  | Station document provenance (§16.2)                     | GAP — fixed (revision 4)                               |
| 24  | Triage and review digest helpers (§8.2)                 | GAP — fixed (revision 4)                               |
| 25  | Per-attempt usage ordinal (§10.2)                       | GAP — fixed (revision 4)                               |
| 26  | Desktop approval, steering, cancellation (§4.1)         | GAP — fixed (revision 4)                               |
| 27  | Rework from a failed verification (§8.2)                | GAP — fixed (revision 4, widening)                     |
| 28  | Pipeline, clarification, steering, agent relay events   | GAP — fixed (revision 4)                               |
| 29  | Work item on an agent invocation (§14.1)                | GAP — fixed (revision 4)                               |
| 30  | Shared failure-code normalization rule (§8.3)           | GAP — fixed (revision 4)                               |

## Agent contract — spec §9.1–9.3, streams S1 and S2

### 1. Declared support for steering, resume, permission modes, structured plans, model/reasoning selection — GAP

`AgentHarnessCapabilitiesSchema` (`packages/contracts/src/agent.ts:31`) declares `resume`,
`steering`, `permissions`, and `structuredPlans` only. Model and reasoning selection are absent even
though `AgentSessionSchema.capabilities` (`packages/contracts/src/entities.ts:222`) already carries
`modelSelection` — the descriptor could not honestly populate the session entity it feeds. Permission
_modes_ (spec §9.1, and named explicitly in the Wave 0 charter) had no representation at all.

**Addition:** `AgentHarnessProfileSchema` (`packages/contracts/src/agent.ts:170`) composes the
existing descriptor with a `selection` block (`modelSelection`, `reasoningSelection`,
`permissionModes`) and an `availability` block. Honesty is enforced by refinement: a harness whose
descriptor sets `capabilities.permissions: false` cannot declare permission modes, and modes must be
unique. The existing `AgentHarnessDescriptorSchema` is unchanged and still valid on its own.

### 2. Session event coverage and sequence numbers — GAP

Sequencing is fine: every agent event carries a positive `sequence`
(`packages/contracts/src/agent.ts:107`), and clients already resume domain streams from
`ListEventsResponseSchema.nextSequence` (`packages/contracts/src/api.ts:83`).

Coverage is not. `AgentSessionEventSchema` (`packages/contracts/src/agent.ts:112`) covers `started`,
`output`, `permission_requested`, `waiting`, `completed`, `failed`, and `cancelled`. Spec §9.1
requires normalized message, thought-summary, plan, tool-call, file-change, and usage events; S6's
charter needs them as separate panes (conversation, plan, diff, usage) and S1's charter must produce
them. Folding all six into `output.stream: "structured"` would push provider-specific parsing into
every consumer, which is the opposite of normalization.

**Addition:** `AgentSessionDetailEventSchema` (`packages/contracts/src/agent.ts:348`) adds `message`,
`thought_summary`, `plan`, `tool_call`, `file_change`, `permission_resolved`, `usage`, and
`interrupted`, all sharing the existing `sessionId`/`sequence`/`occurredAt` context so they interleave
in one sequence space. `AgentSessionStreamEventSchema` (`packages/contracts/src/agent.ts:354`) is the
combined union adapters emit and clients consume. `file_change.path` reuses
`RelativeWorkspacePathSchema`, so an agent cannot report a change outside the managed worktree.

**Revision 3 — the port could not carry them.** Declaring the union was not enough.
`AgentHarnessPort.start`/`resume` (`packages/contracts/src/agent.ts:411`) still returned
`AsyncIterable<AgentSessionEvent>`, the narrower lifecycle union, and revision 1 deliberately left the
port untouched. Async iterable element types are covariant, so `AsyncIterable<AgentSessionStreamEvent>`
is not assignable to it: no adapter could emit a single detail event through the only boundary it has,
which blocks S1's producer and every S6 pane that reads one. Both members now return
`AsyncIterable<AgentSessionStreamEvent>`. This is a widening — existing producers stay assignable, and
consumers that switch on `type` gain members to handle. No consumer existed when it landed.

### 3. Permission request/response round trip — GAP

`permission_requested` (`packages/contracts/src/agent.ts:131`) carries a `permissionRef`, a summary,
and an evidence digest — but no options and no response shape, so neither the S1 conformance suite
nor the pipeline's approval machinery could complete the round trip.

**Addition:** `AgentPermissionOptionSchema`, `AgentPermissionRequestSchema`
(`packages/contracts/src/agent.ts:232`), `AgentPermissionResponseSchema`
(`packages/contracts/src/agent.ts:263`), and `admitAgentPermissionResponse`
(`packages/contracts/src/agent.ts:368`). The response carries an `ApprovalId`, which is how the
pipeline's `Approval` record (`kind: "permission"`, `packages/contracts/src/entities.ts:274`) binds to
it. The admission helper rejects a response from a different session, a response to a different
`permissionRef`, a response against a stale evidence digest, or a selection the request never offered.
A request must offer at least one denial option. `AgentPermissionResponderPort`
(`packages/contracts/src/agent.ts:423`) is a separate interface so adapters that do not declare
`capabilities.permissions` simply do not implement it — `AgentHarnessPort` is untouched.

### 4. Installed vs authenticated status — GAP

Nothing in contracts represented probe results, yet S1's charter requires "installed/authenticated
status probing", S2's requires an `isInstalled()`/`isAuthenticated()` probe per adapter, and
acceptance criterion 6 surfaces it in the UI.

**Addition:** the `availability` block of `AgentHarnessProfileSchema`
(`packages/contracts/src/agent.ts:181`) — `installed`, `authenticated`, an optional non-secret
`detail`, and `checkedAt`. A refinement rejects `authenticated: true` while `installed: false`.

### 5. Session interruption / host loss — GAP

`AgentSessionSchema.status` already includes `interrupted`
(`packages/contracts/src/entities.ts:213`), but no event could drive that transition: on host or
process loss the async iterable simply ends. Spec §15 requires the session be marked interrupted with
evidence preserved, and S1's charter names "durable interruption marking on process loss".

**Addition:** the `interrupted` member of `AgentSessionDetailEventSchema` — `reason`, `retryable`, and
`evidenceDigests` for the partial evidence that must survive. It is deliberately distinct from
`failed`, matching the existing entity status vocabulary.

## Model contract — spec §10, stream S3

### 6. Route transports — SUFFICIENT

`ModelTransportSchema` (`packages/contracts/src/model.ts:48`) covers `vercel_ai_gateway`,
`openrouter`, and `direct`. The direct transport (`packages/contracts/src/model.ts:37`) carries a
`protocol` of `openai_compatible | anthropic | google` plus a free-form `provider` ref, so OpenAI
(`openai_compatible`/`openai`), Anthropic (`anthropic`), and xAI (`openai_compatible`/`xai`) are all
expressible today, and the endpoint refinement already forbids embedded credentials. No addition.

### 7. Discovered modalities and features — GAP

`ModelRouteContextSchema.requiredCapabilities` (`packages/contracts/src/model.ts:72`) states what a
station _needs_, but no schema states what a route _offers_, so §10.1's "UI filters choices by the
capability required by the station" was not implementable and S3's "catalog discovery with capability
filtering" had nothing to produce.

**Addition:** `ModelCatalogEntrySchema` (`packages/contracts/src/model.ts:127`) with
`inputModalities`, `outputModalities`, `features`, optional context/output token windows, and
`discoveredAt`. `MODEL_MODALITIES` and `MODEL_FEATURES` are closed enums so filtering is decidable;
duplicates are rejected. Filtering _logic_ stays in S3 — only the declaration is a contract.

### 8. Usage normalization — GAP

`ModelUsageSchema` (`packages/contracts/src/model.ts:86`) requires exact non-negative token counts and
an exact cost, has a single `provider`/`model` pair that cannot distinguish requested from actual, and
carries no outcome or run/stage attribution. Spec §10.2 requires all of those, and specifically
"Missing provider usage is recorded as unknown rather than estimated as exact" — which the existing
shape cannot express, since a missing count silently becomes `0`.

**Addition:** `ModelTokenCountSchema` and `ModelCostSchema` (`packages/contracts/src/model.ts:159`,
`:164`) are `reported | unknown` discriminated unions; `ModelUsageRecordSchema`
(`packages/contracts/src/model.ts:185`) adds workspace/run/stage/adapter attribution, separate
`requested` and `actual` provider+model, and an `outcome`. `ModelUsageSchema` is untouched and remains
valid for callers that genuinely have exact numbers.

### 9. Fallback / route-change event — GAP

`ModelRouteSelectionSchema` (`packages/contracts/src/model.ts:76`) records the route chosen up front;
nothing records a switch mid-request, so §15's "provider fallback is recorded as a route event" and
S3's "fallback with route-event recording" had no shape.

**Addition:** `ModelRouteFallbackSchema` (`packages/contracts/src/model.ts:230`) with `from`/`to`
route+model targets, `failureCode`, `reason`, and attribution. A refinement rejects a "fallback" that
changes neither route nor model, so the event cannot be recorded as a no-op.

`failureCode` was a bare `StableRefSchema` in revisions 1 and 2 — the shape said a fallback has a
reason without saying what the reasons are. Item 21 gives it a closed vocabulary to draw on.

### 10. Model policy — GAP (decision: it belongs in contracts)

**Decision:** contracts, not S3-internal. Spec §4.1 lists policy in the workbench right inspector, so
S6 must read it without importing S3; S4 selects routes per station and must evaluate the same
ceilings. Two consumers outside S3 means it crosses a contract boundary.

**Addition:** `ModelPolicySchema` (`packages/contracts/src/model.ts:318`) — `stage`,
`allowedRouteRefs`, ordered `fallbackRouteRefs`, optional `maxInputTokens`/`maxOutputTokens`/
`maxCostMicros`, and an optional `reasoningLevel`. A refinement rejects a fallback route that is not
also an allowed route, so a policy cannot escape its own constraint. Data-handling requirements
(zero-data-retention, approved provider lists) are **deferred**: §10.2 scopes them to team policy and
no Milestone A stream reads them.

### 21. Model routing failure taxonomy — GAP (revision 3)

`ModelRouterPort.resolve` (`packages/contracts/src/model.ts:372`) either returns a
`ModelRouteSelection` or raises, and nothing in contracts described the raise. Three streams have to
agree on why a route could not be resolved: S3 raises it, S4 decides from it whether to retry the
stage (§8.3 splits transient from deterministic failure), and S6 displays it. An adapter-local code
enum would have become a de-facto cross-stream interface without ever being reviewed as one — which
is exactly what the Task 0.2 fake did before this was added.

**Addition:** `MODEL_ROUTING_FAILURE_CODES` and `ModelRoutingFailureSchema`
(`packages/contracts/src/model.ts:220`, `:264`) declare the shared vocabulary — `capability_unavailable`,
`route_disabled`, `provider_error`, `rate_limited`, `budget_exceeded` — with secret-safe operator
text, a `retryable` flag, and optional `routeRef`/`requestedModel` attribution.
`ModelRoutingError` (`:299`) is the throwable form, and it admits its input in the constructor so an
unmodelled code cannot reach a caller's retry decision.

A refinement keeps §8.3's split structural rather than advisory. The three codes that describe the
_request_ — `capability_unavailable`, `route_disabled`, `budget_exceeded` — cannot declare themselves
retryable, because retrying the identical request cannot change the answer. `rate_limited` describes
the _moment_ and must stay retryable. `provider_error` is deliberately either, since only the adapter
knows whether a given provider fault was transient.

This also closes `ModelRouteFallbackSchema.failureCode` (item 9): the field binds to
`ModelRoutingFailureCodeSchema`, so a fallback recording a code outside the taxonomy is rejected
structurally. The earlier deferral of that binding rested on a false premise — there were no
recorded fallbacks to break, because the taxonomy and the schema landed in the same branch.

### 22. Model invocation seam — GAP (revision 4)

`ModelRouterPort` (`packages/contracts/src/model.ts:483`) resolves a route, records usage, and looks
one up. Nothing could **execute** one. S1's constraint that every model call goes through the router
was therefore unimplementable, and S3's `runWithRoute` had no contract to implement (S1 escalation
E1, S3 ESC-1). Two drafts existed and disagreed.

**Addition:** `ModelInferencePort` (`packages/contracts/src/model.ts:478`) with
`ModelInferenceRequestSchema` (`:390`), `ModelInferenceResultSchema` (`:412`), and
`admitModelInferenceResult` (`:441`), over `ModelMessageSchema` (`:372`),
`ModelGenerationOptionsSchema` (`:382`), `MODEL_MESSAGE_ROLES` (`:369`), and `MODEL_FINISH_REASONS`
(`:409`).

Reconciliation decisions, recorded because both drafts had to give something up:

- **The request carries the `ModelRouteSelection`, not a route handle.** S3's plan expected
  `ModelRouteHandle` to land here. It cannot: a handle wraps an AI SDK language model, and contracts
  must name no vendor type. S3 keeps `ModelRouteHandle` internal to `packages/model-router`, where
  the AI SDK already lives.
- **`SafeJsonObject` does not exist and was not created.** S1's draft referenced it for structured
  output. Instead `responseFormat: "json"` asks the provider for JSON _text_, and the caller that owns
  the document schema parses it — so no response schema crosses this boundary and prompt shapes stay
  entirely in S1, which is what S3's ESC-1 also required.
- **`maxOutputTokens` is required, not optional.** An unbounded generation cannot be checked against
  `ModelPolicySchema.maxOutputTokens` (`:325`), and a caller that does not care still has to say so.
- **No tool-calling and no streaming**, per S1's E5 ruling. The strict objects make both structurally
  impossible rather than merely undocumented.

The result preserves unknown provider usage through `ModelTokenUsageSchema`/`ModelCostSchema`, which
is the only reason §10.2's "recorded as unknown rather than estimated as exact" can hold at the
boundary that actually knows. Failures are `ModelRoutingError` (item 21), so the taxonomy survives
the call. `createFakeModelInference` (`packages/domain/src/testing/fake-model-inference.ts:35`) joins
the Task 0.2 fakes.

### 25. Per-attempt usage ordinal — GAP (revision 4)

A router that falls back keeps one `idempotencyKey` across attempts, because the caller asked once.
The per-attempt `ModelUsageRecord`s were therefore indistinguishable, and cost would be attributed to
whichever arrived last.

**Addition:** an append-only optional `attempt` ordinal on `ModelUsageRecordSchema`
(`packages/contracts/src/model.ts:213`), nonnegative rather than positive per S3's ruling, so a first
attempt may be numbered 0 or 1 without the contract taking a side.

**Convention, recorded so nobody "fixes" one into the other:** this field is a **0-based ordinal**
that indexes retries inside one call, matching S3's loop-index tests, and is therefore nonnegative.
`StageRunSchema.attempt`, `PipelineStageRequestSchema.attempt`, and the `stage.leased` payload's
`attempt` are **1-based counters** of how many times a stage has been executed, and are therefore
positive. Different semantics, both correct; the numeric bounds differ because the meanings do.

**Item 8 confirmed, not merely assumed.** S1's finding 12 claims `ModelUsageSchema` cannot express
unknown usage while `ModelUsageRecordSchema` can. Verified and now pinned by a test: the exact-count
shape's missing counts default to `0` and it rejects the `{ state: "unknown" }` variants outright,
while the record shape carries them. A producer holding unknowns must therefore not fall back to
`ModelUsageSchema` — doing so would fabricate zeros.

## Pipeline contract — spec §8, stream S4

### 11. Per-station evidence content — GAP

The evidence schemas are digest envelopes; the documents they address had no contract at all, so S1
(which produces triage/plan/review outputs) and S4 (which consumes and verifies them) would each have
invented an incompatible shape.

- `TriageEvidenceSchema` (`packages/contracts/src/pipeline.ts:46`) carries only `summary`; §8.2
  demands type, priority, complexity, duplicates, and actionability.
- `PlanEvidenceSchema` (`packages/contracts/src/pipeline.ts:54`) carries only `planDigest`; §8.2
  demands acceptance criteria, affected areas, risks, verification commands, and required
  permissions/secrets.
- `VerificationEvidenceSchema` (`packages/contracts/src/pipeline.ts:86`) carries only
  `status: "passed"`; §8.2 demands exact commands, exit codes, durations, and that a skipped required
  check be treated as failure — and a _failed_ verification could not be represented at all
  (needed for spec §17.4 journey 6).
- `ReviewEvidenceSchema.findings` (`packages/contracts/src/pipeline.ts:115`) carry severity, summary,
  and evidence digest but no file/location; §8.2 demands location "when applicable".

**Addition:** a new `packages/contracts/src/station-evidence.ts` holding the documents those digests
address — `TriageReportSchema` (`:44`), `PlanDocumentSchema` (`:90`), `VerificationReportSchema`
(`:157`), and `ReviewReportSchema` (`:216`). Enforced invariants worth knowing:

- A plan must name at least one **required** verification command (`station-evidence.ts:124`).
- `VerificationCommandSchema` (`:72`) is executable + args with an explicit `usesShell` flag, so spec
  §14.4's "that fact is visible in the plan approval" is structural rather than conventional.
- A verification report cannot claim `passed` while any required check failed **or was skipped**
  (`:173`) — §8.2's "skipped required checks are failure, not success" — and, symmetrically, cannot
  claim `failed` while every recorded check passed (`:183`).
- An executed check must record an exit code; a skipped one must not (`:151`).
- A review report cannot be `approved` while a critical or high finding stands (`:237`), mirroring the
  existing `ReviewEvidenceSchema` rule.

The existing evidence schemas are unchanged; these documents are what their digests cover.

**Digest contract (revision 2).** Declaring the documents was not enough: `planDigest`,
`verificationReportDigest`, and the fields that reference them had no byte-level serialization, so S1
(producer) and S4 (staleness verifier) could each have computed a different digest over the same
document. The station documents now follow the same canonicalize/digest/admit pattern as
`canonicalizePublishScopeForDigest` / `digestPublishScope` / `admitPublicationEvidenceBundle`
(`pipeline.ts:354-383`):

| Helper                                                          | Purpose                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `canonicalizePlanDocumentForDigest` (`station-evidence.ts:291`) | Explicit field list under domain `autostack.plan-document`             |
| `digestPlanDocument` (`:307`)                                   | Parse, canonicalize, SHA-256                                           |
| `admitPlanDocument` (`:362`)                                    | Rejects a plan whose `planDigest` does not cover its own content       |
| `canonicalizeVerificationReportForDigest` (`:322`)              | Explicit field list under domain `autostack.verification-report`       |
| `digestVerificationReport` (`:335`)                             | Parse, canonicalize, SHA-256                                           |
| `admitVerificationReport` (`:371`)                              | Rejects a report not bound to the plan it names, or from another run   |
| `admitReviewReport` (`:385`)                                    | Rejects a review not bound to this plan and this verification evidence |

Two canonicalization rules that S1 and S4 must both honour, and which differ deliberately:

- **The plan document excludes `planDigest` and `producedAt`.** `planDigest` is the digest itself.
  `producedAt` is record metadata, not approved content — spec §14.2 invalidates an approval only
  when the plan changes _materially_, so re-planning byte-identical content must digest identically.
  This mirrors `canonicalizePublishScopeForDigest`, which likewise excludes `createdAt`.
- **The verification report covers every field, including timestamps and durations.** It has no
  self-digest field to exclude, and unlike a plan it is evidence of one specific execution rather
  than approved content, so the binding from a review to the exact verification run it read should be
  strict.

`canonicalJson` (`runner.ts:455`) sorts object keys before hashing, so the key order in the
canonicalize functions does not affect the digest; array order does, which is correct for ordered
acceptance criteria and verification commands.

`ReviewReportSchema.reviewedDiffDigest` is intentionally **not** derived here — it is a reference to
`ImplementationEvidenceSchema.finalDiffDigest`, and `PublicationEvidenceBundleSchema`
(`pipeline.ts:284`) already enforces that binding.

### 23. Station document provenance — GAP (revision 4)

Spec §16.2 requires the prompt version behind a station document to be stored, and S1's native roles
produce triage, plan, and review documents from versioned prompts through a route. Nothing in the
document shapes could say so, which left that requirement aspirational (S1 escalation E2).

**Addition:** `StationProvenanceSchema` (`packages/contracts/src/station-evidence.ts:34`) as an
optional `producedBy` on `TriageReportSchema` (`:70`), `PlanDocumentSchema` (`:133`), and
`ReviewReportSchema` (`:243`), carrying `adapterId`, `promptRef`, `promptVersion`, and an optional
`routeRef`. Optional because a document may be authored by a human, or by an adapter with no prompt
registry.

`canonicalizePlanDocumentForDigest` already listed its fields explicitly, so provenance is excluded
from the plan digest for free — but the reason is now written down and pinned. Provenance is metadata,
not approved content: §14.2 invalidates an approval only on _material_ change, and if a prompt bump
moved the plan digest it would silently revoke every outstanding plan approval. This is the same
reasoning the contract already applies to `producedAt`.

### 24. Triage and review digest helpers — GAP (revision 4)

`PlanDocument` and `VerificationReport` had canonicalize/digest/admit helpers; `TriageReport` and
`ReviewReport` had none, so S1 (producer) and S4 (verifier) would each have invented one
(S1 escalation E3).

**Addition:** `canonicalizeTriageReportForDigest` (`packages/contracts/src/station-evidence.ts:385`),
`digestTriageReport` (`:405`), `canonicalizeReviewReportForDigest` (`:417`), `digestReviewReport`
(`:434`), and `admitTriageReport` (`:471`).

Both follow the **verification report's** rule rather than the plan document's: every field is
covered, `producedAt` and `producedBy` included, because both are evidence of one specific reading
rather than content a human approved. That asymmetry with the plan document is the point of the pair
and is asserted in both directions. An absent optional contributes nothing to the canonical form, so
a document that omits one and a document that sets it to `undefined` digest alike.

`admitTriageReport` binds a report to the digest it was recorded under. Triage is the first station:
there is no upstream document to bind to and no self-digest field, so that is the only check
available and the helper claims no more. `ReviewReport` keeps `admitReviewReport` for its upstream
binding, with `digestReviewReport` supplying the envelope check alongside it.

### 12. Bounded implement→review rework — GAP (partly sufficient)

The **counter** is durable and sufficient: `StageRunSchema.attempt`
(`packages/contracts/src/entities.ts:191`), `PipelineStageRequestSchema.attempt`
(`packages/contracts/src/pipeline.ts:385`), and the `stage.leased` event payload
(`packages/contracts/src/events.ts:146`) all carry it.

The **edge** is not. `assertPipelineTransition` (`packages/contracts/src/pipeline.ts:410`) only permits
strictly linear progression, so `isolated_review → implement` — which §8.2 requires on a failed review
and S4's charter names explicitly — throws.

**Addition:** `PIPELINE_REWORK_MAX_ATTEMPTS` (`packages/contracts/src/pipeline.ts:421`) and
`assertPipelineReworkTransition` (`:427`), a separate helper that permits exactly
`isolated_review → implement` while the attempt bound holds. `assertPipelineTransition` is untouched
and still the only path to forward progress. The bound is an argument defaulting to 3 so Milestone B's
one-to-five workspace policy (§8.3) fits without a contract change.

### 27. Rework from a failed verification — GAP (revision 4, the batch's one widening)

`assertPipelineReworkTransition` accepted only `isolated_review`, so S4 had nowhere to route a failed
verification: `assertPipelineTransition` only advances, and the single backward edge was reserved for
review. The pipeline could represent "the reviewer rejected this" but not "its own tests reject this".

**Change (orchestrator-approved, not append-only):** `PIPELINE_REWORK_SOURCE_STAGES`
(`packages/contracts/src/pipeline.ts:424`) now admits `verify` alongside `isolated_review`
(`:435`, `:440`). Both are judgements of the implementation, both send it back to the same station,
and both sit under the same attempt bound. Routing a failed verification forward into review instead
would ask a reviewer to approve code its own tests reject.

It only widens: every call that succeeded before still succeeds. The one existing test asserting
`verify` threw is replaced by tests asserting both directions.

### 28. Pipeline, clarification, steering, and agent relay events — GAP (revision 4)

Revision 1 deferred new `EVENT_TYPES` members with the condition that a stream needing them "should
request the addition through the orchestrator with the coherence rules in `validateRunStreamCoherence`
updated in the same change". S4 did, with a tabulation; this is that change.

`EVENT_TYPES` (`packages/contracts/src/events.ts:87`) gains `pipeline.evidence_recorded`,
`clarification.requested` (`:214`), `clarification.answered` (`:220`), `run.steered` (`:226`), and
`agent.session_event` (`:240`), each with a coherence case (`:979`, `:1037`, `:1065`, `:1069`).

- **`pipeline.evidence_recorded`** (`:201`) carries the evidence and optionally the document it
  addresses, tagged by `PipelineStationDocumentSchema`
  (`packages/contracts/src/station-evidence.ts:274`). The four document shapes share no discriminator
  of their own — a plan and a review are simply different objects — so the tag is what tells a reader
  which admission rule applies. Coherence orders stages per run: forward through
  `assertPipelineTransition`, or back to `implement` through `assertPipelineReworkTransition` when the
  previous stage judged the implementation (item 27).

  **Each envelope binds what it names**, and every station now names something: the plan evidence
  names a `planDigest` and the document is admitted against it; verification evidence names a pass
  the report must support; review evidence names a verdict and a reviewed diff that must agree; and
  triage evidence names a `triageReportDigest` (`packages/contracts/src/pipeline.ts:57`), admitted
  through `admitTriageReport` (`packages/contracts/src/events.ts:1020`).

  Triage was identity-only in the first pass of this batch, and the note here claimed closing it
  would not be append-only. That was wrong: an **optional** digest field is append-only, evidence
  recorded before a report exists stays valid, and the binding only engages once the envelope names
  a digest. It landed as a follow-up in this
  same batch, so S4's staleness chain reaches every station.

- **`clarification.requested` / `clarification.answered`** enforce one question per reference per run,
  at most one answer, and refuse an answer to a question nobody asked.

- **`run.steered`** refuses a terminal run, reusing the existing `assertRunCanExecute` guard.

- **`agent.session_event`** relays the normalized stream in one strictly increasing sequence per
  session, with the envelope's `sequence` and `agentSessionId` bound to the relayed event's own so
  there is one source of truth. Its payload uses `AgentSessionStreamEventSchema` directly: those
  strings are already `SafeMetadataString`, so a relay that failed to redact cannot get its output
  past the schema — **the projection is the redaction contract**, not a convention.

Additive to `DomainEventType`. The only existing test touched is the completeness guard that requires
a payload fixture per declared type — the guard doing its job; its assertions are unchanged and the
five fixtures are appended so the positional indices other tests rely on stay put.

### 13. Clarification question/answer — GAP

`RUN_STATUSES` includes `needs_clarification` and `waiting_for_user`
(`packages/contracts/src/entities.ts:25`, `:35`) but nothing carried the question or the answer, so
§8.2's "ask a focused question through the originating channel", §4.3's clarifying questions, and S6's
composer "answer an elicitation" had no shape.

**Addition:** `ClarificationRequestSchema` (`packages/contracts/src/station-evidence.ts:252`) and
`ClarificationResponseSchema` (`:263`). The response carries an idempotency key and reuses the
existing origin vocabulary (`desktop | web | cli | slack | github | api`) so a Slack answer and a
desktop answer are the same contract.

### 14. Publish scope binds branch, repository, and diff — SUFFICIENT

`PublishScopeSchema` (`packages/contracts/src/pipeline.ts:157`) binds `repositoryFullName`, `base`,
`head`, and `finalDiffDigest`, and `canonicalizePublishScopeForDigest` (`:354`) puts exactly those in
the digest, so §14.2's staleness rule already holds. `admitPublicationEvidenceBundle` (`:375`)
re-derives the digest and rejects a mismatch, and `admitDraftPullRequestRequest`
(`packages/contracts/src/integration.ts:150`) rejects a PR outside the approved scope. No addition.

## Integration contract — spec §13, stream S5

### 15. Provider delivery identifiers for dedup — SUFFICIENT

Both ingress variants carry `deliveryId` and `deduplicationKey`
(`packages/contracts/src/integration.ts:28`, `:50`), and `IntegrationIngressPort.accept`
(`:261`) returns `{ replayed }`, which is what §15's duplicate-delivery rule and S4's intake
deduplication need. Socket Mode ack semantics are a transport concern above this contract: the
envelope is acked, then the durable queue processes the deduplicated delivery (§13.2). No addition.

The ingress _event_ enums did not originally cover every §4.4/§4.3 trigger; the orchestrator approved
widening them in revision 2 — see **Resolved escalations** below.

### 16. Editable GitHub progress comments — GAP

Contracts had `SlackProgressRequestSchema` (`packages/contracts/src/integration.ts:158`) but no GitHub
progress shape at all, and `DeliveryIntegrationPort` exposed only draft-PR creation and Slack
progress. §4.4 requires "concise, editable progress comments rather than a new comment for every
event", which needs comment identity in the contract.

**Addition:** `GitHubProgressCommentRequestSchema` (`packages/contracts/src/integration.ts:173`) —
omit `commentId` to create, supply it to edit that comment in place — plus
`GitHubProgressCommentResultSchema` (`:186`) and the `GitHubProgressIntegrationPort` interface
(`:271`). S5 implements `DeliveryIntegrationPort & GitHubProgressIntegrationPort`;
`DeliveryIntegrationPort` itself is unchanged.

### 17. Draft-PR content — GAP

`DraftPullRequestRequestSchema` (`packages/contracts/src/integration.ts:104`) carries every §4.4
_digest_ through `publicationEvidence`, and its refinement already pins repository, base, head, and
diff to the approved scope. What it does not carry is the human-readable structure: `body` is one
opaque 100 KB string, so S5's charter obligation to produce "the §4.4 body structure" and acceptance
criterion 13 had nothing to validate against.

**Addition:** `DraftPullRequestBodySchema` (`packages/contracts/src/integration.ts:200`) with
`problemStatement`, `approvedPlanDigest` + `approvedPlanSummary`, `changeSummary`,
`verificationSummary`, `reviewVerdict`, `knownLimitations`, and `runUrl`. `reviewVerdict` is
`z.literal("approved")` because publication is impossible otherwise (§8.2, §14.2). S5 renders the
request's `body` string from this structure; the request schema is unchanged.

`DraftPullRequestResultSchema` (`:137`) already carries number, URL, draft flag, provider evidence
digest, and timestamp — sufficient.

### 18. Slack approval interactivity — GAP

`SlackProgressRequestSchema` is text-only; nothing represented approve/reject actions, so §4.3's "plan
approval and rejection actions" and S5's "approval interactivity payloads" had no contract.

**Addition:** `SlackApprovalPromptSchema` (`packages/contracts/src/integration.ts:217`) carries the
`ApprovalId`, `RunId`, approval kind, and evidence digest into the posted message;
`SlackApprovalActionSchema` (`:232`) carries the inbound decision back with the workspace/channel/user
binding §13.2 requires validating, the same evidence digest for staleness, and
`deliveryId`/`deduplicationKey` so an interactive payload is deduplicated like any other delivery.

### 26. Desktop approval, steering, and cancellation — GAP (revision 4)

Item 20 added the four HTTP schemas S6's approval inbox and composer need, but the desktop bridge
knew only `factory.health`, `factory.runs.list`, `factory.runs.events`, and `factory.runs.create`, so
over IPC the inbox had nowhere to call.

**Addition:** `DesktopFactoryApprovalListRequestSchema`
(`packages/contracts/src/desktop-api.ts:180`), `DesktopFactoryApprovalDecideRequestSchema` (`:183`),
`DesktopFactoryRunSteerRequestSchema` (`:188`), and `DesktopFactoryRunCancelRequestSchema` (`:192`),
registered in the request map, the discriminated union, and the response map.

Each is derived from the HTTP schema it mirrors with `.extend` rather than re-declared, so the two
surfaces cannot drift and the inbox's paging bounds are the same bounds on both — the same discipline
item 20 applied by reusing `ApprovalSchema.shape`. Two deliberate differences from HTTP: there is no
idempotency key, because a renderer that could choose one could replay another window's decision by
guessing it, so the main process derives it; and `origin` is narrowed to the literal `"desktop"`,
because the renderer is the desktop and a contract that let it claim to be Slack would be recording a
lie. Contracts only — Wave 2 wires the handlers and the preload surface.

### 29. Work item on an agent invocation — GAP (revision 4)

S1's native roles produce triage, plan, and review documents, and all three carry `workItemId` in
their identity shape. `AgentInvocationRequestSchema` had `workspaceId`, `runId`, and `stageRunId` but
no work item, so the only remaining source at document assembly would have been the model — and §14.1
forbids untrusted output supplying identity for a document it authors.

**Addition:** an append-only optional `workItemId` (`packages/contracts/src/agent.ts:70`). Optional
because an adapter may be invoked outside a work item; S1's roles treat it as required at admission
and fail closed when absent, which is the adapter's rule to enforce rather than the contract's to
assume.

## Cross-cutting

### 30. Shared failure-code normalization rule — GAP (revision 4)

Two places have to agree on when an agent-side failure code is usable as a `WorkflowFailure` code:
S4's `classifyStageFailure` in `packages/workflow`, and the agent-harness conformance suite in
`packages/domain`. The suite carried its own coercing normalization as a placeholder. It could not
simply import the classifier — `packages/workflow` depends on `packages/domain`, so the import would
close a cycle — which means the rule itself belongs here, below both.

**Addition:** `normalizeWorkflowFailureCode`
(`packages/contracts/src/workflow-failure.ts:39`) with `WorkflowFailureCode` (`:21`).

The rule is **unchanged-acceptance**, and the distinction is not academic.
`WorkflowFailureCodeSchema` (`:7`) carries `.trim()`, so `" rate_limited"` parses _successfully_ — to
a different string. A helper that returned `parsed.data` whenever parsing succeeded would ship
trim-then-accept, conjuring a code the event stream never carried and that the pipeline never
branches on. The helper therefore compares the parse result against the untrimmed input with strict
equality, and `" rate_limited"`, `"RATE_LIMITED"`, `"provider.rate_limited"`, `"-32601"`, and `""`
all return `undefined`.

Returning `undefined` rather than throwing or substituting is deliberate: what to do with a code that
cannot be lifted is the consumer's decision — the classifier may map it, the conformance suite fails
the adapter that emitted it — and this helper is only the shared rule they agree on.

`packages/domain/src/testing/agent-harness-conformance-evidence.ts` now consumes it in place of its
suite-local normalization. The assertion is unchanged in outcome (both the old coercion and the new
refusal make a non-conforming code fail the comparison against itself), so no fixture code relied on
coercion and both conformance runners stay green.

### 19. `WorkItem` intake — SUFFICIENT

`WorkItemSchema` (`packages/contracts/src/entities.ts:144`) carries title, description, requester,
project, attachments, priority, labels, and acceptance context — every field §7 names.
`SourceRefSchema` (`:117`) discriminates `manual` (with a `desktop | web | cli | api` client),
`github` (repository + issue number + `deliveryId`), `slack` (workspace + channel + `threadTs` +
`deliveryId`), and `api`, so S4's "source deduplication by delivery identifier" works for every
non-manual origin. No addition.

### 20. HTTP schemas for approvals, steering, and cancellation — GAP

`packages/contracts/src/api.ts` had health, create-run, list-runs, and list-events only. S4's charter
names four routes it must serve and S6 must build its approval inbox and composer against those
schemas before S4 merges.

**Addition (all in `packages/contracts/src/api.ts`):** `ApprovalSummarySchema` (`:117`),
`ListApprovalsQuerySchema` (`:132`, defaulting to `status: "pending"` with a coerced numeric `limit`
since query values arrive as strings), `ListApprovalsResponseSchema` (`:140`),
`ApprovalDecisionRequestSchema` (`:147`, which requires the `evidenceDigest` being approved so a stale
decision is detectable) and `ApprovalDecisionResponseSchema` (`:156`, with `replayed` for idempotent
re-decision), `SteerRunRequestSchema`/`SteerRunResponseSchema` (`:168`, `:172`), and
`CancelRunRequestSchema`/`CancelRunResponseSchema` (`:176`, `:180`).

`ListApprovalsQuerySchema` also carries an optional `cursor` (coerced positive integer) so a client
can feed `ListApprovalsResponseSchema.nextCursor` back in and page past the first window — the
response advertised a cursor the query could not consume until revision 2.

`ApprovalSummarySchema.kind`/`.status` and `ListApprovalsQuerySchema.status` reuse
`ApprovalSchema.shape.kind` / `.shape.status` from `entities.ts` rather than re-declaring the
vocabulary, so the HTTP surface cannot drift from the domain entity.
`ApprovalDecisionResponseSchema.status` keeps its own narrower enum on purpose — a decided approval
can never be `pending`.

`ApiErrorSchema`'s code enum (`:91`) gains nothing: `run_not_found`, `invalid_request`,
`version_conflict`, and `idempotency_conflict` already cover approval failures, and adding members to
an existing enum is outside the append-only mandate.

## Resolved escalations

Both items were escalated in revision 1 because widening an existing `z.enum` falls outside the
append-only mandate. The orchestrator approved both, and revision 2 applies them on this branch,
before the Wave 1 worktrees are cut. Each widens inbound parsing only — no consumer exists yet that
switches on these values, so no downstream code can break.

**E1 — GitHub ingress event coverage — RESOLVED.** `GitHubIngressDeliverySchema.event`
(`packages/contracts/src/integration.ts:32`) now admits `issues.labeled` alongside `issues.opened`,
`issues.edited`, and `issue_comment.created`. Spec §4.4 and acceptance criterion 4 require intake
from "an issue labeled `autostack`", and labelling an _existing_ issue emits `issues.labeled`.

**E2 — Slack ingress event coverage — RESOLVED.** `SlackIngressDeliverySchema.event`
(`packages/contracts/src/integration.ts:54`) now admits `message_action` alongside `app_mention` and
`message`. Spec §4.3 and acceptance criterion 3 require invocation from "a DM, mention, or **message
action**"; the delivery's existing `channelId`/`threadTs`/`messageTs`/`userId` fields already carry
everything the shortcut needs.

Unmodelled provider events are still rejected — S5 must escalate rather than widen these enums
silently.

## Explicit deferrals

| Deferred                                                                                                               | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model data-handling policy (zero-data-retention, approved provider lists)                                              | Spec §10.2 scopes these to team policy; no Milestone A stream reads them.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Rename tracking in `file_change` events                                                                                | Representable as delete + add; no stream charter needs rename provenance.                                                                                                                                                                                                                                                                                                                                                                                                  |
| A shared capability-filtering helper over `ModelCatalogEntry`                                                          | Filtering logic is S3-internal; only the capability _declaration_ crosses a boundary.                                                                                                                                                                                                                                                                                                                                                                                      |
| New domain event types in `EVENT_TYPES` (`packages/contracts/src/events.ts:50`)                                        | Appending members to the existing array widens `DomainEventType` and the `PendingDomainEvent` union. Streams that need to persist agent-detail or route events should request the addition through the orchestrator with the coherence rules in `validateRunStreamCoherence` updated in the same change.                                                                                                                                                                   |
| Editing an already-posted Slack progress message                                                                       | §4.3 and §13.2 require thread-bound progress, not in-place edits; only GitHub mandates a single editable comment.                                                                                                                                                                                                                                                                                                                                                          |
| ~~Binding `ModelRouteFallbackSchema.failureCode` to `ModelRoutingFailureCodeSchema`~~ — **landed, no longer deferred** | The deferral premise was wrong: it treated the narrowing as breaking for "any recorded fallback carrying a non-taxonomy ref", but the taxonomy and the fallback schema both landed in this same branch, so there are no recorded fallbacks and no consumers to break. The only non-taxonomy values in the repo were two test fixtures using `provider_rate_limited`, which is the drift the narrowing exists to prevent. The field is now `ModelRoutingFailureCodeSchema`. |
| Factory memory (§16.3) and Eve adapter (§9.4)                                                                          | Deferred by the master plan's locked decision 7.                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Verification

- `pnpm --filter @autostack/contracts test` — 327 passed (17 files) after revision 4; 287 at
  revision 3; 282 at revision 2.
- `pnpm --filter @autostack/domain test` — 114 passed (12 files) after revision 4, including the four
  shared fakes.
- `pnpm --filter @autostack/contracts test:coverage` — statements 90.6%, branches 82.5%,
  functions 93.8%, lines 92.2%; `station-evidence.ts` at 100%.
- `pnpm check` — 12/12 tasks successful.
- `pnpm format:check` — clean across `packages/contracts` and `docs/development`. See the notes below
  for pre-existing failures elsewhere in the repository.

**Test-timeout note.** Revision 1 raised `testTimeout` package-wide in
`packages/contracts/vitest.config.ts`; revision 2 reverts that and scopes the allowance to the single
case that needs it — `events.test.ts > accepts one ordered local execution evidence stream` now
carries `{ timeout: 15_000 }`. That case is crypto-digest bound: it hashes the whole local-execution
evidence stream and took 2.7s at the base commit against the 5s default, which leaves no margin once
the suite's files run in parallel. No assertion was weakened; only that one case's wall-clock budget
changed.

## Pre-existing gate failures (not introduced by this task)

All three were verified by stashing this task's changes and re-running against the base commit. Since
the plan's global constraints make these merge gates for every stream, they block all of Wave 1 until
they have an owner.

1. **`pnpm format:check` fails on eight untouched files** — `apps/desktop/e2e/fixtures/quick-exit-probe.ts`,
   `apps/desktop/e2e/fixtures/seed-execution.ts`, `apps/desktop/src/guardian/bootstrap-router.ts`,
   `apps/desktop/src/renderer/main.tsx`, `scripts/verify-local-execution.mjs`,
   `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md`, and two files under
   `.superpowers/`. Recommended: a separate `chore: apply prettier` commit on the base branch, plus
   adding `.superpowers/` to `.prettierignore` — it is excluded from Git via `.git/info/exclude` but
   not from Prettier, which is why the orchestrator's own working files trip the gate.
2. **`pnpm test:coverage` fails on `@autostack/cli`** — statements 50.59%, branches 49.07%,
   functions 60%, lines 53.77% against the 80% floor, identical before and after this task.
3. **`@autostack/runner-local` has a load-dependent flake.** A full `pnpm test` intermittently fails
   two cases in that package with 5s timeouts. It is not a regression from Task 0.1, and the
   evidence is that a **different pair of tests fails on each run**: `worktree-manager.test.ts` with
   this task's changes applied, `command-guardian.test.ts` with them stashed and the base commit's
   contracts checked out. `worktree-manager.test.ts` passes 60/60 in isolation but spends ~84s in
   real Git subprocesses, and the package reports ~670s of test time inside ~137s of wall clock, so
   its own internal parallelism is enough to starve individual cases. This is the same class of
   latent flake as the contracts case noted above, and the same fix applies: a per-test timeout on
   the Git- and IPC-bound cases. Those files are in Stream S2's and I2's lane, so Task 0.1 did not
   touch them.
