import type { PodiumSettings } from '@podium/runtime'
import type { EventBus } from '../bus'
import { TelegramChannel } from './telegram'
import type { ChannelAdapter, ConversationRef, InboundChatMessage } from './types'

/** How a superagent turn is dispatched — the slice of SuperagentService the
 *  bridge needs (kept narrow for tests). */
export interface SuperagentTurnPort {
  sendTurn(input: {
    threadId: string
    text: string
  }): Promise<{ threadId: string; podiumSessionId: string }>
}

export interface MessagingDeps {
  bus: EventBus
  getSettings(): PodiumSettings
  superagent: SuperagentTurnPort
  /** True while the settings telegram-setup pairing window owns getUpdates. */
  telegramSetupPending?: () => boolean
  /** Adapter factory — injected in tests. */
  createTelegram?: (config: { botToken: string; chatId: string }) => ChannelAdapter
}

interface QueuedInbound {
  threadId: string
  source: ConversationRef
  text: string
  senderLabel?: string
}

interface AwaitedReply {
  source: ConversationRef
  typing: ReturnType<typeof setInterval>
}

const QUEUE_CAP = 20

/**
 * Two-way messaging-app bridge [spec:SP-5d81]. Inbound chat messages become
 * superagent turns; the reply text rides the `superagent.turnEnded` bus event
 * back to the chat. Notifications keep their existing pushTelegram path into
 * the same chat — this service only owns the conversational lane.
 *
 * Thread mapping V1: every conversation maps to the GLOBAL superagent thread
 * (`resolveThreadId`) — the seam where messaging-app threads/topics/channels
 * later map to their own superagent threads.
 */
export class MessagingService {
  private adapter: ChannelAdapter | undefined
  private adapterKey = ''
  /** FIFO of inbound messages not yet dispatched, per superagent thread. */
  private readonly queues = new Map<string, QueuedInbound[]>()
  /** Turns this bridge dispatched and is awaiting, per superagent thread. */
  private readonly awaiting = new Map<string, AwaitedReply>()
  /** Threads with a sendTurn dispatch in flight (pre-ack) — a second pump
   *  while the first promise is pending must not re-send queue[0]. */
  private readonly dispatching = new Set<string>()

  constructor(private readonly deps: MessagingDeps) {
    deps.bus.on('superagent.turnEnded', (ev) => this.onTurnEnded(ev))
    deps.bus.on('settings.changed', () => this.configure())
  }

  /** (Re)build the adapter from current settings. Safe to call repeatedly. */
  configure(): void {
    const n = this.deps.getSettings().notifications
    const botToken = n.telegramBotToken.trim()
    const chatId = n.telegramChatId.trim()
    const key = botToken && chatId ? `${botToken}\n${chatId}` : ''
    if (key === this.adapterKey) return
    this.adapter?.stop()
    this.adapter = undefined
    this.adapterKey = key
    if (!key) return
    const create =
      this.deps.createTelegram ??
      ((config: { botToken: string; chatId: string }) =>
        new TelegramChannel(config, this.deps.telegramSetupPending ?? (() => false)))
    this.adapter = create({ botToken, chatId })
    this.adapter.start((msg) => this.onInbound(msg))
    console.log('[podium:messaging] telegram bridge polling as configured chat', chatId)
  }

  stop(): void {
    this.adapter?.stop()
    this.adapter = undefined
    this.adapterKey = ''
  }

  /** V1: everything converses with the global orchestrator thread. */
  private resolveThreadId(_msg: InboundChatMessage): string {
    return 'global'
  }

  private onInbound(msg: InboundChatMessage): void {
    const threadId = this.resolveThreadId(msg)
    const queue = this.queues.get(threadId) ?? []
    if (queue.length >= QUEUE_CAP) {
      void this.reply(msg.source, '⚠️ Message queue is full — wait for the current replies.')
      return
    }
    queue.push({
      threadId,
      source: msg.source,
      text: msg.text,
      ...(msg.senderLabel ? { senderLabel: msg.senderLabel } : {}),
    })
    this.queues.set(threadId, queue)
    this.pump(threadId)
  }

  private pump(threadId: string): void {
    if (this.awaiting.has(threadId) || this.dispatching.has(threadId)) return
    const queue = this.queues.get(threadId)
    const next = queue?.[0]
    if (!next) return
    this.dispatching.add(threadId)
    void this.deps.superagent
      .sendTurn({ threadId, text: this.turnText(next) })
      .then(() => {
        this.dispatching.delete(threadId)
        queue?.shift()
        const typing = setInterval(() => this.adapter?.sendTyping?.(next.source), 5000)
        ;(typing as { unref?: () => void }).unref?.()
        this.adapter?.sendTyping?.(next.source)
        this.awaiting.set(threadId, { source: next.source, typing })
      })
      .catch((err: unknown) => {
        this.dispatching.delete(threadId)
        const message = err instanceof Error ? err.message : String(err)
        // A turn someone else started is running — keep the message queued;
        // that turn's turnEnded re-pumps. Anything else is terminal for this
        // message: surface it and drop, or the queue wedges forever.
        if (message.includes('already running')) return
        queue?.shift()
        void this.reply(next.source, `⚠️ Could not reach the superagent: ${message}`)
        this.pump(threadId)
      })
  }

  private turnText(msg: QueuedInbound): string {
    const sender = msg.senderLabel ? ` from ${msg.senderLabel}` : ''
    return `(Telegram message${sender} — you are replying into a phone chat: be concise, plain text, no markdown tables)\n\n${msg.text}`
  }

  private onTurnEnded(ev: { threadId: string; ok: boolean; output?: string; error?: string }): void {
    const awaited = this.awaiting.get(ev.threadId)
    if (awaited) {
      clearInterval(awaited.typing)
      this.awaiting.delete(ev.threadId)
      const text = ev.ok
        ? (ev.output?.trim() || '(the superagent finished without a text reply)')
        : `⚠️ Turn failed: ${ev.error ?? 'unknown error'}`
      void this.reply(awaited.source, text)
    }
    // Whether ours or a web-dispatched turn: the thread is free — send the next.
    this.pump(ev.threadId)
  }

  private async reply(target: ConversationRef, text: string): Promise<void> {
    try {
      await this.adapter?.send(target, text)
    } catch (err) {
      console.warn('[podium:messaging] reply send failed:', err instanceof Error ? err.message : err)
    }
  }
}
