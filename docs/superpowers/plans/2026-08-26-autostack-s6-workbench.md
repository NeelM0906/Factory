# AutoStack Stream S6 Implementation Plan — Workbench, Control Room, Observability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stream:** S6 · **Worktree:** `/Users/zidane/factory-s6` · **Branch:** `codex/milestone-a-s6-workbench` · **Base:** `02e5cff`
**Authored:** 2026-08-27 · **Revised:** 2026-08-27 (orchestrator review: APPROVE-WITH-CHANGES, 9 required changes folded)
**Charter:** `.superpowers/sdd/dispatch-s6.md` + master plan "Stream S6" section.

**Goal:** Deliver the AutoStack supervision surface — a workbench that supervises agent work (spec §4.1), a factory control room whose numbers are derived from durable run events and nothing else (spec §4.2), and a standalone observability package that gives every command and stage trace/correlation identity with redaction-safe attributes (spec §16.1) — all provably accessible, all provably schema-honest.

**Architecture:** Three layers, each independently testable.

1. `packages/ui` holds presentation primitives with no knowledge of transport: the shell, the theme/motion controller, pane groups, the command palette dialog, the composer, and status presentation. Every primitive is a pure function of props.
2. `packages/client-app` holds the data layer and the composed features. `AutoStackApiClient` grows the approval/steer/cancel surface; a `RunSupervisionSource` port carries the run-supervision payloads the panes render; a contract-derived mock API server (every response `parse`d through the contract schema before it is served) is the test substrate until S4's endpoints exist. Swapping mock→real is a factory argument, never an edit.
3. `packages/observability` is standalone: an OTLP-shaped span/metric/log vocabulary with correlation-ID propagation, an injectable exporter, and a no-op default. It ships with its own tests and is adopted by the control plane and host daemon in Wave 2, not here.

`apps/web/src` and `apps/desktop/src/renderer` remain thin composition roots over `packages/client-app`.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9 strict; pnpm 10.27; Turborepo 2; Zod 4; React 19; Vitest 4 (jsdom via `// @vitest-environment jsdom` docblock); `@testing-library/react`; `axe-core` (Vitest) and `@axe-core/playwright` (e2e); Playwright 1.62; Electron 43.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` §4.1, §4.2, §8.2, §9.1, §10.2, §14.2, §14.4, §16.1, §17.4, §18.
**Contract map:** `docs/development/milestone-a-contract-audit.md` (items 2, 10, 11, 13, 20 are the shapes this stream renders).

---

## Ownership (binding)

**Owns:** `packages/ui/`, `packages/client-app/`, `packages/observability/` (new), `apps/web/src/`, `apps/web/test/`, `apps/desktop/src/renderer/`, `apps/desktop/e2e/` (renderer-facing specs and fixtures, per the E4 ruling — **including new seeding code for dashboard events**), `apps/desktop/playwright.config.ts` (`testMatch` only), and this plan document.

**Does not touch:** `packages/contracts`, `packages/domain`, `packages/workflow`, `packages/db`, `packages/runner-local`, `apps/control-plane`, `apps/host-daemon`, `apps/cli`, `apps/desktop/src/{main,preload,utility,guardian}`, root config, `.github/`.

**Consequence to hold onto:** the preload bridge is a security boundary owned outside this stream. Anything the renderer needs that is not reachable through the five existing bridge methods (`runtimeStatus`, `request`, `pickRepository`, `subscribeCommand`, `subscribeRuntimeStatus` — `apps/desktop/src/preload/bridge.ts:21-32`) is an escalation, never a workaround.

## Global constraints (inherited, verbatim in force)

- TypeScript strict; no unchecked `any`, non-null assertions, disabled tests, placeholder/TODO implementations, or validation bypasses.
- All cross-boundary data is Zod-validated. **A mock that can serve data its contract schema would reject is a defect**, not a test convenience.
- No implementation package imports another implementation across a contract boundary. This stream depends on `@autostack/contracts` and `@autostack/domain/testing` only.
- Secrets: nothing rendered, logged, exported, or attached to a span may carry credential material. Reuse `containsSensitiveMaterial` / `redactSensitiveText` / `normalizeSafeJson` / `SafeMetadataStringSchema` from `@autostack/contracts` (`packages/contracts/src/secret-safety.ts:726-927`); fail closed when redaction cannot serialize.
- Untrusted input (repo contents, issue text, Slack text, agent output) is rendered as **text**, never as markup, never as a permission grant. No `dangerouslySetInnerHTML` anywhere in this stream.
- 80% coverage floor (statements, branches, functions, lines) on every owned package.
- TDD: failing test first, observe the stated failure, minimal implementation, focused re-run, package verification, conventional-commit per task.
- UTF-8, LF, Prettier-formatted. `as-` class prefix in `packages/ui`; unprefixed classes in `packages/client-app/src/app.css`. Small file per concern: no source file over 400 lines without a stated reason.
- Never push. Merges are orchestrator-owned.

### Lockfile discipline (note 13)

Three tasks touch `pnpm-lock.yaml`, all unavoidably and all expected: Task 10b adds `axe-core` as a devDependency of `@autostack/web`; Task 11a creates the `packages/observability` workspace entry. `pnpm install --frozen-lockfile` is a CI gate, so the lockfile change is committed **with the task that causes it**, never separately, and no task adds a dependency it does not consume in the same commit.

---

## Decided rulings (supersede the plan's original escalations)

The four escalations raised at PLAN_READY have been ruled on. Each is now a **single decided path** — no forks remain in this plan.

### D1 — Desktop approvals/steer/cancel: build HTTP-first, fail typed on desktop, align at contracts 0.12

`DesktopApiRequestSchemaByOperation` (`packages/contracts/src/desktop-api.ts:162-204`) has no `factory.approvals.*`, `factory.runs.steer`, or `factory.runs.cancel`, so `window.autostack.request<K>` cannot reach them. Wave 0 added the HTTP shapes (`packages/contracts/src/api.ts:117-182`); nothing carries them across IPC.

**Decided path:** every feature is built behind `AutoStackApiClient` and lands complete on the HTTP transport. `createDesktopApiClient` implements the four methods by throwing `ApiOperationUnavailableError`, which the UI renders as a **typed, named, non-color-only unavailable state**. When the operations land in contracts 0.12, the desktop client body becomes four `bridge.request` calls and the unavailable state deletes itself. No fake data, no silent no-op, no second code path in the meantime.

The operations, when added by the orchestrator, reuse the existing `IdempotencyKeySchema` (`packages/contracts/src/local-api.ts:26`) for their key field rather than declaring a new regex — this is the D2 ruling applied to the desktop surface.

### D2 — Approval decision idempotency is **server-derived**; the client sends no key (RULED, refined after S4's question)

The server derives the decision's idempotency key internally as `${approvalId}:${decision}:${evidenceDigest}` and **ignores any client-supplied `Idempotency-Key` header** on that route.

**What this stream therefore does:**

- `decideApproval` **omits the `Idempotency-Key` header entirely.** There is no client-side derivation, no key factory, and no idempotency regex anywhere in this stream's production code for that route. A client that sent a key would be sending something the server discards — worse than useless, because it implies a contract that does not exist.
- The mock API server **must not require or validate the header** on the decision route; it derives the key internally under the same rule, so the mock and the real server agree by construction rather than by convention.
- **Steer and cancel keep the client-supplied random-key header** as before. They are intent, not a decision over specific evidence, so re-issuing one is a new instruction and must not be replayed. That factory stays injected for test determinism.

**Server behavior this stream builds and tests against (three rules, three test cases):**

| Case                                                   | Result                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Same `(approvalId, decision, evidenceDigest)` repeated | `replayed: true` with the **original** `decidedAt`                            |
| **Different decision** on the same approval            | **409** conflict (`idempotency_conflict` / `version_conflict`)                |
| Stale `evidenceDigest`                                 | Rejected **before any record is written** — no partial state, no replay entry |

The staleness check runs **first**, ahead of the replay store, so a stale decision can never leave a record behind. That ordering is itself a test case, not an implementation detail.

Client-side the second and third rows are indistinguishable and must be: both are 409 → `ApiConflictError`, and the UI renders "the evidence changed — review again" without branching on which code the server chose. The client does not encode S4's choice between the two error codes.

**Shape note (analysis retained, now S4's to apply).** `apr_<uuid>:approved:<64-hex>` is 40 + 1 + 8 + 1 + 64 = **114 characters**, starts with an alphanumeric, and uses only `[A-Za-z0-9._:-]` — so it satisfies `IdempotencyKeySchema` at `packages/contracts/src/local-api.ts:26` (`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`, max 128), the `min(1).max(240)` variant in `agent.ts`/`model.ts`/`integration.ts`, and the control plane's `length > 200` header rejection (`apps/control-plane/src/app.ts:159`). Recorded because the ruling rests on it; no code in this stream depends on it.

### D3 — Run supervision data is fixture-backed in Wave 1; Wave 2 I1 binds the transport

No API contract carries `AgentSessionStreamEvent` (`packages/contracts/src/agent.ts:354`) or the station evidence documents (`station-evidence.ts:90, 157, 216`): `/v1/runs/:runId/events` returns `StoredDomainEvent` and `EVENT_TYPES` has no member for either.

**Decided path (option c):** the panes are built now as pure presentational components typed directly by those contract schemas, behind a `RunSupervisionSource` port with one implementation in this stream — `createFixtureRunSupervisionSource`, whose every return value is contract-`parse`d. Binding the port to a real transport is a **named Wave 2 I1 deliverable**. When the source is absent, the panes render a typed, named empty state; they never render invented data.

### D4 — §4.2 usage and cost have no event source; they render "Not recorded"

`EVENT_TYPES` (`packages/contracts/src/events.ts:50-69`) has 18 members and none carries model usage. The contract audit defers appending to it (audit line 451), because it widens `DomainEventType` and `PendingDomainEvent` and needs `validateRunStreamCoherence` updated in the same change.

**Decided path:** the dashboard derives every metric that _is_ event-derivable (Task 9a's table) and renders tokens/cost as an explicit **"Not recorded"** tile — spec §10.2's own rule that missing provider usage is recorded as unknown rather than estimated. `deriveFactoryMetrics` already takes `readonly StoredDomainEvent[]`, so if `model.usage_recorded` is appended later it is a consuming change inside one function and nothing else moves.

### D5 — Playwright scope (exit criterion AMENDED IN WRITING by the orchestrator)

`apps/desktop/e2e/workbench.spec.ts` is approved, along with widening `apps/desktop/playwright.config.ts` `testMatch` to `/.*\.spec\.ts$/`. It runs under the existing `pnpm desktop:e2e` CI step — **no CI edit**. The fixtures-directory grant explicitly includes new seeding code for dashboard events.

**Wave 1 desktop e2e covers:** dashboard read-back from seeded events; accessibility, theme, keyboard, and reduced-motion assertions; and the typed unavailable/empty states for the inbox and panes.

**Vitest covers:** approval-paging (against the mock API server) and pane-payload assertions (against the fixture supervision source).

**Wave 2 I1 owns:** full e2e binding of the inbox and panes, which lights up when the desktop operation (D1) and the real routes (D3) land.

There is no web Playwright suite. The web accessibility guarantee is enforced by Task 10b's axe-in-Vitest gate instead.

### Note — coverage was not being enforced on `@autostack/client-app`

`packages/client-app` has no `vitest.config.ts`, so `test:coverage` runs without the root config's 80% thresholds (verified: 89.34% statements reported, exit 0, thresholds never applied). Task 1 adds the two-line shim `packages/ui` and `apps/web` already have.

---

## Scope dispositions (required change 8)

Three surfaces sit on the boundary of the charter's pane list. Each is decided here so no task has to decide it mid-flight.

| Surface                 | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project/run sidebar** | **In scope, Task 10a.** Spec §4.1 requires a hierarchical project/run sidebar showing active work, attention states, and recent history. A rudimentary version exists (`runNavigation`, `packages/client-app/src/app.tsx:113`); Task 10a upgrades it to group by project, surface attention states (`needs_clarification`, `awaiting_*_approval`, `failed`), and separate active from recent history.                                                                                                                                                       |
| **Artifacts pane**      | **Deferred, derivable, spec delta named.** Spec §4.1 lists "artifacts" among the central panes; the S6 charter's pane list names six and artifacts is not one of them. **Ruling: charter-scoped six panes.** It is _derivable_ today — `artifact.recorded` is in `EVENT_TYPES` (`events.ts:67`) and `ArtifactSchema` (`entities.ts:~283`) carries kind/digest/size — so this is a scope choice, not a blocked one. Recorded as a Wave 2 candidate with the delta stated: **spec §4.1 pane list ⊃ S6 charter pane list, by exactly one member (artifacts).** |
| **Inspector policy**    | **In scope, Task 6.** Spec §4.1 lists policy in the right inspector, and contract audit item 10 put `ModelPolicySchema` (`packages/contracts/src/model.ts:318`) in contracts _specifically so S6 can read it without importing S3_. Omitting it would waste a contract decision made for this stream. It is the sixth inspector section.                                                                                                                                                                                                                    |

---

## Task 1: Contract-derived mock API and the enforced coverage floor

**Files:**

- Create: `packages/client-app/vitest.config.ts`
- Create: `packages/client-app/src/testing/factory-fixture.ts`
- Create: `packages/client-app/src/testing/mock-api-server.ts`
- Create: `packages/client-app/src/testing/index.ts`
- Modify: `packages/client-app/package.json` (add the `./testing` export)
- Test: `packages/client-app/test/mock-api-server.test.ts`

- [ ] **Step 1: Add the missing vitest config and observe the floor engage**

```ts
// packages/client-app/vitest.config.ts
import { defineConfig, mergeConfig } from "vitest/config";

