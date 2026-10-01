import {
  canonicalShippingDestination,
  type ShipLaneProjection,
  type ShipOrderProjection,
  shipLaneId,
} from '@podium/model'

export interface ShippingIssueSummary {
  id: string
  seq: number
  title: string
  displayRef?: string
}

export interface ShippingPanelRow {
  order: ShipOrderProjection
  issue: ShippingIssueSummary | undefined
  queueRank: number | undefined
}

export interface ShippingWaitingLane {
  destination: string
  rows: ShippingPanelRow[]
}

export interface ShippingElapsed {
  label: string
  duration: string
}

export interface ShippingPanelModel {
  unfinishedCount: number
  decisionCount: number
  needsYou: ShippingPanelRow[]
  inProgress: ShippingPanelRow[]
  waiting: ShippingWaitingLane[]
  recentlyShipped: ShippingPanelRow[]
}

const byChangedAt = (a: ShippingPanelRow, b: ShippingPanelRow): number =>
  Date.parse(b.order.stateChangedAt) - Date.parse(a.order.stateChangedAt) ||
  a.order.id.localeCompare(b.order.id)

const byQueueRank = (a: ShippingPanelRow, b: ShippingPanelRow): number =>
  (a.queueRank ?? Number.MAX_SAFE_INTEGER) - (b.queueRank ?? Number.MAX_SAFE_INTEGER) ||
  Date.parse(a.order.queuedAt) - Date.parse(b.order.queuedAt) ||
  a.order.id.localeCompare(b.order.id)

/** The one client projection used by both the Shipping dock and its rail cell.
 * Queue position is server-owned: a train's position in its canonical lane.
 * Older servers and offline caches fall back to the order's stamped rank only
 * while that lane row is absent. A present lane's unranked orders stay unranked. */
export function shippingPanelModel(
  orders: readonly ShipOrderProjection[],
  issues: readonly ShippingIssueSummary[],
  repoId: string | null,
  lanes: readonly ShipLaneProjection[] = [],
  recentLimit = 5,
): ShippingPanelModel {
  if (!repoId) {
    return {
      unfinishedCount: 0,
      decisionCount: 0,
      needsYou: [],
      inProgress: [],
      waiting: [],
      recentlyShipped: [],
    }
  }

  const issuesById = new Map(issues.map((issue) => [issue.id, issue]))
  const ranksByLane = new Map<string, Map<ShipOrderProjection['id'], number>>()
  for (const lane of lanes) {
    if (lane.repoId !== repoId) continue
    const ranks = new Map<ShipOrderProjection['id'], number>()
    lane.trains.forEach((train, index) => {
      for (const id of train.orderIds) ranks.set(id, index + 1)
    })
    ranksByLane.set(lane.id, ranks)
  }
  const rows = orders
    .filter((order) => order.repoId === repoId)
    .map((order): ShippingPanelRow => {
      const destination = canonicalShippingDestination(order.destination, order.targetBranch)
      const ranks = ranksByLane.get(shipLaneId(order.repoId, destination))
      return {
        order,
        issue: issuesById.get(order.issueId),
        queueRank: ranks === undefined ? order.queueRank : ranks.get(order.id),
      }
    })
  const needsYou = rows.filter((row) => row.order.humanState === 'needs_you').sort(byChangedAt)
  const inProgress = rows.filter((row) => row.order.humanState === 'in_progress').sort(byChangedAt)
  const waitingRows = rows.filter((row) => row.order.humanState === 'waiting')
  const laneRows = new Map<string, ShippingPanelRow[]>()
  for (const row of waitingRows) {
    const key = canonicalShippingDestination(row.order.destination, row.order.targetBranch)
    const lane = laneRows.get(key) ?? []
    lane.push(row)
    laneRows.set(key, lane)
  }
  const waiting = [...laneRows.entries()]
    .map(
      ([destination, lane]): ShippingWaitingLane => ({
        destination,
        rows: lane.sort(byQueueRank),
      }),
    )
    // Independent lanes have no honest global rank. A stable name sort makes
    // no scheduling claim while each lane retains its server-owned order.
    .sort((a, b) => a.destination.localeCompare(b.destination))
  const recentlyShipped = rows
    .filter((row) => row.order.humanState === 'shipped' && row.order.receiptId !== undefined)
    .sort(byChangedAt)
    .slice(0, Math.max(0, recentLimit))

  return {
    unfinishedCount: needsYou.length + inProgress.length + waitingRows.length,
    decisionCount: needsYou.length,
    needsYou,
    inProgress,
    waiting,
    recentlyShipped,
  }
}

const ACTIVITY_LABELS: Record<ShipOrderProjection['activity'], string> = {
  waiting: 'Waiting',
  checking: 'Checking approved changes',
  composing: 'Combining related changes',
  validating: 'Running checks',
  repairing: 'Trying a safe fix',
  landing: 'Applying checked changes',
  publishing: 'Sending to destination',
  verifying: 'Confirming destination',
  held: 'Needs your decision',
  shipped: 'Shipped',
}

/** Stable product language for the server's deliberately compact activity code. */
export function shippingActivityLabel(activity: ShipOrderProjection['activity']): string {
  return ACTIVITY_LABELS[activity]
}

export function shippingElapsed(queuedAt: string, now: number): ShippingElapsed {
  const start = Date.parse(queuedAt)
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1_000)) : 0
  const minutes = Math.floor(seconds / 60)
  if (minutes < 1) return { label: '<1 min', duration: `PT${seconds}S` }
  if (minutes < 60) return { label: `${minutes} min`, duration: `PT${minutes}M` }
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return {
    label: remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`,
    duration: `PT${hours}H${remainder > 0 ? `${remainder}M` : ''}`,
  }
}

export function formatShippingElapsed(queuedAt: string, now: number): string {
  return shippingElapsed(queuedAt, now).label
}
