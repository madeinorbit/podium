import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

// Outbox write-path storage (docs/spec/outbox-write-path.md §2.1-2.2): the
// applied_mutations idempotency ledger and the queued_messages durable send queue.

describe('SessionStore applied_mutations', () => {
  it('getAppliedMutation returns undefined for an unknown id', () => {
    const store = new SessionStore(':memory:')
    expect(store.sync.getAppliedMutation('never-seen')).toBeUndefined()
  })

  it('round-trips a recorded result verbatim', () => {
    const store = new SessionStore(':memory:')
    store.sync.recordAppliedMutation('m1', 'issues.create', '{"id":"i1"}', 1000)
    expect(store.sync.getAppliedMutation('m1')).toBe('{"id":"i1"}')
  })

  it('a duplicate record keeps the FIRST result (INSERT OR IGNORE)', () => {
    // Idempotency invariant 1: a mutationId is applied at most once — a racing
    // second record must never overwrite what the original run returned.
    const store = new SessionStore(':memory:')
    store.sync.recordAppliedMutation('m1', 'issues.create', '{"v":"first"}', 1000)
    store.sync.recordAppliedMutation('m1', 'issues.create', '{"v":"second"}', 2000)
    expect(store.sync.getAppliedMutation('m1')).toBe('{"v":"first"}')
  })

  it('prunes only mutations older than the age window', () => {
    const store = new SessionStore(':memory:')
    store.sync.recordAppliedMutation('old', 'p', '"a"', 1_000)
    store.sync.recordAppliedMutation('young', 'p', '"b"', 9_000)
    store.sync.pruneAppliedMutations({ maxAgeMs: 5_000, now: 10_000 })
    expect(store.sync.getAppliedMutation('old')).toBeUndefined()
    expect(store.sync.getAppliedMutation('young')).toBe('"b"')
  })
})

describe('SessionStore queued_messages', () => {
  it('lists FIFO by queued_at, then insertion order for ties', () => {
    const store = new SessionStore(':memory:')
    // Inserted out of time order + a same-timestamp pair to prove BOTH sort keys
    // (queued_at first, rowid as the tiebreaker).
    expect(store.sync.enqueueMessage({ id: 'q-b', sessionId: 's1', text: 'b', queuedAt: 2000 })).toBe(
      true,
    )
    expect(store.sync.enqueueMessage({ id: 'q-c', sessionId: 's1', text: 'c', queuedAt: 2000 })).toBe(
      true,
    )
    expect(store.sync.enqueueMessage({ id: 'q-a', sessionId: 's1', text: 'a', queuedAt: 1000 })).toBe(
      true,
    )
    expect(store.sync.listQueuedMessages('s1').map((m) => m.text)).toEqual(['a', 'b', 'c'])
  })

  it('enqueue with a duplicate id returns false and does not duplicate the row', () => {
    // The row id IS the mutationId, so a replayed enqueue must be a storage no-op.
    const store = new SessionStore(':memory:')
    expect(
      store.sync.enqueueMessage({ id: 'mut-1', sessionId: 's1', text: 'once', queuedAt: 1000 }),
    ).toBe(true)
    expect(
      store.sync.enqueueMessage({ id: 'mut-1', sessionId: 's1', text: 'again', queuedAt: 2000 }),
    ).toBe(false)
    const rows = store.sync.listQueuedMessages('s1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'mut-1', text: 'once', attempts: 0 })
  })

  it('queuedMessageCounts groups per session', () => {
    const store = new SessionStore(':memory:')
    store.sync.enqueueMessage({ id: 'a1', sessionId: 's-a', text: 'x', queuedAt: 1000 })
    store.sync.enqueueMessage({ id: 'a2', sessionId: 's-a', text: 'y', queuedAt: 2000 })
    store.sync.enqueueMessage({ id: 'b1', sessionId: 's-b', text: 'z', queuedAt: 3000 })
    expect(store.sync.queuedMessageCounts()).toEqual(
      new Map([
        ['s-a', 2],
        ['s-b', 1],
      ]),
    )
  })

  it('deleteQueuedMessage removes exactly that row', () => {
    const store = new SessionStore(':memory:')
    store.sync.enqueueMessage({ id: 'keep', sessionId: 's1', text: 'keep', queuedAt: 1000 })
    store.sync.enqueueMessage({ id: 'drop', sessionId: 's1', text: 'drop', queuedAt: 2000 })
    store.sync.deleteQueuedMessage('drop')
    expect(store.sync.listQueuedMessages('s1').map((m) => m.id)).toEqual(['keep'])
  })

  it('bumpQueuedAttempts increments the attempt counter', () => {
    const store = new SessionStore(':memory:')
    store.sync.enqueueMessage({ id: 'q1', sessionId: 's1', text: 't', queuedAt: 1000 })
    store.sync.bumpQueuedAttempts('q1')
    store.sync.bumpQueuedAttempts('q1')
    expect(store.sync.listQueuedMessages('s1')[0]?.attempts).toBe(2)
  })

  it('deleteQueuedMessagesForSession drops only that session queue', () => {
    const store = new SessionStore(':memory:')
    store.sync.enqueueMessage({ id: 'a1', sessionId: 's-a', text: 'x', queuedAt: 1000 })
    store.sync.enqueueMessage({ id: 'a2', sessionId: 's-a', text: 'y', queuedAt: 2000 })
    store.sync.enqueueMessage({ id: 'b1', sessionId: 's-b', text: 'z', queuedAt: 3000 })
    store.sync.deleteQueuedMessagesForSession('s-a')
    expect(store.sync.listQueuedMessages('s-a')).toEqual([])
    expect(store.sync.listQueuedMessages('s-b').map((m) => m.id)).toEqual(['b1'])
  })
  it('persists explicit causal input origins with queued prompts', () => {
    const store = new SessionStore(':memory:')
    store.sync.enqueueMessage({
      id: 'steward-1',
      sessionId: 'parent',
      text: 'child done',
      queuedAt: 1000,
      inputOrigin: 'steward',
    })
    store.sync.enqueueMessage({
      id: 'mail-1',
      sessionId: 'worker',
      text: 'new mail',
      queuedAt: 1000,
      inputOrigin: 'mail',
    })
    expect(store.sync.listQueuedMessages('parent')[0]?.inputOrigin).toBe('steward')
    expect(store.sync.listQueuedMessages('worker')[0]?.inputOrigin).toBe('mail')
  })
})
