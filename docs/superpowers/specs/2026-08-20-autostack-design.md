# AutoStack Product and Architecture Design

**Status:** Approved
**Date:** 2026-08-20  
**Product:** AutoStack  
**Delivery target:** Personal local-first milestone followed by a one-organization team pilot

## 1. Purpose

AutoStack is an AI-powered software factory that accepts engineering work from the places where it already appears, coordinates specialized coding agents through a governed delivery workflow, and returns reviewable software changes with evidence.

The product is not a single coding agent and is not only an IDE. It is a control plane over agent harnesses, model providers, repositories, execution environments, communication channels, approvals, and software-delivery automations.

The initial end-to-end outcome is:

> A developer starts work from Slack, a GitHub issue, or the AutoStack desktop application; AutoStack triages and plans the request; a human approves the plan; a selected coding-agent teammate implements it in an isolated branch and workspace; AutoStack verifies and independently reviews the result; a human approves publication; and AutoStack opens a draft pull request and reports the evidence back to the originating surface.

## 2. Product principles

1. **Harnesses and models are independent.** Codex, Claude Code, ACP agents, and native AutoStack agents are harness choices. Vercel AI Gateway, OpenRouter, OpenAI, Anthropic, xAI, and other inference services are model routes. The data model and UI must never conflate them.
2. **AutoStack owns workflow state.** A run must remain inspectable and recoverable even if a harness, model provider, workflow engine, or sandbox vendor changes.
3. **Humans retain judgment.** Planning and publication are explicit approval gates in the first milestone. Merge and deployment are never automatic in the personal milestone or team pilot.
4. **Evidence over claims.** A stage completes with artifacts: plans, diffs, command output, test results, reviewer findings, usage, and provenance.
5. **Isolation by default.** Implementation and review use separate agent sessions. Cloud work uses disposable sandboxes. Local work is confined to an AutoStack-managed worktree unless the user explicitly selects an existing directory.
6. **Every surface is first-class.** Desktop, Slack, GitHub, web, CLI, and API operate on the same tasks and runs rather than maintaining separate conversations.
7. **Local work is not disposable.** The local-first implementation uses the same domain contracts and event vocabulary as the team control plane.
8. **Adapters contain vendor coupling.** BB-derived runtime code, Eve, Vercel services, GitHub, Slack, and model providers sit behind AutoStack-owned interfaces.
9. **Original product identity.** The interaction density and agent-oriented workflow may draw lessons from BB, but AutoStack uses its own naming, information architecture, component system, and visual identity.

## 3. Scope

### 3.1 Milestone A: personal local-first

Milestone A supports one developer on macOS Apple Silicon and includes:

- An Electron desktop application with a bundled local control plane and host daemon.
- One or more local Git repositories represented as AutoStack projects.
- GitHub App authentication, installation selection, issue intake, branches, comments, checks, and draft pull requests.
- A Slack app connected through Socket Mode, requiring no public inbound endpoint.
- Manual task creation from the desktop and CLI.
- A durable issue-to-reviewed-draft-PR workflow.
- Codex, Claude Code, and ACP-compatible coding-agent teammates.
- A native AutoStack agent adapter using the Vercel AI SDK for classifier, planner, and reviewer roles.
- Model routes through Vercel AI Gateway, OpenRouter, and direct OpenAI, Anthropic, and xAI credentials.
- Plan and publication approval gates.
- Live session steering, cancellation, and permission responses.
- Local SQLite persistence, an append-only event log, searchable run history, and artifact retention.
- A workbench UI plus an initial factory dashboard and automation list.

Milestone A does not merge pull requests, deploy software, expose a public SaaS signup flow, or run unattended when the desktop host is offline.

### 3.2 Milestone B: team pilot

Milestone B supports one GitHub organization, one Slack workspace, and approximately 5–20 developers. It adds:

- A hosted AutoStack web control plane and shared workspace.
- GitHub organization and Slack workspace identity mapping.
- `admin`, `member`, and `reviewer` workspace roles.
- PostgreSQL persistence and durable cloud workflows.
- Isolated cloud runners with prewarmed repository snapshots.
- Shared automations triggered by schedules, Slack, and GitHub events.
- Repository policies, concurrency limits, budgets, retention rules, and audit export.
- Workspace-scoped credentials and model-route policies.
- Factory-wide metrics, evaluations, memory, coverage, and bottleneck views.
- Desktop access to both local and team runs.

Milestone B remains a controlled pilot. Public multi-tenant signup, billing, enterprise SSO, marketplace distribution, automatic merge, and automatic production deployment are later product phases.

