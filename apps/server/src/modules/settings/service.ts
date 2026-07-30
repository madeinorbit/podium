import { randomUUID } from 'node:crypto'
import { applySettingsPatch, readSettingsLeaf } from '@podium/commands'
import {
  redeemTelegramClaimCode,
  telegramClaimCodeIsLive,
  SERVER_SECRET_KEYS,
  type SecretPresenceWire,
  type ServerSecretKey,
  type TelegramChatBinding,
  type TelegramClaimCode,
  type UserId,
} from '@podium/model'
import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import { ModelCatalog, type ModelCatalogSnapshot, type ModelProbe } from '../../model-catalog'
import type { TelegramConfig } from '../../notify'
import type { SessionStore } from '../../store'
import type { EventBus } from '../bus'
import { readOrCreateFingerprintKey, secretPresence } from './secret-fingerprint'

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

/**
 * A pending ceremony: the MINT plus the bot it was minted against.
 *
 * The mint is `TelegramClaimCode`, so the user it confers is a field of the
 * ceremony from the moment the ceremony exists — not something resolved later
 * from whatever the redemption happens to have in scope. That is the whole
 * mechanism (ADR 3 Amendment 1 D22, POD-1080): identity is captured on the
 * authenticated transport at mint time and carried opaquely to redemption.
 */
interface PendingTelegramSetup {
  mint: TelegramClaimCode
  botUsername: string
}

/** The write half of the binding table, as the narrowest port the ceremony
 *  needs. A port rather than the repository so this module does not depend on
 *  the store, and so a test can observe the binding directly. */
export interface TelegramBindingWriter {
  upsert(binding: TelegramChatBinding): void
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
  /**
   * WHERE A REDEEMED BINDING IS WRITTEN, and it is REQUIRED — not optional with
   * a no-op default.
   *
   * POD-1075's shape, for its reason: an absent writer would make the ceremony
   * report `connected` while binding nothing, and every inbound message would
   * then be refused by a gate that looks like it is working. A missing
   * dependency must be a compile error, never a silently unbound instance.
   */
  telegramBindings: TelegramBindingWriter
  /**
   * THE USER A CLAIM CODE IS MINTED FOR — the transport principal, and REQUIRED
   * for the reason `createClientSession` takes its user as a required parameter
   * (POD-1075): a service-level default is the one place per-user binding could
   * silently keep stamping one id for everybody while every ceremony still
   * works.
   *
   * The composition root passes `deviceGradeSoleOwner`, because this build's
   * transport cannot tell two humans apart; `bun run audit:machine-grants`
   * counts that call site, and it becomes a compile error when POD-315 deletes
   * the placeholder.
   */
  mintingUser: () => UserId
  telegramSetup?: TelegramSetupClient
  generateTelegramSetupCode?: () => string
  now?: () => number
  /** Live model-list probe (grok/cursor/opencode `models`). Injected in tests so the
   *  catalog never shells out; defaults to the real CLI probe. */
  modelProbe?: ModelProbe
  /** The server-held MAC key the secret fingerprint is derived under. Injected so
   *  a test can pin a fingerprint without touching the real state dir; defaults
   *  to the persistent key beside `daemon.secret`. Read LAZILY (a thunk, not a
   *  Buffer) so constructing a service never creates a key file as a side
   *  effect — only a secret write does. */
  fingerprintKey?: () => Buffer
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
  private readonly telegramBindings: TelegramBindingWriter
  private readonly mintingUser: () => UserId
  private readonly generateTelegramSetupCode: () => string
  private readonly now: () => number
  private readonly fingerprintKey: () => Buffer
  // SWR cache of live per-agent model lists (grok/cursor/opencode). Query-driven:
  // nothing probes until a client asks via getModelCatalog().
  private readonly modelCatalog: ModelCatalog

