# AutoStack Local Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver AutoStack's second executable vertical slice: a secure Electron desktop shell that supervises the loopback control plane and an authenticated host daemon, provisions AutoStack-managed Git worktrees, executes approved executable-plus-argument commands in supervised PTYs, streams normalized terminal events, retains content-addressed evidence, and passes one common local-runner conformance suite without modifying the user's checkout.

**Architecture:** The control plane remains the product-authorization boundary. Before writable work it verifies a non-stale approval over a canonical scope that excludes approval/authentication metadata, then records an immutable environment authorization or per-command authorization. Environment authorization binds the repository, base commit, branch, limits, network policy, filesystem disclosure, and credential ceiling; each command authorization narrows that scope and binds one exact command. The local implementation lives behind a host-daemon utility process on loopback; per-command Electron-as-Node guardians own PTYs, drain output into durable spools, and terminate their process groups when host IPC closes. Electron main owns child supervision and OS-backed credential protection. The renderer receives a narrow typed operation bridge and opaque repository capabilities; it never sees tokens, Node APIs, child-process handles, raw paths, or arbitrary IPC. Worktree and command phases are idempotent by AutoStack ID. Terminal bytes remain in bounded host-owned replay/artifact storage while durable domain events retain safe intent and evidence metadata.

**Tech Stack:** Node.js 24 LTS; TypeScript 5.9; pnpm 10; Turborepo 2; Zod 4; Hono 4; Electron 43; electron-vite 5; node-pty 1.1; React 19; Vitest 4; Playwright; Git CLI.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md`, especially sections 5, 7, 11, 14, 15, 17, 18, and delivery-sequence subproject 2.

**Global Constraints:**

- Keep scope to delivery-sequence subproject 2. Do not add coding-agent adapters, model providers, GitHub/Slack integrations, full pipeline stages, cloud runners, hosted authentication, or team persistence.
- Preserve all foundation contracts and review hardening. Do not weaken secret scanning, request limits, default-deny authentication, durable workspace identity, event coherence, or coverage gates.
- The control plane decides product authorization; the runner only validates and enforces immutable recorded authorizations. Prepare and start require matching non-stale approval evidence; subsequent owned read/cancel/dispose operations remain available after expiry so commands and evidence cannot be stranded. A host-daemon request can never broaden its repository, command, cwd, credential, limit, or network scope.
- Represent every process invocation as `executable` plus `args`. Never accept a shell command string or invoke `exec`, `execSync`, `spawn(..., { shell: true })`, `/bin/sh -c`, or equivalent.
- Confine AutoStack's own filesystem operations to a private data root or a specifically inspected source repository. Resolve real paths, reject traversal and symlink escapes, and never reset, clean, stash, switch, or write into the user's checkout. Do not describe cwd/path checks as a child-process sandbox: local commands run with the desktop user's host filesystem authority, and the approval evidence and capability UI must say so.
- Create product branches only under `autostack/`. Use `git worktree add --lock`; cleanup is explicit, refuses dirty worktrees, and never uses `--force` in the normal path.
- The host daemon binds only to numeric loopback `127.0.0.1` on an ephemeral port and authenticates every route with an ephemeral launch secret. It has no generic shell, filesystem, or OS endpoint. Local runner routes are registered only in explicit local mode and do not exist in hosted mode.
- The desktop renderer uses `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. Its preload bridge exposes named, validated operations—not `ipcRenderer`, arbitrary channels, raw HTTP headers, secrets, filesystem paths, or process APIs.
- The per-install control-plane secret is generated with a cryptographically secure source and encrypted with Electron `safeStorage` in the main process. Tests use an injected protector; production fails closed when OS protection is unavailable.
- Terminal output passes through a stateful streaming redactor with a bounded withheld tail so split and ANSI-interleaved secrets cannot leak. Final artifacts are scanned again before publication. Truncation/overflow and slow-subscriber disconnection are explicit resumable evidence, not silent loss.
- The command supervisor, never an HTTP or renderer subscriber, is the sole PTY consumer. It drains into a bounded, fsynced replay spool; every subscriber has an independent cursor and bounded queue. Disconnecting or falling behind never cancels or blocks the command. Subscriber lag is a transport-local condition with a resume cursor, never a durable command event.
- Run `node-pty` only in Electron-ABI Electron-as-Node guardian processes. Node-based unit tests use an injected fake PTY; the real PTY smoke launches the built main/renderer bundles with the workspace Electron executable and an external staged native directory. ASAR/application packaging, signing, and notarization remain deferred. Do not rebuild one shared native module back and forth between standalone Node and Electron ABIs.
- Use injected clocks, ID factories, process launchers, PTY factories, and temporary directories in tests. Integration tests may create fresh disposable Git repositories; never point tests at the AutoStack source checkout.
- Write every behavior test first, observe the stated failure, make the smallest implementation pass, run package checks, and commit the task. The controller then performs task-scoped spec and quality review (plus security review for privileged boundaries) before dispatching the next task.
- No placeholders, TODO implementations, disabled tests, unchecked `any`, non-null assertions, or assertions that bypass validation in contract/domain/security boundaries.

---

## Task 1: Define versioned runner, command, stream, and host contracts

**Files:**

- Modify: `packages/contracts/src/ids.ts`
- Modify: `packages/contracts/src/entities.ts`
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/runner.ts`
- Create: `packages/contracts/src/host-api.ts`
- Create: `packages/contracts/src/desktop-api.ts`
- Test: `packages/contracts/test/runner.test.ts`
- Test: `packages/contracts/test/host-api.test.ts`
- Test: `packages/contracts/test/events.test.ts`

- [ ] **Step 1: Add failing ID and command-schema tests**

Add branded `command`, `environmentAuthorization`, `commandAuthorization`, and renderer-only opaque `repositoryCapability` IDs with prefixes `cmd`, `envauth`, `cmdauth`, and `repocap`. Test deterministic factories and rejection of wrong prefixes.

Specify and test these strict wire schemas:

```ts
export const CommandSpecSchema = z
  .object({
    executable: z.string().trim().min(1).max(1_024),
    args: z.array(z.string().max(8_192)).max(256),
    cwd: RelativeWorkspacePathSchema.default("."),
    environment: z.array(CommandEnvironmentEntrySchema).max(128),
    timeoutSeconds: z.number().int().min(1).max(14_400),
    terminal: z
      .object({
        columns: z.number().int().min(20).max(500),
        rows: z.number().int().min(5).max(300)
      })
      .strict()
  })
  .strict();
