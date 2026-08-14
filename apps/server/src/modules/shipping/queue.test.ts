import {
  asMachineId,
  asRepoId,
  asShipOrderId,
  FIRST_ADMIN_USER_ID,
  type DeliveryReceipt,
  type ShipOrder,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { GreenPrefixCache, isolateShippingTrain, shippingSchedule } from './queue'

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
    actor: { kind: 'user', id: FIRST_ADMIN_USER_ID },
    onBehalfOf: FIRST_ADMIN_USER_ID,
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

  it('publishes a bounded estimate only from enough same-lane history', () => {
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
      history.map((item) => ({
        orderId: item.id,
        durationMs: 10 * 60_000,
        completedAt: new Date(Date.parse(item.requestedAt) + 10 * 60_000).toISOString(),
      })),
    ).entries.find((candidate) => candidate.order.id === waiting.id)

    expect(entry?.waitEstimate).toEqual({
      lowerBoundMs: 10 * 60_000,
      upperBoundMs: 10 * 60_000,
      sampleSize: 3,
      basis: 'lane-history',
    })
    expect(shippingSchedule([waiting]).entries[0]?.waitEstimate).toBeUndefined()
  })

  it('canonicalizes equivalent local destination aliases into one lane', () => {
    const first = order('first', '2026-08-14T10:00:00.000Z', { destination: 'main' })
    const second = order('second', '2026-08-14T10:01:00.000Z', {
      destination: 'refs/heads/main',
    })
    const entries = shippingSchedule([first, second]).entries
    expect(entries.map((entry) => entry.queueRank)).toEqual([1, 2])
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
})
