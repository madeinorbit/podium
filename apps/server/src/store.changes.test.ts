import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

// Metadata oplog storage (docs/spec/oplog-read-path.md §2.1): the `changes` table
// contract — contiguous seq assignment, range reads, head-only retention, and seq
// monotonicity across a full prune (the property AUTOINCREMENT exists to provide).
describe('SessionStore changes table', () => {
  it('assigns contiguous, monotonic seqs across batches', () => {
    const store = new SessionStore(':memory:')
    const a = store.appendChanges(
      [
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"a":1}' },
        { entity: 'issue', entityId: 'i2', op: 'upsert', payload: '{"a":2}' },
      ],
      1000,
    )
    const b = store.appendChanges(
      [{ entity: 'session', entityId: 's1', op: 'remove', payload: null }],
      2000,
    )
    expect(a).toEqual([1, 2])
    expect(b).toEqual([3])
    expect(store.maxChangeSeq()).toBe(3)
    expect(store.minChangeSeq()).toBe(1)
  })

  it('changesSince returns rows strictly after the cursor, in order', () => {
    const store = new SessionStore(':memory:')
    store.appendChanges(
      [
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":2}' },
        { entity: 'issue', entityId: 'i1', op: 'remove', payload: null },
      ],
      1000,
    )
    const rows = store.changesSince(1)
    expect(rows.map((r) => r.seq)).toEqual([2, 3])
    expect(rows[1]).toMatchObject({ entity: 'issue', entityId: 'i1', op: 'remove', payload: null })
    expect(store.changesSince(3)).toEqual([])
  })

  it('prunes only rows beyond BOTH the row and age budgets, from the head', () => {
    const store = new SessionStore(':memory:')
    for (let i = 1; i <= 5; i++) {
      store.appendChanges(
        [{ entity: 'issue', entityId: `i${i}`, op: 'upsert', payload: '{}' }],
        i * 1000,
      )
    }
    // Row budget keeps 2 (threshold seq 3), age budget cuts before t=4000: rows 1-3
    // are beyond the row budget, but row 3 (t=3000) is NOT older than... it is
    // (< 4000). Rows 1-3 satisfy both -> pruned; 4,5 retained.
    store.pruneChanges({ keepRows: 2, maxAgeMs: 1000, now: 5000 })
    expect(store.minChangeSeq()).toBe(4)
    // Age budget protects rows the row budget would drop: nothing is older than
    // a huge age window, so nothing else is pruned.
    store.pruneChanges({ keepRows: 0, maxAgeMs: 60_000, now: 5000 })
    expect(store.minChangeSeq()).toBe(4)
  })

  it('keeps seq monotonic even after the whole table is pruned', () => {
    const store = new SessionStore(':memory:')
    store.appendChanges([{ entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{}' }], 1000)
    store.appendChanges([{ entity: 'issue', entityId: 'i2', op: 'upsert', payload: '{}' }], 1000)
    store.pruneChanges({ keepRows: 0, maxAgeMs: 0, now: 10_000 })
    expect(store.minChangeSeq()).toBeNull()
    // A rewound seq here would silently corrupt every client cursor.
    expect(store.maxChangeSeq()).toBe(2)
    const next = store.appendChanges(
      [{ entity: 'issue', entityId: 'i3', op: 'upsert', payload: '{}' }],
      1000,
    )
    expect(next).toEqual([3])
  })

  it('folds the log to the latest state per (entity, id)', () => {
    const store = new SessionStore(':memory:')
    store.appendChanges(
      [
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issue', entityId: 'i2', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":2}' },
        { entity: 'issue', entityId: 'i2', op: 'remove', payload: null },
        { entity: 'session', entityId: 'i1', op: 'upsert', payload: '{"s":1}' },
      ],
      1000,
    )
    const folded = store.latestChangeStates()
    expect(folded).toHaveLength(3)
    expect(folded).toContainEqual({
      entity: 'issue',
      entityId: 'i1',
      op: 'upsert',
      payload: '{"v":2}',
    })
    expect(folded).toContainEqual({ entity: 'issue', entityId: 'i2', op: 'remove', payload: null })
    // Same id under a different entity is a distinct key, not a collision.
    expect(folded).toContainEqual({
      entity: 'session',
      entityId: 'i1',
      op: 'upsert',
      payload: '{"s":1}',
    })
  })
})