```

`RelativeWorkspacePathSchema` permits `.` only as the workspace root and otherwise rejects absolute paths, empty segments, embedded `.`/`..` segments, NUL bytes, and platform separator tricks. Environment entries are discriminated as `literal` or `credential_ref`; literal values pass the shared secret scanner and credential entries contain only a `CredentialRefId`.

Define `NetworkPolicySchema` exactly as `host | none | restricted`. The local provider advertises and accepts only `host`; the other versioned values exist for future sandbox-backed providers and must fail with `unsupported_policy` locally.

Run:

```bash
pnpm --filter @autostack/contracts test -- runner.test.ts
```

Expected failure: runner schemas and the `command` ID factory do not exist.

- [ ] **Step 2: Implement the runner request/response schemas**

Add strict schemas and inferred types for:

- `RunnerCapabilities` with runner ID/version, `darwin`/`arm64` platform facts, PTY support, cancellation support, maximum live-output/replay/transcript/artifact byte limits, supported network-policy values, and explicit `hard | advisory | unavailable` enforcement for CPU, memory, duration, AutoStack path operations, child filesystem access, and network controls.
- `InspectRepositoryRequest` and `RepositoryInspection`, including canonical source path, repository common directory, remote identity when available, resolved base ref, exact 40-character source commit, current checkout dirty state, and diagnostics.
- `ExecutionScope`, a canonical value containing workspace/run ownership, repository identity, exact base commit, generated branch, allowed workspace cwd root, resource limits, `host` network policy, host-user filesystem disclosure, and allowed credential-reference IDs. It explicitly excludes approval IDs/evidence and authorization IDs/digests. `approval.evidenceDigest` is exactly `digest(ExecutionScope)`.
- `EnvironmentAuthorization`, which includes its own ID/digest, approval ID/evidence digest, the exact `ExecutionScope`, creation time, and expiry. Its digest covers the authorization record without a self-referential digest field.
- `CommandScope`, a canonical value containing the environment-authorization ID/digest, workspace/run/environment/command IDs, action `implement | verify`, exact `CommandSpec` digest, and the effective repository/branch/cwd/network/filesystem scope plus narrowed limits/credential references. It excludes approval ID/evidence and the command-authorization ID/digest. `approval.evidenceDigest` for a command is exactly `digest(CommandScope)`.
- `CommandAuthorization`, which includes its own ID/digest, approval ID/evidence digest, the exact `CommandScope`, creation time, and expiry. Its digest covers the record without a self-referential digest field; every effective repository/branch/cwd/network/filesystem field must equal the referenced environment authorization and every limit/credential field must equal or narrow it.
- `PrepareEnvironmentRequest`, which includes workspace/run/environment IDs, inspected repository identity, exact base commit, requested `autostack/` branch, and the complete `EnvironmentAuthorization`. The runner canonicalizes/validates its digest and journals the full safe record before Git mutation.
- `StartCommandRequest`, which includes command/environment/run IDs, the exact `CommandSpec`, and the complete `CommandAuthorization` referencing the environment authorization journaled during prepare. The runner canonicalizes/validates its digest and scope, rejects any mismatch or broadening, and journals the full safe record before spawn. `CommandAccepted` is an acknowledgement, not a terminal stream.
- `ReadCommandEventsRequest`, `CancelCommandRequest`, bounded `ReadArtifactChunkRequest`/response (offset plus at most 1 MiB, next offset, done, full digest/size metadata), `DisposeEnvironmentRequest` carrying control-plane-verified terminal run evidence (`completed | cancelled | failed`, terminal event sequence/digest), `ListEnvironmentsResponse`, and idempotent result envelopes.
- `RunnerStreamEvent` as a discriminated union of `command.started`, `terminal.output`, `terminal.truncated`, `artifact.created`, `command.completed`, and terminal `stream.error`. Every event carries a monotonically increasing per-command sequence and timestamp. A PTY event always uses stream `pty`. Completion records exit code/signal, duration, cancellation/interruption flags, and transcript artifact metadata. Durable `stream.error` is reserved for a command-wide protocol failure.
- `RunnerSubscriptionItem` as an implementation-neutral union of `runner.event` carrying one `RunnerStreamEvent` and `subscription.lagged` carrying the subscriber's last durable sequence/resume cursor. A lagged item terminates only that subscription and never enters the durable command sequence. `HostCommandEventFrame` is the wire schema for the same union.
- `GuardianLaunchDescriptor`, used only across the trusted Electron-main/host bootstrap channel, containing the canonical workspace Electron executable, built guardian module, external staged Electron-ABI native directory, desktop build root, runtime-manifest digest, and Electron/node-pty versions. These internal absolute paths are forbidden from renderer/control-plane operations.
- Renderer-safe `DesktopApiOperationMap`, repository-picker request/response, command subscription, bounded artifact-chunk reads, and runtime-status schemas. Request discriminators map statically to response types; no contract accepts an arbitrary URL, method, header, IPC channel, or local path.

Do not put a bearer token, credential value, arbitrary environment map, or shell string in any schema. Absolute runtime paths exist only in `GuardianLaunchDescriptor`, which is never exported through the desktop operation map or public HTTP API.

- [ ] **Step 3: Add host-daemon API contracts**

Define versioned request/response schemas for exactly these routes:

```text
GET    /v1/health
GET    /v1/environments
POST   /v1/repositories/inspect
POST   /v1/environments
POST   /v1/environments/:environmentId/commands
GET    /v1/environments/:environmentId/commands/:commandId/events?after=<sequence>
POST   /v1/environments/:environmentId/commands/:commandId/cancel
GET    /v1/artifacts/:artifactId/content
DELETE /v1/environments/:environmentId
```

Command start returns `202 CommandAccepted`. The events endpoint uses `application/x-ndjson`; each line parses as one `HostCommandEventFrame`. `runner.event` frames contain a durable stream with exactly one terminal completion or command-wide `stream.error`; `subscription.lagged` ends only that follower and supplies its resume cursor. `after` is a resumable per-command sequence. Artifact content is authenticated, bounded, content-addressed, digest/size verified, and supports only validated single byte ranges. Errors use the shared API error shape and stable host error codes.

- [ ] **Step 4: Add durable evidence events**

Extend the domain event vocabulary with:

- `environment.authorization_recorded`
- `command.authorization_recorded`
- `environment.prepare_requested`
- `environment.prepared`
- `command.intent_recorded`
- `command.started`
- `command.completed`
- `artifact.recorded`
- `environment.disposed`

Persist the complete canonical safe authorization records and artifact descriptors, not terminal chunks or credential values. An authorization record is durable before its environment/command intent; an environment intent is durable before Git mutation; a command intent is durable before process launch. Extend the foundation stream-coherence validator for each new event. Test mismatched workspace/run/approval/authorization/environment/command/artifact identities, circular/self-referential digest attempts, scope broadening, stale approvals at prepare/start, phase-key collisions, and secret-bearing metadata rejection.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/contracts check
pnpm --filter @autostack/contracts test:coverage
git diff --check
git status --short
git add packages/contracts/src/ids.ts packages/contracts/src/entities.ts packages/contracts/src/events.ts packages/contracts/src/index.ts packages/contracts/src/runner.ts packages/contracts/src/host-api.ts packages/contracts/src/desktop-api.ts packages/contracts/test/runner.test.ts packages/contracts/test/host-api.test.ts packages/contracts/test/events.test.ts
git commit -m "feat(contracts): define local runner protocol"
```

---

## Task 2: Add the RunnerProvider port, execution decisions, and shared conformance suite

**Files:**

- Create: `packages/domain/src/ports/runner-provider.ts`
- Create: `packages/domain/src/runner-policy.ts`
- Create: `packages/domain/src/testing/runner-provider-conformance.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/package.json`
- Test: `packages/domain/test/runner-policy.test.ts`
- Test: `packages/domain/test/runner-provider-conformance.test.ts`

- [ ] **Step 1: Test the port without importing an implementation**

Define a fake in-memory runner and a reusable conformance suite. The suite must prove:

- environment preparation is idempotent for an identical environment ID and request;
- a conflicting reuse of an environment or command ID is rejected;
- the exact source commit, generated branch, environment authorization, per-command authorization, approval evidence, and workspace/run ownership are retained;
- command start is idempotent; event subscriptions resume from a cursor without owning or blocking PTY drainage;
- event sequences are strictly monotonic, slow subscribers receive a transport-local lag result with a resumable cursor, and durable completion/error is command-terminal;
- cancellation is idempotent;
- artifact chunk reads are workspace/run authorized, capped at 1 MiB, cursor/offset consistent, and digest verified;
- explicit dispose never occurs implicitly and refuses an active command or missing/nonterminal run evidence;
- a disposed environment cannot execute more commands.

Run:

```bash
pnpm --filter @autostack/domain test -- runner-provider-conformance.test.ts
```

Expected failure: no runner port or conformance utility is exported.

- [ ] **Step 2: Define the implementation-neutral port**

Use this public shape, with all inputs and outputs imported from contracts:

```ts
export interface RunnerProvider {
  capabilities(): Promise<RunnerCapabilities>;
  inspectRepository(request: InspectRepositoryRequest): Promise<RepositoryInspection>;
  prepareEnvironment(request: PrepareEnvironmentRequest): Promise<PreparedEnvironment>;
  listEnvironments(): Promise<readonly PreparedEnvironment[]>;
  startCommand(request: StartCommandRequest): Promise<CommandAccepted>;
  readCommandEvents(request: ReadCommandEventsRequest): AsyncIterable<RunnerSubscriptionItem>;
  cancelCommand(request: CancelCommandRequest): Promise<CancelCommandResponse>;
  readArtifactChunk(request: ReadArtifactChunkRequest): Promise<ReadArtifactChunkResponse>;
  disposeEnvironment(request: DisposeEnvironmentRequest): Promise<DisposeEnvironmentResponse>;
}

export interface LocalRunnerLifecycle {
  quiesce(): Promise<void>;
  interruptAndDrain(): Promise<RunnerDrainResult>;
  close(): Promise<void>;
}
```

Export provider and lifecycle conformance helpers through `@autostack/domain/testing` without importing Node, Git, Hono, Electron, or `runner-local` from the domain package. Lifecycle conformance proves quiesce rejects new prepare/start while reads/cancel/artifacts continue, interrupt-and-drain terminalizes active commands and releases guardian leases, and close rejects further operations.

- [ ] **Step 3: Implement control-plane authorization decisions**

Add pure functions that:

