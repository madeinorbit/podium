/**
 * PER-OPERATION LOADERS [POD-6149, server-data rule 2].
 *
 * Many call sites inside one operation each ask for one row by id — the
 * GraphQL-resolver shape. Asking the database once per call makes the
 * statement count grow with the number of rows the operation touches. The
 * standard answer is the DataLoader pattern, and this is the standard package
 * (`dataloader`), not a home-grown one: loads asked for in the same tick are
 * collected into ONE `IN (…)` query, and an id already loaded is answered from
 * the loader for the rest of the operation.
 *
 * SCOPED TO ONE OPERATION THROUGH THE READ SCOPE. Each loader lives in a
 * {@link readScopeSlot}, so an operation that opens `withReadScope` gets its
 * own DataLoader and nothing is reused by the next operation. A load outside an
 * explicit scope gets a fresh one-read scope, so it batches nothing and reuses
 * nothing: unscoped reads stay live, exactly as `read-scope.ts` promises. This
 * is a one-operation memo, not a cache (server-data "Caching" rule 1).
 *
 * WRITES INVALIDATE. A repository calls {@link OperationLoader.invalidate} from
 * every write of the rows it loads. That moves the loader's version, and the
 * next load in ANY open scope starts a new DataLoader, so a read after a write
 * in the same operation sees the write. A load already in flight when the write
 * happened still resolves for its caller, who asked before the write.
 */

import DataLoader from 'dataloader'
import { currentReadScope, readScopeSlot } from './read-scope'

export interface OperationLoader<K, V> {
  /** One row by key, or `undefined` when none exists. Batched within a tick. */
  load(key: K): Promise<V | undefined>
  /** Several rows by key, in one batch with any other loads of this tick. */
  loadMany(keys: Iterable<K>): Promise<Map<K, V | undefined>>
  /** Forget every loaded row in every open scope. Call from each write. */
  invalidate(): void
}

export interface OperationLoaderOptions<V> {
  /**
   * Largest `IN (…)` list one batch sends. A larger tick is split into several
   * batches, so the statement count grows by one per `maxBatchSize` keys,
   * never by one per key. Default 500, under SQLite's bound-parameter limit.
   */
  readonly maxBatchSize?: number
  /**
   * Hand each caller its own copy of a shared row. A loader returns the same
   * object to every caller of the same key; when callers may mutate what they
   * get, pass a copy function so one caller cannot change another's answer.
   */
  readonly copy?: (value: V) => V
}

/**
 * Define a loader once, as a field of the repository that owns the rows.
 *
 * `batch` receives distinct keys and returns the rows it found keyed by the
 * same key; a key with no row is simply absent from the map.
 */
export function operationLoader<K, V>(
  batch: (keys: readonly K[]) => Promise<ReadonlyMap<K, V>>,
  options: OperationLoaderOptions<V> = {},
): OperationLoader<K, V> {
  let version = 0
  // The slot holds a mutable box: a slot's value is created once per scope, and
  // a write must be able to replace the loader inside a scope that stays open.
  const slot = readScopeSlot<{ version: number; loader: DataLoader<K, V | undefined> | null }>(
    () => ({ version, loader: null }),
  )
  const loader = (): DataLoader<K, V | undefined> => {
    const held = currentReadScope().slot(slot)
    if (held.loader !== null && held.version === version) return held.loader
    held.version = version
    held.loader = new DataLoader<K, V | undefined>(
      async (keys) => {
        const found = await batch(keys)
        return keys.map((key) => found.get(key))
      },
      { maxBatchSize: options.maxBatchSize ?? 500 },
    )
    return held.loader
  }
  const copy = options.copy ?? ((value: V) => value)
  const out = (value: V | undefined) => (value === undefined ? undefined : copy(value))
  return {
    async load(key) {
      return out(await loader().load(key))
    },
    async loadMany(keys) {
      const distinct = [...new Set(keys)]
      const values = await loader().loadMany(distinct)
      const result = new Map<K, V | undefined>()
      distinct.forEach((key, index) => {
        const value = values[index]
        if (value instanceof Error) throw value
        result.set(key, out(value))
      })
      return result
    },
    invalidate() {
      version += 1
    },
  }
}
