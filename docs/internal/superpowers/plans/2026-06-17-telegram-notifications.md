# Telegram Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram as a global per-Podium-server external notification target using the existing attention-event triage and visibility gate.

**Architecture:** Extend the global settings schema with optional Telegram fields, add a focused Telegram sender beside the existing ntfy sender, and wire relay routing so configured external targets fire only when no Podium browser window is visible. The Settings UI exposes the fields in the existing Notifications tab; no per-user target table is introduced.

**Tech Stack:** TypeScript, Zod settings schema in `@podium/core`, Vitest, React Settings UI, server-side `fetch`.

---

## File Structure

- Modify `packages/core/src/settings.ts`: add `telegramBotToken` and `telegramChatId` defaults under `notifications`.
- Modify `packages/core/src/settings.test.ts`: cover backward-compatible defaults and explicit Telegram normalization.
- Modify `apps/server/src/notify.ts`: add Telegram config types and a `pushTelegram()` fire-and-forget sender.
- Modify `apps/server/src/notify.test.ts`: cover Telegram request shape, disabled config, network failures, non-ok responses, and token redaction.
- Modify `apps/server/src/relay.ts`: call `pushTelegram()` under the same external-push visibility gate as ntfy.
- Modify `apps/server/src/relay.test.ts`: cover external push routing with both ntfy and Telegram configured.
- Modify `apps/web/src/SettingsView.tsx`: add Telegram bot token and chat ID inputs to the Notifications tab.
- Optional modify `apps/web/test/shell.structure.test.ts`: only if an existing structure test already asserts Settings text. Do not add broad React rendering scaffolding for this small UI addition.

---

## Task 1: Settings Schema Defaults

**Files:**
- Modify: `packages/core/src/settings.test.ts`
- Modify: `packages/core/src/settings.ts`

- [ ] **Step 1: Write failing settings tests**

Append this `describe` block to `packages/core/src/settings.test.ts`:

```ts
describe('normalizeSettings — notification targets', () => {
  it('fills Telegram notification defaults for old saved settings', () => {
    const s = normalizeSettings({
      notifications: { web: false, ntfyTopic: 'podium-topic' },
    })

    expect(s.notifications).toMatchObject({
      web: false,
      ntfyTopic: 'podium-topic',
      telegramBotToken: '',
      telegramChatId: '',
    })
  })

  it('keeps explicit Telegram notification settings', () => {
    const s = normalizeSettings({
      notifications: {
        web: true,
        ntfyTopic: '',
        telegramBotToken: '123456:secret',
        telegramChatId: '-1001234567890',
      },
    })

    expect(s.notifications.telegramBotToken).toBe('123456:secret')
    expect(s.notifications.telegramChatId).toBe('-1001234567890')
  })
})
```

- [ ] **Step 2: Run the focused settings test and verify RED**

Run:

```bash
bun test packages/core/src/settings.test.ts
```

Expected: FAIL because `telegramBotToken` and `telegramChatId` are not present on `notifications`.

- [ ] **Step 3: Add Telegram defaults to the settings schema**

In `packages/core/src/settings.ts`, update the `notifications` object from:

```ts
  notifications: z
    .object({
      web: z.boolean().default(true),
      /** ntfy.sh topic for mobile push (empty = off). */
      ntfyTopic: z.string().default(''),
    })
    .default({}),
```

to:

```ts
  notifications: z
    .object({
      web: z.boolean().default(true),
      /** ntfy.sh topic for mobile push (empty = off). */
      ntfyTopic: z.string().default(''),
      /** Telegram bot token for global server push (empty = off). */
      telegramBotToken: z.string().default(''),
      /** Telegram chat id or @channelusername for global server push (empty = off). */
      telegramChatId: z.string().default(''),
    })
    .default({}),
```

- [ ] **Step 4: Run the focused settings test and verify GREEN**

Run:

```bash
bun test packages/core/src/settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/core/src/settings.ts packages/core/src/settings.test.ts
git commit -m "feat(core): add telegram notification settings"
```

---

## Task 2: Telegram Sender

**Files:**
- Modify: `apps/server/src/notify.test.ts`
- Modify: `apps/server/src/notify.ts`

- [ ] **Step 1: Write failing Telegram sender tests**

