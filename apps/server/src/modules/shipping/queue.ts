import { createHash } from 'node:crypto'
import type { DeliveryReceipt, ShipOrder, ShipOrderId } from '@podium/model'

export interface ShippingWaitEstimate {
  lowerBoundMs: number
  upperBoundMs: number
  sampleSize: number
  basis: 'lane-history'
}

export interface ShippingQueueEntry {
  order: ShipOrder
  queueRank?: number
  blockedBy: ShipOrderId[]
  trainId?: string
  trainIndex?: number
  trainSize?: number
  waitEstimate?: ShippingWaitEstimate
}

export interface ImmutableShippingPrefix {
  id: string
  orderIds: ShipOrderId[]
  approvedHeads: string[]
}

export interface ShippingTrain {
  id: string
  repoId: ShipOrder['repoId']
  destination: string
  targetBranch: string
  orders: ShipOrder[]
  prefixes: ImmutableShippingPrefix[]
}

export interface ShippingSchedule {
  entries: ShippingQueueEntry[]
  trains: ShippingTrain[]
}

const laneKey = (order: ShipOrder): string => JSON.stringify([order.repoId, order.destination])

const attributionKey = (order: ShipOrder): string =>
  JSON.stringify({ onBehalfOf: order.requestedBy.onBehalfOf })

const providerKey = (order: ShipOrder): string => JSON.stringify(order.providerRef ?? null)

/** Facts which must remain identical while one exact executor job owns the
 * immutable composed prefix. Resource locks deliberately do not participate:
 * those stay in the existing Queues scheduler and are acquired at validation. */
export const shippingCompatibilityKey = (order: ShipOrder): string =>
  JSON.stringify([
    order.repoId,
    order.destination,
    order.targetBranch,
    order.policyId,
    order.closeMode,
    attributionKey(order),
    providerKey(order),
  ])

const byFifo = (left: ShipOrder, right: ShipOrder): number =>
  left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id)

const prefixId = (orders: readonly ShipOrder[]): string =>
  `train:${createHash('sha256')
    .update(
      JSON.stringify(
        orders.map((order) => [
          order.id,
          order.approvedBaseSha,
          order.approvedHeadSha,
          order.deliveryDependsOn,
        ]),
      ),
    )
    .digest('hex')}`

const percentile = (sorted: readonly number[], fraction: number): number => {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index] ?? 0
}

const laneDurations = (
  orders: readonly ShipOrder[],
  receipts: readonly DeliveryReceipt[],
): Map<string, number[]> => {
  const byId = new Map(orders.map((order) => [order.id, order]))
  const result = new Map<string, number[]>()
  for (const receipt of receipts) {
    const order = byId.get(receipt.orderId)
    if (!order) continue
    const duration = Date.parse(receipt.completedAt) - Date.parse(order.requestedAt)
    if (!Number.isFinite(duration) || duration < 0) continue
    const key = laneKey(order)
    const samples = result.get(key) ?? []
    samples.push(duration)
    result.set(key, samples)
  }
  for (const [key, samples] of result) {
    result.set(
      key,
      samples.slice(-40).sort((a, b) => a - b),
    )
  }
  return result
}

const estimateWait = (
  order: ShipOrder,
  rank: number,
  samples: readonly number[],
  now: number,
): ShippingWaitEstimate | undefined => {
  // Fewer than three same-lane completions is not evidence for a useful range.
  if (samples.length < 3) return undefined
  const requestedAt = Date.parse(order.requestedAt)
  const elapsed = Number.isFinite(requestedAt) ? Math.max(0, now - requestedAt) : 0
  const lowerBoundMs = Math.max(0, percentile(samples, 0.25) * rank - elapsed)
  const upperBoundMs = Math.max(lowerBoundMs, percentile(samples, 0.9) * rank - elapsed)
  return {
    lowerBoundMs,
    upperBoundMs,
    sampleSize: samples.length,
    basis: 'lane-history',
  }
}

const directPredecessor = (candidate: ShipOrder, predecessor: ShipOrder): boolean =>
  candidate.deliveryDependsOn.includes(predecessor.id)

