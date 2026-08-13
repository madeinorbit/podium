import type { ShipOrder, ShipOrderId } from '@podium/model'

export interface ShippingQueueEntry {
  order: ShipOrder
  queueRank?: number
  blockedBy: ShipOrderId[]
}

/** Dependency-aware per-destination scheduler snapshot. Requested time is only
 * a stable tie-break after dependency depth; no queue position is persisted. */
export function shippingQueue(orders: readonly ShipOrder[]): ShippingQueueEntry[] {
  const byId = new Map(orders.map((order) => [order.id, order]))
  const shipped = new Set(
    orders.filter((order) => order.state === 'shipped').map((order) => order.id),
  )
  const active = orders.filter((order) => order.state === 'queued')
  const depthMemo = new Map<string, number>()
  const depth = (order: ShipOrder, visiting = new Set<string>()): number => {
    const known = depthMemo.get(order.id)
    if (known !== undefined) return known
    if (visiting.has(order.id)) return Number.MAX_SAFE_INTEGER
    visiting.add(order.id)
    const unresolved = order.deliveryDependsOn
      .map((id) => byId.get(id))
      .filter(
        (candidate): candidate is ShipOrder =>
          candidate !== undefined && !shipped.has(candidate.id),
      )
    const value =
      unresolved.length === 0 ? 0 : 1 + Math.max(...unresolved.map((item) => depth(item, visiting)))
    visiting.delete(order.id)
    depthMemo.set(order.id, value)
    return value
  }

  const lanes = new Map<string, ShipOrder[]>()
  for (const order of active) {
    const key = JSON.stringify([order.repoId, order.destination])
    const lane = lanes.get(key) ?? []
    lane.push(order)
    lanes.set(key, lane)
  }
  const rank = new Map<string, number>()
  for (const lane of lanes.values()) {
    lane.sort((left, right) => {
      const byDepth = depth(left) - depth(right)
      if (byDepth !== 0) return byDepth
      const byTime = left.requestedAt.localeCompare(right.requestedAt)
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id)
    })
    for (const [index, order] of lane.entries()) rank.set(order.id, index + 1)
  }

  return orders.map((order) => ({
    order,
    ...(rank.has(order.id) ? { queueRank: rank.get(order.id) } : {}),
    blockedBy: order.deliveryDependsOn.filter((id) => !shipped.has(id)),
  }))
}
