# AutoStack Stream S6 Implementation Plan — Workbench, Control Room, Observability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stream:** S6 · **Worktree:** `/Users/zidane/factory-s6` · **Branch:** `codex/milestone-a-s6-workbench` · **Base:** `02e5cff`
**Authored:** 2026-08-27 · **Charter:** `.superpowers/sdd/dispatch-s6.md` + master plan "Stream S6" section.

**Goal:** Deliver the AutoStack supervision surface — a workbench that supervises agent work (spec §4.1), a factory control room whose numbers are derived from durable run events and nothing else (spec §4.2), and a standalone observability package that gives every command and stage trace/correlation identity with redaction-safe attributes (spec §16.1) — all provably accessible, all provably schema-honest.

**Architecture:** Three layers, each independently testable.

1. `packages/ui` holds presentation primitives with no knowledge of transport: the shell, the theme controller, pane groups, the command palette dialog, the composer, and status presentation. Every primitive is a pure function of props.
2. `packages/client-app` holds the data layer and the composed features. `AutoStackApiClient` grows the approval/steer/cancel surface; a new `RunSupervisionSource` port carries the run-supervision payloads the panes render; a contract-derived mock API server (every response `parse`d through the contract schema before it is served) is the test substrate until S4's endpoints exist. Swapping mock→real is a factory argument, never an edit.
3. `packages/observability` is standalone: an OpenTelemetry-compatible span/metric/log vocabulary with correlation-ID propagation, an injectable exporter, and a no-op default. It ships with its own tests and is adopted by the control plane and host daemon in Wave 2, not here.

`apps/web/src` and `apps/desktop/src/renderer` remain thin composition roots over `packages/client-app`, exactly as they are today.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9 strict; pnpm 10.27; Turborepo 2; Zod 4; React 19; Vitest 4 (jsdom via `// @vitest-environment jsdom` docblock); `@testing-library/react`; Playwright 1.62 + `@axe-core/playwright`; Electron 43.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` §4.1, §4.2, §8.2, §9.1, §14.2, §16.1, §17.4, §18.
**Contract map:** `docs/development/milestone-a-contract-audit.md` (items 2, 11, 13, 20 are the shapes this stream renders).

---

## Ownership (binding)

**Owns:** `packages/ui/`, `packages/client-app/`, `packages/observability/` (new), `apps/web/src/`, `apps/desktop/src/renderer/`, and this plan document.

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
- UTF-8, LF, Prettier-formatted. `as-` class prefix in `packages/ui`; unprefixed classes in `packages/client-app/src/app.css`. Small file per concern.
- Never push. Merges are orchestrator-owned.

---

## Escalations — read before Task 1

Four of these were found while reading the contracts against this charter. **E1 and E3 gate tasks in this plan; E4 gates the exit criteria.** Each names the exact schema, the blocking behavior, and a proposed append-only addition, per the protocol's contract-change rule.

### E1 — The desktop bridge has no operation for approvals, steer, or cancel (blocks Task 14, degrades the desktop half of Task 15)

**Schema:** `DesktopApiRequestSchemaByOperation` / `DesktopApiResponseSchemaByOperation` (`packages/contracts/src/desktop-api.ts:162-204`).

**Blocking behavior:** the renderer's only request path is `window.autostack.request<K>`, whose `K` is constrained to `keyof DesktopApiOperationMap`. That map holds `factory.health`, `factory.runs.list`, `factory.runs.events`, `factory.runs.create` and seven `local.*` operations — no approval list, no approval decision, no steer, no cancel. Wave 0 added the HTTP shapes for all four (`ApprovalSummarySchema`, `ListApprovalsQuerySchema`, `ApprovalDecisionRequest/ResponseSchema`, `SteerRunRequest/ResponseSchema`, `CancelRunRequest/ResponseSchema`, `packages/contracts/src/api.ts:117-182`) but nothing carries them across the desktop IPC boundary. The desktop workbench therefore cannot show an approval inbox or drive the composer at all, and the `apps/web` build can.

**Proposed append-only addition (orchestrator applies on base):** four operations in `packages/contracts/src/desktop-api.ts`, mirroring the `factory.runs.*` pattern exactly —

```ts
export const DesktopFactoryApprovalListRequestSchema = z
  .object({ operation: z.literal("factory.approvals.list") })
  .extend(ListApprovalsQuerySchema.shape)
  .strict();
export const DesktopFactoryApprovalDecideRequestSchema = z
  .object({
    operation: z.literal("factory.approvals.decide"),
    approvalId: ApprovalIdSchema,
    runId: RunIdSchema,
    request: ApprovalDecisionRequestSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  })
  .strict();
