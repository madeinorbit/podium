import { asSessionId, type TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createStoreTranscriptCache } from '../transcript-store/cache'
import { createMemoryTranscriptBackend } from '../transcript-store/memory'
import { createTranscriptStore } from '../transcript-store/store'
import type { TranscriptPage, TranscriptReadRequest } from '../transcript/contracts'
import { TranscriptLog } from './transcript-log'

const chat = asSessionId('chat')
const cursor = (offset: number) =>
  Buffer.from(JSON.stringify(['file', offset, `uuid-${offset}`, 0])).toString('base64url')
const item = (n: number, text = `message ${n}`): TranscriptItem => ({
  id: `m${n}`,
  cursor: cursor(n * 100),
  role: n % 2 === 0 ? 'user' : 'assistant',
  text,
})

function delayedSource() {
  const reads: TranscriptReadRequest[] = []
  const replies: ((page: TranscriptPage) => void)[] = []
  const subscribe = vi.fn(() => () => {})
  return {
    reads,
    subscribe,
    reply: (page: TranscriptPage) => replies.shift()!(page),
    port: {
      read: (request: TranscriptReadRequest) => {
        reads.push(request)
        return new Promise<TranscriptPage>((resolve) => replies.push(resolve))
      },
      subscribe,
    },
  }
}

/** One run of the app: a store over the device's (surviving) backend. */
function run(backend: ReturnType<typeof createMemoryTranscriptBackend>) {
  const store = createTranscriptStore({ backend })
  return { store, cache: createStoreTranscriptCache(store, { settleMs: 0 }) }
}

describe('reopening a chat after a restart', () => {
  it('paints the newest stored messages before any network reply, then reads only what came after', async () => {
    const backend = createMemoryTranscriptBackend()
    const before = run(backend)
    const history = Array.from({ length: 300 }, (_, n) => item(n))
    before.cache.write(chat, () => history)
    before.cache.flush()
    await before.store.settled()

    // Restart. The server is slow to answer.
    const after = run(backend)
    const io = delayedSource()
    const log = new TranscriptLog({
      sessionId: chat,
      source: io.port,
      cache: after.cache,
      initialLimit: 200,
    })
    const starting = log.start()
    await vi.waitFor(() => expect(log.items).toHaveLength(200))
    expect(log.items[0]?.id).toBe('m100')
    expect(log.items.at(-1)?.id).toBe('m299')
    expect(log.freshness).toBe('checking')
    // The delta read: after the message BEFORE the newest stored one (which may
    // have been saved mid-stream), never a newest-window read.
    await vi.waitFor(() => expect(io.reads).toHaveLength(1))
    expect(io.reads[0]).toEqual({
      sessionId: chat,
      anchor: cursor(298 * 100),
      direction: 'after',
      limit: 200,
    })
    io.reply({ items: [item(299, 'message 299, finished'), item(300), item(301)], hasMore: false })
    await starting
    expect(io.reads).toHaveLength(1)
    expect(log.items.at(-1)?.id).toBe('m301')
    expect(log.getItem('m299')?.text).toBe('message 299, finished')
    expect(io.subscribe).toHaveBeenCalledWith(chat, cursor(301 * 100), expect.any(Function))
    // The new messages land on the device too.
    log.dispose()
    after.cache.flush()
    await after.store.settled()
    const stored = await after.store.readNewest(chat, 3)
    expect(stored.messages.map((row) => row.item.id)).toEqual(['m299', 'm300', 'm301'])
  })

  it('falls back to the newest-window read when the delta does not continue the stored run', async () => {
    const backend = createMemoryTranscriptBackend()
    const before = run(backend)
    before.cache.write(chat, () => [item(1), item(2), item(3)])
    before.cache.flush()
    await before.store.settled()

    const after = run(backend)
    const io = delayedSource()
    const log = new TranscriptLog({ sessionId: chat, source: io.port, cache: after.cache })
    const starting = log.start()
    await vi.waitFor(() => expect(io.reads).toHaveLength(1))
    // A reader that lost the anchor answers with the transcript's OLDEST page.
    io.reply({ items: [item(0), item(1)], hasMore: true })
    await vi.waitFor(() => expect(io.reads).toHaveLength(2))
    expect(io.reads[1]).toMatchObject({ direction: 'before', limit: 200 })
    expect(io.reads[1]?.anchor).toBeUndefined()
    io.reply({ items: [item(7), item(8)], head: cursor(700), hasMore: true })
    await starting
    expect(log.items.map((entry) => entry.id)).toEqual(['m7', 'm8'])
    log.dispose()
  })

  it('scrolls back through the device before asking the server', async () => {
    const backend = createMemoryTranscriptBackend()
    const before = run(backend)
    before.cache.write(chat, () => Array.from({ length: 30 }, (_, n) => item(n)))
    before.cache.flush()
    await before.store.settled()

    const after = run(backend)
    const io = delayedSource()
    const log = new TranscriptLog({
      sessionId: chat,
      source: io.port,
      cache: after.cache,
      initialLimit: 10,
      pageLimit: 10,
      retainHistory: () => true,
    })
    const starting = log.start()
    await vi.waitFor(() => expect(io.reads).toHaveLength(1))
    io.reply({ items: [item(29)], hasMore: false })
    await starting
    expect(await log.loadOlder()).toBe(true)
    expect(await log.loadOlder()).toBe(true)
    expect(log.items[0]?.id).toBe('m0')
    expect(io.reads).toHaveLength(1)
    const toServer = log.loadOlder()
    await vi.waitFor(() => expect(io.reads).toHaveLength(2))
    expect(io.reads[1]).toMatchObject({ direction: 'before', anchor: cursor(0) })
    io.reply({ items: [], hasMore: false })
    expect(await toServer).toBe(false)
    log.dispose()
  })
})
