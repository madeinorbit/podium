/**
 * A transaction's entity writes, private until publish. Ordinary updates retain
 * only changed keys; snapshots own a complete replacement instead. Neither path
 * copies or mutates the published map while staging.
 */
export class ChangedKeyDraft<T> {
  private readonly changes = new Map<string, T | undefined>()
  // A remove followed by an upsert must reinsert the key at the end, just as
  // applying the feed operations to a Map in order would.
  private readonly removed = new Set<string>()

  constructor(private readonly replacement?: Map<string, T>) {}

  set(key: string, value: T): void {
    if (this.replacement !== undefined) this.replacement.set(key, value)
    else this.changes.set(key, value)
  }

  delete(key: string): void {
    if (this.replacement !== undefined) {
      this.replacement.delete(key)
      return
    }
    this.removed.add(key)
    this.changes.delete(key)
    this.changes.set(key, undefined)
  }

  /** Full enumeration is needed only when replacing/deleting the entire slice. */
  *values(base: ReadonlyMap<string, T>): IterableIterator<T> {
    if (this.replacement !== undefined) {
      yield* this.replacement.values()
      return
    }
    for (const [key, value] of base) {
      if (this.removed.has(key)) continue
      yield this.changes.get(key) ?? value
    }
    for (const [key, value] of this.changes) {
      if (value !== undefined && (this.removed.has(key) || !base.has(key))) yield value
    }
  }

  /** Called by the adapter's existing publication hook, after prepare/commit. */
  publish(base: Map<string, T>): Map<string, T> {
    if (this.replacement !== undefined) return this.replacement
    for (const key of this.removed) base.delete(key)
    for (const [key, value] of this.changes) {
      if (value !== undefined) base.set(key, value)
    }
    return base
  }
}