## 4. Primary user experience

### 4.1 Workbench

The workbench is optimized for supervising agent work rather than recreating a conventional code editor.

Its desktop layout has:

- A left navigation rail for **Factory**, **Projects**, **Automations**, **Approvals**, **Integrations**, and **Settings**.
- A hierarchical project/run sidebar showing active work, attention states, and recent history.
- A central multi-pane workspace for conversation, plan, terminal output, diff, test evidence, artifacts, and reviewer findings.
- A right inspector for harness, model route, environment, policy, token and cost usage, source trigger, and provenance.
- A persistent composer that can steer the active session, answer an elicitation, attach context, or hand work to another teammate.
- A global command palette for creating, locating, opening, cancelling, retrying, and handing off work.

The first release includes light and dark themes, keyboard navigation, reduced-motion support, screen-reader labels, and non-color-only status indicators.

### 4.2 Factory control room

The control room reflects the delivery lifecycle:

1. Signal
2. Triage
3. Plan
4. Implement
5. Validate
6. Release
7. Document
8. Monitor

Milestone A populates Signal through Validate and treats draft-PR publication as the Release boundary. Document and Monitor appear as inactive future stages so the information architecture does not have to change later.

The dashboard shows:

- Intake volume and source coverage.
- Active, waiting, blocked, failed, and completed runs.
- Stage throughput, queue depth, pass rate, and cycle time.
- Pull requests drafted and validation checks executed.
- Human interventions and approval wait time.
- Harness/model success rate, latency, tokens, and estimated cost.
- Repository and automation coverage in the team pilot.

### 4.3 Slack experience

Users can invoke AutoStack by mentioning it, using a message shortcut on an existing thread, or sending it a direct message.

AutoStack responds in the originating thread with:

- A normalized task summary and detected repository.
- Clarifying questions when confidence is insufficient.
- Stage progress and a deep link to the desktop or web run.
- Plan approval and rejection actions.
- Attention requests from an agent.
- Publication approval after validation and review.
- The final draft pull-request link and evidence summary.

Milestone A receives Slack events through Socket Mode. Milestone B receives signed HTTP events in the hosted control plane. Both map Slack thread identity to the same `ChannelBinding` contract.

### 4.4 GitHub experience

AutoStack can start from:

- An issue labeled `autostack`.
- An authorized `@AutoStack` mention on an issue or pull request.
- A desktop or Slack task associated with a repository.

It posts concise, editable progress comments rather than a new comment for every event. The final output is a draft pull request using an `autostack/<run-id>-<slug>` branch. The pull request includes the problem statement, approved plan, change summary, verification evidence, review verdict, known limitations, and a link to the full run.

Red CI on an AutoStack-owned branch may create a repair attempt only after an explicit user action in Milestone A. A configurable automation may enable automatic repair attempts in the team pilot, with a bounded attempt count and no changes to non-AutoStack branches.

## 5. System architecture

```text
Slack / GitHub / Desktop / Web / CLI / API
                    |
              Ingress adapters
                    |
       AutoStack control-plane service
  auth | tasks | policies | approvals | events
                    |
          Run state-machine contract
                    |
       +------------+-------------+
       |                          |
 Local workflow executor    Cloud workflow adapter
 SQLite + embedded worker   PostgreSQL + Vercel Workflow
       |                          |
       +--------- Runner contract-+
                    |
       +------------+-------------+
       |                          |
 Local host daemon          Cloud sandbox provider
 managed git worktree       disposable isolated VM
       |                          |
       +------- Agent runtime ----+
                    |
 Codex | Claude Code | ACP | Native | Eve adapter
                    |
      Git | terminal | tests | artifacts | tools
```

### 5.1 Architectural planes

#### Experience plane

The desktop application, hosted web application, Slack app, GitHub app, CLI, and public API are clients of the same server contract. They do not invoke agent processes directly.

#### Control plane

The control plane owns identity, projects, tasks, workflow definitions, run state, policies, approvals, automations, credential references, event sequencing, artifacts, usage records, and notification delivery.

#### Execution plane

Runners provision workspaces, execute commands, manage agent processes, collect artifacts, and enforce resource and network policies. A runner never makes product-level authorization decisions.

#### Agent plane

Agent adapters normalize provider-specific lifecycle, messages, tool calls, plans, permission requests, configuration, cancellation, and results into AutoStack events.

#### Model plane

Model adapters provide dynamic model discovery, inference, streaming, structured output, fallback, usage normalization, and error classification for native AutoStack agents. They do not wrap externally managed harness sessions unless a harness explicitly supports a compatible custom endpoint.

