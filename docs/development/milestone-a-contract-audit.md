# Milestone A contract gap audit

**Task:** Wave 0 / Task 0.1 of `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md`
**Date:** 2026-08-26
**Scope:** `@autostack/contracts` audited against `docs/superpowers/specs/2026-08-20-autostack-design.md`
§8.2, §9.1–9.3, §10, §13, §15, and the six Wave 1 stream charters.
**Rule applied:** append-only. No existing export was renamed, removed, or changed in shape or
semantics; every pre-existing test passes unmodified.

Wave 1 stream leads: read the **Additions** section for the new shapes you are expected to build
against, and the **Escalated** section for the two changes that Task 0.1 could not make.

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
| 15  | Ingress delivery identifiers (§15)                      | SUFFICIENT (see Escalated E1)                          |
| 16  | Editable GitHub progress comments (§4.4)                | GAP — fixed                                            |
| 17  | Draft-PR body content (§4.4)                            | GAP — fixed                                            |
| 18  | Slack approval interactivity (§4.3)                     | GAP — fixed                                            |
| 19  | `WorkItem` intake with source references (§7)           | SUFFICIENT                                             |
| 20  | Approval/steer/cancel HTTP schemas                      | GAP — fixed                                            |

## Agent contract — spec §9.1–9.3, streams S1 and S2

### 1. Declared support for steering, resume, permission modes, structured plans, model/reasoning selection — GAP

`AgentHarnessCapabilitiesSchema` (`packages/contracts/src/agent.ts:30`) declares `resume`,
`steering`, `permissions`, and `structuredPlans` only. Model and reasoning selection are absent even
though `AgentSessionSchema.capabilities` (`packages/contracts/src/entities.ts:222`) already carries
`modelSelection` — the descriptor could not honestly populate the session entity it feeds. Permission
_modes_ (spec §9.1, and named explicitly in the Wave 0 charter) had no representation at all.

**Addition:** `AgentHarnessProfileSchema` (`packages/contracts/src/agent.ts:167`) composes the
existing descriptor with a `selection` block (`modelSelection`, `reasoningSelection`,
`permissionModes`) and an `availability` block. Honesty is enforced by refinement: a harness whose
descriptor sets `capabilities.permissions: false` cannot declare permission modes, and modes must be
unique. The existing `AgentHarnessDescriptorSchema` is unchanged and still valid on its own.

### 2. Session event coverage and sequence numbers — GAP

Sequencing is fine: every agent event carries a positive `sequence`
(`packages/contracts/src/agent.ts:107`), and clients already resume domain streams from
`ListEventsResponseSchema.nextSequence` (`packages/contracts/src/api.ts:73`).

Coverage is not. `AgentSessionEventSchema` (`packages/contracts/src/agent.ts:111`) covers `started`,
`output`, `permission_requested`, `waiting`, `completed`, `failed`, and `cancelled`. Spec §9.1
requires normalized message, thought-summary, plan, tool-call, file-change, and usage events; S6's
charter needs them as separate panes (conversation, plan, diff, usage) and S1's charter must produce
them. Folding all six into `output.stream: "structured"` would push provider-specific parsing into
every consumer, which is the opposite of normalization.

**Addition:** `AgentSessionDetailEventSchema` (`packages/contracts/src/agent.ts:345`) adds `message`,
`thought_summary`, `plan`, `tool_call`, `file_change`, `permission_resolved`, `usage`, and
`interrupted`, all sharing the existing `sessionId`/`sequence`/`occurredAt` context so they interleave
in one sequence space. `AgentSessionStreamEventSchema` (`packages/contracts/src/agent.ts:351`) is the
combined union adapters emit and clients consume. `file_change.path` reuses
`RelativeWorkspacePathSchema`, so an agent cannot report a change outside the managed worktree.

### 3. Permission request/response round trip — GAP

`permission_requested` (`packages/contracts/src/agent.ts:130`) carries a `permissionRef`, a summary,
and an evidence digest — but no options and no response shape, so neither the S1 conformance suite
nor the pipeline's approval machinery could complete the round trip.

