import {
  type DeliveryReceipt,
  type ShipHold,
  type ShipLaneProjection,
  type ShipOrder,
  ShipOrderProjection,
  type ShipOrderProjection as ShipOrderProjectionValue,
} from '@podium/model'
import {
  queuedShippingLanes,
  type ShipLaneInput,
  type ShippingStackEdge,
  shipLaneSchedule,
  withNativeStackEdges,
} from './queue'

const humanState = (
  state: Exclude<ShipOrder['state'], 'cancelled'>,
): ShipOrderProjectionValue['humanState'] => {
  if (state === 'queued') return 'waiting'
  if (state === 'held') return 'needs_you'
  if (state === 'shipped') return 'shipped'
  return 'in_progress'
}

const activity = (
  state: Exclude<ShipOrder['state'], 'cancelled'>,
): ShipOrderProjectionValue['activity'] => {
  switch (state) {
    case 'queued':
      return 'waiting'
    case 'preflight':
      return 'checking'
    case 'composing':
    case 'validating':
    case 'repairing':
    case 'landing':
    case 'publishing':
    case 'verifying':
    case 'held':
    case 'shipped':
      return state
  }
}

/** Build compact replicated order rows. Queue rank belongs to the lane row,
 * so scheduling never changes the facts carried by an order (POD-4974 O4). */
export function shipOrderProjectionRows(
  orders: Iterable<ShipOrder>,
  holds: Iterable<ShipHold>,
  receipts: Iterable<DeliveryReceipt>,
): { id: string; value: ShipOrderProjectionValue }[] {
  const orderList = [...orders].filter(
    (
      order,
    ): order is ShipOrder & {
      state: Exclude<ShipOrder['state'], 'cancelled'>
    } => order.state !== 'cancelled',
  )
  const openHoldByOrder = new Map(
    [...holds].filter((hold) => !hold.resolvedAt).map((hold) => [hold.orderId, hold]),
  )
  const receiptByOrder = new Map([...receipts].map((receipt) => [receipt.orderId, receipt]))
  return orderList.map((order) => {
    const hold = openHoldByOrder.get(order.id)
    const receipt = receiptByOrder.get(order.id)
    const human = humanState(order.state)
    const value = ShipOrderProjection.parse({
      id: order.id,
      issueId: order.issueId,
      repoId: order.repoId,
      targetBranch: order.targetBranch,
      destination: order.destination,
      state: order.state,
      humanState: human,
      activity: activity(order.state),
      queuedAt: order.requestedAt,
      stateChangedAt: order.stateChangedAt,
      ...(hold
        ? {
            hold: {
              id: hold.id,
              generation: hold.generation,
              reasonCode: hold.reasonCode,
              headline: hold.headline,
              actions: hold.actions,
            },
          }
        : {}),
      ...(receipt ? { receiptId: receipt.id } : {}),
    })
    return { id: order.id, value }
  })
}

/** One compact order row; scheduler-derived values live only on the lane. */
export function shipOrderProjectionRow(
  order: ShipOrder,
  hold?: ShipHold,
  receipt?: DeliveryReceipt,
): { id: string; value: ShipOrderProjectionValue } | null {
  return shipOrderProjectionRows([order], hold ? [hold] : [], receipt ? [receipt] : [])[0] ?? null
}

/** One lane's scheduler input from rows already in hand: its queued orders
 * with their recorded native-stack edges merged in, and every order they name
 * that is not itself queued in the lane. */
export function shipLaneInput(
  lane: { repoId: ShipOrder['repoId']; destination: string; queued: readonly ShipOrder[] },
  stackEdges: readonly ShippingStackEdge[],
  orderById: ReadonlyMap<ShipOrder['id'], ShipOrder>,
): ShipLaneInput {
  const queued = withNativeStackEdges(lane.queued, stackEdges)
  return {
    repoId: lane.repoId,
    destination: lane.destination,
    queued,
    dependencies: laneDependencyIds(queued).flatMap((id) => {
      const order = orderById.get(id)
      return order ? [order] : []
    }),
  }
}

/** The ids a lane's queued orders depend on that are not queued members. */
export function laneDependencyIds(queued: readonly ShipOrder[]): ShipOrder['id'][] {
  const members = new Set(queued.map((order) => order.id))
  return [
    ...new Set(queued.flatMap((order) => order.deliveryDependsOn.filter((id) => !members.has(id)))),
  ]
}

/** Boot/reconnect FULL TRUTH for both shipping kinds, from the same per-lane
 * plan a commit publishes and with the recorded native-stack edges the tick
 * schedules over, so a restart cannot publish a rank the scheduler would not
 * run. */
export function scheduledShippingProjection(
  orders: Iterable<ShipOrder>,
  holds: Iterable<ShipHold>,
  receipts: Iterable<DeliveryReceipt>,
  stackEdges: readonly ShippingStackEdge[] = [],
): {
  orders: { id: string; value: ShipOrderProjectionValue }[]
  lanes: { id: string; value: ShipLaneProjection }[]
} {
  const orderList = [...orders]
  const orderById = new Map(orderList.map((order) => [order.id, order]))
  const lanes: { id: string; value: ShipLaneProjection }[] = []
  for (const lane of queuedShippingLanes(orderList)) {
    const scheduled = shipLaneSchedule(shipLaneInput(lane, stackEdges, orderById))
    lanes.push({ id: scheduled.lane.id, value: scheduled.lane })
  }
  const holdByOrder = new Map(
    [...holds].filter((hold) => !hold.resolvedAt).map((hold) => [hold.orderId, hold]),
  )
  const receiptByOrder = new Map([...receipts].map((receipt) => [receipt.orderId, receipt]))
  return {
    orders: orderList.flatMap((order) => {
      const row = shipOrderProjectionRow(
        order,
        holdByOrder.get(order.id),
        receiptByOrder.get(order.id),
      )
      return row ? [row] : []
    }),
    lanes,
  }
}