- require a run in the authenticated workspace;
- canonicalize an `ExecutionScope` without approval/evidence/authorization identity and require an approved, non-stale `plan` approval whose evidence digest equals `digest(scope)`;
- issue an immutable environment authorization that binds repository identity, exact source commit, generated `autostack/` branch, cwd root, limits, `host` network policy, host-user filesystem disclosure, and allowed credential-reference IDs;
- canonicalize a distinct `CommandScope` for each exact command-spec digest, require an approved non-stale `permission` approval whose evidence digest equals `digest(CommandScope)`, and require its effective repository/branch/cwd/network/filesystem scope to equal the environment authorization while its limits and credential references are subsets;
- allow environment preparation only when the run is exactly `provisioning` and the approved `plan` approval, repository, branch, and recorded environment authorization all match and are unexpired;
- allow command start with action `implement` only when the run is exactly `implementing`, or action `verify` only when it is exactly `verifying`; in both cases require an approved `permission` approval plus matching command spec, environment, run, credential references, recorded command authorization, referenced environment authorization, and unexpired digests;
- permit owned event/artifact reads and cancellation after approval/authorization expiry while still verifying workspace/run/resource ownership and immutable authorization digests; disposal also requires durable terminal run evidence from the control-plane authority;
- classify cleanup as an explicit operator action;
- return typed decisions with stable rejection codes instead of throwing raw strings.

The runner receives and revalidates the immutable decision envelope but does not decide user roles or approval state. Until subproject 5 creates plan approvals through the product workflow, writable local routes are usable only with a legitimately persisted approval/envelope (integration tests seed one); there is no bypass or development default.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/domain check
pnpm --filter @autostack/domain test:coverage
git diff --check
git status --short
git add packages/domain/src/ports/runner-provider.ts packages/domain/src/runner-policy.ts packages/domain/src/testing/runner-provider-conformance.ts packages/domain/src/index.ts packages/domain/package.json packages/domain/test/runner-policy.test.ts packages/domain/test/runner-provider-conformance.test.ts
git commit -m "feat(domain): add runner port and execution policy"
```

---

## Task 3: Build path confinement and the content-addressed artifact store

**Files:**

- Create: `packages/runner-local/package.json`
- Create: `packages/runner-local/tsconfig.json`
- Create: `packages/runner-local/src/path-policy.ts`
- Create: `packages/runner-local/src/artifact-store.ts`
- Create: `packages/runner-local/src/redacted-transcript.ts`
- Create: `packages/runner-local/src/index.ts`
- Test: `packages/runner-local/test/path-policy.test.ts`
- Test: `packages/runner-local/test/artifact-store.test.ts`
- Test: `packages/runner-local/test/redacted-transcript.test.ts`

- [ ] **Step 1: Add failing path-confinement tests**

Use temporary roots and test valid nested paths plus rejection of absolute paths, `..`, encoded/platform separator variants, NUL bytes, a symlink inside the root pointing outside, a swapped symlink during final open, and a source checkout that resolves inside the managed-worktree root.

Run:

```bash
pnpm --filter @autostack/runner-local test -- path-policy.test.ts
```

Expected failure: the package and confinement functions do not exist.

- [ ] **Step 2: Implement realpath-aware confinement**

Provide separate APIs for AutoStack's read-only repository inspection and its own read/write data paths. Create directories with `0700`, files with `0600`, use `lstat` to reject symlinked state roots, resolve the nearest existing ancestor, and verify the real path remains under the configured root before and after creation. Return typed policy errors without exposing unrelated absolute paths. Document and type these as AutoStack-operation confinement, never child-process filesystem isolation.

- [ ] **Step 3: Test atomic, immutable artifact writes**

The tests must prove:

- SHA-256 content addressing and byte size are correct;
- identical content deduplicates;
- a digest collision/mismatched existing file fails closed;
- writes use private temporary files, file `fsync`, atomic rename, parent-directory `fsync`, and private final permissions;
- blob publication completes durably before equally atomic/fsynced metadata publication;
- maximum bytes are enforced while streaming;
- configured secrets and known credential formats split across chunks or ANSI/control sequences are rejected/redacted before finalization;
- readers verify digest and size and never follow symlinks;
- crash injection at every file/rename/directory-sync boundary returns no artifact until a complete blob+metadata pair is durable.

- [ ] **Step 4: Implement the artifact and transcript stores**

Store blobs under `<dataRoot>/artifacts/sha256/<first-two>/<digest>` and immutable JSON metadata separately. Build transcripts with a stateful streaming redactor that withholds a bounded tail across chunks, normalizes ANSI/control bytes for scanning, and releases only proven-safe output. When a live-output or replay limit is reached, emit one explicit truncation event while continuing the independently bounded durable transcript. Scan the finalized artifact again before publishing metadata. Never include raw credential environment values in metadata.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/runner-local check
pnpm --filter @autostack/runner-local test:coverage
git diff --check
git status --short
git add packages/runner-local/package.json packages/runner-local/tsconfig.json packages/runner-local/src/path-policy.ts packages/runner-local/src/artifact-store.ts packages/runner-local/src/redacted-transcript.ts packages/runner-local/src/index.ts packages/runner-local/test/path-policy.test.ts packages/runner-local/test/artifact-store.test.ts packages/runner-local/test/redacted-transcript.test.ts package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(runner-local): add confined artifact storage"
```

---

## Task 4: Provision idempotent AutoStack-managed Git worktrees

**Files:**

- Create: `packages/runner-local/src/process-runner.ts`
- Create: `packages/runner-local/src/data-root-lock.ts`
- Create: `packages/runner-local/src/git-client.ts`
- Create: `packages/runner-local/src/environment-registry.ts`
- Create: `packages/runner-local/src/worktree-manager.ts`
- Modify: `packages/runner-local/src/index.ts`
- Test: `packages/runner-local/test/git-client.test.ts`
- Test: `packages/runner-local/test/data-root-lock.test.ts`
- Test: `packages/runner-local/test/environment-registry.test.ts`
- Test: `packages/runner-local/test/worktree-manager.test.ts`
- Fixture: `packages/runner-local/test/fixtures/create-git-repository.ts`

- [ ] **Step 1: Add failing repository-inspection tests**

Create a disposable Git repository with two commits and a base branch. Prove inspection:

- rejects non-repositories, bare repositories, missing refs, shallow/ambiguous refs, and source paths inside AutoStack's managed root;
- resolves the Git common directory and exact base commit;
- records dirtiness without modifying it;
- normalizes an optional origin URL without embedding credentials;
- rejects local configuration includes, hooks paths, fsmonitor commands, external checkout/smudge/process filters, and credential-bearing remotes;
- proves fixture hooks, filters, and fsmonitor executables are never invoked during inspect, prepare, status, or dispose;
- invokes `git` through an injected executable-plus-args process runner with the hardened profile.

Capture the exact source-checkout invariant before and after every test: HEAD commit, checked-out branch, index-file digest, tracked/untracked file names and content, and repository config digest. Assert those remain unchanged, excluding only the approved new `autostack/` ref and Git's linked-worktree administrative records.

- [ ] **Step 2: Implement the safe Git client**

Use `spawn`/`execFile` with `shell: false`, output and duration limits, and `--no-optional-locks` for read-only inspection. Resolve `/usr/bin/git` once, require its real path to remain inside the root-owned, non-group/world-writable macOS system toolchain, and invoke only that canonical executable. Construct the child environment from scratch with a fixed safe `PATH`, locale, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`, and private empty HOME/XDG config roots; inherit no `GIT_*`, `NODE_OPTIONS`, `DYLD_*`, or loader variables. Supply explicit `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, `-c core.attributesFile=/dev/null`, and `-c submodule.recurse=false` to every mutating/safety-sensitive invocation. Read local config with includes disabled, reject `include*`, `core.hooksPath`, `core.fsmonitor`, `core.attributesFile`, and every external `filter.*` command/process before checkout, bind the safe-config digest into the environment intent, and recheck it immediately before `worktree add`. Reject remote URLs containing credentials. Do not implement reset, clean, stash, checkout, or arbitrary Git passthrough methods.

- [ ] **Step 3: Add failing worktree lifecycle tests**

Cover:

- deterministic path `<dataRoot>/worktrees/<repositoryDigest>/<environmentId>`;
- branch `autostack/<run-short-id>-<slug>` from the exact source commit;
- a private data-root single-writer lock, implemented directly inside `runner-local` with Node 24's built-in `node:sqlite` by holding a dedicated lock-only database `BEGIN EXCLUSIVE` transaction for the daemon lifetime, rejects a second instance and is released by the OS on crash;
- each active command transfers exclusive ownership of its command receipt/spool subtree to a guardian-held SQLite `BEGIN EXCLUSIVE` lease before spawn; a restarted or second daemon detects the busy lease and cannot acquire/reconcile the root until the authenticated guardian terminalizes and releases it;
- `git worktree add --lock --reason AutoStack -b <branch> <path> <commit>`;
- idempotent prepare after process restart;
- rejection when the branch already exists at a different commit or another worktree;
- recovery for crashes before Git mutation, after branch/worktree creation, and after final exposure by reconciling an external phase journal with `git worktree list --porcelain -z`;
- visible maintenance error for corrupt/mismatched intent or Git administrative state;
- explicit disposal of a clean inactive worktree only with control-plane-verified terminal run evidence, using `git worktree remove` and branch retention;
- refusal to dispose a dirty worktree, active command, active/nonterminal run, symlinked path, or mismatched environment;
- no automatic cleanup, `--force`, reset, clean, or deletion of a user's checkout.

