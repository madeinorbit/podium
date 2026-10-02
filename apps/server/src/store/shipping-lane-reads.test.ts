/**
 * The lane-scoped reads a shipping commit publishes from (POD-4974 O2). Each one
 * must answer for one lane, or one set of orders, and never read history.
 */

import { createHash } from 'node:crypto'
import {
  asIssueId,
  asMachineId,
  asRepoId,
  asShipOrderId,
  firstAdminMemberId,
  type ShipOrder,
  shipLaneId,
} from '@podium/model'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { ACTIVE_SHIP_ORDER_TERM } from './shipping'

const VALIDATION_PROFILE = {
  id: 'default',
  argv: ['bun', 'run', 'test'],
  cwd: 'integration-root' as const,
  timeoutMs: 60_000,
  resourceLocks: [] as string[],
}

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const issue = (id: string, seq: number) => ({
  id: asIssueId(id),
  repoPath: '/r',
  seq,
  title: id,
  description: 'desc',
  ownerUserId: firstAdminMemberId(),
  visibility: 'personal' as const,
  createdByActor: firstAdminMemberId(),
  createdByOnBehalfOf: firstAdminMemberId(),
  stage: 'backlog',
  worktreePath: null,
  branch: `issue/${id}`,
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  machineId: asMachineId('machine-1'),
  linearId: null,
  linearIdentifier: null,
  linearUrl: null,
  activityNotes: null,
  notesUpdatedAt: null,
  suggestedStage: null,
  suggestedReason: null,
  blockedBy: [] as string[],
  dependencyNote: null,
  prUrl: null,
  priority: 2,
  type: 'task',
  assignee: null,
  parentId: null,
  design: null,
  acceptance: null,
  notes: null,
  dueAt: null,
  deferUntil: null,
  closedReason: null,
  closedAt: null,
  supersededBy: null,
  duplicateOf: null,
  pinned: false,
  estimateMin: null,
  needsHuman: false,
  humanQuestion: null,
  createdAt: 't0',
  updatedAt: 't0',
  archived: false,
})

const shipOrder = (id: string, minute: number, overrides: Partial<ShipOrder> = {}): ShipOrder =>
  ({
    id: asShipOrderId(id),
    issueId: asIssueId(`iss_${id}`),
    descendantManifest: [],
    repoId: asRepoId('repo-1'),
    repoPath: '/r',
    machineId: asMachineId('machine-1'),
    targetBranch: 'main',
    destination: 'local:main',
    approvedBaseSha: 'approved-base',
    approvedHeadSha: `head-${id}`,
    deliveryDependsOn: [],
    requestedBy: {
      actor: { kind: 'user', id: firstAdminMemberId() },
      onBehalfOf: firstAdminMemberId(),
    },
    requestedAt: `2026-08-12T10:${String(minute).padStart(2, '0')}:00.000Z`,
    policyId: 'default',
    validationProfile: VALIDATION_PROFILE,
    validationProfileDigest: createHash('sha256')
      .update(JSON.stringify(VALIDATION_PROFILE))
      .digest('hex'),
    closeMode: 'after-destination',
    state: 'queued',
    stateChangedAt: '2026-08-12T10:00:00.000Z',
    ...overrides,
  }) as ShipOrder

async function seeded(orders: readonly ShipOrder[]): Promise<SessionStore> {
  const s = await openTestStore(':memory:')
  stores.push(s)
  for (const [index, order] of orders.entries()) {
    await s.issues.upsertIssue(issue(order.issueId, index + 1))
    await s.shipping.createOrder(order)
  }
  return s
}

