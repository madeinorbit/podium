/**
 * The cache layer [POD-6150] against a real store executor: the LRU bound, the
 * declaration registry, per-key eviction after commit (not before, not on a
 * rollback), the span guard, the stale-fill guard, plain data, and the
 * `expectWriteEvicts` helper shown armed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { expectWriteEvicts } from '../../test-support/cache'
import { CommittedRows } from '../committed-rows'
import {
  assertPlainData, type CacheDeclaration, declareCache, declaredCaches, invalidateOn, openCache, type OpenedCache,
  readThrough,
} from './cache'
import { LruCacheBackend } from './lru'

type Row = { readonly id: string; readonly group: string }

let declared = 0
const declaration = (overrides: Partial<CacheDeclaration> = {}): CacheDeclaration =>
  declareCache({
    name: `test.cache-${++declared}`,
    holds: 'a test row by id',
    key: 'row id',
    limit: 4,
    invalidatedBy: ['rows'],
    writers: 'this test is the only writer',
    measured: 'none: a unit test',
    ...overrides,
  })

describe('cache layer', () => {
  let store: SessionStore
  let rows: CommittedRows<Row>
  let backend: LruCacheBackend<string>
  let cache: OpenedCache<string, string>
  const write = async (...ids: string[]) =>
    await rows.write(async () => ids.map((id) => ({ id, group: 'g' })), 'upsert')

  beforeEach(async () => {
    store = await openTestStore()
    rows = new CommittedRows<Row>(async (fn) => await store.transact(fn), 'rows')
    backend = new LruCacheBackend<string>(4)
    cache = openCache(declaration(), [invalidateOn('rows', rows, (change) => change.rows.map((row) => row.id))], backend)
  })
  afterEach(async () => {
    cache.close()
    await store.close()
  })

  describe('LRU', () => {
    it('never holds more than its limit, dropping the least recently used', async () => {
      const lru = new LruCacheBackend<number>(8)
      const mark = await lru.mark()
      for (let at = 0; at < 1000; at++) {
        await lru.set(`k${at % 50}`, at, mark)
        expect(lru.size).toBeLessThanOrEqual(8)
        // k0 is read after every write, so it is never the least recently used.
        if (at > 0) await lru.get('k0')
      }
      expect(lru.size).toBe(8)
      expect(await lru.get('k0')).toBeDefined()
      expect(await lru.get('k1')).toBeUndefined()
    })

    it('refuses an entry limit that is not a positive integer', () => {
      expect(() => new LruCacheBackend(0)).toThrow(/positive integer/)
      expect(() => new LruCacheBackend(1.5)).toThrow(/positive integer/)
    })

    it('stores a frozen copy, never the caller\'s object', async () => {
      const lru = new LruCacheBackend<{ list: number[] }>(2)
      const value = { list: [1] }
      await lru.set('a', value, await lru.mark())
      value.list.push(2)
      const held = await lru.get('a')
      expect(held).toEqual({ list: [1] })
      expect(Object.isFrozen(held) && Object.isFrozen(held!.list)).toBe(true)
      expect(() => held!.list.push(3)).toThrow()
    })
  })

  describe('declarations', () => {
    it('lists every declared cache and refuses a duplicate, a missing limit or an unstated field', () => {
      const one = declaration()
      expect(declaredCaches()).toContain(one)
      expect(() => declareCache({ ...one })).toThrow(/declared twice/)
      expect(() => declaration({ limit: 0 })).toThrow(/entry limit/)
      expect(() => declaration({ invalidatedBy: [] })).toThrow(/invalidating table/)
      expect(() => declaration({ writers: ' ' })).toThrow(/writers/)
      expect(() => declaration({ name: 'NoOwner' })).toThrow(/<owner>\.<what>/)
    })

    it('opens only with one binding per declared table', () => {
      const two = declaration({ invalidatedBy: ['rows', 'others'] })
      const binding = invalidateOn('rows', rows, (change) => change.rows.map((row) => row.id))
      expect(() => openCache(two, [binding], new LruCacheBackend(2))).toThrow(/declares invalidating tables/)
      const undeclared = { ...two, name: 'test.undeclared' }
      expect(() => openCache(undeclared, [binding], new LruCacheBackend(2))).toThrow(/not declared/)
    })
  })

  describe('invalidation after commit', () => {
    it('removes exactly the keys a committed write names and keeps the others', async () => {
      await expectWriteEvicts(cache, async () => await write('a', 'b'), {
        evicts: [['a', 'A'], ['b', 'B']],
        keeps: [['c', 'C'], ['d', 'D']],
      })
    })

    it('removes nothing before the commit and nothing on a rollback', async () => {
      const mark = await cache.mark()
      await cache.set('a', 'A', mark)
      await store.transact(async () => {
        await write('a')
        // Still held until the commit: the span reads the database, never this.
        expect(await backend.get('a')).toBe('A')
      })
      expect(await cache.get('a')).toBeUndefined()

      await cache.set('b', 'B', await cache.mark())
      await expect(store.transact(async () => {
        await write('b')
        throw new Error('roll back')
      })).rejects.toThrow('roll back')
      expect(await cache.get('b')).toBe('B')
    })

    it('stops evicting once closed', async () => {
      await cache.set('a', 'A', await cache.mark())
      cache.close()
      await write('a')
      expect(await backend.get('a')).toBe('A')
    })
  })

  describe('never read inside a save', () => {
    it('get, getMany and set throw inside an open write span, and work outside it', async () => {
      await cache.set('a', 'A', await cache.mark())
      // Armed: the same calls succeed with no span open.
      expect(await cache.get('a')).toBe('A')
      expect(await cache.getMany(['a'])).toEqual(new Map([['a', 'A']]))
      await store.transact(async () => {
        await expect(cache.get('a')).rejects.toThrow(/inside an open write span/)
        await expect(cache.getMany(['a'])).rejects.toThrow(/inside an open write span/)
        await expect(cache.set('a', 'A2', await cache.mark())).rejects.toThrow(/inside an open write span/)
        // Removing is always allowed.
        await cache.delete('a')
      })
      expect(await cache.get('a')).toBeUndefined()
    })

    it('readThrough reads the database inside a span and leaves the cache alone', async () => {
      await cache.set('a', 'cached', await cache.mark())
      const loads: string[][] = []
      const load = async (keys: readonly string[]) => {
        loads.push([...keys])
        return new Map(keys.map((key) => [key, `db:${key}`] as const))
      }
      const inSpan = await store.transact(async () => await readThrough(cache, ['a', 'b'], load))
      expect(inSpan).toEqual(new Map([['a', 'db:a'], ['b', 'db:b']]))
      expect(await backend.get('b')).toBeUndefined()

      const outside = await readThrough(cache, ['a', 'b'], load)
      expect(outside).toEqual(new Map([['a', 'cached'], ['b', 'db:b']]))
      expect(loads).toEqual([['a', 'b'], ['b']])
      expect(await readThrough(cache, ['a', 'b'], load)).toEqual(outside)
      expect(loads).toHaveLength(2)
    })
  })

  describe('no stale fill', () => {
    it('refuses a fill read before a write that committed before the fill', async () => {
      const mark = await cache.mark()
      await write('a')
      expect(await cache.set('a', 'read before the write', mark)).toBe(false)
      expect(await cache.get('a')).toBeUndefined()
      // Another key, untouched by the write, still fills with the same mark.
      expect(await cache.set('b', 'B', mark)).toBe(true)
    })

    it('readThrough does not cache what it read when a write commits during its load', async () => {
      const value = await readThrough(cache, ['a'], async () => {
        await write('a')
        return new Map([['a', 'old']])
      })
      expect(value.get('a')).toBe('old')
      expect(await cache.get('a')).toBeUndefined()
    })

    it('still refuses once the removal log has dropped the key, by refusing every older mark', async () => {
      const mark = await cache.mark()
      // The log holds `limit` (4) removals; five more push the first one out.
      await write('a')
      for (const id of ['p', 'q', 'r', 's', 't']) await write(id)
      expect(await cache.set('a', 'stale', mark)).toBe(false)
      expect(await cache.set('z', 'refused too: its mark predates a dropped record', mark)).toBe(false)
      expect(await cache.set('a', 'fresh', await cache.mark())).toBe(true)
    })
  })

  describe('plain data', () => {
    it('accepts primitives, arrays and plain objects', () => {
      expect(() => assertPlainData({ a: 1, b: ['x', null, true], c: { d: undefined } }, 't')).not.toThrow()
    })

    it.each([
      ['a Date', { at: new Date(0) }, /Date instance/],
      ['a Map', new Map(), /Map instance/],
      ['a class instance', new (class Live {})(), /Live instance/],
      ['a function', { f: () => 1 }, /function/],
      ['NaN', { n: Number.NaN }, /NaN/],
      ['a bigint', { n: 1n }, /bigint/],
    ])('refuses %s', (_, value, message) => {
      expect(() => assertPlainData(value, 't')).toThrow(message)
    })

    it('refuses a shared reference and a cycle', () => {
      const shared = { x: 1 }
      expect(() => assertPlainData({ a: shared, b: shared }, 't')).toThrow(/shared reference/)
      const cycle: Record<string, unknown> = {}
      cycle.self = cycle
      expect(() => assertPlainData(cycle, 't')).toThrow(/shared reference/)
    })

    it('is checked on every set in a development build', async () => {
      const objects = openCache<string, never>(declaration(), [invalidateOn('rows', rows, () => [])], new LruCacheBackend(2))
      await expect(objects.set('a', new Date(0) as never, await objects.mark())).rejects.toThrow(/Date instance/)
      objects.close()
    })
  })

  describe('expectWriteEvicts is armed', () => {
    it('fails when the write removes nothing', async () => {
      await expect(expectWriteEvicts(cache, async () => {}, { evicts: [['a', 'A']] })).rejects.toThrow(
        /must remove exactly/,
      )
    })

    it('fails when the write removes a key it must keep', async () => {
      await expect(
        expectWriteEvicts(cache, async () => await write('a', 'c'), { evicts: [['a', 'A']], keeps: [['c', 'C']] }),
      ).rejects.toThrow(/must remove exactly/)
    })
  })
})