// factory.runs.steer  -> SteerRunRequestSchema  / SteerRunResponseSchema
// factory.runs.cancel -> CancelRunRequestSchema / CancelRunResponseSchema
```

plus the matching entries in `DesktopApiResponseSchemaByOperation`, `DesktopApiOperationMapSchema`, and the dispatch arm in `apps/desktop/src/main/desktop-request-handler.ts` (main process — not this stream's file). Both are additive; no existing operation changes.

**Mitigation while pending:** every feature is built behind `AutoStackApiClient` and lands complete on the HTTP transport (`apps/web`). `createDesktopApiClient` implements the four new methods by throwing a typed `ApiOperationUnavailableError` that the UI renders as a named, non-color-only "unavailable on desktop" state. When E1 lands, the desktop client body is four `bridge.request` calls and the unavailable state deletes itself. **No fake data, no silent no-op.**

### E2 — §4.2's usage and cost metrics have no event source (shapes Task 9)

**Schema:** `EVENT_TYPES` (`packages/contracts/src/events.ts:50-69`).

**Blocking behavior:** the charter requires dashboard metrics "derived exclusively from run events", and names usage/cost among them. The durable event vocabulary has 18 members and none of them carries model usage, token counts, or cost. `ModelUsageRecordSchema` exists (`packages/contracts/src/model.ts:185`) but is not a domain event, and the contract audit explicitly defers appending to `EVENT_TYPES` to the orchestrator, because it widens `DomainEventType` and `PendingDomainEvent` and requires `validateRunStreamCoherence` to be updated in the same change (audit line 451).

**Proposal:** for Wave 1 the dashboard derives every metric that _is_ event-derivable (the full list is in Task 9) and renders token/cost as an explicit **"Not recorded"** tile — spec §10.2's own rule that missing provider usage is recorded as unknown rather than estimated. If the orchestrator wants live usage tiles in Milestone A, `model.usage_recorded` (payload: `ModelUsageRecordSchema`) must be appended to `EVENT_TYPES` with its coherence rule; I will consume it in a follow-up task with no other change to the metrics engine, whose input is already `readonly StoredDomainEvent[]`.

### E3 — No transport carries `AgentSessionStreamEvent` or the station evidence documents (gates the real half of Tasks 5 and 6)

**Schemas:** `AgentSessionStreamEventSchema` (`packages/contracts/src/agent.ts:354`), `PlanDocumentSchema` / `VerificationReportSchema` / `ReviewReportSchema` (`packages/contracts/src/station-evidence.ts:90, 157, 216`).

**Blocking behavior:** the charter names these as the payloads of the conversation, plan, verification, and findings panes. No API contract carries any of them. `/v1/runs/:runId/events` returns `ListEventsResponseSchema` (`packages/contracts/src/api.ts:80-85`), which is `StoredDomainEvent[]` — and `EVENT_TYPES` has no agent-session member and no station-evidence member. There is no evidence-fetch route in `apps/control-plane/src/app.ts` and none in S4's chartered route list. So the panes have a shape to render and no way to obtain it.

**Proposal:** the panes are built now as pure presentational components typed directly by those contract schemas — that work is real, testable, and transport-independent — behind a `RunSupervisionSource` port in `packages/client-app` with one implementation today (the contract-derived mock). I need a ruling on which of these is the Milestone A answer, and whether it is S4's or Wave 2's to serve:

- **(a)** new API contracts `GET /v1/runs/:runId/sessions/:sessionId/events?after=` returning `AgentSessionStreamEvent[]` and `GET /v1/runs/:runId/evidence` returning the station documents; or
- **(b)** append the agent-detail and station-evidence events to `EVENT_TYPES` so the existing `/v1/runs/:runId/events` stream carries them; or
- **(c)** the panes stay fixture-backed for Milestone A and bind in Wave 2 composition (I1).

I have planned for **(c)** so this stream is not blocked, and the port makes (a) or (b) a one-file addition.

### E4 — Where do this stream's Playwright specs live, and what runs them? (gates the exit criteria)

**Files:** `apps/desktop/playwright.config.ts:5` (`testMatch: "local-execution.spec.ts"`), `.github/workflows/ci.yml:184` (`pnpm desktop:e2e`), master plan line 174 (`apps/desktop/e2e/` is listed under Wave 2 stream I1).

**Blocking behavior:** my exit criteria require Playwright coverage of the workbench panes, the approval inbox paging past 100, the dashboard, failure states, and the accessibility assertions. Three things are outside my ownership as written: `apps/desktop/playwright.config.ts` (a new spec file is not matched by the current `testMatch`), `apps/desktop/e2e/` (I1's per the master plan, though the dispatch tells me to extend `local-execution.spec.ts`'s patterns), and `.github/workflows/ci.yml` (explicitly forbidden). A web-side suite has the same problem one level up: it needs `apps/web/playwright.config.ts` and `apps/web/e2e/` (outside `apps/web/src`), a `@playwright/test` devDependency on `@autostack/web`, and a CI step to run it.

**Requested ruling — two parts:**

1. **Desktop:** may I add `apps/desktop/e2e/workbench.spec.ts` and widen `apps/desktop/playwright.config.ts` `testMatch` to `/.*\.spec\.ts$/`? It runs under the existing `pnpm desktop:e2e` step with no CI edit. I will keep it a second `test()` in a second file rather than growing `local-execution.spec.ts`, reusing its `launch`/`assertAccessible`/`attachScreenshot`/`quitAndWait` helpers by extracting them to `apps/desktop/e2e/fixtures/desktop-app.ts` (a pure move, no behavior change).
2. **Web:** do I own `apps/web/playwright.config.ts` + `apps/web/e2e/`, with the orchestrator adding the one CI step (`pnpm --filter @autostack/web exec playwright test`) on the base branch? If not, I will put the full inbox-paging / dashboard / failure-state / a11y suite in the desktop spec instead — which costs macOS runner minutes but needs no new CI job.

**Default if I get no ruling before Task 15:** I implement part 1 (desktop-only, no CI edit), and cover the web surface with `@testing-library/react` + `axe-core` assertions in Vitest so that the accessibility guarantees are still enforced by an automated gate.

### Note (not an escalation) — coverage was not being enforced on `@autostack/client-app`

`packages/client-app` has no `vitest.config.ts`, so `pnpm --filter @autostack/client-app test:coverage` runs without the root config's 80% thresholds (verified: 89.34% statements reported, exit 0, thresholds never applied). `packages/ui` and `apps/web` both have the two-line `mergeConfig` shim. Task 1 adds the missing one. This is inside my ownership; recording it because it means the package's real floor starts being enforced mid-stream.

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
import { ApprovalSummarySchema, ListApprovalsResponseSchema } from "@autostack/contracts";

import { createMockApiServer, seedFactoryFixture } from "../src/testing/index.js";

describe("contract-derived mock API server", () => {
  it("refuses to seed a response its contract schema would reject", () => {
    expect(() =>
      createMockApiServer({
        fixture: seedFactoryFixture({
          approvals: [{ approvalId: "not-an-approval-id" } as never]
        })
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
    const ids = [...first.items, ...second.items].map((item) => item.approvalId);
    expect(new Set(ids).size).toBe(137);
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

`createMockApiServer({ fixture, latencyMs?, failures? })` exposes `handle(request)` and a `fetch`-shaped adapter so it can be handed straight to `createApiClient({ fetch })`. Routes: `GET /v1/health`, `GET /v1/runs`, `GET /v1/runs/:runId/events`, `POST /v1/runs`, `GET /v1/approvals`, `POST /v1/runs/:runId/approvals/:approvalId/decision`, `POST /v1/runs/:runId/steer`, `POST /v1/runs/:runId/cancel`.

Rules, each of which gets its own test case:

- Every request body is parsed with the contract's **request** schema; a rejection returns `ApiErrorSchema` with `code: "invalid_request"`, never a thrown exception.
- Every response is parsed with the contract's **response** schema before it is returned. `ListApprovalsQuerySchema` is applied to the raw query strings so `limit`/`cursor` coercion is exercised exactly as the real server would.
- `ListApprovalsResponseSchema.items` caps at 100 (`packages/contracts/src/api.ts:142`); paging emits `nextCursor` and the cursor is strictly increasing.
- The decision route enforces evidence staleness: a decision whose `evidenceDigest` does not match the approval's current digest returns `version_conflict`. A repeated decision with the same digest returns `replayed: true` and the original `decidedAt`.
- `failures` injects deterministic faults per route: `unauthorized` (401), `network` (fetch rejects), `malformed` (a body the response schema rejects) — this is what Task 10's failure-state tests drive.

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
- Modify: `packages/client-app/src/index.ts`
- Test: `packages/client-app/test/api-client.test.ts` (extend)

- [ ] **Step 1: Write the failing client tests**

Against the Task 1 mock server, assert:

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

it("surfaces a stale approval decision as a conflict rather than a generic failure", async () => {
  await expect(
    client.decideApproval(runId, approvalId, {
      decision: "approved",
      evidenceDigest: STALE_DIGEST,
      origin: "web"
    })
  ).rejects.toBeInstanceOf(ApiConflictError);
});

it("refuses to send an operator note containing credential material", async () => {
  await expect(
    client.decideApproval(runId, approvalId, {
      decision: "approved",
      evidenceDigest,
      origin: "web",
      note: `ghp_${"a".repeat(36)}`
    })
  ).rejects.toBeInstanceOf(ApiRequestValidationError);
});
```