#### Evidence plane

The append-only event store and artifact store capture enough information to replay a run and support audit, evaluation, debugging, and metrics without depending on transient process memory.

## 6. Proposed monorepo boundaries

AutoStack uses a TypeScript monorepo managed by pnpm and Turborepo.

```text
apps/
  desktop/          Electron shell and native OS integration
  web/              React control-room and workbench client
  control-plane/    Hono HTTP, SSE, WebSocket, and webhook service
  host-daemon/      Local runner daemon and process supervisor
  cli/              Scriptable autostack command-line client
packages/
  domain/           Entities, state machines, policies, and use cases
  contracts/        Versioned client/server and server/runner schemas
  db/               SQLite and PostgreSQL persistence implementations
  workflow/         Pipeline definitions and local/cloud executors
  agent-runtime/    Agent adapter contract and session normalization
  agent-codex/      Codex adapter
  agent-claude/     Claude Code adapter
  agent-acp/        Generic ACP adapter and registry discovery
  agent-native/     Vercel AI SDK native-agent adapter
  model-router/     Gateway, OpenRouter, and direct model adapters
  runner-local/     Managed worktree and local command execution
  runner-vercel/    Vercel Sandbox implementation
  integration-github/
  integration-slack/
  observability/    Tracing, metrics, redaction, and audit export
  ui/               AutoStack design system and shared components
```

No implementation package imports another implementation across a contract boundary. For example, the control plane imports `RunnerClient`, not `runner-vercel`, and the workflow package imports `AgentSession`, not `agent-codex` internals.

## 7. Core domain model

### Workspace

The authorization and policy boundary. Milestone A creates one implicit local workspace. Milestone B has one shared workspace with members and roles.

### Project

An AutoStack representation of a software project. It references one GitHub repository and one or more execution sources, such as a local checkout or cloud snapshot.

### WorkItem

The normalized request entering the factory. It retains source-specific references while presenting a stable title, description, requester, repository, attachments, priority, labels, and acceptance context.

### Run

One durable execution of a workflow for a WorkItem. It owns ordered stage runs, approvals, agent sessions, events, artifacts, usage, and a terminal result.

### StageRun

One attempt at a named factory stage. It records input artifact references, assigned agent/harness/model route, execution environment, timestamps, outcome, and output artifacts.

### AgentSession

A normalized session with an agent harness. It may be resumed or steered if the adapter advertises those capabilities. Its raw provider session identifier is encrypted when sensitive and never used as a cross-provider identity.

### Environment

A binding between a runner, repository checkout, branch, resource limits, network policy, and secret grants. Environments are immutable in identity even if their backing process restarts.

### Approval

A durable request for a human decision. It records scope, requested action, evidence digest, eligible approvers, decision, actor, origin, and timestamp. Decisions are idempotent.

### Artifact

Immutable stage output such as a plan, patch, diff, test report, command transcript, reviewer report, screenshot, or pull-request reference. Large content lives outside the relational database and is addressed by a digest.

### Automation

A versioned trigger plus workflow, repository scope, agent policy, model policy, schedule/event filter, concurrency limit, approval policy, and owner.

### Event

An append-only fact with workspace, run, sequence, type, timestamp, actor, correlation, redacted payload, and schema version. Materialized views may be rebuilt from events plus immutable external references.

### CredentialRef

A reference to a secret held by macOS Keychain, Vercel-managed secrets, a gateway BYOK store, or a later enterprise vault. Raw secret values never enter domain events.

## 8. Workflow model

### 8.1 Run states

```text
queued
  -> triaging
  -> needs_clarification | planning
  -> awaiting_plan_approval
  -> provisioning
  -> implementing
  -> verifying
  -> reviewing
  -> awaiting_publish_approval
  -> publishing
  -> completed
```

From any active state, a run may enter `waiting_for_user`, `retry_scheduled`, `cancelling`, `cancelled`, or `failed`. `completed`, `cancelled`, and `failed` are terminal.

The state machine rejects transitions not declared by the workflow definition. Each transition consumes a command with an idempotency key and emits one or more events in the same database transaction.

### 8.2 Station responsibilities

#### Triage

- Validate source authorization and repository scope.
- Detect task type, priority, complexity, and likely repository.
- Identify duplicates against recent work items and open pull requests.
- Decide whether the request is actionable.
- Ask a focused question through the originating channel if required.

#### Plan

