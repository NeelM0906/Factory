# AutoStack

AutoStack is a local-first AI software factory: one durable control plane for taking work from a signal to a reviewed delivery, while coding agents operate as interchangeable teammates. The product begins as a personal desktop factory and is designed to grow into a team pilot connected to GitHub and Slack.

This repository contains the foundation and a verified local-first desktop alpha. Electron supervises authenticated loopback host and control-plane utilities, preserves durable run history across restart, exposes repository paths to the renderer only as opaque capabilities, and prepares retained managed worktrees for approved local execution.

## Local alpha capabilities

- Versioned, runtime-validated entities, events, IDs, and API contracts.
- Event-derived run projections with fail-closed transitions and approval evidence.
- Atomic SQLite event, idempotency, and workflow-job storage in WAL mode.
- Lease-based, restart-safe local workflow execution.
- Loopback-only authenticated control plane with stable error contracts.
- Scriptable `autostack doctor` diagnostics and stable exit codes.
- Original graphite, signal-orange, and mint AutoStack operator console.
- Sandboxed, context-isolated Electron renderer with a five-method validated preload bridge.
- Private per-install desktop credential storage and generation-ephemeral host credentials.
- Hardened Git inspection and retained `autostack/` managed worktrees that leave the source checkout untouched.
- Supervised PTY guardians, resumable redacted evidence, bounded artifact reads, and explicit cleanup policy.

This is a built-bundle developer alpha, not an ASAR, signed `.app`, DMG, notarized release, or distributable package. GitHub/Slack invocation, coding-agent/model adapters, draft-PR publication, and the secure team pilot remain later milestones in the [approved design](docs/superpowers/specs/2026-08-20-autostack-design.md).

## Repository map

```text
apps/
  cli/             local diagnostics executable
  control-plane/   authenticated API and runtime composition
  desktop/         Electron supervisor, preload, renderer, and utilities
  host-daemon/     authenticated local runner boundary
  web/             browser-based factory control room
packages/
  contracts/       schemas and versioned public types
  db/              SQLite migrations and durable store
  domain/          decisions, projections, and persistence ports
  ui/              visual tokens and accessible shell primitives
  workflow/        typed handler registry and local executor
docs/
  development/     operating and architecture notes
  superpowers/     approved product design and implementation plans
```

## Quick start

Prerequisites are Node.js 24 and pnpm 10.27 through Corepack. The desktop application additionally
requires macOS on Apple Silicon and Git 2.45 or newer at `/usr/bin/git`, which is the only Git the
local runner will use — see [docs/development/local-execution.md](docs/development/local-execution.md).

```bash
corepack enable
corepack install --global pnpm@10.27.0
pnpm install --frozen-lockfile
pnpm build
pnpm desktop:build
```

Verify the real arm64 Electron bundle and local utility composition:

```bash
node scripts/verify-local-execution.mjs
pnpm desktop:e2e
```

The verifier creates a disposable dirty Git checkout, launches the shipped Electron/main/preload/renderer/host/control bundles, injects host loss, relaunches against the same durable state, and proves the source checkout remains unchanged. Desktop operation does not require entering or exporting a token.

See [Local execution development and operation](docs/development/local-execution.md). Commands run with the desktop user's host filesystem and network authority; AutoStack path checks protect AutoStack operations and are not an operating-system sandbox.

## Browser control-plane development

The standalone browser/CLI development flow still uses `.env.example`:

```bash
cp .env.example .env
```

Replace the deliberately invalid placeholder token in `.env` with the output of `openssl rand -hex 32`. Inject that file only into the individual control-plane or CLI process that needs it; do not load it as a global shell environment.

Start the local API:

```bash
pnpm --filter @autostack/control-plane dev
```

In a second terminal, start the control room without exporting `.env` to it:

```bash
pnpm --filter @autostack/web dev
```

Open `http://127.0.0.1:5173`, choose **Connect**, and enter the same local token. The browser keeps it in `sessionStorage`, not durable browser storage. Verify the running system from a separately credentialed CLI process:

```bash
node apps/cli/dist/main.js doctor
```

The CLI accepts its credential only from `AUTOSTACK_LOCAL_API_TOKEN`; it has no token command-line flag. Do not export the local API token into terminals that run installs, builds, repository scripts, coding agents, or other development tooling.

See [Foundation development and operation](docs/development/foundation.md) for curl examples and the standalone browser workflow.

## Verification

```bash
pnpm format:check
pnpm check
pnpm test:coverage
pnpm build
pnpm desktop:build
node scripts/verify-local-execution.mjs
pnpm desktop:e2e
```

Coverage is enforced at 80% for statements, branches, functions, and lines. CI runs the locked install and the same gates on pushes to `main` and pull requests.
