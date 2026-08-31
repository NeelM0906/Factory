# Slack app wiring session

**This is a user action, performed once at the Wave 2 wiring session — not something AutoStack
or this stream registers automatically.** Stream S5 wrote the Socket Mode client, the ingress
mappers, and the message composer this app exercises; it does not create Slack apps, install
them into a workspace, or generate tokens on your behalf.

There is no `slack-wiring.md` companion record for this app the way `github-wiring.md` exists
for GitHub — no Slack app or workspace has been verified live yet, so this document is the
starting point rather than a complement to an existing record.

## Milestone A uses Socket Mode, not signed HTTP

`packages/integration-slack/src/socket-mode/client.ts` (decision D6) is the path this stream
built and tested for Milestone A: a long-lived WebSocket connection opened via
`apps.connections.open`, with every envelope acked on the socket before being handed to the
durable ingress queue. **Signed HTTP delivery is a Milestone B concern** (spec §13.2) — the
`X-Slack-Signature`/`X-Slack-Request-Timestamp` verifier in
`packages/integration-slack/src/http/signature.ts` exists and is tested, but nothing in this
milestone serves an HTTP endpoint for Slack to call. The **signing secret** you generate below is
still required (Socket Mode's own `apps.connections.open` handshake and any future HTTP-mode
verification both use it), but no public URL needs to be configured for it in this milestone.

## Step 1: Create the app from a manifest

1. Go to `https://api.slack.com/apps` and click **Create New App**.
2. Choose **From an app manifest**.
3. Pick the workspace you are installing AutoStack into.
4. Paste a manifest with the shape below (adjust `display_information.name` to taste; it need
   not be globally unique the way a GitHub App name is). This manifest declares every scope,
   event, and shortcut this stream's code depends on in one step, instead of clicking through
   five separate settings pages:

   ```yaml
   display_information:
     name: AutoStack
     description: Drafts pull requests and reports run progress from Slack.
   features:
     bot_user:
       display_name: autostack
       always_online: true
     shortcuts:
       - name: Run AutoStack on this message
         type: message
         callback_id: autostack_message_action
         description: Start an AutoStack run from this message.
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - chat:write
         - im:history
         - commands
   settings:
     event_subscriptions:
       bot_events:
         - app_mention
         - message.im
     interactivity:
       is_enabled: true
     socket_mode_enabled: true
     org_deploy_enabled: false
     token_rotation_enabled: false
   ```

5. Review and click **Create**.

If you would rather click through the UI instead of pasting a manifest, the equivalent manual
steps are: **OAuth & Permissions** → add the four bot scopes under Step 3 below; **Event
Subscriptions** → enable, subscribe to the two bot events under Step 3; **Interactivity &
Shortcuts** → enable interactivity, add one shortcut ("On messages" type) with callback id
`autostack_message_action`; **Socket Mode** → enable. The manifest does all of this in one pass
and is easier to keep in sync with the scopes this document lists.

## Step 2: Enable Socket Mode and generate the app-level token

1. Open **Settings → Socket Mode** in the left sidebar and confirm it is **Enabled** (the
   manifest above already turns it on; this step is a verification, not a new action).
2. Still on that page (or under **Settings → Basic Information → App-Level Tokens**), click
   **Generate Token and Scopes**.
3. Name the token (e.g. `autostack-socket`), add the **`connections:write`** scope — this is
   the scope `createSocketModeClient`'s `apps.connections.open` call requires — and click
   **Generate**.
4. Copy the token, which starts with `xapp-`. GitHub-style, Slack does not show it again after
   you leave this page. **Do not paste it into this document, a commit, or any repository
   file.** You will store it in Step 5.

## Step 3: Confirm bot scopes and event subscriptions

If you used the manifest in Step 1, these are already set — this step is verification only.
Open **OAuth & Permissions** and confirm exactly these **Bot Token Scopes** are present:

| Scope               | Why this exact scope is needed                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `app_mentions:read` | Receives the `app_mention` event `packages/integration-slack/src/ingress/event-delivery.ts` maps into an `IngressDelivery`. |
| `chat:write`        | Posts and edits the five progress-message kinds `message/compose.ts` composes (spec §4.3).                                  |
| `im:history`        | Receives the `message.im` event for a direct message conversation with the bot.                                             |
| `commands`          | Reserved for a future slash-command entry point; harmless to include now, not yet exercised.                                |

Open **Event Subscriptions** and confirm the bot events `app_mention` and `message.im` are both
subscribed (their handler is `event-delivery.ts`'s `SUPPORTED_EVENT_TYPES` set, currently
`app_mention` and `message`).

## Step 4: Confirm the message-action (shortcut) and interactivity

Open **Interactivity & Shortcuts** and confirm:

- **Interactivity** is toggled on.
- A shortcut named "Run AutoStack on this message" exists, with **type = On messages** and
  **Callback ID = `autostack_message_action`**. This is what invokes AutoStack from an existing
  thread (spec §4.3's third intake path) — matched by
  `packages/integration-slack/src/ingress/interactivity.ts`'s `parseSlackMessageAction`, which
  expects a `message_action` payload (Slack's internal name for a message shortcut).

Because Socket Mode is the transport this milestone uses, no **Request URL** needs to be filled
in for interactivity — Socket Mode delivers interactive payloads over the same WebSocket
connection as events, not to an HTTP endpoint.

## Step 5: Install the app to the workspace and store the credentials

1. Open **Settings → Install App** (or **OAuth & Permissions**) and click **Install to
   Workspace**, then approve the scopes.
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`).
3. Open **Settings → Basic Information → App Credentials** and copy the **Signing Secret**.

Store all three of the following in AutoStack's credential store (macOS Keychain-backed,
`packages/model-router/src/credential-ref-store.ts`) — **never** in a repository file and
**never** in a `.env` file:

- The **app-level token** (`xapp-…`) from Step 2.
- The **bot token** (`xoxb-…`) from this step.
- The **signing secret** from this step.

Placeholders only past this point — this document never records the real values:

```text
SLACK_APP_LEVEL_TOKEN=<placeholder — xapp-…, from Step 2, stored via the credential store>
SLACK_BOT_TOKEN=<placeholder — xoxb-…, from Step 5, stored via the credential store>
SLACK_SIGNING_SECRET=<placeholder — from Step 5, stored via the credential store>
```

`createSocketModeClient`'s `appToken` dependency reads the app-level token fresh on every
connection attempt rather than caching it (`packages/integration-slack/src/socket-mode/client.ts`)
— point that supplier at the credential store, not at an environment variable.

## Verification

1. Start the local control plane / desktop app with the three credentials above wired in.
2. In your terminal or the app's logs, confirm the Socket Mode connection opens: `connect()`
   resolves without throwing, and Slack's **Settings → Socket Mode** page (or `apps.connections.open`
   activity) shows an active connection.
3. In the workspace, `@mention` the bot in a channel it is a member of. The event should reach
   `IngressQueue` (acked on the socket immediately, then drained by the caller) and appear in
   AutoStack's own logs/evidence as an accepted `app_mention` delivery.
4. Right-click (or use the shortcuts "⋮" menu on) any message and confirm "Run AutoStack on this
   message" appears and, when invoked, produces a `message_action` delivery.

A connection that never opens, or that opens and immediately closes, most often means the
`xapp-` token is missing the `connections:write` scope (Step 2) or the bot has not yet been
installed to the workspace (Step 5) — re-check both before assuming a code defect.
