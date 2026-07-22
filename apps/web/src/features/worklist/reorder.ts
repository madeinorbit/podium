/**
 * Reorder persistence planning (POD-168): given a sibling scope's NEW id order
 * after a grip-drag, compute the minimal set of sortKey writes.
 *
 * Fast path — the moved row's new neighbors hold well-ordered keys (or the
 * edge is open): ONE write, the fractional midpoint. Slow path — the scope
 * still holds legacy unkeyed (or corrupt/out-of-order) rows around the drop
 * point: backfill fresh ascending keys for the WHOLE scope in its new order,
 * after which every later drag takes the fast path.
 */
import { isSortKey, sortKeyBetween } from '@podium/domain'

export interface ReorderPatch {
  id: string
  sortKey: string
}

export function planReorderKeys(
  order: readonly string[],
  movedId: string,
  keyOf: (id: string) => string | null | undefined,
): ReorderPatch[] {
  const i = order.indexOf(movedId)
  if (i < 0) return []
  const validKey = (id: string | undefined): string | null => {
    if (id === undefined) return null
    const k = keyOf(id)
    return isSortKey(k) ? k : null
  }
  const prev = validKey(order[i - 1])
  const next = validKey(order[i + 1])
  const prevOpen = i === 0
  const nextOpen = i === order.length - 1
  const fastPath =
    (prevOpen || prev !== null) &&
    (nextOpen || next !== null) &&
    (prev === null || next === null || prev < next)
  if (fastPath) {
    return [{ id: movedId, sortKey: sortKeyBetween(prev, next) }]
  }
  // Backfill: fresh keys for the whole scope, top to bottom.
  const patches: ReorderPatch[] = []
  let last: string | null = null
  for (const id of order) {
    const k = sortKeyBetween(last, null)
    patches.push({ id, sortKey: k })
    last = k
  }
  return patches
}
