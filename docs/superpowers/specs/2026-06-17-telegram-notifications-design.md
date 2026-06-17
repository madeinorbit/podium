# Telegram Notifications - Design

**Date:** 2026-06-17
**Status:** Approved (brainstorming) - pending spec review
**Scope:** `packages/core` settings, `apps/server` notification routing, `apps/web` settings UI, focused tests

## Problem

Podium currently has a high-signal notification path for agent states that need
the human: the server creates an `AttentionNotice`, sends web notification events
to browser clients, and optionally sends ntfy mobile push when no Podium browser
window is visible. The next target is Telegram.

The Telegram target is **global per Podium server**, matching the current ntfy
topic model. It is not per user or per device in this pass.

## Current Architecture Findings

- `apps/server/src/notify.ts` owns attention triage. `attentionNotice()` emits a
  notice only when a session transitions into a human-blocked state.
- `apps/server/src/relay.ts` owns smart routing. Browser clients receive
  `attentionEvent` messages when web notifications are enabled; ntfy push only
  fires when no connected browser has reported `visible: true`.
- `packages/core/src/settings.ts` defines global `PodiumSettings`. The settings
  API round-trips the whole settings object and fills missing keys via Zod
  defaults, so old saved settings can gain new notification fields safely.
- `apps/web/src/SettingsView.tsx` already has a Notifications tab with web
  notifications and ntfy topic fields.
- Telegram Bot API `sendMessage` accepts a JSON POST to
  `https://api.telegram.org/bot<token>/sendMessage` with required `chat_id` and
  `text` fields. Using plain text with no parse mode avoids escaping session
  titles or question text.

## Goals

- Add Telegram as another external push target using the existing attention
  triage and visibility gate.
- Configure the target in the existing global Settings UI.
- Allow ntfy and Telegram to be enabled independently or together.
- Keep notification delivery fire-and-forget: failures are logged and never break
  relay state handling.
- Avoid leaking the Telegram bot token in logs or visible non-password UI.

## Non-goals

- Per-user or per-device notification targets.
- Telegram bot setup automation, `getUpdates`, inbound command handling, or
  callback buttons.
- Deep links back into Podium from Telegram messages.
- Secret encryption at rest. The token is stored in the existing settings DB for
  this pass, so filesystem permissions remain the secret boundary.

## Proposed Shape

### Settings

Extend `PodiumSettings.notifications`:

```ts
notifications: {
  web: boolean
  ntfyTopic: string
  telegramBotToken: string
  telegramChatId: string
}
```

Both Telegram fields default to `''`. Telegram is enabled only when both fields
are non-empty after trimming. This preserves backward compatibility for saved
settings that only contain `web` and `ntfyTopic`.

### Settings UI

Add two rows to the Notifications tab:

- `Telegram bot token` - password input, empty means disabled.
- `Telegram chat ID` - text input, supports numeric IDs and `@channelusername`
  style destinations accepted by the Bot API.

The section hint should explain that external push targets use the same smart
routing as ntfy: they are quiet while a Podium window is visibly open.

There is no "test notification" button in this pass. It would require a separate
explicit network action and UI state. The core behavior can be verified by the
same attention-event path that sends real notifications.

### Server Sender

Add a small Telegram sender beside `pushNtfy`:

```ts
interface TelegramConfig {
  botToken: string
  chatId: string
}

function pushTelegram(config: TelegramConfig, notice: AttentionNotice): void
```

Behavior:

- Trim config fields and return immediately unless both are present.
- POST JSON to `https://api.telegram.org/bot${token}/sendMessage`.
- Body:
  - `chat_id`: trimmed chat ID.
  - `text`: `${notice.title}\n\n${notice.body}`.
- Do not set `parse_mode`; all content is plain text.
- Catch network errors and log a warning without throwing.
- If Telegram responds with a non-2xx HTTP status or an `{ ok: false }` JSON
  response, log a warning that includes the status and Telegram description when
  available. Never log the bot token.

The sender should accept an injectable `fetch` in tests or expose a pure request
builder so tests can verify URL/body/error behavior without hitting the network.

### Relay Routing

Keep the current smart-routing semantics:

1. `attentionNotice()` decides whether the state transition deserves attention.
2. Web clients receive `attentionEvent` when `settings.notifications.web` is true.
3. External push targets fire only when no connected client is visible.
4. If ntfy is configured, send ntfy.
5. If Telegram is configured, send Telegram.

Each target failure is isolated. A Telegram failure must not prevent ntfy from
being attempted, and vice versa.

### Testing

Use TDD for implementation. Focused coverage:

- `packages/core/src/settings.test.ts`: old notification blobs normalize with
  empty Telegram defaults; explicit Telegram fields round-trip.
- `apps/server/src/notify.test.ts`: Telegram sender builds the expected request,
  sends plain text with title/body, swallows fetch rejection, and logs non-ok
  responses without exposing the token.
- `apps/server/src/relay.test.ts`: configured external targets are called only
  when no client is visible; Telegram and ntfy can both be attempted for the same
  notice.
- `apps/web` settings structure test if there is a suitable existing pattern;
  otherwise rely on TypeScript and focused unit tests around settings schema.

## Risks

- The Telegram bot token is sensitive and will be stored in the settings DB. This
  matches the requested global server setup but should be revisited if Podium adds
  real user profiles or encrypted secret storage.
- Telegram chat IDs are easy to mistype. The sender should log non-ok responses
  clearly enough to diagnose bad token/chat combinations while redacting the
  token.
- Notification routing currently checks whether any Podium client is visible,
  not whether a specific session is visible. Telegram should preserve that
  behavior in this pass rather than introduce a new routing policy.

## Acceptance Criteria

- A server admin can configure Telegram bot token and chat ID from Settings.
- A transition into `needs_user`, `errored`, or idle question/approval sends a
  Telegram message when no Podium browser window is visible.
- No Telegram message is sent while at least one Podium browser window reports
  visible.
- ntfy behavior is unchanged.
- Missing Telegram fields disable Telegram without warnings.
- Telegram delivery failures are logged and swallowed.
- Tests cover settings defaults, sender behavior, and relay visibility routing.
