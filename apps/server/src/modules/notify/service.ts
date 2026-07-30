import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { AgentObservation, LiveServerMessage, ServerMessage } from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import {
  type AttentionNotice,
  attentionNotice,
  pushNtfy,
  pushTelegram,
  type TelegramConfig,
} from '../../notify'
import type { EventBus } from '../bus'
import type { TelegramNoticePort } from '../messaging/types'

export interface NotificationPushers {
  ntfy(topic: string, notice: AttentionNotice): void
  telegram(config: TelegramConfig, notice: AttentionNotice): void
}

export const DEFAULT_NOTIFICATION_PUSHERS: NotificationPushers = {
  ntfy: pushNtfy,
  telegram: pushTelegram,
}

type NotificationSettings = PodiumSettings['notifications']

/**
 * THE TOKEN NO LONGER COMES FROM THE SETTINGS BLOB (POD-419).
 *
 * `notifications` was one object spanning two matrix rows: `telegramBotToken`
 * (server-owned secret) beside `telegramChatId` (per-user routing). The token
 * moved to the server-only keyed store, so every config here is assembled from
 * TWO sources — the routing half out of the blob, the material out of
 * `NotifyDeps.telegramBotToken()`, read at the moment of use so a rotation takes
 * effect on the next notice rather than on the next restart.
 */
function telegramConfig(settings: NotificationSettings, botToken: string): TelegramConfig {
  return { botToken, chatId: settings.telegramChatId }
}

function isTelegramEnabled(settings: NotificationSettings, botToken: string): boolean {
  return botToken.trim() !== '' && settings.telegramChatId.trim() !== ''
}

function normalizedTelegramKey(settings: NotificationSettings, botToken: string): string {
  return `${botToken.trim()}\n${settings.telegramChatId.trim()}`
}

/** Is a key from {@link normalizedTelegramKey} a CONFIGURED target? Both halves
 *  must be present — the same test {@link isTelegramEnabled} makes, asked of a
 *  remembered key rather than of a live pair. */
function telegramKeyEnabled(key: string): boolean {
  return key.split('\n').every((half) => half.trim() !== '')
}

/** The session fields an attention notice needs — a plain projection so the
 *  service never holds live Session objects. */
export interface SessionNoticeInfo {
  sessionId: SessionId
  name?: string
  title?: string
  cwd: string
  agentKind: string
}

export interface NotifyDeps {
  getSettings(): PodiumSettings
  /**
   * The Telegram bot token out of the server-only secret store (POD-419) —
   * `''` when none is configured.
   *
   * REQUIRED rather than optional-defaulting-to-empty: an omitted dependency
   * would silently disable every Telegram notification on an instance that has
   * a token configured, and "the push stopped arriving" is the failure nobody
   * reports as a bug. A composition root must name where the material comes
   * from.
   */
  telegramBotToken(): string
  /** Experimental delivery boundary [spec:SP-f4b9]. Omitted by isolated tests. */
  notificationsEnabled?(): boolean
  /** store.appendEvent — the durable podium_events log. */
  appendEvent(e: {
    ts: string
    kind: string
    subject: string
    repoPath?: string | null
    payload?: unknown
  }): void
  now(): number
  clients(): Iterable<{ send(msg: ServerMessage): void; visible: boolean }>
  /** Resolve the notice projection for a session (undefined = unknown session). */
  sessionInfo(sessionId: SessionId): SessionNoticeInfo | undefined
  /** Runtime state per session — notifyAttentionForNewExternalTargets replays the
   *  current blocked states to a freshly configured external target. */
  sessionStates(): Iterable<{ info: SessionNoticeInfo; state: AgentRuntimeState | undefined }>
  /** Lazy — production wires MessagingService after registry construction. */
  telegramNotice?: () => TelegramNoticePort | undefined
}

/**
 * Attention notifications (ntfy / telegram / in-app attentionEvent) — peeled off
 * SessionRegistry (issue #13 Phase 2). Subscribes to the typed bus:
 * - 'session.stateChanged' → notifyAttention (durable phase-event + smart-routed push)
 * - 'settings.changed'     → replay current blocked states to newly configured targets
 */
export class NotifyService {
  /** The effective Telegram key (token + chat id) as of the last
   *  `settings.changed`. `undefined` until the first one — see the comparison
   *  in `notifyAttentionForNewExternalTargets` for why that case falls back to
   *  the blob-only reading rather than guessing. */
  private lastTelegramKey: string | undefined

  constructor(
    private readonly deps: NotifyDeps,
    private readonly pushers: NotificationPushers = DEFAULT_NOTIFICATION_PUSHERS,
    bus: EventBus,
  ) {
    bus.on('session.stateChanged', ({ sessionId, prev, next, observation }) => {
      const info = this.deps.sessionInfo(sessionId)
      if (info) this.notifyAttention(info, prev, next, observation)
    })
    bus.on('settings.changed', ({ previous, next }) => {
      this.notifyAttentionForNewExternalTargets(previous.notifications, next.notifications)
    })
  }

  private attentionNoticeName(info: SessionNoticeInfo): string {
    return info.name || info.title || info.cwd.split('/').pop() || 'agent'
  }

  private sendTelegram(config: TelegramConfig, notice: AttentionNotice, sessionId?: string): void {
    const text = `${notice.title}\n\n${notice.body}`
    const port = this.deps.telegramNotice?.()
    if (port) {
      port.sendNotice(text, config, sessionId ? { sessionId } : undefined)
      return
    }
    this.pushers.telegram(config, notice)
  }

