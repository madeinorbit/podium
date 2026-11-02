/**
 * THE CACHE INTERFACE [POD-6150, design §4, server-data "Caching"].
 *
 * The default is no cache. When a fresh measurement shows one is needed, it is
 * built here and nowhere else: never an ad hoc `Map` in a repository or service.
 *
 * ONE INTERFACE, TWO LAYERS.
 *   - {@link Cache} is what callers use: async `get`, `getMany`, `set`, `delete`.
 *     Async so a networked implementation (Redis, for several server processes
 *     or tenants) fits without touching callers.
 *   - {@link CacheBackend} is where the entries live. {@link LruCacheBackend}
 *     (`lru.ts`) is the in-process one, with a required entry limit. A Redis
 *     backend implements the same interface (see "A second writer" below).
 *
 * DECLARED. Every cache is declared once ({@link declareCache}): its name, what
 * it holds, its key, its entry limit, the tables whose committed writes remove
 * its entries, and the writers it assumes. The declarations form one registry
 * ({@link declaredCaches}) so a test or a reader can list every cache there is.
 *
 * REMOVED KEY BY KEY, AFTER COMMIT. {@link openCache} subscribes the cache to
 * each declared table's {@link CommittedRows}. A committed write hands its rows
 * to the declaration's key function and exactly those keys are removed, inside
 * the commit application (mechanism 1 of `executor/post-commit.ts`): after the
 * COMMIT, in the same turn, before the writer's `transact` resolves. There is
 * no "clear": a write never throws the whole cache away. So every write of an
 * invalidating table must go through that table's `CommittedRows.write`; a
 * write some other way is invisible here, and the declaration's test
 * ({@link expectWriteEvicts} in `test-support/cache.ts`) is what proves the
 * writes that matter are covered.
 *
 * NEVER READ INSIDE A SAVE. `get`/`getMany`/`set` throw while a write span is
 * open (`spanOpen()`): a save reads the database, which shows the save's own
 * uncommitted rows; a cache cannot. {@link readThrough} is the safe way in: it
 * goes straight to the database when a span is open, and uses the cache
 * otherwise.
 *
 * NO STALE FILL. A miss reads the database and then fills the cache. A write
 * that commits between that read and the fill would leave the old row cached
 * after its own eviction ran. So a fill carries a {@link CacheMark} taken BEFORE
 * the read, and the backend refuses it when the key was removed after the mark.
 * A refused fill costs one more database read later, never a wrong answer.
 *
 * PLAIN DATA. Values are plain serializable data: primitives, arrays and plain
 * objects, no class instances (Date, Map, Set), functions, cycles or shared
 * references. A development build checks every `set` ({@link assertPlainData});
 * the in-process backend stores a frozen copy, so no caller can change what
 * another caller is handed.
 *
 * A SECOND WRITER. The in-process backend is memory of one process, so its
 * after-commit eviction is correct only while this process is the only writer
 * of the invalidating tables (the same assumption as `WrittenColumns`,
 * server-data "Caching" rule 7). Each declaration states it in `writers`.
 * Before a second writer exists (another server process, a Postgres
 * deployment), the cache must move to a shared backend that EVERY writer
 * invalidates: a Redis backend deletes the keys from each writer's commit (as a
 * durable follow-up, since a commit application cannot await a network call)
 * and implements the mark as a per-key version or lease, so a fill that raced
 * a delete on any process is refused.
 */

import { spanOpen } from '../executor/executor'
import type { CommittedRowChange, CommittedRows } from '../committed-rows'

/** Taken before a database read; a fill made with it is refused if the key was removed since. */
export type CacheMark = number & { readonly __cacheMark: unique symbol }

/**
 * What a cache holds: plain serializable data. Not a type constraint (row
 * interfaces have no index signature); development builds check it at runtime
 * with {@link assertPlainData}.
 */
export type CacheValue =
  | null
  | boolean
  | number
  | string
  | readonly CacheValue[]
  | { readonly [key: string]: CacheValue | undefined }

export interface CacheDeclaration {
  /** Unique across the server, `<owner>.<what>`, e.g. `users.earliest-admin`. */
  readonly name: string
  /** What one entry holds, in words. */
  readonly holds: string
  /** The key's shape, in words. */
  readonly key: string
  /** Entry limit; the least recently used entry is dropped first. Required. */
  readonly limit: number
  /** The tables whose committed writes remove entries, one binding each in {@link openCache}. */
  readonly invalidatedBy: readonly string[]
  /** The writers this cache assumes (see "A second writer" in the file header). */
  readonly writers: string
  /** Why the cache exists: the measurement that showed the need. */
  readonly measured: string
}

