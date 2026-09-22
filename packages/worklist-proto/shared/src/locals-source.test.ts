/**
 * POD-4608 — the locals channel's own contract, without an engine: which keys
 * a notification names, coalescing, value identity, counting and disposal.
 * The engine-backed source is proven in `harness/src/engine-locals.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { createLocalsSource, fixedLocals, settableLocals } from './locals-source'
import type { LocalsKey, SliceLocals } from './slice-types'

const NOW = 1_758_000_000_000
const BASE: SliceLocals = { selectedIssueId: null, coarseNow: NOW }

function record(handle: { source: { subscribe(l: (c: ReadonlySet<LocalsKey>) => void): () => void } }) {
  const seen: LocalsKey[][] = []
  const off = handle.source.subscribe((changed) => seen.push([...changed].sort()))
  return { seen, off }
}

describe('settableLocals', () => {
  it('a tick names coarseNow only; a click names the selection keys only', () => {
    const locals = settableLocals(BASE)
    const { seen } = record(locals)
    locals.set({ coarseNow: NOW + 60_000 })
    locals.flush()
    locals.set({ selectedIssueId: 'i1', selectedIssueWasFolded: true })
    locals.flush()
    expect(seen).toEqual([['coarseNow'], ['selectedIssueId', 'selectedIssueWasFolded']])
    expect(locals.stats.notifications).toBe(2)
    expect(locals.stats.keys).toEqual({ selectedIssueId: 1, selectedIssueWasFolded: 1, coarseNow: 1 })
  })

  it('coalesces one drain into one notification carrying the union of keys', async () => {
    const locals = settableLocals(BASE)
    const { seen } = record(locals)
    locals.set({ selectedIssueId: 'i1' })
    locals.set({ coarseNow: NOW + 60_000 })
    await Promise.resolve()
    expect(seen).toEqual([['coarseNow', 'selectedIssueId']])
    expect(locals.stats.flushes).toBe(1)
  })

  it('get() moves only at the notification, and keeps identity when nothing moved', () => {
    const locals = settableLocals(BASE)
    const first = locals.source.get()
    locals.set({ selectedIssueId: 'i1' })
    // Not yet published: the arm has not been told.
    expect(locals.source.get()).toBe(first)
    locals.flush()
    const second = locals.source.get()
    expect(second).not.toBe(first)
    expect(second).toEqual({ selectedIssueId: 'i1', coarseNow: NOW })
    // A change that comes back before the drain is no change at all.
    locals.set({ selectedIssueId: 'i2' })
    locals.set({ selectedIssueId: 'i1' })
    expect(locals.flush()).toBeNull()
    expect(locals.source.get()).toBe(second)
    expect(locals.stats.notifications).toBe(1)
    expect(locals.stats.flushes).toBe(2)
  })

  it('an absent fold latch equals false: no wake for it', () => {
    const locals = settableLocals(BASE)
    const { seen } = record(locals)
    locals.set({ selectedIssueWasFolded: false })
    expect(locals.flush()).toBeNull()
    expect(seen).toEqual([])
  })

  it('unsubscribe and dispose stop notifications', () => {
    const locals = settableLocals(BASE)
    const { seen, off } = record(locals)
    const other = record(locals)
    off()
    locals.set({ coarseNow: NOW + 1 })
    locals.flush()
    expect(seen).toEqual([])
    expect(other.seen).toEqual([['coarseNow']])
    locals.dispose()
    locals.set({ coarseNow: NOW + 2 })
    expect(locals.flush()).toBeNull()
    expect(other.seen).toHaveLength(1)
  })

  it('one throwing listener does not stop the others', () => {
    const locals = settableLocals(BASE)
    locals.source.subscribe(() => {
      throw new Error('arm bug')
    })
    const { seen } = record(locals)
    locals.set({ coarseNow: NOW + 1 })
    locals.flush()
    expect(seen).toEqual([['coarseNow']])
  })

  it('stats.reset zeroes every counter', () => {
    const locals = settableLocals(BASE)
    locals.set({ coarseNow: NOW + 1 })
    locals.flush()
    locals.stats.reset()
    expect(locals.stats.notifications).toBe(0)
    expect(locals.stats.flushes).toBe(0)
    expect(locals.stats.keys).toEqual({ selectedIssueId: 0, selectedIssueWasFolded: 0, coarseNow: 0 })
  })
})

describe('fixedLocals', () => {
  it('serves its value and never notifies', () => {
    const locals = fixedLocals(BASE)
    const { seen } = record(locals)
    expect(locals.source.get()).toEqual(BASE)
    expect(locals.flush()).toBeNull()
    expect(seen).toEqual([])
    expect(locals.stats.flushes).toBe(0)
  })
})

describe('createLocalsSource', () => {
  it('reads its input only on a signal, at the drain', () => {
    let current: SliceLocals = BASE
    let reads = 0
    let wake: () => void = () => {}
    const locals = createLocalsSource(
      () => {
        reads += 1
        return current
      },
      (w) => {
        wake = w
        return () => {}
      },
    )
    const atCreate = reads
    current = { ...BASE, coarseNow: NOW + 60_000 }
    expect(locals.flush()).toBeNull()
    expect(reads).toBe(atCreate)
    wake()
    expect([...(locals.flush() ?? [])]).toEqual(['coarseNow'])
    expect(reads).toBe(atCreate + 1)
  })
})