const topologicalLane = (
  lane: readonly ShipOrder[],
  byId: ReadonlyMap<ShipOrderId, ShipOrder>,
  shipped: ReadonlySet<ShipOrderId>,
): { ordered: ShipOrder[]; blocked: Map<ShipOrderId, ShipOrderId[]> } => {
  const laneIds = new Set(lane.map((order) => order.id))
  const blocked = new Map<ShipOrderId, ShipOrderId[]>()
  const remaining = new Map(lane.map((order) => [order.id, order]))
  const ordered: ShipOrder[] = []

  for (const order of lane) {
    const external = order.deliveryDependsOn.filter((id) => {
      if (shipped.has(id)) return false
      const dependency = byId.get(id)
      return !dependency || !laneIds.has(id) || dependency.state !== 'queued'
    })
    if (external.length > 0) blocked.set(order.id, external)
  }

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter(
        (order) =>
          !blocked.has(order.id) &&
          order.deliveryDependsOn.every((id) => shipped.has(id) || !remaining.has(id)),
      )
      .sort(byFifo)
    const next = ready[0]
    if (!next) {
      for (const order of remaining.values()) {
        blocked.set(
          order.id,
          order.deliveryDependsOn.filter((id) => !shipped.has(id)),
        )
      }
      break
    }
    ordered.push(next)
    remaining.delete(next.id)
  }
  return { ordered, blocked }
}

const buildTrains = (ordered: readonly ShipOrder[]): ShippingTrain[] => {
  const trains: ShippingTrain[] = []
  const remaining = [...ordered]
  const scheduledIds = new Set(ordered.map((order) => order.id))
  const flush = (members: ShipOrder[]): void => {
    const prefixes = members.map((_, index) => {
      const prefix = members.slice(0, index + 1)
      return {
        id: prefixId(prefix),
        orderIds: prefix.map((order) => order.id),
        approvedHeads: prefix.map((order) => order.approvedHeadSha),
      }
    })
    const first = members[0]!
    trains.push({
      id: prefixes.at(-1)!.id,
      repoId: first.repoId,
      destination: first.destination,
      targetBranch: first.targetBranch,
      orders: members,
      prefixes,
    })
  }

  while (remaining.length > 0) {
    const members = [remaining.shift()!]
    while (true) {
      const previous = members.at(-1)!
      const successorIndex = remaining.findIndex(
        (order) =>
          shippingCompatibilityKey(order) === shippingCompatibilityKey(previous) &&
          directPredecessor(order, previous) &&
          order.deliveryDependsOn.every(
            (id) => !scheduledIds.has(id) || members.some((member) => member.id === id),
          ),
      )
      if (successorIndex < 0) break
      members.push(remaining.splice(successorIndex, 1)[0]!)
    }
    flush(members)
  }
  return trains
}

/** Authoritative scheduling snapshot. Dependency order wins, FIFO breaks ties,
 * blocked work is omitted from train ranks, and every rank/estimate is scoped
 * to exactly one repository/destination lane. */
export function shippingSchedule(
  orders: readonly ShipOrder[],
  receipts: readonly DeliveryReceipt[] = [],
  now = Date.now(),
): ShippingSchedule {
  const byId = new Map(orders.map((order) => [order.id, order]))
  const shipped = new Set(
    orders.filter((order) => order.state === 'shipped').map((order) => order.id),
  )
  const active = orders.filter((order) => order.state === 'queued')
  const lanes = new Map<string, ShipOrder[]>()
  for (const order of active) {
    const key = laneKey(order)
    const members = lanes.get(key) ?? []
    members.push(order)
    lanes.set(key, members)
  }

  const rank = new Map<ShipOrderId, number>()
  const blockers = new Map<ShipOrderId, ShipOrderId[]>()
  const trainByOrder = new Map<ShipOrderId, { train: ShippingTrain; index: number }>()
  const trains: ShippingTrain[] = []
  for (const lane of lanes.values()) {
    const planned = topologicalLane(lane, byId, shipped)
    for (const [id, values] of planned.blocked) blockers.set(id, values)
    const laneTrains = buildTrains(planned.ordered)
    for (const [trainIndex, train] of laneTrains.entries()) {
      for (const order of train.orders) rank.set(order.id, trainIndex + 1)
      trains.push(train)
      train.orders.forEach((order, index) => trainByOrder.set(order.id, { train, index }))
    }
  }

  const durations = laneDurations(orders, receipts)
  return {
    entries: orders.map((order) => {
      const queueRank = rank.get(order.id)
      const train = trainByOrder.get(order.id)
      const waitEstimate =
        queueRank === undefined
          ? undefined
          : estimateWait(order, queueRank, durations.get(laneKey(order)) ?? [], now)
      return {
        order,
        ...(queueRank === undefined ? {} : { queueRank }),
        blockedBy:
          queueRank === undefined
            ? (blockers.get(order.id) ?? order.deliveryDependsOn.filter((id) => !shipped.has(id)))
            : [],
        ...(train
          ? {
              trainId: train.train.id,
              trainIndex: train.index + 1,
              trainSize: train.train.orders.length,
            }
          : {}),
        ...(waitEstimate === undefined ? {} : { waitEstimate }),
      }
    }),
    trains,
  }
}

