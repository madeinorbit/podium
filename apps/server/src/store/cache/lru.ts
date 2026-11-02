/**
 * THE IN-PROCESS CACHE BACKEND: a least-recently-used map with a required
 * entry limit [POD-6150]. The repository had no LRU to reuse (the existing
 * bounded maps are insertion-ordered and private to their owners), and a
 * `Map`'s insertion order is all an LRU needs, so this adds no dependency.
 *
 * Values are stored as frozen deep copies and handed out as they are stored:
 * no caller shares a mutable object with the code that filled the entry or
 * with another caller (`cache.ts`, "Plain data").
 *
 * The fill guard ({@link CacheMark}): every removal moves `generation` and
 * records it against the key. A fill made with a mark older than the key's
 * last removal is refused. The removal log is bounded like the entries; when
 * its oldest record is dropped, every mark older than that record is refused
 * (`floor`), so dropping a record can only refuse more fills, never accept a
 * stale one.
 */

import type { CacheBackend, CacheMark } from './cache'

export class LruCacheBackend<V> implements CacheBackend<V> {
  private readonly entries = new Map<string, V>()
  private readonly removedAt = new Map<string, number>()
  private generation = 0
  private floor = 0

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('an LRU cache needs a positive integer entry limit')
  }

  /** Entries held now; never above {@link limit}. */
  get size(): number {
    return this.entries.size
  }

  async get(key: string): Promise<V | undefined> {
    return this.touch(key)
  }

  async getMany(keys: readonly string[]): Promise<Map<string, V>> {
    const found = new Map<string, V>()
    for (const key of keys) {
      const value = this.touch(key)
      if (value !== undefined) found.set(key, value)
    }
    return found
  }

  async mark(): Promise<CacheMark> {
    return this.generation as CacheMark
  }

  async set(key: string, value: V, mark: CacheMark): Promise<boolean> {
    if (mark < this.floor || (this.removedAt.get(key) ?? -1) > mark) return false
    this.entries.delete(key)
    this.entries.set(key, deepFreeze(structuredClone(value)))
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value as string)
    }
    return true
  }

  async delete(keys: readonly string[]): Promise<void> {
    this.evictCommitted(keys)
  }

  evictCommitted(keys: readonly string[]): void {
    for (const key of keys) {
      this.generation += 1
      this.entries.delete(key)
      this.removedAt.delete(key)
      this.removedAt.set(key, this.generation)
    }
    while (this.removedAt.size > this.limit) {
      const [oldest, at] = this.removedAt.entries().next().value as [string, number]
      this.removedAt.delete(oldest)
      this.floor = Math.max(this.floor, at)
    }
  }

  private touch(key: string): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    // Most recently used last: the eviction loop drops from the front.
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}
