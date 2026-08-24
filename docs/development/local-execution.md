# Local execution development and operation

AutoStack's desktop alpha supervises two independent Electron utility processes. The host daemon owns the local runner and binds an ephemeral numeric-loopback port. The control plane owns durable workflow evidence, binds another ephemeral loopback port, and is the only service exposed to the typed desktop bridge. Every host route requires the generation-private host token; the renderer receives neither token nor either origin.

## Build and verify

Prerequisites are macOS arm64, Node.js 24–26, pnpm 10.27.0, Xcode command-line tools, and Git 2.45 or newer.

```bash
CI=true pnpm install --frozen-lockfile
pnpm desktop:build
node scripts/verify-local-execution.mjs
pnpm desktop:e2e
```

`desktop:build` rebuilds `node-pty` for Electron 43.4.0 in a private temporary build root, stages only that Electron ABI under `apps/desktop/dist/runtime/native`, and writes a digest-bound runtime manifest. It does not rebuild the workspace's ordinary Node dependency tree. The verifier-only entry is built separately under the ignored `.e2e-dist` directory and is absent from the production manifest.

## Private state

Electron's user-data directory contains `private/` with mode `0700`:

- `api-token.enc` is the OS-protected API-token ciphertext; plaintext remains in Electron main only.
- `control-plane/` contains `autostack.sqlite` plus transient WAL/SHM files.
- `host/` contains the held data-root lock, environment journals, command receipts/spools, managed worktrees, private Git configuration, and content-addressed artifacts.

The exact OS user-data parent is selected by Electron. Build-only native staging and the runtime manifest remain under `apps/desktop/dist/` and are not operator data.

## Authority and lifecycle

Local commands run with the desktop user's host filesystem and network authority. AutoStack path checks protect AutoStack's own worktree, journal, spool, and artifact operations; they are not a child-process sandbox.

Prepare and start require current approved immutable scopes. Once work is owned, bounded read, event replay, cancellation, artifact access, and eligible disposal remain available after approval expiry. Commands use executable/argument arrays, not shell strings. Output is redacted before durable publication, subscribers resume by sequence, and artifact content is served only as authenticated digest-verified chunks of at most 1 MiB.

Managed worktrees and `autostack/` branches are retained by default. Disposal is explicit by exact environment identity. Dirty worktrees, active commands, nonterminal runs, invalid terminal evidence, corrupt journals, and ambiguous spawned/running receipts refuse cleanup. Normal cleanup never uses force and AutoStack never resets, cleans, stashes, or switches the user's source checkout. Disposal removes the clean managed worktree but retains the branch.

Normal quit quiesces the control plane, interrupts and drains guardians, drains reconciliation, and closes the host and control plane in evidence-preserving order. Control-plane loss replays durable intents and receipts without duplicate execution. Host loss retires the old control generation and waits for guardian interruption evidence and lease release before a replacement host can own the data root.

Do not export desktop tokens, host tokens, repository paths, native-stage paths, guardian secrets, or runtime-manifest overrides. The `.env.example` variables are only for one-process-scoped standalone control-plane/browser/CLI development. Never load that file into install, build, repository, coding-agent, or model-provider shells.