  constructor(
    private readonly store: SettingsStore,
    private readonly bus: EventBus,
    options: SettingsServiceOptions,
  ) {
    this.telegramBindings = options.telegramBindings
    this.mintingUser = options.mintingUser
    this.telegramSetup = options.telegramSetup ?? DEFAULT_TELEGRAM_SETUP_CLIENT
    this.generateTelegramSetupCode = options.generateTelegramSetupCode ?? defaultTelegramSetupCode
    this.now = options.now ?? Date.now
    this.fingerprintKey = options.fingerprintKey ?? (() => readOrCreateFingerprintKey())
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

  /**
   * THE BLOB WRITE MAY NOT CARRY A SECRET (POD-420, ADR 1 D6 / POD-352).
   *
   * `settings.set` is the legacy one-blob command, and the whole defect this
   * issue exists to fix is that it answers for three matrix rows at once. Its
   * secret third is now written by `settings.setSecret` / `settings.clearSecret`
   * — online-sensitive, admin-grade, never queued — so a secret change arriving
   * through the blob is refused rather than quietly honoured.
   *
   * The refusal is derived from `SERVER_SECRET_KEYS` (POD-418's closed
   * vocabulary), so a secret ADDED to the model becomes unwritable-by-blob on
   * the same commit. It is NOT a detector over key names or value shapes: a
   * detector that misses one key fails open, and this one enumerates the
   * classification instead.
   *
   * It compares VALUES rather than rejecting any payload that mentions a secret,
   * because the shipped clients send the whole blob back including the secrets
   * they were served — an unchanged secret must round-trip, or every preference
   * save through the legacy command would fail. Only a CHANGE is refused, which
   * is precisely the write that must go through the secret commands.
   */
  private assertNoSecretChange(previous: PodiumSettings, next: PodiumSettings): void {
    const leaf = (blob: PodiumSettings, key: ServerSecretKey): string =>
      String(readSettingsLeaf(blob, key) ?? '')
    const changed = SERVER_SECRET_KEYS.filter((key) => leaf(previous, key) !== leaf(next, key))
    if (changed.length === 0) return
    // Names the KEYS and never a value: the key vocabulary is public (the
    // presence projection publishes all five), the material is not.
    throw new Error(
      `settings.set may not write server-owned secrets (${changed.join(', ')}) — ` +
        'use settings.setSecret / settings.clearSecret, which are online-only and never queued (ADR 1 D6)',
    )
  }

  setSettings(settings: PodiumSettings): PodiumSettings {
    const previous = this.store.getSettings()
    this.assertNoSecretChange(previous, settings)
    this.store.setSettings(settings)
    // Synchronous bus fan-out: NotifyService replays blocked states to newly
    // configured external targets; the registry re-arms auto-continue.
    this.bus.emit('settings.changed', { previous, next: settings })
    return settings
  }

  // -------------------------------------------------------------------------
  // The contracted write surface (POD-420)
  // -------------------------------------------------------------------------

  /**
   * `settings.updatePersonal` / `settings.updateInstance` — a path-addressed
   * preference patch.
   *
   * ONE METHOD FOR BOTH TIERS, and the tier gate is deliberately NOT here: it is
   * each command's INPUT SCHEMA, which admits only paths its own tier
   * classifies. Re-deciding it in the handler would be a second answer to the
   * authorization question, and the two would drift — while a handler-side check
   * could not refuse anything the schema had already let through anyway.
   *
   * `normalizeSettings` is what validates the VALUES. The patch is
   * `Record<string, unknown>` by design (the contract decides addresses, the
   * model decides value types), so this parse is where `hibernation.memoryPct =
   * "abc"` is refused — by the model's own schema, not by a restatement of it.
   */
  updatePreferences(values: Readonly<Record<string, unknown>>): PodiumSettings {
    const current = this.store.getSettings()
    return this.setSettings(normalizeSettings(applySettingsPatch(current, values)))
  }

  /**
   * `settings.setSecret` — replace one server-owned secret.
   *
   * It writes the store DIRECTLY rather than through {@link setSettings},
   * because that method now refuses a secret change: this is the one path
   * authorized to make one, and routing it through the refusal would mean either
   * a bypass flag or a guard with an exception — both of which are how the guard
   * eventually forgives the wrong caller.
   *
   * It still emits `settings.changed`, because every subscriber that reacts to a
   * changed token (the notify service's replay, the messaging bridge) must react
   * whichever command wrote it.
   *
   * The material lands in the LEGACY blob path (`apiKeys.openai`, …) because
   * that is where secrets still live; POD-419 owns moving them into the keyed
   * store. The RETURN carries no material: `secretPresence` names presence, an
   * opaque fingerprint and a rotation time, and has no value key by construction.
   */
  setSecret(key: ServerSecretKey, value: string): SecretPresenceWire {
    const previous = this.store.getSettings()
    const next = normalizeSettings(applySettingsPatch(previous, { [key]: value }))
    this.store.setSettings(next)
    this.bus.emit('settings.changed', { previous, next })
    // RECORDED GAP: the blob has nowhere to persist a per-secret rotation time,
    // so this is the time of THIS write and a later read projection cannot
    // recover it. POD-419's keyed store is where `updatedAt` becomes durable;
    // returning the write time is truthful about what just happened and is the
    // only honest non-null answer available here.
    return secretPresence(key, value, this.fingerprintKey(), new Date(this.now()).toISOString())
  }

  /**
   * `settings.clearSecret` — remove one server-owned secret.
   *
   * `''` is today's blob spelling of "not configured" (the ambiguity POD-418
   * removed at the model and POD-419 removes at rest), so clearing writes it and
   * the presence projection reports `present: false` with both nullables null.
   */
  clearSecret(key: ServerSecretKey): SecretPresenceWire {
    const previous = this.store.getSettings()
    const next = normalizeSettings(applySettingsPatch(previous, { [key]: '' }))
    this.store.setSettings(next)
    this.bus.emit('settings.changed', { previous, next })
    return secretPresence(key, '', this.fingerprintKey())
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

  /** True while a pairing window is open — the messaging bridge pauses its
   *  getUpdates long-poll so the setup flow's polls don't 409 [spec:SP-5d81]. */
  hasPendingTelegramSetup(): boolean {
    const now = this.nowIso()
    for (const setup of this.telegramSetups.values()) {
      if (telegramClaimCodeIsLive(setup.mint, now)) return true
    }
    return false
  }

  /** The clock as the model's predicates take it. One conversion, here, so no
   *  call site re-derives "is this mint still live" from raw milliseconds. */
  private nowIso(): string {
    return new Date(this.now()).toISOString()
  }

  /**
   * MINT A CLAIM CODE FOR THE CALLING PRINCIPAL — half one of the ceremony
   * (ADR 3 Amendment 1 D22.1, `settings.telegramSetupStart`).
   *
   * The user is stamped HERE, from {@link SettingsServiceOptions.mintingUser},
   * and never at redemption. That ordering is the mechanism: at this moment the
   * caller is on an authenticated transport, and at redemption the only thing
   * present is a chat id the sender controls.
   */
  async startTelegramSetup(): Promise<TelegramSetupStartResult> {
    const botToken = this.store.getSettings().notifications.telegramBotToken.trim()
    if (!botToken) throw new Error('Telegram bot token is required before setup')

    const { username } = await this.telegramSetup.getMe(botToken)
    const code = this.generateTelegramSetupCode()
    const setupId = randomUUID()
    const createdAt = this.nowIso()
    const expiresAt = new Date(this.now() + TELEGRAM_SETUP_TTL_MS).toISOString()
    const mint: TelegramClaimCode = {
      code,
      userId: this.mintingUser(),
      createdAt,
      expiresAt,
    }
    this.telegramSetups.set(setupId, { mint, botUsername: username })
    return {
      setupId,
      code,
      botUsername: username,
      telegramUrl: telegramSetupUrl(username, code),
      expiresAt,
    }
  }

  /**
   * REDEEM A PRESENTED CODE AND BIND THE CHAT — half two (D22.1,
   * `settings.telegramSetupPoll`).
   *
   * The binding's user comes from `setup.mint`, through
   * `redeemTelegramClaimCode`, which HAS NO USER PARAMETER. Nothing in this
   * method can supply one: not the matched update, not the caller, not an
   * ambient default. That is what makes "who does this chat speak as" a property
   * of the mechanism rather than of a string somebody sent.
   *
   * An unknown or expired `setupId` returns the SAME `expired` result, per the
   * contract's error-consistency cell: distinguishing them would tell a caller
   * whether someone else's ceremony is open.
   */
  async pollTelegramSetup(setupId: string): Promise<TelegramSetupPollResult> {
    const setup = this.telegramSetups.get(setupId)
    if (!setup) return { status: 'expired' }
    const now = this.nowIso()
    if (!telegramClaimCodeIsLive(setup.mint, now)) {
      this.telegramSetups.delete(setupId)
      return { status: 'expired' }
    }

    const current = this.store.getSettings()
    const botToken = current.notifications.telegramBotToken.trim()
    if (!botToken) throw new Error('Telegram bot token is required before setup')

    const updates = await this.telegramSetup.getUpdates(botToken)
    const match = updates.find((update) => telegramTextHasCode(update.text, setup.mint.code))
    if (!match) return { status: 'pending', expiresAt: setup.mint.expiresAt }

    const chatId = String(match.chatId)
    const binding = redeemTelegramClaimCode(setup.mint, chatId, now)
    if (!binding) {
      // The mint was live a few lines ago, so this is the chat id failing the
      // model's own shape check. Consume the mint and refuse: a ceremony that
      // matched a code but could not produce a binding must not leave a live
      // code behind, and must not report success.
      this.telegramSetups.delete(setupId)
      return { status: 'expired' }
    }
    this.telegramBindings.upsert(binding)

    // The INBOUND half is now the binding above. This write is the OUTBOUND
    // routing address, which is a different fact on a different row
    // (`preferences-personal`, `secret: 'preference'`) and is unchanged by this
    // issue: it is still an instance-wide singleton, and making notification
    // routing per-user is ADR 9 D8 S3's work, not this ceremony's.
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