```bash
pnpm --filter @autostack/client-app test -- api-client.test.ts
```

Expected failure: `client.listApprovals is not a function`.

- [ ] **Step 2: Add the error vocabulary**

`packages/client-app/src/api-errors.ts` adds `ApiConflictError` (409 / `version_conflict` / `idempotency_conflict`), `ApiRequestValidationError` (the request schema rejected locally, before any network call), and `ApiOperationUnavailableError` (E1's honest desktop gap: carries the operation name and nothing else). The two existing errors move nowhere — `ApiAuthenticationError` and `ApiResponseError` stay exported from `api-client.ts` for compatibility and are re-exported from the new module.

- [ ] **Step 3: Implement the four HTTP methods**

Extend `AutoStackApiClient`:

```ts
listApprovals(query?: ListApprovalsQueryInput, signal?: AbortSignal): Promise<ListApprovalsResponse>;
decideApproval(runId: string, approvalId: string, input: ApprovalDecisionRequest, signal?: AbortSignal): Promise<ApprovalDecisionResponse>;
steerRun(runId: string, input: SteerRunRequest, signal?: AbortSignal): Promise<SteerRunResponse>;
cancelRun(runId: string, input: CancelRunRequest, signal?: AbortSignal): Promise<CancelRunResponse>;
```

Each follows the existing shape exactly: `authenticatedHeaders()`, request-schema `parse` before send (so `SafeMetadataStringSchema` rejects credential-bearing notes/instructions client-side), an `Idempotency-Key` header on the two mutating routes, `decode()` through the response schema, `401 → ApiAuthenticationError`, `409 → ApiConflictError`, anything else non-ok → `ApiResponseError`. Query values are serialized through `URLSearchParams`; `cursor` is omitted when undefined rather than sent as `"undefined"`.

- [ ] **Step 4: Implement `createDesktopApiClient` parity honestly**

The four new methods on the desktop client throw `ApiOperationUnavailableError("factory.approvals.list")` etc., with a comment citing E1 and the exact contract file that must gain the operation. Test that they throw and that they never touch `bridge.request` — this is the assertion that catches a future accidental cast.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/client-app check
pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src packages/client-app/test/api-client.test.ts
git commit -m "feat(client-app): reach the approval, steer, and cancel routes"
```

---

## Task 3: Theme, motion, and focus as a first-class, testable surface

**Files:**

- Create: `packages/ui/src/theme.tsx`
- Modify: `packages/ui/src/tokens.css`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/theme.test.tsx`

- [ ] **Step 1: Write the failing theme tests**

```ts
it("follows the system preference by default and records that it is doing so", () => { ... });
it("pins light or dark when the user chooses, over a dark system preference", () => { ... });
it("restores the user's choice from storage on mount", () => { ... });
it("exposes the choice through a labelled control with three named options", () => { ... });
it("never reads or writes storage when no storage is supplied", () => { ... });
```

Assertions are on `document.documentElement.dataset.theme` being `"light" | "dark" | undefined` (undefined = follow the system), and on the control being reachable by `getByRole("radiogroup", { name: /theme/i })`.

```bash
pnpm --filter @autostack/ui test -- theme.test.tsx
```

Expected failure: `Cannot find module '../src/theme.js'`.

- [ ] **Step 2: Extend the tokens, do not replace them**

The graphite / signal-orange / mint identity stays exactly as it is. `tokens.css` currently defines light on bare `:root` and overrides under `@media (prefers-color-scheme: dark)` (`packages/ui/src/tokens.css:53`). Add — additively — a `:root[data-theme="dark"]` block repeating the same overrides, and guard the media block as `:root:not([data-theme="light"])` so an explicit light choice wins over a dark system. No colour value changes. The `prefers-reduced-motion` block stays and gains a `:root[data-motion="reduced"]` sibling so the preference is also assertable without emulating media in jsdom.

- [ ] **Step 3: Implement `ThemeProvider` / `useTheme`**

Props: `{ storage?: ThemeStorage; matchMedia?: typeof window.matchMedia; children }` — both injected, both optional, no module-scope globals. State is `"system" | "light" | "dark"`; the provider writes `data-theme` (absent for `"system"`) and subscribes to the media query so a system flip repaints without a reload. `ThemeControl` is the labelled radiogroup. Storage key `autostack.theme`, same convention as `autostack.local-api-token`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/ui check
pnpm --filter @autostack/ui test:coverage
git add packages/ui/src packages/ui/test/theme.test.tsx
git commit -m "feat(ui): let the operator pin the workbench theme"
```

---

## Task 4: Workbench layout primitives — pane group, inspector, palette, composer

**Files:**

- Create: `packages/ui/src/pane-group.tsx`
- Create: `packages/ui/src/inspector-section.tsx`
- Create: `packages/ui/src/command-palette.tsx`
- Create: `packages/ui/src/composer.tsx`
- Modify: `packages/ui/src/shell.css`, `packages/ui/src/index.ts`
- Test: `packages/ui/test/pane-group.test.tsx`, `packages/ui/test/command-palette.test.tsx`, `packages/ui/test/composer.test.tsx`

- [ ] **Step 1: Write the failing keyboard and semantics tests**

`PaneGroup` is a real ARIA tablist: `role="tablist"` with `aria-label`, `role="tab"` children with `aria-selected` and `aria-controls`, `role="tabpanel"` with `aria-labelledby` and `tabIndex={0}`. Tests drive `ArrowRight`/`ArrowLeft`/`Home`/`End` and assert roving `tabIndex` (exactly one tab is tabbable at a time), and assert that a pane with no data renders a named empty state rather than nothing.

`CommandPalette` is a modal dialog: `role="dialog"` + `aria-modal`, focus moves to the filter input on open, `Escape` closes and returns focus to the invoker, `ArrowDown`/`ArrowUp` move an `aria-activedescendant` cursor through `role="option"` rows, `Enter` invokes, focus is trapped while open. Tests assert every one of those, plus that a disabled command is `aria-disabled` and is not invoked by `Enter`.

`Composer` has three modes — `steer`, `answer`, `cancel` — each with its own label, its own submit affordance, and a `busy` state that disables submission without removing the control from the accessibility tree.

```bash
pnpm --filter @autostack/ui test -- pane-group.test.tsx command-palette.test.tsx composer.test.tsx
```

Expected failure: three missing modules.

- [ ] **Step 2: Implement the primitives**

Presentation only — no fetching, no contract imports beyond types, no state that outlives a mount. `InspectorSection` is a labelled `<section>` wrapping a `<dl>` with an explicit `"Not recorded"` rendering for absent values (this is the shape E2's usage tile uses, and it must be a first-class state, not an empty string).

- [ ] **Step 3: Style additively**

Append to `shell.css` using existing tokens only. Every focus style routes through the existing `:where(...):focus-visible` rule (`packages/ui/src/shell.css:14`); no new focus colour. Any transition uses `--as-duration-*`, which the reduced-motion block already zeroes.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/ui check
pnpm --filter @autostack/ui test:coverage
git add packages/ui/src packages/ui/test
git commit -m "feat(ui): add the workbench pane, palette, and composer primitives"
```

---

## Task 5: Run supervision panes over the contract payloads

**Files:**

- Create: `packages/client-app/src/panes/conversation-pane.tsx`
- Create: `packages/client-app/src/panes/plan-pane.tsx`
- Create: `packages/client-app/src/panes/terminal-pane.tsx`
- Create: `packages/client-app/src/panes/diff-pane.tsx`
- Create: `packages/client-app/src/panes/verification-pane.tsx`
- Create: `packages/client-app/src/panes/findings-pane.tsx`
- Create: `packages/client-app/src/run-supervision-source.ts`
- Test: `packages/client-app/test/panes.test.tsx`

- [ ] **Step 1: Write the failing pane tests**

Each pane is a pure function of a contract type. Real assertions, one per rule the contract already guarantees so the UI cannot contradict it:

- **Conversation** renders `AgentSessionStreamEvent[]` ordered by `sequence`, groups `message` / `thought_summary` / `tool_call` distinctly, renders `permission_requested` with its options and `permission_resolved` with the chosen option, and renders `interrupted` as a distinct, non-color-only state from `failed` (contract audit item 5). Test: an out-of-order input array still renders in `sequence` order.
- **Plan** renders `PlanDocument`: summary, ordered acceptance criteria, affected areas, risks by severity, verification commands, required permissions, required credential **refs** (IDs only — never a value). Test: a command with `usesShell: true` is rendered with a visible, labelled shell marker, because spec §14.4 requires that fact to be visible in the plan approval.
- **Terminal** renders `RunnerStreamEvent` output from the existing evidence stream, honours `terminal.truncated` as visible evidence rather than silent loss, and renders `stream.error` as terminal.
- **Diff** renders `file_change` events grouped by path with added/modified/deleted counts. Test: a path is rendered as text and never as markup.
- **Verification** renders `VerificationReport`: per-check command, status, exit code, duration. Test: a report with `status: "passed"` and a skipped **required** check is unrepresentable — the pane asserts the parse throws, proving the UI inherits `station-evidence.ts:173` rather than re-implementing it.
- **Findings** renders `ReviewReport` findings by severity with `location` when present. Test: a `changes_requested` verdict with a critical finding renders the verdict prominently; an `approved` verdict with a high finding is unrepresentable (`station-evidence.ts:237`).

```bash
pnpm --filter @autostack/client-app test -- panes.test.tsx
```

Expected failure: six missing modules.

- [ ] **Step 2: Define the `RunSupervisionSource` port**

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

One implementation ships in this stream: `createFixtureRunSupervisionSource(fixture)` in `src/testing/`, whose every return value is contract-`parse`d. The doc comment names E3 and the two candidate transports. **No stub returning `[]` in production code** — `App` takes the source as an optional prop and renders a named "run supervision data is not yet served by this build" state when it is absent.

- [ ] **Step 3: Implement the panes, then verify and commit**

```bash
pnpm --filter @autostack/client-app check
pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src/panes packages/client-app/src/run-supervision-source.ts packages/client-app/test/panes.test.tsx
git commit -m "feat(client-app): render the run supervision panes"
```

---

## Task 6: Right inspector — harness, route, environment, usage, provenance

**Files:**

- Create: `packages/client-app/src/inspector/run-inspector.tsx`
- Create: `packages/client-app/src/inspector/usage-summary.ts`
- Test: `packages/client-app/test/run-inspector.test.tsx`

- [ ] **Step 1: Write the failing inspector tests**

Five labelled sections (spec §4.1): **harness** from `AgentHarnessProfile` — capabilities the adapter does not declare render as visibly unavailable, never as absent (spec §9.1, audit item 1); **model route** from `ModelRouteSelection` plus any `ModelRouteFallback`, which renders the fallback's `failureCode` from the closed taxonomy (audit item 21); **environment** from `Environment` — branch, base commit, network policy, resource limits; **usage** from `ModelUsageRecord` where `tokens`/`cost` are `reported | unknown` discriminated unions, so `unknown` renders as **"Not recorded"** and never as `0`; **provenance** — source trigger from the work item's `SourceRef`, workflow version, adapter ID.

The load-bearing test: given a usage record with `{ kind: "unknown" }` cost, the rendered output contains "Not recorded" and does **not** contain "0" in the cost field. That is spec §10.2 made testable.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src/inspector packages/client-app/test/run-inspector.test.tsx
git commit -m "feat(client-app): show route, harness, and usage provenance in the inspector"
```

---

## Task 7: Persistent composer and command palette wiring

**Files:**

- Create: `packages/client-app/src/composer/run-composer.tsx`
- Create: `packages/client-app/src/commands/command-registry.ts`
- Modify: `packages/client-app/src/use-factory.ts` (add `steer`, `cancel`, `answerClarification`)
- Test: `packages/client-app/test/run-composer.test.tsx`, `packages/client-app/test/command-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

- Steering an active run calls `client.steerRun` once and reflects `accepted`.
- Cancelling requires a reason (`CancelRunRequestSchema` `min(1)`) and is a two-step confirm, because it is irreversible.
- Answering a `ClarificationRequest` sends the answer with an idempotency key; re-submitting the same answer does not send twice.
- An instruction containing credential material is rejected **before** the request leaves the client, with a visible error naming the field. This is the untrusted-input rule at the composer.
- The palette registry produces create / locate / open / cancel / retry / hand-off commands; a command that is not available for the current selection is present and `aria-disabled`, never silently missing.
- `Cmd/Ctrl+K` opens the palette from anywhere in the shell and `Escape` returns focus to the previously focused element.

```bash
pnpm --filter @autostack/client-app test -- run-composer.test.tsx command-registry.test.ts
```

Expected failure: two missing modules.

- [ ] **Step 2: Implement, verify, commit**

`useFactory` gains the three actions following its existing `createRun` shape exactly: abort the in-flight controller, set a busy flag, act, refresh, and translate a failure into a message on state rather than an unhandled rejection.

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src packages/client-app/test
git commit -m "feat(client-app): steer, answer, and cancel from the persistent composer"
```

---

## Task 8: Approval inbox with cursor paging and evidence digest display

**Files:**

- Create: `packages/client-app/src/approvals/approval-inbox.tsx`
- Create: `packages/client-app/src/approvals/use-approvals.ts`
- Test: `packages/client-app/test/approval-inbox.test.tsx`

- [ ] **Step 1: Write the failing inbox tests**

```ts
it("loads every pending approval past the first window", async () => {
  const server = createMockApiServer({ fixture: seedFactoryFixture({ approvalCount: 137 }) });
  render(<ApprovalInbox client={createApiClient({ baseUrl: "", getToken: () => TOKEN, fetch: server.fetch })} />);
  await screen.findByRole("button", { name: /load more approvals/i });
  fireEvent.click(screen.getByRole("button", { name: /load more approvals/i }));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(137));
  expect(screen.queryByRole("button", { name: /load more approvals/i })).toBeNull();
});
```

Plus: the digest is displayed truncated with the full value available to assistive technology; approving sends the displayed digest so a stale decision is detectable; a `version_conflict` response renders a "the evidence changed — review again" state and **does not** retry automatically (spec §14.2 material change re-requests approval); kind and status are shown with a text label and a shape cue, never colour alone; the filter offers every `ApprovalSchema.shape.status` member, sourced from the schema rather than a hand-written list.

- [ ] **Step 2: Implement `useApprovals`**

Cursor accumulation modelled on the existing `useFactory.loadMore` discipline: an `AbortController` per request, no double-fetch while one is in flight, de-duplication by `approvalId`, and a distinct `paginationMessage` for a failed page so one bad page does not blank the loaded list.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src/approvals packages/client-app/test/approval-inbox.test.tsx
git commit -m "feat(client-app): page the approval inbox and bind decisions to evidence"
```

