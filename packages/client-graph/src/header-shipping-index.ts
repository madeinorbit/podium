import { type ObservableSet, observable } from 'mobx'
import { HEADER_SCHEMA, type HeaderRows } from './header-schema'
import { createKeyedAnswer, type KeyedAnswer } from './query-result'

type ShipOrder = HeaderRows['shipOrder']
interface Shipped {
  readonly id: string
  readonly changedAt: number
}
/** The shipping panel's history order: newest change first, then the order id. */
const newestFirst = (a: Shipped, b: Shipped): number =>
  b.changedAt - a.changedAt || a.id.localeCompare(b.id)
const NONE: ReadonlySet<string> = Object.freeze(new Set<string>())
const UNFINISHED = HEADER_SCHEMA.shipOrder.counts.unfinished as readonly string[]

const unfinishedRepo = (order: ShipOrder | undefined): string | undefined =>
  order?.repoId && UNFINISHED.includes(order.humanState) ? order.repoId : undefined
const shippedRepo = (order: ShipOrder | undefined): string | undefined =>
  order?.repoId && order.humanState === 'shipped' && order.receiptId !== undefined
    ? order.repoId
    : undefined

/**
 * Per-repository shipping membership, moved one order at a time as orders are
 * ingested: the unfinished working set as IDs, and shipped history as a
 * newest-first index that a view walks one window at a time. Nothing here
 * reads a row, and history past a window is never visited.
 */
export function createShippingIndex() {
  /** A repository's set is made on its first unfinished order and kept: a move is one add and one delete. */
  const unfinished = observable.map<string, ObservableSet<string>>(undefined, { deep: false })
  const shipped = new Map<string, KeyedAnswer<Shipped>>()
  /** One revision per repository's shipped index: a walk observes only its own. */
  const revisions = observable.map<string, number>(undefined, { deep: false })

  function bump(repoId: string): void {
    revisions.set(repoId, (revisions.get(repoId) ?? 0) + 1)
  }
  function moveUnfinished(id: string, from: string | undefined, to: string | undefined): void {
    if (from === to) return
    if (from) unfinished.get(from)?.delete(id)
    if (!to) return
    let members = unfinished.get(to)
    if (!members) unfinished.set(to, (members = observable.set<string>(undefined, { deep: false })))
    members.add(id)
  }
  function moveShipped(id: string, previous: ShipOrder | undefined, next: ShipOrder | undefined): void {
    const from = shippedRepo(previous),
      to = shippedRepo(next)
    const changedAt = to ? Date.parse(next!.stateChangedAt) : undefined
    if (from === to && (!to || shipped.get(to)?.get(id)?.changedAt === changedAt)) return
    if (from) {
      shipped.get(from)?.delete(id)
      bump(from)
    }
    if (to) {
      let answer = shipped.get(to)
      if (!answer) shipped.set(to, (answer = createKeyedAnswer<Shipped>(newestFirst)))
      answer.set(id, '', { id, changedAt: changedAt! })
      if (to !== from) bump(to)
    }
  }

  return {
    /** Call inside the ingest action, once per changed order. */
    move(id: string, previous: ShipOrder | undefined, next: ShipOrder | undefined): void {
      moveUnfinished(id, unfinishedRepo(previous), unfinishedRepo(next))
      moveShipped(id, previous, next)
    },
    /** Needs-you, in-progress and waiting orders of one repository (unordered). */
    unfinished: (repoId: string): ReadonlySet<string> => unfinished.get(repoId) ?? NONE,
    /** At most `limit` verified shipped orders, newest first. */
    recentShipped(repoId: string, limit: number): string[] {
      revisions.get(repoId)
      const answer = shipped.get(repoId),
        ids: string[] = []
      let value = answer?.first()
      while (value && ids.length < limit) {
        ids.push(value.id)
        value = answer!.after(value, value.id)
      }
      return ids
    },
    clear(): void {
      for (const repoId of shipped.keys()) bump(repoId)
      shipped.clear()
      for (const members of unfinished.values()) members.clear()
    },
  }
}
