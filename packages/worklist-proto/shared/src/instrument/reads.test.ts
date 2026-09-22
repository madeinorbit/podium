/**
 * POD-4557 — the reads fence counts every door, and refuses the bypasses it
 * can see. Each counting rule has a case that would read 0 if the rule were
 * deleted.
 */
import { describe, expect, it } from 'vitest'
import type { RowSource } from '../arm'
import type { RowRecord, RowSourceEvent } from '../stats'
import { createReadFence, DISABLED_READ_FENCE, type RelationReader } from './reads'

function sessionRow(id: string, issueId = 'i1'): RowRecord {
  return { kind: 'session', id, value: { sessionId: id, issueId, lastActiveAt: '2026-09-22T00:00:00Z' } as never }
}

function staticSource(rows: RowRecord[]): RowSource & { emit(event: RowSourceEvent): void } {
  const listeners = new Set<(event: RowSourceEvent) => void>()
  return {
    snapshot: (kind) => rows.filter((row) => row.kind === kind),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event) {
      for (const listener of listeners) listener(event)
    },
  }
}

/** Borrow `n` session rows through the fence's feed door, as a pool would. */
function borrowedSessions(fence: ReturnType<typeof createReadFence>, n: number): Map<string, unknown> {
  const rows = Array.from({ length: n }, (_, index) => sessionRow(`s${index}`))
  const source = fence.wrapSource(staticSource(rows))
  const table = new Map<string, unknown>()
  for (const record of source.snapshot('session')) table.set(record.id, record.value)
  fence.reset()
  return table
}

describe('feed door', () => {
  it('counts a field read on a borrowed row, once per distinct row', () => {
    const fence = createReadFence({ enabled: true })
    const table = borrowedSessions(fence, 3)
    const row = table.get('s1') as { issueId: string; lastActiveAt: string }
    void row.issueId
    void row.lastActiveAt
    expect(fence.stats().rows).toBe(1)
    expect(fence.stats().accesses.field).toBe(2)
    expect(fence.stats().byEntity).toEqual({ session: 1 })
  })

  it('counts spreading and key enumeration as a read', () => {
    const fence = createReadFence({ enabled: true })
    const table = borrowedSessions(fence, 2)
    void { ...(table.get('s0') as object) }
    void Object.keys(table.get('s1') as object)
    expect(fence.stats().rows).toBe(2)
  })

  it('hands the SAME proxy for the same raw row, and refuses writes', () => {
    const fence = createReadFence({ enabled: true })
    const raw = sessionRow('s0')
    const source = fence.wrapSource(staticSource([raw]))
    const a = source.snapshot('session')[0]!.value
    const b = source.snapshot('session')[0]!.value
    expect(a).toBe(b)
    expect(fence.isBorrowed(a)).toBe(true)
    expect(() => {
      ;(a as { issueId: string }).issueId = 'x'
    }).toThrow(/read-only/)
  })

  it('borrows rows delivered by events and passes deletes through', () => {
    const fence = createReadFence({ enabled: true })
    const inner = staticSource([])
    const events: RowSourceEvent[] = []
    fence.wrapSource(inner).subscribe((event) => events.push(event))
    inner.emit({ type: 'update', rows: [sessionRow('s9'), { kind: 'session', id: 's8', value: undefined }] })
    expect(fence.isBorrowed(events[0]!.rows[0]!.value)).toBe(true)
    expect(events[0]!.rows[1]!.value).toBeUndefined()
  })
})