- Inspect a read-only repository checkout.
- Produce a concise implementation plan with acceptance criteria, affected areas, risks, and verification commands.
- Identify permissions, secrets, network access, and destructive actions the implementation may require.
- Generate a deterministic evidence digest for the approval request.

#### Implement

- Start only after plan approval.
- Provision a managed worktree from the repository's configured base branch.
- Run the selected coding-agent harness with the approved plan and repository instructions.
- Stream normalized progress, permission requests, tool calls, and file changes.
- Commit changes on an AutoStack-owned branch after local verification succeeds.

#### Verify

- Run repository-defined checks plus checks named in the approved plan.
- Record exact commands, exit codes, durations, structured reports, and relevant redacted output.
- Treat skipped required checks as failure, not success.

#### Review

- Use a session isolated from the implementer's hidden reasoning.
- Review the approved plan, acceptance criteria, final diff, relevant repository context, and verification evidence.
- Produce findings with severity, file/location when applicable, evidence, and a pass/fail verdict.
- A failed review routes back to Implement with bounded attempts; it never silently marks itself passed.

#### Publish

- Request human approval using the final diff summary, verification results, reviewer verdict, branch, and projected GitHub action.
- Push only the AutoStack-owned branch named in the approval request.
- Open a draft pull request and report its URL to all bound channels.
- Never merge or deploy.

### 8.3 Retry policy

- Network, rate-limit, and temporary provider errors use exponential backoff with jitter and respect server-provided retry times.
- Invalid input, denied authorization, missing required credentials, policy rejection, and deterministic test failures do not retry automatically.
- An agent stage can make at most three attempts in Milestone A. The team pilot exposes a workspace policy with an allowed range of one to five attempts.
- A publish command uses a stable idempotency key so retries cannot create duplicate branches, comments, or pull requests.

## 9. Agent runtime

### 9.1 Normalized adapter contract

Every `AgentAdapter` exposes:

- Adapter identity, display metadata, installed/authenticated status, and capabilities.
- Dynamic model/config discovery when the harness supports it.
- `startSession`, `resumeSession`, `send`, `cancel`, and `dispose` operations.
- A stream of normalized message, thought-summary, plan, tool-call, permission, file-change, usage, error, and completion events.
- Declared support for steering, session resume, permission modes, structured plans, and model/reasoning selection.

Unsupported capabilities remain visibly unavailable. AutoStack does not emulate session resume by replaying a transcript into a new harness and calling it the same session.

### 9.2 Codex and Claude Code

Codex and Claude Code receive dedicated adapters so AutoStack can preserve capabilities not uniformly represented by ACP. They run as child processes supervised by the host daemon or sandbox runner, never by the renderer process.

Each adapter uses the user's existing CLI authentication in local mode unless the user explicitly configures a separate credential. Team cloud runners use workspace-managed service credentials and never copy a developer's local credential store.

### 9.3 ACP

ACP is the generic integration path for compatible agents. AutoStack communicates over JSON-RPC, uses stdio for local agents, negotiates capabilities, and maps ACP sessions, plans, terminals, permission requests, cancellation, and updates into AutoStack contracts.

Custom ACP launch commands are configured as executable plus argument arrays, never shell command strings. Editing that configuration is treated as permission to execute local code and is restricted to the local workspace owner or team admin.

### 9.4 Native AutoStack agents and Eve

Classifier, planner, reviewer, and lightweight routing roles initially use the native adapter built on the Vercel AI SDK. This provides direct access to AutoStack tools and the model-router contract.

Eve is supported later as an optional agent adapter and authoring format for teams that want filesystem-defined agents, skills, channels, schedules, and evaluations. AutoStack's workflow, approvals, event log, and runner contracts do not depend on Eve's internal persistence or beta APIs.

## 10. Model routing

### 10.1 Route types

`ModelRoute` has one of these types:

- `vercel_gateway`: dynamic model catalog, provider ordering, model fallback, BYOK, and usage tags.
- `openrouter`: dynamic catalog, provider selection, model fallback, and OpenRouter BYOK behavior.
- `direct`: explicit OpenAI, Anthropic, xAI, or later provider adapter for features not available through an aggregator.

Each route declares supported modalities and features discovered from the provider. The UI filters choices by the capability required by the station rather than presenting an unvalidated universal list.

### 10.2 Policy

Model policy can constrain route, provider, model, maximum input/output tokens, maximum estimated cost, reasoning level, fallback models, and data-handling requirements.

The default personal policy uses a low-cost route for triage and a higher-quality route for planning and review. The implementation harness retains its own model configuration. Team policy may require approved provider lists or zero-data-retention routes.