---

## Task 9: Factory dashboard metrics, derived from events and proven against a fixture

**Files:**

- Create: `packages/client-app/src/metrics/derive-factory-metrics.ts`
- Create: `packages/client-app/src/metrics/types.ts`
- Create: `packages/client-app/src/dashboard/factory-dashboard.tsx`
- Test: `packages/client-app/test/derive-factory-metrics.test.ts`
- Test: `packages/client-app/test/factory-dashboard.test.tsx`

- [ ] **Step 1: Build the seeded event fixture with hand-computed expectations**

A hand-written, literal `StoredDomainEvent[]` — **not** generated by the same code under test — covering: 7 work items (3 github, 2 slack, 1 manual, 1 api), 7 runs whose transitions land 2 active, 1 waiting-on-approval, 1 blocked on clarification, 1 failed, 2 completed; 19 stage lease/succeed/fail triples across all six stages including one `implement` at `attempt: 3`; 4 approvals of which 3 are decided with known request→decide gaps; 5 `command.completed` events; 1 `publish` stage success. Every expected number is written in the test as a literal with the arithmetic shown in a comment.

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

Every metric and its exact event source — this is the whole §4.2 list, and each line is a test case:

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
| Tokens / cost         | **no event source — E2.** Returned as `{ kind: "unknown" }`, rendered "Not recorded" |

