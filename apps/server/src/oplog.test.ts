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
    store.pruneChanges({ keepRows: 1, maxAgeMs: 0, now: Date.now() + 1 })
    expect(oplog.changesSince(0)).toBeNull() // seq 1-2 pruned away -> gap
    expect(oplog.changesSince(2)?.map((c) => c.seq)).toEqual([3]) // still contiguous
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
