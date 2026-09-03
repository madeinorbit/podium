import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '../../migrations'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import { createBunStoreExecutor } from '../../store/executor'
import { OperationStore, type PersistedOperation } from './store'

/** A real database over the real migration chain — the operations table has to
 *  come from the committed migration, not from DDL a test invented. */
function store(): OperationStore {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  return new OperationStore(createBunStoreExecutor({ database: db }))
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
  it('returns what it was given, parsed', async () => {
    const s = store()
    await s.insert(op())
    const row = await s.get('op_1')
    expect(row?.state).toBe('running')
    expect(row?.operation?.steps?.[0]?.id).toBe('first')
    expect(row?.finishedAt).toBeNull()
  })

  it('keeps a field it does not know across a write it did not originate', async () => {
    // The successor-server case: this binary re-persists an operation carrying
    // a field only a newer one understands. Dropping it here would corrupt the
    // newer server's state the moment an older one touched the row.
    const s = store()
    await s.insert({ ...op(), aFieldAddedNextYear: 'keep me' } as PersistedOperation)
    const read = (await s.get('op_1'))?.operation as Record<string, unknown>
    await s.update({ ...(read as unknown as PersistedOperation), updatedAt: 2000 })
    expect(((await s.get('op_1'))?.operation as Record<string, unknown>).aFieldAddedNextYear).toBe(
      'keep me',
    )
  })

  it('serves the stored bytes verbatim alongside the parse', async () => {
    const s = store()
    await s.insert(op())
    expect(JSON.parse((await s.get('op_1'))?.payload ?? '{}').kind).toBe('test')
  })

  it('mirrors the terminal stamp into its column', async () => {
    const s = store()
    await s.insert(op())
    await s.update({ ...op(), state: 'done', updatedAt: 5000, finishedAt: 5000 })
    expect(await s.get('op_1')).toMatchObject({ state: 'done', finishedAt: 5000, updatedAt: 5000 })
  })

  it('stays readable through its columns when the payload is not parseable here', async () => {
    // A state from a server newer than this binary. Single-flight must still
    // hold, which is the reason `state` is a column at all.
    const s = store()
    await s.insert(op())
    ;(s as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare('UPDATE operations SET payload = ? WHERE id = ?')
      .run('{"id":"op_1","kind":"test","state":"quiescing"}', 'op_1')
    const row = await s.get('op_1')
    expect(row?.operation).toBeNull()
    expect(row?.state).toBe('running')
    expect((await s.activeByGroup('lifecycle'))?.id).toBe('op_1')
  })
})

describe('activeByGroup is single-flight’s question', () => {
  it('finds the live operation in the group', async () => {
    const s = store()
    await s.insert(op())
    expect((await s.activeByGroup('lifecycle'))?.id).toBe('op_1')
  })

  it('answers nothing once the operation reaches an outcome', async () => {
    for (const terminal of ['done', 'failed', 'canceled'] as const) {
      const s = store()
      await s.insert(op({ state: terminal }))
      expect(await s.activeByGroup('lifecycle')).toBeUndefined()
    }
  })

  it('holds for every non-terminal state, waiting included', async () => {
    for (const live of ['pending', 'running', 'waiting'] as const) {
      const s = store()
      await s.insert(op({ state: live }))
      expect((await s.activeByGroup('lifecycle'))?.state).toBe(live)
    }
  })

  it('does not let one group block another', async () => {
    const s = store()
    await s.insert(op())
    await s.insert(op({ id: 'op_2', exclusionGroup: 'reindex' }))
    expect((await s.activeByGroup('reindex'))?.id).toBe('op_2')
  })

  it('prefers the newest when history and a live operation share a group', async () => {
    const s = store()
    await s.insert(op({ id: 'old', state: 'done', createdAt: 1, updatedAt: 1, finishedAt: 1 }))
    await s.insert(op({ id: 'new', createdAt: 9, updatedAt: 9 }))
    expect((await s.activeByGroup('lifecycle'))?.id).toBe('new')
  })
})

describe('history and retention', () => {
  const many = async (s: OperationStore, count: number, kind = 'test') => {
    for (let i = 0; i < count; i++) {
      const id = kind === 'test' ? `op_${i}` : `${kind}_${i}`
      await s.insert(op({ id, kind, state: 'done', createdAt: i, updatedAt: i, finishedAt: i }))
    }
  }

  it('lists newest first, capped', async () => {
    const s = store()
    await many(s, 5)
    expect((await s.history('test', 3)).map((r) => r.id)).toEqual(['op_4', 'op_3', 'op_2'])
  })

  it('scopes to a kind, and lists across kinds when asked for none', async () => {
    const s = store()
    await many(s, 2)
    await s.insert(
      op({ id: 'move', kind: 'server-move', state: 'done', createdAt: 7, updatedAt: 7 }),
    )
    expect((await s.history('server-move')).map((r) => r.id)).toEqual(['move'])
    expect((await s.history()).length).toBe(3)
  })

  it('defaults to twenty, the retention the spec fixes', async () => {
    const s = store()
    await many(s, 25)
    expect((await s.history('test')).length).toBe(20)
  })

  it('sweeps down to the newest twenty and says how many went', async () => {
    const s = store()
    await many(s, 25)
    expect(await s.sweepRetention('test')).toBe(5)
    expect((await s.history('test', 100)).map((r) => r.id)).toContain('op_24')
    expect(await s.get('op_0')).toBeUndefined()
    expect((await s.history('test', 100)).length).toBe(20)
  })

  it('never sweeps a live operation, however old', async () => {
    const s = store()
    await s.insert(op({ id: 'ancient', state: 'running', createdAt: -1, updatedAt: -1 }))
    await many(s, 25)
    await s.sweepRetention('test')
    expect(await s.get('ancient')).toBeDefined()
    expect((await s.activeByGroup('lifecycle'))?.id).toBe('ancient')
  })

  it('leaves the history of another kind alone', async () => {
    const s = store()
    await many(s, 25)
    await many(s, 3, 'server-move')
    await s.sweepRetention('test')
    expect((await s.history('server-move', 100)).length).toBe(3)
  })
})
