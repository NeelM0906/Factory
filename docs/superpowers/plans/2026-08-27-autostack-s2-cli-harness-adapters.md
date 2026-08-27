# AutoStack CLI Harness Adapters Implementation Plan (Stream S2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `packages/agent-acp`, `packages/agent-claude`, and `packages/agent-codex` — three `AgentHarnessPort` implementations that supervise their provider CLI as a child process over stdio, normalize its protocol into `AgentSessionStreamEvent`, declare only the capabilities their configured provider profile genuinely has, classify every failure into the workflow-failure alphabet, and pass `describeAgentHarnessConformance` unmodified against fixture provider processes replaying transcripts recorded from the real CLIs.

**Architecture:** Each adapter is a thin protocol mapper over a shared session supervisor. The supervisor owns one long-lived child (`executable` + `args`, never a shell string), a line-delimited frame reader on stdout, a bounded writer on stdin, process-tree termination, and an honest `quiesce()` that reports idleness only when no byte, frame, or event is in flight. Above it sit three per-provider layers: a **launch profile** (which provider mode to run, and therefore which capabilities the descriptor may declare), a **frame mapper** (provider frame → zero or more normalized events, sequence-allocated and schema-validated at the boundary), and a **failure classifier** (enumerated structured provider fields → a `^[a-z][a-z0-9_]{0,63}$` code, never free text). The supervisor starts inside `packages/agent-acp` and moves to `packages/agent-adapter-kit` at the second consumer, exactly as the charter requires. Conformance runs the real adapter against a checked-in fixture provider process, so the transport under test is a real child process on a real macrotask boundary; the real CLIs appear only in the flagged live smoke.

**Tech Stack:** Node.js 24 LTS (local 26); TypeScript 5.9 strict; pnpm 10.27; Zod 4; Vitest 4; Claude Code CLI 2.1.228; Codex CLI 0.150.1; ACP JSON-RPC 2.0 over stdio.

**Spec:** `docs/superpowers/specs/2026-08-20-autostack-design.md` — §9.1 (normalized adapter contract), §9.2 (Codex and Claude Code), §9.3 (ACP), §14.1 (trust boundaries), §14.3 (secrets), §15 (failure handling).

**Charter:** `docs/superpowers/plans/2026-08-26-autostack-milestone-a-parallel.md` "Stream S2" + `.superpowers/sdd/dispatch-s2.md`.

**Contract map:** `docs/development/milestone-a-contract-audit.md` §§1–5.

**Global Constraints:**

- TypeScript strict; no unchecked `any`, non-null assertions, disabled tests, placeholder/TODO implementations, or validation bypasses.
- Every process invocation is `executable` + `args`. Never shell command strings, `exec`, `spawn(..., { shell: true })`, or `/bin/sh -c`.
- Every event leaving an adapter parses through `AgentSessionStreamEventSchema` before it is yielded. A frame that cannot be mapped to a valid event is a classified failure, never a crash and never a silently dropped frame.
- `failed.code` is minted from enumerated, structured provider fields only (JSON-RPC `error.code`, Claude `result.subtype`, process exit status). Never from provider prose: provider output is untrusted input (spec §14.1) and retryability is a policy branch.
- Provider text is redacted through `@autostack/runner-local`'s public streaming redactor before it becomes event text; `SafeMetadataStringSchema` is the fail-closed backstop, not the first line of defence.
- Adapters use the user's ambient CLI authentication by letting the child inherit the specific variables that authentication needs. They never read, copy, persist, or log credential material, and never inspect `~/.claude` or `~/.codex`.
- `file_change.path` is relativized against the invocation `cwd` and validated by `RelativeWorkspacePathSchema`. A provider-reported path outside the workspace is reported as `output`, never as a `file_change`.
- No emulated resume (spec §9.1). `resume` is declared only where the provider itself continues the session under a stable identity.
- An adapter that does not declare `capabilities.permissions` must not have a `respondToPermission` property at all.
- 80% coverage floor (statements, branches, functions, lines) on every package this stream owns.
- Tests inject clocks, id factories, executable resolvers, and temp dirs. Live tests use disposable temp repositories, never the AutoStack checkout.
- No pushes to origin (stream-lead protocol, Push policy). Commit locally, per task, conventional-commit style.
- Do not modify `packages/contracts`, `packages/domain`, `packages/runner-local`, another stream's packages, root config, or CI. Any need to is an escalation.

**Open escalations (see `.superpowers/sdd/stream-report.md` for the full text):**