- [ ] **Step 4: Implement the registry and manager**

Acquire one non-stealable single-writer lock for the private data root before environment or command recovery by using Node 24's built-in `node:sqlite` directly in `runner-local`—never importing `@autostack/db`—opening a dedicated lock-only database, entering `BEGIN EXCLUSIVE`, and holding that connection for the daemon lifetime; a second process receives a controlled busy error, and process death releases the kernel lock without PID/stale-file heuristics. Before accepting the root, scan command journals and prove every per-command `node:sqlite` lease database is acquirable; if an authenticated guardian still holds one, release the root lock and report `root_busy` until guardian terminalization. Store versioned environment intents outside checkouts under `<dataRoot>/environments/<environmentId>.json`; never write an AutoStack marker into the worktree. Journal and fsync phases `intent_recorded`, `worktree_added`, and `ready`. On startup, reconcile every intent against canonical repository identity and `git worktree list --porcelain -z`; adopt only an exact environment/path/branch/commit/config-digest match and surface every ambiguity as maintenance work. Lock each environment operation in-process in addition to the data-root lock. Creation order is: validate authorization/config, durably journal intent, create parent, add locked worktree at exact commit, journal worktree-added, verify, journal ready, then expose it. Failure cleanup may remove only a newly created, exact-journal-matched, clean worktree from the current attempt.

Disposal order is: reject active/dirty/mismatched state, unlock, `git worktree remove <exact-path>`, verify absence, and retain the product branch for later publication/recovery.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/runner-local test -- worktree-manager.test.ts
pnpm --filter @autostack/runner-local check
pnpm --filter @autostack/runner-local test:coverage
git diff --check
git status --short
git add packages/runner-local/src/process-runner.ts packages/runner-local/src/data-root-lock.ts packages/runner-local/src/git-client.ts packages/runner-local/src/environment-registry.ts packages/runner-local/src/worktree-manager.ts packages/runner-local/src/index.ts packages/runner-local/test/git-client.test.ts packages/runner-local/test/data-root-lock.test.ts packages/runner-local/test/environment-registry.test.ts packages/runner-local/test/worktree-manager.test.ts packages/runner-local/test/fixtures/create-git-repository.ts
git commit -m "feat(runner-local): manage isolated Git worktrees"
```

---

## Task 5: Execute and cancel commands through supervised PTYs

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `packages/runner-local/package.json`
- Create: `packages/runner-local/src/pty.ts`
- Create: `packages/runner-local/src/replay-spool.ts`
- Create: `packages/runner-local/src/command-guardian.ts`
- Create: `packages/runner-local/src/command-registry.ts`
- Create: `packages/runner-local/src/command-executor.ts`
- Modify: `packages/runner-local/src/index.ts`
- Test: `packages/runner-local/test/command-registry.test.ts`
- Test: `packages/runner-local/test/command-executor.test.ts`
- Test: `packages/runner-local/test/replay-spool.test.ts`
- Test: `packages/runner-local/test/command-guardian.test.ts`
- Fixture: `packages/runner-local/test/fixtures/fake-pty.ts`

- [ ] **Step 1: Install the PTY boundary and write failing lifecycle tests**

Add exact `node-pty@1.1.0` behind an injected `PtyFactory` and add only `node-pty` to `pnpm-workspace.yaml`'s `onlyBuiltDependencies` allowlist. Node-based unit/conformance tests use only the fake factory. Do not load or rebuild the native module for standalone Node; Task 9 builds and smokes the single production Electron ABI.

Test receipt-before-spawn ordering, ordered UTF-8 PTY output, split multibyte/secret/ANSI sequences, resize, normal exit, nonzero/signal exit, PTY EOF, completion with no subscribers, large-output pressure, spawn failure, timeout, explicit cancellation, cancellation race, IPC disconnect, and process-tree termination. Test that the executable and each argument reach the PTY separately and no shell option exists.

Run:

```bash
pnpm install
pnpm --filter @autostack/runner-local test -- command-executor.test.ts
```

Expected failure: the command executor is absent.

- [ ] **Step 2: Implement bounded command supervision**

Resolve `cwd` through the environment path policy and revalidate the recorded environment and per-command authorizations, including exact command digest and subset constraints. Construct a minimal environment from an allowlist plus validated literal values and only command-authorization-listed credential material supplied through a one-call secret resolver; never return or record resolved secret values. Before spawn, atomically/fsync a canonical request receipt and create a durable append-only replay/transcript spool outside the worktree.

Launch a bundled Electron-as-Node command guardian over authenticated Node IPC. Before spawn, the guardian opens the command's private lease database, enters `BEGIN EXCLUSIVE`, completes an authenticated lease-transfer handshake, and becomes the sole writer of that command's receipt/spool subtree until terminal fsync and lease release. The guardian owns one PTY and its process group, is the sole PTY consumer, decodes split UTF-8, applies the stateful redactor, appends/fsyncs monotonic frames to the bounded spool, and finalizes the content-addressed transcript before terminal completion. The host command registry manages subscribers independently: each has a cursor and bounded queue; a slow subscriber receives the transport-local `subscription.lagged` result with its last durable sequence and is disconnected without applying PTY backpressure.

On user cancellation or timeout, send a graceful signal, wait an injected grace duration, terminate the process group, then emit exactly one terminal completion. On host shutdown/crash, guardian IPC closes; the guardian terminates the process group, finalizes the partial spool as `interrupted` evidence, and exits. Remove all listeners and timers. Subscriber disconnect never cancels the command.

- [ ] **Step 3: Make command IDs restart-safe and replayable**

Persist private, versioned command receipts under the environment data directory with phases `intent`, `lease_transferred`, `spawned`, `running`, `finalizing`, and `terminal`. Fsync every transition. An identical command ID/request digest replays its durable event spool and artifact metadata; a conflicting request is rejected. On daemon restart, first probe every command lease. A busy lease proves an authenticated guardian is still finalizing, so restart/root reconciliation waits; an acquirable nonterminal lease may be reconciled only from its fsynced receipt/spool. A nonterminal receipt becomes `interrupted` only after the guardian's authenticated IPC closure/finalizer outcome is observed; it is never silently re-executed. Do not kill a bare persisted PID. The guardian owns descendant cleanup, avoiding PID-reuse guesses.

- [ ] **Step 4: Lock the guardian launch contract for Electron**

Using only the fake launcher/PTY, define and pass the complete guardian IPC conformance contract: authenticated handshake, exact executable/args/environment envelope, PTY-only output, input, resize, durable sequence acknowledgements, graceful cancel, host-IPC disconnect interruption, terminal receipt, and artifact metadata. No native test is skipped or disabled. Task 9 implements the production Electron-as-Node launcher and runs the real PTY smoke against this same contract.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/runner-local check
pnpm --filter @autostack/runner-local test:coverage
git diff --check
git status --short
git add pnpm-workspace.yaml pnpm-lock.yaml packages/runner-local/package.json packages/runner-local/src/pty.ts packages/runner-local/src/replay-spool.ts packages/runner-local/src/command-guardian.ts packages/runner-local/src/command-registry.ts packages/runner-local/src/command-executor.ts packages/runner-local/src/index.ts packages/runner-local/test/command-registry.test.ts packages/runner-local/test/command-executor.test.ts packages/runner-local/test/replay-spool.test.ts packages/runner-local/test/command-guardian.test.ts packages/runner-local/test/fixtures/fake-pty.ts
git commit -m "feat(runner-local): supervise redacted PTY commands"
```

---

## Task 6: Compose LocalRunnerProvider and pass the shared conformance suite

**Files:**

- Create: `packages/runner-local/src/local-runner-provider.ts`
- Modify: `packages/runner-local/src/index.ts`
- Test: `packages/runner-local/test/local-runner-provider.test.ts`
- Test: `packages/runner-local/test/local-runner-provider.conformance.test.ts`

- [ ] **Step 1: Bind the shared conformance suite**