**Addition:** `AgentPermissionOptionSchema`, `AgentPermissionRequestSchema`
(`packages/contracts/src/agent.ts:229`), `AgentPermissionResponseSchema`
(`packages/contracts/src/agent.ts:260`), and `admitAgentPermissionResponse`
(`packages/contracts/src/agent.ts:364`). The response carries an `ApprovalId`, which is how the
pipeline's `Approval` record (`kind: "permission"`, `packages/contracts/src/entities.ts:274`) binds to
it. The admission helper rejects a response from a different session, a response to a different
`permissionRef`, a response against a stale evidence digest, or a selection the request never offered.
A request must offer at least one denial option. `AgentPermissionResponderPort`
(`packages/contracts/src/agent.ts:412`) is a separate interface so adapters that do not declare
`capabilities.permissions` simply do not implement it — `AgentHarnessPort` is untouched.

### 4. Installed vs authenticated status — GAP

Nothing in contracts represented probe results, yet S1's charter requires "installed/authenticated
status probing", S2's requires an `isInstalled()`/`isAuthenticated()` probe per adapter, and
acceptance criterion 6 surfaces it in the UI.

**Addition:** the `availability` block of `AgentHarnessProfileSchema`
(`packages/contracts/src/agent.ts:178`) — `installed`, `authenticated`, an optional non-secret
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

**Addition:** `ModelRouteFallbackSchema` (`packages/contracts/src/model.ts:216`) with `from`/`to`
route+model targets, `failureCode`, `reason`, and attribution. A refinement rejects a "fallback" that
changes neither route nor model, so the event cannot be recorded as a no-op.

### 10. Model policy — GAP (decision: it belongs in contracts)

**Decision:** contracts, not S3-internal. Spec §4.1 lists policy in the workbench right inspector, so
S6 must read it without importing S3; S4 selects routes per station and must evaluate the same
ceilings. Two consumers outside S3 means it crosses a contract boundary.

**Addition:** `ModelPolicySchema` (`packages/contracts/src/model.ts:244`) — `stage`,
`allowedRouteRefs`, ordered `fallbackRouteRefs`, optional `maxInputTokens`/`maxOutputTokens`/
`maxCostMicros`, and an optional `reasoningLevel`. A refinement rejects a fallback route that is not
also an allowed route, so a policy cannot escape its own constraint. Data-handling requirements
(zero-data-retention, approved provider lists) are **deferred**: §10.2 scopes them to team policy and
no Milestone A stream reads them.

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
(`:157`), and `ReviewReportSchema` (`:207`). Enforced invariants worth knowing:

- A plan must name at least one **required** verification command (`station-evidence.ts:124`).
- `VerificationCommandSchema` (`:72`) is executable + args with an explicit `usesShell` flag, so spec
  §14.4's "that fact is visible in the plan approval" is structural rather than conventional.
- A verification report cannot claim `passed` while any required check failed **or was skipped**
  (`:173`) — §8.2's "skipped required checks are failure, not success".
- An executed check must record an exit code; a skipped one must not (`:151`).
- A review report cannot be `approved` while a critical or high finding stands (`:237`), mirroring the
  existing `ReviewEvidenceSchema` rule.

The existing evidence schemas are unchanged; these documents are what their digests cover.

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

### 13. Clarification question/answer — GAP

`RUN_STATUSES` includes `needs_clarification` and `waiting_for_user`
(`packages/contracts/src/entities.ts:25`, `:35`) but nothing carried the question or the answer, so
§8.2's "ask a focused question through the originating channel", §4.3's clarifying questions, and S6's
composer "answer an elicitation" had no shape.

**Addition:** `ClarificationRequestSchema` (`packages/contracts/src/station-evidence.ts:243`) and
`ClarificationResponseSchema` (`:254`). The response carries an idempotency key and reuses the
existing origin vocabulary (`desktop | web | cli | slack | github | api`) so a Slack answer and a
desktop answer are the same contract.

### 14. Publish scope binds branch, repository, and diff — SUFFICIENT

`PublishScopeSchema` (`packages/contracts/src/pipeline.ts:157`) binds `repositoryFullName`, `base`,
`head`, and `finalDiffDigest`, and `canonicalizePublishScopeForDigest` (`:354`) puts exactly those in
the digest, so §14.2's staleness rule already holds. `admitPublicationEvidenceBundle` (`:375`)
re-derives the digest and rejects a mismatch, and `admitDraftPullRequestRequest`
(`packages/contracts/src/integration.ts:149`) rejects a PR outside the approved scope. No addition.

## Integration contract — spec §13, stream S5

### 15. Provider delivery identifiers for dedup — SUFFICIENT