- **E-1 — BLOCKING for Task 2.** runner-local exposes no public child-process supervisor. Public surface is redaction (`redacted-transcript.ts`), path confinement (`path-policy.ts`), `darwin-process-signals.ts`, and the `pty.ts` _types_. The one close implementation, `src/process-runner.ts` (`BoundedProcessRunner`), is private **and** unsuitable — it buffers all output, resolves once at exit, and ignores stdin. `CommandExecutor` is PTY-, guardian-child-, worktree-, and darwin-arm64-bound. There is no NDJSON stdout reader anywhere in the repo. This plan is written for **Option B** (S2 implements the supervisor, modelled on but not copied from `process-runner.ts`, importing runner-local's public redaction and signal exports). Tasks 2 and 6 are the only tasks that change if the orchestrator prefers **Option A** (a public streaming stdio supervisor added to runner-local on the base branch).
- **E-2 — confirm before Task 3.** Capability honesty with two launch profiles per adapter. The conformance fixture requires one subject declaring `resume`/`steering`/`permissions` all true and one declaring all three false, while a real adapter ships one descriptor. Resolution taken here: the descriptor is a function of the **configured launch profile**, and both profiles are real supported provider modes — never an invented degradation. Each profile gets its own `adapterId`.
- **E-3 — confirm before Task 4.** Evidence digests. `completed.evidenceDigests`, `interrupted.evidenceDigests`, and `permission_requested.evidenceDigest` are all required, so adapters must produce content digests. This plan defines a narrow injected `AgentEvidenceSink` port in the kit rather than depending on `ArtifactStore` directly, so the agent packages stay composition-agnostic and unit-testable. Confirm no other stream is already minting this port.
- **E-4 — non-blocking.** The charter says create `packages/agent-adapter-kit` "when the second consumer appears, not before." The supervisor is needed by consumer one. This plan follows the charter literally (build in `agent-acp`, relocate in Task 6). If the orchestrator prefers, Task 6 can move to the front and Task 2 can author the kit directly.

---

## Task 1: Record the three provider protocols into checked-in transcript fixtures

**Files:**

- Create: `packages/agent-acp/test/fixtures/transcripts/README-provenance.json`
- Create: `packages/agent-claude/test/fixtures/transcripts/*.json`
- Create: `packages/agent-codex/test/fixtures/transcripts/*.json`

Nothing in this task is TDD; it is evidence gathering whose output every later task replays. Fixtures are data, and their provenance travels with them.

- [ ] **Step 1: Capture Claude Code stream-json transcripts**

In a disposable temp repository (`mktemp -d`, `git init`, one trivial file — never the AutoStack checkout), record real sessions with:

```bash
claude -p "<objective>" \
  --output-format stream-json --input-format stream-json --verbose \
  --session-id <uuid> --permission-mode manual --add-dir <tmp>
```

Capture five scenarios: normal completion; a permission round trip; cancellation mid-stream; a provider error; and malformed output (inject a corrupt line into a copy of a real transcript rather than provoking one). Record the exact `argv`, the CLI version, the recording timestamp, and every stdout line verbatim.

Settle these open questions and write the answers into the fixture provenance:

- How a permission decision is requested and answered in `-p` streaming mode. `--permission-prompt-tool` is absent from 2.1.228's `--help`; `--permission-mode manual` is present. Determine whether the CLI emits a control request on stdout and accepts a control response on stdin, or whether an MCP permission-prompt server via `--mcp-config` is the only channel. **If neither channel exists, the Claude adapter cannot honestly declare `permissions: true`, cannot supply a full-capability subject, and cannot pass the suite — stop and escalate rather than faking it.**
- Whether `--resume <id>` reuses the original session id (the existence of `--fork-session`, "create a new session ID instead of reusing the original", is strong evidence that it does). Confirm from a real transcript pair.
- What `result.subtype` values the CLI actually emits, and which `usage` figures it reports. Reasoning tokens are expected to be absent, which is what supplies conformance behaviour 8's required `{ state: "unknown" }` figure.

- [ ] **Step 2: Capture Codex transcripts for both profiles**

Record `codex app-server` (JSON-RPC over stdio) driving `initialize` → `thread/start` → `turn/start`, plus `turn/steer`, `turn/interrupt`, `thread/resume`, an approval request, and `thread/tokenUsage/updated`. The protocol schema is authoritative and machine-readable:

```bash
codex app-server generate-json-schema --out <dir>
```

Record `codex exec --json` separately as the minimal profile. Capture the same five scenarios for the app-server profile and the four non-permission scenarios for `exec`.

- [ ] **Step 3: Author the ACP transcripts**

No ACP agent is installed, so these are authored against the protocol rather than recorded: `initialize` capability negotiation, `session/new`, `session/prompt`, `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `plan`, `tool_call`, `tool_call_update`), `session/request_permission`, `session/cancel`, and `session/load`. Author two negotiation results — one advertising `loadSession` and permission support, one advertising neither — because those are the two capability profiles Task 3 derives descriptors from. Mark provenance `"authored"`, not `"recorded"`, and cite the protocol version.

- [ ] **Step 4: Fix the fixture format**

Every transcript is one JSON document:

```ts
interface TranscriptFixture {
  readonly provenance: {
    readonly source: "recorded" | "authored";
    readonly cli: string; // "claude" | "codex" | "acp"
    readonly version: string; // CLI --version output, or the ACP protocol version
    readonly recordedAt: string; // ISO-8601
    readonly argv: readonly string[];
  };
  readonly scenario: "completes" | "pauses" | "requests_permission" | "fails" | "interrupted";
  readonly frames: readonly TranscriptFrame[];
}
```

A `TranscriptFrame` is either `{ emit: unknown }` (write this frame to stdout), `{ awaitStdin: { match: ... } }` (block until the client sends a matching frame), or `{ exit: { code: number | null; signal: string | null } }`. Scan every recorded transcript for credential material before checking it in; a transcript that trips `containsSensitiveMaterial` is re-recorded, never hand-edited.

- [ ] **Step 5: Commit**

```bash
git diff --check
git status --short
git add packages/agent-acp packages/agent-claude packages/agent-codex
git commit -m "test(agent-adapters): record the provider protocol transcripts"
```

---

## Task 2: Build the supervised stdio session inside `packages/agent-acp`

**Files:**

- Create: `packages/agent-acp/package.json`
- Create: `packages/agent-acp/tsconfig.json`
- Create: `packages/agent-acp/vitest.config.ts`
- Create: `packages/agent-acp/src/launch-config.ts`
- Create: `packages/agent-acp/src/child-session.ts`
- Create: `packages/agent-acp/src/line-frames.ts`
- Create: `packages/agent-acp/src/session-errors.ts`
- Create: `packages/agent-acp/src/index.ts`
- Test: `packages/agent-acp/test/launch-config.test.ts`
- Test: `packages/agent-acp/test/child-session.test.ts`
- Test: `packages/agent-acp/test/line-frames.test.ts`
- Test: `packages/agent-acp/test/fixtures/echo-child.mjs`

- [ ] **Step 1: Add failing launch-configuration tests**

The launch config is `executable` + `args` arrays and nothing else (spec §9.3). Tests must prove it rejects: a non-absolute executable; an executable containing a path separator that escapes after realpath; any shell metacharacter interpreted as such (the point is that none are — assert the child receives the argument verbatim); more than 256 arguments; an argument over 32 KiB; more than 128 environment entries; an environment name outside `/^[A-Za-z_][A-Za-z0-9_]*$/`; and an environment value that trips `containsSensitiveMaterial`. It must accept a config whose args contain spaces, quotes, `;`, and `$(...)` and prove via the echo child that they arrive as single literal arguments.

Run:

```bash
pnpm --filter @autostack/agent-acp test -- launch-config.test.ts
```

Expected failure: the package and `AcpLaunchConfigSchema` do not exist.

- [ ] **Step 2: Implement the launch configuration**

A `.strict()` Zod schema over `{ executable, args, cwd, environment }` with the bounds above. Document in the module that editing this configuration is permission to execute local code (spec §9.3) and is therefore a privileged operation for the surfaces that expose it; the schema is the enforcement point available at this layer.

- [ ] **Step 3: Add failing frame-reader tests**

The reader turns a byte stream into whole JSON values. Tests must prove: a frame split across three chunk boundaries reassembles; multiple frames in one chunk all emit, in order; `\r\n` and `\n` both terminate; a line over the configured byte cap yields a classified `frame_too_large` failure rather than unbounded buffering; invalid JSON yields a classified `frame_malformed` failure carrying no provider text; a trailing partial line at EOF is a classified failure, not a silently dropped frame; and the reader never emits a frame it has not fully received.

- [ ] **Step 4: Implement the frame reader**

A stateful reader over `Uint8Array` chunks with an explicit byte budget, decoding UTF-8 incrementally. It exposes `observedBytes` and `emittedFrames` counters — Step 6's quiesce reads them, so they are part of the module's contract, not diagnostics.

- [ ] **Step 5: Add failing child-session tests**

Against `test/fixtures/echo-child.mjs` (a tiny Node script, following the precedent of `packages/db/test/fixtures/*.mjs`), prove the supervisor:

- spawns with `shell: false`, `stdio: ["pipe", "pipe", "pipe"]`, `windowsHide: true`, `detached` on non-Windows, and only the supplied environment;
- delivers stdout frames in order and surfaces stderr separately;
- resolves `write()` only once the child has accepted the bytes;
- on `close()` sends SIGTERM, waits a bounded grace, escalates to SIGKILL of the **process group**, and resolves with an exit proof;
- reports a spawn failure as `launch_failed` and a child that exits before its terminal frame as `child_exited`, both without leaking the provider's message;
- is idempotent on repeated `close()`;
- enforces a total-runtime bound and a no-output-progress bound, each yielding a distinct classified failure;
- leaves no orphaned process after `close()` (assert by probing the pid and the group).

- [ ] **Step 6: Implement the child session and its honest quiesce**

Model the spawn flags, PGID kill escalation, and bounds on the private `packages/runner-local/src/process-runner.ts`; import redaction from `@autostack/runner-local`'s public `redacted-transcript` surface (`StreamingSecretRedactor`, `REDACTION_MARKER`) and signal validation from `darwin-process-signals`. Do not copy `process-runner.ts` — it is one-shot, buffered, and stdin-less, and this is a long-lived bidirectional session (see escalation E-1).

`quiesce()` is an honesty obligation the conformance suite cannot check, so it is specified precisely and tested directly:

```text
1. Await every outstanding stdin write callback.
2. Loop, recording (observedBytes, emittedFrames, deliveredEvents, exitReduced):
     await setImmediate
     continue while any counter changed since the previous turn,
       or framesEmittedButNotYetDelivered > 0,
       or the child has exited and the exit has not yet been reduced to a terminal event.
3. Require two consecutive no-change turns before resolving.
4. Bound the total turns; exceeding the bound throws — a transport that never idles is a defect,
   not a pause.
```

- [ ] **Step 7: Test the quiesce itself**

The suite cannot detect a lazy `quiesce()`, so this stream tests it directly. Prove that with a frame in flight — written by the child but not yet pulled by the consumer — `isPending` over an outstanding `next()` reports **false** (the frame is delivered), and that with the child deliberately silent it reports **true**. A `quiesce()` that returned an already-resolved promise fails the first assertion. Prove it also waits out a child that emits its frame after several event-loop turns.

- [ ] **Step 8: Verify and commit**

```bash
pnpm --filter @autostack/agent-acp check
pnpm --filter @autostack/agent-acp test:coverage
git diff --check
git status --short
git add packages/agent-acp package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(agent-acp): supervise an agent child over line-delimited stdio"
```

---

## Task 3: Negotiate ACP capabilities into an honest descriptor and profile

**Files:**

- Create: `packages/agent-acp/src/acp-protocol.ts`
- Create: `packages/agent-acp/src/acp-capabilities.ts`
- Create: `packages/agent-acp/src/acp-failures.ts`
- Create: `packages/agent-acp/src/availability.ts`
- Test: `packages/agent-acp/test/acp-capabilities.test.ts`
- Test: `packages/agent-acp/test/acp-failures.test.ts`
- Test: `packages/agent-acp/test/availability.test.ts`

- [ ] **Step 1: Add failing capability-negotiation tests**

Prove that the descriptor is derived from the `initialize` result and nothing else: an agent advertising `loadSession` and permission support yields `resume: true`, `permissions: true`; one advertising neither yields both `false`, **and the returned object has no `respondToPermission` property at all** (`expect("respondToPermission" in harness).toBe(false)`). Prove `structuredPlans` follows the agent's advertised prompt capabilities and that an adapter with `structuredPlans: false` never emits a `plan` event even when the fixture agent sends one — the frame becomes an `output` event instead. Prove an unparseable or absent `initialize` result fails closed to the minimal descriptor rather than optimistically declaring capabilities.

Run:

```bash
pnpm --filter @autostack/agent-acp test -- acp-capabilities.test.ts
```

Expected failure: `negotiateAcpCapabilities` does not exist.

- [ ] **Step 2: Implement negotiation**

Parse the `initialize` result with a `.strict()` schema, map advertised capabilities to `AgentHarnessCapabilities`, and build the harness object so the responder method is conditionally spread — never defined-then-thrown. Give each profile a distinct `adapterId` (`acp.negotiated.full`, `acp.negotiated.minimal` are placeholders; use the agent's advertised name where it is a valid `StableRef`, falling back to a fixed literal).

- [ ] **Step 3: Add failing failure-classification tests**

This is the contract obligation the dispatch calls out by name. Table-drive it and assert both the code and its retryability, and that no code equals its message:

| Provider signal                       | `failed.code`                 | `retryable`           |
| ------------------------------------- | ----------------------------- | --------------------- |
| JSON-RPC `-32700`                     | `provider_protocol_invalid`   | `false`               |
| JSON-RPC `-32600`                     | `provider_protocol_invalid`   | `false`               |
| JSON-RPC `-32601`                     | `provider_method_unsupported` | `false`               |
| JSON-RPC `-32602`                     | `provider_request_rejected`   | `false`               |
| JSON-RPC `-32603`                     | `provider_internal_error`     | `true`                |
| JSON-RPC `-32000`…`-32099`            | `provider_error`              | `true`                |
| ACP auth-required error               | `provider_unauthenticated`    | `false`               |
| any other numeric code                | `provider_error`              | `false` (fail closed) |
| spawn failed                          | `harness_launch_failed`       | `true`                |
| child exited before a terminal frame  | `harness_child_exited`        | `true`                |
| unparseable frame                     | `provider_output_malformed`   | `false`               |
| runtime or no-progress bound exceeded | `provider_timeout`            | `true`                |

Every code must satisfy `^[a-z][a-z0-9_]{0,63}$`; assert that property over the whole table rather than per row. Prove classification reads only `error.code` — feed two errors with identical codes and wildly different `message` text and assert identical classification, and feed an error whose message says `"rate limited, please retry"` under a non-retryable code and assert `retryable: false`.

- [ ] **Step 4: Implement the classifier**

A frozen lookup table plus a fail-closed default. Follow the repo's error convention (`packages/runner-local/src/local-runner-provider-error.ts`): a fixed message table, a `code` field, the underlying failure retained as a non-enumerable `cause`, `Object.freeze(this)`, and no caller-controlled provenance in the message.

- [ ] **Step 5: Add failing availability-probe tests**

`isInstalled()` and `isAuthenticated()` take injected probes and never spawn a real CLI in unit tests. Prove: a missing executable yields `installed: false, authenticated: false`; a probe reporting an unauthenticated agent yields `installed: true, authenticated: false`; `authenticated: true` with `installed: false` is impossible (the `AgentHarnessProfileSchema` refinement rejects it, so the builder must too); a probe that throws yields "not installed" rather than propagating; and the optional `detail` is redacted and never carries credential material.

- [ ] **Step 6: Implement the probes and profile builder**

Build an `AgentHarnessProfile`, parsing through `AgentHarnessProfileSchema`. `permissionModes` stays empty whenever `capabilities.permissions` is false — the schema refinement enforces it, and the builder must not construct the invalid intermediate.

- [ ] **Step 7: Verify and commit**

```bash
pnpm --filter @autostack/agent-acp check
pnpm --filter @autostack/agent-acp test:coverage
git diff --check
git status --short
git add packages/agent-acp
git commit -m "feat(agent-acp): negotiate capabilities and classify provider failures"
```

---

## Task 4: Normalize the ACP session into the contract event stream

**Files:**

- Create: `packages/agent-acp/src/event-sequencer.ts`
- Create: `packages/agent-acp/src/evidence-sink.ts`
- Create: `packages/agent-acp/src/acp-event-mapper.ts`
- Create: `packages/agent-acp/src/acp-harness.ts`
- Test: `packages/agent-acp/test/event-sequencer.test.ts`
- Test: `packages/agent-acp/test/acp-event-mapper.test.ts`
- Test: `packages/agent-acp/test/acp-harness.test.ts`

- [ ] **Step 1: Add failing sequencer tests**

Prove sequence numbers are positive, strictly increasing, allocated per AutoStack session, and **survive the stream ending** — a `start()` stream that is abandoned after two events, followed by `resume()`, continues above the last allocated number (conformance behaviour 6 asserts exactly this). Prove nothing is emitted after a lifecycle terminal, and that `interrupted` is not a terminal but does end the stream.

- [ ] **Step 2: Implement the sequencer and the evidence sink port**

The sequencer is a small per-session allocator plus a terminal latch. `AgentEvidenceSink` is the narrow injected port (escalation E-3):

```ts
export interface AgentEvidenceSink {
  record(input: {
    readonly kind: "transcript" | "diff" | "plan" | "permission";
    readonly bytes: Uint8Array;
  }): Promise<{ readonly digest: string }>;
}
```

The agent packages never import `ArtifactStore`; composition binds this to it later. Tests use an in-memory sink that SHA-256s its input.

- [ ] **Step 3: Add failing mapper tests**

Replay each Task 1 transcript through the mapper and assert the exact normalized sequence. Cover: `agent_message_chunk` → `message`; `agent_thought_chunk` → `thought_summary`; `plan` → `plan` (only when `structuredPlans`); `tool_call`/`tool_call_update` → `tool_call` with `started`/`completed`/`failed` phases sharing one `toolCallRef`; file edits → `file_change` with a relativized path and a `diffDigest` from the sink; `session/request_permission` → `permission_requested` with the offered options, including at least one denial option; the decision → `permission_resolved`; the turn end → `completed` with at least one evidence digest.

Prove the security invariants at this layer: an absolute or `..`-escaping path becomes an `output` event, never a `file_change`; provider text containing a credential-shaped token is redacted before the event is minted; and an oversized text field is bounded rather than rejecting the whole frame.

Prove usage honesty: ACP reports no token or cost figures, so the `usage` event carries `{ state: "unknown" }` for every figure. Assert there is no code path that can substitute a zero.

- [ ] **Step 4: Implement the mapper**

Pure functions from one provider frame plus session state to zero or more events. Every produced event goes through `AgentSessionStreamEventSchema.parse` before it leaves the mapper; a parse failure is reported as `provider_output_malformed`, which keeps the fail-closed rule from turning a bad frame into a thrown exception at the port.

- [ ] **Step 5: Add failing harness tests**

Prove the port surface: `start()` runs the session to a terminal; `steer()` rejects with an `Error` when the profile denies steering and otherwise sends `turn`-level input and makes the instruction observable in a later event; `cancel()` sends `session/cancel`, waits a bounded interval, terminates the process tree, and yields exactly one `cancelled` terminal and never a `completed`; `resume()` rejects when the profile denies it and otherwise issues `session/load` under the same AutoStack `sessionId`; `respondToPermission()` rejects a foreign `permissionRef`, rejects a second decision on a settled permission, rejects after disposal, and otherwise releases the gated side effect; and `dispose()` is idempotent and makes every subsequent operation reject.

- [ ] **Step 6: Implement the harness**

Compose sequencer, mapper, classifier, and child session behind `AgentHarnessPort`. Use `admitAgentPermissionResponse` from `@autostack/contracts` for decision admission rather than re-deriving the rules.

- [ ] **Step 7: Verify and commit**

```bash
pnpm --filter @autostack/agent-acp check
pnpm --filter @autostack/agent-acp test:coverage
git diff --check
git status --short
git add packages/agent-acp
git commit -m "feat(agent-acp): normalize ACP sessions into the contract event stream"
```

---

## Task 5: Pass the conformance suite against a fixture ACP agent

**Files:**

- Create: `packages/agent-acp/test/fixtures/acp-agent.mjs`
- Create: `packages/agent-acp/test/fixtures/conformance.ts`
- Test: `packages/agent-acp/test/acp-harness.conformance.test.ts`

- [ ] **Step 1: Write the fixture agent**

A Node script that takes a transcript path and a scenario on `argv`, speaks ACP over stdio, and replays the transcript: emits frames, blocks on `awaitStdin` until the matching client frame arrives, and exits as scripted. It is a real child process, so the adapter under test runs against a real macrotask transport. It carries no knowledge of the conformance suite.

Scenario obligations it must genuinely satisfy:

- `completes` — one `completed`, at least one `usage` event with at least one `{ state: "unknown" }` figure.
- `pauses` — emit, then block indefinitely until steered or cancelled; after a steer, echo the instruction text into a later event.
- `requests_permission` — emit `permission_requested` offering an allow and a deny option, then block; gate the `file_change` and the terminal behind the decision.
- `fails` — terminate with a JSON-RPC error, classified identically on every replay.
- `interrupted` — emit an evidence-bearing event, then exit non-zero with no terminal frame, so the adapter mints `interrupted` and ends without a lifecycle terminal.

- [ ] **Step 2: Build the conformance fixture**

Implement `AgentHarnessConformanceFixture` minting the invocation, steer, cancel, resume, and permission-response envelopes, and supplying the honest `quiesce()` from Task 2 Step 6. `createFullCapabilityHarness` launches the fixture agent in its full-negotiation mode; `createMinimalCapabilityHarness` launches it in the mode that advertises nothing. `dispose()` tears the child down and is idempotent.

- [ ] **Step 3: Run the suite under both runners**

```ts
describeAgentHarnessConformance("agent-acp (in process)", acpConformanceFixture);
describeAgentHarnessConformance(
  "agent-acp (macrotask deferred)",
  deferAcpFixture(acpConformanceFixture)
);
```

The macrotask wrapper mirrors `packages/domain/test/fixtures/async-agent-harness.ts` and is the standing guard against a `quiesce()` that is calibrated to a fixed number of turns rather than to the transport. Run:

```bash
pnpm --filter @autostack/agent-acp test -- acp-harness.conformance.test.ts
```

Expected failure: the fixture does not exist yet; then, once it does, each conformance behaviour fails until Tasks 3 and 4 satisfy it.

- [ ] **Step 4: Prove the suite is not passing vacuously**

Add mutation checks as ordinary tests: a subject whose descriptor lies about `permissions`, one that fabricates a zero for an unreported usage figure, one that emits a raw `-32601` as `failed.code`, and one whose `quiesce()` returns immediately. Assert each is rejected — the first three by the suite, the fourth by Task 2 Step 7's direct quiesce test. Keep these as tests of the fixture's honesty, not as disabled or skipped cases.

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

## Task 6: Extract `packages/agent-adapter-kit` at the second consumer

**Files:**

- Create: `packages/agent-adapter-kit/package.json`
- Create: `packages/agent-adapter-kit/tsconfig.json`
- Create: `packages/agent-adapter-kit/vitest.config.ts`
- Create: `packages/agent-adapter-kit/src/{index,launch-config,child-session,line-frames,event-sequencer,evidence-sink,session-errors,conformance-support}.ts`
- Modify: `packages/agent-acp/src/*` (import from the kit)
- Test: move `packages/agent-acp/test/{launch-config,child-session,line-frames,event-sequencer}.test.ts` to the kit

This task exists because the charter permits the kit only once duplication is real. It is a relocation, not a redesign: the modules and their tests move unchanged, and `agent-acp`'s behaviour is unchanged.

- [ ] **Step 1: Move the protocol-agnostic modules and their tests**

Everything protocol-specific (`acp-*.ts`) stays in `agent-acp`. The kit also gains `conformance-support.ts` — the macrotask-deferring fixture wrapper and the in-memory evidence sink, so all three packages share one honest test scaffold.

- [ ] **Step 2: Prove the move changed nothing**

```bash
pnpm --filter @autostack/agent-acp test
pnpm --filter @autostack/agent-adapter-kit test:coverage
```

Expected: the same tests pass, in their new home, with no assertion edited. Any assertion that had to change means this was a redesign and must be split into its own task.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @autostack/agent-adapter-kit check
pnpm --filter @autostack/agent-acp check
git diff --check
git status --short
git add packages/agent-adapter-kit packages/agent-acp pnpm-lock.yaml
git commit -m "refactor(agent-adapter-kit): extract the shared adapter transport"
```

---

## Task 7: Map the Claude Code stream-json session

**Files:**

- Create: `packages/agent-claude/package.json`
- Create: `packages/agent-claude/tsconfig.json`
- Create: `packages/agent-claude/vitest.config.ts`
- Create: `packages/agent-claude/src/{claude-launch-profile,claude-frames,claude-event-mapper,claude-failures,index}.ts`
- Test: `packages/agent-claude/test/{claude-launch-profile,claude-frames,claude-event-mapper,claude-failures}.test.ts`

- [ ] **Step 1: Add failing launch-profile tests**

Two real profiles, each with its own `adapterId` and descriptor (escalation E-2):

| Profile                 | argv                                                                                                               | resume  | steering | permissions |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- | -------- | ----------- |
| `claude-code.streaming` | `-p --output-format stream-json --input-format stream-json --verbose --session-id <uuid> --permission-mode manual` | `true`  | `true`   | `true`      |
| `claude-code.batch`     | `-p --output-format stream-json --verbose`                                                                         | `false` | `false`  | `false`     |

Prove the argv is built as an array with no shell string anywhere; that the objective is passed as an argument or on stdin, never interpolated into a flag; that `--session-id` is a UUID the adapter mints so provider session identity is pinned rather than discovered; that the batch profile's harness object has no `respondToPermission` property; and that the environment passed to the child carries the variables the user's ambient CLI authentication needs and nothing the adapter has read from a credential store.

- [ ] **Step 2: Implement the profiles**

- [ ] **Step 3: Add failing frame and mapper tests**

Replay the Task 1 transcripts. Map: `system`/`init` → `started` with `providerSessionRef` set to the pinned session id; `assistant` message content → `message` (text blocks) and `tool_call` (tool-use blocks, phase `started`); `user` tool results → `tool_call` phase `completed`/`failed` under the same `toolCallRef`; thinking blocks → `thought_summary`; file-editing tool results → `file_change` with a relativized path; `result` → `completed` plus a `usage` event.

Usage honesty: map `input_tokens`, `output_tokens`, and the cache figures to `{ state: "reported" }`; map reasoning tokens to `{ state: "unknown" }` because the CLI does not report them; map `total_cost_usd` to `{ state: "reported", currency: "USD", micros }` when present and `{ state: "unknown" }` otherwise. Assert no path fabricates a zero.

- [ ] **Step 4: Add failing failure-classification tests**

| Provider signal                            | `failed.code`               | `retryable` |
| ------------------------------------------ | --------------------------- | ----------- |
| `result.subtype: "error_max_turns"`        | `provider_turn_limit`       | `false`     |
| `result.subtype: "error_during_execution"` | `provider_execution_error`  | `true`      |
| unknown `result.subtype` with `is_error`   | `provider_error`            | `false`     |
| non-zero exit with no `result` frame       | `harness_child_exited`      | `true`      |
| unparseable stdout line                    | `provider_output_malformed` | `false`     |

Include the untrusted-text test: an `error_max_turns` result whose text says "temporary, retry" still classifies `retryable: false`.

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

Implement whichever permission channel Task 1 Step 1 established. Prove: a permission request becomes `permission_requested` with the CLI's offered options plus a denial option; a decision is written back on the channel and produces `permission_resolved`; a foreign `permissionRef`, a stale evidence digest, a second decision on a settled permission, and a decision after disposal each reject; and the gated side effect stays unobserved until the decision lands.

Steering: a `steer()` on the streaming profile writes a user message to stdin and the instruction text becomes observable in a later event. On the batch profile it rejects with an `Error` and leaves the session running to its normal terminal.

- [ ] **Step 2: Implement the control channel**

- [ ] **Step 3: Add failing cancellation and resume tests**

Cancellation follows spec §15: graceful signal, bounded wait, then process-tree termination, partial evidence recorded, exactly one `cancelled` terminal, never a `completed`. A second `cancel()` after the terminal is a no-op or a clean rejection, never a hang.

Resume runs `--resume <pinned session id>` as a fresh child continuing the provider's own session, and asserts continuity: the same AutoStack `sessionId` on every event, sequence numbers above the last allocated one, and the same `providerSessionRef`. Add an explicit test that the adapter never replays a transcript into a new session and calls it a resume (spec §9.1) — assert the resume argv contains `--resume` and no `--fork-session`, and that the objective from the original invocation is not re-sent.

- [ ] **Step 4: Implement the harness and availability probes**

Probes mirror Task 3 Step 6, driven by injected probe dependencies: an executable resolver for `installed`, and a non-spawning authentication probe for `authenticated`. Unit tests never invoke the real CLI.

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

- Create: `packages/agent-claude/test/fixtures/claude-agent.mjs`
- Create: `packages/agent-claude/test/fixtures/conformance.ts`
- Test: `packages/agent-claude/test/claude-harness.conformance.test.ts`

- [ ] **Step 1: Write the fixture CLI**

A Node script that impersonates `claude -p --output-format stream-json`, replaying a Task 1 transcript over real stdio and honouring the stdin control channel. It asserts nothing about the adapter; it only speaks the recorded protocol.

- [ ] **Step 2: Build the fixture and run both runners**

`createFullCapabilityHarness` uses the streaming profile; `createMinimalCapabilityHarness` uses the batch profile. Supply the kit's honest `quiesce()`. Run `describeAgentHarnessConformance` twice, in process and macrotask-deferred.

```bash
pnpm --filter @autostack/agent-claude test -- claude-harness.conformance.test.ts
```

Expected failure: the fixture does not exist; then each behaviour in turn until Tasks 7 and 8 satisfy it.

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

## Task 10: Map the Codex app-server session

**Files:**

- Create: `packages/agent-codex/package.json`
- Create: `packages/agent-codex/tsconfig.json`
- Create: `packages/agent-codex/vitest.config.ts`
- Create: `packages/agent-codex/src/{codex-launch-profile,codex-jsonrpc,codex-event-mapper,codex-failures,codex-harness,availability,index}.ts`
- Test: `packages/agent-codex/test/{codex-launch-profile,codex-jsonrpc,codex-event-mapper,codex-failures,codex-harness,availability}.test.ts`

- [ ] **Step 1: Add failing launch-profile tests**

| Profile            | argv                      | resume  | steering | permissions |
| ------------------ | ------------------------- | ------- | -------- | ----------- |
| `codex.app-server` | `app-server`              | `true`  | `true`   | `true`      |
| `codex.exec`       | `exec --json <objective>` | `false` | `false`  | `false`     |

The app-server profile is full because the protocol genuinely provides `thread/resume`, `turn/steer`, `turn/interrupt`, and approval requests. The `exec` profile declares `resume: false` deliberately: continuing an `exec` run means a new process, which would be emulated resume (spec §9.1). Prove the argv is array-built and that `--dangerously-bypass-approvals-and-sandbox` never appears in any profile.

- [ ] **Step 2: Add failing JSON-RPC client tests**

Request/response correlation by id; concurrent in-flight requests resolved to the right callers; notifications routed without a response; a response to an unknown id ignored with a classified diagnostic rather than a throw; a server-initiated approval request answered on the same channel; and a `close()` that rejects every in-flight request rather than leaving them pending.

- [ ] **Step 3: Add failing mapper tests**

Replay the Task 1 app-server transcript. Map `initialize` → capabilities; `thread/start` → `started` with `providerSessionRef` set to the thread id; agent message deltas → `message`; reasoning deltas → `thought_summary`; `turn/plan/updated` → `plan`; command and file-change items → `tool_call` and `file_change`; approval requests → `permission_requested`; `thread/tokenUsage/updated` → `usage` with reported token figures and `{ state: "unknown" }` cost (the protocol reports tokens, not dollars); `turn/completed` → `completed`.

- [ ] **Step 4: Add failing classification tests**

Reuse the JSON-RPC table from Task 3 Step 3 — Codex app-server is JSON-RPC, so the `-32601` mapping obligation applies identically — plus `ErrorNotification` → `provider_execution_error` (`retryable: true`) and turn interruption → `cancelled`, not `failed`.

- [ ] **Step 5: Implement the profile, client, mapper, classifier, harness, and probes**

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @autostack/agent-codex check
pnpm --filter @autostack/agent-codex test:coverage
git diff --check
git status --short
git add packages/agent-codex pnpm-lock.yaml
git commit -m "feat(agent-codex): map the Codex app-server session"
```

---

## Task 11: Pass the conformance suite for Codex

**Files:**

- Create: `packages/agent-codex/test/fixtures/codex-agent.mjs`
- Create: `packages/agent-codex/test/fixtures/conformance.ts`
- Test: `packages/agent-codex/test/codex-harness.conformance.test.ts`

- [ ] **Step 1: Write the fixture app-server**

A Node script speaking the recorded app-server JSON-RPC over stdio, in a full-capability mode and a mode that behaves as `codex exec --json` for the minimal subject.

- [ ] **Step 2: Run both runners and satisfy every behaviour**

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

## Task 12: Live smoke behind `AUTOSTACK_LIVE_HARNESS_SMOKE=1`

**Files:**

- Create: `packages/agent-claude/test/live-smoke.test.ts`
- Create: `packages/agent-codex/test/live-smoke.test.ts`
- Create: `packages/agent-acp/test/live-smoke.test.ts`

- [ ] **Step 1: Add the skip semantics test first**

Prove the smoke is skipped **visibly**: without the flag, or with the flag but no CLI on PATH, the test reports a skip with a stated reason. Assert the guard never silently passes — a test body that never ran must not report green. Use `it.skip` with a reason string or `context.skip(reason)`, and assert the guard function's return value directly in an always-running test.

- [ ] **Step 2: Drive the real CLIs on a disposable repository**

Create a temp repo with `mktemp -d` + `git init` + one file. Never the AutoStack checkout, and assert that precondition in the test itself. Drive a trivial objective end to end, assert the stream reaches a `completed` terminal with a usage event, assert the child is reaped, and delete the temp repo in a `finally`. Record the observed CLI versions in the stream report as the required evidence.

- [ ] **Step 3: ACP fixture-agent smoke**

The same end-to-end path against the shipped fixture agent, which runs unconditionally because it has no external dependency.

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

## Task 13: Stream gates and final self-review

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

Confirm, by reading the diff rather than by recollection: no TODO or placeholder code; no disabled or skipped tests except the live smoke's documented visible skip; no `any`, non-null assertion, or validation bypass; no shell string in any spawn path; no credential material in any fixture; no file touched outside the four owned packages and this plan document; and no orphaned process left by any test (check with a process probe after the suite).

- [ ] **Step 3: Write the stream report and request merge review**

Update `.superpowers/sdd/stream-report.md` and `.superpowers/sdd/progress.md`, then report `MERGE_READY` with the head SHA, the gate output summary, and the live-smoke evidence. Do not push (stream-lead protocol, Push policy).

---

## Completion evidence

Stream S2 is complete only when the committed evidence demonstrates all of the following:

- All three adapters pass `describeAgentHarnessConformance` unmodified, under both an in-process and a macrotask-deferred runner, against fixture provider processes that are real child processes.
- The conformance `quiesce()` is separately proven honest: it reports a session paused only when the transport is genuinely idle, and reports a slow-but-progressing transport as not paused.
- Transcript fixtures cover normal completion, permission round trip (where the profile is capable), cancellation mid-stream, provider error, and malformed provider output — the last classified, not crashed.
- Every `failed.code` satisfies `^[a-z][a-z0-9_]{0,63}$` and is derived only from enumerated structured provider fields; JSON-RPC `-32601` is mapped, never passed through.
- Capability declarations are honest per launch profile: no adapter implements `respondToPermission` without declaring `permissions`, none emits a `plan` without declaring `structuredPlans`, and none emulates resume.
- `isInstalled()` and `isAuthenticated()` are probe-injected, fail closed, and never spawn a real CLI in unit tests.
- Live smoke passes locally for the installed `claude` and `codex` CLIs on a disposable temp repository, with the observed CLI versions recorded; the ACP fixture-agent smoke is green.
- No adapter reads, copies, persists, or logs credential material, and no fixture contains any.
- `pnpm format:check`, `pnpm check`, `pnpm build --filter='!@autostack/desktop'`, and `pnpm test` are green, with ≥80% coverage on `agent-adapter-kit`, `agent-acp`, `agent-claude`, and `agent-codex`.

## Primary implementation references

- <https://agentclientprotocol.com>
- <https://docs.claude.com/en/docs/claude-code/cli-reference>
- <https://github.com/openai/codex>
