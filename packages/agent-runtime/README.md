# @autostack/agent-runtime

Host-side runtime for agent harnesses: which harnesses exist and are usable
(`createAgentHarnessRegistry`), how a session's event stream is ordered and persisted
(`createSessionEventRelay`), and how a running session is supervised to a single terminal
(`createAgentSessionSupervisor`). This package is the **adapter-consumer** side of
`AgentHarnessPort` — it drives harnesses through the contracts port and never implements a
provider. Adapter implementations (including the built-in one, `@autostack/agent-native`) live
elsewhere and depend on this package, never the reverse.

## Public surface

Exactly what `src/index.ts` exports; the runtime surface is pinned by
`test/public-surface.test.ts`, so an accidental export is a failing test. Factories:
`createAgentHarnessRegistry`, `createAgentSessionSupervisor`, `createSessionEventRelay`.
Admission and probing: `admitHarnessRegistration`, `describeHarnessAvailability` (probes
installed/authenticated status and fails closed — an erroring probe reports unavailable, never
available). Failures: `AgentRuntimeError` over the frozen `AGENT_RUNTIME_FAILURES` table — every entry
`retryable: false` except `agent_harness_probe_failed`, which is `true` because a probe is
environmental and re-runnable (a workbench refresh IS the retry). Interruption evidence:
`digestSessionTranscript` under `AGENT_SESSION_TRANSCRIPT_DIGEST_DOMAIN`.

## What this package refuses to do

- **No provider SDK, no credential, no API key, no network call, no shell string.** It holds
  harness descriptors and session streams; it never talks to a model provider.
- **No permission grants from untrusted input.** Text that arrived in a session stream is data;
  only the host's explicit responder path answers a permission request.
- **No adapter implementation.** Consumers compose adapters in; this package only validates,
  supervises, and persists what adapters emit.

## Invariants

- **Registry and supervisor are separate because their lifetimes are separate.** A registry
  outlives every session it hands out; there is deliberately no single `createAgentRuntime`.
- **The relay is the shared stream primitive.** Dependency direction is
  `@autostack/agent-native` → `@autostack/agent-runtime`, never reverse.
- **Interruption has a single owner per stream.** An adapter's own `interrupted` relays
  unchanged; the supervisor synthesizes one only when a stream ends with neither a lifecycle
  terminal nor an interruption — and `interrupted` is deliberately NOT a lifecycle terminal.
- **Cancellation is bounded by the injected budget.** After `cancellationGraceMs` (measured
  against the injected `sleep`) the supervisor appends its own `cancelled` and detaches.
- **Persist before visibility.** Every event is persisted before it becomes observable; a
  rejecting sink ends the session `interrupted` rather than reporting success.
- **Concluded session ids stay reserved.** Re-supervising a concluded `agentSessionId` raises
  `agent_session_already_supervised`; an id is never reusable.

## Digest domains

`autostack.agent-session-transcript` — the partial-evidence digest of a transcript when a
session is interrupted. **This package is the single authority**: the domain constant
(`AGENT_SESSION_TRANSCRIPT_DIGEST_DOMAIN`) and the projection (`digestSessionTranscript`) live
here and `@autostack/agent-native` imports them, so both interruption owners agree on what the
evidence of a lost session looks like. Internal today; potential future contract surface — it
moves to `@autostack/contracts` alongside the station-evidence helpers the moment another stream
reads it.
