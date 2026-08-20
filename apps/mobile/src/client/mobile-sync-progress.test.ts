import type { ReplicaEvent } from '@podium/sync/replica'
import { describe, expect, it, vi } from 'vitest'
import { MobileSyncProgressStore } from './mobile-sync-progress'

const posture = (next: 'cold' | 'bootstrapping' | 'live' | 'healing' | 'stale'): ReplicaEvent => ({
  type: 'posture',
  posture: next,
  previous: next === 'live' ? 'healing' : 'live',
})

describe('MobileSyncProgressStore', () => {
  it('blocks only the first cursorless world, then keeps later catch-up warm', () => {
    const store = new MobileSyncProgressStore()
    store.begin('cold')
    expect(store.getSnapshot()).toMatchObject({ blocking: true, phase: 'connecting' })

    store.noteBootstrapFrame({
      seq: 7,
      last: true,
      changes: Array.from({ length: 40 }),
      totalRows: 100,
    })
    expect(store.getSnapshot()).toMatchObject({
      blocking: true,
      phase: 'saving',
      rowsSeen: 40,
      totalRows: 100,
    })

    store.noteEvent({
      type: 'bootstrap-installed',
      cause: 'cold-start',
      snapshotSeq: 7,
      entityCount: 40,
      bufferedFramesApplied: 0,
    })
    expect(store.getSnapshot()).toMatchObject({ blocking: false, phase: 'ready' })

    store.noteEvent(posture('stale'))
    expect(store.getSnapshot()).toMatchObject({ blocking: false, phase: 'reconnecting' })
  })

  it('makes a persisted-cursor launch usable while it catches up', () => {
    const store = new MobileSyncProgressStore()
    store.begin('stale')
    expect(store.getSnapshot()).toMatchObject({ blocking: false, phase: 'reconnecting' })

    store.noteEvent(posture('healing'))
    expect(store.getSnapshot()).toMatchObject({ blocking: false, phase: 'updating' })
    store.noteEvent(posture('live'))
    expect(store.getSnapshot()).toMatchObject({ blocking: false, phase: 'ready' })
  })

  it('never publishes per-row entity events', () => {
    const store = new MobileSyncProgressStore()
    store.begin('stale')
    const listener = vi.fn()
    store.subscribe(listener)

    store.noteEvent({
      type: 'upserted',
      readmitted: false,
      record: {
        entity: 'issue',
        entityId: 'i1',
        value: {},
        provenance: { seq: 1 },
      },
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it('surfaces exhausted bootstrap retries until a real recovery starts', () => {
    const store = new MobileSyncProgressStore()
    store.begin('cold')
    store.noteEvent({
      type: 'bootstrap-failed',
      cause: 'cold-start',
      attempts: 3,
      error: 'world unavailable',
    })

    expect(store.getSnapshot()).toMatchObject({
      blocking: true,
      phase: 'failed',
      failure: 'world unavailable',
    })
    // The kernel emits its terminal posture immediately after the failure. It
    // must not erase the only signal that can replace the infinite splash.
    store.noteEvent(posture('cold'))
    expect(store.getSnapshot()).toMatchObject({ phase: 'failed', failure: 'world unavailable' })

    store.noteEvent(posture('bootstrapping'))
    expect(store.getSnapshot()).toMatchObject({ phase: 'connecting', failure: null })
  })

  it('keeps a failed warm world usable and names it as offline', () => {
    const store = new MobileSyncProgressStore()
    store.begin('stale')
    store.noteEvent({
      type: 'bootstrap-failed',
      cause: 'resync-required',
      attempts: 3,
      error: 'network unavailable',
    })
    store.noteEvent(posture('stale'))

    expect(store.getSnapshot()).toMatchObject({
      blocking: false,
      phase: 'offline',
      failure: 'network unavailable',
    })
  })
})