export function shippingQueue(
  orders: readonly ShipOrder[],
  receipts: readonly DeliveryReceipt[] = [],
  now = Date.now(),
): ShippingQueueEntry[] {
  return shippingSchedule(orders, receipts, now).entries
}

export interface PrefixValidationResult {
  passed: boolean
  summary?: string
}

export class GreenPrefixCache {
  private readonly green = new Map<
    string,
    { result: PrefixValidationResult; orderIds: ShipOrderId[] }
  >()

  get(prefix: ImmutableShippingPrefix): PrefixValidationResult | undefined {
    return this.green.get(prefix.id)?.result
  }

  record(prefix: ImmutableShippingPrefix, result: PrefixValidationResult): void {
    if (result.passed) this.green.set(prefix.id, { result, orderIds: prefix.orderIds })
  }

  invalidateOrder(orderId: ShipOrderId): void {
    for (const [id, cached] of this.green) {
      if (cached.orderIds.includes(orderId)) this.green.delete(id)
    }
  }
}

export interface AdaptiveIsolationResult {
  green: ShipOrderId[][]
  failures: ShipOrderId[][]
  interactions: ShipOrderId[][]
  validationCount: number
}

/** Full-set-first delta isolation. If both halves are green while their union
 * is red, the union is reported as an interaction set; no member is mislabeled
 * as the offender. Exact green subsets are reused through the prefix cache. */
export async function isolateShippingTrain(
  orders: readonly ShipOrder[],
  validate: (subset: readonly ShipOrder[]) => Promise<PrefixValidationResult>,
  cache = new GreenPrefixCache(),
): Promise<AdaptiveIsolationResult> {
  const green: ShipOrderId[][] = []
  const failures: ShipOrderId[][] = []
  const interactions: ShipOrderId[][] = []
  let validationCount = 0
  if (orders.length === 0) return { green, failures, interactions, validationCount }

  const run = async (subset: readonly ShipOrder[]): Promise<boolean> => {
    const prefix: ImmutableShippingPrefix = {
      id: prefixId(subset),
      orderIds: subset.map((order) => order.id),
      approvedHeads: subset.map((order) => order.approvedHeadSha),
    }
    const cached = cache.get(prefix)
    if (cached) return true
    validationCount += 1
    const result = await validate(subset)
    cache.record(prefix, result)
    if (result.passed) green.push(prefix.orderIds)
    return result.passed
  }

  const isolate = async (subset: readonly ShipOrder[], knownFailed = false): Promise<void> => {
    if (!knownFailed && (await run(subset))) return
    if (subset.length === 1) {
      failures.push([subset[0]!.id])
      return
    }
    const middle = Math.ceil(subset.length / 2)
    const left = subset.slice(0, middle)
    const right = subset.slice(middle)
    const leftGreen = await run(left)
    const rightGreen = await run(right)
    if (leftGreen && rightGreen) {
      interactions.push(subset.map((order) => order.id))
      return
    }
    if (!leftGreen) await isolate(left, true)
    if (!rightGreen) await isolate(right, true)
  }

  await isolate(orders)
  return { green, failures, interactions, validationCount }
}
