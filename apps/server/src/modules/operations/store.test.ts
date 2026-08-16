import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import { runDrizzleMigrations } from '../../migrations'
import { OperationStore, type PersistedOperation } from './store'

/** A real database over the real migration chain — the operations table has to
 *  come from the committed migration, not from DDL a test invented. */
function store(): OperationStore {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  return new OperationStore(db)
}

const op = (over: Partial<PersistedOperation> = {}): PersistedOperation => ({
  id: 'op_1',
  kind: 'test',
  exclusionGroup: 'lifecycle',
  state: 'running',
  createdAt: 1000,
  updatedAt: 1000,
  steps: [{ id: 'first', state: 'running' }],
  ...over,
})

describe('OperationStore round-trip', () => {
  it('returns what it was given, parsed', () => {
    const s = store()
    s.insert(op())
    const row = s.get('op_1')
    expect(row?.state).toBe('running')
    expect(row?.operation?.steps?.[0].id).toBe('first')
    expect(row?.finishedAt).toBeNull()
  })

  it('keeps a field it does not know across a write it did not originate', () => {
    // The successor-server case: this binary re-persists an operation carrying
    // a field only a newer one understands. Dropping it here would corrupt the
    // newer server's state the moment an older one touched the row.
    const s = store()
    s.insert({ ...op(), aFieldAddedNextYear: 'keep me' } as PersistedOperation)
    const read = s.get('op_1')?.operation as Record<string, unknown>
    s.update({ ...(read as unknown as PersistedOperation), updatedAt: 2000 })
    expect((s.get('op_1')?.operation as Record<string, unknown>).aFieldAddedNextYear).toBe('keep me')
  })

  it('serves the stored bytes verbatim alongside the parse', () => {
    const s = store()
    s.insert(op())
    expect(JSON.parse(s.get('op_1')?.payload ?? '{}').kind).toBe('test')
  })

  it('mirrors the terminal stamp into its column', () => {
    const s = store()
    s.insert(op())
    s.update({ ...op(), state: 'done', updatedAt: 5000, finishedAt: 5000 })
    expect(s.get('op_1')).toMatchObject({ state: 'done', finishedAt: 5000, updatedAt: 5000 })
  })

  it('stays readable through its columns when the payload is not parseable here', () => {
    // A state from a server newer than this binary. Single-flight must still
    // hold, which is the reason `state` is a column at all.
    const s = store()
    s.insert(op())
    ;(s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare('UPDATE operations SET payload = ? WHERE id = ?')
      .run('{"id":"op_1","kind":"test","state":"quiescing"}', 'op_1')
    const row = s.get('op_1')
    expect(row?.operation).toBeNull()
    expect(row?.state).toBe('running')
    expect(s.activeByGroup('lifecycle')?.id).toBe('op_1')
  })
})

describe('activeByGroup is single-flight’s question', () => {
  it('finds the live operation in the group', () => {
    const s = store()
    s.insert(op())
    expect(s.activeByGroup('lifecycle')?.id).toBe('op_1')
  })

  it('answers nothing once the operation reaches an outcome', () => {
    for (const terminal of ['done', 'failed', 'canceled']) {
      const s = store()
      s.insert(op({ state: terminal }))
      expect(s.activeByGroup('lifecycle')).toBeUndefined()
    }
  })

  it('holds for every non-terminal state, waiting included', () => {
    for (const live of ['pending', 'running', 'waiting']) {
      const s = store()
      s.insert(op({ state: live }))
      expect(s.activeByGroup('lifecycle')?.state).toBe(live)
    }
  })

  it('does not let one group block another', () => {
    const s = store()
    s.insert(op())
    s.insert(op({ id: 'op_2', exclusionGroup: 'reindex' }))
    expect(s.activeByGroup('reindex')?.id).toBe('op_2')
  })

  it('prefers the newest when history and a live operation share a group', () => {
    const s = store()
    s.insert(op({ id: 'old', state: 'done', createdAt: 1, updatedAt: 1, finishedAt: 1 }))
    s.insert(op({ id: 'new', createdAt: 9, updatedAt: 9 }))
    expect(s.activeByGroup('lifecycle')?.id).toBe('new')
  })
})

describe('history and retention', () => {
  const many = (s: OperationStore, count: number, kind = 'test') => {
    for (let i = 0; i < count; i++) {
      const id = kind === 'test' ? `op_${i}` : `${kind}_${i}`
      s.insert(op({ id, kind, state: 'done', createdAt: i, updatedAt: i, finishedAt: i }))
    }
  }

  it('lists newest first, capped', () => {
    const s = store()
    many(s, 5)
    expect(s.history('test', 3).map((r) => r.id)).toEqual(['op_4', 'op_3', 'op_2'])
  })

  it('scopes to a kind, and lists across kinds when asked for none', () => {
    const s = store()
    many(s, 2)
    s.insert(op({ id: 'move', kind: 'server-move', state: 'done', createdAt: 7, updatedAt: 7 }))
    expect(s.history('server-move').map((r) => r.id)).toEqual(['move'])
    expect(s.history().length).toBe(3)
  })

  it('defaults to twenty, the retention the spec fixes', () => {
    const s = store()
    many(s, 25)
    expect(s.history('test').length).toBe(20)
  })

  it('sweeps down to the newest twenty and says how many went', () => {
    const s = store()
    many(s, 25)
    expect(s.sweepRetention('test')).toBe(5)
    expect(s.history('test', 100).map((r) => r.id)).toContain('op_24')
    expect(s.get('op_0')).toBeUndefined()
    expect(s.history('test', 100).length).toBe(20)
  })

  it('never sweeps a live operation, however old', () => {
    const s = store()
    s.insert(op({ id: 'ancient', state: 'running', createdAt: -1, updatedAt: -1 }))
    many(s, 25)
    s.sweepRetention('test')
    expect(s.get('ancient')).toBeDefined()
    expect(s.activeByGroup('lifecycle')?.id).toBe('ancient')
  })

  it('leaves the history of another kind alone', () => {
    const s = store()
    many(s, 25)
    many(s, 3, 'server-move')
    s.sweepRetention('test')
    expect(s.history('server-move', 100).length).toBe(3)
  })
})