Both ingress variants carry `deliveryId` and `deduplicationKey`
(`packages/contracts/src/integration.ts:28`, `:50`), and `IntegrationIngressPort.accept`
(`:260`) returns `{ replayed }`, which is what §15's duplicate-delivery rule and S4's intake
deduplication need. Socket Mode ack semantics are a transport concern above this contract: the
envelope is acked, then the durable queue processes the deduplicated delivery (§13.2). No addition.

**But see Escalated E1** — the ingress _event_ enums do not cover every §4.4/§4.3 trigger.

### 16. Editable GitHub progress comments — GAP

Contracts had `SlackProgressRequestSchema` (`packages/contracts/src/integration.ts:157`) but no GitHub
progress shape at all, and `DeliveryIntegrationPort` exposed only draft-PR creation and Slack
progress. §4.4 requires "concise, editable progress comments rather than a new comment for every
event", which needs comment identity in the contract.

**Addition:** `GitHubProgressCommentRequestSchema` (`packages/contracts/src/integration.ts:172`) —
omit `commentId` to create, supply it to edit that comment in place — plus
`GitHubProgressCommentResultSchema` (`:185`) and the `GitHubProgressIntegrationPort` interface
(`:270`). S5 implements `DeliveryIntegrationPort & GitHubProgressIntegrationPort`;
`DeliveryIntegrationPort` itself is unchanged.

### 17. Draft-PR content — GAP

`DraftPullRequestRequestSchema` (`packages/contracts/src/integration.ts:103`) carries every §4.4
_digest_ through `publicationEvidence`, and its refinement already pins repository, base, head, and
diff to the approved scope. What it does not carry is the human-readable structure: `body` is one
opaque 100 KB string, so S5's charter obligation to produce "the §4.4 body structure" and acceptance
criterion 13 had nothing to validate against.

**Addition:** `DraftPullRequestBodySchema` (`packages/contracts/src/integration.ts:199`) with
`problemStatement`, `approvedPlanDigest` + `approvedPlanSummary`, `changeSummary`,
`verificationSummary`, `reviewVerdict`, `knownLimitations`, and `runUrl`. `reviewVerdict` is
`z.literal("approved")` because publication is impossible otherwise (§8.2, §14.2). S5 renders the
request's `body` string from this structure; the request schema is unchanged.

`DraftPullRequestResultSchema` (`:136`) already carries number, URL, draft flag, provider evidence
digest, and timestamp — sufficient.

### 18. Slack approval interactivity — GAP

`SlackProgressRequestSchema` is text-only; nothing represented approve/reject actions, so §4.3's "plan
approval and rejection actions" and S5's "approval interactivity payloads" had no contract.

**Addition:** `SlackApprovalPromptSchema` (`packages/contracts/src/integration.ts:216`) carries the
`ApprovalId`, `RunId`, approval kind, and evidence digest into the posted message;
`SlackApprovalActionSchema` (`:231`) carries the inbound decision back with the workspace/channel/user
binding §13.2 requires validating, the same evidence digest for staleness, and
`deliveryId`/`deduplicationKey` so an interactive payload is deduplicated like any other delivery.

## Cross-cutting

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

**Addition (all in `packages/contracts/src/api.ts`):** `ApprovalSummarySchema` (`:110`),
`ListApprovalsQuerySchema` (`:125`, defaulting to `status: "pending"` with a coerced numeric `limit`
since query values arrive as strings), `ListApprovalsResponseSchema` (`:132`),
`ApprovalDecisionRequestSchema` (`:139`, which requires the `evidenceDigest` being approved so a stale
decision is detectable) and `ApprovalDecisionResponseSchema` (`:148`, with `replayed` for idempotent
re-decision), `SteerRunRequestSchema`/`SteerRunResponseSchema` (`:158`, `:162`), and
`CancelRunRequestSchema`/`CancelRunResponseSchema` (`:166`, `:170`).

`ApiErrorSchema`'s code enum (`:80`) gains nothing: `run_not_found`, `invalid_request`,
`version_conflict`, and `idempotency_conflict` already cover approval failures, and adding members to
an existing enum is outside the append-only mandate.

## Escalated — orchestrator action required before S5 starts

These two changes cannot be made append-only. Both require adding members to an existing `z.enum`
inside an existing schema, which Task 0.1's mandate forbids. Recommend the orchestrator applies them
on the base branch before cutting the S5 worktree.

