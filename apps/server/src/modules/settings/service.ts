import { randomUUID } from 'node:crypto'
import type { PodiumSettings } from '@podium/runtime'
import { ModelCatalog, type ModelCatalogSnapshot, type ModelProbe } from '../../model-catalog'
import type { TelegramConfig } from '../../notify'
import type { SessionStore } from '../../store'
import type { EventBus } from '../bus'

const TELEGRAM_SETUP_TTL_MS = 5 * 60 * 1000

interface TelegramSetupUpdate {
  updateId: number
  chatId: string | number
  chatType: string
  chatLabel?: string
  text: string
}

export interface TelegramSetupClient {
  getMe(botToken: string): Promise<{ username: string }>
  getUpdates(botToken: string): Promise<TelegramSetupUpdate[]>
  sendMessage(config: TelegramConfig, text: string): Promise<void>
  acknowledgeUpdates?(botToken: string, offset: number): Promise<void>
}

interface PendingTelegramSetup {
  code: string
  botUsername: string
  expiresAtMs: number
}

export interface TelegramSetupStartResult {
  setupId: string
  code: string
  botUsername: string
  telegramUrl: string
  expiresAt: string
}

export type TelegramSetupPollResult =
  | { status: 'pending'; expiresAt: string }
  | { status: 'expired' }
  | {
      status: 'connected'
      chatId: string
      chatType: string
      chatLabel?: string
      settings: PodiumSettings
    }

function telegramApiUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken.trim()}/${method}`
}

type TelegramApiBody = {
  ok?: boolean
  description?: string
  result?: unknown
}

async function telegramJson(
  botToken: string,
  method: string,
  init?: RequestInit,
): Promise<TelegramApiBody> {
  const res = await fetch(telegramApiUrl(botToken, method), init)
  const body = (await res.json().catch(() => ({}))) as TelegramApiBody
  if (res.ok && body.ok === true) return body
  const description = typeof body.description === 'string' ? body.description : `HTTP ${res.status}`
  throw new Error(description)
}

function telegramUpdateChatLabel(chat: {
  username?: unknown
  title?: unknown
  first_name?: unknown
}): string | undefined {
  if (typeof chat.username === 'string' && chat.username) return `@${chat.username}`
  if (typeof chat.title === 'string' && chat.title) return chat.title
  if (typeof chat.first_name === 'string' && chat.first_name) return chat.first_name
  return undefined
}

function parseTelegramSetupUpdates(result: unknown): TelegramSetupUpdate[] {
  if (!Array.isArray(result)) return []
  const updates: TelegramSetupUpdate[] = []
  for (const update of result) {
    if (!update || typeof update !== 'object') continue
    const u = update as { update_id?: unknown; message?: unknown; channel_post?: unknown }
    const msg = (u.message ?? u.channel_post) as { chat?: unknown; text?: unknown } | undefined
    const chat = msg?.chat as
      | { id?: unknown; type?: unknown; username?: unknown; title?: unknown; first_name?: unknown }
      | undefined
    if (typeof u.update_id !== 'number') continue
    if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) continue
    if (typeof chat.type !== 'string') continue
    if (typeof msg?.text !== 'string') continue
    updates.push({
      updateId: u.update_id,
      chatId: chat.id,
      chatType: chat.type,
      chatLabel: telegramUpdateChatLabel(chat),
      text: msg.text,
    })
  }
  return updates
}

const DEFAULT_TELEGRAM_SETUP_CLIENT: TelegramSetupClient = {
  async getMe(botToken) {
    const body = await telegramJson(botToken, 'getMe')
    const result = body.result as { username?: unknown } | undefined
    if (typeof result?.username !== 'string' || !result.username) {
      throw new Error('Telegram bot username was missing')
    }
    return { username: result.username }
  },
  async getUpdates(botToken) {
    const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'channel_post']))
    const body = await telegramJson(botToken, `getUpdates?allowed_updates=${allowedUpdates}`)
    return parseTelegramSetupUpdates(body.result)
  },
  async sendMessage(config, text) {
    await telegramJson(config.botToken, 'sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId.trim(), text }),
    })
  },
  async acknowledgeUpdates(botToken, offset) {
    await telegramJson(botToken, `getUpdates?offset=${offset}`)
  },
}

function defaultTelegramSetupCode(): string {
  return `PODIUM${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`
}

function telegramSetupUrl(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`
}

function telegramTextHasCode(text: string, code: string): boolean {
  const want = code.toUpperCase()
  return text
    .trim()
    .split(/\s+/)
    .some((part) => part.toUpperCase() === want)
}

/** The store surface this module persists through. */
type SettingsStore = Pick<
  SessionStore['settings'],
  'getSettings' | 'setSettings' | 'getModelCatalog' | 'setModelCatalog'
>