Instantiate `LocalRunnerProvider` with a new temporary data root and disposable Git fixture for each case, then run the exact suite exported by `@autostack/domain/testing`.

Run:

```bash
pnpm --filter @autostack/runner-local test -- local-runner-provider.conformance.test.ts
```

Expected failure: composition does not exist.

- [ ] **Step 2: Implement the provider composition**

Compose the inspector, worktree manager, command supervisor, artifact store, environment/command registries, replay spool, redactor, data-root lock, lifecycle controller, and injected credential/guardian launchers. Validate every public input and every emitted output with the contracts package. Verify full journaled environment/command authorization records and digests, exact command digest, credential subset, and workspace/run/environment ownership on every operation. Approval staleness/expiry gates only prepare/start; read/cancel/artifact/dispose continue after expiry for the same owner and immutable authorization binding, but disposal additionally requires terminal run evidence. Return stable error codes for conflict, invalid path, authorization mismatch/staleness, active command, active run, dirty worktree, missing credential, timeout, interruption, subscriber lag, and unsupported policy.

The macOS local provider must not claim hard CPU, memory, child-filesystem, or network isolation that `node-pty` cannot provide. It advertises hard duration, live-output, replay, transcript, artifact, and AutoStack-operation path limits. CPU/memory are advisory; child filesystem access is `host_user`; and network policy supports only exact value `host`. Requests for `none` or `restricted` fail with `unsupported_policy`. Cloud/container runners may advertise stronger controls later through the same capabilities contract.

- [ ] **Step 3: Add restart and no-touch integration tests**