Replace the import in `apps/server/src/notify.test.ts`:

```ts
import { attentionNotice } from './notify'
```

with:

```ts
import { attentionNotice, pushTelegram } from './notify'
```

Append this `describe` block to `apps/server/src/notify.test.ts`:

```ts
describe('pushTelegram', () => {
  it('posts a plain-text sendMessage request with trimmed config', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })

    pushTelegram(
      { botToken: ' 123456:secret ', chatId: ' -100123 ' },
      { title: 'podium / keyboard needs you', body: 'SQLite or Postgres?' },
      { fetch },
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:secret/sendMessage',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: '-100123',
          text: 'podium / keyboard needs you\n\nSQLite or Postgres?',
        }),
      },
    )
  })

  it('does nothing when either Telegram field is blank', async () => {
    const fetch = vi.fn()

    pushTelegram({ botToken: '', chatId: '-100123' }, { title: 't', body: 'b' }, { fetch })
    pushTelegram({ botToken: '123456:secret', chatId: '   ' }, { title: 't', body: 'b' }, { fetch })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('logs and swallows network failures', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('socket closed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    pushTelegram(
      { botToken: '123456:secret', chatId: '-100123' },
      { title: 't', body: 'b' },
      { fetch },
    )

    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(warn.mock.calls.flat().join(' ')).toContain('socket closed')
    warn.mockRestore()
  })

  it('logs non-ok Telegram responses without exposing the bot token', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    pushTelegram(
      { botToken: '123456:secret', chatId: '-100123' },
      { title: 't', body: 'b' },
      { fetch },
    )

    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain('400')
    expect(logged).toContain('chat not found')
    expect(logged).not.toContain('123456:secret')
    warn.mockRestore()
  })
})
```

Also update the Vitest import at the top of `apps/server/src/notify.test.ts` from:

```ts
import { describe, expect, it } from 'vitest'
```

to:

```ts
import { describe, expect, it, vi } from 'vitest'
```

- [ ] **Step 2: Run the focused notify test and verify RED**

Run:

```bash
bun test apps/server/src/notify.test.ts
```

Expected: FAIL because `pushTelegram` is not exported.

- [ ] **Step 3: Implement the minimal Telegram sender**

In `apps/server/src/notify.ts`, after `pushNtfy`, add:

```ts
export interface TelegramConfig {
  botToken: string
  chatId: string
}

type PushTelegramFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

interface PushTelegramOptions {
  fetch?: PushTelegramFetch
}

type TelegramResponseBody = {
  ok?: boolean
  description?: string
}

async function telegramDescription(res: Pick<Response, 'json'>): Promise<string | undefined> {
  try {
    const body = (await res.json()) as TelegramResponseBody
    return typeof body.description === 'string' ? body.description : undefined
  } catch {
    return undefined
  }
}

/** Fire-and-forget Telegram push. Failures are logged, never thrown. */
export function pushTelegram(
  config: TelegramConfig,
  notice: AttentionNotice,
  opts: PushTelegramOptions = {},
): void {
  const botToken = config.botToken.trim()
  const chatId = config.chatId.trim()
  if (!botToken || !chatId) return

  const send = opts.fetch ?? fetch
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`
  send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `${notice.title}\n\n${notice.body}`,
    }),
  })
    .then(async (res) => {
      if (res.ok) return
      const description = await telegramDescription(res)
      console.warn(
        '[podium] Telegram push failed:',
        description ? `${res.status} ${description}` : `HTTP ${res.status}`,
      )
    })
    .catch((err) => {
      console.warn('[podium] Telegram push failed:', err instanceof Error ? err.message : err)
    })
}
```

- [ ] **Step 4: Run the focused notify test and verify GREEN**

Run:

```bash
bun test apps/server/src/notify.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/server/src/notify.ts apps/server/src/notify.test.ts
git commit -m "feat(server): add telegram push sender"
```

---

## Task 3: Relay External Push Routing

**Files:**
- Modify: `apps/server/src/relay.test.ts`
- Modify: `apps/server/src/relay.ts`

- [ ] **Step 1: Write a failing relay routing test**

Append this test to the existing `describe('agent state', () => { ... })` block in `apps/server/src/relay.test.ts`:

```ts
  it('sends every configured external push target only when no client is visible', () => {
    const store = new SessionStore(':memory:')
    const settings = store.getSettings()
    store.setSettings({
      ...settings,
      notifications: {
        ...settings.notifications,
        web: true,
        ntfyTopic: 'podium-topic',
        telegramBotToken: '123456:secret',
        telegramChatId: '-100123',
      },
    })
    const ntfy = vi.fn()
    const telegram = vi.fn()

    try {
      const reg = new SessionRegistry(store, { ntfy, telegram })
      reg.attachDaemon(() => {})
      const { sessionId } = reg.createSession({
        agentKind: 'claude-code',
        cwd: '/proj',
        title: 'keyboard',
      })
      const hidden = sink()
      const hiddenId = reg.attachClient(hidden.send)
      reg.onClientMessage(hiddenId, { type: 'presence', visible: false })
      hidden.sent.length = 0

      reg.onDaemonMessage({
        type: 'agentState',
        sessionId,
        state: {
          phase: 'needs_user',
          since: '2026-06-12T10:00:00.000Z',
          openTaskCount: 0,
          need: { kind: 'question', summary: 'SQLite or Postgres?' },
        },
      })

      expect(hidden.sent).toContainEqual({
        type: 'attentionEvent',
        sessionId,
        title: 'keyboard needs you',
        body: 'SQLite or Postgres?',
      })
      expect(ntfy).toHaveBeenCalledWith('podium-topic', {
        title: 'keyboard needs you',
        body: 'SQLite or Postgres?',
      })
      expect(telegram).toHaveBeenCalledWith(
        { botToken: '123456:secret', chatId: '-100123' },
        { title: 'keyboard needs you', body: 'SQLite or Postgres?' },
      )

      ntfy.mockClear()
      telegram.mockClear()
      const visible = sink()
      const visibleId = reg.attachClient(visible.send)
      reg.onClientMessage(visibleId, { type: 'presence', visible: true })
      reg.onDaemonMessage({
        type: 'agentState',
        sessionId,
        state: {
          phase: 'errored',
          since: '2026-06-12T10:01:00.000Z',
          openTaskCount: 0,
          error: { class: 'rate_limit', retryable: true },
        },
      })

      expect(ntfy).not.toHaveBeenCalled()
      expect(telegram).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })
```

- [ ] **Step 2: Run the focused relay test and verify RED**

Run:

```bash
bun test apps/server/src/relay.test.ts --runInBand
```

Expected: FAIL because `pushTelegram` is not called by the relay yet.

- [ ] **Step 3: Add a small notification-pusher seam and wire Telegram**

Update the import at the top of `apps/server/src/relay.ts` from:

```ts
import { attentionNotice, pushNtfy } from './notify'
```

to:

```ts
import {
  attentionNotice,
  type AttentionNotice,
  pushNtfy,
  pushTelegram,
  type TelegramConfig,
} from './notify'
```

Above `export class SessionRegistry`, add:

```ts
interface NotificationPushers {
  ntfy(topic: string, notice: AttentionNotice): void
  telegram(config: TelegramConfig, notice: AttentionNotice): void
}

const DEFAULT_NOTIFICATION_PUSHERS: NotificationPushers = {
  ntfy: pushNtfy,
  telegram: pushTelegram,
}
```

Change the constructor from:

```ts
  constructor(private readonly store: SessionStore = new SessionStore(':memory:')) {
    this.loadFromStore()
  }
```

to:

```ts
  constructor(
    private readonly store: SessionStore = new SessionStore(':memory:'),
    private readonly notificationPushers: NotificationPushers = DEFAULT_NOTIFICATION_PUSHERS,
  ) {
    this.loadFromStore()
  }
```

In `notifyAttention()`, replace:

```ts
    if (settings.ntfyTopic) {
      const someoneWatching = [...this.clients.values()].some((c) => c.visible)
      if (!someoneWatching) pushNtfy(settings.ntfyTopic, notice)
    }
```

with:

```ts
    const telegram = {
      botToken: settings.telegramBotToken,
      chatId: settings.telegramChatId,
    }
    const telegramEnabled = telegram.botToken.trim() !== '' && telegram.chatId.trim() !== ''
    if (settings.ntfyTopic || telegramEnabled) {
      const someoneWatching = [...this.clients.values()].some((c) => c.visible)
      if (!someoneWatching) {
        if (settings.ntfyTopic) this.notificationPushers.ntfy(settings.ntfyTopic, notice)
        if (telegramEnabled) this.notificationPushers.telegram(telegram, notice)
      }
    }
```

- [ ] **Step 4: Run the focused relay test and verify GREEN**

Run:

```bash
bun test apps/server/src/relay.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(server): route attention notices to telegram"
```

---

## Task 4: Settings UI Fields

**Files:**
- Modify: `apps/web/src/SettingsView.tsx`

- [ ] **Step 1: Typecheck first to capture the pre-change baseline**

Run:

```bash
bun run typecheck
```

Expected: PASS. If it fails before UI edits, stop and record the pre-existing failure.

- [ ] **Step 2: Add Telegram fields to the Notifications section**

In `apps/web/src/SettingsView.tsx`, find the Notifications section:

```tsx
            {tab === 'notifications' && (
              <Section
                title="Notifications"
                hint="Web notifications fire when this page is open in the background. The ntfy topic adds real mobile push: install the free ntfy app, subscribe to your topic."
              >
```

Change the `hint` to:

```tsx
                hint="Web notifications fire when this page is open in the background. External push targets use the same smart routing: they stay quiet while a Podium window is visible."
```

After the existing `ntfy.sh topic` row, add:

```tsx
                <Row label="Telegram bot token">
                  <Input
                    type="password"
                    placeholder="empty = off"
                    value={settings.notifications.telegramBotToken}
                    onChange={(e) =>
                      patch({
                        notifications: {
                          ...settings.notifications,
                          telegramBotToken: e.target.value,
                        },
                      })
                    }
                  />
                </Row>
                <Row label="Telegram chat ID">
                  <Input
                    type="text"
                    placeholder="e.g. -1001234567890 or @channel"
                    value={settings.notifications.telegramChatId}
                    onChange={(e) =>
                      patch({
                        notifications: {
                          ...settings.notifications,
                          telegramChatId: e.target.value,
                        },
                      })
                    }
                  />
                </Row>
```

- [ ] **Step 3: Run typecheck for UI schema integration**

Run:

```bash
bun run typecheck
```

Expected: PASS. This proves `PodiumSettings.notifications` fields are visible to the web package.

- [ ] **Step 4: Commit Task 4**

```bash
git add apps/web/src/SettingsView.tsx
git commit -m "feat(web): expose telegram notification settings"
```

---

## Task 5: Full Verification

**Files:**
- No new code files unless verification exposes a bug.

- [ ] **Step 1: Run notification and settings tests together**

Run:

```bash
bun test packages/core/src/settings.test.ts apps/server/src/notify.test.ts apps/server/src/relay.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run all tests**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 3: Run full typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only intentional Telegram notification changes remain uncommitted. The existing untracked `report.*.json` files may still appear; do not stage or delete them.

- [ ] **Step 5: Final commit if verification changed anything after Task 4**

If Task 5 required fixes, commit them:

```bash
git add packages/core/src/settings.ts packages/core/src/settings.test.ts apps/server/src/notify.ts apps/server/src/notify.test.ts apps/server/src/relay.ts apps/server/src/relay.test.ts apps/web/src/SettingsView.tsx
git commit -m "fix(notifications): finalize telegram push target"
```

If Task 5 produced no code changes, do not create an empty commit.

---

## Self-Review

- **Spec coverage:** Task 1 covers schema/defaults; Task 2 covers Telegram Bot API send behavior, plain text, and redacted failure logging; Task 3 covers smart routing and independent ntfy/Telegram enablement; Task 4 covers global Settings UI; Task 5 covers verification.
- **Scope:** This is one focused feature. It does not add per-user targets, inbound Telegram handling, deep links, or secret encryption.
- **Type consistency:** The plan consistently uses `telegramBotToken`, `telegramChatId`, `TelegramConfig`, and `pushTelegram(config, notice, opts?)`.
- **TDD:** Tasks 1-3 add failing tests before production code. Task 4 is UI wiring covered by typecheck because there is no existing focused Settings render test; do not invent broad UI test scaffolding for this small field addition.
