# Foundation development and operation

This guide operates AutoStack's local-first foundation and records the invariants the next subproject must preserve.

## Requirements and configuration

Use Node.js 24 and pnpm 10.27.0. Install dependencies from the committed lockfile:

```bash
corepack enable
corepack install --global pnpm@10.27.0
pnpm install --frozen-lockfile
pnpm build
```

Generate at least 32 bytes of entropy for the local bearer token:

```bash
openssl rand -hex 32
```

Copy `.env.example` to `.env` and replace its deliberately invalid placeholder. Load it only into the control-plane and CLI shells that require the bearer credential:

```bash
set -a
source .env
set +a
```

`AUTOSTACK_DATA_DIR` selects the state directory. The control plane creates `${AUTOSTACK_DATA_DIR}/autostack.sqlite` and its WAL support files. It defaults to `./autostack-data`. This directory may contain work history and must not be committed or casually deleted.

The server binds to `127.0.0.1:4318` by default. A non-loopback bind is rejected unless `AUTOSTACK_ALLOW_NON_LOOPBACK=true` is explicit; that switch is for controlled development networks, not ordinary personal operation.

## Run the vertical slice

Terminal one—control plane:

```bash
pnpm --filter @autostack/control-plane dev
```

Terminal two—web control room:

```bash
pnpm --filter @autostack/web dev
```

Do not load `.env` in the web terminal or in a shell that runs installs, builds, repository scripts, coding agents, or unrelated tools. The renderer receives the token only through the explicit connection form and keeps it in session storage. The CLI accepts its credential only through `AUTOSTACK_LOCAL_API_TOKEN`.

Terminal three—diagnostics:

```bash
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js doctor --json
```

The doctor command exits `0` when healthy, `1` for invalid usage, `2` for authentication failure, and `3` when the control plane is unavailable or degraded.

Create a manual run through the API:

```bash
curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${AUTOSTACK_LOCAL_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: manual-example-1" \
  --data '{"title":"Connect the first coding teammate","description":"Prepare the local adapter boundary."}' \
  "${AUTOSTACK_URL}/v1/runs"
```

Repeating that exact command returns the original work-item and run IDs with `replayed: true`. Restart the control plane and list the same durable run:

```bash
curl --fail-with-body \
  --header "Authorization: Bearer ${AUTOSTACK_LOCAL_API_TOKEN}" \
  "${AUTOSTACK_URL}/v1/runs"
```

## Persistence invariants

- Events are immutable, schema-versioned, ordered by stream version, and globally ordered by SQLite sequence.
- A commit checks every expected stream version and appends all events and queued work in one `BEGIN IMMEDIATE` transaction.
- Idempotency is scoped. A repeated scope/key returns the exact stored commit result and never creates another event or workflow job.
- Projections are rebuilt from validated events; serialized database JSON is never trusted without schema validation.
- Workflow jobs are leased with a unique token and expiry. Only the current, unexpired lease can heartbeat, complete, or fail a job.
- Expired leases are recoverable and increment the attempt. Maximum attempts terminate the job instead of retrying forever.
- Approval decisions bind to canonical evidence digests and fail closed when evidence becomes stale.
- API tokens are configuration secrets. They do not belong in URLs, events, logs, errors, generated web assets, or committed environment files.

## Development gates

Run the same sequence used by CI from a fresh terminal where `.env` has not been loaded:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm check
pnpm test:coverage
pnpm build
```

The restart test lives at `apps/control-plane/test/foundation-flow.test.ts`. It creates a run through the HTTP application boundary, closes SQLite, reopens the same file, verifies event replay, repeats the idempotent command, and proves no duplicate run or event exists.

## Next subproject boundary: local execution

The next subproject turns a durable run into repository work without weakening the foundation. It adds managed Git worktrees under the application data directory; a runner protocol; adapters for Codex, Claude Code, and ACP-compatible harnesses; normalized tool, permission, and result events; provider routing through Vercel AI Gateway, OpenRouter, and direct providers; artifact capture; cancellation and resume; and the Electron desktop boundary.

That work must consume the existing `DurableStore` and `HandlerRegistry` ports. Provider SDKs, Git processes, and Electron APIs stay outside domain decisions. Every external effect receives an idempotency key, secrets remain referenced rather than serialized, and publish operations continue to require explicit approval evidence.
