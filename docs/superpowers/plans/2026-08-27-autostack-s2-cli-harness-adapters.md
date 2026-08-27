# AutoStack CLI Harness Adapters Implementation Plan (Stream S2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `packages/agent-adapter-kit`, `packages/agent-acp`, `packages/agent-claude`, and `packages/agent-codex` — three `AgentHarnessPort` implementations over one shared transport, each supervising its provider CLI as a child process over stdio, normalizing the provider protocol into `AgentSessionStreamEvent`, declaring only the capabilities its configured launch profile genuinely has, classifying every failure into the workflow-failure alphabet, and passing `describeAgentHarnessConformance` unmodified against fixture provider processes replaying transcripts recorded from the real CLIs.

**Architecture:** `agent-adapter-kit` owns everything protocol-agnostic: the launch configuration, one long-lived child (`executable` + `args`, never a shell string), a line-delimited frame reader over **raw** stdout bytes, a bounded stdin writer, process-tree termination, the per-session sequence allocator, the evidence sink port, the redaction boundary, the shared failure taxonomy, and the honest `quiesce()`. Each adapter package adds three thin layers: a **launch profile** (which provider mode to run, and therefore which capabilities the descriptor may declare), a **frame mapper** (provider frame → zero or more normalized events, sequence-allocated, redacted per field, schema-validated at the boundary), and a **failure classifier** (enumerated structured provider fields → a `^[a-z][a-z0-9_]{0,63}$` code). Conformance runs the real adapter against a checked-in fixture provider process, so the transport under test is a real child on a real macrotask boundary; the real CLIs appear only in the flagged live smoke.