describe('table door', () => {
  it('counts get and has by id', () => {
    const fence = createReadFence({ enabled: true })
    const { session } = fence.wrapTables({ session: borrowedSessions(fence, 5) })
    session.get('s1')
    session.has('s2')
    session.get('missing')
    expect(fence.stats().rows).toBe(3)
    expect(fence.stats().accesses.get).toBe(3)
  })

  it('counts EVERY element of EVERY kind of iteration', () => {
    for (const walk of [
      (t: ReadonlyMap<string, unknown>) => [...t.values()],
      (t: ReadonlyMap<string, unknown>) => [...t.keys()],
      (t: ReadonlyMap<string, unknown>) => [...t.entries()],
      (t: ReadonlyMap<string, unknown>) => [...t],
      (t: ReadonlyMap<string, unknown>) => t.forEach(() => undefined),
    ]) {
      const fence = createReadFence({ enabled: true })
      const { session } = fence.wrapTables({ session: borrowedSessions(fence, 40) })
      walk(session)
      expect(fence.stats().rows).toBe(40)
      expect(fence.stats().accesses.iterate).toBe(40)
    }
  })

  it('does not count size', () => {
    const fence = createReadFence({ enabled: true })
    const { session } = fence.wrapTables({ session: borrowedSessions(fence, 4) })
    expect(session.size).toBe(4)
    expect(fence.stats().rows).toBe(0)
  })

  it('counts every element an array method visits', () => {
    const fence = createReadFence({ enabled: true })
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    const { issue } = fence.wrapTables({ issue: rows }, { borrowed: false })
    expect(issue.find((row) => (row as { id: string }).id === 'b')).toBe(rows[1])
    expect(fence.stats().rows).toBe(2)
    issue.filter(() => true)
    expect(fence.stats().rows).toBe(4)
    expect(Array.isArray(issue)).toBe(true)
  })

  it('returns one wrapper per raw table, so identity memos still hit', () => {
    const fence = createReadFence({ enabled: true })
    const raw = borrowedSessions(fence, 1)
    expect(fence.wrapTables({ session: raw }).session).toBe(fence.wrapTables({ session: raw }).session)
  })

  it('THROWS when a table holds a row the feed did not hand out (a copy)', () => {
    const fence = createReadFence({ enabled: true })
    const copies = new Map<string, unknown>([['s0', { sessionId: 's0' }]])
    const { session } = fence.wrapTables({ session: copies })
    expect(() => session.get('s0')).toThrow(/did not hand out/)
    expect(() => [...session.values()]).toThrow(/did not hand out/)
  })

  it('THROWS on any member that is not a counted ReadonlyMap read', () => {
    const fence = createReadFence({ enabled: true })
    const { session } = fence.wrapTables({ session: borrowedSessions(fence, 1) })
    expect(() => (session as unknown as { set: unknown }).set).toThrow(/no counted member set/)
    expect(() => (session as unknown as { toJSON: unknown }).toJSON).toThrow(/no counted member/)
  })
})

describe('violations are sticky', () => {
  it('stats() re-throws a violation even when the throw itself was swallowed, and reset keeps it', () => {
    const fence = createReadFence({ enabled: true })
    const { session } = fence.wrapTables({ session: new Map<string, unknown>([['s0', { sessionId: 's0' }]]) })
    try {
      session.get('s0')
    } catch {
      // The feed's emit swallows listener errors exactly like this.
    }
    expect(() => fence.stats()).toThrow(/fence violated 1 time\(s\); first: .*did not hand out/)
    fence.reset()
    expect(() => fence.stats()).toThrow(/fence violated/)
  })
})

describe('relation door', () => {
  const reader: RelationReader = {
    one: (_from, _id, relation) => (relation === 'parent' ? 'i0' : null),
    many: () => ['s1', 's2', 's3'],
    size: () => 3,
  }

  it('counts the target of a single relation, and every member of a collection', () => {
    const fence = createReadFence({ enabled: true })
    const relations = fence.wrapRelations(reader)
    expect(relations.one('issue', 'i1', 'parent')).toBe('i0')
    expect(relations.one('issue', 'i1', 'worktree')).toBeNull()
    expect(fence.stats().byEntity).toEqual({ issue: 1 })
    expect([...relations.many('issue', 'i1', 'sessions')]).toEqual(['s1', 's2', 's3'])
    expect(fence.stats().byEntity).toEqual({ issue: 1, session: 3 })
    expect(relations.size('issue', 'i1', 'sessions')).toBe(3)
    expect(fence.stats().rows).toBe(4)
  })

  it('THROWS on a relation the schema does not declare', () => {
    const relations = createReadFence({ enabled: true }).wrapRelations(reader)
    expect(() => relations.one('issue', 'i1', 'origin')).toThrow(/not a declared relation/)
    expect(() => relations.size('session', 's1', 'children')).toThrow(/not a declared relation/)
  })
})