import sharedConfig from "../../vitest.config.js";

export default mergeConfig(sharedConfig, defineConfig({}));
```

```bash
pnpm --filter @autostack/client-app test:coverage
```

Expected: still green (89.34% / 84.35% / 90.8% / 92.07% against an 80% floor), but the summary now ends with the threshold check instead of silence. If any number is below 80, stop and report — that is a pre-existing gap, not something to paper over.

- [ ] **Step 2: Write the failing mock-server contract test first**

```ts
// packages/client-app/test/mock-api-server.test.ts
import { describe, expect, it } from "vitest";
import { ListApprovalsResponseSchema } from "@autostack/contracts";

import { createMockApiServer, seedFactoryFixture } from "../src/testing/index.js";

describe("contract-derived mock API server", () => {
  it("refuses to seed a response its contract schema would reject", () => {
    expect(() =>
      createMockApiServer({
        fixture: seedFactoryFixture({ approvals: [{ approvalId: "not-an-approval-id" } as never] })
      })
    ).toThrow(/approval/i);
  });

  it("pages approvals past the first window with a cursor the query schema accepts", async () => {
    const server = createMockApiServer({ fixture: seedFactoryFixture({ approvalCount: 137 }) });
    const first = ListApprovalsResponseSchema.parse(
      await server.handle({ path: "/v1/approvals", query: { status: "pending", limit: "100" } })
    );
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeDefined();
    const second = ListApprovalsResponseSchema.parse(
      await server.handle({
        path: "/v1/approvals",
        query: { status: "pending", limit: "100", cursor: String(first.nextCursor) }
      })
    );
    expect(second.items).toHaveLength(37);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((i) => i.approvalId)).size).toBe(137);
  });
});
```

```bash
pnpm --filter @autostack/client-app test -- mock-api-server.test.ts
```

Expected failure: `Cannot find module '../src/testing/index.js'`.

- [ ] **Step 3: Implement the fixture builder**

`seedFactoryFixture(options)` produces a deterministic, internally consistent world: workspace ID, work items (with a `SourceRef` per source kind so source-coverage metrics have something to count), runs across every `RUN_STATUSES` member, stage runs, approvals across `plan | publish | permission` and every `ApprovalSchema.shape.status` member, and the `StoredDomainEvent` stream that would have produced them. Injected clock and ID factory — no `Date.now()`, no `crypto.randomUUID()` at module scope. Every produced value is `parse`d through its contract schema **at construction**, so a malformed fixture fails where it is written rather than where it is read.

- [ ] **Step 4: Implement the mock server**

`createMockApiServer({ fixture, failures? })` exposes `handle(request)` and a `fetch`-shaped adapter so it can be handed straight to `createApiClient({ fetch })`. (Per note 12, there is **no `latencyMs` option** — nothing in this plan consumes it.) Routes: `GET /v1/health`, `GET /v1/runs`, `GET /v1/runs/:runId/events`, `POST /v1/runs`, `GET /v1/approvals`, `POST /v1/runs/:runId/approvals/:approvalId/decision`, `POST /v1/runs/:runId/steer`, `POST /v1/runs/:runId/cancel`.

Rules, each of which gets its own test case:

- Every request body is parsed with the contract's **request** schema; a rejection returns `ApiErrorSchema` with `code: "invalid_request"`, never a thrown exception.
- Every response is parsed with the contract's **response** schema before it is returned. `ListApprovalsQuerySchema` is applied to the raw query strings so `limit`/`cursor` coercion is exercised exactly as the real server would.
- `ListApprovalsResponseSchema.items` caps at 100 (`packages/contracts/src/api.ts:142`); paging emits `nextCursor` and the cursor is strictly increasing.
- **Idempotency on the decision route is server-derived (D2).** The mock **neither requires nor validates an `Idempotency-Key` header** there; it derives `${approvalId}:${decision}:${evidenceDigest}` internally, exactly as S4's server does. Four test cases, in this order because the order is the rule:
  1. A request carrying an `Idempotency-Key` header is served identically to one without — the header is ignored, proving the client is right to omit it.
  2. A **stale `evidenceDigest`** is rejected **before any record is written**: the response is 409, and a follow-up read shows the approval still `pending` with no replay entry created.
  3. The same `(approvalId, decision, evidenceDigest)` repeated returns `replayed: true` with the **original** `decidedAt`.
  4. A **different decision** on the same approval returns 409 (`idempotency_conflict`).
- `failures` injects deterministic faults per route: `unauthorized` (401), `network` (fetch rejects), `malformed` (a body the response schema rejects) — this is what Task 10a's failure-state tests drive.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/client-app check
pnpm --filter @autostack/client-app test:coverage
pnpm format:check
git add packages/client-app/vitest.config.ts packages/client-app/src/testing packages/client-app/package.json packages/client-app/test/mock-api-server.test.ts
git commit -m "test(client-app): serve the factory API from its own contracts"
```

