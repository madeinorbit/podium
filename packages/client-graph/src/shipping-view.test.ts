import { type ShippingIssueSummary, shippingPanelModel } from '@podium/client-core/values'
import {
  canonicalShippingDestination,
  type ShipLaneProjection,
  type ShipOrderProjection,
  shipLaneId,
} from '@podium/model'
import { expect, it, vi } from 'vitest'
import { headerEntities } from './header-entities'
import { MobxPool } from './pool'
import { SHIPPED_HISTORY_LIMIT, type ShippingSource, ShippingView } from './shipping-view'

const base = Date.parse('2026-10-09T00:00:00Z')
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString()
type Order = ShipOrderProjection

function fixture(scale: 1 | 4) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: base }, undefined, {
    header: true,
    load: () => undefined,
    schedule: () => () => {},
  })
  let seed = 11
  const next = (range: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % range
  }
  const order = (index: number, over: Partial<Order>): Order =>
    ({
      id: `order-${String(index).padStart(4, '0')}`,
      issueId: `issue-${index % 9}`,
      repoId: index % 5 === 0 ? 'repo-b' : 'repo-a',
      targetBranch: 'main',
      destination: ['origin/main', 'main', 'origin/release'][index % 3],
      state: 'queued',
      humanState: 'waiting',
      activity: 'waiting',
      queuedAt: at(next(500)),
      stateChangedAt: at(next(500)),
      ...over,
    }) as Order
  const states = ['needs_you', 'in_progress', 'waiting'] as const
  const orders: Order[] = [
    ...Array.from({ length: 14 }, (_, index) => order(index, { humanState: states[index % 3] })),
    // Shipped history grows with scale; some without a receipt, some tied in time.
    ...Array.from({ length: 60 * scale }, (_, offset) => {
      const index = 100 + offset
      return order(index, {
        humanState: 'shipped',
        activity: 'shipped',
        stateChangedAt: at(offset % 7 === 0 ? 42 : next(5000)),
        ...(offset % 4 === 3 ? {} : { receiptId: `receipt-${index}` as never }),
      })
    }),
  ]
  const issues: ShippingIssueSummary[] = Array.from({ length: 6 }, (_, index) => ({
    id: `issue-${index}`,
    seq: index + 1,
    title: `Synthetic issue ${index}`,
    displayRef: `POD-${index + 1}`,
  }))
  let lanes: ShipLaneProjection[] = []
  // Server lanes for repo-a's waiting orders; each lane leaves its newest order unranked.
  const rebuildLanes = () => {
    const groups = new Map<string, Order[]>()
    for (const row of byId.values()) {
      if (row.repoId !== 'repo-a' || row.humanState !== 'waiting') continue
      const destination = canonicalShippingDestination(row.destination, row.targetBranch)
      groups.set(destination, [...(groups.get(destination) ?? []), row])
    }
    lanes = [...groups].map(([destination, rows]) => ({
      id: shipLaneId('repo-a' as never, destination),
      repoId: 'repo-a' as never,
      destination,
      trains: rows.slice(0, -1).reverse().map((row) => ({ orderIds: [row.id] })),
      blockedOrderIds: [],
    }))
  }
  const byId = new Map(orders.map((row) => [row.id as string, row]))
  const apply = (changed: Order[], removed: string[] = []) => {
    for (const row of changed) byId.set(row.id, row)
    for (const id of removed) byId.delete(id)
    headerEntities(pool).apply([
      ...changed.map((value) => ({ kind: 'shipOrder' as const, id: value.id as string, value })),
      ...removed.map((id) => ({ kind: 'shipOrder' as const, id, value: undefined })),
    ])
    rebuildLanes()
  }
  apply(orders)
  const source: ShippingSource = {
    unfinished: (repoId) => headerEntities(pool).shippingUnfinished(repoId),
    recentShipped: (repoId, limit) => headerEntities(pool).recentShipped(repoId, limit),
    counts: (repoId) => headerEntities(pool).shippingCounts(repoId),
    order: (id) => pool.row('shipOrder', id) as Order | undefined,
    issue: (id) => issues.find((issue) => issue.id === id),
    lane: (id) => lanes.findLast((lane) => lane.id === id),
  }
  return { pool, source, apply, byId, get lanes() { return lanes }, issues }
}

