import { describe, expect, it } from 'vitest'
import { operationLoader } from './operation-loader'
import { withReadScope } from './read-scope'

/** A loader over an in-memory table that records every batch it was asked for. */
const tableLoader = (rows: Record<string, { name: string }>) => {
  const batches: string[][] = []
  const loader = operationLoader<string, { name: string }>(async (keys) => {
    batches.push([...keys])
    return new Map(keys.flatMap((key) => (rows[key] ? [[key, { ...rows[key] }] as const] : [])))
  })
  return { loader, batches }
}

describe('operationLoader', () => {
  it('makes one query for several loads in the same tick', async () => {
    const { loader, batches } = tableLoader({ a: { name: 'A' }, b: { name: 'B' } })
    const found = await withReadScope(async () =>
      Promise.all([loader.load('a'), loader.load('b'), loader.load('missing'), loader.load('a')]),
    )
    expect(found).toEqual([{ name: 'A' }, { name: 'B' }, undefined, { name: 'A' }])
    expect(batches).toEqual([['a', 'b', 'missing']])
  })

  it('reuses loaded rows, absent ones included, for the rest of the operation', async () => {
    const { loader, batches } = tableLoader({ a: { name: 'A' } })
    await withReadScope(async () => {
      expect(await loader.load('a')).toEqual({ name: 'A' })
      expect(await loader.load('missing')).toBeUndefined()
      expect(await loader.load('a')).toEqual({ name: 'A' })
      expect(await loader.load('missing')).toBeUndefined()
      expect(await loader.loadMany(['a', 'missing'])).toEqual(
        new Map([
          ['a', { name: 'A' }],
          ['missing', undefined],
        ]),
      )
    })
    expect(batches).toEqual([['a'], ['missing']])
  })

  it('reuses nothing across operations, and nothing outside an explicit scope', async () => {
    const { loader, batches } = tableLoader({ a: { name: 'A' } })
    await withReadScope(async () => await loader.load('a'))
    await withReadScope(async () => await loader.load('a'))
    await loader.load('a')
    await loader.load('a')
    expect(batches).toEqual([['a'], ['a'], ['a'], ['a']])
  })

  it('joins an enclosing operation rather than starting its own', async () => {
    const { loader, batches } = tableLoader({ a: { name: 'A' } })
    await withReadScope(async () => {
      await loader.load('a')
      await withReadScope(async () => await loader.load('a'))
    })
    expect(batches).toEqual([['a']])
  })

  it('sees a write made inside the same operation', async () => {
    const rows: Record<string, { name: string }> = { a: { name: 'A' } }
    const { loader, batches } = tableLoader(rows)
    await withReadScope(async () => {
      expect(await loader.load('a')).toEqual({ name: 'A' })
      rows.a = { name: 'A2' }
      loader.invalidate()
      expect(await loader.load('a')).toEqual({ name: 'A2' })
    })
    expect(batches).toEqual([['a'], ['a']])
  })

  it('splits a large tick into batches of maxBatchSize, never one query per key', async () => {
    const batches: number[] = []
    const loader = operationLoader<number, number>(
      async (keys) => {
        batches.push(keys.length)
        return new Map(keys.map((key) => [key, key * 2]))
      },
      { maxBatchSize: 100 },
    )
    const keys = Array.from({ length: 250 }, (_, i) => i)
    const found = await withReadScope(async () => await loader.loadMany(keys))
    expect(found.get(249)).toBe(498)
    expect(batches).toEqual([100, 100, 50])
  })

  it('hands each caller its own copy when asked to', async () => {
    const loader = operationLoader<string, { name: string }>(
      async (keys) => new Map(keys.map((key) => [key, { name: key }])),
      { copy: (row) => ({ ...row }) },
    )
    await withReadScope(async () => {
      const first = await loader.load('a')
      first!.name = 'changed by one caller'
      expect(await loader.load('a')).toEqual({ name: 'a' })
    })
  })

  it('does not keep a failed batch: the next load asks again', async () => {
    let fail = true
    const loader = operationLoader<string, string>(async (keys) => {
      if (fail) throw new Error('database unavailable')
      return new Map(keys.map((key) => [key, key]))
    })
    await withReadScope(async () => {
      await expect(loader.load('a')).rejects.toThrow('database unavailable')
      fail = false
      expect(await loader.load('a')).toBe('a')
    })
  })
})
