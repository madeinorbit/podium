import type { ShippingIssueSummary, ShippingPanelRow } from '@podium/client-core/values'
import { lazy } from '@podium/mobx-helpers'
import {
  canonicalShippingDestination,
  type ShipLaneProjection,
  type ShipOrderProjection,
  shipLaneId,
} from '@podium/model'
import { action, compareShallow, compareStructural, observable } from 'mobx'
import { headerEntities } from './header-entities'
import type { ShippingCounts } from './header-schema'
import type { MobxPool } from './pool'
import { shellViews } from './shell-views'
import { LOADING, type Loaded } from './worklist/rollup'

/** What the shipping panel reads: membership as IDs, fields one order at a time. */
export interface ShippingSource {
  /** Needs-you, in-progress and waiting order IDs of one repository, unordered. */
  unfinished(repoId: string): Iterable<string>
  /** At most `limit` verified shipped order IDs, newest first. */
  recentShipped(repoId: string, limit: number): readonly string[]
  counts(repoId: string): ShippingCounts
  order(id: string): ShipOrderProjection | undefined
  issue(id: string): Loaded<ShippingIssueSummary>
  /** The server lane with this ID. */
  lane(id: string): ShipLaneProjection | undefined
}

export function poolShippingSource(pool: MobxPool): ShippingSource {
  const header = headerEntities(pool),
    shell = shellViews(pool)
  return {
    unfinished: (repoId) => header.shippingUnfinished(repoId),
    recentShipped: (repoId, limit) => header.recentShipped(repoId, limit),
    counts: (repoId) => header.shippingCounts(repoId),
    order: (id) => pool.row('shipOrder', id) as ShipOrderProjection | undefined,
    issue: (id) => shell.issue(id) as Loaded<ShippingIssueSummary>,
    lane: (id) => {
      const lane = pool.row('shellShipLane', id)
      return lane && lane !== LOADING ? lane : undefined
    },
  }
}

export const SHIPPED_HISTORY_LIMIT = 5

const byChangedAt = (a: ShipOrderProjection, b: ShipOrderProjection): number =>
  Date.parse(b.stateChangedAt) - Date.parse(a.stateChangedAt) || a.id.localeCompare(b.id)

export interface ShippingLane {
  destination: string
  ids: readonly string[]
}

/**
 * One open shipping panel over one repository (POD-5835). Groups are ID lists:
 * the unfinished working set is ordered by reading its own orders, shipped
 * history is a bounded newest-first walk, and an order's card fields are read
 * only by the row that shows it. Queue position stays the server lane's.
 */
export class ShippingView {
  @observable accessor selectedId: string | null = null

  constructor(
    private readonly source: ShippingSource,
    readonly repoId: string,
  ) {}

  @action select(id: string | null): void {
    this.selectedId = id
  }

  private group(state: ShipOrderProjection['humanState']): string[] {
    const orders: ShipOrderProjection[] = []
    for (const id of this.source.unfinished(this.repoId)) {
      const order = this.source.order(id)
      if (order?.humanState === state) orders.push(order)
    }
    return orders.sort(byChangedAt).map((order) => order.id)
  }

  @lazy({ equals: compareShallow }) get needsYou(): string[] {
    return this.group('needs_you')
  }

  @lazy({ equals: compareShallow }) get inProgress(): string[] {
    return this.group('in_progress')
  }

  /** Lanes by destination name; each lane keeps the server's train order. */
  @lazy({ equals: compareStructural }) get waiting(): ShippingLane[] {
    const lanes = new Map<string, ShipOrderProjection[]>()
    for (const id of this.source.unfinished(this.repoId)) {
      const order = this.source.order(id)
      if (order?.humanState !== 'waiting') continue
      const key = canonicalShippingDestination(order.destination, order.targetBranch)
      lanes.set(key, [...(lanes.get(key) ?? []), order])
    }
    return [...lanes.entries()]
      .map(([destination, orders]) => ({
        destination,
        ids: orders
          .sort(
            (a, b) =>
              (this.queueRank(a.id) ?? Number.MAX_SAFE_INTEGER) -
                (this.queueRank(b.id) ?? Number.MAX_SAFE_INTEGER) ||
              Date.parse(a.queuedAt) - Date.parse(b.queuedAt) ||
              a.id.localeCompare(b.id),
          )
          .map((order) => order.id),
      }))
      .sort((a, b) => a.destination.localeCompare(b.destination))
  }

  @lazy({ equals: compareShallow }) get recentlyShipped(): string[] {
    return [...this.source.recentShipped(this.repoId, SHIPPED_HISTORY_LIMIT)]
  }

  @lazy get unfinishedCount(): number {
    return this.source.counts(this.repoId).unfinishedCount
  }

  @lazy get decisionCount(): number {
    return this.source.counts(this.repoId).decisionCount
  }

  /** The selected order while it is still one of the panel's shown rows. */
  @lazy get selected(): string | undefined {
    const id = this.selectedId
    if (!id) return undefined
    const shown =
      this.needsYou.includes(id) ||
      this.inProgress.includes(id) ||
      this.waiting.some((lane) => lane.ids.includes(id)) ||
      this.recentlyShipped.includes(id)
    return shown ? id : undefined
  }

  /** The server lane's position, from this repository's lanes only. */
  queueRank(id: string): number | undefined {
    const order = this.source.order(id)
    if (!order) return undefined
    const lane = this.source.lane(
      shipLaneId(order.repoId, canonicalShippingDestination(order.destination, order.targetBranch)),
    )
    if (lane?.repoId !== this.repoId) return undefined
    // As the panel always did: the last train naming the order wins.
    let rank: number | undefined
    lane.trains.forEach((train, index) => {
      if (train.orderIds.includes(order.id)) rank = index + 1
    })
    return rank
  }

  /** One shown row's card fields, read when that row renders. */
  row(id: string): ShippingPanelRow | undefined {
    const order = this.source.order(id)
    if (!order) return undefined
    const issue = this.source.issue(order.issueId)
    return {
      order,
      issue: issue === LOADING ? undefined : issue,
      issueLoading: issue === LOADING,
      queueRank: this.queueRank(id),
    }
  }
}
