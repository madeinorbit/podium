import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../bus'
import { MessagingService } from './service'
import { chunkTelegramText, parseTelegramUpdates } from './telegram'
import type { ChannelAdapter, InboundChatMessage } from './types'

describe('parseTelegramUpdates', () => {
  it('extracts text messages and the last update id', () => {
    const { messages, lastUpdateId } = parseTelegramUpdates([
      {
        update_id: 10,
        message: {
          text: 'hello',
          chat: { id: 42 },
          from: { first_name: 'Mika', username: 'mika' },
        },
      },
      { update_id: 11, message: { chat: { id: 42 }, photo: [{}] } },
      { update_id: 12, edited_message: { text: 'edited', chat: { id: 42 } } },
    ])
    expect(messages).toEqual([
      { updateId: 10, chatId: '42', text: 'hello', senderLabel: '@mika' },
    ])
    expect(lastUpdateId).toBe(12)
  })

  it('skips bot senders and carries forum topic ids as threadRef', () => {
    const { messages } = parseTelegramUpdates([
      {
        update_id: 1,
        message: { text: 'from bot', chat: { id: 1 }, from: { is_bot: true } },
      },
      {
        update_id: 2,
        message: { text: 'in topic', chat: { id: 1 }, message_thread_id: 77 },
      },
    ])
    expect(messages).toEqual([{ updateId: 2, chatId: '1', threadRef: '77', text: 'in topic' }])
  })

  it('tolerates garbage', () => {
    expect(parseTelegramUpdates(undefined).messages).toEqual([])
    expect(parseTelegramUpdates([null, 3, { update_id: 'x' }]).messages).toEqual([])
  })
})

describe('chunkTelegramText', () => {
  it('passes short text through untouched', () => {
    expect(chunkTelegramText('hi')).toEqual(['hi'])
  })

  it('splits long text at newline boundaries under the cap', () => {
    const para = 'a'.repeat(3000)
    const chunks = chunkTelegramText(`${para}\n${para}`, 4000)
    expect(chunks).toEqual([para, para])
  })

  it('hard-splits a single unbroken run', () => {
    const chunks = chunkTelegramText('x'.repeat(9000), 4000)
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 1000])
  })
})

interface Harness {
  service: MessagingService
  bus: EventBus
  inbound: (text: string) => void
  sent: Array<{ chatId: string; text: string }>
  sendTurn: ReturnType<typeof vi.fn>
}

function makeHarness(opts: { sendTurnImpl?: () => Promise<unknown> } = {}): Harness {
  const bus = new EventBus()
  const sent: Array<{ chatId: string; text: string }> = []
  let onMessage: ((msg: InboundChatMessage) => void) | undefined
  const adapter: ChannelAdapter = {
    channel: 'telegram',
    start: (cb) => {
      onMessage = cb
    },
    stop: () => {},
    send: async (target, text) => {
      sent.push({ chatId: target.chatId, text })
    },
  }
  const sendTurn = vi.fn(
    opts.sendTurnImpl ??
      (() => Promise.resolve({ threadId: 'global', podiumSessionId: 'ps1' })),
  )
  const service = new MessagingService({
    bus,
    getSettings: () =>
      ({
        notifications: {
          web: true,
          ntfyTopic: '',
          telegramBotToken: 'tok',
          telegramChatId: '42',
        },
      }) as never,
    superagent: { sendTurn: sendTurn as never },
    createTelegram: () => adapter,
  })
  service.configure()
  return {
    service,
    bus,
    sent,
    sendTurn,
    inbound: (text) =>
      onMessage?.({ source: { channel: 'telegram', chatId: '42' }, text }),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('MessagingService', () => {
  it('dispatches an inbound message as a global-thread turn and relays the reply', async () => {
    const h = makeHarness()
    h.inbound('status?')
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sendTurn.mock.calls[0]![0]!.threadId).toBe('global')
    expect(h.sendTurn.mock.calls[0]![0]!.text).toContain('status?')
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: true,
      output: 'all good',
    })
    await flush()
    expect(h.sent).toEqual([{ chatId: '42', text: 'all good' }])
  })

  it('does not double-dispatch when two messages land before the first ack', async () => {
    const h = makeHarness()
    h.inbound('first')
    h.inbound('second') // no flush between — dispatch promise still pending
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    expect(h.sendTurn.mock.calls[0]![0]!.text).toContain('first')
  })

  it('queues while a turn is in flight and drains on turnEnded', async () => {
    const h = makeHarness()
    h.inbound('first')
    await flush()
    h.inbound('second')
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(1)
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: true,
      output: 'reply one',
    })
    await flush()
    expect(h.sendTurn).toHaveBeenCalledTimes(2)
    expect(h.sendTurn.mock.calls[1]![0]!.text).toContain('second')
  })

  it('keeps the message queued when someone else holds the thread, retries on turnEnded', async () => {
    let busy = true
    const h = makeHarness({
      sendTurnImpl: () =>
        busy
          ? Promise.reject(new Error('a turn is already running on this thread'))
          : Promise.resolve({ threadId: 'global', podiumSessionId: 'ps1' }),
    })
    h.inbound('hello')
    await flush()
    expect(h.sent).toEqual([]) // no error surfaced — just queued
    busy = false
    // A web-dispatched turn (not awaited by the bridge) finishes:
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: true,
      output: 'web reply',
    })
    await flush()
    expect(h.sent).toEqual([]) // web turn's reply is not relayed
    expect(h.sendTurn).toHaveBeenCalledTimes(2) // retried and accepted
  })

  it('surfaces terminal dispatch errors and keeps the queue moving', async () => {
    const h = makeHarness({
      sendTurnImpl: () => Promise.reject(new Error('thread is open in a terminal')),
    })
    h.inbound('hello')
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('thread is open in a terminal')
  })

  it('relays a failed turn as an error message', async () => {
    const h = makeHarness()
    h.inbound('hi')
    await flush()
    h.bus.emit('superagent.turnEnded', {
      threadId: 'global',
      podiumSessionId: 'ps1',
      ok: false,
      error: 'harness died',
    })
    await flush()
    expect(h.sent[0]!.text).toContain('harness died')
  })
})
