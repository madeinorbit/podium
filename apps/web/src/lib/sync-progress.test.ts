import { describe, expect, it } from 'vitest'
import { SyncProgressStore } from './sync-progress'

describe('HTTP sync progress', () => {
  it('keeps received rows separate from the atomic install', () => {
    const store = new SyncProgressStore()
    store.beginFirstSync()
    store.beginAttempt()
    store.noteMeta(20)
    store.noteReceived(20, 500)
    store.noteSaving()
    expect(store.getSnapshot()).toMatchObject({
      rowsSeen: 20,
      bytesSeen: 500,
      rowsCommitted: 0,
      phase: 'saving',
    })
    store.noteInstalled(20)
    expect(store.getSnapshot()).toMatchObject({
      rowsCommitted: 20,
      hasInstalled: true,
      phase: 'ready',
    })
  })
  it('resets retries even when the target has not changed', () => {
    const store = new SyncProgressStore()
    store.beginAttempt()
    store.noteMeta(20)
    store.noteReceived(10, 250)
    store.noteCommitted(1, 5, 10)
    store.noteError('network')
    store.beginAttempt()
    store.noteMeta(20)
    expect(store.getSnapshot()).toMatchObject({
      attempt: 2,
      rowsSeen: 0,
      bytesSeen: 0,
      framesCommitted: 0,
      error: null,
      totalRows: 20,
    })
  })
  it('retains installed content through a later heal and reports committed frames', () => {
    const store = new SyncProgressStore()
    store.beginFirstSync()
    store.noteInstalled(4)
    store.beginAttempt()
    store.noteReceived(2, 200)
    store.noteCommitted(1, 8, 10)
    expect(store.getSnapshot()).toMatchObject({
      hasInstalled: true,
      rowsCommitted: 0,
      framesCommitted: 1,
      committedSeq: 8,
      targetSeq: 10,
    })
  })
})
