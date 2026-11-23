/**
 * WHEN THE STORE MAY TRUST WHAT IT KNOWS ABOUT A ROW [POD-6234]: the rules in
 * `written-columns.ts`, one at a time. The session parity suite
 * (`session-upsert-changed-columns.test.ts`) shows the stored result; this
 * shows the orderings a database cannot be made to produce on demand, where a
 * read returns after the row it read was written or forgotten.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSliceStore, type SliceStore } from '../test-support/pg-slice-tables'
import { WrittenColumns } from './written-columns'

let slice: SliceStore
let span: <T>(fn: () => Promise<T>) => Promise<T>
let known: WrittenColumns<string>

// The spans are the run's engine's: SQLite on the store shard, Postgres on
// `server-store-pg` (POD-6983). The rules are the hint's own, so they hold on both.
beforeEach(async () => {
  slice = await openSliceStore()
  span = slice.queries.createOrJoinTransaction
  known = new WrittenColumns<string>('test:written-columns')
})

afterEach(async () => await slice.close())

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

describe('WrittenColumns on Postgres (POD-6983)', () => {
  it('is off: it knows no write or read, so every upsert sets every column', async () => {
    const off = WrittenColumns.forDialect<string>('pg', 'test:written-columns-off')
    await span(async () => off.wrote('a', 'v1'))
    expect(await span(async () => off.get('a'))).toBeUndefined()
    off.read([['b', 'stored']], off.mark)
    expect(await span(async () => off.get('b'))).toBeUndefined()
    await span(async () => {
      off.wrote('c', 'v1')
      expect(off.get('c')).toBeUndefined()
    })
  })

  it('is on for SQLite', async () => {
    const on = WrittenColumns.forDialect<string>('sqlite', 'test:written-columns-on')
    await span(async () => on.wrote('a', 'v1'))
    expect(await span(async () => on.get('a'))).toBe('v1')
  })
})
