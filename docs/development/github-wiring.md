# GitHub wiring — NeelM0906/Factory

Live wiring state for Milestone A's GitHub integration, verified 2026-08-31 against the
user's own `gh` CLI. This is the durable record composition (Wave 2 I1) and the acceptance
run read from; update it if any of these facts change.

## Verified working today

| Fact | Value | Verified how |
| --- | --- | --- |
| Account | `NeelM0906` (user id `171834562`) | `gh auth status`, `gh api user` |
| Token storage | macOS keyring via `gh` (never copied into AutoStack) | `gh auth status` |
| Token scopes | `gist`, `read:org`, `repo`, `workflow` | `gh auth status` |
| Repo access | `NeelM0906/Factory`, viewer permission **ADMIN** | `gh repo view` |
| Default branch | `codex/autostack-foundation` | `gh api repos/…` |
| Live API reachability | 200 on repo + labels reads | `gh api` |
| Trigger label | `autostack` (created 2026-08-31, color `#6f42c1`) | `gh api …/labels` POST |

## How AutoStack consumes this

- **Auth mode: ambient user token.** `createUserTokenAuth` (integration-github) re-reads the
  token on every call via an injected `readToken`; composition supplies
  `() => exec("gh auth token")`. The token is never persisted, logged, or copied — rotation
  and revocation stay entirely inside `gh`. `repo` scope covers every API operation Milestone
  A performs (create branch ref, draft PR, duplicate-recovery reads).
- **Triggers.** `issues.labeled` is gated on the `autostack` label (now present in the repo);
  `issue_comment.created` is gated on an `@autostack` mention (addressing only — never a
  grant).
- **Source authorization policy entry.** The parser records actors as
  `String(payload.…user.id)` — the **numeric id, not the login**. The workspace policy that
  authorizes the owner to start runs from GitHub must therefore contain:

  ```json
  { "source": "github", "externalId": "171834562" }
  ```

  An entry carrying `"NeelM0906"` would fail closed (correctly, but confusingly).

## Still pending (final wiring session, ~15 min, needs the user)

- **GitHub App registration** — webhook ingress (signature secret, delivery endpoint) needs
  it; blocked until the control-plane ingress route (S5 Task 15) and the click-by-click
  instructions (S5 Task 16) exist. User-token auth above does NOT cover webhooks.
- **Slack app + Socket Mode token** — unrelated to GitHub but part of the same session.
- Live re-run of §17.4 journeys 2–3 after both registrations.