Usage records include workspace, run, stage, adapter, route, requested model, actual model/provider, input/output/cached tokens, latency, estimated cost, and outcome. Missing provider usage is recorded as unknown rather than estimated as exact.

## 11. Local execution

### 11.1 Desktop process model

- The Electron main process starts and supervises the local control plane and host daemon.
- The renderer is a sandboxed browser context with context isolation enabled, Node integration disabled, and a narrow typed preload bridge.
- The control plane binds to loopback and uses a per-install authentication secret stored in Keychain.
- The host daemon owns PTYs, filesystem access, Git operations, agent child processes, and operating-system actions.
- The desktop can attach to a team control plane without granting that remote service arbitrary access to the local machine.

### 11.2 Workspaces and Git

AutoStack creates managed Git worktrees under its application data directory. A run records repository identity, base commit, worktree path, branch, and runner. Worktrees are retained while a run is active or unarchived and cleaned only through an explicit lifecycle operation.

Before implementation, AutoStack verifies that the base checkout is a Git repository, the requested base branch exists, and no branch with the generated name points at conflicting work. It never resets or cleans a user's existing checkout.

### 11.3 Local durability

SQLite is the local source of truth. The local workflow executor leases runnable stage commands from the database, writes a heartbeat, and commits state transitions and outbox events transactionally. On restart, expired leases return to the queue according to retry policy. This makes approval waits and application restarts durable without requiring a cloud account.

## 12. Team execution

### 12.1 Hosted control plane

The hosted service uses PostgreSQL as the transactional source of truth. Every workspace-owned table includes `workspace_id`, and authorization is checked in the use-case layer before persistence or external API calls.

Vercel Workflow is the first cloud orchestration adapter. Workflow functions coordinate deterministic stages; side effects execute in durable steps. Approval waits use resumable hooks. AutoStack still records domain transitions and evidence in its own database so the product can migrate orchestration vendors.

### 12.2 Cloud runners

Vercel Sandbox is the first cloud runner implementation. `RunnerProvider` remains portable to another microVM, container, Kubernetes, or self-hosted backend.

A cloud environment is created from an AutoStack-controlled snapshot, receives a short-lived GitHub installation token and stage-scoped secrets, clones the exact base commit, and is destroyed after artifacts and the resulting branch are secured. Snapshot creation and dependency prewarming are administrative operations, not agent tools.

### 12.3 Roles

- `admin`: manages integrations, repositories, policies, credentials, automations, members, and budgets.
- `member`: creates and steers runs within permitted repositories and can approve plans for runs they initiated unless repository policy requires a reviewer.
- `reviewer`: has member abilities and can approve publication for protected repositories.

No role permits automatic merge or deployment in the team pilot.

## 13. Integrations

### 13.1 GitHub App

AutoStack uses a GitHub App rather than personal access tokens. It requests only the repository permissions required for metadata, issues, pull requests, checks, and contents. Installation tokens are created just in time, scoped to the target installation and repository, and never persisted in events or artifacts.

Webhook signatures are validated against the raw request body. Delivery identifiers provide ingress idempotency. User-initiated actions use a user access token when authorization must be intersected with that user's GitHub permissions; unattended automations use installation identity and repository policy.

### 13.2 Slack App

The Slack integration validates workspace and user binding before creating or mutating work. Interactive payloads and HTTP events are signature-verified in team mode. Socket Mode envelopes are acknowledged promptly in local mode and then processed from the durable ingress queue.

Slack messages contain concise status, approval controls, and deep links. Full terminal logs, hidden model reasoning, secrets, and large diffs are never posted into Slack.

### 13.3 CLI and API

The `autostack` CLI is a client of the server contract and supports project, task, run, approval, agent, model, automation, and diagnostic operations. Machine-readable commands offer JSON output and stable exit codes.

The API uses versioned schemas and idempotency keys for commands. Streaming run events use WebSocket locally and resumable Server-Sent Events in hosted mode. A client reconnects using its last observed sequence number.

## 14. Security and policy

### 14.1 Trust boundaries

AutoStack treats all of the following as untrusted input:

- Repository contents and repository-level agent instructions.
- Issues, pull-request comments, Slack messages, attachments, and linked pages.
- Agent output, tool arguments, generated shell commands, and dependency scripts.
- Third-party MCP and ACP servers.

Repository instructions may guide code work but cannot grant permissions, reveal secrets, change workspace policy, select a broader credential scope, or approve an action.

### 14.2 Approval gates

Milestone A always requires:

