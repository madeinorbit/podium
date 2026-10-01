import {
  asMachineId,
  asRepoId,
  asShipOrderId,
  type DeliveryReceipt,
  firstAdminMemberId,
  type ShipOrder,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { scheduledShippingProjection, shipLaneInput } from './projection'
import {
  GreenPrefixCache,
  isolateShippingTrain,
  queuedShippingLanes,
  shipLaneIdOf,
  shipLaneSchedule,
  shippingSchedule,
  withNativeStackEdges,
} from './queue'

const order = (id: string, requestedAt: string, input: Partial<ShipOrder> = {}): ShipOrder => ({
  id: asShipOrderId(id),
  issueId: `issue:${id}` as ShipOrder['issueId'],
  descendantManifest: [],
  repoId: asRepoId('repo-1'),
  repoPath: '/repo',
  machineId: asMachineId('machine-1'),
  targetBranch: 'main',
  destination: 'local:main',
  approvedBaseSha: 'base',
  approvedHeadSha: `head-${id}`,
  deliveryDependsOn: [],
  requestedBy: {
    actor: { kind: 'user', id: firstAdminMemberId() },
    onBehalfOf: firstAdminMemberId(),
  },
  requestedAt,
  policyId: 'policy-1',
  validationProfile: {
    id: 'podium-agent',
    argv: ['bun', 'run', 'test'],
    cwd: 'integration-root',
    timeoutMs: 60_000,
    resourceLocks: [],
  },
  validationProfileDigest: 'e'.repeat(64),
  closeMode: 'after-destination',
  state: 'queued',
  stateChangedAt: requestedAt,
  ...input,
})

const receipt = (item: ShipOrder, completedAt: string): DeliveryReceipt => ({
  id: `receipt:${item.id}` as DeliveryReceipt['id'],
  orderId: item.id,
  approvedBaseSha: item.approvedBaseSha,
  approvedHeadSha: item.approvedHeadSha,
  resultCommitSha: item.approvedHeadSha,
  testedIntegrationSha: item.approvedHeadSha,
  landedRefSha: item.approvedHeadSha,
  destinationSha: item.approvedHeadSha,
  validationProfileId: 'podium-agent',
  validationResult: 'passed',
  destination: item.destination,
  completedAt,
})

const cacheScope = (orders: readonly ShipOrder[]) => ({
  repoId: orders[0]!.repoId,
  targetBranch: orders[0]!.targetBranch,
  targetSha: orders[0]!.approvedBaseSha,
  destination: orders[0]!.destination,
  provider: orders[0]!.providerRef ?? null,
  repair: null,
  validationProfile: {
    id: 'podium-agent',
    argv: ['bun', 'run', 'test'],
    cwd: 'integration-root',
    timeoutMs: 60_000,
    resourceLocks: [],
  },
  members: orders.map((item, index) => ({
    orderId: item.id,
    attemptId: `attempt-${item.id}`,
    generation: index + 1,
    approvedHeadSha: item.approvedHeadSha,
  })),
})

describe('shippingSchedule', () => {
  it('O1 boot rows keep ranks and omit unused train and waitEstimate facts', () => {
    const first = order('first', '2026-08-14T10:00:00.000Z')
    const second = order('second', '2026-08-14T10:01:00.000Z', {
      deliveryDependsOn: [first.id],
    })
    const blocked = order('blocked', '2026-08-14T09:00:00.000Z', {
      deliveryDependsOn: [asShipOrderId('missing')],
    })
    const orders = [second, blocked, first]
    const rows = scheduledShippingProjection(orders, [], []).orders
    expect(rows.map(({ id, value }) => [id, value.queueRank])).toEqual([
      [second.id, 1],
      [blocked.id, undefined],
      [first.id, 1],
    ])
    for (const { value } of rows) {
      expect(value).not.toHaveProperty('train')
      expect(value).not.toHaveProperty('waitEstimate')
    }
  })

  it('groups dependency prefixes before FIFO peers without creating a global lane rank', () => {
    const a = order('a', '2026-08-14T10:00:00.000Z')
    const c = order('c', '2026-08-14T10:01:00.000Z')
    const b = order('b', '2026-08-14T10:02:00.000Z', {
      deliveryDependsOn: [a.id],
    })
    const otherLane = order('other', '2026-08-14T09:00:00.000Z', {
      destination: 'git:origin/release',
    })
    const missing = asShipOrderId('missing')
    const blocked = order('blocked', '2026-08-14T08:00:00.000Z', {
      deliveryDependsOn: [missing],
    })

    const schedule = shippingSchedule([c, b, blocked, otherLane, a])
    expect(schedule.trains.map((train) => train.orders.map((item) => item.id))).toEqual([
      [a.id, b.id, c.id],
      [otherLane.id],
    ])
    expect(
      Object.fromEntries(schedule.entries.map((entry) => [entry.order.id, entry.queueRank])),
    ).toEqual({ a: 1, b: 1, c: 1, blocked: undefined, other: 1 })
    expect(schedule.entries.find((entry) => entry.order.id === blocked.id)?.blockedBy).toEqual([
      missing,
    ])
  })

  it('O1 queue entries omit unused train and waitEstimate facts', () => {
    const waiting = order('waiting', '2026-08-14T10:00:00.000Z')
    const history = [1, 2, 3].map((index) =>
      order(`done-${index}`, `2026-08-14T0${index}:00:00.000Z`, {
        state: 'shipped',
      }),
    )
    const receipts = history.map((item) =>
      receipt(item, new Date(Date.parse(item.requestedAt) + 10 * 60_000).toISOString()),
    )
    const entry = shippingSchedule(
      [waiting, ...history],
      receipts,
      Date.parse('2026-08-14T10:05:00.000Z'),
    ).entries.find((candidate) => candidate.order.id === waiting.id)

    expect(entry?.queueRank).toBe(1)
    expect(entry).not.toHaveProperty('trainId')
    expect(entry).not.toHaveProperty('trainIndex')
    expect(entry).not.toHaveProperty('trainSize')
    expect(entry).not.toHaveProperty('waitEstimate')
  })

  it('canonicalizes equivalent local destination aliases into one lane', () => {
    const first = order('first', '2026-08-14T10:00:00.000Z', { destination: 'main' })
    const second = order('second', '2026-08-14T10:01:00.000Z', {
      destination: 'refs/heads/main',
    })
    const schedule = shippingSchedule([first, second])
    expect(schedule.entries.map((entry) => entry.queueRank)).toEqual([1, 1])
    expect(schedule.trains).toHaveLength(1)
    expect(schedule.trains[0]?.orders.map((item) => item.id)).toEqual(['first', 'second'])
  })
})

describe('isolateShippingTrain', () => {
  it('validates the full group first and reports a red union of green halves as interaction', async () => {
    const a = order('a', '2026-08-14T10:00:00.000Z')
    const b = order('b', '2026-08-14T10:01:00.000Z')
    const seen: string[][] = []
    const result = await isolateShippingTrain(
      [a, b],
      async (subset) => {
        seen.push(subset.map((item) => item.id))
        return { passed: subset.length === 1 }
      },
      new GreenPrefixCache(),
      cacheScope([a, b]),
    )

    expect(seen).toEqual([[a.id, b.id], [a.id], [b.id]])
    expect(result.interactions).toEqual([[a.id, b.id]])
    expect(result.failures).toEqual([])
  })

  it('reuses green immutable subsets and invalidates every cache entry containing a moved order', async () => {
    const a = order('a', '2026-08-14T10:00:00.000Z')
    const cache = new GreenPrefixCache()
    let validations = 0
    const validate = async () => {
      validations += 1
      return { passed: true }
    }
    await isolateShippingTrain([a], validate, cache, cacheScope([a]))
    await isolateShippingTrain([a], validate, cache, cacheScope([a]))
    expect(validations).toBe(1)
    cache.invalidateOrder(a.id)
    await isolateShippingTrain([a], validate, cache, cacheScope([a]))
    expect(validations).toBe(2)
  })

  it('keeps direct dependency components indivisible during isolation', async () => {
    const lower = order('lower', '2026-08-14T10:00:00.000Z')
    const upper = order('upper', '2026-08-14T10:01:00.000Z', {
      deliveryDependsOn: [lower.id],
    })
    const independent = order('independent', '2026-08-14T10:02:00.000Z')
    const seen: string[][] = []
    const result = await isolateShippingTrain(
      [lower, upper, independent],
      async (subset) => {
        seen.push(subset.map((item) => item.id))
        return { passed: subset.length === 1 }
      },
      new GreenPrefixCache(),
      cacheScope([lower, upper, independent]),
      true,
    )
    expect(seen).toEqual([[lower.id, upper.id], [independent.id]])
    expect(result.interactions).toEqual([[lower.id, upper.id]])
    expect(result.green).toContainEqual([independent.id])
  })

  it('never bisects or cache-aliases an immutable repaired candidate', async () => {
    const a = order('repair-a', '2026-08-14T10:00:00.000Z')
    const b = order('repair-b', '2026-08-14T10:01:00.000Z')
    const cache = new GreenPrefixCache()
    const scope = {
      ...cacheScope([a, b]),
      repair: {
        round: 2,
        contextDigest: 'c'.repeat(64),
        repairRef: 'refs/podium/ship-repair/order/attempt/1/context',
        candidateHeadSha: 'd'.repeat(40),
      },
    }
    let validations = 0
    const validate = async () => {
      validations += 1
      return { passed: true }
    }

    await isolateShippingTrain([a, b], validate, cache, scope)
    await isolateShippingTrain([a, b], validate, cache, scope)

    expect(validations).toBe(2)
  })
})

describe('POD-4974 O2 lane-scoped scheduling', () => {
  const t = (minute: number) => `2026-08-14T10:${String(minute).padStart(2, '0')}:00.000Z`
  const world = (): ShipOrder[] => {
    const shippedDependency = order('shipped-dep', t(0), {
      repoId: asRepoId('repo-2'),
      state: 'shipped',
    })
    const pendingDependency = order('pending-dep', t(1), { repoId: asRepoId('repo-2') })
    return [
      shippedDependency,
      pendingDependency,
      // One lane under three raw spellings of local:main.
      order('a', t(2), { destination: 'main' }),
      order('b', t(3), { destination: 'refs/heads/main', deliveryDependsOn: [asShipOrderId('a')] }),
      order('c', t(4), { approvedBaseSha: 'other-base' }),
      order('d', t(5), { deliveryDependsOn: [shippedDependency.id] }),
      order('e', t(6), { deliveryDependsOn: [pendingDependency.id] }),
      order('f', t(7), { deliveryDependsOn: [asShipOrderId('missing')] }),
      order('g', t(8), { state: 'preflight' }),
      order('h', t(9), { deliveryDependsOn: [asShipOrderId('g')] }),
      // A second lane in the same repository.
      order('x', t(10), { destination: 'git:origin/main' }),
      order('y', t(11), {
        destination: 'remote:origin/main',
        deliveryDependsOn: [asShipOrderId('x')],
      }),
    ]
  }

  it('O2 a lane read through its own input schedules exactly as the world schedule does', () => {
    const orders = world()
    const byId = new Map(orders.map((item) => [item.id, item]))
    const schedule = shippingSchedule(orders)
    const lanes = queuedShippingLanes(orders)
    expect(lanes.map((lane) => lane.destination).sort()).toEqual([
      'git:origin/main',
      'local:main',
      'local:main',
    ])
    for (const lane of lanes) {
      const scheduled = shipLaneSchedule(shipLaneInput(lane, [], byId))
      const laneId = shipLaneIdOf(lane.queued[0]!)
      expect(scheduled.lane.id).toBe(laneId)
      expect(scheduled.lane.trains.map((train) => train.orderIds)).toEqual(
        schedule.trains
          .filter((train) => shipLaneIdOf(train.orders[0]!) === laneId)
          .map((train) => train.orders.map((item) => item.id)),
      )
      for (const item of lane.queued) {
        const entry = schedule.entries.find((candidate) => candidate.order.id === item.id)!
        expect(scheduled.ranks.get(item.id)).toBe(entry.queueRank)
        expect(scheduled.lane.blockedOrderIds.includes(item.id)).toBe(entry.queueRank === undefined)
      }
    }
    // Non-vacuity: the fixture exercises a shipped cross-lane dependency (ranked),
    // a pending one, a missing one and an in-flight one (all blocked).
    const main = shipLaneSchedule(
      shipLaneInput(lanes.find((lane) => lane.queued.some((item) => item.id === 'd'))!, [], byId),
    )
    expect(main.ranks.get(asShipOrderId('d'))).toBeDefined()
    expect(main.lane.blockedOrderIds).toEqual(['e', 'f', 'h'])
  })

  it('O2 recorded native-stack edges rebuild the nearest set the tick infers', () => {
    const lower = order('lower', t(3))
    const middle = order('middle', t(2))
    const upper = order('upper', t(1))
    const started = order('started', t(0), { state: 'preflight' })
    const incompatible = order('incompatible', t(4), { approvedBaseSha: 'other-base' })
    const recorded = [
      // History: upper was recorded above lower before middle arrived.
      { upperOrderId: upper.id, lowerOrderId: lower.id },
      { upperOrderId: upper.id, lowerOrderId: middle.id },
      { upperOrderId: middle.id, lowerOrderId: lower.id },
      // An edge to an order that left the queue, and one across compatibility.
      { upperOrderId: upper.id, lowerOrderId: started.id },
      { upperOrderId: incompatible.id, lowerOrderId: lower.id },
    ]
    const merged = withNativeStackEdges([upper, middle, lower, incompatible], recorded)
    expect(Object.fromEntries(merged.map((item) => [item.id, item.deliveryDependsOn]))).toEqual({
      upper: [middle.id],
      middle: [lower.id],
      lower: [],
      incompatible: [],
    })
    // The tick merges exactly these nearest edges, so both plans agree.
    const tick = shippingSchedule([
      { ...upper, deliveryDependsOn: [middle.id] },
      { ...middle, deliveryDependsOn: [lower.id] },
      lower,
      incompatible,
    ])
    const lane = shipLaneSchedule({
      repoId: upper.repoId,
      destination: 'local:main',
      queued: merged,
      dependencies: [],
    })
    expect(lane.lane.trains.map((train) => train.orderIds)).toEqual(
      tick.trains.map((train) => train.orders.map((item) => item.id)),
    )
    expect(lane.lane.trains[0]!.orderIds).toEqual([lower.id, middle.id, upper.id])
  })

  it('O2 boot truth ranks over recorded edges and publishes one row per queued lane', () => {
    const lower = order('lower', t(2), { approvedHeadSha: 'lower-head' })
    const blocker = order('blocker', t(1), { approvedBaseSha: 'other-base' })
    const upper = order('upper', t(0), { approvedHeadSha: 'upper-head' })
    const done = order('done', t(3), { state: 'shipped', destination: 'git:origin/release' })
    const truth = scheduledShippingProjection(
      [upper, blocker, lower, done],
      [],
      [],
      [{ upperOrderId: upper.id, lowerOrderId: lower.id }],
    )
    expect(truth.lanes.map((row) => row.value)).toEqual([
      {
        id: shipLaneIdOf(upper),
        repoId: upper.repoId,
        destination: 'local:main',
        trains: [{ orderIds: [blocker.id] }, { orderIds: [lower.id, upper.id] }],
        blockedOrderIds: [],
      },
    ])
    expect(Object.fromEntries(truth.orders.map((row) => [row.id, row.value.queueRank]))).toEqual({
      upper: 2,
      blocker: 1,
      lower: 2,
      done: undefined,
    })
  })
})
