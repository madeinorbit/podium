import {
  type DeliveryReceipt,
  type ShipHold,
  type ShipOrder,
  ShipOrderProjection,
  type ShipOrderProjection as ShipOrderProjectionValue,
} from '@podium/model'
import { shippingQueue } from './queue'

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

/** Build compact replicated order rows. `queueRank` remains absent here: only
 * the dependency-aware scheduler may supply that optional projection fact. */
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

/** One compact row with an optional scheduler-derived rank. The scheduler's
 * trains remain internal; unused train and wait estimates never enter the row. */
export function shipOrderProjectionRow(
  order: ShipOrder,
  hold?: ShipHold,
  receipt?: DeliveryReceipt,
  queueRank?: number,
): { id: string; value: ShipOrderProjectionValue } | null {
  const row = shipOrderProjectionRows([order], hold ? [hold] : [], receipt ? [receipt] : [])[0]
  if (!row) return null
  return {
    id: row.id,
    value: ShipOrderProjection.parse({
      ...row.value,
      ...(queueRank === undefined ? {} : { queueRank }),
    }),
  }
}

/** Boot/reconnect summary uses the same scheduler snapshot as live mutations,
 * so a restart cannot briefly publish FIFO-looking client ranks. */
export function scheduledShipOrderProjectionRows(
  orders: Iterable<ShipOrder>,
  holds: Iterable<ShipHold>,
  receipts: Iterable<DeliveryReceipt>,
  now = Date.now(),
): { id: string; value: ShipOrderProjectionValue }[] {
  const orderList = [...orders]
  const holdByOrder = new Map(
    [...holds].filter((hold) => !hold.resolvedAt).map((hold) => [hold.orderId, hold]),
  )
  const receiptList = [...receipts]
  const receiptByOrder = new Map(receiptList.map((receipt) => [receipt.orderId, receipt]))
  return shippingQueue(orderList, receiptList, now).flatMap(({ order, queueRank }) => {
    const row = shipOrderProjectionRow(
      order,
      holdByOrder.get(order.id),
      receiptByOrder.get(order.id),
      queueRank,
    )
    return row ? [row] : []
  })
}
