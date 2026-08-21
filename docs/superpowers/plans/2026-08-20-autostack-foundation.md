# AutoStack Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver AutoStack's first executable vertical slice: a strict TypeScript monorepo with versioned contracts, deterministic run-state rules, a WAL-backed SQLite event and job store, a restart-safe local executor, an authenticated loopback API, CLI diagnostics, and an original control-room web shell that can create and inspect durable manual runs.

**Architecture:** Contracts remain pure wire schemas. Domain code owns decisions and ports. SQLite implements the durable store without leaking into workflow code. The local executor consumes leased jobs through the domain port. Hono composes those layers and is the only backend reached by the CLI and web client. The baseline UI uses the shared AutoStack component package and does not access Node.js or the database.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9; pnpm 10; Turborepo 2; Zod 4; Node's `node:sqlite`; Hono 4; React 19; Vite 7; Vitest 4; Testing Library; tsup; Prettier.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md`

**Global Constraints:**

- Keep the scope to delivery-sequence subproject 1. Do not add Electron, host-daemon process execution, Git worktrees, agent adapters, model providers, GitHub, Slack, cloud runners, or hosted authentication.
- Keep `@autostack/contracts` and `@autostack/domain` free of Hono, React, SQLite, and vendor SDKs.
- Use strict TypeScript. No unchecked `any`, non-null assertions, or type assertions that bypass validation in contract or domain code.
- Represent commands as executable-plus-argument arrays. Do not introduce shell command strings.
- Persist only validated, structured payloads. Never persist or log the local API token.
- Bind the development server to `127.0.0.1` by default. Require bearer authentication for every endpoint except `/v1/health`.
- Use injected clocks and ID factories in tests. Use a fresh directory from `mktemp -d` or the test framework's temporary-directory helper for every SQLite test.
- Write each behavior test first, observe the stated failure, make the smallest implementation pass, run the package checks, and commit before continuing.
- Preserve user changes and do not reset or clean an existing checkout.
- The attached concept image informs density and lifecycle visibility only. Do not copy its assets, labels, layout measurements, or branding.

---

## Task 1: Establish the workspace and quality gates

**Files:**

- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `.prettierignore`
- Create: `.prettierrc.json`
- Create: `.nvmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Add the root workspace manifest**

Create `package.json` with this public command surface:

```json
{
  "name": "autostack",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.27.0",
  "engines": { "node": ">=24 <27" },
  "scripts": {
    "build": "turbo run build",
    "check": "turbo run check",
    "dev": "turbo run dev --parallel",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "turbo run test",
    "test:coverage": "turbo run test:coverage"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "@vitest/coverage-v8": "^4.1.1",
    "prettier": "^3.6.2",
    "tsup": "^8.5.0",
    "tsx": "^4.20.5",
    "turbo": "^2.5.6",
    "typescript": "^5.9.3",
    "vitest": "^4.1.1"
  }
}
```

- [ ] **Step 2: Define workspace and Turbo behavior**

Set `pnpm-workspace.yaml` packages to `apps/*` and `packages/*`. Configure `turbo.json` so `build` depends on upstream builds and emits `dist/**`; `check` depends on upstream checks; tests depend on upstream checks; and `dev` is uncached and persistent.

- [ ] **Step 3: Add strict shared TypeScript and Vitest settings**

`tsconfig.base.json` must enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: "Bundler"`, and `target: "ES2023"`.

`vitest.config.ts` must select `**/*.test.ts` and `**/*.test.tsx`, use the V8 provider, exclude generated and configuration files, and enforce 80% line, statement, function, and branch coverage.

- [ ] **Step 4: Add repository hygiene files**

Use Node 24 in `.nvmrc`. Ignore `node_modules`, `dist`, `coverage`, `.turbo`, `.env*`, `*.sqlite*`, and `autostack-data/`. Keep `.env.example` eligible for version control. Configure LF endings and a two-space default indentation in `.editorconfig`.

- [ ] **Step 5: Install and verify the empty workspace**

Run:

```bash
pnpm install
pnpm exec tsc --version
pnpm exec turbo --version
```

Expected: `pnpm-lock.yaml` is created, TypeScript reports 5.9.x, and Turbo reports 2.x.

- [ ] **Step 6: Commit the workspace**

```bash
git add .editorconfig .gitignore .prettierignore .prettierrc.json .nvmrc package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json vitest.config.ts
git commit -m "build: initialize AutoStack workspace"
```

---

## Task 2: Define versioned IDs, entities, events, and API schemas

**Files:**

- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/entities.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/api.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/ids.test.ts`
- Test: `packages/contracts/test/events.test.ts`
- Test: `packages/contracts/test/api.test.ts`

- [ ] **Step 1: Create the contracts package and failing ID tests**

Name the package `@autostack/contracts`; expose `./src/index.ts`; add `zod@^4.1.5` as its only runtime dependency, then run `pnpm install`. Test every prefix below, deterministic UUID injection, and rejection of an ID with the wrong prefix:

```ts
export const ID_PREFIX = {
  workspace: "ws",
  project: "prj",
  workItem: "wi",
  run: "run",
  stageRun: "stage",
  agentSession: "agt",
  environment: "env",
  approval: "apr",
  artifact: "art",
  automation: "aut",
  credentialRef: "cred",
  event: "evt",
  job: "job"
} as const;
```

Run `pnpm --filter @autostack/contracts test -- ids.test.ts`.

Expected failure: the test cannot import `../src/ids.js`.

- [ ] **Step 2: Implement branded ID schemas and factories**

Use a private `unique symbol` brand, one exported Zod schema per ID type, and this factory signature:

```ts
export function createId<K extends IdKind>(kind: K, uuid: string = randomUUID()): IdFor<K>;

export interface IdFactory {
  workspace(): WorkspaceId;
  project(): ProjectId;
  workItem(): WorkItemId;
  run(): RunId;
  stageRun(): StageRunId;
  agentSession(): AgentSessionId;
  environment(): EnvironmentId;
  approval(): ApprovalId;
  artifact(): ArtifactId;
  automation(): AutomationId;
  credentialRef(): CredentialRefId;
  event(): EventId;
  job(): JobId;
}

export function createIdFactory(random: () => string = randomUUID): IdFactory;
```

Validate the UUID before adding the prefix. Do not accept arbitrary strings through the factory.

- [ ] **Step 3: Add failing entity-schema tests**

Cover the implicit local workspace, a manual-source `WorkItem`, every `RunStatus`, an approval with a SHA-256 evidence digest, artifact metadata, and a `CredentialRef` containing metadata but no secret value.

The schemas must model `Workspace`, `Project`, `WorkItem`, `Run`, `StageRun`, `AgentSession`, `Environment`, `Approval`, `Artifact`, `Automation`, and `CredentialRef`. Use UTC ISO timestamps and `schemaVersion: 1` where an entity crosses a process boundary.

Run `pnpm --filter @autostack/contracts test -- entities`.

Expected failure: entity schemas are not exported.

- [ ] **Step 4: Implement the entity schemas**

Use this exact status vocabulary:

```ts
export const RunStatusSchema = z.enum([
  "queued",
  "triaging",
  "needs_clarification",
  "planning",
  "awaiting_plan_approval",
  "provisioning",
  "implementing",
  "verifying",
  "reviewing",
  "awaiting_publish_approval",
  "publishing",
  "completed",
  "waiting_for_user",
  "retry_scheduled",
  "cancelling",
  "cancelled",
  "failed"
]);
```

Keep harness identity, model route, and environment as separate optional references on `StageRun`.

Use `RunStageSchema` with `triage`, `plan`, `implement`, `verify`, `review`, and `publish` for executable workflow jobs. Use a separate `FactoryLaneSchema` with `signal`, `triage`, `plan`, `implement`, `validate`, `release`, `document`, and `monitor` for the stable control-room information architecture.

- [ ] **Step 5: Add failing event-envelope tests**

Test successful parsing and malformed-payload rejection for:

```text
work_item.created
run.created
run.transitioned
stage.queued
stage.leased
stage.succeeded
stage.failed
approval.requested
approval.decided
```

Test that a stored event requires `eventId`, stream kind/id/version, global sequence, schema version, actor, correlation ID, and timestamp. Test that a pending event omits store-assigned fields.

Run `pnpm --filter @autostack/contracts test -- events`.

Expected failure: event schemas are not exported.

- [ ] **Step 6: Implement discriminated event schemas**

Build `PendingDomainEventSchema` from validated context plus a discriminated `{ type, payload }` union. Extend it into `StoredDomainEventSchema`. The `actor` union must distinguish `user`, `system`, `agent`, and `integration`; do not store hidden reasoning or credentials in any payload.

- [ ] **Step 7: Add and implement the versioned HTTP schemas**

Define and test:

```ts
HealthResponseSchema;
CreateRunRequestSchema;
CreateRunResponseSchema;
RunSummarySchema;
ListRunsResponseSchema;
ListEventsResponseSchema;
ApiErrorSchema;
```

`CreateRunRequest` accepts a title, optional description, and optional manual acceptance context. The idempotency key is an HTTP header, not a body field. `HealthResponse` exposes service/version, storage state, and executor state but no filesystem path or token.

- [ ] **Step 8: Verify and commit contracts**

```bash
pnpm --filter @autostack/contracts check
pnpm --filter @autostack/contracts test:coverage
git add packages/contracts
git commit -m "feat(contracts): define AutoStack v1 schemas"
```

Expected: all contract tests pass and package coverage is at least 80%.

---

## Task 3: Implement deterministic domain decisions and persistence ports

**Files:**

- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/errors.ts`
- Create: `packages/domain/src/run-machine.ts`
- Create: `packages/domain/src/create-run.ts`
- Create: `packages/domain/src/approval.ts`
- Create: `packages/domain/src/projections.ts`
- Create: `packages/domain/src/ports/durable-store.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/test/run-machine.test.ts`
- Test: `packages/domain/test/create-run.test.ts`
- Test: `packages/domain/test/approval.test.ts`
- Test: `packages/domain/test/projections.test.ts`

- [ ] **Step 1: Create the package and failing run-state tests**

Name the package `@autostack/domain`, expose `./src/index.ts`, depend only on `@autostack/contracts: workspace:*`, and run `pnpm install`.

Test the main happy path, global waiting/retry/cancellation paths, resume-state enforcement, and rejection from terminal states. The declared happy path is:

```text
queued -> triaging -> planning -> awaiting_plan_approval
-> provisioning -> implementing -> verifying -> reviewing
-> awaiting_publish_approval -> publishing -> completed
```

`needs_clarification` may return only to `triaging`. `waiting_for_user` and `retry_scheduled` must carry a valid `resumeStatus`. `cancelling` may end only as `cancelled` or `failed`.

Run `pnpm --filter @autostack/domain test -- run-machine`.

Expected failure: `transitionRun` is missing.

- [ ] **Step 2: Implement the pure transition function**

Use this interface and return a validated event with the new immutable run value:

```ts
export interface TransitionRunCommand {
  readonly run: Run;
  readonly to: RunStatus;
  readonly reason: string;
  readonly resumeStatus?: RunStatus;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly occurredAt: string;
}

export function transitionRun(command: TransitionRunCommand): {
  readonly run: Run;
  readonly events: readonly PendingDomainEvent[];
};
```

Throw `InvalidRunTransitionError` with `from` and `to`; never silently coerce a transition.

- [ ] **Step 3: Test-drive manual run creation**

Test that `createManualRun` produces one `WorkItem`, one queued `Run`, and two stream appends sharing a correlation ID. Inject IDs and time so the expected objects are exact. A title containing only whitespace must fail validation.

Implement this dependency surface:

```ts
export interface CreateRunDependencies {
  readonly now: () => string;
  readonly ids: Pick<IdFactory, "workItem" | "run">;
}

export function createManualRun(
  input: CreateRunRequest,
  context: { workspaceId: WorkspaceId; actor: Actor; correlationId: string },
  dependencies: CreateRunDependencies
): CreateRunDecision;
```

- [ ] **Step 4: Test-drive approval digests and decisions**

Test canonical key ordering, identical digest for semantically identical evidence, stale digest rejection, idempotent repetition of the same decision, and conflict on a changed decision.

Implement SHA-256 over recursively key-sorted UTF-8 JSON. Expose `digestApprovalEvidence`, `requestApproval`, and `decideApproval`. Never hash a `JSON.stringify` result whose property order came directly from an external payload.

- [ ] **Step 5: Test-drive run projections**

Test that `projectRunSummaries(events)` rebuilds current status from ordered stored events, ignores unrelated streams, reports the latest global sequence, and throws `ProjectionOrderError` for duplicate or descending stream versions.

- [ ] **Step 6: Define the durable-store port**

Use this responsibility split:

```ts
export interface DurableStore {
  commit(request: CommitRequest): Promise<CommitResult>;
  readStream(request: ReadStreamRequest): Promise<readonly StoredDomainEvent[]>;
  readAll(request: ReadAllRequest): Promise<readonly StoredDomainEvent[]>;
  leaseNext(request: LeaseNextRequest): Promise<LeasedWorkflowJob | null>;
  heartbeat(request: HeartbeatRequest): Promise<void>;
  completeJob(request: CompleteJobRequest): Promise<CommitResult>;
  failJob(request: FailJobRequest): Promise<void>;
  health(): Promise<StoreHealth>;
  close(): Promise<void>;
}
```

`CommitRequest` contains an idempotency scope/key, one or more expected-version stream appends, and zero or more new jobs. `CompleteJobRequest` carries the lease token and commits resulting stream appends/new jobs in the same transaction that marks the leased job complete.

Define the core write types without persistence-specific fields:

```ts
export interface StreamAppend {
  readonly stream: { readonly kind: "work_item" | "run"; readonly id: string };
  readonly expectedVersion: number;
  readonly events: readonly PendingDomainEvent[];
}

export interface NewWorkflowJob {
  readonly jobId: JobId;
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly stage: RunStage;
  readonly handler: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
}

export interface CommitRequest {
  readonly idempotency: { readonly scope: string; readonly key: string };
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
}
```

- [ ] **Step 7: Verify and commit domain code**

```bash
pnpm --filter @autostack/domain check
pnpm --filter @autostack/domain test:coverage
git add packages/domain
git commit -m "feat(domain): add run decisions and durable ports"
```

---

## Task 4: Create and migrate the WAL-backed SQLite database

**Files:**

- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/database.ts`
- Create: `packages/db/src/migrations.ts`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/test/database.test.ts`

- [ ] **Step 1: Create the package and failing database test**

Name the package `@autostack/db`, expose `./src/index.ts`, depend on `@autostack/contracts` and `@autostack/domain` through `workspace:*`, and run `pnpm install`.

Use `node:sqlite` and no ORM. Open a file inside a test temporary directory, then assert:

- `PRAGMA journal_mode` is `wal`.
- `PRAGMA foreign_keys` is `1`.
- the schema version is `1`.
- reopening the same file does not re-run or duplicate a migration.

Run `pnpm --filter @autostack/db test -- database`.

Expected failure: `openDatabase` is missing.

- [ ] **Step 2: Implement connection configuration and migration locking**

`openDatabase({ filePath, busyTimeoutMs })` must create only the parent directory it is given, open `DatabaseSync`, set WAL, foreign keys, and busy timeout, then apply migrations inside `BEGIN IMMEDIATE`/`COMMIT` with rollback on error.

Do not derive a path from the user's home directory in this package.

- [ ] **Step 3: Add migration 1**

Create these tables and constraints:

```text
schema_migrations(version PRIMARY KEY, applied_at)
events(global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
       event_id UNIQUE, workspace_id, stream_kind, stream_id,
       stream_version, event_type, schema_version, occurred_at,
       actor_json, correlation_id, causation_id, payload_json,
       UNIQUE(stream_kind, stream_id, stream_version))
idempotency_records(scope, key, result_json, created_at,
                    PRIMARY KEY(scope, key))
workflow_jobs(job_id PRIMARY KEY, workspace_id, run_id, stage,
              handler, payload_json, status, attempt, max_attempts,
              available_at, lease_owner, lease_token, lease_expires_at,
              heartbeat_at, created_at, updated_at)
```

Add indexes for global event replay, per-workspace run events, runnable jobs, and expired leases. Restrict job status to `queued`, `leased`, `completed`, or `failed`.

- [ ] **Step 4: Verify rollback behavior**

Add a test-only migration with invalid SQL after one valid statement. Assert the version and valid statement are both absent after the failure.

- [ ] **Step 5: Verify and commit the database base**

```bash
pnpm --filter @autostack/db check
pnpm --filter @autostack/db test:coverage
git add packages/db
git commit -m "feat(db): add SQLite WAL schema and migrations"
```

---

## Task 5: Implement the atomic event store and durable job queue

**Files:**

- Create: `packages/db/src/codecs.ts`
- Create: `packages/db/src/sqlite-durable-store.ts`
- Update: `packages/db/src/index.ts`
- Test: `packages/db/test/sqlite-durable-store.test.ts`

- [ ] **Step 1: Add failing atomic-commit tests**

In one commit, append `work_item.created` and `run.created` to separate streams and enqueue a triage job. Assert sequential global IDs, independent stream version 1, and one queued job.

Repeat with the same idempotency scope/key. Assert the original result is returned with `replayed: true`, no new events exist, and no second job exists.

Run `pnpm --filter @autostack/db test -- sqlite-durable-store`.

Expected failure: `SqliteDurableStore` is missing.

- [ ] **Step 2: Implement validated row codecs**

Every JSON column must be parsed as `unknown` and then validated with the relevant Zod schema. Convert SQLite numbers with explicit safe-integer checks. Throw `CorruptStoreRecordError` containing the table and stable record ID, not the raw payload.

- [ ] **Step 3: Implement transactional commit**

Inside `BEGIN IMMEDIATE`:

1. Return a stored result when the idempotency record exists.
2. Check each stream's current version against `expectedVersion`.
3. Insert validated events and capture `lastInsertRowid` as `globalSequence`.
4. Insert validated jobs.
5. Persist the exact commit result under the idempotency scope/key.
6. Commit, or roll back and translate a version race to `OptimisticConcurrencyError`.

Inject `now` and `eventId` factories into the store constructor.

- [ ] **Step 4: Add failing replay and concurrency tests**

Cover `readStream` after a version, `readAll` after a global sequence, workspace filtering, limit clamping to 1–500, wrong expected version, and data surviving close/reopen.

- [ ] **Step 5: Implement event reads**

Always order stream reads by `stream_version` and global reads by `global_sequence`. Never rely on insertion order without an `ORDER BY`.

- [ ] **Step 6: Add failing lease tests**

Test FIFO leasing, future `availableAt`, unique lease token, heartbeat extension, rejection of the wrong lease token, expired-lease recovery, maximum-attempt failure, and transactional `completeJob` with output events plus a next-stage job.

- [ ] **Step 7: Implement leases and completion**

Use `BEGIN IMMEDIATE` for claim, completion, and failure. A recovered expired lease increments `attempt`. `completeJob` must verify `status = leased`, the lease token, and non-expired ownership before applying output. `failJob` either schedules the provided next availability or marks the job failed when attempts are exhausted.

- [ ] **Step 8: Verify and commit the store**

```bash
pnpm --filter @autostack/db check
pnpm --filter @autostack/db test:coverage
git add packages/db
git commit -m "feat(db): add atomic event and workflow store"
```

---

## Task 6: Build the restart-safe local workflow executor

**Files:**

- Create: `packages/workflow/package.json`
- Create: `packages/workflow/tsconfig.json`
- Create: `packages/workflow/src/errors.ts`
- Create: `packages/workflow/src/handler-registry.ts`
- Create: `packages/workflow/src/local-executor.ts`
- Create: `packages/workflow/src/index.ts`
- Test: `packages/workflow/test/handler-registry.test.ts`
- Test: `packages/workflow/test/local-executor.test.ts`

- [ ] **Step 1: Test-drive the typed handler registry**

Name the package `@autostack/workflow`, expose `./src/index.ts`, depend on `@autostack/contracts` and `@autostack/domain` through `workspace:*` plus `zod@^4.1.5`, and run `pnpm install`.

Register a handler by stable name plus a Zod input schema. Assert successful parsing, rejection before invocation for an invalid payload, and duplicate-name rejection.

Use this public contract:

```ts
export interface WorkflowHandlerContext {
  readonly job: LeasedWorkflowJob;
  readonly signal: AbortSignal;
}

export interface WorkflowHandlerResult {
  readonly appends: readonly StreamAppend[];
  readonly jobs: readonly NewWorkflowJob[];
}

export type WorkflowHandler<T> = (
  input: T,
  context: WorkflowHandlerContext
) => Promise<WorkflowHandlerResult>;
```

- [ ] **Step 2: Add failing single-cycle executor tests**

Test `runOnce()` returning `idle` with no work, completing one valid job atomically, converting `RetryableJobError` into a scheduled retry, converting other errors into a terminal failure when attempts are exhausted, and refusing to invoke an unregistered handler.

- [ ] **Step 3: Implement `runOnce`**

The constructor receives the durable store, registry, worker ID, clock, lease duration, retry calculator, and an error reporter. Do not import SQLite. Redact the caught error to `{ name, message, retryable }` before passing it to persistence or logs.

- [ ] **Step 4: Test-drive heartbeat and lifecycle behavior**

With fake timers, assert that `start()` polls without overlapping calls, a long handler heartbeats before half the lease expires, `stop()` prevents another lease, and an abort waits for the current handler to settle before resolving.

- [ ] **Step 5: Implement executor lifecycle**

Use one timer chain rather than `setInterval`, so a slow cycle cannot overlap the next. Keep the executor state as `stopped`, `idle`, or `working`; expose it through `getStatus()` for health reporting.

- [ ] **Step 6: Verify and commit workflow code**

```bash
pnpm --filter @autostack/workflow check
pnpm --filter @autostack/workflow test:coverage
git add packages/workflow
git commit -m "feat(workflow): add durable local executor"
```

---

## Task 7: Expose an authenticated loopback control-plane API

**Files:**

- Create: `apps/control-plane/package.json`
- Create: `apps/control-plane/tsconfig.json`
- Create: `apps/control-plane/src/auth.ts`
- Create: `apps/control-plane/src/config.ts`
- Create: `apps/control-plane/src/run-service.ts`
- Create: `apps/control-plane/src/app.ts`
- Create: `apps/control-plane/src/server.ts`
- Test: `apps/control-plane/test/auth.test.ts`
- Test: `apps/control-plane/test/app.test.ts`

- [ ] **Step 1: Create the app package and failing auth tests**

Name the app `@autostack/control-plane`. Add the four internal packages through `workspace:*`, `hono@^4.9.6`, and `@hono/node-server@^1.19.1`, then run `pnpm install`.

Use Hono and `@hono/node-server`. Test that health is public, run routes require `Authorization: Bearer <token>`, malformed and wrong tokens return the same 401 body, and token values never appear in errors.

Compare token bytes with `timingSafeEqual` after checking equal buffer lengths.

- [ ] **Step 2: Implement safe local configuration**

Accept `AUTOSTACK_DATA_DIR`, `AUTOSTACK_LOCAL_API_TOKEN`, `AUTOSTACK_HOST`, and `AUTOSTACK_PORT`. Default host to `127.0.0.1`; reject a non-loopback host unless `AUTOSTACK_ALLOW_NON_LOOPBACK=true` is explicitly set. Require a minimum 32-byte token for this foundation server. Tests inject config and never mutate the user's profile.

- [ ] **Step 3: Add failing health-route tests**

Assert this shape through `HealthResponseSchema`:

```json
{
  "service": "autostack-control-plane",
  "version": "0.1.0",
  "status": "ok",
  "storage": { "status": "ok", "journalMode": "wal", "schemaVersion": 1 },
  "executor": { "status": "idle" }
}
```

Return 503 with `status: "degraded"` when store health fails.

- [ ] **Step 4: Add failing create/list/event route tests**

Cover:

- `POST /v1/runs` requires a valid `Idempotency-Key` header and body.
- first creation returns 201; exact replay returns 200 with `replayed: true`.
- the response validates against `CreateRunResponseSchema`.
- `GET /v1/runs` returns projected summaries newest first.
- `GET /v1/runs/:runId/events?after=0` returns only that stream's ordered events.
- malformed input returns `ApiErrorSchema` with a stable code and no stack trace.

- [ ] **Step 5: Implement the run service and routes**

The route calls `createManualRun`, then one `DurableStore.commit`. Use the idempotency scope `api:create-run:<workspaceId>`. The implicit workspace ID is created once by composition and injected. Do not let the client choose a workspace or actor ID in this milestone.

Use stable error codes: `unauthorized`, `invalid_request`, `missing_idempotency_key`, `run_not_found`, `version_conflict`, and `internal_error`.

- [ ] **Step 6: Compose and build the server**

`server.ts` opens `${AUTOSTACK_DATA_DIR}/autostack.sqlite`, constructs the store and executor, binds to the configured loopback address, handles `SIGINT`/`SIGTERM`, stops the executor, and closes SQLite before exiting.

The package scripts must include:

```json
{
  "dev": "tsx watch src/server.ts",
  "build": "tsup src/server.ts --format esm --platform node --sourcemap --clean --no-external @autostack/contracts --no-external @autostack/domain --no-external @autostack/db --no-external @autostack/workflow",
  "start": "node dist/server.js",
  "check": "tsc -p tsconfig.json --noEmit",
  "test": "vitest run",
  "test:coverage": "vitest run --coverage"
}
```

- [ ] **Step 7: Verify and commit the control plane**

```bash
pnpm --filter @autostack/control-plane check
pnpm --filter @autostack/control-plane test:coverage
pnpm --filter @autostack/control-plane build
git add apps/control-plane
git commit -m "feat(control-plane): expose local run API"
```

---

## Task 8: Add scriptable CLI diagnostics

**Files:**

- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/http-client.ts`
- Create: `apps/cli/src/doctor.ts`
- Create: `apps/cli/src/main.ts`
- Test: `apps/cli/test/doctor.test.ts`
- Test: `apps/cli/test/main.test.ts`

- [ ] **Step 1: Add failing doctor tests**

Name the app `@autostack/cli`, add `@autostack/contracts: workspace:*`, and run `pnpm install`.

Inject `fetch`, stdout, and stderr. Cover healthy, degraded, unauthorized, connection-refused, invalid JSON, `--json`, and help output. Assert the token never appears in output.

Exit codes are stable:

```text
0 healthy
1 usage error
2 authentication error
3 control plane unavailable or degraded
```

- [ ] **Step 2: Implement the typed HTTP client**

Validate every response through contracts. Convert network and schema failures into named CLI errors. The client accepts `{ baseUrl, token, fetch }` and sets the bearer header only for authenticated calls.

- [ ] **Step 3: Implement argument parsing and doctor output**

Use `node:util.parseArgs`; do not add a CLI framework. Support:

```text
autostack doctor [--url http://127.0.0.1:4318] [--token <value>] [--json]
autostack --help
autostack --version
```

Read `AUTOSTACK_URL` and `AUTOSTACK_LOCAL_API_TOKEN` when flags are absent. Human output must identify API, storage, schema, and executor states. JSON output must be exactly one JSON object on stdout.

- [ ] **Step 4: Configure the executable build**

Set `bin.autostack` to `dist/main.js`; add a Node shebang through tsup's banner option; and bundle internal workspace packages.

- [ ] **Step 5: Verify and commit the CLI**

```bash
pnpm --filter @autostack/cli check
pnpm --filter @autostack/cli test:coverage
pnpm --filter @autostack/cli build
node apps/cli/dist/main.js --help
git add apps/cli
git commit -m "feat(cli): add AutoStack doctor command"
```

---

## Task 9: Create the AutoStack visual system and shell components

**Files:**

- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/src/tokens.css`
- Create: `packages/ui/src/shell.css`
- Create: `packages/ui/src/app-shell.tsx`
- Create: `packages/ui/src/lifecycle-strip.tsx`
- Create: `packages/ui/src/metric-card.tsx`
- Create: `packages/ui/src/run-status-badge.tsx`
- Create: `packages/ui/src/index.ts`
- Test: `packages/ui/test/app-shell.test.tsx`
- Test: `packages/ui/test/run-status-badge.test.tsx`

- [ ] **Step 1: Add failing semantic component tests**

Name the package `@autostack/ui`. Add `react@^19.1.1` as a peer dependency and dev dependency, then add `@testing-library/jest-dom@^6.8.0`, `@testing-library/react@^16.3.0`, `@types/react@^19.1.10`, and `jsdom@^26.1.0` as dev dependencies. Expose the component entry point and both CSS files; run `pnpm install`.

Use Testing Library with jsdom. Assert:

- navigation exposes Factory, Projects, Automations, Approvals, Integrations, and Settings.
- the active destination uses `aria-current="page"`.
- lifecycle stages are an ordered list with text labels.
- every run status has visible text, an icon or shape cue, and an accessible label.
- the shell provides skip navigation and named main/aside landmarks.

- [ ] **Step 2: Implement design tokens**

Create an original AutoStack system with graphite surfaces, warm signal orange, cool success mint, visible focus blue, system sans for reading, and system mono for operational data. Define light/dark variables, spacing, type scale, radii, borders, motion duration, and `prefers-reduced-motion` overrides.

Do not import a font or image from the reference products.

- [ ] **Step 3: Implement shell primitives**

The public component signatures are:

```ts
export interface AppShellProps {
  readonly activeDestination: NavigationDestination;
  readonly sidebar: ReactNode;
  readonly inspector?: ReactNode;
  readonly children: ReactNode;
}

export interface LifecycleStripProps {
  readonly stages: readonly LifecycleStageView[];
}

export interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: "neutral" | "good" | "attention";
}
```

Use CSS Grid to collapse the inspector below 1180px and the project sidebar below 820px. Keep keyboard focus visible on every interactive element.

- [ ] **Step 4: Verify and commit UI primitives**

```bash
pnpm --filter @autostack/ui check
pnpm --filter @autostack/ui test:coverage
git add packages/ui
git commit -m "feat(ui): add AutoStack control-room primitives"
```

---

## Task 10: Build the baseline factory web application

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/api-client.ts`
- Create: `apps/web/src/use-factory.ts`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/app.css`
- Test: `apps/web/test/api-client.test.ts`
- Test: `apps/web/test/app.test.tsx`

- [ ] **Step 1: Add failing API-client tests**

Name the app `@autostack/web`. Add `@autostack/contracts` and `@autostack/ui` through `workspace:*`, `react@^19.1.1`, and `react-dom@^19.1.1`; add Vite 7, the React Vite plugin, React type packages, Testing Library, and jsdom as development dependencies. Run `pnpm install`.

Test validated health, authenticated run listing, creation with a generated idempotency key, auth rejection, malformed server data, and abort propagation. The token provider is a function so the Electron preload can replace session storage later.

Use this surface:

```ts
export interface AutoStackApiClient {
  health(signal?: AbortSignal): Promise<HealthResponse>;
  listRuns(signal?: AbortSignal): Promise<ListRunsResponse>;
  createRun(input: CreateRunRequest, signal?: AbortSignal): Promise<CreateRunResponse>;
}

export function createApiClient(options: {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly fetch?: typeof globalThis.fetch;
}): AutoStackApiClient;
```

- [ ] **Step 2: Implement the API client**

Use relative `/v1` URLs by default, validate all response bodies, and attach a fresh UUID `Idempotency-Key` for create-run. Never put the token in a query string or error message.

- [ ] **Step 3: Add failing application tests**

Render with a fake client and cover:

- product name and eight lifecycle stages.
- health, active/waiting/failed/completed metrics derived from runs.
- explicit disconnected state when no token exists.
- connection form stores the token in `sessionStorage`, never `localStorage`.
- durable run list with title, source, current state, and last update.
- manual-run form submits title/description and displays the created run.
- loading, empty, API failure, and retry states.

- [ ] **Step 4: Implement the factory page**

The first screen uses the shared shell with:

- navigation rail.
- project/run list at left.
- lifecycle strip and four metric cards at top.
- active-run queue in the main surface.
- compact inspector with source, event sequence, and timestamps.
- a modal or drawer for manual run creation.

Poll every five seconds only while the page is visible. Cancel the previous request before a new poll. Do not add charting or state-management libraries.

- [ ] **Step 5: Configure Vite and production build**

Proxy `/v1` to `http://127.0.0.1:4318` in development. Bind Vite itself to `127.0.0.1`. Package scripts provide `dev`, `build`, `check`, `test`, and `test:coverage`.

- [ ] **Step 6: Verify responsive and accessible behavior**

Run:

```bash
pnpm --filter @autostack/web check
pnpm --filter @autostack/web test:coverage
pnpm --filter @autostack/web build
```

Expected: checks and tests pass; Vite produces `apps/web/dist`; no build-time token appears in the generated assets.

- [ ] **Step 7: Commit the web application**

```bash
git add apps/web
git commit -m "feat(web): add AutoStack factory shell"
```

---

## Task 11: Prove restart durability and document the foundation

**Files:**

- Create: `apps/control-plane/test/foundation-flow.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.env.example`
- Create: `README.md`
- Create: `docs/development/foundation.md`

- [ ] **Step 1: Add a failing restart integration test**

Exercise the full non-network service boundary:

1. start app/store A against a temporary SQLite file.
2. create a manual run through `app.request`.
3. close store A.
4. start app/store B against the same file.
5. list runs and replay the created run's events.
6. repeat the original create command with the same idempotency key.
7. assert one run, unchanged event count, original IDs, and `replayed: true`.

Expected failure before final wiring: restart composition or idempotent response behavior is incomplete.

- [ ] **Step 2: Complete composition until the restart test passes**

Keep test-only factories outside production modules. Ensure shutdown is idempotent and no open handle remains after Vitest exits.

- [ ] **Step 3: Add CI**

Use GitHub Actions on pull requests and pushes to `main`, Node 24, pnpm 10 with Corepack, and dependency caching. Run in this order:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm check
pnpm test:coverage
pnpm build
```

Upload coverage only as a workflow artifact; do not require an external service.

- [ ] **Step 4: Document exact local operation**

`.env.example` contains names and safe descriptions, never a usable credential. `README.md` describes AutoStack, current foundation scope, repository map, and quick start. `docs/development/foundation.md` documents:

- generating a 32-byte local token.
- starting control plane and web app.
- running `autostack doctor`.
- creating a manual run with a curl example.
- the SQLite location selected through `AUTOSTACK_DATA_DIR`.
- event/idempotency/lease invariants.
- the boundary of the next local-execution subproject.

- [ ] **Step 5: Run the complete verification matrix**

```bash
pnpm format
pnpm format:check
pnpm check
pnpm test:coverage
pnpm build
git status --short
```

Expected: every command passes; coverage thresholds pass; only the intended foundation files are modified.

- [ ] **Step 6: Manually smoke-test the vertical slice**

Use a temporary data directory and an explicit development token:

```bash
AUTOSTACK_DATA_DIR=/tmp/autostack-foundation-smoke \
AUTOSTACK_LOCAL_API_TOKEN=0123456789abcdef0123456789abcdef \
pnpm --filter @autostack/control-plane dev
```

In a second terminal, run the built CLI against port 4318, launch the web app, connect with the same development token, create one run, restart the control plane, and confirm the run remains visible. Remove only `/tmp/autostack-foundation-smoke` after verifying its exact path.

- [ ] **Step 7: Commit the verified foundation**

```bash
git add .env.example .github README.md docs apps/control-plane/test/foundation-flow.test.ts pnpm-lock.yaml
git commit -m "test: verify AutoStack foundation durability"
```

---

## Foundation completion gate

The subproject is complete only when all statements below are demonstrated:

- [ ] `pnpm install --frozen-lockfile`, formatting, type checks, tests with coverage, and all builds pass on Node 24.
- [ ] Contracts reject unknown event types, malformed IDs, invalid states, and secret-bearing credential payloads.
- [ ] Invalid run transitions and stale approval evidence fail closed.
- [ ] One SQLite transaction can atomically commit multiple streams and queued work.
- [ ] Idempotent replay returns original IDs and creates no duplicate event or job.
- [ ] Expired work is recoverable; wrong or stale lease tokens cannot complete it.
- [ ] Restarting the control plane preserves and replays a manually created run.
- [ ] Every non-health API route requires the local bearer token, and the token is absent from logs, errors, events, and web build assets.
- [ ] CLI doctor reports healthy, degraded, authentication, and unavailable states with stable exit codes.
- [ ] The web shell is usable with keyboard and screen reader semantics at desktop and narrow widths, creates a manual run, and renders durable run state from the API.
- [ ] No code from BB, Factory, Warp, or Eve has been copied into this foundation.
- [ ] The implementation is reviewed before beginning subproject 2.
