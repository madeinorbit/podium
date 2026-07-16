import type { TelegramConfig } from '../../notify'
import type { ChannelAdapter, ConversationRef, InboundChatMessage } from './types'

/** Telegram caps sendMessage at 4096 UTF-16 code units; split below it so the
 *  " (n/m)" counter never overflows a chunk. JS string.length IS UTF-16 code
 *  units, so plain length math is the correct measure here. */
const SPLIT_THRESHOLD = 4000
const POLL_TIMEOUT_S = 50

export interface TelegramUpdateMessage {
  updateId: number
  chatId: string
  threadRef?: string
  text: string
  senderLabel?: string
}

/** Parse a raw getUpdates result into the inbound messages we bridge: plain
 *  text messages only (media/edits/reactions are follow-up work). Exported for
 *  tests. */
export function parseTelegramUpdates(result: unknown): {
  messages: TelegramUpdateMessage[]
  lastUpdateId?: number
} {
  if (!Array.isArray(result)) return { messages: [] }
  const messages: TelegramUpdateMessage[] = []
  let lastUpdateId: number | undefined
  for (const raw of result) {
    if (!raw || typeof raw !== 'object') continue
    const update = raw as { update_id?: unknown; message?: unknown }
    if (typeof update.update_id !== 'number') continue
    lastUpdateId = update.update_id
    const msg = update.message as
      | {
          text?: unknown
          message_thread_id?: unknown
          chat?: { id?: unknown }
          from?: { first_name?: unknown; username?: unknown; is_bot?: unknown }
        }
      | undefined
    if (!msg || typeof msg.text !== 'string' || msg.text === '') continue
    const chatId = msg.chat?.id
    if (typeof chatId !== 'number' && typeof chatId !== 'string') continue
    if (msg.from?.is_bot === true) continue
    const senderLabel =
      typeof msg.from?.username === 'string'
        ? `@${msg.from.username}`
        : typeof msg.from?.first_name === 'string'
          ? msg.from.first_name
          : undefined
    messages.push({
      updateId: update.update_id,
      chatId: String(chatId),
      ...(typeof msg.message_thread_id === 'number'
        ? { threadRef: String(msg.message_thread_id) }
        : {}),
      text: msg.text,
      ...(senderLabel ? { senderLabel } : {}),
    })
  }
  return { messages, ...(lastUpdateId !== undefined ? { lastUpdateId } : {}) }
}

/** Split at the platform cap, preferring newline then space boundaries so a
 *  chunk never bisects a word (or a surrogate pair). Exported for tests. */
export function chunkTelegramText(text: string, limit = SPLIT_THRESHOLD): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^[\n ]/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

type TelegramApiBody = { ok?: boolean; description?: string; result?: unknown; parameters?: unknown }

/**
 * Telegram transport [spec:SP-5d81]: long-polls getUpdates on the notification
 * bot and accepts messages ONLY from the configured private chat — the chat id
 * is the authorization boundary. Outbound sends are plain text (rich
 * formatting is follow-up work), chunked to the platform cap, with one inline
 * retry on flood control.
 */
export class TelegramChannel implements ChannelAdapter {
  readonly channel = 'telegram'
  private stopped = true
  private offset: number | undefined
  private loop: Promise<void> | undefined
  private abort: AbortController | undefined

