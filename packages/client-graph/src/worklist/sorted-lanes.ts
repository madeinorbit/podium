/** Ordered membership filed one identity at a time. Persistent answers retain
 * historical snapshots; moving a row changes tree paths, never the roster. */
import { createAtom, type IAtom, type ObservableMap, observable } from 'mobx'
import { debugName } from '../debug-name'
import { createKeyedAnswer, mapQueryResult, type KeyedAnswer } from '../query-result'

const EMPTY: readonly string[] = Object.freeze([])
interface Filed<K, S> { readonly key: K; readonly sort: S }
interface Member<S> { readonly id: string; readonly sort: S }
interface Lane<S> {
  readonly answer: KeyedAnswer<Member<S>>
  readonly atom: IAtom
  ids?: readonly string[]
}

export class SortedLanes<K, S> {
  private readonly lanes: ObservableMap<K, Lane<S>>
  private readonly filed = new Map<string, Filed<K, S>>()
  private readonly listeners = new Map<K, Set<(id: string | undefined) => void>>()
  constructor(
    private readonly compare: (a: S, b: S) => number,
    private readonly name: string,
    private readonly demand?: () => void,
  ) {
    this.lanes = observable.map(undefined, { deep: false, name: debugName(() => name) })
  }
  lane(key: K): readonly string[] {
    this.demand?.()
    const lane = this.lanes.get(key)
    if (!lane) return EMPTY
    lane.atom.reportObserved()
    return lane.ids ??= mapQueryResult(lane.answer.snapshot(), member => member.id)
  }
  keys(): IterableIterator<K> { this.demand?.(); return this.lanes.keys() }
  has(id: string): boolean { return this.filed.has(id) }
  hasIn(key: K, id: string): boolean { return this.filed.get(id)?.key === key }
  subscribe(key: K, changed: (id: string | undefined) => void): () => void {
    this.demand?.()
    let listeners = this.listeners.get(key)
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners) }
    listeners.add(changed)
    return () => { listeners.delete(changed); if (!listeners.size) this.listeners.delete(key) }
  }
  private changed(key: K, lane: Lane<S>, id: string) {
    lane.ids = undefined
    lane.atom.reportChanged()
    for (const changed of this.listeners.get(key) ?? []) changed(id)
  }
  /** Returns 0 for an unchanged position, 1 for one lane, 2 for a group move. */
  file(id: string, key: K | undefined, sort: S | undefined): number {
    const before = this.filed.get(id)
    if (key === undefined || sort === undefined) {
      if (!before) return 0
      this.filed.delete(id)
      this.takeOut(id, before)
      return 1
    }
    const member = { id, sort }
    if (before?.key === key) {
      const lane = this.lanes.get(key)!
      const old = lane.answer.get(id)!
      const prev = lane.answer.before(old, id), next = lane.answer.after(old, id)
      const fits = (!prev || this.compare(prev.sort, sort) < 0) && (!next || this.compare(sort, next.sort) < 0)
      this.filed.set(id, { key, sort })
      lane.answer.set(id, '', member)
      if (fits) return 0
      this.changed(key, lane, id)
      return 1
    }
    this.filed.set(id, { key, sort })
    if (before) this.takeOut(id, before)
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { answer: createKeyedAnswer<Member<S>>((a, b) => this.compare(a.sort, b.sort)),
        atom: createAtom(debugName(() => `${this.name}.lane`) ?? 'Atom') }
      this.lanes.set(key, lane)
    }
    lane.answer.set(id, '', member)
    this.changed(key, lane, id)
    return before ? 2 : 1
  }
  private takeOut(id: string, before: Filed<K, S>) {
    const lane = this.lanes.get(before.key)!
    lane.answer.delete(id)
    if (!lane.answer.first()) this.lanes.delete(before.key)
    this.changed(before.key, lane, id)
  }
  clear(): void {
    this.lanes.clear(); this.filed.clear()
    for (const listeners of [...this.listeners.values()]) for (const changed of [...listeners]) changed(undefined)
  }
}
