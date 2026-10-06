import { reaction } from 'mobx'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../worklist-proto/harness/src/work-meter'
import { REPLICA_TRANSCRIPT_ITEM_CAP } from '../replica/contract'
import type { TranscriptPage } from '../transcript/contracts'
import { TranscriptLog, type TranscriptChange } from './transcript-log'

const item = (index: number, role: TranscriptItem['role'] = 'assistant'): TranscriptItem => ({
  id: `item-${index}`, text: `Message ${index}`, role,
  cursor: Buffer.from(JSON.stringify(['file', index, `item-${index}`, 0])).toString('base64url'),
})

it('bounds stream, append, retained read and prepend producer work at 1x/4x history', async () => {
  const samples = []
  for (const scale of [1, 4]) {
    const items = Array.from({ length: 256 * scale }, (_, index) => item(index))
    let page: TranscriptPage = { items, head: 'head', hasMore: true }
    const write = vi.fn()
    const changes: TranscriptChange[] = []
    const log = new TranscriptLog({
      sessionId: asSessionId('incremental-work'),
      source: { read: async () => page, subscribe: () => () => {} },
      cache: { maxItems: REPLICA_TRANSCRIPT_ITEM_CAP, read: () => undefined, write },
      retainHistory: () => true,
      onChange: change => changes.push(change),
    })
    await log.start()
    const count = async (name: string, action: () => unknown) =>
      (await measureWork(async () => insideReader(name, action), { trace: true })).work
    try {
      const stream = await count('TranscriptLog.stream', () =>
        log.merge([{ ...items.at(-1)!, text: 'streamed token' }]))
      const incoming = await count('TranscriptLog.incoming', () => log.merge([item(items.length)]))
      page = { items: [{ ...item(items.length), text: 'read update' }], tail: 'authority-tail', hasMore: false }
      const read = await count('TranscriptLog.retainedRead', () => log.refresh())
      page = { items: [item(-2, 'user'), item(-1), items[0]!], head: 'older-head', hasMore: false }
      const older = await count('TranscriptLog.loadOlder', () => log.loadOlder())
      expect(log.items).toHaveLength(items.length + 3)
      expect(log.position(items.at(-1)!.id)).toBe(items.length + 1)
      expect(log.position(`item-${items.length}`)).toBe(items.length + 2)
      expect(log.latestOperatorPrompt).toBe('Message -2')
      expect(log.tail).toBe('authority-tail')
      expect(changes.slice(-4).map(change => ({
        changed: change.changed.length, added: change.added.length,
        rebuild: change.rebuild, orderChanged: change.orderChanged,
      }))).toEqual([
        { changed: 1, added: 0, rebuild: false, orderChanged: false },
        { changed: 1, added: 1, rebuild: false, orderChanged: true },
        { changed: 1, added: 0, rebuild: false, orderChanged: false },
        { changed: 2, added: 2, rebuild: false, orderChanged: true },
      ])
      for (const [, cached] of write.mock.calls) expect(cached).toHaveLength(REPLICA_TRANSCRIPT_ITEM_CAP)
      samples.push({ scale, history: items.length, stream, incoming, read, older })
    } finally { log.dispose() }
  }
  for (const name of ['stream', 'incoming', 'read', 'older'] as const) {
    expect(samples[1]![name].elements).toBe(samples[0]![name].elements)
    expect(samples[1]![name].visits).toBe(samples[0]![name].visits)
  }
  console.log('[transcript-ingress-work]', JSON.stringify(samples))
})

it('keeps old snapshots immutable and preserves keyed facts across prefix and cursor insertion', async () => {
  let page: TranscriptPage = { items: [item(-2, 'user'), item(-1)], head: 'older', hasMore: false }
  const log = new TranscriptLog({
    sessionId: asSessionId('incremental-snapshots'),
    source: { read: async () => page, subscribe: () => () => {} },
    cache: { read: () => ({ items: [item(0, 'user'), item(2)], savedAt: 1 }), write: () => {} },
    retainHistory: () => true,
  })
  const initial = log.items
  const idsChanged = vi.fn()
  const stop = reaction(() => log.ids.slice(), idsChanged)
  try {
    log.merge([{ ...item(2), text: 'changed' }])
    expect(idsChanged).not.toHaveBeenCalled()
    const streamed = log.items
    expect(streamed).not.toBe(initial)
    expect(initial[1]?.text).toBe('Message 2')
    log.head = 'head'
    await log.loadOlder()
    log.merge([item(1, 'user')])
    expect(log.ids.slice()).toEqual(['item--2', 'item--1', 'item-0', 'item-1', 'item-2'])
    expect(log.position('item-0')).toBe(2)
    expect(log.position('item-1')).toBe(3)
    expect(log.latestOperatorPrompt).toBe('Message 1')
    expect(initial).toEqual([item(0, 'user'), item(2)])
    expect(streamed).toHaveLength(2)
    page = { items: [], hasMore: false }
    log.merge([], { reset: true })
    expect(log.items).toEqual([])
    expect(log.latestOperatorPrompt).toBeNull()
    expect(log.position('item-1')).toBeUndefined()
    await Promise.resolve()
  } finally { stop(); log.dispose() }
})

it('retains the full cache contract by default and supports an explicitly empty cache window', () => {
  for (const maxItems of [undefined, 0, 2]) {
    const write = vi.fn()
    const log = new TranscriptLog({
      sessionId: asSessionId('cache-contract'),
      source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} },
      cache: { maxItems, read: () => ({ items: [item(0), item(1)], savedAt: 1 }), write },
      retainHistory: () => true,
    })
    try {
      log.merge([item(2)])
      expect(write.mock.calls[0]?.[1]).toEqual(
        maxItems === undefined ? [item(0), item(1), item(2)] : maxItems === 0 ? [] : [item(1), item(2)],
      )
      expect(log.items).toEqual([item(0), item(1), item(2)])
    } finally { log.dispose() }
  }
})
