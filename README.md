# AutoStack

AutoStack is a local-first AI software factory: one durable control plane for taking work from a signal to a reviewed delivery, while coding agents operate as interchangeable teammates. The product begins as a personal desktop factory and is designed to grow into a team pilot connected to GitHub and Slack.

This repository currently contains the verified foundation. It can accept a manual work item, persist its run and event history in SQLite/WAL, survive a restart, expose authenticated local APIs, report diagnostics through a CLI, and render the durable state in an accessible browser control room.

## Foundation capabilities

- Versioned, runtime-validated entities, events, IDs, and API contracts.
- Event-derived run projections with fail-closed transitions and approval evidence.
- Atomic SQLite event, idempotency, and workflow-job storage in WAL mode.
- Lease-based, restart-safe local workflow execution.
- Loopback-only authenticated control plane with stable error contracts.
- Scriptable `autostack doctor` diagnostics and stable exit codes.
- Original graphite, signal-orange, and mint AutoStack operator console.

The foundation intentionally does not yet execute repositories or call coding models. Local worktrees, GitHub, model routing, Codex/Claude/ACP adapters, Electron packaging, and Slack arrive in the subsequent subprojects described in the [approved design](docs/superpowers/specs/2026-08-20-autostack-design.md).

## Repository map

```text
apps/
  cli/             local diagnostics executable
  control-plane/   authenticated API and runtime composition
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

Prerequisites are Node.js 24 and pnpm 10.27 through Corepack.

```bash
corepack enable
corepack install --global pnpm@10.27.0
pnpm install --frozen-lockfile
cp .env.example .env
```

Replace the placeholder token in `.env` with the output of `openssl rand -hex 32`, then export the file in each terminal:

```bash
set -a
source .env
set +a
```

Start the local API:

```bash
pnpm --filter @autostack/control-plane dev
```

In a second terminal, start the control room:

```bash
pnpm --filter @autostack/web dev
```

Open `http://127.0.0.1:5173`, choose **Connect**, and enter the same local token. The browser keeps it in `sessionStorage`, not durable browser storage. Verify the running system from another terminal:

```bash
pnpm --filter @autostack/cli build
node apps/cli/dist/main.js doctor
```

See [Foundation development and operation](docs/development/foundation.md) for curl examples, storage details, invariants, test commands, and the next implementation boundary.

## Verification

```bash
pnpm format:check
pnpm check
pnpm test:coverage
pnpm build
```

Coverage is enforced at 80% for statements, branches, functions, and lines. CI runs the locked install and the same gates on pushes to `main` and pull requests.
