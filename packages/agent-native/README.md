# @autostack/agent-native

The built-in native agent harness: `createNativeHarness(config, deps)` returns an
`AgentHarnessPort & Partial<AgentPermissionResponderPort>` that runs the three station roles —
triage, plan, review — over an injected `ModelInferencePort` and model router. This package is
the **adapter-implementer** side of the harness port; it passes
`describeAgentHarnessConformance` unmodified and depends on `@autostack/agent-runtime` (the
relay, the transcript digest), never the reverse.

## Public surface

Exactly what `src/index.ts` exports; the runtime surface is pinned by
`test/public-surface.test.ts`, so an accidental export is a failing test. The harness factory
and its config/dependency types; the role configs; the evidence wrappers
(`digest*/admit*Evidence`); context assembly (`assembleContext`, `isPathInScope`); structured
output admission (`admitStructuredOutput`); failure classification (`classifyThrowable`,
`MODEL_ROUTING_FAILURE_CLASSIFICATIONS`); `NativeAgentError` over the frozen
`NATIVE_AGENT_FAILURES` table, every entry `retryable: false`.

## Roles are data, not control flow

`NATIVE_ROLE_CONFIGS` (and the per-role `TRIAGE_ROLE_CONFIG` / `PLAN_ROLE_CONFIG` /
`REVIEW_ROLE_CONFIG`) each carry the prompt, route stage, required capabilities, the narrowed
model-authored output schema, `buildDocument`, `digestDocument`, and `admitDocument` — one
engine (`native-session.ts`, internal) executes all three.

| Role   | Route stage       | Required capabilities           | Document       |
| ------ | ----------------- | ------------------------------- | -------------- |
| triage | `triage`          | `["text", "structured_output"]` | `TriageReport` |
| plan   | `plan`            | `["text", "structured_output"]` | `PlanDocument` |
| review | `isolated_review` | `["text", "structured_output"]` | `ReviewReport` |

## What this package refuses to do

- **No provider SDK, no credential, no API key, no network call, no shell string.** Inference
  and routing arrive as injected ports; clocks and ref factories are injected too.
- **Untrusted input never grants permission and is never interpolated into a system prompt.**
  Repository and document content is rendered only inside explicit untrusted-input fences.
- **No usage persistence.** The harness emits unknown-preserving `usage` events and never calls
  `recordUsage` — durable `ModelUsageRecord` persistence is an I1 composition concern.

## Invariants

- **Pre-model admission gate.** `admitRoleInputs` (transitive contracts admission plus the
  invocation-identity hold) rejects bad upstream documents with **zero inference calls**;
  `buildDocument` re-admits before the output document may exist.
- **Reviewer isolation is structural.** The review role renders only admitted typed documents
  (`ReviewRoleDocuments`); free-text `context` blobs are unrenderable for review by
  construction, not by filtering.
- **Prompts are versioned, and the digest table is append-only.** Each role's prompt artifact
  carries a version pin; `PROMPT_DIGESTS` (on the package root) records one digest row per
  released `(promptRef, version)` under `autostack.native-prompt` — changing a prompt means a
  new version and a new appended row, never editing an existing row.
- **Failures are classified fail-closed.** Routing failures carry their taxonomy code through
  the frozen classification table with `retryable` PRESERVED from the `ModelRoutingError`
  (`rate_limited` is `true`; `provider_error` is caller-supplied); the six native codes are all
  `retryable: false`; model-authored text is never echoed into failure detail.

## Composition interfaces (I1)

- `NativeRoleInputsProvider.forInvocation(request)` supplies per-invocation upstream inputs as
  the `NativeRoleInputs` union: plain `{ label, content }` entries for triage and plan, the
  typed `ReviewRoleDocuments` (plan document, verification report, reviewed-diff descriptor)
  for the reviewer. `isReviewRoleDocuments` narrows the union.
- Usage: this package emits `usage` events only; S3's `recordUsage` is the sink I1 wires up.

## Digest domains

- `autostack.native-prompt` — the prompt version pin, minted and owned here. Internal today;
  potential future contract surface.
- `autostack.agent-session-transcript` — imported from `@autostack/agent-runtime`, which is the
  **single authority** (`AGENT_SESSION_TRANSCRIPT_DIGEST_DOMAIN` + `digestSessionTranscript`);
  this package never redefines the domain or the projection. Internal today; potential future
  contract surface.

Either domain moves to `@autostack/contracts` the moment another stream reads it. The former
`autostack.native-structured-output` placeholder domain was deleted at T10 and must not be
reintroduced.
