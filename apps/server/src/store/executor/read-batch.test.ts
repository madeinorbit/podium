import { afterEach, describe, expect, it } from 'vitest'
import { testStoreEngine } from '../../test-support/pg-test-database'
import { type Harness, openEngineHarness } from './harness'
import { withReadBatch } from './read-batch'

const opened: Harness[] = []
const open = async () => {
  const harness = await openEngineHarness()
  opened.push(harness)
  return harness
}
const insert =
  testStoreEngine() === 'pg'
    ? 'INSERT INTO notes (body) VALUES ($1)'
    : 'INSERT INTO notes (body) VALUES (?)'
const batches = (h: Harness) => h.log.entries.filter((entry) => entry.includes(':BATCH['))

afterEach(async () => {
  for (const h of opened.splice(0)) await h.close()
})

describe('explicit independent read batches', () => {
  it('keeps decoded results and order while sending concurrent reads together', async () => {
    const h = await open()
    const values = await withReadBatch(
      async () => await Promise.all([h.db.get('SELECT 1 AS value'), h.db.all('SELECT 2 AS value')]),
    )
    expect(values).toEqual([{ value: 1 }, [{ value: 2 }]])
    expect(batches(h)).toHaveLength(1)
    expect(batches(h)[0]).toContain('BATCH[2]')
    h.log.clear()
    await Promise.all([h.db.get('SELECT 1 AS value'), h.db.get('SELECT 2 AS value')])
    expect(batches(h)).toHaveLength(0)
  })

  it('keeps sequential dependencies and ends at the explicit callback boundary', async () => {
    const h = await open()
    await withReadBatch(async () => {
      const first = await Promise.all([
        h.db.get('SELECT 1 AS value'),
        h.db.get('SELECT 2 AS value'),
      ])
      expect(first).toEqual([{ value: 1 }, { value: 2 }])
      await Promise.all([h.db.get('SELECT 3 AS value'), h.db.get('SELECT 4 AS value')])
    })
    expect(batches(h)).toHaveLength(2)
    h.log.clear()
    await h.db.get('SELECT 5 AS value')
    expect(batches(h)).toHaveLength(0)
  })

  it('never combines stores or nested transaction frames', async () => {
    const a = await open()
    const b = await open()
    await withReadBatch(
      async () =>
        await Promise.all([
          a.db.get('SELECT 1 AS value'),
          a.db.get('SELECT 2 AS value'),
          b.db.get('SELECT 3 AS value'),
          b.db.get('SELECT 4 AS value'),
        ]),
    )
    expect(batches(a)).toHaveLength(1)
    expect(batches(b)).toHaveLength(1)
    a.log.clear()
    await a.executor.transact(async (tx) => {
      await withReadBatch(async () => {
        await Promise.all([tx.drizzle.get('SELECT 1 AS value'), a.db.get('SELECT 2 AS value')])
        await tx.transact(async (nested) => {
          await Promise.all([
            nested.drizzle.get('SELECT 3 AS value'),
            a.db.get('SELECT 4 AS value'),
          ])
        })
        await Promise.all([tx.drizzle.get('SELECT 5 AS value'), a.db.get('SELECT 6 AS value')])
      })
    })
    expect(batches(a)).toHaveLength(3)
  })

  it('recovers a failed read batch without aborting the enclosing write', async () => {
    const h = await open()
    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'before')
      const results = await withReadBatch(
        async () =>
          await Promise.allSettled([
            tx.drizzle.get('SELECT 1 AS value'),
            tx.drizzle.all('SELECT * FROM missing_read_batch_table'),
          ]),
      )
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
      await tx.drizzle.run(insert, 'after')
    })
    expect(await h.db.all('SELECT body FROM notes ORDER BY id')).toEqual([
      { body: 'before' },
      { body: 'after' },
    ])
  })

  it('refuses writes, including RETURNING and explicit batches, before they execute', async () => {
    const h = await open()
    const writes: (() => Promise<unknown>)[] = [
      () => h.db.run(insert, 'refused'),
      () => h.db.writeAll(`${insert} RETURNING body`, 'refused'),
      () =>
        h.db.batch([
          { sql: insert, params: ['refused'], intent: 'write' as const, method: 'run' as const },
        ]),
    ]
    for (const write of writes) {
      await expect(withReadBatch(write)).rejects.toThrow('independent reads only')
    }
    expect(await h.db.all('SELECT body FROM notes')).toEqual([])
    await h.db.run(insert, 'accepted')
    expect(await h.db.all('SELECT body FROM notes')).toEqual([{ body: 'accepted' }])
  })
})
