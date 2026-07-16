import type { TelegramConfig } from '../../notify'
import {
  escapeChunkCounterSuffix,
  formatTelegramMarkdown,
  isTelegramMarkdownParseError,
  stripTelegramMarkdownV2,
} from './telegram-markdown'
import type {
  ChannelAdapter,
  ConversationRef,
  InboundChatMessage,
  SendOptions,
} from './types'

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
export interface TelegramCallbackUpdate {
  updateId: number
  chatId: string
  threadRef?: string
  callbackQueryId: string
  data: string
  senderLabel?: string
}

export function parseTelegramUpdates(result: unknown): {
  messages: TelegramUpdateMessage[]
  callbacks: TelegramCallbackUpdate[]
  lastUpdateId?: number
} {
  if (!Array.isArray(result)) return { messages: [], callbacks: [] }
  const messages: TelegramUpdateMessage[] = []
  const callbacks: TelegramCallbackUpdate[] = []
  let lastUpdateId: number | undefined
  for (const raw of result) {
    if (!raw || typeof raw !== 'object') continue
    const update = raw as { update_id?: unknown; message?: unknown; callback_query?: unknown }
    if (typeof update.update_id !== 'number') continue
    lastUpdateId = update.update_id
    const cb = update.callback_query as
      | {
          id?: unknown
          data?: unknown
          from?: { first_name?: unknown; username?: unknown; is_bot?: unknown }
          message?: {
            chat?: { id?: unknown }
            message_thread_id?: unknown
          }
        }
      | undefined
    if (cb && typeof cb.id === 'string' && typeof cb.data === 'string' && cb.data !== '') {
      const chatId = cb.message?.chat?.id
      if (typeof chatId === 'number' || typeof chatId === 'string') {
        const senderLabel =
          typeof cb.from?.username === 'string'
            ? `@${cb.from.username}`
            : typeof cb.from?.first_name === 'string'
              ? cb.from.first_name
              : undefined
        callbacks.push({
          updateId: update.update_id,
          chatId: String(chatId),
          ...(typeof cb.message?.message_thread_id === 'number'
            ? { threadRef: String(cb.message.message_thread_id) }
            : {}),
          callbackQueryId: cb.id,
          data: cb.data,
          ...(senderLabel ? { senderLabel } : {}),
        })
      }
      continue
    }
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
  return {
    messages,
    callbacks,
    ...(lastUpdateId !== undefined ? { lastUpdateId } : {}),
  }
}

function inlineKeyboardMarkup(opts?: SendOptions) {
  const rows = opts?.replyMarkup?.inlineKeyboard
  if (!rows?.length) return undefined
  return {
    inline_keyboard: rows.map((row) =>
      row.map((btn) => ({ text: btn.label, callback_data: btn.data })),
    ),
  }
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
 * is the authorization boundary. Outbound replies convert superagent markdown
 * to MarkdownV2 (Hermes pattern: try MDV2, strip+resend plain on parse error),
 * chunked to the platform cap, with one inline retry on flood control.
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
            allowed_updates: ['message', 'callback_query'],
            ...(this.offset !== undefined ? { offset: this.offset } : {}),
          },
          this.abort?.signal,
        )
        const { messages, callbacks, lastUpdateId } = parseTelegramUpdates(body.result)
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
        for (const cb of callbacks) {
          if (cb.chatId !== wantChatId) continue
          onMessage({
            source: {
              channel: this.channel,
              chatId: cb.chatId,
              ...(cb.threadRef ? { threadRef: cb.threadRef } : {}),
            },
            text: '',
            callback: { id: cb.callbackQueryId, data: cb.data },
            ...(cb.senderLabel ? { senderLabel: cb.senderLabel } : {}),
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

  async send(target: ConversationRef, text: string, opts?: SendOptions): Promise<void> {
    const formatted = formatTelegramMarkdown(text)
    let chunks = chunkTelegramText(formatted)
    if (chunks.length > 1) {
      chunks = chunks.map((chunk, i) => {
        const suffix = ` (${i + 1}/${chunks.length})`
        return escapeChunkCounterSuffix(chunk + suffix)
      })
    }
    const replyMarkup = inlineKeyboardMarkup(opts)
    for (let i = 0; i < chunks.length; i++) {
      await this.sendChunk(target, chunks[i]!, {
        ...(i === chunks.length - 1 && replyMarkup ? { replyMarkup } : {}),
      })
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    })
  }

  async createForumTopic(chatId: string, name: string): Promise<{ threadRef: string }> {
    const body = await this.call('createForumTopic', {
      chat_id: chatId,
      name: name.slice(0, 128),
    })
    const threadId = (body.result as { message_thread_id?: unknown } | undefined)?.message_thread_id
    if (typeof threadId !== 'number') throw new Error('createForumTopic returned no message_thread_id')
    return { threadRef: String(threadId) }
  }

  private async sendChunk(
    target: ConversationRef,
    text: string,
    opts: {
      floodRetried?: boolean
      plainFallback?: boolean
      replyMarkup?: ReturnType<typeof inlineKeyboardMarkup>
    } = {},
  ): Promise<void> {
    const { floodRetried = false, plainFallback = false, replyMarkup } = opts
    try {
      await this.call('sendMessage', {
        chat_id: target.chatId,
        ...(target.threadRef ? { message_thread_id: Number(target.threadRef) } : {}),
        text,
        ...(plainFallback ? {} : { parse_mode: 'MarkdownV2' }),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      })
    } catch (err) {
      const retryAfter = (err as { retryAfter?: number }).retryAfter
      if (!floodRetried && typeof retryAfter === 'number' && retryAfter <= 30) {
        await sleep(retryAfter * 1000)
        return this.sendChunk(target, text, { floodRetried: true, plainFallback })
      }
      if (!plainFallback && isTelegramMarkdownParseError(err)) {
        return this.sendChunk(target, stripTelegramMarkdownV2(text), { plainFallback: true })
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.()
  })
}
