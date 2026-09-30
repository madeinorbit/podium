/**
 * Ids filed by key, each key's ids kept in ORDER, maintained one id at a time.
 *
 * Filing an id moves that id only: out of its lane at its old place (binary
 * search), into its lane at its new place (binary search), with two splices.
 * No lane is ever re-sorted, and an id whose place is unchanged (its sort
 * value moved but not past a neighbour, or only a field the order ignores
 * changed) moves nothing, so its readers do not re-run. The worklist files
 * its visible order, its pinned section and each group's lanes here
 * (`visible.ts`, `groups.ts`), from the one filing reaction per issue.
 *
 * WHY NOT mobx-utils' `ObservableGroupMap`. It groups the items of ONE
 * observable array by key, with one reaction per item that it installs
 * itself and a symbol property written onto each item. The pool has no such
 * array (its items are the issues it holds, built on first read, filed by
 * their own reaction), its groups are unordered arrays with swap-remove
 * (every group here needs an order), removing an item from the base array
 * is a linear splice, and mobx-utils declares MobX 6 where the pool runs
 * MobX 7 (as `cached.ts` notes for `computedFn`).
 *
 * WHAT IS OBSERVABLE: each lane (an observable array of ids, shallow, in
 * order) and the lanes by key (an observable map: a lane appears with its
 * first id and goes with its last). What each id was filed under, its key
 * and its sort value, is a plain map read only by `file`, inside the action
 * that files: no derivation reads it. A reader sees the lanes alone, and a
 * value it needs about a member (its rank, its label) it reads from the
 * member itself, tracked.
 */

import { type IObservableArray, type ObservableMap, observable } from 'mobx'

const EMPTY: readonly string[] = Object.freeze([]) as readonly string[]

interface Filed<K, S> {
  readonly key: K
  readonly sort: S
}

export class SortedLanes<K, S> {
  private readonly lanes: ObservableMap<K, IObservableArray<string>>
  /** Each filed id's key and sort value (maintenance only: read by `file`, never by a derivation). */
  private readonly filed = new Map<string, Filed<K, S>>()

  /** `compare` must be total over the ids of one lane: two ids never compare equal. */
  constructor(
    private readonly compare: (a: S, b: S) => number,
    private readonly name: string,
  ) {
    this.lanes = observable.map<K, IObservableArray<string>>(undefined, { deep: false, name })
  }

  /** TRACKED: the ids filed under `key`, in order (a shared empty list when none). */
  lane(key: K): readonly string[] {
    return this.lanes.get(key) ?? EMPTY
  }

  /** TRACKED: the keys that hold at least one id. */
  keys(): IterableIterator<K> {
    return this.lanes.keys()
  }

  /** Whether `id` is filed (maintenance: plain). */
  has(id: string): boolean {
    return this.filed.has(id)
  }

  /**
   * File `id` under `key` at `sort`, or take it out (`key` undefined). Call
   * inside an action. Returns the lanes it changed: 0 when the id stays where
   * it is, 1 for a move inside one lane or an id entering or leaving, 2 for
   * a move from one lane to another.
   */
  file(id: string, key: K | undefined, sort: S | undefined): number {
    const before = this.filed.get(id)
    if (key === undefined || sort === undefined) {
      if (before === undefined) return 0
      this.takeOut(id, before)
      this.filed.delete(id)
      return 1
    }
    const after: Filed<K, S> = { key, sort }
    if (before !== undefined && before.key === key) {
      const lane = this.lanes.get(key) as IObservableArray<string>
      const at = this.placeOf(lane, id, before.sort)
      this.filed.set(id, after)
      if (this.fits(lane, at, sort)) return 0
      lane.splice(at, 1)
      lane.splice(this.insertionPoint(lane, sort), 0, id)
      return 1
    }
    if (before !== undefined) this.takeOut(id, before)
    let lane = this.lanes.get(key)
    if (lane === undefined) {
      lane = observable.array<string>([], { deep: false, name: `${this.name}.lane` })
      this.lanes.set(key, lane)
    }
    lane.splice(this.insertionPoint(lane, sort), 0, id)
    this.filed.set(id, after)
    return before === undefined ? 1 : 2
  }

  /** Empty every lane (the pool's dispose; call inside an action). */
  clear(): void {
    this.lanes.clear()
    this.filed.clear()
  }

  private sortOf(id: string): S {
    return (this.filed.get(id) as Filed<K, S>).sort
  }

  /** Remove `id` from the lane it was filed in; the lane goes with its last id. */
  private takeOut(id: string, before: Filed<K, S>): void {
    const lane = this.lanes.get(before.key) as IObservableArray<string>
    lane.splice(this.placeOf(lane, id, before.sort), 1)
    if (lane.length === 0) this.lanes.delete(before.key)
  }

  /** The index of `id`, filed at `sort`, in `lane`. */
  private placeOf(lane: IObservableArray<string>, id: string, sort: S): number {
    const at = this.insertionPoint(lane, sort)
    if (lane[at] !== id) throw new Error(`[pool] ${this.name}: ${id} is not where it was filed`)
    return at
  }

  /** The first index whose id does not sort before `sort` (binary search). */
  private insertionPoint(lane: IObservableArray<string>, sort: S): number {
    let lo = 0
    let hi = lane.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.compare(this.sortOf(lane[mid] as string), sort) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Whether the id at `at` stays in order with its neighbours at `sort`. */
  private fits(lane: IObservableArray<string>, at: number, sort: S): boolean {
    const prev = at > 0 ? (lane[at - 1] as string) : undefined
    const next = at + 1 < lane.length ? (lane[at + 1] as string) : undefined
    return (
      (prev === undefined || this.compare(this.sortOf(prev), sort) < 0) &&
      (next === undefined || this.compare(sort, this.sortOf(next)) < 0)
    )
  }
}
