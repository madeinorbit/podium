import type { PodiumSettings } from '@podium/core'
import type { AgentRuntimeState, ServerMessage } from '@podium/protocol'
import {
  type AttentionNotice,
  attentionNotice,
  pushNtfy,
  pushTelegram,
  type TelegramConfig,
} from '../../notify'
import type { EventBus } from '../bus'

export interface NotificationPushers {
  ntfy(topic: string, notice: AttentionNotice): void
  telegram(config: TelegramConfig, notice: AttentionNotice): void
}

export const DEFAULT_NOTIFICATION_PUSHERS: NotificationPushers = {
  ntfy: pushNtfy,
  telegram: pushTelegram,
}

type NotificationSettings = PodiumSettings['notifications']

function telegramConfig(settings: NotificationSettings): TelegramConfig {
  return {
    botToken: settings.telegramBotToken,
    chatId: settings.telegramChatId,
  }
}

function isTelegramEnabled(settings: NotificationSettings): boolean {
  const telegram = telegramConfig(settings)
  return telegram.botToken.trim() !== '' && telegram.chatId.trim() !== ''
}

function normalizedTelegramKey(settings: NotificationSettings): string {
  const telegram = telegramConfig(settings)
  return `${telegram.botToken.trim()}\n${telegram.chatId.trim()}`
}

/** The session fields an attention notice needs — a plain projection so the
 *  service never holds live Session objects. */
export interface SessionNoticeInfo {
  sessionId: string
  name?: string
  title?: string
  cwd: string
  agentKind: string
}

export interface NotifyDeps {
  getSettings(): PodiumSettings
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
  sessionInfo(sessionId: string): SessionNoticeInfo | undefined
  /** Runtime state per session — notifyAttentionForNewExternalTargets replays the
   *  current blocked states to a freshly configured external target. */
  sessionStates(): Iterable<{ info: SessionNoticeInfo; state: AgentRuntimeState | undefined }>
}

/**
 * Attention notifications (ntfy / telegram / in-app attentionEvent) — peeled off
 * SessionRegistry (issue #13 Phase 2). Subscribes to the typed bus:
 * - 'session.stateChanged' → notifyAttention (durable phase-event + smart-routed push)
 * - 'settings.changed'     → replay current blocked states to newly configured targets
 */
export class NotifyService {
  constructor(
    private readonly deps: NotifyDeps,
    private readonly pushers: NotificationPushers = DEFAULT_NOTIFICATION_PUSHERS,
    bus: EventBus,
  ) {
    bus.on('session.stateChanged', ({ sessionId, prev, next }) => {
      const info = this.deps.sessionInfo(sessionId)
      if (info) this.notifyAttention(info, prev, next)
    })
    bus.on('settings.changed', ({ previous, next }) => {
      this.notifyAttentionForNewExternalTargets(previous.notifications, next.notifications)
    })
  }

  private attentionNoticeName(info: SessionNoticeInfo): string {
    return info.name || info.title || info.cwd.split('/').pop() || 'agent'
  }

  private notifyAttentionForNewExternalTargets(
    previous: NotificationSettings,
    next: NotificationSettings,
  ): void {
    const previousNtfy = previous.ntfyTopic.trim()
    const nextNtfy = next.ntfyTopic.trim()
    const sendNtfy = nextNtfy !== '' && previousNtfy !== nextNtfy
    const sendTelegram =
      isTelegramEnabled(next) &&
      (!isTelegramEnabled(previous) ||
        normalizedTelegramKey(previous) !== normalizedTelegramKey(next))
    if (!sendNtfy && !sendTelegram) return

    const telegram = telegramConfig(next)
    for (const { info, state } of this.deps.sessionStates()) {
      if (!state) continue
      const notice = attentionNotice(this.attentionNoticeName(info), undefined, state)
      if (!notice) continue
      if (sendNtfy) this.pushers.ntfy(nextNtfy, notice)
      if (sendTelegram) this.pushers.telegram(telegram, notice)
    }
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
            agentKind: info.agentKind,
            cwd: info.cwd,
          },
        })
      } catch {}
    }
    const settings = this.deps.getSettings().notifications
    const name = this.attentionNoticeName(info)
    const notice = attentionNotice(name, prev, next)
    if (!notice) return
    if (settings.web) {
      const event: ServerMessage = {
        type: 'attentionEvent',
        sessionId: info.sessionId,
        title: notice.title,
        body: notice.body,
      }
      for (const c of this.deps.clients()) c.send(event)
    }
    const telegram = telegramConfig(settings)
    const telegramEnabled = isTelegramEnabled(settings)
    if (settings.ntfyTopic || telegramEnabled) {
      const someoneWatching = [...this.deps.clients()].some((c) => c.visible)
      if (!someoneWatching) {
        if (settings.ntfyTopic) this.pushers.ntfy(settings.ntfyTopic, notice)
        if (telegramEnabled) this.pushers.telegram(telegram, notice)
      }
    }
  }
}