describe('POD-4974 O2 lane-scoped shipping reads', () => {
  it('reads one lane under every raw spelling of its destination, FIFO, queued only', async () => {
    const s = await seeded([
      shipOrder('spelled-branch', 3, { destination: 'main' }),
      shipOrder('spelled-ref', 1, { destination: 'refs/heads/main' }),
      shipOrder('spelled-local', 2),
      shipOrder('started', 0),
      // Not this lane: another branch's raw spelling, another destination,
      // another repository.
      shipOrder('other-branch', 4, { destination: 'main', targetBranch: 'dev' }),
      shipOrder('other-destination', 5, { destination: 'git:origin/main' }),
      shipOrder('other-repo', 6, { repoId: asRepoId('repo-2') }),
    ])
    await s.shipping.transitionOrder('started', 'queued', 'preflight', '2026-08-12T11:00:00.000Z')
    const lane = await s.shipping.queuedLaneOrders(asRepoId('repo-1'), 'local:main')
    expect(lane.map((order) => order.id)).toEqual([
      'spelled-ref',
      'spelled-local',
      'spelled-branch',
    ])
    expect(
      await s.shipping.laneMemberIssueIds(shipLaneId(asRepoId('repo-1'), 'local:main')),
    ).toEqual(['iss_spelled-ref', 'iss_spelled-local', 'iss_spelled-branch'])
    expect(await s.shipping.laneMemberIssueIds('not-a-lane-id')).toEqual([])
  })

  it('finds queued dependents across lanes, and scans only active orders to do it', async () => {
    const s = await seeded([
      shipOrder('dependency', 0),
      shipOrder('same-lane', 1, { deliveryDependsOn: [asShipOrderId('dependency')] }),
      shipOrder('cross-lane', 2, {
        repoId: asRepoId('repo-2'),
        deliveryDependsOn: [asShipOrderId('dependency'), asShipOrderId('elsewhere')],
      }),
      shipOrder('cancelled', 3, { deliveryDependsOn: [asShipOrderId('dependency')] }),
      shipOrder('unrelated', 4, { deliveryDependsOn: [asShipOrderId('elsewhere')] }),
    ])
    await s.shipping.transitionOrder('cancelled', 'queued', 'cancelled', '2026-08-12T11:00:00.000Z')
    expect((await s.shipping.queuedDependentsOf(['dependency'])).map((order) => order.id)).toEqual([
      'same-lane',
      'cross-lane',
    ])
    expect(await s.shipping.queuedDependentsOf([])).toEqual([])

    // The term is the partial index's own WHERE, and SQLite takes that index for
    // it: the scan is over active orders, never over shipped or cancelled history.
    const db = (s.shipping as unknown as { db: { all: (query: unknown) => Promise<unknown[]> } }).db
    const index = (await db.all(
      sql.raw(`SELECT sql FROM sqlite_master WHERE name = 'idx_ship_orders_one_active_issue'`),
    )) as { sql: string }[]
    expect(index[0]?.sql).toContain(ACTIVE_SHIP_ORDER_TERM)
    const plan = (await db.all(
      sql.raw(
        `EXPLAIN QUERY PLAN SELECT id FROM ship_orders WHERE ${ACTIVE_SHIP_ORDER_TERM} AND state = 'queued' AND EXISTS (SELECT 1 FROM json_each(delivery_depends_on) WHERE json_each.value IN ('dependency'))`,
      ),
    )) as { detail: string }[]
    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'USING INDEX idx_ship_orders_one_active_issue',
    )
  })

  it('reads open holds, receipts and stack edges only for the orders asked about', async () => {
    const s = await seeded([shipOrder('lower', 0), shipOrder('upper', 1), shipOrder('other', 2)])
    await s.shipping.recordNativeStackEdge({
      upperOrderId: asShipOrderId('upper'),
      lowerOrderId: asShipOrderId('lower'),
      recordedAt: '2026-08-12T11:00:00.000Z',
    })
    expect(await s.shipping.nativeStackEdgesFrom(['upper', 'other'])).toEqual([
      { upperOrderId: 'upper', lowerOrderId: 'lower' },
    ])
    expect(await s.shipping.nativeStackEdgesFrom(['lower'])).toEqual([])
    expect(await s.shipping.listNativeStackEdges()).toEqual([
      { upperOrderId: 'upper', lowerOrderId: 'lower' },
    ])
    expect(
      (await s.shipping.ordersByIds(['other', 'missing', 'other'])).map((order) => order.id),
    ).toEqual(['other'])
    expect((await s.shipping.openHoldsForOrders(['lower'])).size).toBe(0)
    expect((await s.shipping.receiptsForOrders(['lower'])).size).toBe(0)
  })
})
