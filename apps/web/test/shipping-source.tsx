import type { ShippingIssueSummary } from '@podium/client-core/values'
import { createShippingIndex } from '@podium/client-graph/header-shipping-index'
import type { ShippingSource } from '@podium/client-graph/shipping-view'
import type { ShipLaneProjection, ShipOrderProjection } from '@podium/model'
import { action, observable, observableRef } from 'mobx'
import type { JSX } from 'react'
import { useLayoutEffect, useState } from 'react'
import { ShippingPanel, type ShippingPanelCommands } from '@/features/shipping/ShippingPanel'

export interface ShippingArrays {
  orders: readonly ShipOrderProjection[]
  lanes?: readonly ShipLaneProjection[]
  issues: readonly ShippingIssueSummary[]
}

/** Arrays fed through the real shipping index, one order at a time. */
export class ArrayShippingSource implements ShippingSource {
  private readonly index = createShippingIndex()
  private readonly orders = observable.map<string, ShipOrderProjection>(undefined, { deep: false })
  @observableRef accessor issues: ReadonlyMap<string, ShippingIssueSummary> = new Map()
  @observableRef accessor laneRows: readonly ShipLaneProjection[] = []

  constructor(arrays: ShippingArrays) {
    this.set(arrays)
  }

  @action set({ orders, lanes = [], issues }: ShippingArrays): void {
    const next = new Map(orders.map((order) => [order.id as string, order]))
    for (const [id, previous] of [...this.orders]) {
      if (next.has(id)) continue
      this.index.move(id, previous, undefined)
      this.orders.delete(id)
    }
    for (const [id, order] of next) {
      this.index.move(id, this.orders.get(id), order)
      this.orders.set(id, order)
    }
    this.issues = new Map(issues.map((issue) => [issue.id, issue]))
    this.laneRows = lanes
  }

  unfinished = (repoId: string) => this.index.unfinished(repoId)
  recentShipped = (repoId: string, limit: number) => this.index.recentShipped(repoId, limit)
  counts(repoId: string) {
    let unfinishedCount = 0,
      decisionCount = 0
    for (const order of this.orders.values()) {
      if (order.repoId !== repoId) continue
      if (order.humanState === 'needs_you' || order.humanState === 'in_progress' || order.humanState === 'waiting')
        unfinishedCount++
      if (order.humanState === 'needs_you') decisionCount++
    }
    return { unfinishedCount, decisionCount }
  }
  order = (id: string) => this.orders.get(id)
  issue = (id: string) => this.issues.get(id)
  lane = (id: string) => this.laneRows.findLast((lane) => lane.id === id)
}

/** The panel over plain arrays, as tests describe shipping state. */
export function ArrayShippingPanel({
  orders,
  lanes,
  issues,
  ...props
}: ShippingArrays & {
  repoId: string | null
  now: number
  commands: ShippingPanelCommands
}): JSX.Element {
  const [source] = useState(() => new ArrayShippingSource({ orders, lanes, issues }))
  useLayoutEffect(() => source.set({ orders, lanes, issues }), [source, orders, lanes, issues])
  return <ShippingPanel {...props} source={source} />
}