1. Plan approval before writable implementation begins.
2. Explicit response to any agent permission request outside the pre-approved policy.
3. Publication approval before pushing a branch or creating a draft pull request.

Approval evidence includes an immutable digest of the action scope. If the plan, target repository, branch, or publish diff changes materially, the prior approval becomes stale and AutoStack requests a new decision.

### 14.3 Secrets

- Local secrets are stored in macOS Keychain and exposed only to the process or sandbox step that needs them.
- Team secrets use Vercel-managed credentials or an encrypted server-side store with separate encryption keys.
- Logs and events pass through structured redaction before persistence or broadcast.
- AutoStack blocks known credential formats from artifacts and fails closed when redaction cannot safely serialize a payload.
- Agents receive task-scoped tokens instead of long-lived credentials wherever the external service supports them.

### 14.4 Execution policy

Policies cover filesystem roots, command categories, network egress, secret grants, maximum duration, CPU/memory, token and cost budgets, Git operations, and publication rights.

Shell commands are represented as executable plus argument arrays. Shell interpretation is used only when a repository-defined verification command explicitly requires it, and that fact is visible in the plan approval.

## 15. Failure handling

- Duplicate Slack and GitHub deliveries resolve to the existing WorkItem through source delivery identifiers.
- Client disconnection never cancels a run. Clients resume from event sequence.
- Host or agent-process loss marks the session interrupted, preserves evidence, and retries only when the stage policy permits.
- A local host that is offline leaves work visibly waiting; it is not silently reassigned to cloud execution.
- Cancellation sends a graceful adapter cancellation, waits a bounded interval, terminates the process or sandbox, records partial artifacts, and marks the run cancelled.
- Database state is committed before outbox delivery. Notification workers retry idempotently.
- Artifact upload failure prevents a stage from reporting success when that artifact is required evidence.
- A provider fallback is recorded as a route event so evaluation and cost reporting reflect the actual provider/model.
- Cleanup failures create operator-visible maintenance work and do not erase the completed run.

## 16. Observability, evaluations, and memory

### 16.1 Observability

Every command and stage receives trace and correlation identifiers. OpenTelemetry spans cover ingress, workflow transitions, agent sessions, model calls, runner commands, external APIs, artifact storage, and notifications.

Operational metrics include:

- Run and stage counts by state.
- Queue and approval wait time.
- Stage latency and retry counts.
- Harness/model/provider success rate.
- Test and review pass rates.
- Human intervention rate.
- Tokens, cost, and cost per completed pull request.
- Runner provisioning and cleanup health.

### 16.2 Evaluations

AutoStack stores a version for every workflow, prompt, policy, adapter, and model route used by a run. Evaluation datasets can replay captured tasks against candidate configurations without granting publication permissions.

The team pilot includes regression evaluations for triage accuracy, plan completeness, implementation verification, reviewer finding quality, and channel-response correctness. Configuration promotion requires recorded evaluation results rather than anecdotal success.

### 16.3 Factory memory

Factory memory contains repository facts, successful commands, ownership knowledge, conventions, and recurring failure remedies. Memories have source references, scope, confidence, creator, timestamps, and expiry/review state.

Agents may propose memories. Milestone A requires user approval before a proposed memory becomes active. The team pilot may auto-accept low-risk facts derived from repository files while requiring review for behavioral instructions or security-sensitive knowledge. Untrusted issue or Slack text never becomes durable instruction without validation.

## 17. Testing strategy

### 17.1 Unit tests

- Domain state transitions, policy decisions, approval invalidation, idempotency, redaction, cost accounting, and source normalization.
- Model-route capability filtering and usage normalization.
- Adapter event mapping using provider transcript fixtures.

### 17.2 Contract tests

- Versioned client/server and server/runner schemas.
- A shared AgentAdapter conformance suite for Codex, Claude Code, ACP, and native adapters.
- A shared RunnerProvider suite for local and cloud execution.
- SQLite and PostgreSQL persistence implementations against identical repository behavior tests.

### 17.3 Integration tests

- GitHub webhook signature, token scope, idempotency, branch push, comment update, and draft-PR flows against a dedicated test installation or recorded API boundary.
- Slack Socket Mode and HTTP event handling, interactive approvals, retries, and thread updates.
- Local executor restart during each stage and approval wait.
- Vercel Workflow hooks, retries, cancellation, and evidence persistence.
- Sandbox provisioning, checkout, command execution, artifact extraction, and teardown.

### 17.4 End-to-end tests

Critical journeys run through the packaged desktop application and hosted pilot:

1. Create a desktop task and produce a reviewed local branch.
2. Start from Slack, approve the plan, steer the agent, approve publication, and receive a draft PR.
3. Start from a labeled GitHub issue and complete the same workflow.
4. Restart AutoStack while awaiting approval and resume without duplicate work.
5. Deny a permission request and verify the run stops or replans without performing the action.
6. Simulate a failed verification and confirm publication remains unavailable.
7. Switch between Codex, Claude Code, and an ACP fixture agent without changing the workflow.
8. Route native stations through Gateway, OpenRouter, and a direct-provider fixture with correct usage attribution.

Desktop tests include screenshots and accessibility checks for the workbench, approval surfaces, factory dashboard, and failure states.

### 17.5 Security tests

- Prompt-injection fixtures attempting to exfiltrate secrets or override policy.
- Command and path traversal attempts.
- Cross-workspace authorization tests in the team pilot.
- Webhook replay and signature failure tests.
- Secret redaction and artifact scanning fixtures.
- Dependency and supply-chain scanning for packaged desktop/runtime artifacts.

## 18. Milestone A acceptance criteria

Milestone A is complete only when all of the following are demonstrated against a real test repository:

1. The packaged macOS desktop application launches the local control plane and persists data across restart. Signing and notarization are required before external distribution, not for local milestone verification.
2. A user can connect a GitHub App installation and select an accessible repository without storing a PAT.
3. A user can connect a Slack app through Socket Mode and invoke AutoStack from a DM, mention, or message action.
4. A task can be started from desktop, Slack, and a labeled GitHub issue, with duplicate deliveries deduplicated.
5. AutoStack produces a repository-informed plan and cannot begin writable implementation until the user approves it.
6. The user can select Codex, Claude Code, or an ACP-compatible agent; each passes the common adapter conformance suite.
7. Native stations can use a dynamically discovered Vercel AI Gateway model, OpenRouter model, or configured direct OpenAI, Anthropic, or xAI model.
8. Implementation occurs in an AutoStack-managed worktree and never cleans or resets the user's checkout.
9. The user can observe normalized messages, tool activity, files, terminal output, usage, and permissions live and can steer or cancel the session.
10. Required verification commands execute and their exact evidence is retained.
11. An independent reviewer evaluates the approved plan, final diff, and verification evidence in a separate session.
12. Publication is impossible until review passes and the user approves the final action.
13. AutoStack pushes only its generated branch, creates one draft pull request, and reports it back to every originating surface.
14. Restarting the desktop during work or an approval wait resumes from durable state without duplicate external actions.
15. Run history can replay the ordered audit events and open stored plan, diff, test, review, usage, and pull-request artifacts.
16. No configured secret appears in persisted events, ordinary logs, Slack messages, GitHub comments, or exported artifacts.

## 19. Milestone B acceptance criteria

The team pilot is complete only when:

1. Members of the configured GitHub organization can authenticate and are mapped to the single AutoStack workspace.
2. Admin, member, and reviewer permissions are enforced in API, UI, Slack, GitHub, and workflow actions.
3. At least two repositories can run concurrently in isolated cloud sandboxes with repository-scoped credentials.
4. Shared Slack, GitHub, and scheduled automations can be created, paused, versioned, run, and audited.
5. Repository policy controls allowed runners, harnesses, model routes, budgets, approvals, concurrency, retention, and publication.
6. Team runs remain durable across deployment and worker restarts and can wait for approvals without holding a live compute process.
7. Factory dashboards accurately derive throughput, queue depth, pass rate, cycle time, interventions, usage, cost, and repository coverage from recorded evidence.
8. Evaluation runs compare workflow/prompt/harness/model configurations without obtaining publish credentials.
9. Factory memory is scoped, sourced, reviewable, and resistant to untrusted-channel instruction injection.
10. Audit export reconstructs who requested, approved, executed, changed, reviewed, and published each run.
11. The desktop and hosted web application can observe and steer the same team run subject to workspace permissions.
12. Security, integration, contract, workflow, runner, and critical end-to-end test suites pass in CI.

## 20. Delivery sequence

The implementation is divided into independently reviewable subprojects:

