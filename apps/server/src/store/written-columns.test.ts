/**
 * WHEN THE STORE MAY TRUST WHAT IT KNOWS ABOUT A ROW [POD-6234]: the rules in
 * `written-columns.ts`, one at a time. The session parity suite
 * (`session-upsert-changed-columns.test.ts`) shows the stored result; this
 * shows the orderings a database cannot be made to produce on demand, where a
 * read returns after the row it read was written or forgotten.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { WrittenColumns } from './written-columns'

let db: SqlDatabase
let span: <T>(fn: () => Promise<T>) => Promise<T>
let known: WrittenColumns<string>

beforeEach(() => {
  db = openMigratedTestDatabase()
  const queries = createBunStoreExecutor({ database: db }).queries
  if (!queries) throw new Error('the synchronous query capability is absent on this handle')
  span = queries.createOrJoinTransaction
  known = new WrittenColumns<string>('test:written-columns')
})

afterEach(() => db.close())

const inSpan = (id: string) => span(async () => known.get(id))

describe('WrittenColumns', () => {
  it('knows a committed write, and nothing with no span open', async () => {
    await span(async () => known.wrote('a', 'v1'))
    expect(await inSpan('a')).toBe('v1')
    expect(known.get('a')).toBeUndefined()
  })

  it('forgets a write whose span rolled back', async () => {
    await span(async () => known.wrote('a', 'v1'))
    await expect(
      span(async () => {
        known.wrote('a', 'v2')
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    expect(await inSpan('a')).toBeUndefined()
  })

  it('records a read with no span open when nothing moved since its mark', async () => {
    const mark = known.mark
    known.read([['a', 'stored']], mark)
    expect(await inSpan('a')).toBe('stored')
  })

  it('drops a read overtaken by a write, a forget or a promotion', async () => {
    let mark = known.mark
    await span(async () => known.wrote('a', 'v1'))
    known.read([['a', 'stale']], mark)
    expect(await inSpan('a')).toBe('v1')

    mark = known.mark
    known.forget('b')
    known.read([['a', 'stale']], mark)
    expect(await inSpan('a')).toBe('v1')
  })

  it('drops a read made inside a span or while another writer runs', async () => {
    await span(async () => known.read([['a', 'own write']], known.mark))
    expect(await inSpan('a')).toBeUndefined()

    await known.aside(['b'], async () => known.read([['a', 'mid write']], known.mark))
    expect(await inSpan('a')).toBeUndefined()
  })

  it('answers unknown while another writer runs, and forgets what it touched', async () => {
    await span(async () => {
      known.wrote('a', 'v1')
      known.wrote('b', 'v1')
    })
    await known.aside(['a'], async () => {
      expect(await inSpan('b')).toBeUndefined()
    })
    expect(await inSpan('a')).toBeUndefined()
    expect(await inSpan('b')).toBe('v1')
    await known.aside('all', async () => {})
    expect(await inSpan('b')).toBeUndefined()
  })
})