export interface SettingsServiceOptions {
  telegramSetup?: TelegramSetupClient
  generateTelegramSetupCode?: () => string
  now?: () => number
  /** Live model-list probe (grok/cursor/opencode `models`). Injected in tests so the
   *  catalog never shells out; defaults to the real CLI probe. */
  modelProbe?: ModelProbe
}

/**
 * Settings + model catalog + telegram-setup flow — peeled off SessionRegistry
 * (issue #13 Phase 2). setSettings persists first, then emits 'settings.changed'
 * on the bus; reactions (notification replay, auto-continue re-arm) live with
 * their subscribers, not here.
 */
export class SettingsService {
  private readonly telegramSetups = new Map<string, PendingTelegramSetup>()
  private readonly telegramSetup: TelegramSetupClient
  private readonly generateTelegramSetupCode: () => string
  private readonly now: () => number
  // SWR cache of live per-agent model lists (grok/cursor/opencode). Query-driven:
  // nothing probes until a client asks via getModelCatalog().
  private readonly modelCatalog: ModelCatalog

  constructor(
    private readonly store: SettingsStore,
    private readonly bus: EventBus,
    options: SettingsServiceOptions = {},
  ) {
    this.telegramSetup = options.telegramSetup ?? DEFAULT_TELEGRAM_SETUP_CLIENT
    this.generateTelegramSetupCode = options.generateTelegramSetupCode ?? defaultTelegramSetupCode
    this.now = options.now ?? Date.now
    this.modelCatalog = new ModelCatalog(options.modelProbe, {
      now: this.now,
      // Persist the catalog so the first picker-open after a restart/redeploy serves
      // the last-known list instantly (then refreshes), instead of a cold ~2s probe.
      load: () => this.store.getModelCatalog(),
      save: (snapshot) => this.store.setModelCatalog(snapshot),
    })
  }

  getSettings(): PodiumSettings {
    return this.store.getSettings()
  }

  setSettings(settings: PodiumSettings): PodiumSettings {
    const previous = this.store.getSettings()
    this.store.setSettings(settings)
    // Synchronous bus fan-out: NotifyService replays blocked states to newly
    // configured external targets; the registry re-arms auto-continue.
    this.bus.emit('settings.changed', { previous, next: settings })
    return settings
  }

  /** Live per-agent model lists (SWR — returns cached instantly, refreshes in the
   *  background). The web merges these over its static catalog. */
  getModelCatalog(): ModelCatalogSnapshot {
    return this.modelCatalog.get()
  }

  /** Force a fresh probe and return the updated snapshot (explicit "refresh now"). */
  async refreshModelCatalog(): Promise<ModelCatalogSnapshot> {
    await this.modelCatalog.refresh()
    return this.modelCatalog.get()
  }

  async startTelegramSetup(): Promise<TelegramSetupStartResult> {
    const botToken = this.store.getSettings().notifications.telegramBotToken.trim()
    if (!botToken) throw new Error('Telegram bot token is required before setup')

    const { username } = await this.telegramSetup.getMe(botToken)
    const code = this.generateTelegramSetupCode()
    const setupId = randomUUID()
    const expiresAtMs = this.now() + TELEGRAM_SETUP_TTL_MS
    this.telegramSetups.set(setupId, { code, botUsername: username, expiresAtMs })
    return {
      setupId,
      code,
      botUsername: username,
      telegramUrl: telegramSetupUrl(username, code),
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  async pollTelegramSetup(setupId: string): Promise<TelegramSetupPollResult> {
    const setup = this.telegramSetups.get(setupId)
    if (!setup) return { status: 'expired' }
    if (this.now() > setup.expiresAtMs) {
      this.telegramSetups.delete(setupId)
      return { status: 'expired' }
    }

    const current = this.store.getSettings()
    const botToken = current.notifications.telegramBotToken.trim()
    if (!botToken) throw new Error('Telegram bot token is required before setup')

    const updates = await this.telegramSetup.getUpdates(botToken)
    const match = updates.find((update) => telegramTextHasCode(update.text, setup.code))
    if (!match) return { status: 'pending', expiresAt: new Date(setup.expiresAtMs).toISOString() }

    const chatId = String(match.chatId)
    const next = this.setSettings({
      ...current,
      notifications: {
        ...current.notifications,
        telegramChatId: chatId,
      },
    })
    this.telegramSetups.delete(setupId)
    await this.telegramSetup.sendMessage(
      { botToken, chatId },
      'Telegram notifications are connected to Podium.',
    )
    await this.telegramSetup.acknowledgeUpdates?.(botToken, match.updateId + 1)
    return {
      status: 'connected',
      chatId,
      chatType: match.chatType,
      ...(match.chatLabel ? { chatLabel: match.chatLabel } : {}),
      settings: next,
    }
  }
}