1. **Foundation:** monorepo, contracts, domain model, SQLite event store, local workflow executor, CLI diagnostics, and baseline UI shell.
2. **Local execution:** Electron supervision, host daemon, managed worktrees, terminal and artifact streams, policy enforcement, and local runner conformance.
3. **Agent teammates:** native adapter followed by Codex, Claude Code, and ACP adapters with one common conformance suite.
4. **Model plane:** model catalog, credential references, Gateway/OpenRouter/direct adapters, routing policy, usage, and budgets.
5. **First pipeline:** triage, plan, approval, implement, verify, isolated review, publication approval, and durable restart behavior.
6. **GitHub:** App installation, intake, status, branch publication, checks, and draft pull request.
7. **Slack:** local Socket Mode intake, clarification, progress, approvals, steering, and completion.
8. **Workbench and control room:** full run supervision, panes, inspector, approval inbox, automation list, factory dashboard, accessibility, and desktop packaging.
9. **Team control plane:** authentication, PostgreSQL, roles, hosted web, Vercel Workflow adapter, cloud runner, hosted Slack events, and shared GitHub App.
10. **Team operations:** automations, policies, budgets, observability, evaluations, factory memory, audit export, and pilot hardening.

Each subproject gets its own implementation plan, test cycle, review gate, and commit history. The first implementation plan covers only subproject 1 while preserving the contracts required by the complete design.

## 21. Fixed technical constraints

- Runtime language: TypeScript under Node.js 24 LTS.
- Package management: pnpm workspace with a committed lockfile.
- Build orchestration: Turborepo.
- Desktop: Electron with renderer sandboxing, context isolation, and no renderer Node integration.
- Web UI: React with a shared AutoStack component package.
- Control-plane HTTP service: Hono with versioned Zod schemas.
- Local persistence: SQLite in WAL mode.
- Team persistence: PostgreSQL.
- Cloud durable execution: Vercel Workflow behind an AutoStack executor contract.
- First cloud runner: Vercel Sandbox behind `RunnerProvider`.
- Native model runtime: Vercel AI SDK behind `ModelAdapter`.
- Validation: Vitest for unit/contract/integration tests and Playwright for desktop/web end-to-end tests.
- Observability: OpenTelemetry-compatible traces, metrics, and structured logs.
- Git branch prefix created by the product: `autostack/`.
- Source files use UTF-8, LF endings, strict TypeScript, and no unchecked `any` in contract or domain packages.

## 22. Decisions intentionally deferred beyond the team pilot

These are excluded without leaving architectural ambiguity:

- Windows and Linux desktop packaging are separate platform projects after the macOS milestone.
- Mobile applications consume the same server contract but are not part of either accepted milestone.
- Public multi-tenancy adds tenant provisioning, billing, quotas, and marketplace onboarding after the one-workspace pilot.
- Enterprise SSO, SCIM, customer-managed keys, regional data residency, and self-hosted control planes build on Workspace and CredentialRef boundaries later.
- Automatic merge and deployment require separate policy, rollback, environment, and incident-response designs and are never implied by draft-PR publication.
- Additional issue trackers and communication channels implement the existing ingress and channel contracts after GitHub and Slack are proven.

## 23. Research anchors

This design incorporates patterns from the following primary sources without making their products part of AutoStack's trusted core:

- [Factory Software Factory overview](https://docs.factory.ai/software-factory/overview) and [Custom Automations](https://docs.factory.ai/software-factory/automations) for lifecycle coverage, automation triggers, and control-room metrics.
- [Warp's cloud software factory guide](https://www.warp.dev/blog/a-guide-to-cloud-software-factories-for-engineering-leaders) for the separation of runners, orchestration, integrations, human intervention, multi-harness operation, and measurement.
- [Vercel's Eve software factory template](https://github.com/vercel-labs/eve-software-factory-template) for independent classifier, analyst, implementer, and reviewer stations.
- [BB system overview](https://github.com/get-bb/bb/blob/main/docs/system-overview.md), [repository overview](https://github.com/get-bb/bb/blob/main/docs/repository-overview.md), and [configuration](https://github.com/get-bb/bb/blob/main/docs/configuration.md) for the server/daemon/client boundaries and pluggable agent-runtime lessons.
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview) for interoperable sessions, updates, plans, terminals, permissions, cancellation, and configuration.
- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers) and [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection) for dynamic model catalogs, routing, fallback, and usage attribution.
- [GitHub App security guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app), [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), and [webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) for identity, least privilege, and event integrity.
- [Slack agent development](https://docs.slack.dev/ai/developing-agents/) and [Socket Mode](https://api.slack.com/apis/connections/socket) for conversational intake, contextual threads, interactive approvals, and local outbound connectivity.
- [Vercel Workflow](https://github.com/vercel/workflow) and [Vercel Sandbox](https://vercel.com/sandbox) for the first durable cloud-execution and isolated-runner adapters.
