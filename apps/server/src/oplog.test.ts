import { describe, expect, it } from 'vitest'
import { MetadataOplog } from './oplog'
import { SessionStore } from './store'

// The diff-at-broadcast feed (docs/spec/oplog-read-path.md §2.2): record() must
// emit exactly the difference, changesSince() must refuse to serve a gapped range,
// and a fresh instance must rebuild its diff baseline from the durable log.
describe('MetadataOplog', () => {
  const issue = (id: string, v: number) => ({ id, value: { id, title: `t${v}` } })

  it('records only actual changes: first sight, edits, and disappearances', () => {
    const oplog = new MetadataOplog(new SessionStore(':memory:'))
    const first = oplog.record('issue', [issue('a', 1), issue('b', 1)])
    expect(first.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'upsert'],
    ])
    // Byte-identical list -> no rows (an activity bump that changed nothing).
    expect(oplog.record('issue', [issue('a', 1), issue('b', 1)])).toEqual([])
    // One field change + one removal -> exactly two rows.
    const second = oplog.record('issue', [issue('a', 2)])
    expect(second.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'remove'],
    ])
    expect(second[0]).toMatchObject({ entity: 'issue', value: { id: 'a', title: 't2' } })
    expect(oplog.cursor()).toBe(4)
  })

  it('serves changesSince within the retained range and rejects everything else', () => {
    const oplog = new MetadataOplog(new SessionStore(':memory:'))
    expect(oplog.changesSince(null)).toBeNull() // bootstrap -> snapshot
    expect(oplog.changesSince(0)).toEqual([]) // empty log, cursor at head
    oplog.record('issue', [issue('a', 1)])
    oplog.record('issue', [issue('a', 2)])
    expect(oplog.changesSince(0)?.map((c) => c.seq)).toEqual([1, 2])
    expect(oplog.changesSince(1)?.map((c) => c.seq)).toEqual([2])
    expect(oplog.changesSince(2)).toEqual([]) // caught up
    expect(oplog.changesSince(3)).toBeNull() // future cursor (server DB reset)
  })

  it('falls back to snapshot when the cursor predates the retained log', () => {
    const store = new SessionStore(':memory:')
    const oplog = new MetadataOplog(store)
    oplog.record('issue', [issue('a', 1)])
    oplog.record('issue', [issue('a', 2)])
    oplog.record('issue', [issue('a', 3)])
    store.pruneChanges({ keepRows: 1, maxAgeMs: 60_000, now: Date.now() })
    expect(oplog.changesSince(0)).toBeNull() // seq 1-2 pruned away -> gap
    expect(oplog.changesSince(2)?.map((c) => c.seq)).toEqual([3]) // still contiguous
  })

  it('prunes a bloated log at construction (boot self-heal)', () => {
    const store = new SessionStore(':memory:')
    const t0 = 1_000_000
    store.appendChanges([{ entity: 'issue', entityId: 'a', op: 'upsert', payload: '{}' }], t0)
    const young = t0 + MetadataOplog.MAX_AGE_MS + 60_000
    store.appendChanges([{ entity: 'issue', entityId: 'b', op: 'upsert', payload: '{}' }], young)
    // Boot with "now" past row 1's age budget but within row 2's: the constructor
    // prune drops the aged head before folding the baseline.
    const oplog = new MetadataOplog(store, () => young + 1)
    expect(store.minChangeSeq()).toBe(2)
    expect(store.maxChangeSeq()).toBe(2)
    // The surviving row still seeds the diff baseline: re-recording it is a no-op.
    expect(oplog.record('issue', [{ id: 'b', value: JSON.parse('{}') }])).toEqual([])
  })

  it('conversation records ignore volatile-only churn but ship full payloads on stable changes', () => {
    const conv = (over: Record<string, unknown> = {}) => [
      {
        id: 'c1',
        value: {
          id: 'c1',
          title: 'hi',
          updatedAt: 'T1',
          messageCount: 1,
          statusHint: 'busy',
          ...over,
        },
      },
    ]
    const store = new SessionStore(':memory:')
    const oplog = new MetadataOplog(store)
    expect(oplog.record('conversation', conv())).toHaveLength(1) // first sight
    // Scan-driven activity bumps (updatedAt / messageCount / statusHint) changed
    // no stable field -> nothing recorded (the 81MB/day churn fix). Staleness
    // tradeoff: delta clients see these refresh on the next stable-field change
    // or reconnect snapshot.
    expect(
      oplog.record('conversation', conv({ updatedAt: 'T2', messageCount: 5, statusHint: 'idle' })),
    ).toEqual([])
    // A stable-field change records — and the durable payload is the FULL current
    // wire value, volatile fields included.
    const changed = oplog.record(
      'conversation',
      conv({ title: 'renamed', updatedAt: 'T3', messageCount: 9, statusHint: 'idle' }),
    )
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({
      op: 'upsert',
      value: { title: 'renamed', updatedAt: 'T3', messageCount: 9, statusHint: 'idle' },
    })
    // Disappearance still records a remove.
    expect(oplog.record('conversation', []).map((c) => c.op)).toEqual(['remove'])
    // And re-appearance after a remove is a fresh upsert.
    expect(oplog.record('conversation', conv()).map((c) => c.op)).toEqual(['upsert'])
  })

  it('the conversation projection baseline survives a restart', () => {
    const store = new SessionStore(':memory:')
    const before = new MetadataOplog(store)
    before.record('conversation', [
      { id: 'c1', value: { id: 'c1', title: 'hi', updatedAt: 'T1', messageCount: 1 } },
    ])
    const after = new MetadataOplog(store)
    // Volatile-only drift across the restart must not re-record.
    expect(
      after.record('conversation', [
        { id: 'c1', value: { id: 'c1', title: 'hi', updatedAt: 'T9', messageCount: 42 } },
      ]),
    ).toEqual([])
    // Sessions/issues are unaffected by the projection: byte-level diff as before.
    expect(
      after.record('session', [{ id: 's1', value: { id: 's1', updatedAt: 'T1' } }]),
    ).toHaveLength(1)
    expect(
      after.record('session', [{ id: 's1', value: { id: 's1', updatedAt: 'T2' } }]),
    ).toHaveLength(1)
  })

  it('rebuilds its diff baseline from the log across a restart', () => {
    const store = new SessionStore(':memory:')
    const before = new MetadataOplog(store)
    before.record('issue', [issue('a', 1), issue('b', 1)])
    const cursor = before.cursor()

    // "Restart": a fresh instance over the same store. Recording the post-restart
    // truth (a edited, b gone) must emit exactly that difference — not re-upsert
    // the unchanged world, and not silently rebase past the offline gap.
    const after = new MetadataOplog(store)
    const changes = after.record('issue', [issue('a', 2)])
    expect(changes.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'remove'],
    ])
    // And an unchanged truth emits nothing.
    expect(after.record('issue', [issue('a', 2)])).toEqual([])
    expect(after.changesSince(cursor)?.map((c) => [c.id, c.op])).toEqual([
      ['a', 'upsert'],
      ['b', 'remove'],
    ])
  })
})