Rules the tests pin: an empty stream yields zeros, not `NaN`; an unmatched `stage.leased` (crash mid-stage) contributes to queue depth and to nothing else; a `run.transitioned` for a run with no `run.created` in the window is counted as partial rather than dropped silently; `windowComplete: false` marks every derived total as partial, mirroring the `partialMetrics` label convention already in `app.tsx:250`.

- [ ] **Step 3: Build the dashboard view**

Lifecycle strip Signal→Monitor with Document and Monitor rendered as **inactive future stages** (spec §4.2), metric cards through the existing `MetricCard`, and a visible "showing the loaded run window" note whenever `windowComplete` is false. Collection is bounded and honest: page `/v1/runs`, then page each run's `/v1/runs/:runId/events`; the note says so.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
git add packages/client-app/src/metrics packages/client-app/src/dashboard packages/client-app/test
git commit -m "feat(client-app): derive the control-room metrics from run events"
```

---

## Task 10: Assemble the workbench, the six destinations, and the failure states

**Files:**

- Modify: `packages/client-app/src/app.tsx`, `packages/client-app/src/app.css`, `packages/client-app/src/index.ts`
- Create: `packages/client-app/src/workbench/workbench.tsx`, `.../navigation.ts`
- Test: `packages/client-app/test/app.test.tsx` (extend), `packages/client-app/test/workbench.test.tsx`

- [ ] **Step 1: Write the failing navigation and failure-state tests**

Six destinations reachable by keyboard, `Automations` present and `aria-disabled` with a "future stage" description (spec §4.2). Failure states, each driven by the Task 1 `failures` injector and each asserted as a **named, actionable** state rather than a blank pane: control plane unreachable, 401 after the token expires, malformed response, approval decision conflict, run supervision source absent (E3), desktop operation unavailable (E1).

The existing 33 tests in `app.test.tsx` must keep passing unmodified — the workbench is an addition to the shell, not a replacement of it.

- [ ] **Step 2: Implement, verify, commit**

Keep `app.tsx` under the 400-line working ceiling by moving the run queue and manual-run form into `workbench/`; the exported `App` signature does not change, because `apps/web` and `apps/desktop/src/renderer` both construct it.

```bash
pnpm --filter @autostack/client-app check && pnpm --filter @autostack/client-app test:coverage
pnpm --filter @autostack/web check && pnpm --filter @autostack/web test
git add packages/client-app apps/web/src
git commit -m "feat(client-app): assemble the workbench across all six destinations"
```

---

## Task 11: `packages/observability` — correlation context and tracing

**Files:**

- Create: `packages/observability/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/observability/src/{index.ts,correlation.ts,attributes.ts,tracer.ts,exporter.ts}`
- Test: `packages/observability/test/{correlation.test.ts,attributes.test.ts,tracer.test.ts}`

**Dependency stance:** zero runtime dependencies beyond `@autostack/contracts`. "OpenTelemetry-compatible" here means the _shapes_ match the OTel data model — a 16-byte trace ID and 8-byte span ID as lowercase hex, `traceparent` W3C serialization, span kind, status, attributes, events, links, and OTel semantic-convention attribute names — so a real OTel exporter is a thin adapter in Wave 2. Pulling `@opentelemetry/*` into Wave 1 would add a lockfile-wide dependency for an integration this stream is explicitly not doing.

- [ ] **Step 1: Write the failing correlation tests**

W3C `traceparent` parse/serialize round-trip; a rejected malformed header (wrong version, wrong length, all-zero trace ID); child spans inherit the trace ID and record the parent span ID; `withCorrelation(context, fn)` restores the previous context after both a normal return and a throw; an injected ID factory makes every ID deterministic in tests.

```bash
pnpm --filter @autostack/observability test -- correlation.test.ts
```

Expected failure: the package does not exist (`No projects matched the filter`).

- [ ] **Step 2: Write the failing attribute-safety tests — the security core of this package**

```ts
it("refuses to attach an attribute whose value carries credential material", () => {
  expect(() => safeAttributes({ "http.url": `https://x/?token=ghp_${"a".repeat(36)}` }))
    .toThrow(/redact/i);
});
it("fails closed when a value cannot be serialized safely", () => {
  expect(() => safeAttributes({ payload: { toJSON() { throw new Error("nope"); } } as never })).toThrow();
});
it("redacts registered sensitive values rather than dropping the attribute", () => { ... });
it("truncates an oversized attribute value and marks it truncated", () => { ... });
```

Implementation reuses `containsSensitiveMaterial`, `redactSensitiveText`, and `normalizeSafeJson` from `@autostack/contracts` — the existing redaction machinery, not a second one.

- [ ] **Step 3: Implement the tracer with an injectable exporter and a no-op default**

`createTracer({ exporter = noopExporter, now, ids })` returns `startSpan(name, { kind, attributes, links })` with `setAttribute`, `addEvent`, `setStatus`, `recordException`, and `end`. Tests assert: a span that is never ended is never exported; ending twice exports once; an exporter that throws does not propagate into the traced code path (observability must never break the thing it observes) but is counted on a diagnostics channel; the no-op default allocates no span objects, proven by a counting exporter never being called.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/observability check
pnpm --filter @autostack/observability test:coverage
git add packages/observability pnpm-lock.yaml
git commit -m "feat(observability): trace with correlation identity and safe attributes"
```

---

## Task 12: Metrics and structured logs

**Files:**

- Create: `packages/observability/src/{metrics.ts,logger.ts}`
- Test: `packages/observability/test/{metrics.test.ts,logger.test.ts}`

- [ ] **Step 1: Write the failing tests**

Metrics: counter / up-down counter / histogram with the OTel instrument semantics; the §16.1 instrument set is registered by name (`autostack.run.count`, `autostack.stage.latency`, `autostack.queue.wait`, `autostack.approval.wait`, `autostack.stage.retries`, `autostack.model.success_rate`, `autostack.review.pass_rate`, `autostack.intervention.rate`, `autostack.tokens`, `autostack.cost`, `autostack.runner.provision`); a negative value on a plain counter throws; attribute sets go through the same `safeAttributes` gate; the no-op default records nothing.

Logger: every record carries `traceId`, `spanId`, `correlationId`, severity, timestamp, and safe attributes; a log call inside `withCorrelation` inherits the context without being passed it; a message containing credential material is redacted, not dropped, and the record is marked redacted; a sink that throws does not propagate.

- [ ] **Step 2: Implement, verify, commit**

```bash
pnpm --filter @autostack/observability check && pnpm --filter @autostack/observability test:coverage
git add packages/observability
git commit -m "feat(observability): record the operational metrics and structured logs"
```

---

## Task 13: One simulated full-pipeline trace, end to end

**Files:**

- Create: `packages/observability/test/pipeline-trace.test.ts`
- Create: `packages/observability/src/testing/{recording-exporter.ts,index.ts}`
- Modify: `packages/observability/package.json` (`./testing` export)

- [ ] **Step 1: Write the failing simulation**

Drive one correlation ID through the full §16.1 span set — ingress → workflow transition → agent session → model call → runner command → external API → artifact storage → notification — using `@autostack/domain/testing`'s fakes as the simulated participants so the shape of the pipeline is the real one, not one invented here.

Assertions:

```ts
expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
expect(spans.map((span) => span.name)).toEqual([...]);           // exact ordered set
expect(orphanSpans(spans)).toEqual([]);                          // every child names a real parent
expect(rootSpan.endTimeUnixNano).toBeGreaterThanOrEqual(maxChildEnd);
expect(JSON.stringify(spans)).not.toContain(SECRET);             // the credential planted in every layer
expect(JSON.stringify(logs)).not.toContain(SECRET);
expect(metrics.find((m) => m.name === "autostack.stage.latency")?.dataPoints).toHaveLength(6);
```

The planted secret goes into a model API key, a runner environment entry, an agent output line, and an external-API URL — all four paths, one assertion each.

- [ ] **Step 2: Implement the recording exporter, verify, commit**

```bash
pnpm --filter @autostack/observability check && pnpm --filter @autostack/observability test:coverage
git add packages/observability
git commit -m "test(observability): trace one simulated pipeline run end to end"
```

---

## Task 14: Desktop renderer composition

**Files:**

- Modify: `apps/desktop/src/renderer/main.tsx`
- Test: covered by `apps/desktop/test/` only where it already exists; the renderer's behavior is asserted in Task 15.

**Gated on E1** for the approval/composer surface. Everything else lands regardless.

- [ ] **Step 1: Compose the same client-app surface**

Wrap `App` in `ThemeProvider` with `window.localStorage` (the renderer already uses `window.sessionStorage` for the token, so no preload change is needed and none is proposed). Keep `executionAuthorityDisclosure`, keep `runtimeBridge={window.autostack}`, keep the CSP as it is.

- [ ] **Step 2: Verify the desktop package still builds and checks**

```bash
pnpm --filter @autostack/desktop rebuild:native
pnpm --filter @autostack/desktop check
pnpm --filter @autostack/desktop test
pnpm --filter @autostack/desktop build
git add apps/desktop/src/renderer/main.tsx
git commit -m "feat(desktop): compose the workbench in the sandboxed renderer"
```

If E1 has not landed by this point, the desktop workbench shows the approval and composer surfaces in their `ApiOperationUnavailableError` state, which is the honest rendering of the gap. Report it in the status message; do not work around it.

---

## Task 15: Playwright coverage and the accessibility assertions

**Files (pending the E4 ruling):**

- Create: `apps/desktop/e2e/fixtures/desktop-app.ts` (pure extraction of `launch` / `assertAccessible` / `attachScreenshot` / `quitAndWait` from `local-execution.spec.ts`)
- Create: `apps/desktop/e2e/workbench.spec.ts`
- Modify: `apps/desktop/playwright.config.ts` (`testMatch: /.*\.spec\.ts$/`)
- Modify: `apps/desktop/e2e/local-execution.spec.ts` (import the extracted helpers; **no assertion changes**)

- [ ] **Step 1: Extract the helpers without changing behavior**

```bash
pnpm --filter @autostack/desktop rebuild:native
pnpm --filter @autostack/desktop build
pnpm desktop:e2e
```

Expected: `local-execution.spec.ts` passes exactly as before. This step is a refactor with a green-to-green gate; if anything changes, revert and stop.

- [ ] **Step 2: Write the failing workbench spec**

Coverage, all against the launched Electron app:

- **Panes:** every pane in the group is reachable by `ArrowRight` from the tablist, each renders either its payload or its named empty state.
- **Approval inbox past 100:** the scenario seeds 137 approvals; the test loads the first window, clicks "Load more approvals", and asserts 137 distinct rows and the disappearance of the control. **Gated on E1** — until it lands, this half runs against `apps/web` per the E4 ruling, or asserts the unavailable state on desktop and the paging assertion lives in the Vitest suite.
- **Dashboard:** seeded events produce the hand-computed numbers from Task 9, read out of the DOM.
- **Failure states:** kill the host (the existing `__autostackVerifier.kill("host")` affordance) and assert the named degraded state, then recovery.
- **Accessibility:** `assertAccessible(page)` (axe, zero violations) at the default viewport, at a **granted** narrow viewport, in light and in dark.
- **Themes:** flip `data-theme` through the control and re-run axe in both, proving contrast holds in each.
- **Keyboard:** tab from the skip link through rail → sidebar → pane tabs → composer with no focus trap and no focus loss; `Cmd+K` opens and `Escape` closes the palette with focus restored.
- **Reduced motion:** `page.emulateMedia({ reducedMotion: "reduce" })` and assert the computed transition duration is `0s`.

**The Wave 0 lesson, applied.** CI's display work area is ~1024×745 and the window has `minWidth: 1024`, so a resize whose frame does not fit snaps width back to `minWidth` on macOS. The verifier bridge's `resize` clamps to the work area and returns the **granted** size. Every viewport assertion is written against the granted geometry:

```ts
const granted = await application.evaluate(() => globalThis.__autostackVerifier.resize(720, 900));
expect(granted).not.toBeNull();
expect(granted?.width).toBeLessThanOrEqual(720);
await expect.poll(async () => await page.evaluate(() => window.innerWidth)).toBe(granted?.width);
await assertAccessible(page);
```

Never `expect(window.innerWidth).toBe(720)`. Never assume a requested size was honoured.

- [ ] **Step 3: Run, fix, and commit**

```bash
pnpm --filter @autostack/desktop rebuild:native
pnpm --filter @autostack/desktop build
pnpm desktop:e2e
git add apps/desktop/e2e apps/desktop/playwright.config.ts
git commit -m "test(desktop-e2e): supervise the workbench, inbox, and dashboard"
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

Walk the full diff (`git diff codex/autostack-foundation...HEAD`) against this checklist and fix what it catches:

- No TODO, no placeholder, no disabled test, no `.skip`, no `any`, no `!` assertion.
- No `dangerouslySetInnerHTML`, anywhere.
- No file outside the ownership list is modified. `git diff --name-only` is the proof.
- Every mock response is contract-`parse`d; no fixture bypasses a schema.
- No secret, token, absolute path, or credential value in any rendered string, span attribute, log record, or test snapshot.
- Test output is pristine — no unhandled rejection warnings, no `act()` warnings, no console noise.
- Scope creep removed: every changed line traces to a charter requirement.

- [ ] **Step 3: Write the stream report and stop**

Write `.superpowers/sdd/stream-report.md` with per-task commits, coverage numbers per owned package, the E1–E4 outcomes, and anything Wave 2 must pick up. Return `MERGE_READY` with the SHA and a one-line test summary. **Do not push.**

---

## Verification matrix

| Charter exit criterion                      | Proven by                                                          |
| ------------------------------------------- | ------------------------------------------------------------------ |
| Workbench panes                             | Task 5 unit tests + Task 15 e2e pane traversal                     |
| Approval inbox, paging past 100 via cursor  | Task 1 mock (137 approvals), Task 2 client, Task 8 UI, Task 15 e2e |
| Dashboard numbers vs. seeded fixture        | Task 9 hand-computed literals + Task 15 DOM read-back              |
| Failure states                              | Task 1 `failures` injector + Task 10 tests + Task 15 host-kill     |
| Light/dark themes                           | Task 3 tests + Task 15 axe in both themes                          |
| Full keyboard navigation                    | Task 4 primitive tests + Task 7 palette + Task 15 tab traversal    |
| Reduced motion                              | Task 3 tokens + Task 15 computed-duration assertion                |
| Screen-reader labels                        | Every component test asserts by role and accessible name           |
| Non-color-only status                       | Existing `RunStatusBadge` cue + Task 8 kind/status cues            |
| Observability spans/metrics/logs, one trace | Task 13, with correlation intact and four planted secrets absent   |
| ≥80% coverage, all owned packages           | Task 16                                                            |

## Dependency ledger

| Task                 | Blocked on | Unblocking artifact                                   |
| -------------------- | ---------- | ----------------------------------------------------- |
| 14 (desktop half)    | E1         | four `DesktopApiOperationMap` operations + handler    |
| 9 (usage tile)       | E2         | `model.usage_recorded` in `EVENT_TYPES`, or "unknown" |
| 5, 6 (real data)     | E3         | an evidence/session transport ruling                  |
| 15                   | E4         | e2e file-ownership + `testMatch` ruling               |
| 8 (against real API) | S4 merge   | the four `/v1` routes; mock server until then         |

Tasks 1–13 and 16 are unblocked today.
