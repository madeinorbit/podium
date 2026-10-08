import type { IssueId } from '@podium/model'

/** Index one ID list for O(1) membership below. Recursion (not a loop over
 * the tainted queue) keeps the single output pass narrow: one output array
 * plus index objects, never old/new set or intermediate array copies. Depth
 * is bounded by the deck length — a phone-screen queue, not a catalog. */
function fillIndex(ids: readonly IssueId[], at: number, table: Record<string, 1>): void {
  if (at >= ids.length) return
  table[ids[at]!] = 1
  fillIndex(ids, at + 1, table)
}
function pushDecided(order: readonly IssueId[], at: number, end: number, out: IssueId[]): void {
  if (at >= end) return
  out.push(order[at]!)
  pushDecided(order, at + 1, end, out)
}
function pushKept(
  order: readonly IssueId[],
  screenable: Record<string, 1>,
  at: number,
  out: IssueId[],
): void {
  if (at >= order.length) return
  const id = order[at]!
  if (screenable[id] === 1) out.push(id)
  pushKept(order, screenable, at + 1, out)
}
function pushArrivals(
  seen: Record<string, 1>,
  queue: readonly IssueId[],
  at: number,
  out: IssueId[],
): void {
  if (at >= queue.length) return
  const id = queue[at]!
  if (seen[id] !== 1) {
    seen[id] = 1
    out.push(id)
  }
  pushArrivals(seen, queue, at + 1, out)
}
/** The deck's already-decided prefix stays fixed while the live queue changes. */
export function reconcileScreeningIds(order: IssueId[], index: number, queue: readonly IssueId[]) {
  const end = Math.min(Math.max(index, 0), order.length)
  const screenable: Record<string, 1> = {}
  fillIndex(queue, 0, screenable)
  const seen: Record<string, 1> = {}
  fillIndex(order, 0, seen)
  const next: IssueId[] = []
  pushDecided(order, 0, end, next)
  pushKept(order, screenable, end, next)
  pushArrivals(seen, queue, 0, next)
  return { order: next, index: end }
}
