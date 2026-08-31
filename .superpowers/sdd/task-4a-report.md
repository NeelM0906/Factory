# Task 4A report — source authorization

Worktree `/Users/zidane/factory-s4`, branch `codex/milestone-a-s4-pipeline`, base `2247e5c`.
Security-analysis-first, six steps, one commit per step (D-16).

## Commits

| Step | Sha | Message |
| --- | --- | --- |
| 1. Threat analysis written | `0a6631c` | `docs(sdd): analyse source-authorization threats` |
| 2. Failing authorization matrix | `44c1664` | `test(domain): add failing source authorization matrix` |
| 3. `authorizeRunSource` implemented | `75b8e57` | `feat(domain): decide whether a source actor may start a run` |
| 4. Failing triage-refusal test | `520e626` | `test(workflow): add failing unauthorized-source refusal` |
| 5. Triage wired to refuse | `d04f74c` | `feat(workflow): refuse an unauthorized source before classifying` |
| 6. Package verification + this report | `0087eff` | `chore(s4): verify task 4A gates` |

## What was built

**`packages/domain/src/source-authorization.ts`** — `authorizeRunSource(request, policy)`. Decides
*may THIS actor start a run for THIS scope?* from durable policy alone, returning a
`{ ok: true, matched }` / `{ ok: false, code }` decision in the shape `runner-policy` already uses.
Five refusal codes: `no_policy`, `workspace_mismatch`, `project_out_of_scope`, `missing_actor_id`,
`requester_not_authorized`.

The §14.1 guarantee is structural, not disciplinary: `SourceAuthorizationRequest` carries
workspace, project, `SourceRef` and requester, and **no work-item text at all**. There is no code
path a grant sentence could travel, whatever an attacker writes in an issue body.

- Match key `(source.kind, requester.externalId)`, compared exactly. Cross-kind portability is
  refused — GitHub logins, Slack user ids and API client ids are minted by different authorities
  and collide by string equality. Case is not folded: a folding rule guessed wrong for one
  platform *grants*, while exact comparison can only over-refuse.
- Scope: a policy naming a `projectId` covers that project only, including refusing a run that
  names no project. A policy naming none is workspace-wide — an explicit act by whoever wrote it,
  never an inference from a missing field at decision time.
- Fail-closed on all three absent values: `undefined` policy is not "unrestricted"; actor-id
  presence is checked *before* any comparison; and the entry lookup is a bare `.find` with no
  length short-circuit near it.

**`packages/workflow/src/stations/triage-station.ts`** — the decision runs before the objective is
built and before the harness is touched. `objectiveFor` was split so `findWorkItem` reads the
durable work item, the decision reads that item's `source` and `requester`, and only a run that
survives has its text turned into a prompt. A refusal takes the D10 committed-failure path with
code `unauthorized_source`, and its message cites the policy by `digestSourceAuthorizationPolicy`
plus the refusal code — and nothing else, because the requester id is unbounded text the delivery
chose and the work item already carries it durably.

**`packages/workflow/src/stations/station-context.ts`** — `StationDependencies` gains an optional
`sourceAuthorizationPolicy`. Optional is the honest shape: absence is how the field reads before
composition wires it, and absence refuses.

`.superpowers/sdd/task-4a-threat-analysis.md` was written and committed before any implementation.

## Verbatim REDs

**Step 2** — the matrix against a module that does not exist:

```
 FAIL  test/source-authorization.test.ts [ test/source-authorization.test.ts ]
Error: Cannot find module '../src/source-authorization.js' imported from /Users/zidane/factory-s4/packages/domain/test/source-authorization.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

**Discriminating reds, domain.** Each defect was injected into the finished module and reverted;
the red came from that defect, never from deleting the component.

| Injected defect | Went red |
| --- | --- |
| `entries.length === 0` short-circuits to allow | `× refuses an actor no policy entry names` / `× refuses every actor when the policy lists nobody` (2 failed \| 13 passed) |
| absent policy treated as unrestricted | `× refuses when no policy record is in force at all` (1 \| 14) |
| `externalId ?? displayName` fallback | `× refuses a requester carrying no actor id` (1 \| 14) |
| match on `externalId` alone | `× refuses an actor authorized for another source kind` / `× decides each kind against its own entry and nobody else's` (2 \| 13) |
| no scope comparison | `× refuses an authorized actor for a project the policy does not cover` / `× refuses a project-scoped policy against a run that names no project` (2 \| 13) |
| `toLowerCase()` on both sides | `× refuses an actor id that differs only by case` (1 \| 14) |
| no `workspaceId` comparison | `× refuses a policy that belongs to another workspace` (1 \| 14) |