/** Old and new answers on the same state: groups, counts and every shown row. */
function compare(f: ReturnType<typeof fixture>, repoId: string) {
  const legacy = shippingPanelModel([...f.byId.values()], f.issues, repoId, f.lanes)
  const view = new ShippingView(f.source, repoId)
  const ids = (rows: { order: Order }[]) => rows.map((row) => row.order.id)
  expect(view.needsYou).toEqual(ids(legacy.needsYou))
  expect(view.inProgress).toEqual(ids(legacy.inProgress))
  expect(view.waiting).toEqual(legacy.waiting.map((lane) => ({ destination: lane.destination, ids: ids(lane.rows) })))
  expect(view.recentlyShipped).toEqual(ids(legacy.recentlyShipped))
  expect({ unfinished: view.unfinishedCount, decisions: view.decisionCount }).toEqual({
    unfinished: legacy.unfinishedCount,
    decisions: legacy.decisionCount,
  })
  for (const row of [...legacy.needsYou, ...legacy.inProgress, ...legacy.waiting.flatMap((lane) => lane.rows), ...legacy.recentlyShipped])
    expect(view.row(row.order.id)).toEqual({ ...row, issueLoading: false })
  return { legacy, view }
}

it('shows the legacy groups, counts and rows through order changes, reading a bounded window at 1x and 4x history', () => {
  const reads: number[] = []
  for (const scale of [1, 4] as const) {
    const f = fixture(scale)
    const row = vi.spyOn(f.pool, 'row')
    const { legacy, view } = compare(f, 'repo-a')
    expect(legacy.recentlyShipped).toHaveLength(SHIPPED_HISTORY_LIMIT)
    expect(view.waiting.flatMap((lane) => lane.ids).some((id) => view.row(id)?.queueRank !== undefined)).toBe(true)
    compare(f, 'repo-b')
    compare(f, 'repo-none')
    // A fresh panel: membership, order and the five shown history rows.
    row.mockClear()
    const fresh = new ShippingView(f.source, 'repo-a')
    for (const id of [...fresh.needsYou, ...fresh.inProgress, ...fresh.waiting.flatMap((lane) => lane.ids), ...fresh.recentlyShipped])
      fresh.row(id)
    reads.push(new Set(row.mock.calls.filter(([entity]) => String(entity) === 'shipOrder').map(([, id]) => id)).size)

    const one = (id: string) => f.byId.get(id)!
    const shipped = [...f.byId.values()].filter((value) => value.humanState === 'shipped' && value.receiptId && value.repoId === 'repo-a')
    // In-progress ships (newest), a waiting order starts, a needs-you order leaves.
    f.apply([{ ...one('order-0001'), humanState: 'shipped', activity: 'shipped', stateChangedAt: at(9000), receiptId: 'receipt-x' as never }])
    compare(f, 'repo-a')
    f.apply([{ ...one('order-0002'), humanState: 'in_progress', activity: 'validating', stateChangedAt: at(1) }])
    compare(f, 'repo-a')
    f.apply([], ['order-0003'])
    compare(f, 'repo-a')
    // An unfinished order moves repository: it leaves one panel and enters the other.
    f.apply([{ ...one('order-0004'), repoId: 'repo-b' as never }])
    expect(compare(f, 'repo-a').view.inProgress).not.toContain('order-0004')
    expect(compare(f, 'repo-b').view.inProgress).toContain('order-0004')
    // A shown history row is revised older; an old one is revised newest; one moves repository.
    const newest = compare(f, 'repo-a').view.recentlyShipped
    f.apply([{ ...one(newest[0]!), stateChangedAt: at(-50) }])
    compare(f, 'repo-a')
    f.apply([{ ...shipped.at(-1)!, stateChangedAt: at(9500) }])
    compare(f, 'repo-a')
    f.apply([{ ...one(newest[1]!), repoId: 'repo-b' as never }])
    compare(f, 'repo-a')
    compare(f, 'repo-b')
    // A receipt arrives on a shipped order that had none.
    const unreceipted = [...f.byId.values()].find((value) =>
      value.repoId === 'repo-a' && value.humanState === 'shipped' && !value.receiptId)!
    f.apply([{ ...unreceipted, stateChangedAt: at(9900), receiptId: 'receipt-y' as never }])
    expect(compare(f, 'repo-a').view.recentlyShipped[0]).toBe(unreceipted.id)
  }
  // Only unfinished orders and the five shown history rows are read, whatever the history size.
  expect(reads[1]).toBe(reads[0])
  expect(reads[0]).toBeLessThan(14 + SHIPPED_HISTORY_LIMIT + 1)
})
