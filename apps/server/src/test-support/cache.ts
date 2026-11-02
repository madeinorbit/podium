/**
 * The test every declared cache needs [POD-6150, server-data "Caching" rule 3]:
 * a committed write removes exactly the entries it changed.
 *
 * `expectWriteEvicts(cache, write, { evicts, keeps })` fills every named key
 * (with the value the caller gives, so the test owns what was cached), runs
 * `write` as production runs it, and asserts after it resolved that each
 * `evicts` key is gone and each `keeps` key still holds its value. Name at least
 * one `keeps` key whenever the cache can hold more than one entry, so a write
 * that empties the whole cache fails.
 *
 * Shown armed: a write that evicts nothing fails, and so does one that evicts
 * a `keeps` key (`store/cache/cache.test.ts`).
 */
import { expect } from 'vitest'
import type { Cache } from '../store/cache/cache'

export interface WriteEvicts<K extends string, V> {
  /** Keys the write must remove, each filled with its value first. */
  readonly evicts: ReadonlyMap<K, V> | readonly (readonly [K, V])[]
  /** Keys the write must leave, each filled with its value first. */
  readonly keeps?: ReadonlyMap<K, V> | readonly (readonly [K, V])[]
}

export async function expectWriteEvicts<K extends string, V>(
  cache: Cache<K, V>,
  write: () => Promise<unknown>,
  { evicts, keeps = [] }: WriteEvicts<K, V>,
): Promise<void> {
  const evicted = new Map(evicts)
  const kept = new Map(keeps)
  if (evicted.size === 0) throw new Error('expectWriteEvicts: name at least one key the write removes')
  const mark = await cache.mark()
  for (const [key, value] of [...evicted, ...kept]) {
    expect(await cache.set(key, value, mark), `fill "${key}" before the write`).toBe(true)
  }
  await write()
  const after = await cache.getMany([...evicted.keys(), ...kept.keys()])
  const stillHeld = [...evicted.keys()].filter((key) => after.has(key))
  const lost = [...kept.keys()].filter((key) => !after.has(key))
  expect(
    { stillHeld, lost },
    `cache "${cache.declaration.name}": the write must remove exactly [${[...evicted.keys()].join(', ')}]`,
  ).toEqual({ stillHeld: [], lost: [] })
  for (const [key, value] of kept) expect(after.get(key)).toEqual(value)
}
