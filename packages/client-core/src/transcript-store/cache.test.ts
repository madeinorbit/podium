import { asSessionId, type TranscriptItem } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStoreTranscriptCache, planTranscriptWrite } from './cache'
import { createMemoryTranscriptBackend } from './memory'
import { createTranscriptStore, type TranscriptStore, type TranscriptStoreChange } from './store'

const chat = asSessionId('chat')
const item = (id: string, text = id): TranscriptItem => ({ id, role: 'assistant', text })

afterEach(() => {
  vi.useRealTimers()
})

function recordingStore(inner: TranscriptStore) {
  const puts: TranscriptStoreChange[] = []
  const store: TranscriptStore = {
    ...inner,
    put: (id, change) => {
      puts.push(change)
      return inner.put(id, change)
    },
  }
  return { store, puts }
}

describe('row diff', () => {
  it('writes one row for a new message and one for a changed one', () => {
    const a = item('a')
    const b = item('b')
    const first = planTranscriptWrite(new Map(), [a, b], false)!
    expect(first.change).toMatchObject({ clear: true })
    const appended = planTranscriptWrite(first.mirror, [a, b, item('c')], false)!
    expect(appended.change.upsert?.map((row) => row.id)).toEqual(['c'])
    expect(appended.change.clear).toBeUndefined()
    const edited = planTranscriptWrite(appended.mirror, [a, b, item('c', 'done')], false)!
    expect(edited.change.upsert?.map((row) => row.id)).toEqual(['c'])
    const same = planTranscriptWrite(edited.mirror, [a, b, edited.mirror.get('c')!.item], false)!
    expect(same.change).toEqual({})
  })

  it('places a message between two stored ones without rewriting them', () => {
    const base = planTranscriptWrite(new Map(), [item('a'), item('c')], false)!
    const inserted = planTranscriptWrite(base.mirror, [item('a'), item('b'), item('c')], false)!
    expect(inserted.change.upsert?.map((row) => row.id)).toEqual(['b'])
    const seqs = ['a', 'b', 'c'].map((id) => inserted.mirror.get(id)!.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
  })

  it('keeps stored rows contiguous: a jump past them removes what is below, no overlap replaces', () => {
    const base = planTranscriptWrite(new Map(), [item('a'), item('b'), item('c')], false)!
    // The window now starts with messages the device never stored, then continues at c.
    const jumped = planTranscriptWrite(base.mirror, [item('x'), item('y'), item('c')], false)!
    // a and b may not continue x and y, so they go: the rows below c are removed.
    expect(jumped.change.removeBelow).toBe(base.mirror.get('c')!.seq)
    expect(jumped.change.upsert?.map((row) => row.id)).toEqual(['x', 'y'])
    const disjoint = planTranscriptWrite(base.mirror, [item('p'), item('q')], false)!
    expect(disjoint.change.clear).toBe(true)
    const ghost = planTranscriptWrite(base.mirror, [item('a'), item('c')], false)!
    expect(ghost.change.remove).toEqual(['b'])
  })
})

describe('streaming writes', () => {
  it('writes a streaming reply about four times a second and the frozen message on flush', async () => {
    vi.useFakeTimers()
    const backend = createMemoryTranscriptBackend()
    const { store, puts } = recordingStore(createTranscriptStore({ backend }))
    const cache = createStoreTranscriptCache(store, { settleMs: 250 })
    const release = cache.hold!(chat)
    let window: TranscriptItem[] = [item('question')]
    // Two seconds of tokens at 60 frames a second.
    for (let frame = 0; frame < 120; frame++) {
      window = [window[0]!, item('reply', `token ${frame}`)]
      cache.write(chat, () => window)
      vi.advanceTimersByTime(1000 / 60)
    }
    expect(puts.length).toBeGreaterThanOrEqual(7)
    expect(puts.length).toBeLessThanOrEqual(9)
    // Every write after the first carries only the reply row.
    for (const change of puts.slice(1))
      expect(change.upsert?.map((row) => row.id)).toEqual(['reply'])
    window = [window[0]!, item('reply', 'the frozen answer')]
    cache.write(chat, () => window)
    cache.flush()
    vi.useRealTimers()
    await store.settled()
    const stored = await store.readNewest(chat, 10)
    expect(stored.messages.map((row) => row.item.text)).toEqual(['question', 'the frozen answer'])
    release()
  })

  it('reads older pages from the device, then nothing past the oldest stored message', async () => {
    const backend = createMemoryTranscriptBackend()
    const store = createTranscriptStore({ backend })
    const writer = createStoreTranscriptCache(store, { settleMs: 0 })
    const all = Array.from({ length: 30 }, (_, i) => item(`m${i}`))
    writer.write(chat, () => all)
    writer.flush()
    await store.settled()
    // A new run of the app.
    const cache = createStoreTranscriptCache(createTranscriptStore({ backend }))
    const release = cache.hold!(chat)
    const newest = await cache.load(chat, 10)
    expect(newest?.items.map((m) => m.id)).toEqual(all.slice(20).map((m) => m.id))
    expect(newest?.hasOlder).toBe(true)
    const older = await cache.loadBefore(chat, 'm20', 15)
    expect(older?.items.map((m) => m.id)).toEqual(all.slice(5, 20).map((m) => m.id))
    const oldest = await cache.loadBefore(chat, 'm5', 15)
    expect(oldest?.items.map((m) => m.id)).toEqual(all.slice(0, 5).map((m) => m.id))
    expect(oldest?.hasOlder).toBe(false)
    expect(await cache.loadBefore(chat, 'm0', 15)).toBeUndefined()
    release()
  })
})