/** The storage seam: the in-process LRU now, a shared store (Redis) later. */
export interface CacheBackend<V> {
  get(key: string): Promise<V | undefined>
  getMany(keys: readonly string[]): Promise<Map<string, V>>
  /** Store `value` unless `key` was removed after `mark`; answers whether it was stored. */
  set(key: string, value: V, mark: CacheMark): Promise<boolean>
  delete(keys: readonly string[]): Promise<void>
  mark(): Promise<CacheMark>
  /**
   * Remove `keys` from inside a commit application, which cannot await: the
   * keys must be unreadable before this returns. A networked backend cannot do
   * that and must evict from every writer instead (file header).
   */
  evictCommitted(keys: readonly string[]): void
}

export interface Cache<K extends string, V> {
  readonly declaration: CacheDeclaration
  /** Throws inside an open write span. */
  get(key: K): Promise<V | undefined>
  /** The keys found; a key absent from the map is a miss. Throws inside an open write span. */
  getMany(keys: Iterable<K>): Promise<Map<K, V>>
  /** Take BEFORE the database read whose result {@link set} stores. */
  mark(): Promise<CacheMark>
  /** Fill one entry read at `mark`; refused (false) if the key was removed since. Throws inside a span. */
  set(key: K, value: V, mark: CacheMark): Promise<boolean>
  /** Remove one key or several. Never the whole cache. */
  delete(keys: K | Iterable<K>): Promise<void>
}

/** A cache opened on one store: unsubscribe with {@link OpenedCache.close}. */
export interface OpenedCache<K extends string, V> extends Cache<K, V> {
  close(): void
}

/** One invalidating table: its committed writes and the keys each write removes. */
export interface CacheInvalidation<K extends string> {
  readonly table: string
  subscribe(evict: (keys: Iterable<K>) => void): () => void
}

/**
 * Bind a declared table to the keys its committed writes remove. `keys` gets
 * the committed rows (RETURNING) and names every key they affect; a write whose
 * rows cannot name their keys must name every key it might affect, never "all".
 */
export function invalidateOn<K extends string, Row>(
  table: string,
  rows: CommittedRows<Row>,
  keys: (change: CommittedRowChange<Row>) => Iterable<K>,
): CacheInvalidation<K> {
  return {
    table,
    subscribe: (evict) => rows.subscribe((change) => evict(keys(change))),
  }
}

const declarations = new Map<string, CacheDeclaration>()

/** Declare a cache once, at module level. Refuses a duplicate name or a missing limit. */
export function declareCache(declaration: CacheDeclaration): CacheDeclaration {
  const { name, limit, invalidatedBy } = declaration
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(name)) {
    throw new Error(`cache name "${name}" must read <owner>.<what>, lower-case`)
  }
  if (declarations.has(name)) throw new Error(`cache "${name}" is declared twice`)
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`cache "${name}" needs a positive integer entry limit`)
  if (invalidatedBy.length === 0 || new Set(invalidatedBy).size !== invalidatedBy.length) {
    throw new Error(`cache "${name}" must name each invalidating table once`)
  }
  for (const field of ['holds', 'key', 'writers', 'measured'] as const) {
    if (declaration[field].trim() === '') throw new Error(`cache "${name}" must state ${field}`)
  }
  const frozen = Object.freeze({ ...declaration, invalidatedBy: Object.freeze([...invalidatedBy]) })
  declarations.set(name, frozen)
  return frozen
}

/** Every declared cache, in declaration order. */
export function declaredCaches(): readonly CacheDeclaration[] {
  return [...declarations.values()]
}

/**
 * Open a declared cache for one store: one {@link invalidateOn} binding per
 * declared table, no more and no fewer. Each committed write of a bound table
 * removes the keys it names, after the commit.
 */