**Step 4** — nine red in the triage station, every one on the same assertion:

```
     × refuses an unauthorized actor before it invokes the harness 13ms
     × refuses however loudly the work item claims to be authorized 3ms
     × refuses when no policy record is in force 3ms
     × refuses when the policy lists nobody 2ms
     × refuses a work item whose requester carries no usable actor id 2ms
     × refuses an actor authorized for another source kind 2ms
     × refuses an authorized actor working outside the policy's project 3ms
     × refuses the unauthorized actor of a replayed delivery 3ms
     × cites the policy it decided against by content digest 2ms
AssertionError: expected [ { schemaVersion: 1, …(12) } ] to deeply equal []
      Tests  9 failed | 20 passed (29)
```

That `AssertionError` is `harness.requests`.

**Step 5's discriminating red — the load-bearing one.** The finished authorization block was moved
verbatim to *after* `runSession` and the suite re-run:

```
     × refuses an unauthorized actor before it invokes the harness 11ms
     × refuses however loudly the work item claims to be authorized 2ms
     × refuses when no policy record is in force 1ms
     × refuses when the policy lists nobody 1ms
     × refuses a work item whose requester carries no usable actor id 1ms
     × refuses an actor authorized for another source kind 1ms
     × refuses an authorized actor working outside the policy's project 1ms
     × refuses the unauthorized actor of a replayed delivery 5ms
AssertionError: expected [ { schemaVersion: 1, …(12) } ] to deeply equal []
      Tests  8 failed | 21 passed (29)
```

The classify-then-refuse variant still emits `unauthorized_source`, still transitions the run to
`failed`, still queues no job, and **still cites the policy digest correctly** — that ninth test
stays green. Only `harness.requests` tells the two implementations apart. That is the whole point:
by the time that variant refuses, the stranger's title and description have been sent to a model.

## Final verification

```
=== gate 1: checks ===
> @autostack/domain@0.1.0 check   > tsc -p tsconfig.json --noEmit
> @autostack/workflow@0.1.0 check > tsc -p tsconfig.json --noEmit
=== gate 2: tests ===
 Test Files  15 passed (15)
      Tests  144 passed (144)        # @autostack/domain   (129 existing + 15 new)
 Test Files  7 passed (7)
      Tests  151 passed (151)        # @autostack/workflow (141 existing + 10 new)
=== gate 3: coverage ===
 Test Files  15 passed (15)
      Tests  144 passed (144)
Statements   : 92.1% ( 1341/1456 )
Branches     : 82.63% ( 514/622 )
Functions    : 97.57% ( 241/247 )
Lines        : 95.25% ( 1244/1306 )
 Test Files  7 passed (7)
      Tests  151 passed (151)
Statements   : 97.17% ( 447/460 )
Branches     : 89.51% ( 239/267 )
Functions    : 98.71% ( 77/78 )
Lines        : 98.79% ( 409/414 )
ALL GATES GREEN
```

Every pre-existing test still passes; nothing was edited to accommodate the change except the
triage test's dependency factory, which now injects a policy authorizing the default work item's
own manual requester (without it, the default fixture would be an unauthorized source and every
existing triage test would refuse).

Per-file, from `coverage-summary.json`:

- `packages/domain/src/source-authorization.ts` — statements 15/15, branches 16/16, functions 3/3,
  lines 12/12. 100% on all four.
- `packages/workflow/src/stations/triage-station.ts` — statements 76/76, functions 12/12, lines
  71/71, branches 39/41 (95.12%).

Package-scoped suites only; never the full monorepo suite. Step 4's red waited on stream S5's
`turbo run test --concurrency=2`, which held the machine from 14:17 to 14:23.