**Tech Stack:** Node.js 24 LTS (local 26); TypeScript 5.9 strict; pnpm 10.27; Zod 4; Vitest 4; Claude Code CLI 2.1.228; Codex CLI 0.150.1; ACP JSON-RPC 2.0 over stdio.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` — §9.1 (normalized adapter contract), §9.2 (Codex and Claude Code), §9.3 (ACP), §14.1 (trust boundaries), §14.3 (secrets), §15 (failure handling).

**Charter:** `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md` "Stream S2" + `.superpowers/sdd/dispatch-s2.md`.

**Contract map:** `docs/development/milestone-a-contract-audit.md` §§1–5.

**Global Constraints:**

- TypeScript strict; no unchecked `any`, non-null assertions, disabled tests, placeholder/TODO implementations, or validation bypasses.
- Every process invocation is `executable` + `args`. Never shell command strings, `exec`, `spawn(..., { shell: true })`, or `/bin/sh -c`.
- Every event leaving an adapter parses through `AgentSessionStreamEventSchema` before it is yielded. A frame that cannot be mapped to a valid event is a classified failure, never a crash and never a silently dropped frame.
- `failed.code` is minted from enumerated, structured provider fields only (JSON-RPC `error.code`, Claude `result.subtype`, Codex `ErrorNotification`, process exit status). Never from provider prose: provider output is untrusted input (spec §14.1) and retryability is a policy branch.
- Redaction is applied **per extracted text field after JSON parse**, never over the stdio byte stream (see Decision D-4).
- Adapters use the user's ambient CLI authentication through an opaque key-copy of an explicit environment allowlist (Decision D-5). They never read, copy, persist, scan, or log credential material, and never read `~/.claude`, `~/.codex`, or any provider config file.
- `file_change.path` is relativized against the invocation `cwd` and validated by `RelativeWorkspacePathSchema`. A provider-reported path outside the workspace is reported as `output`, never as a `file_change`.
- No emulated resume (spec §9.1). `resume` is declared only where a recorded transcript pair proves the provider continues the session under a stable identity.
- An adapter that does not declare `capabilities.permissions` must not have a `respondToPermission` property at all.
- 80% coverage floor (statements, branches, functions, lines) on every package this stream owns.
- Tests inject clocks, id factories, executable resolvers, and temp dirs. Live tests use disposable temp repositories, never the AutoStack checkout.
- No pushes to origin (stream-lead protocol, Push policy). Commit locally, per task, conventional-commit style.
- Do not modify `packages/contracts`, `packages/domain`, `packages/runner-local`, another stream's packages, root config, or CI. `pnpm-workspace.yaml` already globs `packages/*`, so new packages need no root edit; if one seems necessary, that is an escalation.

## Decisions (settled by the orchestrator at plan review — no longer open)

**D-1 — The kit is authored up front.** `packages/agent-adapter-kit` is created in Task 2, not extracted later. The charter's "second consumer" rule is satisfied by intent: three consumers are planned and the transport is provably shared, so an extraction task would be pure churn.

**D-2 — Interruption versus failure has one discriminator, applied before any code is chosen.** All three adapters implement exactly this rule:

| Child outcome                                                                                                         | Prior evidence-bearing events? | Result                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Terminated by signal, or lost with no provider error frame                                                            | yes                            | `interrupted` detail event carrying that partial evidence; stream ends with **no** lifecycle terminal (conformance behaviour 10) |
| Terminated by signal, or lost with no provider error frame                                                            | no                             | `failed` terminal, `harness_*` code — nothing partial exists to preserve                                                         |
| Exited carrying a provider error shape (JSON-RPC `error`, Claude `result` with `is_error`, Codex `ErrorNotification`) | either                         | `failed` terminal, code from the per-provider table                                                                              |
| Failed to launch at all                                                                                               | n/a                            | `failed` terminal, `harness_not_installed` / `harness_launch_denied` / `harness_launch_failed`                                   |

A non-zero exit code alone never decides this; only the presence of a provider error shape does.

**D-3 — Permission normalization.** An approval-gated provider call surfaces as `permission_requested` **only**. No `tool_call` event — of any phase — is emitted for that call until the decision allows it; `tool_call` with phase `started` is emitted at the moment the decision permits the call to proceed. This keeps conformance behaviour 4's "no side effect before the decision" assertion true by construction rather than by luck, since `tool_call` is one of its side-effect types. Task 1 records transcripts that reproduce this ordering so the mappers are tested against it.

**D-4 — Redaction happens after parsing, per field.** The frame reader sees raw bytes; redaction is applied to each extracted string field after `JSON.parse`, via `redactCompleteText` (or a per-field `StreamingSecretRedactor` that is finalized before the field is used). Redacting the byte stream is forbidden for two independent reasons: substituting a marker mid-JSON corrupts the frame, and the streaming redactor deliberately withholds a tail to catch secrets spanning chunk boundaries — a withheld tail is bytes the transport is holding, which would make `quiesce()` report idle while a frame is still in flight.

**D-5 — Ambient authentication is an opaque key-copy over an explicit allowlist.** The spawn environment is built from a fixed allowlist — `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TMPDIR`, every `LC_*`, plus each provider's documented authentication variables (pinned in Task 1) — copied key-by-key from `process.env` without the value ever being read into anything that is logged, scanned, persisted, compared, or placed in an event. This is a different channel from `AgentInvocationRequest.environment`, whose entries are contract-supplied, non-secret, and validated by `NonSecretEnvironmentEntrySchema`; adapters apply that schema's `/^[A-Z_][A-Z0-9_]*$/` name rule to their own allowlist too. Tested by giving each allowlisted variable a credential-shaped value, running a full session, and asserting the value appears in no event, no error message, no transcript artifact, and no log.

**D-6 — `isAuthenticated()` may spawn in production.** The "never spawn a real CLI" rule is a unit-test constraint, not a production one. The production probe runs the CLI's own status command as `executable` + `args` under a bounded timeout with its output passed through redaction, and reads its exit status. It must not read provider config files or home directories. Per adapter: `claude auth status`; `codex login status`; for ACP, the negotiated `initialize` result plus the agent's advertised auth methods — there is no external command to run. Unit tests inject the probe; only the live smoke exercises the spawning path.

**D-7 — Steering is observable because the adapter says so.** When `steer()` injects an instruction, the adapter emits a `message` event with `role: "user"` carrying that instruction. Observability never depends on the provider or a fixture echoing the text back.

**D-8 — Resume requires recorded proof, for every adapter.** Claude's `--resume` and Codex's `thread/resume` are both held to the same standard: a recorded transcript pair must show the provider continuing under the **same** session identifier. If either pair shows a new identifier, `resume: true` is dishonest for that adapter — stop and escalate rather than declaring it, exactly as risk R-1 requires for permissions.

**D-9 — Model and reasoning selection are derived, not assumed.** `AgentHarnessProfile.selection` is populated per provider from the real surface: Claude from `--model` and `--effort` (`low|medium|high|xhigh|max`); Codex from `-m/--model` and the reasoning-effort config override; ACP from the `initialize` negotiation. A provider mode that offers neither declares both false.

**Remaining escalations:** none blocking. E-1 is resolved in favour of Option B — S2 implements the child supervisor inside `agent-adapter-kit`, modelled on but not copied from the private `packages/runner-local/src/process-runner.ts`, importing runner-local's public redaction, path-policy, and signal exports. The module is to be written so that promoting it into `runner-local` later is a clean lift. E-3's `AgentEvidenceSink` port is confirmed as S2-owned.

---

## Task 1: Record the three provider protocols into checked-in transcript fixtures

**Files:**

- Create: `packages/agent-adapter-kit/test/fixtures/transcript-format.ts`
- Create: `packages/agent-adapter-kit/scripts/record-transcripts.mjs`
- Create: `packages/agent-claude/test/fixtures/transcripts/*.json`
- Create: `packages/agent-codex/test/fixtures/transcripts/*.json`
- Create: `packages/agent-acp/test/fixtures/transcripts/*.json`

Nothing in this task is TDD; it is evidence gathering whose output every later task replays. Fixtures are data, and their provenance travels with them.

- [ ] **Step 1: Write the recorder script**

`packages/agent-adapter-kit/scripts/record-transcripts.mjs` is checked in so a re-record is reproducible rather than a fresh act of archaeology. It takes a provider and a scenario, creates a disposable temp repository (`mktemp -d`, `git init`, one trivial file — never the AutoStack checkout, asserted in the script), spawns the CLI with the exact argv for that scenario, captures every stdout and stderr line with its stream tag, and writes one fixture file named `<provider>-<scenario>.json`.

Each scenario carries a fixed **objective text** and a **deterministic provocation** recorded in the script, so a re-record reproduces the same shape:

| Scenario              | Objective                                                  | Provocation                                              |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `completes`           | "Print the contents of README.md and stop."                | none — runs to completion                                |
| `pauses`              | "Wait for further instructions before doing anything."     | none — the CLI blocks on input                           |
| `requests_permission` | "Create a file named notes.txt containing the word hello." | permission mode set so the write must be approved        |
| `fails`               | "Print the contents of README.md and stop."                | invalid model name passed on argv                        |
| `interrupted`         | "Print the contents of README.md and stop."                | SIGKILL the child after the first evidence-bearing frame |
| `malformed`           | derived                                                    | copy the `completes` transcript and corrupt one frame    |

- [ ] **Step 2: Fix the fixture format**

```ts
type TranscriptScenario =
  "completes" | "pauses" | "requests_permission" | "fails" | "interrupted" | "malformed";

interface TranscriptFixture {
  readonly provenance: {
    readonly source: "recorded" | "authored";
    readonly cli: "claude" | "codex" | "acp";
    readonly version: string;
    readonly recordedAt: string; // ISO-8601
    readonly argv: readonly string[];
    readonly stability: "stable" | "experimental";
    readonly notes?: string;
  };
  readonly scenario: TranscriptScenario;
  readonly frames: readonly TranscriptFrame[];
}

type TranscriptFrame =
  | { readonly emit: unknown }
  | { readonly emitStderr: string }
  | { readonly awaitStdin: { readonly match: unknown } }
  | { readonly exit: { readonly code: number | null; readonly signal: string | null } };
```

`emitStderr` exists because provider diagnostics arrive on stderr and the adapters must prove they surface them as `output` events without ever letting them reach the frame parser. `stability` is recorded because `codex app-server` is marked `[experimental]` in the CLI's own help — that is a real risk to this stream's Codex profile and it travels with the fixtures.

- [ ] **Step 3: Normalize and scan every recorded fixture**

The recorder rewrites machine-specific values to fixed placeholders in **both** the frames and the recorded `argv`: the home directory to `/home/agent`, the temp repository path to `/tmp/agent-workspace`, and the username to `agent`. Normalization runs first, then the normalized document is scanned with `containsSensitiveMaterial`; a fixture that still trips the scan is re-recorded with the offending variable unset, and the reason is written into `provenance.notes`. Targeted normalization is expected and fine; what is forbidden is editing frames to make a test pass.

- [ ] **Step 4: Record Claude Code and settle its open questions**

```bash
claude -p "<objective>" \
  --output-format stream-json --input-format stream-json --verbose \
  --session-id <uuid> --permission-mode manual --add-dir <tmp>
```

Settle and write into `provenance.notes`:

- **The permission channel.** `--permission-prompt-tool` is absent from 2.1.228's help; `--permission-mode manual` is present. Determine whether the CLI emits a control request on stdout and accepts a control response on stdin, or whether an MCP permission-prompt server via `--mcp-config` is the only channel. **If neither exists, the Claude adapter cannot honestly declare `permissions: true`, cannot supply the full-capability subject, and cannot pass the suite — stop and escalate rather than faking it (risk R-1).**
- **The permission ordering (D-3).** Record whether the CLI announces the tool call before or after the approval, so the mapper is written against the real ordering.
- **Resume identity (D-8).** Record a `--resume` pair and confirm the session id is reused.
- **The documented auth variables (D-5)** and the `result.subtype` values and `usage` figures the CLI actually emits. Reasoning tokens are expected to be absent, which is what supplies conformance behaviour 8's required `{ state: "unknown" }` figure.

- [ ] **Step 5: Record Codex for both profiles**

Dump the authoritative protocol first:

```bash
codex app-server generate-json-schema --out <dir>
```

Record `codex app-server` driving `initialize` → `thread/start` → `turn/start`, plus `turn/steer`, `turn/interrupt`, `thread/resume`, an approval request, and the token-usage notification. Record `codex exec --json` separately as the minimal profile. Mark the app-server fixtures `stability: "experimental"` and confirm the `thread/resume` identity pair per D-8.

- [ ] **Step 6: Author the ACP transcripts**

No ACP agent is installed, so these are authored against the protocol: `initialize` capability negotiation, `session/new`, `session/prompt`, `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `plan`, `tool_call`, `tool_call_update`), `session/request_permission`, `session/cancel`, and `session/load`. Author two negotiation results — one advertising `loadSession` and permission support, one advertising neither — because those are the two capability profiles Task 4 derives descriptors from. Mark provenance `"authored"` and cite the protocol version.

- [ ] **Step 7: Commit**

```bash
git diff --check
git status --short
git add packages/agent-adapter-kit packages/agent-acp packages/agent-claude packages/agent-codex
git commit -m "test(agent-adapters): record the provider protocol transcripts"
```

---

## Task 2: Author the shared transport in `packages/agent-adapter-kit`

**Files:**

- Create: `packages/agent-adapter-kit/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/agent-adapter-kit/src/{launch-config,line-frames,child-session,child-environment,session-errors,index}.ts`
- Test: `packages/agent-adapter-kit/test/{launch-config,line-frames,child-session,child-environment,quiesce}.test.ts`
- Test: `packages/agent-adapter-kit/test/fixtures/echo-child.mjs`

- [ ] **Step 1: Add failing launch-configuration tests**

The launch config is `executable` + `args` arrays and nothing else (spec §9.3). Tests must prove it rejects: a non-absolute executable; an executable that escapes its expected root after realpath; more than 256 arguments; an argument over 32 KiB; more than 128 environment entries; and an environment name outside `/^[A-Z_][A-Z0-9_]*$/` (the contract's `NonSecretEnvironmentEntrySchema` rule, per D-5). It must accept a config whose args contain spaces, quotes, `;`, and `$(...)`, and prove via the echo child that each arrives as one literal argument — the positive proof that no shell is involved.

```bash
pnpm --filter @autostack/agent-adapter-kit test -- launch-config.test.ts
```

Expected failure: the package and `AgentLaunchConfigSchema` do not exist.

- [ ] **Step 2: Implement the launch configuration**

A `.strict()` Zod schema with the bounds above. Document in the module that editing this configuration is permission to execute local code (spec §9.3) and is therefore privileged for the surfaces that expose it; the schema is the enforcement point available at this layer.

- [ ] **Step 3: Add failing environment-policy tests (D-5)**

Prove the spawn environment contains exactly the allowlisted names present in `process.env` and nothing else — no inherited `process.env` spread. Prove `LC_*` is matched by prefix. Prove the **opacity** property directly: set every allowlisted variable to a credential-shaped value, run a full session against the echo child, and assert the value appears in no emitted event, no thrown error's message, no recorded transcript, and no log sink. Prove the copy is key-based by asserting no code path passes an environment value to a redactor, a scanner, or a comparison.

- [ ] **Step 4: Implement the environment policy**

An opaque key-copy loop over the frozen allowlist plus the `LC_` prefix. The provider-specific auth variable names are supplied by each adapter package and pinned from Task 1.

- [ ] **Step 5: Add failing frame-reader tests**

The reader turns **raw** bytes into whole JSON values — no redaction at this layer (D-4). Tests must prove: a frame split across three chunk boundaries reassembles; multiple frames in one chunk all emit in order; `\r\n` and `\n` both terminate; a line over the byte cap yields a classified `provider_output_malformed` failure rather than unbounded buffering; invalid JSON yields the same, carrying no provider text; a trailing partial line at EOF is a classified failure, not a silently dropped frame; and the reader never emits a frame it has not fully received. Prove stderr bytes never reach the frame parser.

- [ ] **Step 6: Implement the frame reader**

A stateful reader over `Uint8Array` chunks with an explicit byte budget, decoding UTF-8 incrementally. It exposes `observedBytes` and `emittedFrames` counters; Step 8's quiesce reads them, so they are part of the module's contract, not diagnostics.

- [ ] **Step 7: Add failing child-session tests**

Against `test/fixtures/echo-child.mjs` (following the precedent of `packages/db/test/fixtures/*.mjs`), prove the supervisor:

- spawns with `shell: false`, `stdio: ["pipe", "pipe", "pipe"]`, `windowsHide: true`, `detached` on non-Windows, and only the policy-built environment;
- delivers stdout frames in order and surfaces stderr separately as `output`;
- resolves `write()` only once the child has accepted the bytes;
- on `close()` sends SIGTERM, waits a bounded grace, escalates to SIGKILL of the **process group**, and resolves with an exit proof;
- is idempotent on repeated `close()`;
- enforces a total-runtime bound and a no-output-progress bound, each yielding a distinct classified failure;
- leaves no orphaned process after `close()` — assert by probing the pid and the process group, not by absence of error;
- **on stream abandonment** (finding 14): when the consumer calls `iterator.return()`, the child is terminated and reaped with no orphan, but the harness object stays usable — a subsequent `resume()` works. `dispose()` remains the strictly stronger operation: after it, every operation rejects.

- [ ] **Step 8: Implement the child session and its honest quiesce**

Model the spawn flags, PGID kill escalation, and bounds on the private `packages/runner-local/src/process-runner.ts`; import signal validation from its public `darwin-process-signals`. Do not copy it — it is one-shot, buffered, and stdin-less, and this is a long-lived bidirectional session.

`quiesce()` is an honesty obligation the conformance suite cannot check, so it is specified precisely and tested directly (finding 11):

```text
1. Await every outstanding stdin write callback.
2. Loop, recording (observedBytes, emittedFrames, deliveredEvents, exitReduced):
     await one full event-loop iteration that reaches the poll phase
       -- a timers-phase yield (setTimeout 0), then a check-phase drain (setImmediate);
          setImmediate alone runs in the check phase and can skip poll entirely,
          which is where a socket's readable data actually arrives.
     continue while any counter changed since the previous turn,
       or framesEmittedButNotYetDelivered > 0,
       or the child has exited and the exit has not yet been reduced to a terminal event.
3. Require two consecutive no-change turns.
4. While the child is still alive, do not resolve before a bounded wall-clock floor has
   elapsed, so a child that is about to write is never mistaken for one that is waiting.
5. Bound the total turns and the total wall clock; exceeding either throws -- a transport
   that never idles is a defect, not a pause.
```

- [ ] **Step 9: Test the quiesce itself**

The suite cannot detect a lazy `quiesce()`, so this stream tests it directly. Prove that with a frame in flight — written by the child but not yet pulled — `isPending` over an outstanding `next()` reports **false**; and with the child deliberately silent it reports **true**. A `quiesce()` returning an already-resolved promise fails the first assertion. Prove it waits out a child that emits after several event-loop turns, and a child that emits only after a poll-phase read (the case a `setImmediate`-only loop misses). Run each of these **20 times in a loop** to catch a quiesce that is merely usually right.

- [ ] **Step 10: Verify and commit**

```bash
pnpm --filter @autostack/agent-adapter-kit check
pnpm --filter @autostack/agent-adapter-kit test:coverage
git diff --check
git status --short
git add packages/agent-adapter-kit pnpm-lock.yaml
git commit -m "feat(agent-adapter-kit): supervise an agent child over line-delimited stdio"
```

---

## Task 3: Sequencing, evidence, redaction, and the shared failure taxonomy

**Files:**

- Create: `packages/agent-adapter-kit/src/{event-sequencer,evidence-sink,text-boundary,failure-taxonomy,jsonrpc-failures,conformance-support}.ts`
- Test: `packages/agent-adapter-kit/test/{event-sequencer,evidence-sink,text-boundary,failure-taxonomy,jsonrpc-failures}.test.ts`

- [ ] **Step 1: Add failing sequencer tests**

Prove sequence numbers are positive, strictly increasing, allocated per AutoStack session, and **survive the stream ending** — a `start()` stream abandoned after two events, followed by `resume()`, continues above the last allocated number (conformance behaviour 6 asserts exactly this). Prove nothing is emitted after a lifecycle terminal, and that `interrupted` is not a terminal but does end the stream (D-2).

- [ ] **Step 2: Add failing evidence-sink tests**

```ts
export interface AgentEvidenceSink {
  record(input: {
    readonly kind: "transcript" | "diff" | "plan" | "permission";
    readonly bytes: Uint8Array;
  }): Promise<{ readonly digest: string }>;
}
```

Prove the in-memory test sink returns a lowercase 64-hex SHA-256 matching `DigestSchema`, is content-addressed (identical bytes → identical digest), and that a sink failure becomes a classified adapter failure rather than an unhandled rejection. The agent packages never import `ArtifactStore`; composition binds this later.

- [ ] **Step 3: Add failing text-boundary tests (D-4)**

The single place provider text becomes event text. Prove: each field is redacted with `redactCompleteText` after parse; a credential-shaped token in a message body is replaced by the marker; a secret split across two frames is still caught, because each frame's field is redacted whole; text is truncated to the contract's per-field maximum **after** redaction, never before; an empty field after redaction is dropped rather than emitted as an empty string that `SafeMetadataStringSchema.min(1)` would reject; and the byte stream itself is never redacted — assert the frame reader receives bytes identical to what the child wrote.

- [ ] **Step 4: Add failing taxonomy tests (finding 5)**

Every code maps to exactly one `retryable` value, so classification never has to decide twice. Spellings align with `MODEL_ROUTING_FAILURE_CODES` (`packages/contracts/src/model.ts:220`) wherever the meaning coincides.

| Code                        | `retryable` | Meaning                                                                |
| --------------------------- | ----------- | ---------------------------------------------------------------------- |
| `rate_limited`              | `true`      | provider throttled the request (aligned spelling)                      |
| `capability_unavailable`    | `false`     | the provider does not offer the requested operation (aligned spelling) |
| `provider_unavailable`      | `true`      | provider-side transient outage                                         |
| `provider_internal_error`   | `true`      | provider reported an internal fault                                    |
| `provider_execution_error`  | `true`      | the agent run itself failed mid-execution                              |
| `provider_timeout`          | `true`      | runtime or no-progress bound exceeded                                  |
| `provider_error`            | `false`     | unclassified provider failure — fail closed (aligned spelling)         |
| `provider_protocol_invalid` | `false`     | the provider violated its own protocol                                 |
| `provider_request_rejected` | `false`     | the provider rejected the request as invalid                           |
| `provider_output_malformed` | `false`     | a frame could not be parsed or mapped                                  |
| `provider_turn_limit`       | `false`     | the provider stopped at a configured turn ceiling                      |
| `provider_unauthenticated`  | `false`     | the provider has no usable credential                                  |
| `harness_not_installed`     | `false`     | the executable does not exist                                          |
| `harness_launch_denied`     | `false`     | the executable exists but cannot be executed                           |
| `harness_launch_failed`     | `true`      | transient spawn failure (resource exhaustion)                          |
| `harness_child_exited`      | `true`      | the child exited carrying a provider error shape                       |

Assert as properties over the whole table rather than row by row: every code matches `^[a-z][a-z0-9_]{0,63}$`; every code has exactly one retryable value; no code equals any message in the message table.

- [ ] **Step 5: Add failing JSON-RPC mapping tests**

Shared by ACP and Codex app-server, since both are JSON-RPC. This is the obligation the dispatch names explicitly.

| JSON-RPC `error.code`  | Adapter code                |
| ---------------------- | --------------------------- |
| `-32700`, `-32600`     | `provider_protocol_invalid` |
| `-32601`               | `capability_unavailable`    |
| `-32602`               | `provider_request_rejected` |
| `-32603`               | `provider_internal_error`   |
| `-32000`…`-32099`      | `provider_unavailable`      |
| any other numeric code | `provider_error`            |

Prove classification reads only `error.code`: feed two errors with identical codes and wildly different `message` text and assert identical classification; feed an error whose message says "rate limited, please retry" under `-32602` and assert `retryable: false`. Prove a raw `-32601` can never reach `failed.code` — assert the mapper's output against `WorkflowFailureCodeSchema` for every input in a generated range of codes.

- [ ] **Step 6: Implement all five modules**

Follow the repo's error convention (`packages/runner-local/src/local-runner-provider-error.ts`): a fixed message table, a `code` field, the underlying failure retained as a non-enumerable `cause`, `Object.freeze(this)`, and no caller-controlled provenance in the message. `conformance-support.ts` exports the macrotask-deferring fixture wrapper and the in-memory evidence sink so all three adapters share one honest test scaffold.

- [ ] **Step 7: Verify and commit**

```bash
pnpm --filter @autostack/agent-adapter-kit check
pnpm --filter @autostack/agent-adapter-kit test:coverage
git diff --check
git status --short
git add packages/agent-adapter-kit
git commit -m "feat(agent-adapter-kit): sequence, digest, redact, and classify"
```

---

## Task 4: Negotiate ACP capabilities into an honest descriptor and profile

**Files:**

- Create: `packages/agent-acp/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/agent-acp/src/{acp-protocol,acp-capabilities,acp-failures,availability,index}.ts`
- Test: `packages/agent-acp/test/{acp-capabilities,acp-failures,availability}.test.ts`

- [ ] **Step 1: Add failing capability-negotiation tests**

Prove the descriptor is derived from the `initialize` result and nothing else: an agent advertising `loadSession` and permission support yields `resume: true`, `permissions: true`; one advertising neither yields both `false`, **and the returned object has no `respondToPermission` property at all** (`expect("respondToPermission" in harness).toBe(false)`). Prove `structuredPlans` follows the advertised prompt capabilities and that an adapter with `structuredPlans: false` maps a `plan` frame to `output` rather than `plan`. Prove `selection.modelSelection` and `selection.reasoningSelection` come from the negotiation (D-9), and that `permissionModes` stays empty whenever `permissions` is false. Prove an unparseable or absent `initialize` result fails closed to the minimal descriptor.

```bash
pnpm --filter @autostack/agent-acp test -- acp-capabilities.test.ts
```

Expected failure: `negotiateAcpCapabilities` does not exist.

- [ ] **Step 2: Implement negotiation**

Parse the `initialize` result with a `.strict()` schema and build the harness so the responder method is conditionally spread — never defined-then-thrown. Distinct `adapterId` per negotiated profile.

- [ ] **Step 3: Add failing ACP failure-mapping tests**

Compose the kit's JSON-RPC table with the ACP-specific cases: an auth-required error → `provider_unauthenticated`; a `session/cancel` acknowledgement → `cancelled`, not `failed`. Apply D-2's discriminator: a fixture agent SIGKILLed after emitting a file change yields `interrupted` with no terminal; one that exits non-zero after a JSON-RPC `error` frame yields `failed`; one that dies before any event yields `failed` with `harness_child_exited`.

- [ ] **Step 4: Add failing availability-probe tests (D-6)**

Prove: a missing executable yields `installed: false, authenticated: false`; an agent whose negotiation reports no usable auth method yields `installed: true, authenticated: false`; `authenticated: true` with `installed: false` is impossible (the `AgentHarnessProfileSchema` refinement rejects it, so the builder must not construct the invalid intermediate); a probe that throws yields "not installed" rather than propagating; and `detail` is redacted and carries no credential material. ACP has no external status command — availability comes from the negotiation.

- [ ] **Step 5: Implement the classifier, probes, and profile builder**

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @autostack/agent-acp check
pnpm --filter @autostack/agent-acp test:coverage
git diff --check
git status --short
git add packages/agent-acp pnpm-lock.yaml
git commit -m "feat(agent-acp): negotiate capabilities and classify provider failures"
```

---

## Task 5: Normalize the ACP session into the contract event stream

**Files:**

- Create: `packages/agent-acp/src/{acp-event-mapper,acp-harness}.ts`
- Test: `packages/agent-acp/test/{acp-event-mapper,acp-harness}.test.ts`

- [ ] **Step 1: Add failing mapper tests**

Replay each Task 1 transcript and assert the exact normalized sequence. Cover: `agent_message_chunk` → `message`; `agent_thought_chunk` → `thought_summary`; `plan` → `plan` (only when `structuredPlans`); `tool_call`/`tool_call_update` → `tool_call` with `started`/`completed`/`failed` phases sharing one `toolCallRef`; file edits → `file_change` with a relativized path and a `diffDigest` from the sink; `session/request_permission` → `permission_requested` with the offered options including at least one denial; the decision → `permission_resolved`; the turn end → `completed` with at least one evidence digest.

Assert D-3 explicitly: for the `requests_permission` transcript, no `tool_call` of any phase appears before `permission_resolved`, and a `tool_call` with phase `started` appears immediately after it.

Security invariants at this layer: an absolute or `..`-escaping path becomes an `output` event, never a `file_change`; stderr frames become `output` events; provider text is redacted per D-4.

Usage honesty: ACP reports no token or cost figures, so `usage` carries `{ state: "unknown" }` for every figure. Assert directly that no code path can substitute a zero (finding 15 — a unit assertion on the usage builder, not a mutant subject).

- [ ] **Step 2: Implement the mapper**

Pure functions from one provider frame plus session state to zero or more events. Every produced event goes through `AgentSessionStreamEventSchema.parse` before it leaves; a parse failure becomes `provider_output_malformed`, keeping the fail-closed rule from turning a bad frame into a thrown exception at the port.

- [ ] **Step 3: Add failing harness tests**

Prove the port surface: `start()` runs to a terminal; `steer()` rejects with an `Error` when the profile denies steering, and otherwise sends the instruction **and emits a `message` event with `role: "user"` carrying it** (D-7); `cancel()` sends `session/cancel`, waits a bounded interval, terminates the process tree, and yields exactly one `cancelled` terminal and never a `completed`; `resume()` rejects when denied and otherwise issues `session/load` under the same AutoStack `sessionId` with sequence numbers above the last allocated; `respondToPermission()` rejects a foreign `permissionRef`, a stale evidence digest, a second decision on a settled permission, and any decision after disposal, and otherwise releases the gated side effect; `dispose()` is idempotent and makes every subsequent operation reject; abandoning the stream leaves the harness usable (finding 14).

- [ ] **Step 4: Implement the harness**

Compose sequencer, mapper, classifier, and child session behind `AgentHarnessPort`. Use `admitAgentPermissionResponse` from `@autostack/contracts` rather than re-deriving the admission rules.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-acp check
pnpm --filter @autostack/agent-acp test:coverage
git diff --check
git status --short
git add packages/agent-acp
git commit -m "feat(agent-acp): normalize ACP sessions into the contract event stream"
```

---

## Task 6: Pass the conformance suite against a fixture ACP agent

**Files:**

- Create: `packages/agent-acp/test/fixtures/{acp-agent.mjs,conformance.ts}`
- Test: `packages/agent-acp/test/acp-harness.conformance.test.ts`

- [ ] **Step 1: Write the fixture agent**

A Node script taking a transcript path and scenario on `argv`, speaking ACP over stdio and replaying the transcript: emits frames, writes `emitStderr` frames to stderr, blocks on `awaitStdin` until the matching client frame arrives, and exits as scripted. It is a real child process, so the adapter runs against a real macrotask transport. It carries no knowledge of the conformance suite.

Scenario obligations it must genuinely satisfy:

- `completes` — one `completed`, at least one `usage` event with at least one `{ state: "unknown" }` figure.
- `pauses` — emit, then block indefinitely until steered or cancelled.
- `requests_permission` — emit `permission_requested` offering an allow and a deny option, then block; gate the `tool_call`, the `file_change`, and the terminal behind the decision (D-3).
- `fails` — terminate with a JSON-RPC error, classified identically on every replay.
- `interrupted` — emit an evidence-bearing event, then die by signal with no error frame, so the adapter mints `interrupted` and ends without a lifecycle terminal (D-2).

- [ ] **Step 2: Build the conformance fixture**

Implement `AgentHarnessConformanceFixture`, minting the invocation, steer, cancel, resume, and permission-response envelopes, and supplying the kit's honest `quiesce()`. `createFullCapabilityHarness` launches the agent in full-negotiation mode; `createMinimalCapabilityHarness` in the mode advertising nothing. `dispose()` tears the child down and is idempotent.

- [ ] **Step 3: Run the suite under both runners**

```ts
describeAgentHarnessConformance("agent-acp (in process)", acpConformanceFixture);
describeAgentHarnessConformance(
  "agent-acp (macrotask deferred)",
  deferFixture(acpConformanceFixture)
);
```

The macrotask wrapper (from the kit's `conformance-support.ts`, mirroring `packages/domain/test/fixtures/async-agent-harness.ts`) is the standing guard against a `quiesce()` calibrated to a fixed number of turns rather than to the transport.

```bash
pnpm --filter @autostack/agent-acp test -- acp-harness.conformance.test.ts
```

Expected failure: the fixture does not exist; then each behaviour in turn until Tasks 4 and 5 satisfy it.

- [ ] **Step 4: Guard against a vacuous pass**

Keep exactly one mutant: a subject whose `quiesce()` resolves immediately, asserted to fail the pause-dependent behaviours. The descriptor-honesty, fabricated-usage, and raw-`-32601` cases are covered by direct unit assertions in Tasks 3–5 instead of fake subjects (finding 15). Additionally, run the pause and permission behaviours **20 times** to catch a transport that is only usually well-behaved (finding 11).

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-acp check
pnpm --filter @autostack/agent-acp test:coverage
git diff --check
git status --short
git add packages/agent-acp
git commit -m "test(agent-acp): pass the agent harness conformance suite"
```

---

## Task 7: Map the Claude Code stream-json session

**Files:**

- Create: `packages/agent-claude/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/agent-claude/src/{claude-launch-profile,claude-frames,claude-event-mapper,claude-failures,index}.ts`
- Test: `packages/agent-claude/test/{claude-launch-profile,claude-frames,claude-event-mapper,claude-failures}.test.ts`

- [ ] **Step 1: Add failing launch-profile tests**

Two real profiles, each with its own `adapterId` and descriptor:

| Profile                 | argv                                                                                                               | resume  | steering | permissions |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- | -------- | ----------- |
| `claude-code.streaming` | `-p --output-format stream-json --input-format stream-json --verbose --session-id <uuid> --permission-mode manual` | `true`  | `true`   | `true`      |
| `claude-code.batch`     | `-p --output-format stream-json --verbose`                                                                         | `false` | `false`  | `false`     |

Prove the argv is array-built with no shell string; that the objective is passed as an argument or on stdin, never interpolated into a flag; that `--session-id` is a UUID the adapter mints, so provider session identity is pinned rather than discovered; that the batch profile's harness has no `respondToPermission` property; that `selection` is derived from `--model` and `--effort` (D-9); and that the environment is the D-5 allowlist with Claude's documented auth variables from Task 1.

- [ ] **Step 2: Implement the profiles**

- [ ] **Step 3: Add failing frame and mapper tests**

Replay the Task 1 transcripts. Map: `system`/`init` → `started` with `providerSessionRef` set to the pinned session id; assistant text blocks → `message`; assistant tool-use blocks → `tool_call` phase `started`, **subject to D-3** — suppressed until an approval-gated call is permitted; `user` tool results → `tool_call` phase `completed`/`failed` under the same `toolCallRef`; thinking blocks → `thought_summary`; file-editing tool results → `file_change` with a relativized path; `result` → `completed` plus a `usage` event.

Usage honesty: `input_tokens`, `output_tokens`, and the cache figures map to `{ state: "reported" }`; reasoning tokens map to `{ state: "unknown" }` because the CLI does not report them; `total_cost_usd` maps to `{ state: "reported", currency: "USD", micros }` when present and `{ state: "unknown" }` otherwise. Assert directly that no path fabricates a zero.

- [ ] **Step 4: Add failing failure-classification tests**

Under D-2's discriminator, this table classifies only the `failed` branch:

| Provider signal                                               | Code                        | `retryable` |
| ------------------------------------------------------------- | --------------------------- | ----------- |
| `result.subtype: "error_max_turns"`                           | `provider_turn_limit`       | `false`     |
| `result.subtype: "error_during_execution"`                    | `provider_execution_error`  | `true`      |
| unknown `result.subtype` with `is_error`                      | `provider_error`            | `false`     |
| exit with a `result` carrying `is_error` and no known subtype | `harness_child_exited`      | `true`      |
| unparseable stdout line                                       | `provider_output_malformed` | `false`     |

Plus the D-2 cases: signal death after evidence → `interrupted`, no terminal; death before any event → `failed` with `harness_child_exited`. Include the untrusted-text test: an `error_max_turns` result whose text says "temporary, retry" still classifies `retryable: false`.

- [ ] **Step 5: Implement the mapper and classifier**

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @autostack/agent-claude check
pnpm --filter @autostack/agent-claude test:coverage
git diff --check
git status --short
git add packages/agent-claude pnpm-lock.yaml
git commit -m "feat(agent-claude): map the Claude Code stream-json session"
```

---

## Task 8: Steer, decide permissions, cancel, and resume a Claude session

**Files:**

- Create: `packages/agent-claude/src/{claude-control-channel,claude-harness,availability}.ts`
- Test: `packages/agent-claude/test/{claude-control-channel,claude-harness,availability}.test.ts`

- [ ] **Step 1: Add failing control-channel tests**

Implement whichever permission channel Task 1 Step 4 established. Prove: a permission request becomes `permission_requested` with the CLI's offered options plus a denial option; the decision is written back and produces `permission_resolved`, with the gated `tool_call` emitting only afterwards (D-3); a foreign `permissionRef`, a stale evidence digest, a second decision on a settled permission, and a decision after disposal each reject; and the gated side effect stays unobserved until the decision lands.

Steering: on the streaming profile, `steer()` writes a user message to stdin **and emits a `message` event with `role: "user"`** (D-7). On the batch profile it rejects with an `Error` and leaves the session running to its normal terminal.

- [ ] **Step 2: Implement the control channel**

- [ ] **Step 3: Add failing cancellation and resume tests**

Cancellation follows spec §15: graceful signal, bounded wait, process-tree termination, partial evidence recorded, exactly one `cancelled` terminal, never a `completed`. A second `cancel()` after the terminal is a no-op or a clean rejection, never a hang.

Resume runs `--resume <pinned session id>` as a fresh child continuing the provider's own session, asserting continuity: the same AutoStack `sessionId` on every event, sequence numbers above the last allocated, and the same `providerSessionRef`. Assert the adapter never replays a transcript into a new session and calls it a resume (spec §9.1): the resume argv contains `--resume` and no `--fork-session`, and the original objective is not re-sent. **If Task 1's recorded pair showed a new session id, `resume` is declared `false` and this step becomes an escalation, not a workaround (D-8).**

- [ ] **Step 4: Implement the harness and availability probes**

The production probe runs `claude auth status` as `executable` + `args` under a bounded timeout, reads its exit status, and passes any surfaced output through redaction; it never reads `~/.claude` (D-6). Unit tests inject the probe and never spawn the real CLI.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-claude check
pnpm --filter @autostack/agent-claude test:coverage
git diff --check
git status --short
git add packages/agent-claude
git commit -m "feat(agent-claude): steer, decide, cancel, and resume a session"
```

---

## Task 9: Pass the conformance suite for Claude Code

**Files:**

- Create: `packages/agent-claude/test/fixtures/{claude-agent.mjs,conformance.ts}`
- Test: `packages/agent-claude/test/claude-harness.conformance.test.ts`

- [ ] **Step 1: Write the fixture CLI**

A Node script impersonating `claude -p --output-format stream-json`, replaying a Task 1 transcript over real stdio and honouring the stdin control channel. It asserts nothing about the adapter; it only speaks the recorded protocol.

- [ ] **Step 2: Build the fixture and run both runners**

`createFullCapabilityHarness` uses the streaming profile; `createMinimalCapabilityHarness` the batch profile. Supply the kit's honest `quiesce()`, run `describeAgentHarnessConformance` in process and macrotask-deferred, and repeat the pause and permission behaviours 20 times.

```bash
pnpm --filter @autostack/agent-claude test -- claude-harness.conformance.test.ts
```

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/agent-claude check
pnpm --filter @autostack/agent-claude test:coverage
git diff --check
git status --short
git add packages/agent-claude
git commit -m "test(agent-claude): pass the agent harness conformance suite"
```

---

## Task 10: Codex launch profiles, JSON-RPC client, and failure classification

**Files:**

- Create: `packages/agent-codex/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/agent-codex/src/{codex-launch-profile,codex-jsonrpc,codex-failures,index}.ts`
- Test: `packages/agent-codex/test/{codex-launch-profile,codex-jsonrpc,codex-failures}.test.ts`

- [ ] **Step 1: Add failing launch-profile tests**

| Profile            | argv                      | resume  | steering | permissions |
| ------------------ | ------------------------- | ------- | -------- | ----------- |
| `codex.app-server` | `app-server`              | `true`  | `true`   | `true`      |
| `codex.exec`       | `exec --json <objective>` | `false` | `false`  | `false`     |

The app-server profile is full because the protocol genuinely provides `thread/resume`, `turn/steer`, `turn/interrupt`, and approval requests. The `exec` profile declares `resume: false` deliberately: continuing an `exec` run means a new process, which would be emulated resume (spec §9.1). Prove the argv is array-built; that `--dangerously-bypass-approvals-and-sandbox` and `--dangerously-bypass-hook-trust` appear in no profile; that `selection` derives from `-m/--model` and the reasoning-effort override (D-9); and that the environment is the D-5 allowlist with Codex's documented auth variables.

Record in the module doc that `codex app-server` is marked `[experimental]` by the CLI (finding 18), so a future CLI upgrade breaking the full profile is a known, named risk rather than a surprise.

- [ ] **Step 2: Add failing JSON-RPC client tests**

Request/response correlation by id; concurrent in-flight requests resolved to the right callers; notifications routed without a response; a response to an unknown id ignored with a classified diagnostic rather than a throw; a server-initiated approval request answered on the same channel; and `close()` rejecting every in-flight request rather than leaving them pending.

- [ ] **Step 3: Add failing classification tests**

Reuse the kit's JSON-RPC table — Codex app-server is JSON-RPC, so the `-32601` obligation applies identically — plus `ErrorNotification` → `provider_execution_error` (`true`) and turn interruption → `cancelled`, not `failed`. Apply D-2's discriminator to app-server process loss.

- [ ] **Step 4: Implement the profiles, client, and classifier**

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @autostack/agent-codex check
pnpm --filter @autostack/agent-codex test:coverage
git diff --check
git status --short
git add packages/agent-codex pnpm-lock.yaml
git commit -m "feat(agent-codex): launch profiles and the app-server JSON-RPC client"
```

---

## Task 11: Normalize the Codex session and expose the harness

**Files:**

- Create: `packages/agent-codex/src/{codex-event-mapper,codex-harness,availability}.ts`
- Test: `packages/agent-codex/test/{codex-event-mapper,codex-harness,availability}.test.ts`

- [ ] **Step 1: Add failing mapper tests**

Replay the Task 1 app-server transcript. Map `initialize` → capabilities; `thread/start` → `started` with `providerSessionRef` set to the thread id; agent message deltas → `message`; reasoning deltas → `thought_summary`; the plan notification → `plan`; command and file-change items → `tool_call` and `file_change`, gated per D-3 behind their approval; approval requests → `permission_requested`; the token-usage notification → `usage` with reported token figures and `{ state: "unknown" }` cost, since the protocol reports tokens and not dollars; `turn/completed` → `completed`.

Also map the `exec --json` transcript for the minimal profile.

- [ ] **Step 2: Add failing harness and probe tests**

The same port-surface assertions as Task 5 Step 3, against Codex: `turn/steer` for steering with the D-7 `message` echo; `turn/interrupt` for cancellation; `thread/resume` for resume with the D-8 identity proof and sequence continuity; approval responses on the JSON-RPC channel; `dispose()` idempotent and terminal; stream abandonment leaving the harness usable.

The production probe runs `codex login status` as `executable` + `args` under a bounded timeout and never reads `~/.codex` (D-6).

- [ ] **Step 3: Implement the mapper, harness, and probes**

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/agent-codex check
pnpm --filter @autostack/agent-codex test:coverage
git diff --check
git status --short
git add packages/agent-codex
git commit -m "feat(agent-codex): normalize Codex sessions into the contract event stream"
```

---

## Task 12: Pass the conformance suite for Codex

**Files:**

- Create: `packages/agent-codex/test/fixtures/{codex-agent.mjs,conformance.ts}`
- Test: `packages/agent-codex/test/codex-harness.conformance.test.ts`

- [ ] **Step 1: Write the fixture app-server**

A Node script speaking the recorded app-server JSON-RPC over stdio, with a full-capability mode and a mode behaving as `codex exec --json` for the minimal subject.

- [ ] **Step 2: Run both runners and satisfy every behaviour**

Including the 20-times repeat of the pause and permission behaviours.

```bash
pnpm --filter @autostack/agent-codex test -- codex-harness.conformance.test.ts
```

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/agent-codex check
pnpm --filter @autostack/agent-codex test:coverage
git diff --check
git status --short
git add packages/agent-codex
git commit -m "test(agent-codex): pass the agent harness conformance suite"
```

---

## Task 13: Live smoke behind `AUTOSTACK_LIVE_HARNESS_SMOKE=1`

**Files:**

- Create: `packages/agent-{acp,claude,codex}/test/live-smoke.test.ts`

- [ ] **Step 1: Add the skip semantics test first**

Prove the smoke is skipped **visibly**: without the flag, or with the flag but no CLI on PATH, the test reports a skip with a stated reason. Assert the guard never silently passes — a test body that never ran must not report green. Assert the guard function's return value directly in an always-running test.

- [ ] **Step 2: Drive the real CLIs on a disposable repository**

Create a temp repo with `mktemp -d` + `git init` + one file, asserting in the test that the path is not the AutoStack checkout. Drive a trivial objective end to end, assert the stream reaches a `completed` terminal with a usage event, assert the child is reaped and no orphan remains, and delete the temp repo in a `finally`. Exercise the D-6 spawning probes here — this is the only place they run for real. Record the observed CLI versions in the stream report as required evidence.

- [ ] **Step 3: ACP fixture-agent smoke**

The same end-to-end path against the shipped fixture agent, running unconditionally because it has no external dependency.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @autostack/agent-claude test
pnpm --filter @autostack/agent-codex test
AUTOSTACK_LIVE_HARNESS_SMOKE=1 pnpm --filter @autostack/agent-claude test -- live-smoke.test.ts
AUTOSTACK_LIVE_HARNESS_SMOKE=1 pnpm --filter @autostack/agent-codex test -- live-smoke.test.ts
git diff --check
git status --short
git add packages/agent-acp packages/agent-claude packages/agent-codex
git commit -m "test(agent-adapters): add the flagged live harness smoke"
```

---

## Task 14: Stream gates and final self-review

- [ ] **Step 1: Run the full gate suite from the worktree root**

```bash
pnpm format:check
pnpm check
pnpm build --filter='!@autostack/desktop'
pnpm --filter @autostack/agent-adapter-kit test:coverage
pnpm --filter @autostack/agent-acp test:coverage
pnpm --filter @autostack/agent-claude test:coverage
pnpm --filter @autostack/agent-codex test:coverage
pnpm test
```

Coverage must be at or above 80% on statements, branches, functions, and lines for all four owned packages. The known pre-existing `runner-local` flake may be re-run once and must be noted if it trips.

- [ ] **Step 2: Self-review pass**

Confirm by reading the diff rather than by recollection: no TODO or placeholder code; no disabled or skipped tests except the live smoke's documented visible skip; no `any`, non-null assertion, or validation bypass; no shell string in any spawn path; no redaction applied to a byte stream (D-4); no environment value read into a scanned, logged, or compared position (D-5); no credential material in any fixture; no file touched outside the four owned packages and this plan document; and no orphaned process after the suite, checked with a process probe.

- [ ] **Step 3: Write the stream report and request merge review**

Update `.superpowers/sdd/stream-report.md` and `.superpowers/sdd/progress.md`, then report `MERGE_READY` with the head SHA, the gate output summary, and the live-smoke evidence. Do not push (stream-lead protocol, Push policy).

---

## Completion evidence

Stream S2 is complete only when the committed evidence demonstrates all of the following:

- All three adapters pass `describeAgentHarnessConformance` unmodified, under both an in-process and a macrotask-deferred runner, against fixture provider processes that are real child processes.
- `quiesce()` is separately proven honest: it reports a session paused only when the transport is genuinely idle, follows a child that emits only after a poll-phase read, and holds under a 20-times repeat of the pause and permission behaviours.
- Transcript fixtures cover normal completion, permission round trip, cancellation mid-stream, provider error, host loss, and malformed provider output — the last classified, not crashed — and each carries provenance including the recorded CLI version and its stability.
- Interruption and failure are separated by the D-2 discriminator in all three adapters, with `interrupted` ending the stream with no lifecycle terminal.
- Every `failed.code` satisfies `^[a-z][a-z0-9_]{0,63}$`, determines its own `retryable` value, and is derived only from enumerated structured provider fields; JSON-RPC `-32601` is mapped, never passed through.
- No approval-gated call surfaces a `tool_call` before its decision (D-3).
- Redaction is applied per field after parse and never to a byte stream (D-4); ambient auth is an opaque key-copy whose values appear in no output (D-5).
- Capability declarations are honest per launch profile: no adapter implements `respondToPermission` without declaring `permissions`, none emits a `plan` without declaring `structuredPlans`, none emulates resume, and `selection` is derived per provider (D-9).
- `isInstalled()` and `isAuthenticated()` fail closed, are probe-injected in unit tests, and in production run only the CLI's own status command — never a config-file read (D-6).
- Live smoke passes locally for the installed `claude` and `codex` CLIs on a disposable temp repository, with the observed CLI versions recorded; the ACP fixture-agent smoke is green.
- `pnpm format:check`, `pnpm check`, `pnpm build --filter='!@autostack/desktop'`, and `pnpm test` are green, with ≥80% coverage on `agent-adapter-kit`, `agent-acp`, `agent-claude`, and `agent-codex`.

## Primary implementation references

- <https://agentclientprotocol.com>
- <https://docs.claude.com/en/docs/claude-code/cli-reference>
- <https://github.com/openai/codex>