export function openCache<K extends string, V>(
  declaration: CacheDeclaration,
  invalidations: readonly CacheInvalidation<K>[],
  backend: CacheBackend<V>,
): OpenedCache<K, V> {
  if (declarations.get(declaration.name) !== declaration) {
    throw new Error(`cache "${declaration.name}" is not declared (declareCache)`)
  }
  const bound = invalidations.map((binding) => binding.table).sort()
  const declared = [...declaration.invalidatedBy].sort()
  if (bound.length !== declared.length || bound.some((table, at) => table !== declared[at])) {
    throw new Error(
      `cache "${declaration.name}" declares invalidating tables [${declared.join(', ')}] ` +
        `but was opened with [${bound.join(', ')}]`,
    )
  }
  const unsubscribe = invalidations.map((binding) =>
    binding.subscribe((keys) => {
      const distinct = [...new Set(keys)]
      if (distinct.length > 0) backend.evictCommitted(distinct)
    }),
  )
  const guard = (what: string): void => {
    if (spanOpen()) {
      throw new Error(
        `cache "${declaration.name}": ${what} inside an open write span. A save reads the database ` +
          '(server-data "Caching" rule 5); use readThrough, which does.',
      )
    }
  }
  return {
    declaration,
    async get(key) {
      guard('get')
      return await backend.get(key)
    },
    async getMany(keys) {
      guard('getMany')
      return (await backend.getMany([...new Set(keys)])) as Map<K, V>
    },
    async mark() {
      return await backend.mark()
    },
    async set(key, value, mark) {
      guard('set')
      if (checkPlainData) assertPlainData(value, `cache "${declaration.name}" key "${key}"`)
      return await backend.set(key, value, mark)
    },
    async delete(keys) {
      await backend.delete(typeof keys === 'string' ? [keys] : [...new Set(keys)])
    },
    close() {
      for (const stop of unsubscribe) stop()
    },
  }
}

/**
 * Read keys through a cache: hits from the cache, misses from `load` (one
 * call, the misses only), and the misses filled with a mark taken before the
 * load. Inside an open write span the cache is not touched and every key is
 * read from the database. A key `load` does not find is not cached.
 */
export async function readThrough<K extends string, V>(
  cache: Cache<K, V>,
  keys: Iterable<K>,
  load: (misses: readonly K[]) => Promise<ReadonlyMap<K, V>>,
): Promise<Map<K, V>> {
  const distinct = [...new Set(keys)]
  if (spanOpen()) return new Map(await load(distinct))
  const found = await cache.getMany(distinct)
  const misses = distinct.filter((key) => !found.has(key))
  if (misses.length === 0) return found
  const mark = await cache.mark()
  const loaded = await load(misses)
  for (const key of misses) {
    const value = loaded.get(key)
    if (value === undefined) continue
    found.set(key, value)
    // The span may have opened while the load awaited (a caller's continuation
    // never does, but a misuse would): never fill from inside one.
    if (!spanOpen()) await cache.set(key, value, mark)
  }
  return found
}

/**
 * Development builds check every cached value. `PODIUM_APP_VERSION` must stay a
 * literal `process.env` read: the release build bakes it (see `features.ts`),
 * so a released server skips the walk.
 */
const checkPlainData = (process.env.PODIUM_APP_VERSION ?? 'dev') === 'dev'

/**
 * Throw unless `value` is plain serializable data: null, booleans, finite
 * numbers, strings, arrays and plain objects (own enumerable string keys,
 * `Object.prototype` or null prototype), with no object reached twice.
 * An `undefined` property is allowed (it reads the same after a JSON round trip).
 */
export function assertPlainData(value: unknown, where: string): void {
  const seen = new Set<object>()
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error(`${where}: ${path} is ${node}, not serializable`)
      return
    }
    if (typeof node !== 'object') throw new Error(`${where}: ${path} is a ${typeof node}, not plain data`)
    if (seen.has(node)) throw new Error(`${where}: ${path} is a shared reference; cache plain copies`)
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((item, at) => {
        if (item === undefined) throw new Error(`${where}: ${path}[${at}] is undefined`)
        walk(item, `${path}[${at}]`)
      })
      return
    }
    const proto = Object.getPrototypeOf(node)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${where}: ${path} is a ${proto?.constructor?.name ?? 'class'} instance, not plain data`)
    }
    if (Object.getOwnPropertySymbols(node).length > 0) throw new Error(`${where}: ${path} has symbol keys`)
    for (const [key, item] of Object.entries(node)) {
      if (item !== undefined) walk(item, `${path}.${key}`)
    }
  }
  walk(value, 'value')
}
