# AutoStack Milestone A Parallel Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Orchestration note:** This is the master plan for completing Milestone A with parallel Opus subagent streams. Each stream's first task is to author its own dated, fully detailed TDD implementation plan under `docs/superpowers/plans/` (matching the granularity of `2026-08-20-autostack-foundation.md` and `2026-08-21-autostack-local-execution.md`), then execute it. This document locks scope, boundaries, interfaces, dependencies, and merge gates so the streams cannot drift or collide.

**Goal:** Deliver the remaining ~70% of Milestone A — agent teammates, model plane, delivery pipeline, GitHub and Slack integration, workbench/control room, packaging — so the packaged desktop app passes all 16 acceptance criteria in spec §18 against a real test repository.

**Architecture:** Six parallel workstreams build against contracts already frozen in `@autostack/contracts` (`AgentHarnessPort`, `ModelRouterPort`, `DeliveryPipelinePort`, `IntegrationIngressPort`, `DeliveryIntegrationPort`, pipeline evidence + approval digest schemas). A short serial Wave 0 audits and gap-fills those contracts plus shared test doubles; Wave 1 runs the six streams concurrently in isolated git worktrees; Wave 2 integrates, runs the eight end-to-end journeys, packages the app, and executes the acceptance run.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9 strict; pnpm 10.27; Turborepo 2; Zod 4; Hono 4; Electron; electron-vite; React 19; Vercel AI SDK (native agent); Vitest 4; Playwright; Git CLI.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` — subprojects 3–8 of §20; acceptance criteria §18.

## Locked decisions (confirmed with the user 2026-08-26)

1. **Scope:** Milestone A only. No Milestone B work (no PostgreSQL, hosted control plane, cloud runners, roles).
2. **GitHub:** Live validation uses the user's existing GitHub credentials (`gh` CLI auth) against the user's own `NeelM0906/Factory` test repository. The integration is built behind the provider-agnostic `DeliveryIntegrationPort` with a user-access-token client first (spec §13.1 permits user tokens for user-initiated actions). GitHub App auth is implemented behind the same contract with signed-fixture tests; registering the actual GitHub App is a documented end-of-project wiring task with click-by-click instructions (required to fully satisfy acceptance criterion 2).
3. **Slack:** Fixture-first (Socket Mode envelopes and interactive payloads as recorded fixtures). A final wiring task provides exact Slack-app creation instructions and validates live with the user's workspace.
4. **Model providers:** The user has Anthropic, OpenAI, Vercel AI Gateway, and OpenRouter credentials — all four routes get live smoke validation in Wave 2; Wave 1 tests use recorded fixtures.
5. **Merge model:** Each stream works on its own branch in its own git worktree. The orchestrator (Fable) reviews each merge against spec and gates; the user checks in at wave boundaries and approval-worthy decisions.
6. **Subagent model:** Streams are led by Opus subagents (Agent tool `model: "opus"`), one lead per stream, dispatching their own task-level subagents per superpowers:subagent-driven-development.
7. **Explicit deferral:** Factory memory (spec §16.3) appears in no §18 acceptance criterion and is deferred to a follow-up plan after the acceptance run; agent-proposed memories will land behind the existing approval machinery then. Eve adapter support (§9.4) is likewise deferred by the spec itself.

## Global constraints

Copied from spec §21 and the existing plans; every stream inherits all of them.

- TypeScript strict; no unchecked `any`, non-null assertions, disabled tests, placeholder/TODO implementations, or validation bypasses in contract/domain/security boundaries.
- Every process invocation is `executable` + `args`. Never shell command strings, `exec`, `spawn(..., { shell: true })`, or `/bin/sh -c`.
- 80% coverage floor (statements, branches, functions, lines) per package; `pnpm format:check`, `pnpm check`, `pnpm test:coverage`, `pnpm build` must pass before any merge.
- All cross-boundary data is Zod-validated. New public types live in `@autostack/contracts` with versioned schemas.
- No implementation package imports another implementation across a contract boundary (control plane imports ports, not adapters).
- Secrets: macOS Keychain / Electron `safeStorage` only; structured redaction before persistence or broadcast; fail closed when redaction cannot serialize.
- Product branches only under `autostack/`; never reset/clean/switch the user's checkout; worktree lifecycle stays explicit.
- Repository contents, issues, PR comments, Slack messages, and agent output are untrusted input (spec §14.1); they never grant permissions or change policy.
- TDD: write the failing test first, observe the stated failure, implement minimally, commit per task with conventional-commit messages (`feat(scope): ...`).
- Injected clocks, ID factories, launchers, and temp dirs in tests; integration tests create disposable Git repositories, never the AutoStack source checkout.
- UTF-8, LF, Prettier-formatted; follow existing small-file-per-concern conventions (see `packages/runner-local/src/`).

## Orchestration model

```text
Wave 0 (serial, 1 stream, small)
  contract audit + gap-fill + shared test doubles
        |