Prepare an environment, start a command, disconnect/reconnect subscribers by cursor, destroy and recreate the provider after terminal command completion, replay the command receipt, and read/digest-verify its artifact. First prove disposal rejects missing, mismatched, and nonterminal run evidence. Then persist a valid terminal run event in the test's durable event fixture, pass its exact sequence/digest in `DisposeEnvironmentRequest`, and explicitly dispose the worktree. Assert throughout the exact source-checkout invariant from Task 4. Also prove a dirty managed worktree is retained and reported for operator attention, and a second command in one environment is rejected while the first is active.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/runner-local check
pnpm --filter @autostack/runner-local test:coverage
git diff --check
git status --short
git add packages/runner-local/src/local-runner-provider.ts packages/runner-local/src/index.ts packages/runner-local/test/local-runner-provider.test.ts packages/runner-local/test/local-runner-provider.conformance.test.ts
git commit -m "feat(runner-local): compose conformant local runner"
```

---

## Task 7: Expose the local runner through an authenticated host daemon

**Files:**

- Create: `apps/host-daemon/package.json`
- Create: `apps/host-daemon/tsconfig.json`
- Create: `apps/host-daemon/tsup.config.ts`
- Create: `apps/host-daemon/src/config.ts`
- Create: `apps/host-daemon/src/app.ts`
- Create: `apps/host-daemon/src/server.ts`
- Create: `apps/host-daemon/src/readiness.ts`
- Create: `apps/host-daemon/src/guardian-launcher.ts`
- Create: `apps/host-daemon/src/shutdown.ts`
- Create: `apps/host-daemon/src/index.ts`
- Test: `apps/host-daemon/test/config.test.ts`
- Test: `apps/host-daemon/test/app.test.ts`
- Test: `apps/host-daemon/test/server.test.ts`
- Test: `apps/host-daemon/test/stream.test.ts`
- Test: `apps/host-daemon/test/guardian-launcher.test.ts`
- Test: `apps/host-daemon/test/shutdown.test.ts`

- [ ] **Step 1: Add failing configuration and authentication tests**

Require a schema-validated bootstrap payload containing the host token, with the same sentinel/secret rules as the control plane, a private data root, `127.0.0.1`, port `0`, and a complete `GuardianLaunchDescriptor`. Production receives this payload once over Electron `parentPort` before listening; it rejects host tokens and runtime-path overrides in environment variables. Process-level tests use an injected bootstrap reader. Reject non-loopback hosts unconditionally. Authenticate every `/v1/*` route, including health and unknown routes, in constant time. Enforce content type and request byte limits before JSON parsing.

Read the descriptor's runtime manifest in one bounded snapshot, verify its SHA-256 digest and exact Electron/node-pty versions, `realpath` every descriptor field, reject symlinks, require guardian module/native directory beneath the manifest's fixed build roots, and require the Electron executable to equal the manifest's canonical workspace Electron executable. Construct the production `GuardianLauncher` explicitly from this validated descriptor and inject it into `LocalRunnerProvider`; the host never derives these paths from `process.execPath`, cwd, argv, or environment.

- [ ] **Step 2: Test the exact route surface**

Use a fake `RunnerProvider` and prove each route validates path parameters and bodies, returns stable status/error codes, never reflects credentials, and has no generic `exec`, `shell`, `files`, `read`, `write`, or arbitrary-method endpoint. Command start and cursor-based event follow are separate. The artifact HTTP route translates each validated single range into one or more `readArtifactChunk` calls of at most 1 MiB; reads require a known artifact ID and verify full digest/size metadata. `DELETE` requires an explicit environment ID and matching recorded environment authorization, but remains usable after its expiry.

- [ ] **Step 3: Implement NDJSON terminal streaming**

The command-events route writes one validated `HostCommandEventFrame` per newline and flushes promptly from the subscriber's bounded queue. It never applies backpressure to the guardian/spool. Client disconnect unsubscribes only that response. A reconnect with `after=<sequence>` replays the durable spool then follows the live command. A slow subscriber receives one transport-local `subscription.lagged` frame carrying its last durable sequence and disconnects; the command continues. Invalid/secret-bearing runner output is quarantined, finalized as a durable command-wide redacted `stream.error`, and is never written raw.

- [ ] **Step 4: Add lifecycle and readiness behavior**

After bootstrap, wait until every guardian-held command lease is released, acquire the private data-root single-writer lock, then listen on numeric loopback port `0`. Emit exactly one versioned readiness record containing PID and verified loopback origin through Electron `parentPort` in production and an injected dedicated readiness writer in process-level tests; stdout is never a framing protocol. Ordinary logs use the redacting structured logger.

Inject both `RunnerProvider` and `LocalRunnerLifecycle` into the host. Define schema-validated parent lifecycle messages `quiesce`, `interrupt-and-drain`, `drained`, and `close`. `quiesce` calls the lifecycle boundary, rejects new prepare/start requests, and keeps reads, cancellation, artifact access, and reconciliation alive. `interrupt-and-drain` marks active work as host-shutdown interruption (not user cancellation), calls `interruptAndDrain`, reconciles terminal receipts/artifacts, and replies `drained` only after every guardian lease is released. `close` calls the lifecycle close and then releases the data-root lock. `SIGINT`/`SIGTERM` run the same protocol internally and exit nonzero if incomplete. Test the host state machine with a fake lifecycle. Do not dispose worktrees on shutdown.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/host-daemon check
pnpm --filter @autostack/host-daemon test:coverage
pnpm --filter @autostack/host-daemon build
git diff --check
git status --short
git add apps/host-daemon/package.json apps/host-daemon/tsconfig.json apps/host-daemon/tsup.config.ts apps/host-daemon/src/config.ts apps/host-daemon/src/app.ts apps/host-daemon/src/server.ts apps/host-daemon/src/readiness.ts apps/host-daemon/src/guardian-launcher.ts apps/host-daemon/src/shutdown.ts apps/host-daemon/src/index.ts apps/host-daemon/test/config.test.ts apps/host-daemon/test/app.test.ts apps/host-daemon/test/server.test.ts apps/host-daemon/test/stream.test.ts apps/host-daemon/test/guardian-launcher.test.ts apps/host-daemon/test/shutdown.test.ts package.json pnpm-lock.yaml
git commit -m "feat(host-daemon): expose authenticated local runner"
```

---

## Task 8: Integrate the host daemon with the control plane and CLI

**Files:**

- Create: `apps/control-plane/src/host-daemon-client.ts`
- Create: `apps/control-plane/src/local-execution-service.ts`
- Create: `apps/control-plane/src/command-reconciler.ts`
- Create: `apps/control-plane/src/local-artifact-service.ts`
- Create: `apps/control-plane/src/readiness.ts`
- Create: `apps/control-plane/src/shutdown.ts`
- Modify: `apps/control-plane/src/app.ts`
- Modify: `apps/control-plane/src/config.ts`
- Modify: `apps/control-plane/src/server.ts`
- Test: `apps/control-plane/test/host-daemon-client.test.ts`
- Test: `apps/control-plane/test/local-execution.test.ts`
- Test: `apps/control-plane/test/local-execution-flow.test.ts`
- Test: `apps/control-plane/test/command-reconciler.test.ts`
- Test: `apps/control-plane/test/local-artifact.test.ts`
- Test: `apps/control-plane/test/readiness.test.ts`
- Test: `apps/control-plane/test/shutdown.test.ts`
- Create: `apps/cli/src/local.ts`
- Modify: `apps/cli/src/http-client.ts`
- Modify: `apps/cli/src/main.ts`
- Test: `apps/cli/test/local.test.ts`
- Test: `apps/cli/test/main.test.ts`

- [ ] **Step 1: Test a validated host client**

The client accepts only a numeric-loopback origin and an injected ephemeral secret, sends validated requests, incrementally parses bounded NDJSON by cursor, rejects malformed/out-of-order/secret-bearing events, reads artifacts only through repeated `ReadArtifactChunkRequest`/response calls capped at 1 MiB with offset/full-digest/full-size verification, and never logs headers. Aborting one follower does not affect the host supervisor; the control-plane reconciler follows independently of renderers. Retry safe idempotent inspection/list/read calls only; never create a command under a new ID.

- [ ] **Step 2: Add authenticated control-plane routes**

Expose:

```text
POST   /v1/local/repositories/inspect
GET    /v1/local/environments
POST   /v1/local/environments
POST   /v1/local/environments/:environmentId/commands
GET    /v1/local/environments/:environmentId/commands/:commandId/events?after=<sequence>
POST   /v1/local/environments/:environmentId/commands/:commandId/cancel
GET    /v1/local/artifacts/:artifactId/content
DELETE /v1/local/environments/:environmentId
```

Register this entire surface only when `mode === "local"`; hosted mode has no `/v1/local/*` routes. Before prepare/start, load the run, approval, and recorded environment/command authorization events from durable state; verify workspace, non-stale approval evidence over the canonical scope, exact permitted run state, environment-to-command subset, exact repository/branch/command/credential/limit scope, and expiry, then send the complete validated authorization record to the host. For later read/cancel/artifact/dispose, verify authenticated workspace/run/resource ownership plus the immutable recorded authorization IDs/digests, but do not reject solely because approval or authorization has since expired. Dispose additionally requires the run's latest durable status to be `completed`, `cancelled`, or `failed` and sends the terminal event sequence/digest as evidence; active/unarchived runs are retained. Require caller-supplied stable resource IDs and idempotency keys for every mutation.

Persist `environment.authorization_recorded` or `command.authorization_recorded` before the corresponding `environment.prepare_requested` or `command.intent_recorded` event, all before calling the host. Use deterministic phase keys `environment:<id>:authorization|intent|prepared|disposed` and `command:<id>:authorization|intent|started|artifact|completed|cancel`, each bound to its canonical request digest. Successful preparation atomically records `environment.prepared` and the declared `provisioning -> implementing` run transition. Start an implementation command only after that transition plus authorization and intent durability. A control-plane-owned background reconciler follows host `runner.event` frames independently of any client, handles `subscription.lagged` by resuming from its cursor, records started metadata, reads artifacts through bounded `readArtifactChunk`-backed host ranges, verifies the finalized full digest/size, commits `artifact.recorded`, and only then commits `command.completed`. Never persist terminal chunks or transport-local lag frames. Return `503 local_runner_unavailable` only in local mode when its supervised host is absent; never choose cloud execution.

- [ ] **Step 3: Add crash-window reconciliation tests**

Crash at every phase: before intent commit, after intent/before host call, after host accept, after started, after artifact finalization, after artifact verification/before event commit, and after completion. Retry with the same environment/command ID and phase key; canonical matches replay and mismatches reject. On control-plane restart, the reconciler resumes from durable intents plus external environment journals/host receipts, verifies artifact-before-success ordering, and appends each evidence event exactly once without auto-disposal or duplicate execution.

Bind the control plane to numeric loopback port `0` in desktop local mode and emit the same versioned readiness shape through Electron `parentPort` or the injected test writer. Desktop bootstrap receives only the SHA-256 digest of the per-install API token; bearer authentication hashes each presented token and compares digests in constant time. Development mode converts its configured token to the same in-memory digest. Add tested parent lifecycle messages `quiesce`, `interrupt-and-drain`, `drained`, and `close`: quiescing closes renderer/CLI ingress while the reconciler and persistence remain alive; drain waits for host terminal evidence commits before acknowledging; close happens only afterward. Keep the existing fixed development-server option outside desktop mode; remove/forbid every non-loopback local-desktop override.

- [ ] **Step 4: Add scriptable CLI local commands**

Add:

```text
autostack local inspect --repo <path> --base <ref> [--json]
autostack local prepare --run <id> --approval <id> --environment-authorization <id> --environment-id <id> --repo <path> --base <ref> --slug <slug> --idempotency-key <key> [--json]
autostack local exec --run <id> --approval <id> --command-authorization <id> --environment <id> --command-id <id> --idempotency-key <key> -- <executable> [args...]
autostack local events --environment <id> --command <id> --after <sequence> [--json]
autostack local artifact --artifact <id> --output <explicit-path>
autostack local cancel --environment <id> --command <id> --command-authorization <id> --idempotency-key <key>
autostack local dispose --environment <id> --environment-authorization <id> --idempotency-key <key>
```

The `--` delimiter yields executable plus args without shell parsing. Writable prepare/start calls cannot manufacture approvals/authorizations and fail closed if supplied evidence is missing, stale, or mismatched. Cancel/dispose remain available after expiry but require the exact recorded authorization and stable idempotency key. PTY data writes to stdout; diagnostics write to stderr; machine-readable mode remains valid NDJSON. Artifact output uses one explicit caller path after digest verification. Never print tokens or resolved credential values. Refuse cleanup without the exact environment ID/authorization.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/control-plane check
pnpm --filter @autostack/control-plane test:coverage
pnpm --filter @autostack/cli check
pnpm --filter @autostack/cli test:coverage
git diff --check
git status --short
git add apps/control-plane/src/host-daemon-client.ts apps/control-plane/src/local-execution-service.ts apps/control-plane/src/command-reconciler.ts apps/control-plane/src/local-artifact-service.ts apps/control-plane/src/readiness.ts apps/control-plane/src/shutdown.ts apps/control-plane/src/app.ts apps/control-plane/src/config.ts apps/control-plane/src/server.ts apps/control-plane/test/host-daemon-client.test.ts apps/control-plane/test/local-execution.test.ts apps/control-plane/test/local-execution-flow.test.ts apps/control-plane/test/command-reconciler.test.ts apps/control-plane/test/local-artifact.test.ts apps/control-plane/test/readiness.test.ts apps/control-plane/test/shutdown.test.ts apps/cli/src/local.ts apps/cli/src/http-client.ts apps/cli/src/main.ts apps/cli/test/local.test.ts apps/cli/test/main.test.ts
git commit -m "feat(control-plane): orchestrate local execution"
```

---

## Task 9: Build the secure Electron supervisor and typed preload bridge

**Files:**

- Modify: `pnpm-workspace.yaml`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/credential-store.ts`
- Create: `apps/desktop/src/main/runtime-supervisor.ts`
- Create: `apps/desktop/src/main/repository-capabilities.ts`
- Create: `apps/desktop/src/main/window.ts`
- Create: `apps/desktop/src/main/navigation-policy.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/main.tsx`
- Create: `apps/desktop/scripts/build-runtime-manifest.mjs`
- Create: `apps/desktop/scripts/rebuild-native.mjs`
- Create: `packages/client-app/package.json`
- Create: `packages/client-app/tsconfig.json`
- Create: `packages/client-app/src/api-client.ts`
- Create: `packages/client-app/src/app.tsx`
- Create: `packages/client-app/src/app.css`
- Create: `packages/client-app/src/use-factory.ts`
- Create: `packages/client-app/src/index.ts`
- Create: `packages/client-app/test/api-client.test.ts`
- Create: `packages/client-app/test/app.test.tsx`
- Modify: `apps/web/src/api-client.ts`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/app.css`
- Modify: `apps/web/src/use-factory.ts`
- Modify: `apps/web/package.json`
- Test: `apps/desktop/test/credential-store.test.ts`
- Test: `apps/desktop/test/runtime-manifest.test.ts`
- Test: `apps/desktop/test/runtime-supervisor.test.ts`
- Test: `apps/desktop/test/window.test.ts`
- Test: `apps/desktop/test/navigation-policy.test.ts`
- Test: `apps/desktop/test/preload.test.ts`
- Test: `apps/desktop/test/repository-capabilities.test.ts`
- Test: `apps/desktop/test/electron-pty.test.ts`
- Test: `apps/web/test/api-client.test.ts`

- [ ] **Step 1: Install Electron tooling and test secret protection**

Add exact `electron@43.4.0`, `electron-vite@5.0.0`, and `@electron/rebuild`. Set `pnpm-workspace.yaml`'s `onlyBuiltDependencies` to exactly `electron` and `node-pty`, retain the frozen lockfile/integrity metadata, and reject any additional lifecycle script. Rebuild `node-pty` once for Electron 43 into an external staged Electron-only native directory; do not mutate the Node unit-test dependency copy. Test that `build-runtime-manifest.mjs` resolves the workspace Electron executable, built guardian module, staged native directory, and fixed build roots, writes a private canonical manifest plus digest, and rejects symlinks/version mismatches. Add explicit `desktop:build` and `desktop:smoke` scripts that build main/preload/renderer/guardian bundles, generate the manifest, and launch those bundles via its Electron executable. This slice does not create an ASAR, `.app`, DMG, or installer; packaging/signing/notarization remains delivery-sequence subproject 8.

Wrap Electron `safeStorage` behind an injected async `SecretProtector`. Generate at least 32 random bytes, store only encrypted bytes in a `0600` file under the private app-data root, and reuse it across restart. Fail closed when encryption is unavailable, decryption fails, the file is a symlink, or permissions/ownership are unsafe. Never derive workspace identity from this token.

Run:

```bash
pnpm install
pnpm --filter @autostack/desktop test -- credential-store.test.ts
```

Expected failure: the desktop package does not exist.

- [ ] **Step 2: Test deterministic process supervision**

Using a fake launcher/clock, prove this state machine:

```text
stopped -> starting_host -> starting_control_plane -> ready
   |              |                    |
   +---------- degraded <--------------+
                     -> stopping -> stopped
```

The production launcher uses Electron `utilityProcess.fork` for host and control plane; tests use an injected fake. Every utility receives an explicit environment built from a fixed minimal allowlist and containing no token, unrelated parent secret, `NODE_OPTIONS`, `GIT_*`, `DYLD_*`, or loader variable. Main reads and validates the private runtime manifest before spawn and constructs its exact `GuardianLaunchDescriptor`. After spawn, main sends a schema-validated one-shot bootstrap payload over the trusted parent/child message channel: the host receives its ephemeral token, private data root, and guardian descriptor; after host readiness, main sends the control plane only the SHA-256 digest of the per-install API token, stable data directory, verified numeric-loopback host origin, and host token. Main decrypts the token once, retains the plaintext only in private main-process memory for bearer injection, never exposes it to preload/renderer, and releases it on shutdown; only ciphertext is persisted. Neither service listens before bootstrap. A host exit first waits for all authenticated guardian command leases to terminalize; only then does it restart the whole host/control-plane generation so no stale host origin or concurrent data-root writer survives. A control-plane-only exit may restart against the verified live host. Unexpected exits enter visible degraded state with bounded backoff/restart ceiling. Child logs are redacted and bounded. Tests assert bootstrap values never enter argv/env/logs and unrelated parent secrets/dangerous variables are absent from both utilities and guardians.

Application quit distinguishes interruption from user cancellation and drives the tested parent protocol: send control-plane `quiesce`; send host `interrupt-and-drain`; wait for host `drained` and guardian lease release; allow the control-plane reconciler to commit terminal evidence; send control-plane `interrupt-and-drain` and wait for its `drained`; then send `close` to host and control plane. Forced termination is last-resort and produces visible incomplete-shutdown evidence.

- [ ] **Step 3: Implement the hardened BrowserWindow**

Explicitly set:

```ts
webPreferences: {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  preload
}
```

Extract the reusable React application, client transport, and shared application CSS/assets from `apps/web` into `@autostack/client-app`. Add `@autostack/client-app` as an explicit workspace dependency of `apps/web/package.json`. Keep `apps/web` and `apps/desktop/src/renderer` as separate deployable entries that import that package; no app imports another app's internals or build output. Electron-vite builds the desktop renderer entry only. Before any writable local-execution control, render a persistent, non-dismissible capability disclosure stating that commands have the desktop user's host filesystem and network authority and that AutoStack path checks are not an OS sandbox; cover the exact text/semantic warning role in client tests. Load the bundled local renderer in production and an explicitly configured numeric-loopback Vite URL only in development. Apply a restrictive CSP; deny all permission requests, popups, downloads, unexpected navigation, and untrusted external protocols. Validate the sender frame and origin for every IPC handler. Do not use `<webview>`.

- [ ] **Step 4: Expose a narrow typed transport bridge**

Expose only:

```ts
interface AutoStackDesktopBridge {
  runtimeStatus(): Promise<DesktopRuntimeStatus>;
  request<K extends keyof DesktopApiOperationMap>(
    input: DesktopApiOperationMap[K]["request"]
  ): Promise<DesktopApiOperationMap[K]["response"]>;
  pickRepository(): Promise<RepositoryCapability>;
  subscribeCommand(
    input: DesktopCommandStreamRequest,
    listener: (event: RunnerStreamEvent) => void
  ): () => void;
  subscribeRuntimeStatus(listener: (status: DesktopRuntimeStatus) => void): () => void;
}
```

All bridge schemas and the operation map live in `@autostack/contracts`, not an app package. They cover only named control-plane operations and accept no arbitrary URLs, headers, IPC channel names, HTTP methods, or renderer-supplied local paths. `pickRepository` invokes the native directory chooser and stores the canonical path in a main-process capability registry; the renderer receives only an opaque, expiring `RepositoryCapabilityId` plus safe display label. Main resolves the path internally for inspection and injects the bearer token. `subscribeCommand` registers its listener before starting cursor delivery, validates every `RunnerSubscriptionItem`, and forwards only durable `RunnerStreamEvent` values to the renderer. On `subscription.lagged`, main immediately reopens the authenticated cursor stream at the supplied sequence with bounded backoff/retry accounting; tests prove no gap/duplicate and a visible runtime error after the retry ceiling. Renderer queue overflow uses the same main-owned resumption path. Detaching never cancels the command. The shared client package selects this bridge when present and browser HTTP otherwise.

- [ ] **Step 5: Add desktop startup integration tests**

With stub child services, launch main, wait for both readiness records, perform a bridge health/run-list request without exposing a token, select a repository and prove the renderer sees only an opaque capability, assert the persistent host-filesystem/network authority disclosure is visible before every writable control, kill the host, observe degraded status and generation restart, and quit in the required evidence-preserving order. Assert renderer globals contain no `process`, `require`, token, host origin, raw path, or `ipcRenderer` handle.

Then run the real Electron-ABI PTY guardian smoke deferred from Task 5: PTY-only output, EOF, resize-after-exit safety, signal exit, no-subscriber drainage, large-output pressure, interactive input, cancellation, and killing the host while a descendant is active. Prove IPC closure terminates the descendant and finalizes partial interrupted evidence without PID-based recovery.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @autostack/desktop check
pnpm --filter @autostack/desktop test:coverage
pnpm --filter @autostack/desktop build
pnpm --filter @autostack/client-app test:coverage
pnpm --filter @autostack/web test:coverage
git diff --check
git status --short
git add pnpm-workspace.yaml package.json pnpm-lock.yaml apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/electron.vite.config.ts apps/desktop/src/main/index.ts apps/desktop/src/main/credential-store.ts apps/desktop/src/main/runtime-supervisor.ts apps/desktop/src/main/repository-capabilities.ts apps/desktop/src/main/window.ts apps/desktop/src/main/navigation-policy.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/index.html apps/desktop/src/renderer/main.tsx apps/desktop/scripts/build-runtime-manifest.mjs apps/desktop/scripts/rebuild-native.mjs apps/desktop/test/credential-store.test.ts apps/desktop/test/runtime-manifest.test.ts apps/desktop/test/runtime-supervisor.test.ts apps/desktop/test/window.test.ts apps/desktop/test/navigation-policy.test.ts apps/desktop/test/preload.test.ts apps/desktop/test/repository-capabilities.test.ts apps/desktop/test/electron-pty.test.ts packages/client-app/package.json packages/client-app/tsconfig.json packages/client-app/src/api-client.ts packages/client-app/src/app.tsx packages/client-app/src/app.css packages/client-app/src/use-factory.ts packages/client-app/src/index.ts packages/client-app/test/api-client.test.ts packages/client-app/test/app.test.tsx apps/web/package.json apps/web/src/api-client.ts apps/web/src/app.tsx apps/web/src/app.css apps/web/src/use-factory.ts apps/web/test/api-client.test.ts
git commit -m "feat(desktop): supervise secure local runtime"
```

---

## Task 10: Prove the local execution slice end to end

**Files:**

- Create: `apps/desktop/e2e/local-execution.spec.ts`
- Create: `apps/desktop/e2e/fixtures/test-repository.ts`
- Create: `apps/desktop/playwright.config.ts`
- Create: `scripts/verify-local-execution.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/development/local-execution.md`
- Modify: `docs/superpowers/plans/2026-08-21-autostack-local-execution.md`

- [ ] **Step 1: Add one real vertical-slice verifier**

Create a fresh temporary Git repository with a committed file, a deliberately dirty/untracked user change, and inert malicious hook/filter/fsmonitor fixtures that would leave sentinel files if executed. `scripts/verify-local-execution.mjs` launches the workspace Electron executable against the built main/preload/renderer bundles and external staged native directory in verifier mode; Electron main starts the Electron-ABI host and control-plane utility processes on port `0`. The Node orchestrator never imports `node-pty` or starts the daemon directly.

Before app launch, the fixture uses the durable-store test harness to atomically seed one coherent manual work item/run already in `provisioning`, its approved `plan` approval and environment authorization, and approved `permission` approvals/command authorizations for the three exact fixture commands. This out-of-band setup exists because approval-creation UI/API belongs to subproject 5; it uses the final run/environment/command IDs and both canonical digest equations. After setup, every repository/runner action uses only the authenticated public control-plane contract:

1. load the seeded run and authorization evidence and prove all workspace/run/environment/command identities and digests are coherent;
2. inspect the repository and exact base commit and prove hooks/filters/fsmonitor do not run;
3. durably record environment intent and prepare an `autostack/` branch in a managed worktree;
4. observe the atomic `environment.prepared` evidence and `provisioning -> implementing` transition before any command starts;
5. durably record command intent, start the approved Electron-as-Node fixture, disconnect one subscriber, and resume ordered PTY events by sequence;
6. open the artifact through the authenticated control-plane content route and independently verify its digest, size, range limit, and final secret scan;
7. restart only the control plane and prove the host command/receipt follower reconciles without duplicate execution;
8. start a long-running command under a second exact per-command authorization within the same environment ceiling, kill the host, and prove guardian IPC closure terminates descendants, finalizes partial interrupted evidence under its lease, and blocks daemon/root reacquisition until terminalization;
9. restart the host/control-plane generation, reconcile external environment journals and command receipts, and inspect exactly-once durable intent/started/artifact/completed or interrupted events;
10. attempt explicit disposal and observe the required dirty-worktree refusal;
11. run a separately approved per-command argument-array Node fixture that removes only its own generated file without reprovisioning the environment;
12. attempt disposal again and observe active-run retention even though the worktree is clean;
13. stop Electron, use the durable-store test harness to append the declared `implementing -> cancelling -> cancelled` transitions, and relaunch against the same data roots;
14. explicitly dispose the now-clean managed worktree using the durable terminal event sequence/digest while retaining the branch.

Also attempt a stale/mismatched approval, command, credential ref, non-`host` network policy, second concurrent command, and second data-root owner; every case must fail before side effects. Finally prove the exact source-checkout invariant (HEAD, branch, index digest, config digest, tracked/untracked names and bytes) remains unchanged except the approved `autostack/` ref/worktree administration, and no hook/filter/fsmonitor sentinel exists. Fail on any configured or chunk-split secret in renderer data, stdout, stderr, logs, SQLite, intents, receipts, spools, or artifacts.

Run:

```bash
node scripts/verify-local-execution.mjs
```

Expected initial failure: the verifier cannot complete the slice until all prior tasks are wired.

- [ ] **Step 2: Add Electron Playwright coverage**

Launch the workspace Electron executable against the built bundles, verify the factory shell renders, both utilities reach ready, a run list loads through the typed bridge, the repository picker exposes only an opaque capability, and the persistent warning explicitly discloses desktop-user host filesystem/network authority before writable controls. Verify command events resume by cursor, artifact content is readable without a path/token, host loss becomes a non-color-only degraded state, and relaunch retains history. Capture screenshots for default, capability-disclosure, degraded, and narrow viewport states. Run axe or equivalent accessibility assertions. Inspect BrowserWindow preferences and fail if renderer sandboxing, context isolation, Node isolation, navigation denial, sender validation, CSP, or the narrow operation map regresses.

- [ ] **Step 3: Add CI and operator documentation**

Run the real Electron-ABI local-execution verifier on macOS because PTY and guardian behavior are platform-specific; keep contract/fake-PTY tests on the standard CI matrix. Verify the exact lifecycle-script allowlist during frozen install. Document prerequisites, private data paths/lock, external intent journals, branch retention, explicit cleanup, interruption recovery, bounded replay/artifact access, token handling, and the guarantee that AutoStack never cleans or resets the source checkout. State plainly that local commands run with the desktop user's host filesystem and network authority; path checks protect AutoStack operations, not the child. Do not document secrets as global shell exports.

- [ ] **Step 4: Run the complete verification matrix**

```bash
CI=true pnpm install --frozen-lockfile
pnpm format:check
pnpm check
pnpm test:coverage
pnpm build
node scripts/verify-local-execution.mjs
pnpm --filter @autostack/desktop exec playwright test
git diff --check
git status --short
```

Expected: all package coverage thresholds remain at or above 80%; all commands pass; the real Git fixture proves source-checkout non-interference; the desktop test proves process and renderer isolation; only intentional plan/implementation files are modified.

- [ ] **Step 5: Run independent review gates**

Task-scoped spec and quality review already gates Tasks 1–9. Request the broad final gates in order:

1. TypeScript quality review;
2. security review focused on approvals, IPC, tokens, child authority disclosure, hardened Git, PTY/guardian process trees, streaming, logs, and artifacts;
3. final code/spec review against the approved design, every task commit, and this plan.

Resolve all critical and important findings with regression tests, re-run the full matrix, and re-request the relevant review. Do not advance to agent teammates while a blocking finding remains.

- [ ] **Step 6: Commit the verified slice**

```bash
git status --short
git add .github/workflows/ci.yml .env.example README.md docs/development/local-execution.md docs/superpowers/plans/2026-08-21-autostack-local-execution.md apps/desktop/e2e/local-execution.spec.ts apps/desktop/e2e/fixtures/test-repository.ts apps/desktop/playwright.config.ts scripts/verify-local-execution.mjs
git commit -m "test: verify AutoStack local execution"
```

---

## Completion evidence

Subproject 2 is complete only when the committed evidence demonstrates all of the following:

- Electron supervises independently testable host-daemon and control-plane child processes and reports degradation/recovery.
- The renderer is sandboxed, context-isolated, has no Node integration, and can call only a narrow validated main-process bridge.
- The per-install API token is OS-protected and never enters renderer state, logs, events, artifacts, command lines, or broad child environments.
- Every host-daemon route is authenticated; both services bind only to loopback; a remote team control plane has no host-daemon capability.
- The local runner passes the common provider conformance suite.
- Every prepare/start side effect is bound to a matching approved, non-stale canonical scope and recorded environment/per-command authorization; later owned read/cancel/dispose remains possible after expiry and there is no development/default bypass.
- A real Git repository runs at its exact base commit in a locked `autostack/` managed worktree, while a dirty source checkout remains untouched.
- Hardened Git provisioning cannot execute repository hooks, external filters, or fsmonitor commands.
- PTY commands use executable/argument arrays, drain independently through guardians into resumable redacted spools, support bounded cancellation/interruption, and retain authenticated digest-verified transcript evidence.
- Capabilities and UI state that child filesystem/network access has host-user authority; no path helper is represented as an OS sandbox.
- Environment and command IDs are idempotent across retries/restarts; interrupted commands are visible and never silently duplicated.
- Worktrees are retained by default and disposed only through an explicit, safe, clean-worktree lifecycle action.
- The complete foundation plus local-execution format, type, coverage, build, integration, desktop, and security checks pass.

## Primary implementation references

- Electron security checklist: <https://www.electronjs.org/docs/latest/tutorial/security>
- Electron context isolation: <https://www.electronjs.org/docs/latest/tutorial/context-isolation>
- Electron process sandboxing: <https://www.electronjs.org/docs/latest/tutorial/sandbox>
- Electron `safeStorage`: <https://www.electronjs.org/docs/latest/api/safe-storage>
- Electron utility processes: <https://www.electronjs.org/docs/latest/api/utility-process>
- Electron native modules: <https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules>
- Git worktree lifecycle: <https://git-scm.com/docs/git-worktree>
- `node-pty` API and security boundary: <https://github.com/microsoft/node-pty>
- Node child-process lifecycle and abort behavior: <https://nodejs.org/api/child_process.html>