---

## Task 2: Extend the API client with approvals, steering, and cancellation

**Files:**

- Modify: `packages/client-app/src/api-client.ts`
- Create: `packages/client-app/src/api-errors.ts`
- Create: `packages/client-app/src/idempotency.ts` (steer/cancel key factory **only** — no decision derivation, per D2)
- Modify: `packages/client-app/src/index.ts`
- Test: `packages/client-app/test/api-client.test.ts` (extend), `packages/client-app/test/idempotency.test.ts`

- [ ] **Step 1: Write the failing idempotency test (D2 as refined — the client's job is to send nothing)**

```ts
// packages/client-app/test/idempotency.test.ts
it("gives steer and cancel a fresh key each time", () => {
  const factory = createIdempotencyKeyFactory({ randomUUID: sequentialUuids() });
  expect(factory()).not.toBe(factory());
});
```

```bash
pnpm --filter @autostack/client-app test -- idempotency.test.ts
```

Expected failure: `Cannot find module '../src/idempotency.js'`.

The decision route has **no counterpart here on purpose**. The server derives its own key and discards any the client sends (D2), so the client-side assertion is the _absence_ of a header — which belongs with the request, and is tested in Step 2.

- [ ] **Step 2: Write the failing client tests**

```ts
it("sends no Idempotency-Key on an approval decision, because the server derives its own", async () => {
  const sent: Request[] = [];
  const client = createApiClient({
    baseUrl: "",
    getToken: () => TOKEN,
    fetch: recording(server.fetch, sent)
  });
  await client.decideApproval(runId, approvalId, input);
  expect(sent.at(-1)?.headers.has("Idempotency-Key")).toBe(false);
});

it("still sends one on steer and cancel", async () => {
  await client.steerRun(runId, { instruction: "narrow the diff" });
  expect(sent.at(-1)?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
});
```

```ts
it("pages the approval inbox past the first window", async () => {
  const server = createMockApiServer({ fixture: seedFactoryFixture({ approvalCount: 137 }) });
  const client = createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch });
  const first = await client.listApprovals({ status: "pending", limit: 100 });
  const second = await client.listApprovals({
    status: "pending",
    limit: 100,
    cursor: first.nextCursor
  });
  expect(first.items.length + second.items.length).toBe(137);
});

it("replays an identical decision rather than deciding twice", async () => {
  const once = await client.decideApproval(runId, approvalId, input);
  const twice = await client.decideApproval(runId, approvalId, input);
  expect(twice.replayed).toBe(true);
  expect(twice.decidedAt).toBe(once.decidedAt);
});

it("surfaces a stale approval decision as a conflict rather than a generic failure", async () => {
  await expect(
    client.decideApproval(runId, approvalId, {
      decision: "approved",
      evidenceDigest: STALE,
      origin: "web"
    })
  ).rejects.toBeInstanceOf(ApiConflictError);
});

it("surfaces a conflicting decision on the same approval the same way", async () => {
  await client.decideApproval(runId, approvalId, { ...input, decision: "approved" });
  // Same evidence, opposite decision: 409 from the server. The client must not branch on
  // whether it came back as version_conflict or idempotency_conflict (D2).
  await expect(
    client.decideApproval(runId, approvalId, { ...input, decision: "rejected" })
  ).rejects.toBeInstanceOf(ApiConflictError);
});

it("refuses to send an operator note containing credential material", async () => {
  await expect(
    client.decideApproval(runId, approvalId, { ...input, note: `ghp_${"a".repeat(36)}` })
  ).rejects.toBeInstanceOf(ApiRequestValidationError);
});
```

```bash
pnpm --filter @autostack/client-app test -- api-client.test.ts
```

Expected failure: `client.listApprovals is not a function`.

- [ ] **Step 3: Add the error vocabulary**

`packages/client-app/src/api-errors.ts` adds `ApiConflictError` (409 / `version_conflict` / `idempotency_conflict`), `ApiRequestValidationError` (the request schema rejected locally, before any network call), and `ApiOperationUnavailableError` (D1's honest desktop gap: carries the operation name and nothing else). `ApiAuthenticationError` and `ApiResponseError` stay exported from `api-client.ts` and are re-exported from the new module.

- [ ] **Step 4: Implement the four HTTP methods**

```ts
listApprovals(query?: ListApprovalsQueryInput, signal?: AbortSignal): Promise<ListApprovalsResponse>;
decideApproval(runId: string, approvalId: string, input: ApprovalDecisionRequest, signal?: AbortSignal): Promise<ApprovalDecisionResponse>;
steerRun(runId: string, input: SteerRunRequest, signal?: AbortSignal): Promise<SteerRunResponse>;
cancelRun(runId: string, input: CancelRunRequest, signal?: AbortSignal): Promise<CancelRunResponse>;
```

Each follows the existing shape exactly: `authenticatedHeaders()`, request-schema `parse` before send (so `SafeMetadataStringSchema` rejects credential-bearing notes/instructions client-side), `decode()` through the response schema, `401 → ApiAuthenticationError`, `409 → ApiConflictError`, other non-ok → `ApiResponseError`. `decideApproval` sets **no** `Idempotency-Key` (D2 — the server derives its own and discards the client's); `steerRun`/`cancelRun` set one from the injected UUID factory. Query values serialize through `URLSearchParams`; `cursor` is omitted when undefined rather than sent as `"undefined"`.

- [ ] **Step 5: Implement `createDesktopApiClient` parity honestly**

The four new methods throw `ApiOperationUnavailableError("factory.approvals.list")` etc., each with a comment citing D1 and the exact contract file that must gain the operation. Test that they throw and that they never touch `bridge.request` — the assertion that catches a future accidental cast.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @autostack/client-app check
pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src packages/client-app/test
git commit -m "feat(client-app): reach the approval, steer, and cancel routes"
```

---

## Task 3: Theme, motion, and focus as a first-class, testable surface

**Files:**

- Create: `packages/ui/src/theme.tsx`
- Modify: `packages/ui/src/tokens.css`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/theme.test.tsx`

- [ ] **Step 1: Write the failing theme and motion tests**

```ts
it("follows the system preference by default and records that it is doing so", () => { ... });
it("pins light or dark when the user chooses, over a dark system preference", () => { ... });
it("restores the user's choice from storage on mount", () => { ... });
it("exposes theme through a labelled radiogroup with three named options", () => { ... });
it("exposes motion through a labelled radiogroup with three named options", () => { ... });
it("writes data-motion=reduced when the user pins reduced motion", () => { ... });
it("writes data-motion=reduced when the system prefers reduced motion and the user has not chosen", () => { ... });
it("never reads or writes storage when no storage is supplied", () => { ... });
```

Assertions are on `document.documentElement.dataset.theme` (`"light" | "dark" | undefined`) and `dataset.motion` (`"reduced" | "full" | undefined`), and on the controls being reachable by `getByRole("radiogroup", { name: /theme/i })` and `{ name: /motion/i }`.

```bash
pnpm --filter @autostack/ui test -- theme.test.tsx
```

Expected failure: `Cannot find module '../src/theme.js'`.

- [ ] **Step 2: Extend the tokens, do not replace them**

The graphite / signal-orange / mint identity stays exactly as it is; no colour value changes. `tokens.css` currently defines light on bare `:root` and overrides under `@media (prefers-color-scheme: dark)` (`packages/ui/src/tokens.css:53`). Additively:

- Guard the dark media block as `:root:not([data-theme="light"])` so an explicit light choice wins over a dark system.
- Add `:root[data-theme="dark"]` repeating the same overrides so the pinned choice wins in both directions.
- **Pin `color-scheme` in both explicit blocks** (note 15): `:root[data-theme="light"] { color-scheme: light; }` and `:root[data-theme="dark"] { color-scheme: dark; }`. Without this the bare `:root { color-scheme: light dark; }` at `tokens.css:2` leaves form controls, scrollbars, and the canvas painted by the _system_ preference while the tokens follow the _pinned_ one — a real mismatch, and the reason a pinned-light-on-dark-system screenshot looks wrong.
- Keep the existing `@media (prefers-reduced-motion: reduce)` block and add a `:root[data-motion="reduced"]` sibling zeroing the same `--as-duration-*` tokens. **This is a real motion mode** (required change 6) — the attribute is written by a control that a user can operate, not an inert marker for tests.

- [ ] **Step 3: Implement `ThemeProvider` / `useTheme` / `ThemeControl`**

Props: `{ storage?: ThemeStorage; matchMedia?: typeof window.matchMedia; children }` — both injected, both optional, no module-scope globals. Two independent states: theme `"system" | "light" | "dark"` and motion `"system" | "reduced" | "full"`. The provider writes `data-theme` / `data-motion` (absent for `"system"`) and subscribes to both media queries so a system flip repaints without a reload. Storage keys `autostack.theme` and `autostack.motion`, matching the existing `autostack.local-api-token` convention.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/ui check
pnpm --filter @autostack/ui test:coverage
git add packages/ui/src packages/ui/test/theme.test.tsx
git commit -m "feat(ui): let the operator pin the workbench theme and motion"
```

---

## Task 4a: Pane group and inspector section primitives

**Files:**

- Create: `packages/ui/src/pane-group.tsx`, `packages/ui/src/inspector-section.tsx`
- Modify: `packages/ui/src/shell.css`, `packages/ui/src/index.ts`
- Test: `packages/ui/test/pane-group.test.tsx`, `packages/ui/test/inspector-section.test.tsx`

- [ ] **Step 1: Write the failing tests**

`PaneGroup` is a real ARIA tablist: `role="tablist"` with `aria-label`, `role="tab"` children with `aria-selected` and `aria-controls`, `role="tabpanel"` with `aria-labelledby` and `tabIndex={0}`. Tests drive `ArrowRight`/`ArrowLeft`/`Home`/`End` and assert roving `tabIndex` (exactly one tab tabbable at a time), and that a pane with no data renders a named empty state rather than nothing.

`InspectorSection` is a labelled `<section>` wrapping a `<dl>`, with an explicit **"Not recorded"** rendering for absent values — a first-class state, not an empty string. This is the shape D4's usage tile uses.

```bash
pnpm --filter @autostack/ui test -- pane-group.test.tsx inspector-section.test.tsx
```

Expected failure: `Cannot find module '../src/pane-group.js'`.

- [ ] **Step 2: Implement, style additively, verify, commit**

Presentation only — no fetching, no contract imports beyond types, no state outliving a mount. Append to `shell.css` using existing tokens only; focus styles route through the existing `:where(...):focus-visible` rule (`packages/ui/src/shell.css:14`), no new focus colour; transitions use `--as-duration-*`, which both reduced-motion paths zero.

```bash
pnpm --filter @autostack/ui check && pnpm --filter @autostack/ui test:coverage
git add packages/ui/src packages/ui/test
git commit -m "feat(ui): add the workbench pane group and inspector sections"
```

---

## Task 4b: Command palette and composer primitives

**Files:**

- Create: `packages/ui/src/command-palette.tsx`, `packages/ui/src/composer.tsx`
- Modify: `packages/ui/src/shell.css`, `packages/ui/src/index.ts`
- Test: `packages/ui/test/command-palette.test.tsx`, `packages/ui/test/composer.test.tsx`

- [ ] **Step 1: Write the failing tests**

`CommandPalette` is a modal dialog: `role="dialog"` + `aria-modal`, focus moves to the filter input on open, `Escape` closes and returns focus to the invoker, `ArrowDown`/`ArrowUp` move an `aria-activedescendant` cursor through `role="option"` rows, `Enter` invokes, focus is trapped while open, a disabled command is `aria-disabled` and is not invoked by `Enter`.

`Composer` has three modes — `steer`, `answer`, `cancel` — each with its own label and submit affordance, and a `busy` state that disables submission without removing the control from the accessibility tree.

```bash
pnpm --filter @autostack/ui test -- command-palette.test.tsx composer.test.tsx
```

Expected failure: `Cannot find module '../src/command-palette.js'`.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/ui check && pnpm --filter @autostack/ui test:coverage
git add packages/ui/src packages/ui/test
git commit -m "feat(ui): add the command palette and persistent composer"
```

---

## Task 5a: The supervision port and the conversation, plan, and terminal panes

**Files:**

- Create: `packages/client-app/src/run-supervision-source.ts`
- Create: `packages/client-app/src/panes/{conversation-pane.tsx,plan-pane.tsx,terminal-pane.tsx}`
- Create: `packages/client-app/src/testing/fixture-run-supervision-source.ts`
- Test: `packages/client-app/test/panes-conversation.test.tsx`, `packages/client-app/test/panes-plan.test.tsx`, `packages/client-app/test/panes-terminal.test.tsx`

- [ ] **Step 1: Define the port**

```ts
export interface RunSupervisionSource {
  sessionEvents(
    runId: RunId,
    afterSequence: number,
    signal?: AbortSignal
  ): Promise<readonly AgentSessionStreamEvent[]>;
  planDocument(runId: RunId, signal?: AbortSignal): Promise<PlanDocument | undefined>;
  verificationReport(runId: RunId, signal?: AbortSignal): Promise<VerificationReport | undefined>;
  reviewReport(runId: RunId, signal?: AbortSignal): Promise<ReviewReport | undefined>;
}
```

One implementation ships in this stream: `createFixtureRunSupervisionSource(fixture)`, every return value contract-`parse`d. The doc comment names D3 and the Wave 2 I1 deliverable. **No stub returning `[]` in production code** — `App` takes the source as an optional prop and renders a named "run supervision data is not served by this build" state when absent.

- [ ] **Step 2: Write the failing pane tests**

- **Conversation** renders `AgentSessionStreamEvent[]` ordered by `sequence`, groups `message` / `thought_summary` / `tool_call` distinctly, renders `permission_requested` with its options and `permission_resolved` with the chosen option, and renders `interrupted` as a distinct, non-color-only state from `failed` (contract audit item 5). Load-bearing test: an out-of-order input array still renders in `sequence` order.
- **Plan** renders `PlanDocument`: summary, ordered acceptance criteria, affected areas, risks by severity, verification commands, required permissions, required credential **refs** (IDs only — never a value). Load-bearing test: a command with `usesShell: true` renders a visible, labelled shell marker, because spec §14.4 requires that fact to be visible in the plan approval.
- **Terminal** renders `RunnerStreamEvent` output from the existing evidence stream, honours `terminal.truncated` as visible evidence rather than silent loss, and renders `stream.error` as terminal.

```bash
pnpm --filter @autostack/client-app test -- panes-conversation.test.tsx panes-plan.test.tsx panes-terminal.test.tsx
```

Expected failure: `Cannot find module '../src/panes/conversation-pane.js'`.

- [ ] **Step 3: Implement, verify, commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src packages/client-app/test
git commit -m "feat(client-app): render the conversation, plan, and terminal panes"
```

---

## Task 5b: The diff, verification, and findings panes

**Files:**

- Create: `packages/client-app/src/panes/{diff-pane.tsx,verification-pane.tsx,findings-pane.tsx}`
- Test: `packages/client-app/test/panes-evidence.test.tsx`

- [ ] **Step 1: Write the failing tests**

- **Diff** renders `file_change` events grouped by path with added/modified/deleted counts. Load-bearing test: a path is rendered as text and never as markup.
- **Verification** renders `VerificationReport`: per-check command, status, exit code, duration. Load-bearing test: a report with `status: "passed"` and a skipped **required** check is unrepresentable — the test asserts the contract parse throws, proving the UI inherits `station-evidence.ts:173` rather than re-implementing it.
- **Findings** renders `ReviewReport` findings by severity with `location` when present. Load-bearing test: `changes_requested` with a critical finding renders the verdict prominently; `approved` with a high finding is unrepresentable (`station-evidence.ts:237`).

```bash
pnpm --filter @autostack/client-app test -- panes-evidence.test.tsx
```

Expected failure: `Cannot find module '../src/panes/diff-pane.js'`.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src packages/client-app/test
git commit -m "feat(client-app): render the diff, verification, and findings panes"
```

---

## Task 6: Right inspector — harness, route, environment, usage, policy, provenance

**Files:**

- Create: `packages/client-app/src/inspector/run-inspector.tsx`, `packages/client-app/src/inspector/usage-summary.ts`
- Test: `packages/client-app/test/run-inspector.test.tsx`

- [ ] **Step 1: Write the failing inspector tests**

Six labelled sections (spec §4.1, with policy per the scope disposition above):

- **Harness** from `AgentHarnessProfile` — capabilities the adapter does not declare render as visibly unavailable, never as absent (spec §9.1, audit item 1).
- **Model route** from `ModelRouteSelection` plus any `ModelRouteFallback`, rendering the fallback's `failureCode` from the closed taxonomy (audit item 21).
- **Environment** from `Environment` — branch, base commit, network policy, resource limits.
- **Usage** from `ModelUsageRecord`, whose `tokens`/`cost` are `reported | unknown` discriminated unions.
- **Policy** from `ModelPolicySchema` (`packages/contracts/src/model.ts:318`) — allowed routes, ordered fallbacks, token/cost ceilings, reasoning level.
- **Provenance** — source trigger from the work item's `SourceRef`, workflow version, adapter ID.

The load-bearing test: given a usage record with `{ kind: "unknown" }` cost, the rendered output contains "Not recorded" and does **not** contain "0" in the cost field. That is spec §10.2 made testable.

```bash
pnpm --filter @autostack/client-app test -- run-inspector.test.tsx
```

Expected failure: `Cannot find module '../src/inspector/run-inspector.js'`.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src/inspector packages/client-app/test/run-inspector.test.tsx
git commit -m "feat(client-app): show route, harness, policy, and usage provenance"
```

---

## Task 7: Composer and command palette wiring

**Files:**

- Create: `packages/client-app/src/composer/run-composer.tsx`, `packages/client-app/src/commands/command-registry.ts`
- Create: `packages/client-app/src/use-factory-actions.ts`
- Modify: `packages/client-app/src/use-factory.ts`
- Test: `packages/client-app/test/run-composer.test.tsx`, `packages/client-app/test/command-registry.test.ts`

**File-size discipline (note 13):** `use-factory.ts` is already 469 lines. The three new actions (`steer`, `cancel`, `answerClarification`) go in a **new** `use-factory-actions.ts` and are composed into the returned `FactoryController`; `use-factory.ts` gains only the composition line. It does not grow past its current size.

- [ ] **Step 1: Write the failing tests**

- Steering an active run calls `client.steerRun` once and reflects `accepted`.
- Cancelling requires a reason (`CancelRunRequestSchema` `min(1)`) and is a two-step confirm, because it is irreversible.
- Answering a `ClarificationRequest` sends the answer with an idempotency key; re-submitting the same answer does not send twice.
- An instruction containing credential material is rejected **before** the request leaves the client, with a visible error naming the field.
- The palette registry produces create / locate / open / cancel / retry / hand-off commands; a command unavailable for the current selection is present and `aria-disabled`, never silently missing.
- `Cmd/Ctrl+K` opens the palette from anywhere in the shell; `Escape` returns focus to the previously focused element.

```bash
pnpm --filter @autostack/client-app test -- run-composer.test.tsx command-registry.test.ts
```

Expected failure: `Cannot find module '../src/composer/run-composer.js'`.

- [ ] **Step 2: Implement, verify, commit**

Each action follows the existing `createRun` shape: abort the in-flight controller, set a busy flag, act, refresh, translate failure into a message on state rather than an unhandled rejection.

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src packages/client-app/test
git commit -m "feat(client-app): steer, answer, and cancel from the persistent composer"
```

---

## Task 8: Approval inbox with cursor paging and evidence digest display

**Files:**

- Create: `packages/client-app/src/approvals/approval-inbox.tsx`, `packages/client-app/src/approvals/use-approvals.ts`
- Test: `packages/client-app/test/approval-inbox.test.tsx`

Per D5 this is where the **approval-paging assertion lives** — Vitest against the mock server, not e2e.

- [ ] **Step 1: Write the failing inbox tests**

```ts
it("loads every pending approval past the first window", async () => {
  const server = createMockApiServer({ fixture: seedFactoryFixture({ approvalCount: 137 }) });
  render(<ApprovalInbox client={createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch })} />);
  fireEvent.click(await screen.findByRole("button", { name: /load more approvals/i }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(137));
  expect(screen.queryByRole("button", { name: /load more approvals/i })).toBeNull();
});
```

Plus: the digest is displayed truncated with the full value available to assistive technology; approving sends the displayed digest so a stale decision is detectable; **any** `ApiConflictError` renders "the evidence changed — review again", refreshes that row, and **does not** retry automatically (spec §14.2) — the UI does not distinguish a stale digest from a conflicting decision, per D2; a replayed decision (`replayed: true`) is shown as already-decided rather than as a new decision; the status filter offers every `ApprovalSchema.shape.status` member, **sourced from the schema** rather than a hand-written list.

**Non-color-only, schema-sourced (required change 5).** The status-cue test iterates the vocabularies rather than a literal list, so a new member added in contracts fails this test instead of silently shipping colour-only:

```ts
it.each(ApprovalSchema.shape.status.options)("gives %s a non-color cue and a text label", (status) => {
  render(<ApprovalRow approval={{ ...base, status }} />);
  const row = screen.getByRole("listitem");
  expect(within(row).getByText(new RegExp(status.replace("_", " "), "i"))).toBeInTheDocument();
  expect(row.querySelector("[data-cue]")?.textContent?.trim()).not.toBe("");
});

it.each(RUN_STATUSES)("gives run status %s a non-color cue and a text label", (status) => { ... });
```

- [ ] **Step 2: Implement `useApprovals`**

Cursor accumulation modelled on the existing `useFactory.loadMore` discipline: an `AbortController` per request, no double-fetch while one is in flight, de-duplication by `approvalId`, and a distinct `paginationMessage` for a failed page so one bad page does not blank the loaded list.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src/approvals packages/client-app/test/approval-inbox.test.tsx
git commit -m "feat(client-app): page the approval inbox and bind decisions to evidence"
```

---

## Task 9a: Derive the control-room metrics from run events

**Files:**

- Create: `packages/client-app/src/metrics/{derive-factory-metrics.ts,types.ts}`
- Create: `packages/client-app/src/testing/seed-dashboard-events.ts`
- Test: `packages/client-app/test/derive-factory-metrics.test.ts`

- [ ] **Step 1: Build the seeded event fixture with hand-computed expectations**

`seed-dashboard-events.ts` is the **new seeding code the fixtures grant covers** (D5). Its output is a literal, hand-written `StoredDomainEvent[]` — **not** generated by the same code under test — covering: 7 work items (3 github, 2 slack, 1 manual, 1 api); 7 runs whose transitions land 2 active, 1 waiting on approval, 1 blocked on clarification, 1 failed, 2 completed; 19 stage lease/succeed/fail triples across all six stages including one `implement` at `attempt: 3`; 4 approvals of which 3 are decided with known request→decide gaps; 5 `command.completed`; 1 `publish` stage success. Every expected number is a literal in the test with the arithmetic shown:

```ts
// 2 completed runs: run_a created 10:00:00Z -> completed 10:04:00Z (240s)
//                   run_b created 10:01:00Z -> completed 10:11:00Z (600s)
// median cycle time = (240 + 600) / 2 = 420_000 ms
expect(metrics.cycleTime.medianMs).toBe(420_000);
```

```bash
pnpm --filter @autostack/client-app test -- derive-factory-metrics.test.ts
```

Expected failure: `Cannot find module '../src/metrics/derive-factory-metrics.js'`.

- [ ] **Step 2: Implement the derivation as one pure function**

```ts
export const deriveFactoryMetrics = (
  events: readonly StoredDomainEvent[],
  options: { readonly now: string; readonly windowComplete: boolean }
): FactoryMetrics => { ... };
```

| Metric                | Derived from                                                                         |
| --------------------- | ------------------------------------------------------------------------------------ |
| Intake volume         | `work_item.created` count                                                            |
| Source coverage       | `work_item.created` → `payload.workItem.source.kind`                                 |
| Run state counts      | fold `run.created` + `run.transitioned` per `runId` to a final `RunStatus`           |
| Stage throughput      | `stage.succeeded` per `payload.stage`                                                |
| Queue depth           | `stage.queued` minus `stage.leased`, per stage, by `jobId`                           |
| Stage latency         | `stage.leased.occurredAt` → `stage.succeeded\|failed.occurredAt`, matched on `jobId` |
| Retry counts          | max `stage.leased.payload.attempt` per `(runId, stage)`                              |
| Pass rate             | `verify`-stage `succeeded / (succeeded + failed)`                                    |
| Cycle time            | `run.created.occurredAt` → the `run.transitioned` whose `to === "completed"`         |
| Approval wait time    | `approval.requested` → `approval.decided`, matched on `approvalId`                   |
| Human interventions   | `approval.decided` count + transitions into `waiting_for_user`                       |
| Pull requests drafted | `stage.succeeded` where `stage === "publish"`                                        |
| Validation checks run | `command.completed` count                                                            |
| Tokens / cost         | **no event source — D4.** Returned as `{ kind: "unknown" }`, rendered "Not recorded" |

Rules the tests pin: an empty stream yields zeros, not `NaN`; an unmatched `stage.leased` (crash mid-stage) contributes to queue depth and nothing else; a `run.transitioned` for a run with no `run.created` in the window is counted as partial rather than dropped silently; `windowComplete: false` marks every total partial, mirroring the `partialMetrics` convention at `app.tsx:250`.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src/metrics packages/client-app/src/testing packages/client-app/test
git commit -m "feat(client-app): derive the control-room metrics from run events"
```

---

## Task 9b: The factory dashboard view

**Files:**

- Create: `packages/client-app/src/dashboard/factory-dashboard.tsx`
- Test: `packages/client-app/test/factory-dashboard.test.tsx`

- [ ] **Step 1: Write the failing view tests**

Lifecycle strip Signal→Monitor with Document and Monitor rendered as **inactive future stages** (spec §4.2, asserted by `aria-disabled`); metric cards through the existing `MetricCard`; the cost tile reads "Not recorded"; a visible "showing the loaded run window" note whenever `windowComplete` is false.

```bash
pnpm --filter @autostack/client-app test -- factory-dashboard.test.tsx
```

Expected failure: `Cannot find module '../src/dashboard/factory-dashboard.js'`.

- [ ] **Step 2: Implement, verify, commit**

Collection is bounded and honest: page `/v1/runs`, then page each run's `/v1/runs/:runId/events`; the note says so.

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src/dashboard packages/client-app/test/factory-dashboard.test.tsx
git commit -m "feat(client-app): render the factory control room"
```

---

## Task 10a: Assemble the workbench, the sidebar, and the failure states

**Files:**

- Modify: `packages/client-app/src/app.tsx`, `packages/client-app/src/app.css`, `packages/client-app/src/index.ts`
- Create: `packages/client-app/src/workbench/{workbench.tsx,navigation.ts,run-sidebar.tsx}`
- Test: `packages/client-app/test/app.test.tsx` (extend), `packages/client-app/test/workbench.test.tsx`

**File-size discipline (note 13):** `app.tsx` is 417 lines today. The run queue, the manual-run form, and the sidebar move into `workbench/`; `app.tsx` ends this task **under 250 lines** and the exported `App` signature does not change, because `apps/web` and `apps/desktop/src/renderer` both construct it.

- [ ] **Step 1: Write the failing navigation, sidebar, and failure-state tests**

Six destinations reachable by keyboard; `Automations` present and `aria-disabled` with a "future stage" description (spec §4.2). The sidebar (per the scope disposition) groups by project, surfaces attention states, and separates active work from recent history — tested by asserting a run in `awaiting_plan_approval` appears under an "Needs attention" group with a text label and a non-colour cue.

Failure states, each driven by the Task 1 `failures` injector and each asserted as a **named, actionable** state rather than a blank pane: control plane unreachable; 401 after token expiry; malformed response; approval decision conflict; run supervision source absent (D3); desktop operation unavailable (D1).

The existing 33 tests in `app.test.tsx` must keep passing unmodified — the workbench is an addition to the shell, not a replacement.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app apps/web/src
git commit -m "feat(client-app): assemble the workbench across all six destinations"
```

---

## Task 10b: The web accessibility gate (axe in Vitest)

**Files:**

- Create: `apps/web/test/accessibility.test.tsx`
- Modify: `apps/web/package.json` (add `axe-core` devDependency), `apps/web/src/main.tsx`
- Modify: `pnpm-lock.yaml` (see the lockfile discipline note)

This is the web half of the accessibility guarantee, replacing the web Playwright suite that D5 ruled out.

- [ ] **Step 1: Add the dependency and write the failing test**

`axe-core` (not `@axe-core/playwright` — there is no browser here) as a devDependency of `@autostack/web` only. The test renders the composed web app against the Task 1 mock server and runs axe over the jsdom tree:

```ts
// @vitest-environment jsdom
import axe from "axe-core";

const expectNoViolations = async (container: HTMLElement): Promise<void> => {
  const results = await axe.run(container, { resultTypes: ["violations"] });
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
};

it.each(["light", "dark"] as const)("has no accessibility violations in the %s theme", async (theme) => {
  document.documentElement.dataset.theme = theme;
  const { container } = render(<App client={mockClient} />);
  await screen.findByRole("heading", { name: "AutoStack Factory" });
  await expectNoViolations(container);
});

it("has no accessibility violations on the approval inbox or the dashboard", async () => { ... });
it("has no accessibility violations in any failure state", async () => { ... });
```

```bash
pnpm --filter @autostack/web test -- accessibility.test.tsx
```

Expected failure: `Cannot find module 'axe-core'`.

- [ ] **Step 2: Wire `ThemeControl` on web (required change 9)**

`ThemeProvider` wraps `<App />` in **`apps/web/src/main.tsx`** — the web composition root — with `window.localStorage` as its storage. `ThemeControl` composes inside the Settings destination rendered by `packages/client-app`, so it is reachable identically on web and desktop; `main.tsx` supplies only the provider and the storage. Assert in the test that the control is present and that operating it changes `document.documentElement.dataset.theme`.

Note: jsdom does not compute contrast the way a real browser does, so colour-contrast rules are exercised by the desktop Playwright axe pass (Task 15b), not here. This gate covers structure, roles, names, and labelling — which is where regressions actually happen.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/web check
pnpm --filter @autostack/web test:coverage
git add apps/web pnpm-lock.yaml
git commit -m "test(web): gate the workbench on axe accessibility violations"
```

---

## Task 11a: `packages/observability` — correlation context and safe attributes

**Files:**

- Create: `packages/observability/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/observability/src/{index.ts,correlation.ts,attributes.ts}`
- Test: `packages/observability/test/{correlation.test.ts,attributes.test.ts}`
- Modify: `pnpm-lock.yaml` (new workspace package)

**Dependency stance:** zero runtime dependencies beyond `@autostack/contracts`. "OpenTelemetry-compatible" means the emitted _shapes_ map field-for-field onto OTLP (Task 11b's table makes that falsifiable), so a real OTel exporter is a thin adapter in Wave 2. Pulling `@opentelemetry/*` into Wave 1 would add a dependency for an integration this stream explicitly is not doing.

- [ ] **Step 1: Write the failing correlation tests**

W3C `traceparent` parse/serialize round-trip; a rejected malformed header (wrong version, wrong length, all-zero trace ID); child spans inherit the trace ID and record the parent span ID; `withCorrelation(context, fn)` restores the previous context after both a normal return and a throw; an injected ID factory makes every ID deterministic in tests.

```bash
pnpm --filter @autostack/observability test -- correlation.test.ts
```

Expected failure: `No projects matched the filter "@autostack/observability"`.

- [ ] **Step 2: Write the failing attribute-safety tests — the security core of this package**

```ts
it("refuses to attach an attribute whose value carries credential material", () => {
  expect(() => safeAttributes({ "http.url": `https://x/?token=ghp_${"a".repeat(36)}` })).toThrow(/redact/i);
});
it("fails closed when a value cannot be serialized safely", () => {
  expect(() => safeAttributes({ payload: { toJSON() { throw new Error("nope"); } } as never })).toThrow();
});
it("redacts registered sensitive values rather than dropping the attribute", () => { ... });
it("truncates an oversized attribute value and marks it truncated", () => { ... });
```

Implementation reuses `containsSensitiveMaterial`, `redactSensitiveText`, and `normalizeSafeJson` from `@autostack/contracts` — the existing redaction machinery, not a second one.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/observability check && pnpm --filter @autostack/observability test:coverage
git add packages/observability pnpm-lock.yaml
git commit -m "feat(observability): propagate correlation identity with safe attributes"
```

---

## Task 11b: The tracer, the exporter, and the OTLP field mapping

**Files:**

- Create: `packages/observability/src/{tracer.ts,exporter.ts,otlp.ts}`
- Test: `packages/observability/test/{tracer.test.ts,otlp-conformance.test.ts}`

- [ ] **Step 1: Write the failing tracer tests**

`createTracer({ exporter = noopExporter, now, ids })` returns `startSpan(name, { kind, attributes })` with `setAttribute`, `addEvent`, `setStatus`, `recordException`, and `end`. (Per note 12 there is **no `links` option** — nothing in this plan emits a linked span.) Tests assert: a span never ended is never exported; ending twice exports once; an exporter that throws does not propagate into the traced code path — observability must never break the thing it observes — but is counted on a diagnostics channel; the no-op default allocates no span objects, proven by a counting exporter never being called.

- [ ] **Step 2: Write the failing OTLP shape-conformance test (finding 10 — required)**

This is what makes "OpenTelemetry-compatible" falsifiable rather than a claim in a comment. `toOtlpSpan(span)` maps the internal record onto the OTLP `Span` message, and the test asserts the exact key names and value types:

| Internal field          | OTLP field (`opentelemetry.proto.trace.v1.Span`) | Encoding                            |
| ----------------------- | ------------------------------------------------ | ----------------------------------- |
| `traceId`               | `traceId`                                        | 32 lowercase hex chars              |
| `spanId`                | `spanId`                                         | 16 lowercase hex chars              |
| `parentSpanId`          | `parentSpanId`                                   | 16 hex, omitted on a root span      |
| `name`                  | `name`                                           | string                              |
| `kind`                  | `kind`                                           | `SPAN_KIND_*` enum name             |
| `startedAt` / `endedAt` | `startTimeUnixNano` / `endTimeUnixNano`          | decimal string of nanoseconds       |
| `attributes`            | `attributes`                                     | `KeyValue[]` with `AnyValue`        |
| `events`                | `events`                                         | `Event[]` with `timeUnixNano`       |
| `status`                | `status`                                         | `{ code: STATUS_CODE_*, message? }` |
| `resource`              | `resource.attributes`                            | `KeyValue[]`                        |

```ts
it("maps a span onto the OTLP span shape", () => {
  const otlp = toOtlpSpan(recordedSpan);
  expect(Object.keys(otlp).sort()).toEqual([...]); // exact key set — no extra, none missing
  expect(otlp.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(otlp.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(otlp.startTimeUnixNano).toMatch(/^\d+$/);
  expect(otlp.kind).toBe("SPAN_KIND_INTERNAL");
  expect(otlp.attributes).toEqual([{ key: "autostack.run.id", value: { stringValue: runId } }]);
  expect(otlp.status).toEqual({ code: "STATUS_CODE_OK" });
});
it("omits parentSpanId on a root span rather than sending zeroes", () => { ... });
```

- [ ] **Step 3: Implement, verify, commit**

```bash
pnpm --filter @autostack/observability check && pnpm --filter @autostack/observability test:coverage
git add packages/observability
git commit -m "feat(observability): trace spans in an OTLP-conformant shape"
```

---

## Task 12: Metrics and structured logs

**Files:**

- Create: `packages/observability/src/{metrics.ts,logger.ts}`
- Test: `packages/observability/test/{metrics.test.ts,logger.test.ts}`

- [ ] **Step 1: Write the failing tests**

**Metrics:** counter / up-down counter / histogram with OTel instrument semantics; a negative value on a plain counter throws; attribute sets go through the same `safeAttributes` gate; the no-op default records nothing. The registered instrument set is the **complete** §16.1 list (note 13 adds the last two, which the first draft dropped):

`autostack.run.count`, `autostack.stage.latency`, `autostack.queue.wait`, `autostack.approval.wait`, `autostack.stage.retries`, `autostack.model.success_rate`, `autostack.review.pass_rate`, `autostack.intervention.rate`, `autostack.tokens`, `autostack.cost`, **`autostack.cost.per_pull_request`** (§16.1 "cost per completed pull request"), `autostack.runner.provision`, **`autostack.runner.cleanup_health`** (§16.1 "Runner provisioning and cleanup health").

A test iterates the §16.1 list and asserts every instrument is registered, so a future spec reading cannot silently lose one.

**Logger:** every record carries `traceId`, `spanId`, `correlationId`, severity, timestamp, and safe attributes; a log call inside `withCorrelation` inherits the context without being passed it; a message containing credential material is redacted, not dropped, and the record is marked redacted; a sink that throws does not propagate.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/observability check && pnpm --filter @autostack/observability test:coverage
git add packages/observability
git commit -m "feat(observability): record the operational metrics and structured logs"
```

---

## Task 13: One simulated full-pipeline trace, end to end

**Files:**

- Create: `packages/observability/src/testing/{recording-exporter.ts,index.ts}`
- Create: `packages/observability/test/pipeline-trace.test.ts`
- Modify: `packages/observability/package.json` (`./testing` export)

- [ ] **Step 1: Write the failing simulation**

Drive one correlation ID through the full §16.1 span set — ingress → workflow transition → agent session → model call → runner command → external API → artifact storage → notification — using `@autostack/domain/testing`'s fakes as the simulated participants, so the pipeline shape is the real one rather than one invented here.

```ts
expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
expect(spans.map((span) => span.name)).toEqual([...]);           // exact ordered set
expect(orphanSpans(spans)).toEqual([]);                          // every child names a real parent
expect(rootSpan.endTimeUnixNano).toBeGreaterThanOrEqual(maxChildEnd);
expect(JSON.stringify(spans)).not.toContain(SECRET);
expect(JSON.stringify(logs)).not.toContain(SECRET);
expect(metrics.find((m) => m.name === "autostack.stage.latency")?.dataPoints).toHaveLength(6);
```

The planted secret goes into a model API key, a runner environment entry, an agent output line, and an external-API URL — all four paths, one assertion each.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/observability check && pnpm --filter @autostack/observability test:coverage
git add packages/observability
git commit -m "test(observability): trace one simulated pipeline run end to end"
```

---

## Task 14: Desktop renderer composition

**Files:**

- Modify: `apps/desktop/src/renderer/main.tsx`

- [ ] **Step 1: Compose the same client-app surface**

Wrap `App` in `ThemeProvider` with `window.localStorage` (the renderer already uses `window.sessionStorage` for the token, so no preload change is needed and none is proposed). Keep `executionAuthorityDisclosure`, keep `runtimeBridge={window.autostack}`, keep the CSP as it is.

Per D1, the desktop approval and composer surfaces render in their `ApiOperationUnavailableError` state until contracts 0.12 lands. That is the honest rendering of the gap; report it in the status message and do not work around it.

- [ ] **Step 2: Verify and commit**

```bash
pnpm --filter @autostack/desktop rebuild:native
pnpm --filter @autostack/desktop check
pnpm --filter @autostack/desktop test
pnpm --filter @autostack/desktop build
git add apps/desktop/src/renderer/main.tsx
git commit -m "feat(desktop): compose the workbench in the sandboxed renderer"
```

---

## Task 15a: Extract the e2e helpers without changing behavior

**Files:**

- Create: `apps/desktop/e2e/fixtures/desktop-app.ts`
- Modify: `apps/desktop/e2e/local-execution.spec.ts` (imports only — **no assertion changes**)

- [ ] **Step 1: Move `launch`, `assertAccessible`, `attachScreenshot`, and `quitAndWait` into the fixture**

```bash
pnpm --filter @autostack/desktop rebuild:native
pnpm --filter @autostack/desktop build
pnpm desktop:e2e
```

Expected: `local-execution.spec.ts` passes exactly as before. This is a refactor with a green-to-green gate; if any assertion outcome changes, revert and stop.

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/e2e
git commit -m "refactor(desktop-e2e): share the app launch and accessibility helpers"
```

---

## Task 15b: The workbench e2e spec (amended scope per D5)

**Files:**

- Create: `apps/desktop/e2e/workbench.spec.ts`
- Create: `apps/desktop/e2e/fixtures/seed-dashboard-events.ts`
- Modify: `apps/desktop/playwright.config.ts` (`testMatch: /.*\.spec\.ts$/`)

**Wave 1 scope — exactly this, per the orchestrator's written amendment:**

1. **Dashboard read-back** from seeded events — the Task 9a hand-computed numbers, read out of the DOM.
2. **Accessibility** — `assertAccessible(page)` (axe, zero violations) at the default viewport, at a **granted** narrow viewport, in light and in dark.
3. **Theme** — flip `data-theme` through the control and re-run axe in both, proving contrast holds in each (this is the colour-contrast coverage jsdom cannot give).
4. **Keyboard** — tab from the skip link through rail → sidebar → pane tabs → composer with no focus trap and no focus loss; `Cmd+K` opens and `Escape` closes the palette with focus restored.
5. **Reduced motion** — assert the real motion mode, pinned to the token value.
6. **Typed unavailable/empty states** — the approval inbox and the panes render their named D1/D3 states, and those states are themselves accessible.

**Not here (D5):** approval-paging assertions (Task 8, Vitest) and pane-payload assertions (Tasks 5a/5b, Vitest). Full e2e binding of the inbox and panes is a named **Wave 2 I1** deliverable.

- [ ] **Step 1: Write the failing spec**

**Reduced motion, pinned to the token (required change 6).** The `--as-duration-*` tokens resolve to `0ms`, so the assertion reads the computed value rather than trusting the media emulation:

```ts
await page.emulateMedia({ reducedMotion: "reduce" });
const duration = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue("--as-duration-standard").trim()
);
expect(duration).toBe("0ms");
// and the same through the operable control, not just the media query:
await page.getByRole("radio", { name: /reduced/i }).click();
expect(await page.evaluate(() => document.documentElement.dataset.motion)).toBe("reduced");
```

**The Wave 0 geometry lesson, applied.** CI's display work area is ~1024×745 and the window has `minWidth: 1024`, so a resize whose frame does not fit snaps width back to `minWidth` on macOS. The verifier bridge's `resize` clamps to the work area and returns the **granted** size. Every viewport assertion is written against granted geometry:

```ts
const granted = await application.evaluate(() => globalThis.__autostackVerifier.resize(720, 900));
expect(granted).not.toBeNull();
expect(granted?.width).toBeLessThanOrEqual(720);
await expect.poll(async () => await page.evaluate(() => window.innerWidth)).toBe(granted?.width);
await assertAccessible(page);
```

Never `expect(window.innerWidth).toBe(720)`. Never assume a requested size was honoured.

- [ ] **Step 2: Run, fix, and commit**

```bash
pnpm --filter @autostack/desktop rebuild:native
pnpm --filter @autostack/desktop build
pnpm desktop:e2e
git add apps/desktop/e2e apps/desktop/playwright.config.ts
git commit -m "test(desktop-e2e): supervise the workbench dashboard and accessibility"
```

---

## Task 16: Full gate suite, self-review, and stream report

- [ ] **Step 1: Run every gate from the worktree root**

```bash
pnpm format:check
pnpm check
pnpm build --filter='!@autostack/desktop'
pnpm --filter @autostack/desktop rebuild:native && pnpm --filter @autostack/desktop build
pnpm --filter @autostack/ui test:coverage
pnpm --filter @autostack/client-app test:coverage
pnpm --filter @autostack/observability test:coverage
pnpm --filter @autostack/web test:coverage
pnpm test
```

`pnpm test` from root must be green; the known runner-local load-dependent flake gets exactly one re-run and a note, per the protocol.

- [ ] **Step 2: Self-review pass**

Walk `git diff codex/autostack-foundation...HEAD` against this checklist and fix what it catches:

- No TODO, no placeholder, no disabled test, no `.skip`, no `any`, no `!` assertion.
- No `dangerouslySetInnerHTML`, anywhere.
- No idempotency key, derivation, or regex on the approval-decision path in production code, and no branch on which 409 code the server returned (D2).
- No file outside the ownership list is modified — `git diff --name-only` is the proof.
- Every mock response is contract-`parse`d; no fixture bypasses a schema.
- No secret, token, absolute path, or credential value in any rendered string, span attribute, log record, or test snapshot.
- Test output is pristine — no unhandled rejection warnings, no `act()` warnings, no console noise.
- Every changed line traces to a charter requirement or a decided ruling.

- [ ] **Step 3: Write the stream report and stop**

Write `.superpowers/sdd/stream-report.md` with per-task commits, coverage per owned package, the D1–D5 outcomes, and the Wave 2 I1 handoff list. Return `MERGE_READY` with the SHA and a one-line test summary. **Do not push.**

---

## Verification matrix

| Charter exit criterion                      | Proven by                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Workbench panes                             | Tasks 5a/5b Vitest pane-payload tests; Task 15b e2e empty/unavailable states |
| Approval inbox, paging past 100 via cursor  | Task 1 mock (137 approvals), Task 2 client, Task 8 UI — **Vitest, per D5**   |
| Dashboard numbers vs. seeded fixture        | Task 9a hand-computed literals + Task 15b DOM read-back                      |
| Failure states                              | Task 1 `failures` injector, Task 10a tests, Task 15b typed states            |
| Light/dark themes                           | Task 3 tests, Task 10b axe in both, Task 15b axe in both (contrast)          |
| Full keyboard navigation                    | Tasks 4a/4b primitives, Task 7 palette, Task 15b tab traversal               |
| Reduced motion                              | Task 3 real motion mode + Task 15b token-pinned assertion                    |
| Screen-reader labels                        | Every component test asserts by role and accessible name; Task 10b axe gate  |
| Non-color-only status                       | Task 8 `it.each` over `RUN_STATUSES` + `ApprovalSchema.shape.status`         |
| Observability spans/metrics/logs, one trace | Task 13, correlation intact, four planted secrets absent                     |
| OpenTelemetry compatibility is falsifiable  | Task 11b OTLP field-mapping table + shape-conformance test                   |
| ≥80% coverage, all owned packages           | Task 16                                                                      |

## Wave 2 handoff (named deliverables for I1)

1. Bind `RunSupervisionSource` to a real transport (D3) and add the e2e pane-payload assertions.
2. Bind the approval inbox to the real routes once contracts 0.12 lands (D1) and add the e2e paging assertion.
3. Adopt `packages/observability` in the control plane and host daemon.
4. Optional: the artifacts pane (derivable from `artifact.recorded`; the spec §4.1 / charter delta is recorded above).

## Dependency ledger

| Task              | Blocked on     | Unblocking artifact                                     |
| ----------------- | -------------- | ------------------------------------------------------- |
| 14 (desktop half) | contracts 0.12 | four `DesktopApiOperationMap` operations + main handler |
| 9a (usage tile)   | D4             | none — renders "Not recorded" by ruling                 |
| 5a/5b (real data) | Wave 2 I1      | none — fixture-backed by ruling                         |
| 8 (real API)      | S4 merge       | the four `/v1` routes; mock server until then           |

Every task in this plan is executable today. Nothing is blocked.
