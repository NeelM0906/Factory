# GitHub App wiring session

**This is a user action, performed once at the Wave 2 wiring session — not something AutoStack
or this stream registers automatically.** Stream S5 wrote the ingress route and the auth code
this App exercises; it does not create GitHub Apps, install them, or generate credentials on
your behalf. Follow this document by hand at `github.com`, then hand the three resulting
secrets to AutoStack's credential store as described in [Step 6](#step-6-store-the-credentials).

Read [`github-wiring.md`](./github-wiring.md) first — it is the verified record of the `gh`
account, token scopes, repository admin access, and the `autostack` label already confirmed
working for this repository. This document does not repeat any of that; it only covers what
`github-wiring.md` explicitly leaves pending: registering the GitHub App itself.

## Prerequisites

- You can sign in to `github.com` as `NeelM0906` (the account verified in `github-wiring.md`).
- The control plane binds only an ephemeral **loopback** port (see
  [`local-execution.md`](./local-execution.md)) — GitHub cannot deliver a webhook straight to
  `localhost`. Before Step 2 you need a public HTTPS forwarder pointed at your local control
  plane's `/ingress/github` route (an `ngrok http <port>`-style tunnel, Cloudflare Tunnel, or
  `smee.io` relay all work). Note the forwarder's `https://…` base URL; you will append
  `/ingress/github` to it in Step 2.

## Step 1: Start the GitHub App registration

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
   (`https://github.com/settings/apps/new`), signed in as `NeelM0906`.
2. **GitHub App name**: a globally-unique name, e.g. `AutoStack (NeelM0906 dev)`. GitHub rejects
   a name already taken by any account, so add a qualifier if the plain name is unavailable.
3. **Description**: one sentence is enough, e.g. "AutoStack Milestone A local development
   integration — drafts pull requests and comments from labeled issues."
4. **Homepage URL**: the repository URL, `https://github.com/NeelM0906/Factory`.
5. **Callback URL**: leave blank. AutoStack does not use GitHub's user-to-server OAuth flow —
   its two auth strategies are the ambient `gh` user token (`github-wiring.md`) and the App
   installation token (this document) — so no callback is needed.
6. **Expire user authorization tokens** / **Request user authorization (OAuth) during
   installation**: leave unchecked. Checking it activates the OAuth flow Step 5 says AutoStack
   does not use.
7. **Webhook → Active**: check this box.
8. **Webhook URL**: your Step-2-prerequisite forwarder's base URL with `/ingress/github`
   appended, e.g. `https://your-tunnel-subdomain.example.com/ingress/github`. Note the path is
   deliberately outside `/v1` — GitHub webhooks authenticate by signature over the raw body, not
   by AutoStack's bearer token, so this route sits outside the bearer-protected surface entirely
   (see `apps/control-plane/src/ingress/github.ts`).
9. **Webhook secret**: click "Generate a webhook secret" (or use your own long random value).
   Copy it now — GitHub does not show it again after you save. You will store it in Step 6.
   **Do not paste it into this document, a commit, or any repository file.**

## Step 2: Permissions — grant exactly these, nothing wider

Under **Repository permissions**, set only:

| Permission    | Access       | Why this exact permission is needed                                                                       |
| ------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| Metadata      | Read-only    | Required by GitHub on every App; AutoStack reads repository/ref metadata to resolve branches and commits. |
| Issues        | Read & write | Reads the triggering issue body and labels; posts/edits the progress comment thread (spec §4.4).          |
| Pull requests | Read & write | Creates the draft pull request and updates its body as the run progresses.                                |
| Contents      | Read & write | Creates/deletes `autostack/`-prefixed branch refs and writes files to them (`client/branch-refs.ts`).     |
| Checks        | Read-only    | Reads CI check-run status to report it back to the user; AutoStack never triggers or writes a check run.  |

Leave every other permission (Actions, Administration, Discussions, Environments, Pages,
Security events, Workflows, etc.) at **No access**. A permission not listed above is not needed
by anything this stream implemented — granting it would widen the App's blast radius for no
Milestone A feature.

**Subscribe to events**: check exactly `Issues` and `Issue comment`. These are the two events
`parseGitHubDelivery` (`src/webhook/delivery.ts`) accepts; any other event GitHub sends is
ignored with a `202 { ignored: true }` response, so subscribing to more only adds noise.