  constructor(
    private readonly config: TelegramConfig,
    /** While true the poll loop idles — the settings telegram-setup flow owns
     *  getUpdates for its pairing window (concurrent polls 409). */
    private readonly paused: () => boolean = () => false,
  ) {}

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.config.botToken.trim()}/${method}`
  }

  private async call(method: string, body?: unknown, signal?: AbortSignal): Promise<TelegramApiBody> {
    const res = await fetch(this.api(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      ...(signal ? { signal } : {}),
    })
    const parsed = (await res.json().catch(() => ({}))) as TelegramApiBody
    if (res.ok && parsed.ok === true) return parsed
    const description =
      typeof parsed.description === 'string' ? parsed.description : `HTTP ${res.status}`
    const err = new Error(description) as Error & { status?: number; retryAfter?: number }
    err.status = res.status
    const params = parsed.parameters as { retry_after?: unknown } | undefined
    if (typeof params?.retry_after === 'number') err.retryAfter = params.retry_after
    throw err
  }

  start(onMessage: (msg: InboundChatMessage) => void): void {
    if (!this.stopped) return
    this.stopped = false
    this.abort = new AbortController()
    this.loop = this.pollLoop(onMessage).catch((err) => {
      console.warn('[podium:messaging] telegram poll loop died:', err)
    })
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
  }

  private async pollLoop(onMessage: (msg: InboundChatMessage) => void): Promise<void> {
    // Skip the backlog on start: replaying getUpdates history would re-answer
    // old messages (including the setup pairing code) after every redeploy.
    try {
      const head = await this.call('getUpdates', { offset: -1, timeout: 0 }, this.abort?.signal)
      const { lastUpdateId } = parseTelegramUpdates(head.result)
      if (lastUpdateId !== undefined) this.offset = lastUpdateId + 1
    } catch (err) {
      if (this.stopped) return
      console.warn('[podium:messaging] telegram initial offset fetch failed:', err)
    }
    const wantChatId = this.config.chatId.trim()
    while (!this.stopped) {
      if (this.paused()) {
        await sleep(3000)
        continue
      }
      try {
        const body = await this.call(
          'getUpdates',
          {
            timeout: POLL_TIMEOUT_S,
            allowed_updates: ['message'],
            ...(this.offset !== undefined ? { offset: this.offset } : {}),
          },
          this.abort?.signal,
        )
        const { messages, lastUpdateId } = parseTelegramUpdates(body.result)
        if (lastUpdateId !== undefined) this.offset = lastUpdateId + 1
        for (const msg of messages) {
          if (msg.chatId !== wantChatId) continue
          onMessage({
            source: {
              channel: this.channel,
              chatId: msg.chatId,
              ...(msg.threadRef ? { threadRef: msg.threadRef } : {}),
            },
            text: msg.text,
            ...(msg.senderLabel ? { senderLabel: msg.senderLabel } : {}),
          })
        }
      } catch (err) {
        if (this.stopped) return
        const status = (err as { status?: number }).status
        // 409 = another getUpdates consumer (the settings setup flow) — back
        // off long enough for its short polls to win the race.
        await sleep(status === 409 ? 15_000 : 5000)
      }
    }
  }

  async send(target: ConversationRef, text: string): Promise<void> {
    const chunks = chunkTelegramText(text)
    for (let i = 0; i < chunks.length; i++) {
      const suffix = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''
      await this.sendChunk(target, chunks[i] + suffix)
    }
  }

  private async sendChunk(target: ConversationRef, text: string, retried = false): Promise<void> {
    try {
      await this.call('sendMessage', {
        chat_id: target.chatId,
        ...(target.threadRef ? { message_thread_id: Number(target.threadRef) } : {}),
        text,
      })
    } catch (err) {
      const retryAfter = (err as { retryAfter?: number }).retryAfter
      if (!retried && typeof retryAfter === 'number' && retryAfter <= 30) {
        await sleep(retryAfter * 1000)
        return this.sendChunk(target, text, true)
      }
      throw err
    }
  }

  sendTyping(target: ConversationRef): void {
    this.call('sendChatAction', {
      chat_id: target.chatId,
      ...(target.threadRef ? { message_thread_id: Number(target.threadRef) } : {}),
      action: 'typing',
    }).catch(() => {})
  }

  async registerCommands(): Promise<void> {
    await this.call('setMyCommands', {
      commands: [
        { command: 'help', description: 'List available commands' },
        { command: 'issues', description: 'Active or recent issues' },
        { command: 'stop', description: 'Interrupt the running turn' },
        { command: 'new', description: 'Reset the superagent thread' },
      ],
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.()
  })
}
