import { asMutationId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncRepository } from './adapters/sqlite/sync-repository'
import {
  createTestSyncDatabase,
  createTestSyncQueries,
  createTestSyncRepository,
  createTestTransact,
  testSyncServerTables,
} from './adapters/sqlite/test-support'
import { CHANGE_KEEP_ROWS, CHANGE_MAX_AGE_MS, minAvailableSeq } from './change-log'
import { testLedgerWriter } from './conformance/ledger-writer'
import { ModelRecords } from './conformance/model-records'
import { type EntityChangeSpec, entityOverlayKey, Ledger, prepareLedgerBoot } from './ledger'

const spec = (id: string, value: unknown): EntityChangeSpec => ({
  entity: 'issueProjection',
  id,
  op: 'upsert',
  value,
})
function fixture() {
  const repo = createTestSyncRepository()
  const records = new ModelRecords()
  const ledger = new Ledger({ repo, records, now: () => 1_000, transact: (fn) => fn() })
  const writer = testLedgerWriter(ledger)
  const save = async (rows: EntityChangeSpec[]) =>
    await writer.commit({
      write: async () => records.set(rows.map(({ id, ...row }) => ({ ...row, entityId: id }))),
    })
  return { repo, records, ledger, writer, save }
}

afterEach(() => vi.restoreAllMocks())

describe('ledger facade', () => {
  it('uses a collision-free entity and id key', () => {
    expect(entityOverlayKey('session', 'a')).toBe('session\u0000a')
    expect(entityOverlayKey('session', 'a:b')).not.toBe(entityOverlayKey('session:a', 'b'))
  })

  it('returns the write result and whole records, skipping unchanged values', async () => {
    const f = fixture()
    const first = await f.writer.commit({
      write: async () => {
        f.records.set([{ entity: 'issueProjection', entityId: 'a', op: 'upsert', value: 1 }])
        return 42
      },
    })
    expect(first.result).toBe(42)
    expect(first.changes).toEqual([
      { seq: 1, entity: 'issueProjection', id: 'a', op: 'upsert', value: 1 },
    ])
    expect((await f.save([spec('a', 1)])).changes).toEqual([])
    expect((await f.save([spec('a', 2), spec('b', 3)])).changes.map((row) => row.seq)).toEqual([
      2, 3,
    ])
    expect(
      (await f.save([{ entity: 'issueProjection', id: 'b', op: 'remove' }])).changes,
    ).toMatchObject([{ seq: 4, op: 'remove' }])
  })

  it('notifies only changed batches and respects unsubscribe', async () => {
    const f = fixture()
    const seen = vi.fn()
    const off = f.ledger.onAppended(seen)
    await f.save([spec('a', 1)])
    await f.save([spec('a', 1)])
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    await f.save([spec('a', 2)])
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('serves retained deltas and refuses missing, future and pruned cursors', async () => {
    const f = fixture()
    expect(await f.ledger.changesSince(null)).toBeNull()
    await f.save([spec('a', 1)])
    await f.save([spec('a', 2)])
    expect((await f.ledger.changesSince(1))?.map((row) => row.seq)).toEqual([2])
    expect(await f.ledger.changesSince(3)).toBeNull()
    await f.repo.pruneChangeBatch({ thresholdSeq: 1 })
    expect(await f.ledger.changesSince(0)).toBeNull()
    expect(await f.ledger.changesSince(1)).toHaveLength(1)
    await f.repo.pruneChangeBatch({ thresholdSeq: 2 })
    expect(await minAvailableSeq(f.repo)).toBe(3)
    expect(await f.ledger.changesSince(2)).toEqual([])
  })

  it('uses 30 days and 500,000 rows when preparing boot retention', async () => {
    const f = fixture()
    expect(CHANGE_KEEP_ROWS).toBe(500_000)
    expect(CHANGE_MAX_AGE_MS).toBe(30 * 86_400_000)
    const plan = vi.spyOn(f.repo, 'planChangePrune')
    await prepareLedgerBoot({ repo: f.repo, now: () => 100 })
    expect(plan).toHaveBeenCalledExactlyOnceWith({
      keepRows: 500_000,
      maxAgeMs: 30 * 86_400_000,
      now: 100,
    })
  })

  it('passes the ambient provenance through the facade', async () => {
    const repo = createTestSyncRepository()
    const records = new ModelRecords()
    const ledger = new Ledger({
      repo,
      records,
      now: () => 1_000,
      transact: (fn) => fn(),
      provenance: { current: () => ({ mutationId: asMutationId('m'), causationId: 'c' }) },
    })
    await testLedgerWriter(ledger).commit({
      write: async () => {
        const { id, ...row } = spec('a', 1)
        records.set([{ ...row, entityId: id }])
      },
    })
    expect(await repo.changesSince(0)).toMatchObject([{ mutationId: 'm', causationId: 'c' }])
  })

  it('runs a commit application even when no record changed', async () => {
    const f = fixture()
    const apply = vi.fn()
    await f.writer.commit({ write: async () => 42, apply })
    expect(apply).toHaveBeenCalledExactlyOnceWith(42, [])
  })
})

describe('source write and append atomicity', () => {
  it('rolls back source rows when appending fails, and permits an exact retry', async () => {
    const db = createTestSyncDatabase()
    try {
      db.exec('CREATE TABLE test_models (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const repo = new SyncRepository(createTestSyncQueries(db), testSyncServerTables)
      const records = new ModelRecords()
      const get = db.prepare('SELECT value FROM test_models WHERE id = ?')
      records.build = async (_kind, ids) =>
        ids.flatMap((id) => {
          const row = get.get(id) as { value: string } | null
          return row ? [{ id, value: JSON.parse(row.value) }] : []
        })
      const ledger = new Ledger({
        repo,
        records,
        now: () => 1_000,
        transact: createTestTransact(db),
      })
      const writer = testLedgerWriter(ledger)
      const commit = () =>
        writer.commit({
          write: async () => {
            db.prepare('INSERT INTO test_models VALUES (?, ?)').run('a', '1')
            // What the table's capture trigger would record (POD-6920).
            records.capture('issueProjection', 'a')
          },
        })
      const append = vi
        .spyOn(repo, 'appendChanges')
        .mockRejectedValueOnce(new Error('append failed'))
      await expect(commit()).rejects.toThrow('append failed')
      expect(get.get('a') ?? null).toBeNull()
      expect(await repo.maxChangeSeq()).toBe(0)
      append.mockRestore()
      expect((await commit()).changes).toHaveLength(1)
      expect(await repo.maxChangeSeq()).toBe(1)
    } finally {
      db.close()
    }
  })
})