## Step 3: Where can this GitHub App be installed

Choose **Only on this account** (`NeelM0906`). Milestone A has one authorized owner
(`github-wiring.md`'s numeric id `171834562`); there is no reason for this App to be installable
by any other GitHub account.

## Step 4: Create the App and generate its private key

1. Click **Create GitHub App**.
2. On the resulting App settings page, note the **App ID** (a short number near the top) — you
   will need it in Step 6.
3. Scroll to **Private keys** and click **Generate a private key**. GitHub downloads a
   `.pem` file. Move it somewhere it will not be committed or synced to a shared location; you
   will delete the downloaded copy once it is in the credential store (Step 6).

## Step 5: Install the App on `NeelM0906/Factory`

1. On the App settings page, open **Install App** in the left sidebar.
2. Next to `NeelM0906`, click **Install**.
3. Choose **Only select repositories**, select `Factory`, and confirm.
4. After installation, note the **installation id** from the URL of the installation's settings
   page (`https://github.com/settings/installations/<installation id>`) — this is the id
   `listAccessibleRepositories` (`packages/integration-github/src/client/installations.ts`) is
   called with once the App-installation auth strategy is wired up for it.

## Step 6: Store the credentials

Store all three of the following in AutoStack's credential store (macOS Keychain-backed,
`packages/model-router/src/credential-ref-store.ts`) — **never** in a repository file and
**never** in a `.env` file:

- The **App ID** from Step 4.
- The **private key** `.pem` contents from Step 4 (delete the downloaded file once stored).
- The **webhook secret** from Step 1.

Placeholders only past this point — this document never records the real values:

```text
GITHUB_APP_ID=<placeholder — from Step 4, stored via the credential store>
GITHUB_APP_PRIVATE_KEY=<placeholder — from Step 4, stored via the credential store>
GITHUB_APP_WEBHOOK_SECRET=<placeholder — from Step 1, stored via the credential store>
```

## Numeric-user-id policy note

The workspace's `SourceAuthorizationPolicy` entry for this owner must use the **numeric user id
`171834562`**, never the login `NeelM0906` — see `github-wiring.md`'s "How AutoStack consumes
this" section for the full explanation (`String(user.id)` is what the parser records and what
`externalId` is matched against; the login silently matches nothing and fails closed). Nothing
in App registration itself depends on this — it is a reminder because it is easy to get wrong at
the same wiring session while copying ids around.

## Verification

### Confirm a delivery arrived

1. On the App settings page, open **Advanced** in the left sidebar.
2. Trigger a delivery: add the `autostack` label to any issue on `NeelM0906/Factory` (verify the
   label exists first — `github-wiring.md` confirms it was already created; this step does not
   create it), or comment `@autostack` on an issue.
3. Refresh **Advanced → Recent Deliveries**. A new row appears with the event name (`issues` or
   `issue_comment`), a timestamp, and a response status.
4. A healthy delivery shows **202** (`{"accepted":true}`) or **200** (`{"replayed":true}` if
   AutoStack had already seen that delivery id). Click the row to see the full request/response,
   including headers.

### Read a failed delivery's signature error

If a delivery's response status is **401** with body
`{"error":{"code":"unauthorized","message":"The webhook signature is invalid."}}`
(`apps/control-plane/src/ingress/github.ts`), the raw request body's HMAC-SHA256 (computed with
the webhook secret) did not match the `X-Hub-Signature-256` header GitHub sent. In practice this
means the webhook secret stored in the credential store (Step 6) does not exactly match the one
GitHub has for this App. Fix: regenerate the webhook secret on the App's **General** settings
page, update the credential store with the new value, and use **Redeliver** on the failed
delivery in **Advanced → Recent Deliveries** to confirm it now succeeds.

A **503** response (`{"error":{"code":"local_runner_unavailable", …}}`) is a different failure
mode — it means the signature verified but the local runner was not accepting work at that
moment (ingress closed, or AutoStack was not running).

**GitHub does not automatically retry a failed webhook delivery.** A non-2xx response is recorded
in **Recent Deliveries** and left there; redelivery is a manual action. So a 503 means that event
is waiting for you, not queued for automatic recovery: start AutoStack, then open the failed
delivery and press **Redeliver**. Any event that arrived while AutoStack was down needs the same
treatment, one delivery at a time — nothing replays on its own.