**E1 — GitHub ingress event coverage.** `GitHubIngressDeliverySchema.event`
(`packages/contracts/src/integration.ts:31`) admits only `issues.opened`, `issues.edited`, and
`issue_comment.created`. Spec §4.4 and acceptance criterion 4 require intake from "an issue labeled
`autostack`" — labelling an _existing_ issue emits `issues.labeled`, which cannot be represented.
Recommended: add `issues.labeled`.

**E2 — Slack ingress event coverage.** `SlackIngressDeliverySchema.event`
(`packages/contracts/src/integration.ts:53`) admits only `app_mention` and `message`. Spec §4.3 and
acceptance criterion 3 require invocation from "a DM, mention, or **message action**" — the shortcut
arrives as an interactive payload with no matching event value. Recommended: add `message_action`
(the delivery's existing `channelId`/`threadTs`/`messageTs`/`userId` fields already carry everything
the shortcut needs).

## Explicit deferrals

| Deferred                                                                        | Rationale                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model data-handling policy (zero-data-retention, approved provider lists)       | Spec §10.2 scopes these to team policy; no Milestone A stream reads them.                                                                                                                                                                                                                                |
| Rename tracking in `file_change` events                                         | Representable as delete + add; no stream charter needs rename provenance.                                                                                                                                                                                                                                |
| A shared capability-filtering helper over `ModelCatalogEntry`                   | Filtering logic is S3-internal; only the capability _declaration_ crosses a boundary.                                                                                                                                                                                                                    |
| New domain event types in `EVENT_TYPES` (`packages/contracts/src/events.ts:50`) | Appending members to the existing array widens `DomainEventType` and the `PendingDomainEvent` union. Streams that need to persist agent-detail or route events should request the addition through the orchestrator with the coherence rules in `validateRunStreamCoherence` updated in the same change. |
| Editing an already-posted Slack progress message                                | §4.3 and §13.2 require thread-bound progress, not in-place edits; only GitHub mandates a single editable comment.                                                                                                                                                                                        |
| Factory memory (§16.3) and Eve adapter (§9.4)                                   | Deferred by the master plan's locked decision 7.                                                                                                                                                                                                                                                         |

## Verification

- `pnpm --filter @autostack/contracts test` — 265 passed (15 files).
- `pnpm --filter @autostack/contracts test:coverage` — statements 90.4%, branches 82.3%,
  functions 93.5%, lines 92.0%; `station-evidence.ts` at 100%.
- `pnpm check` — 12/12 tasks successful.
- `pnpm test` (whole monorepo) — 21/21 tasks successful, run twice.
- `pnpm format:check` — clean across `packages/contracts` and `docs/development`. See the notes below
  for pre-existing failures elsewhere in the repository.

**Test-timeout change.** `packages/contracts/vitest.config.ts` now sets `testTimeout: 20_000`. The
pre-existing `events.test.ts > accepts one ordered local execution evidence stream` case is
crypto-digest bound and took 2.7s at the base commit against the 5s default; the extra test file
added here pushes it to ~4.5s under parallel load, close enough to the default to flake. No assertion
was weakened — only the wall-clock budget was raised.

**Pre-existing gate failure (not introduced here):** at the Task 0.1 base commit `e8ec2e6`,
`pnpm format:check` already fails on eight files that Task 0.1 does not touch —
`apps/desktop/e2e/fixtures/quick-exit-probe.ts`, `apps/desktop/e2e/fixtures/seed-execution.ts`,
`apps/desktop/src/guardian/bootstrap-router.ts`, `apps/desktop/src/renderer/main.tsx`,
`scripts/verify-local-execution.mjs`, `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md`,
and two untracked files under `.superpowers/`. Since the plan's global constraints make
`pnpm format:check` a merge gate for every stream, this blocks all of Wave 1 until fixed.
Recommended: a separate `chore: apply prettier` commit on the base branch, plus adding
`.superpowers/` to `.prettierignore` (it is excluded from Git but not from Prettier).

**Second pre-existing gate failure (not introduced here):** `pnpm test:coverage` fails on
`@autostack/cli` at the base commit with identical numbers before and after this task — statements
50.59%, branches 49.07%, functions 60%, lines 53.77% against the 80% floor. This also blocks every
Wave 1 stream's merge gate and needs an owner before Wave 1 merges begin.
