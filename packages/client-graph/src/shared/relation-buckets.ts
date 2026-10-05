import { observable } from 'mobx'

const EMPTY: readonly string[] = Object.freeze([])

/** Shared forward links and inverse membership for screen sources. Updates
 * touch only the buckets a member entered or left; unchanged buckets keep
 * their array identity. Call mutations inside the source publication action. */
export class RelationBuckets {
  private readonly forwards: Map<string, readonly string[]>
  private readonly buckets = observable.map<string, readonly string[]>(undefined, { deep: false })

  constructor(private readonly options: { trackedForward?: boolean; sorted?: boolean } = {}) {
    this.forwards = options.trackedForward
      ? observable.map<string, readonly string[]>(undefined, { deep: false })
      : new Map()
  }

  move(address: string, member: string, targets: readonly string[], bucket: (target: string) => string): void {
    const previous = this.forwards.get(address) ?? EMPTY
    if (previous.length === targets.length && previous.every((target, index) => target === targets[index])) return
    for (const target of previous) {
      if (targets.includes(target)) continue
      const key = bucket(target), rest = this.many(key).filter(id => id !== member)
      if (rest.length) this.buckets.set(key, rest)
      else this.buckets.delete(key)
    }
    for (const target of targets) {
      if (previous.includes(target)) continue
      const key = bucket(target), next = [...this.many(key), member]
      if (this.options.sorted) next.sort()
      this.buckets.set(key, next)
    }
    if (targets.length) this.forwards.set(address, [...targets])
    else this.forwards.delete(address)
  }

  one(address: string): string | undefined { return this.forwards.get(address)?.[0] }
  many(key: string): readonly string[] { return this.buckets.get(key) ?? EMPTY }
  clear(): void { this.forwards.clear(); this.buckets.clear() }
}
