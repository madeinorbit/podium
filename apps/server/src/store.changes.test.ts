import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

// Metadata oplog storage (docs/spec/oplog-read-path.md §2.1): the `changes` table
// contract — contiguous seq assignment, range reads, head-only retention, and seq
// monotonicity across a full prune (the property AUTOINCREMENT exists to provide).
describe('SessionStore changes table', () => {
  it('assigns contiguous, monotonic seqs across batches', () => {
    const store = new SessionStore(':memory:')
    const a = store.sync.appendChanges(
      [
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"a":1}' },
        { entity: 'issue', entityId: 'i2', op: 'upsert', payload: '{"a":2}' },
      ],
      1000,
    )
    const b = store.sync.appendChanges(
      [{ entity: 'session', entityId: 's1', op: 'remove', payload: null }],
      2000,
    )
    expect(a).toEqual([1, 2])
    expect(b).toEqual([3])
    expect(store.sync.maxChangeSeq()).toBe(3)
    expect(store.sync.minChangeSeq()).toBe(1)
  })

  it('changesSince returns rows strictly after the cursor, in order', () => {
    const store = new SessionStore(':memory:')
    store.sync.appendChanges(
      [
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":2}' },
        { entity: 'issue', entityId: 'i1', op: 'remove', payload: null },
      ],
      1000,
    )
    const rows = store.sync.changesSince(1)
    expect(rows.map((r) => r.seq)).toEqual([2, 3])
    expect(rows[1]).toMatchObject({ entity: 'issue', entityId: 'i1', op: 'remove', payload: null })
    expect(store.sync.changesSince(3)).toEqual([])
  })

  it('prunes rows beyond EITHER the row cap or the age budget, head-only', () => {
    const store = new SessionStore(':memory:')
    for (let i = 1; i <= 5; i++) {
      store.sync.appendChanges(
        [{ entity: 'issue', entityId: `i${i}`, op: 'upsert', payload: '{}' }],
        i * 1000,
      )
    }
    // Row cap alone: keep the newest 2, even though every row is young (nothing
    // is older than the huge age window). The old AND-policy kept all 5 here —
    // that is exactly why the table never pruned under sustained write rates.
    store.sync.pruneChanges({ keepRows: 2, maxAgeMs: 60_000, now: 5000 })
    expect(store.sync.minChangeSeq()).toBe(4)
    expect(store.sync.maxChangeSeq()).toBe(5)
    // Age budget alone: a generous row cap does not protect rows past the age
    // cutoff (t < 4500 -> row 4 at t=4000 goes, row 5 at t=5000 stays).
    store.sync.pruneChanges({ keepRows: 100, maxAgeMs: 500, now: 5000 })
    expect(store.sync.minChangeSeq()).toBe(5)
  })

  it('bounds each head-prune delete unit and reports its row count', () => {
    const store = new SessionStore(':memory:')
    for (let i = 1; i <= 5; i++) {
      store.sync.appendChanges(
        [{ entity: 'issue', entityId: `i${i}`, op: 'upsert', payload: '{}' }],
        1000,
      )
    }

    expect(
      store.sync.pruneChanges({ keepRows: 0, maxAgeMs: 0, now: 10_000, batchSize: 2 }),
    ).toBe(2)
    expect(store.sync.minChangeSeq()).toBe(3)
    expect(
      store.sync.pruneChanges({ keepRows: 0, maxAgeMs: 0, now: 10_000, batchSize: 2 }),
    ).toBe(2)
    expect(store.sync.minChangeSeq()).toBe(5)
  })

  it('age pruning deletes from the head only, keeping the retained range contiguous', () => {
    const store = new SessionStore(':memory:')
    // Out-of-order event times: row 2 is "old", rows 1 and 3 are "young". A naive
    // `WHERE event_time < cutoff` would punch a hole at seq 2; head-only pruning
    // must delete everything at-or-below the highest aged seq instead.
    store.sync.appendChanges([{ entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{}' }], 9000)
    store.sync.appendChanges([{ entity: 'issue', entityId: 'i2', op: 'upsert', payload: '{}' }], 1000)
    store.sync.appendChanges([{ entity: 'issue', entityId: 'i3', op: 'upsert', payload: '{}' }], 9000)
    store.sync.pruneChanges({ keepRows: 100, maxAgeMs: 1000, now: 5000 })
    expect(store.sync.minChangeSeq()).toBe(3)
  })

  it('keeps seq monotonic even after the whole table is pruned', () => {
    const store = new SessionStore(':memory:')
    store.sync.appendChanges([{ entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{}' }], 1000)
    store.sync.appendChanges([{ entity: 'issue', entityId: 'i2', op: 'upsert', payload: '{}' }], 1000)
    store.sync.pruneChanges({ keepRows: 0, maxAgeMs: 0, now: 10_000 })
    expect(store.sync.minChangeSeq()).toBeNull()
    // A rewound seq here would silently corrupt every client cursor.
    expect(store.sync.maxChangeSeq()).toBe(2)
    const next = store.sync.appendChanges(
      [{ entity: 'issue', entityId: 'i3', op: 'upsert', payload: '{}' }],
      1000,
    )
    expect(next).toEqual([3])
  })

  it('folds the log to the latest state per (entity, id)', () => {
    const store = new SessionStore(':memory:')
    store.sync.appendChanges(
      [
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issue', entityId: 'i2', op: 'upsert', payload: '{"v":1}' },
        { entity: 'issue', entityId: 'i1', op: 'upsert', payload: '{"v":2}' },
        { entity: 'issue', entityId: 'i2', op: 'remove', payload: null },
        { entity: 'session', entityId: 'i1', op: 'upsert', payload: '{"s":1}' },
      ],
      1000,
    )
    const folded = store.sync.latestChangeStates()
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