Wave 1 (parallel, 6 streams, worktrees)
  S1 agent-runtime + native agent + conformance suite
  S2 CLI harness adapters (claude, codex, acp)
  S3 model-router + credential store
  S4 delivery pipeline stages + approvals + retries
  S5 integration-github + integration-slack
  S6 workbench UI + dashboard + observability
        |
Wave 2 (serial-ish, 2 streams then 1)
  I1 composition + e2e journeys     I2 packaging + security tests
        |
  Acceptance run (all 16 criteria) + live wiring with user credentials
```

**Worktrees:** `git worktree add ../factory-s1 -b codex/milestone-a-s1-agent-runtime` (same pattern per stream, S1–S6, I1–I2), all branched from the tip of `codex/autostack-foundation`.

**Cross-stream rule:** A stream may modify only the packages it owns (listed per stream below) plus append-only additions to `@autostack/contracts` that Wave 0 pre-approved. Any other contract change goes through the orchestrator, who applies it on the base branch and rebases affected streams. This is the collision-prevention mechanism.

**Stream lead brief (dispatch template):** every Opus stream lead receives: this plan; the spec; its stream charter section; the repo conventions summary; and the instruction to (1) author its detailed dated plan, (2) get orchestrator review of that plan, (3) execute task-by-task with TDD and per-task commits, (4) run the full gate suite before requesting merge review.

---

## Wave 0: Contract audit and shared test kit (serial, blocks Wave 1)

**Owner:** one Opus subagent. **Duration target:** small — the ports already exist; this is gap-filling, not authoring.

**Files:**

- Modify (append-only): `packages/contracts/src/agent.ts`, `model.ts`, `pipeline.ts`, `integration.ts`, `index.ts`
- Create: `packages/domain/src/testing/fake-agent-harness.ts`, `packages/domain/src/testing/fake-model-router.ts`, `packages/domain/src/testing/fake-delivery-integration.ts`
- Create: `packages/domain/src/testing/agent-harness-conformance.ts` (exported suite factory, same pattern as the existing runner conformance suite in `packages/domain/test/runner-provider-conformance.test.ts`) — landed in `packages/domain`, not `packages/contracts`, because the suite calls `describe`/`it`/`expect` and contracts must not import vitest; it is re-exported from `@autostack/domain/testing`

**Tasks:**

- [ ] **Task 0.1 — Contract gap audit.** Diff `AgentHarnessPort`, `ModelRouterPort`, `DeliveryPipelinePort`, `IntegrationIngressPort`, `DeliveryIntegrationPort` against spec §9.1, §10, §8.2, §13. Confirm every capability the streams need is expressible (session resume/steer declarations, permission modes, model catalog discovery, usage normalization, editable-progress-comment identity, Socket Mode ack semantics). Produce a written gap list; add missing schemas append-only with tests. No breaking changes to existing schema shapes.
- [ ] **Task 0.2 — Shared fakes.** Deterministic in-memory fakes for each port (scripted event sequences, injectable failures) exported from `@autostack/domain/testing`, so S4 and S6 can build the pipeline and UI without waiting for S1–S3, and so the conformance suite has a reference implementation.
- [ ] **Task 0.3 — Agent-harness conformance suite factory.** `describeAgentHarnessConformance(makeHarness)` covering: descriptor/capability honesty, start/send/cancel/dispose lifecycle, event-stream ordering and schema validity, permission-request round-trip, cancellation within bounded time, resume only when capability declared (spec §9.1: no emulated resume), usage reporting, error classification. The fake harness must pass it; S1/S2 adapters must pass it unmodified.
- [ ] **Task 0.4 — Gate + merge.** Full gate suite; orchestrator review; merge to base branch; cut the six Wave 1 worktrees from the merged tip.

**Exit criteria:** gap list resolved or explicitly deferred with rationale; fakes + conformance suite merged; Wave 1 branches created.

---

## Wave 1 — six parallel streams

### Stream S1: Agent runtime and native agent (spec §9.1, §9.4 — subproject 3a)

**Owns:** `packages/agent-runtime/` (new), `packages/agent-native/` (new).

**Consumes:** `AgentHarnessPort`, `AgentSessionEvent`, `AgentInvocationRequest` (contracts); `ModelRouterPort` via Wave 0 fake; conformance suite.
**Produces:** `createAgentRuntime(registry)` — harness registry keyed by `AgentHarnessKind` with installed/authenticated status probing; `createNativeHarness(router: ModelRouterPort)` implementing `AgentHarnessPort` for the classifier/planner/reviewer roles with structured-output prompts and AutoStack tool access.

**Scope highlights:**

- Session supervision: normalized event stream with sequence numbers, durable interruption marking on process loss (spec §15), bounded cancellation.
- Native agent roles: triage classifier (task type/priority/actionability/duplicates), planner (plan with acceptance criteria, risks, verification commands, permission/secret needs, deterministic evidence digest input), reviewer (findings with severity/location/evidence, pass/fail verdict) — each as a role configuration of one native harness, prompts stored as versioned artifacts (spec §16.2).
- All model calls through `ModelRouterPort` — no direct SDK provider wiring in this package (that is S3's job); tests use the Wave 0 fake router plus recorded provider transcript fixtures.

**Exit criteria:** native harness passes the conformance suite; role outputs validate against `TriageEvidenceSchema`, `PlanEvidenceSchema`, `ReviewEvidenceSchema`; ≥80% coverage; gates green.

### Stream S2: CLI harness adapters — Claude Code, Codex, ACP (spec §9.2, §9.3 — subproject 3b)

**Owns:** `packages/agent-claude/` (new), `packages/agent-codex/` (new), `packages/agent-acp/` (new).

**Consumes:** `AgentHarnessPort` + conformance suite (Wave 0); process supervision and PTY patterns from `packages/runner-local` (guardian, redaction, spawn envelope) — reused via its public exports, not copied.
**Produces:** three `AgentHarnessPort` implementations, each with an `isInstalled()`/`isAuthenticated()` probe and a fixture-driven test double of its provider protocol.

**Scope highlights:**

- Child processes supervised through the host-daemon boundary, never the renderer (spec §9.2); reuse of the user's existing CLI authentication; no credential copying.
- Protocol mapping from recorded transcript fixtures: Claude Code stream-json events, Codex CLI protocol, ACP JSON-RPC over stdio with capability negotiation (`initialize`, `session/new`, `session/prompt`, permission requests, cancellation).
- ACP launch config as executable+args only; editing it is a privileged operation (spec §9.3).
- Unsupported capabilities surface as visibly unavailable — the adapter must not fake resume/steer.

**Exit criteria:** all three adapters pass the shared conformance suite against their fixture doubles; a live smoke test behind an env flag (`AUTOSTACK_LIVE_HARNESS_SMOKE=1`) drives the locally installed Claude Code and Codex CLIs end-to-end on a disposable repo; gates green.

### Stream S3: Model plane — router and credentials (spec §10 — subproject 4)

**Owns:** `packages/model-router/` (new), plus the Keychain-backed credential store (extend the existing `apps/desktop/src/main/credential-store.ts` pattern into a reusable `packages/model-router/src/credential-ref-store.ts` consumed by desktop main).

**Consumes:** `ModelRoute`, `ModelRouterPort`, `ModelUsage` contracts; `CredentialRef` concept from spec §7.
**Produces:** `createModelRouter(deps)` implementing `ModelRouterPort` with route types `vercel_gateway`, `openrouter`, and `direct` (OpenAI, Anthropic, xAI) on the Vercel AI SDK; dynamic catalog discovery with capability filtering; fallback with route-event recording (spec §15); usage normalization (unknown recorded as unknown, never estimated); per-station policy evaluation (route/model/token/cost ceilings, spec §10.2).

**Exit criteria:** catalog, routing, fallback, policy, and usage tests pass on recorded HTTP fixtures for all three route types; credential store round-trips through an injected protector and fails closed without OS protection; gates green. (Live validation of all four user-provided credentials happens in Wave 2.)

### Stream S4: Delivery pipeline (spec §8 — subproject 5)

**Owns:** `packages/workflow/src/stations/` (new directory), `packages/domain/src/` pipeline use-cases (append-only), `apps/control-plane/src/` pipeline service + routes.

**Consumes:** `DeliveryPipelinePort`, pipeline evidence schemas, `assertPipelineTransition`, approval machinery (`packages/domain/src/approval.ts`), run machine, workflow executor, Wave 0 fakes for harness/router/integration.
**Produces:** registered workflow handlers `triage`, `plan`, `implement`, `verify`, `review`, `publish` in the (currently empty) handler registry; control-plane routes `POST /v1/runs/:runId/approvals/:approvalId/decision`, `GET /v1/approvals?status=pending`, `POST /v1/runs/:runId/steer`, `POST /v1/runs/:runId/cancel`; a `WorkItem` intake use-case with source deduplication by delivery identifier.

**Scope highlights:**

- Each station consumes ports only. Implement provisions via the existing local `RunnerProvider` worktree flow; verify executes plan-named commands through the existing command executor with exact evidence retention; review runs an isolated session (separate harness session, no implementer state) and routes failure back to implement with bounded attempts (max 3, spec §8.3).
- Plan approval and publish approval reuse the existing evidence-digest + staleness machinery; material change re-requests approval (spec §14.2).
- Retry taxonomy: transient → exponential backoff with jitter; deterministic/policy failures → no auto-retry. Publish uses a stable idempotency key.
- Restart durability: executor lease recovery test for every station and both approval waits.

**Exit criteria:** full pipeline runs queued→completed against all-fake ports in an integration test, including restart-mid-stage and restart-mid-approval; review-fail loop bounded; publication impossible without passing review + fresh approval; gates green.

### Stream S5: GitHub and Slack integrations (spec §13, §4.3, §4.4 — subprojects 6–7)

**Owns:** `packages/integration-github/` (new), `packages/integration-slack/` (new), ingress routes in `apps/control-plane/src/` (append-only).

**Consumes:** `IngressDeliverySchema`, `ChannelBindingSchema`, `DraftPullRequestRequestSchema`, `admitDraftPullRequestRequest`, `SlackProgressRequestSchema`, `IntegrationIngressPort`, `DeliveryIntegrationPort`.
**Produces:** `createGitHubIntegration(auth)` implementing `DeliveryIntegrationPort` (branch push, draft-PR creation with the §4.4 body structure, editable progress comments, checks read) with two auth strategies behind one interface: user-token (validated live against `NeelM0906/Factory`) and GitHub App (installation tokens, fixture-tested); webhook ingress with raw-body signature validation and delivery-ID idempotency; `createSlackIntegration()` with Socket Mode envelope handling (prompt ack, durable queue processing), DM/mention/shortcut intake, thread-bound progress, approval interactivity payloads, and the never-post list (no logs, reasoning, secrets, large diffs — spec §13.2).

**Exit criteria:** webhook signature/replay/idempotency tests; PR flow validated live against the user's Factory repo using their `gh` credentials (branch `autostack/...` pushed, draft PR opened and closed by the test, comments edited in place); Slack flows fully covered by signed fixtures; gates green.

### Stream S6: Workbench, control room, observability (spec §4.1, §4.2, §16.1 — subprojects 8a + observability)

**Owns:** `packages/ui/`, `packages/client-app/`, `apps/web/src/`, `apps/desktop/src/renderer/`, `packages/observability/` (new).

**Consumes:** existing local API + desktop preload bridge; run/event/approval schemas; Wave 0 fakes via a mock API server for component tests; S4's new endpoints (schema-level, from contracts — not S4's implementation).
**Produces:** workbench with left rail (Factory/Projects/Automations/Approvals/Integrations/Settings — Automations inactive per §4.2 note on future stages), run supervision panes (conversation, plan, terminal via existing evidence streams, diff, verification evidence, reviewer findings), right inspector (harness, route, environment, usage, provenance), persistent composer (steer/answer/cancel), command palette, approval inbox with evidence display; factory dashboard deriving §4.2 metrics from run events; light/dark themes, keyboard navigation, reduced motion, screen-reader labels, non-color-only status (spec §4.1); `packages/observability` with OpenTelemetry-compatible tracing/metrics/structured-log helpers and correlation-ID propagation adopted by control plane and host daemon.

**Exit criteria:** Playwright component/e2e coverage of workbench, approval surfaces, dashboard, and failure states including accessibility assertions; dashboard numbers proven against a seeded event fixture; observability spans asserted across one full fake-pipeline run; gates green.

---

## Wave 2 — integration, packaging, acceptance

Two streams in parallel, then a serial acceptance run.

### Stream I1: Composition and end-to-end journeys

**Owns:** `apps/control-plane/src/server.ts` composition, `apps/desktop` runtime manifest, `apps/desktop/e2e/`, `scripts/`.

- [ ] Replace Wave 0 fakes with real S1–S3/S5 implementations in the control-plane composition root; agent selection and model-route selection exposed through the API and UI.
- [ ] Live model-route smoke for all four credential sets (Anthropic, OpenAI, Gateway, OpenRouter) behind `AUTOSTACK_LIVE_MODEL_SMOKE=1`.
- [ ] Implement spec §17.4 journeys 1, 4, 5, 6, 7, 8 as Playwright tests against the built desktop bundles (journey 2 Slack and 3 GitHub run fixture-backed here, live at wiring time).
- [ ] Extend `scripts/verify-local-execution.mjs` into `scripts/verify-milestone-a.mjs` adding pipeline restart-resume and duplicate-external-action checks (acceptance criterion 14).
- [ ] **Ingress→intake requester mapping (S4-flagged seam, orchestrator-confirmed 2026-08-31):** the composition that converts a consumed `IngressDelivery` into `IntakeWorkItemInput` MUST map `requester.externalId` from `delivery.issue.authorId` — which for `issue_comment.created` is the **commenter**, not the issue opener, by S5's parser contract (b76b46d). S4's source-authorization check (Task 4A) authorizes whatever this field carries; a wrong mapping here authorizes the wrong person while every stream's own tests stay green. The composition test must include the commenter≠issue-author vector.
- [ ] **Launch-configuration editing is an execute-code grant (S2-flagged seam, 2026-08-31):** spec §9.3 makes editing an agent launch configuration equivalent to permission to execute local code. S2's schema validates shape only and states this limitation in its module docs — it cannot authorize the editor. ANY surface that exposes launch-config editing (control-plane API route, desktop settings UI) MUST gate writes behind the same approval discipline as command execution; a read-only exposure needs no gate. Composition review must enumerate every write path to launch configuration and show its gate, or show the path does not exist.

### Stream I2: Packaging and security tests

**Owns:** `apps/desktop` packaging config, `.github/workflows/ci.yml`, security test fixtures across packages.

- [ ] ASAR packaging, `.app` bundle, DMG build; signing + notarization wired but gated on the user's Apple Developer credentials (spec §18.1 requires them only before external distribution — document the toggle).
- [ ] Spec §17.5 suites: prompt-injection fixtures (repo instructions attempting permission grants, issue text attempting secret exfiltration), command/path traversal, webhook replay/signature failure, redaction and artifact scanning fixtures, dependency scanning in CI.
- [ ] CI matrix update: all new packages in the build/check/coverage graph.

### Acceptance run (serial, orchestrator + user)

- [ ] Execute all 16 §18 acceptance criteria against the user's `NeelM0906/Factory` repository, recording evidence per criterion into `docs/development/milestone-a-acceptance.md`.
- [ ] **User wiring session (requires the user):** register the GitHub App (instructions provided; satisfies criterion 2), create the Slack app + Socket Mode token (instructions provided; criteria 3–4), confirm model credentials in Keychain, then re-run journeys 2 and 3 live.
- [ ] User sign-off; merge to `main`; tag `v0.2.0-milestone-a`.

---

## Merge protocol (every stream, every wave)

1. Stream lead runs `pnpm format:check && pnpm check && pnpm test:coverage && pnpm build` in its worktree — all green, coverage ≥80% on owned packages.
2. Orchestrator review: spec-section compliance, contract-boundary discipline (no cross-implementation imports), security constraints, test honesty (no weakened assertions), convention match.
3. Rebase onto current base, re-run gates, merge with conventional-commit history intact.
4. After each Wave 1 merge, remaining streams rebase at their next natural checkpoint.

## Dependency ledger

| Blocked item                       | Blocks on           | Unblocking artifact                    |
| ---------------------------------- | ------------------- | -------------------------------------- |
| All Wave 1                         | Wave 0              | merged fakes + conformance suite       |
| S2 conformance runs                | Wave 0              | suite factory (not S1)                 |
| S4 pipeline                        | nothing in Wave 1   | uses Wave 0 fakes                      |
| S6 approval inbox against real API | S4 merge            | until then: mock server from contracts |
| I1 composition                     | all of S1–S6 merged | —                                      |
| Acceptance criteria 2–4 live       | user wiring session | GitHub App + Slack app registration    |

## User-required inputs (none block Wave 0–1 start)

- Already available: `gh` CLI auth for `NeelM0906/Factory`; Anthropic/OpenAI/Gateway/OpenRouter keys (needed first in Wave 2 live smokes; provided via env to the specific test process only, never exported globally, per README credential discipline).
- Wave 2 wiring session: GitHub App registration, Slack app creation, optional Apple Developer signing credentials.