  private notifyAttentionForNewExternalTargets(
    previous: NotificationSettings,
    next: NotificationSettings,
  ): void {
    const previousNtfy = previous.ntfyTopic.trim()
    if (this.deps.notificationsEnabled?.() === false) return
    const nextNtfy = next.ntfyTopic.trim()
    const sendNtfy = nextNtfy !== '' && previousNtfy !== nextNtfy
    // Both sides are evaluated against the LIVE token, plus the memo below, so
    // the two transitions that mean "a target became reachable" both fire: a
    // chat id newly filled in (the blob changed) and a token newly set or
    // rotated (the keyed store changed, and the blob did not). Before the split
    // the token was in the blob and one comparison caught both; keeping only the
    // blob comparison would silently stop replaying blocked states on the write
    // that most needs it — the first time a bot token is configured.
    const botToken = this.deps.telegramBotToken()
    const nextKey = normalizedTelegramKey(next, botToken)
    const previousKey = this.lastTelegramKey ?? normalizedTelegramKey(previous, botToken)
    const previouslyEnabled = telegramKeyEnabled(previousKey)
    const sendTelegram =
      isTelegramEnabled(next, botToken) && (!previouslyEnabled || previousKey !== nextKey)
    this.lastTelegramKey = nextKey
    if (!sendNtfy && !sendTelegram) return

    const telegram = telegramConfig(next, botToken)
    for (const { info, state } of this.deps.sessionStates()) {
      if (!state) continue
      const notice = attentionNotice(this.attentionNoticeName(info), undefined, state)
      if (!notice) continue
      if (sendNtfy) this.pushers.ntfy(nextNtfy, notice)
      if (sendTelegram) this.sendTelegram(telegram, notice, info.sessionId)
    }
  }

  /**
   * Push a notice to the configured EXTERNAL targets (ntfy / Telegram) — the
   * delivery behind a subscription's "Notify" switch (#470) [spec:SP-17db], which
   * until now wrote a `steward.notify` event nobody read.
   *
   * Two deliberate differences from notifyAttention:
   *  - No visibility gate. The attention path suppresses the phone push while a
   *    Podium window is visible (a heuristic about where you are looking). A
   *    subscription's Notify is an EXPLICIT standing request for an external
   *    ping — silently dropping it because a browser tab is open would reproduce
   *    the exact bug this fixes.
   *  - No in-app `attentionEvent`. That message is keyed on a session; a
   *    subscription's subscriber may be an issue.
   */
  notifyExternal(notice: AttentionNotice): void {
    const settings = this.deps.getSettings().notifications
    if (this.deps.notificationsEnabled?.() === false) return
    if (settings.ntfyTopic) this.pushers.ntfy(settings.ntfyTopic, notice)
    const botToken = this.deps.telegramBotToken()
    if (isTelegramEnabled(settings, botToken))
      this.sendTelegram(telegramConfig(settings, botToken), notice)
  }

  /**
   * Smart-routed attention notifications. Web clients always get the event
   * (each shows it only while hidden); the mobile push (ntfy) fires only when
   * NO Podium window is visible anywhere — if you're looking at a desktop, the
   * phone stays quiet.
   */
  private notifyAttention(
    info: SessionNoticeInfo,
    prev: AgentRuntimeState | undefined,
    next: AgentRuntimeState,
    observation?: AgentObservation,
  ): void {
    // Durable event log: one row per REAL phase transition (the caller fires on
    // every agentState message, including same-phase refreshes). prev==null is the
    // first seed after a server restart (agentState isn't restored from the DB) —
    // skip it or every redeploy logs a phantom row per live session. Best-effort.
    if (prev != null && prev.phase !== next.phase) {
      try {
        this.deps.appendEvent({
          ts: new Date(this.deps.now()).toISOString(),
          kind: 'session.phase',
          subject: info.sessionId,
          payload: {
            phase: next.phase,
            ...(next.idle?.kind ? { verdict: next.idle.kind } : {}),
            ...(observation
              ? {
                  transitionId: observation.transitionId,
                  provider: observation.provider,
                  providerSessionId: observation.providerSessionId,
                  providerTurnId: observation.providerTurnId,
                  providerPromptId: observation.providerPromptId,
                  observerGeneration: observation.observerGeneration,
                  providerCursor: observation.providerCursor,
                  turnEpoch: observation.turnEpoch,
                  transitionKind: observation.transitionKind,
                  providerAt: observation.providerAt,
                  receivedAt: observation.receivedAt,
                  sourceEventKind: observation.sourceEventKind,
                  provenance: observation.provenance,
                  inputOrigin: observation.inputOrigin,
                  priorPhase: observation.priorPhase,
                  nextPhase: observation.nextPhase,
                }
              : {}),
            agentKind: info.agentKind,
            cwd: info.cwd,
          },
        })
      } catch {}
    }
    const settings = this.deps.getSettings().notifications
    if (this.deps.notificationsEnabled?.() === false) return
    const name = this.attentionNoticeName(info)
    const notice = attentionNotice(name, prev, next)
    if (!notice) return
    if (settings.web) {
      const event: LiveServerMessage = {
        type: 'attentionEvent',
        sessionId: info.sessionId,
        title: notice.title,
        body: notice.body,
      }
      for (const c of this.deps.clients()) c.send(event)
    }
    const botToken = this.deps.telegramBotToken()
    const telegram = telegramConfig(settings, botToken)
    const telegramEnabled = isTelegramEnabled(settings, botToken)
    if (settings.ntfyTopic || telegramEnabled) {
      const someoneWatching = [...this.deps.clients()].some((c) => c.visible)
      if (!someoneWatching) {
        if (settings.ntfyTopic) this.pushers.ntfy(settings.ntfyTopic, notice)
        if (telegramEnabled) this.sendTelegram(telegram, notice, info.sessionId)
      }
    }
  }
}