describe('per change', () => {
  it('reset starts the next change from zero', () => {
    const fence = createReadFence({ enabled: true })
    const { session } = fence.wrapTables({ session: borrowedSessions(fence, 10) })
    ;[...session.values()]
    expect(fence.stats().rows).toBe(10)
    fence.reset()
    expect(fence.stats()).toEqual({
      rows: 0,
      byEntity: {},
      accesses: { get: 0, iterate: 0, relation: 0, field: 0 },
      sample: [],
    })
    session.get('s3')
    expect(fence.stats().rows).toBe(1)
  })
})

describe('disabled (timing runs)', () => {
  it('is the identity on every door, and stats() THROWS rather than report zero', () => {
    const raw = new Map<string, unknown>([['s0', { sessionId: 's0' }]])
    const source = staticSource([sessionRow('s0')])
    const reader: RelationReader = { one: () => null, many: () => [], size: () => 0 }
    expect(DISABLED_READ_FENCE.wrapTables({ session: raw }).session).toBe(raw)
    expect(DISABLED_READ_FENCE.wrapSource(source)).toBe(source)
    expect(DISABLED_READ_FENCE.wrapRelations(reader)).toBe(reader)
    expect(() => DISABLED_READ_FENCE.stats()).toThrow(/disabled/)
  })
})

// ------------------------------------------------------------------ POD-4563
// The copy sweep: a planted copy outside the wrapped tables fails, the same
// pool without the copy passes, and a sweep that cannot reach the pool fails.

describe('copy sweep', () => {
  function pool(fence: ReturnType<typeof createReadFence>) {
    const sessions = borrowedSessions(fence, 3)
    const tables = fence.wrapTables({ session: sessions })
    return { sessions, tables }
  }

  it('passes a pool that stores the borrowed rows, with derived row-view objects beside it', () => {
    const fence = createReadFence({ enabled: true })
    const handle = {
      pool: pool(fence),
      views: new Map([['i1', { id: 'i1', title: 'x', seq: 1, working: true }]]),
      buckets: new Map([['i1', new Set(['s0', 's1'])]]),
    }
    const sweep = fence.assertNoCopies(handle)
    expect(sweep.tables).toBeGreaterThan(0)
    expect(sweep.objects).toBeGreaterThan(3)
    // The sweep reads raw values only: it charges no row to the change.
    expect(fence.stats().rows).toBe(0)
  })

  it('PLANTED: fails on copies kept in a second, unwrapped container', () => {
    const fence = createReadFence({ enabled: true })
    const { sessions, tables } = pool(fence)
    const copies = new Map<string, object>()
    for (const [id, row] of sessions) copies.set(id, { ...(row as object) })
    expect(() => fence.assertNoCopies({ pool: { sessions, tables }, copies })).toThrow(
      /\[copies\] the arm holds copies of fed rows outside its wrapped tables: sessionId=s\d/,
    )
    // Sticky, like every other violation.
    expect(() => fence.stats()).toThrow(/fence violated/)
  })

  it('PLANTED: finds a copy behind a symbol-keyed admin object (the MobX layout)', () => {
    const fence = createReadFence({ enabled: true })
    const { sessions, tables } = pool(fence)
    const admin = Symbol('admin')
    const model = { [admin]: { values: new Map([['value', { ...(sessions.get('s2') as object) }]]) } }
    expect(() => fence.assertNoCopies({ tables, models: [model] })).toThrow(/sessionId=s2/)
  })

  it('fails when the walk reaches no wrapped table: silence would be blindness', () => {
    const fence = createReadFence({ enabled: true })
    pool(fence)
    expect(() => fence.assertNoCopies({ unrelated: new Map() })).toThrow(/reached none of the arm's wrapped tables/)
  })

  it('refuses to run with the fence disabled', () => {
    expect(() => DISABLED_READ_FENCE.assertNoCopies({})).toThrow(/disabled/)
  })
})