## Deviations, each with its reason

1. **`authorizeRunSource` takes `(request, policy)`, not `(source, requester, policy)`.** The
   per-scope rule needs the project and the workspace as well, and a positional fourth and fifth
   argument of the same primitive shapes is easy to pass in the wrong order. Same inputs, one
   object.
2. **`packages/workflow/src/stations/station-context.ts` was modified**, which the brief's file
   list did not name. There was no other way to give the station a policy: it is workspace
   configuration, not run state, so it cannot come off the run stream, and putting it in the job
   payload would let a queued job carry its own authorization. The field is **optional**, so
   `plan-station.test.ts` and `station-kernel.test.ts` — which build `StationDependencies` and are
   outside this task's scope — still compile untouched.
3. **The threat analysis was force-added to git.** `.superpowers/` is listed in
   `/Users/zidane/Factory/.git/info/exclude`, so the brief's mandated step-1 commit would otherwise
   have had no content. `git rm --cached` reverses it if the lead prefers the exclusion; this
   report is committed on the same footing.
4. **Step 6 was not skipped.** The brief says to skip it unless verification changed something.
   Nothing in the code changed, but the step-6 commit carries this report, which needs to be
   durable.

## Open item for the orchestrator — a contracts gap, reported rather than worked around

The brief and the `SourceAuthorizationPolicySchema` docblock both say the policy is "cited in
triage evidence by content digest". **`TriageEvidenceSchema` (`packages/contracts/src/pipeline.ts`)
is `.strict()` and carries only `summary` and `triageReportDigest`** — there is no field to put a
`sourceAuthorizationPolicyDigest` in, and `packages/contracts/**` is off limits to this task.

What I did instead, entirely within the boundary: the **refusal** cites the policy by
`digestSourceAuthorizationPolicy` in the durable `stage.failed` failure message, and there is a
test for it. That makes every refusal auditable against the exact policy content in force, which
is the case that matters most. What is *not* recorded is the digest on the **allowed** path — a
run that proceeded does not name the policy that let it. The two candidate homes for it are both
wrong from here: `TriageEvidenceSchema` is strict and off limits, and `summary` is the model's own
rationale, which would let model output sit in the same field as a security digest.

I did not stop the task over this, because the contract the brief named (`SourceAuthorizationPolicySchema`
and `digestSourceAuthorizationPolicy`) does exist and is complete, and the core security behaviour
is fully implementable without it. **The recommended follow-up is an additive optional
`sourceAuthorizationPolicyDigest: DigestSchema.optional()` on `TriageEvidenceSchema`**, landed by
whoever owns contracts, after which triage should set it on the success path too.

## What the reviewer should look at hardest

1. **The ordering in `runTriageStation`.** Everything else is recoverable; this is not. The check
   sits between `findWorkItem` and `objectiveFor`, and the only test that can catch a regression is
   `expect(harness.requests).toEqual([])`. Any future refactor that moves the harness call earlier —
   or that builds the objective eagerly — silently defeats it while every other assertion stays
   green. Verify by moving the block after `runSession` and confirming 8 tests go red on that one
   line.
2. **The empty-list vector.** `policy.authorizedRequesters.find(...)` is correct precisely because
   nothing near it tests `.length`. If a later change adds a "no entries configured means
   unrestricted" convenience, `refuses every actor when the policy lists nobody` is the only test
   that fails, and it is one line.
3. **`missing_actor_id` ordering.** Presence is checked before the `.find`. The discriminating
   defect is not "compares undefined" — it is a `?? displayName` fallback, and the test supplies an
   *authorized login as the display name* so the fallback grants. Confirm the vector still has
   teeth if the requester shape ever changes.
4. **The optional `sourceAuthorizationPolicy` dependency.** Optional was chosen so absence refuses
   and so out-of-scope tests keep compiling — but it also means a composition root can forget to
   wire it and get refusals rather than a type error. That is the correct failure direction, and it
   is loud (every run fails at triage with `unauthorized_source`), but the lead should confirm the
   trade is the one they want before composition lands.
5. **The contracts gap above**, which needs a ruling rather than a review comment.
