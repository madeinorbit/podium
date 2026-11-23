import {
  asDeliveryReceiptId,
  asIssueId,
  asMachineId,
  asRepoId,
  asShipAttemptId,
  asShipOrderId,
  asShipStepId,
  firstAdminMemberId,
  type ShipAttempt,
  type ShipOrder,
  shipLaneId,
} from '@podium/model'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openShippingStoreSlices,
  type WorkspaceShippingSlice,
} from '../test-support/shipping-store-slice'
import {
  AT,
  DESTINATION,
  hold,
  LANE_DESTINATION,
  ONLY,
  other,
  rowsOf,
  type Seeded,
  SHARED,
  scope,
  seed,
  shipOrder,
  type Tag,
  WS,
} from '../test-support/workspace-seeds/shipping'

let stores: Record<Tag, WorkspaceShippingSlice>
let seeded: Record<Tag, Seeded>

beforeEach(async () => {
  const [a, b] = await openShippingStoreSlices([WS.a, WS.b])
  stores = { a, b }
  seeded = { a: await seed(a, 'a'), b: await seed(b, 'b') }
})

afterEach(async () => {
  await stores.a.close()
})

/** No content of the other workspace, and no id only it holds, anywhere in `value`. */
function onlyOwn(value: unknown, tag: Tag): void {
  const o = other(tag)
  expect(JSON.stringify(value)).not.toMatch(
    new RegExp(`\\b${o}-|"${o} |${o} (evidence|planned|hold)|only-|"${WS[o]}"`),
  )
}

/** The sorted ids of `rows`, which hold no content of the other workspace: the ids are the
 *  same in both, so the content is what tells a crossed-over row. */
function idsOf(rows: readonly { id: string }[], tag: Tag): string[] {
  onlyOwn(rows, tag)
  return rows.map((row) => row.id).sort()
}

describe('shipping reads answer only their own workspace', () => {
  for (const tag of ['a', 'b'] as const) {
    it(`workspace ${tag} reads its own orders, attempts, steps, holds and receipts`, async () => {
      const s = stores[tag].shipping
      const mine = seeded[tag]
      // The other workspace holds the same ids (seeded) and a lane only it holds (planted).
      const theirs = await seed(stores[other(tag)], other(tag), ONLY)
      const ids = (rows: readonly { id: string }[]) => idsOf(rows, tag)
      const mineIds = [mine.one.id, mine.queued.id, mine.lower.id, mine.covering.id].sort()

      expect(ids(await s.listOrders())).toEqual(mineIds)
      expect(await s.getOrder(mine.one.id)).toMatchObject({
        id: mine.one.id,
        state: 'held',
        approvedBaseSha: `${tag}-base`,
      })
      expect(await s.getOrder(theirs.one.id)).toBeNull()
      expect((await s.activeOrderForIssue(mine.queued.issueId))?.id).toBe(mine.queued.id)
      expect(await s.activeOrderForIssue(theirs.queued.issueId)).toBeNull()
      expect(ids(await s.activeOrders())).toEqual([mine.one.id, mine.queued.id].sort())
      expect(ids(await s.resumableOrders())).toEqual([])
      expect(ids(await s.activeOrdersOfLane(mine.one.repoId, [DESTINATION]))).toEqual(
        [mine.one.id, mine.queued.id].sort(),
      )
      expect(await s.activeOrdersOfLane(theirs.one.repoId, [DESTINATION])).toEqual([])
      expect(ids(await s.queuedLaneOrders(mine.one.repoId, LANE_DESTINATION))).toEqual([
        mine.queued.id,
      ])
      expect(await s.queuedLaneOrders(theirs.one.repoId, LANE_DESTINATION)).toEqual([])
      expect(ids(await s.ordersByIds([...mineIds, theirs.one.id, theirs.queued.id]))).toEqual(
        mineIds,
      )
      expect(ids(await s.queuedDependentsOf([mine.one.id, theirs.one.id]))).toEqual([
        mine.queued.id,
      ])
      expect(await s.queuedDependentsOf([theirs.one.id])).toEqual([])
      const shipped = await s.shippedPredecessors(mine.one.repoId)
      expect(shipped.map((row) => row.order.id).sort()).toEqual(
        [mine.lower.id, mine.covering.id].sort(),
      )
      expect(await s.shippedPredecessors(theirs.one.repoId)).toEqual([])

      const mineLane = shipLaneId(mine.one.repoId, LANE_DESTINATION)
      const theirLane = shipLaneId(theirs.one.repoId, LANE_DESTINATION)
      expect(await s.laneMemberIssueIds(mineLane)).toEqual([mine.queued.issueId])
      expect(await s.laneMemberIssueIds(theirLane)).toEqual([])
      expect(await s.laneMemberIssueIdsMany([mineLane, theirLane])).toEqual(
        new Map([
          [mineLane, [mine.queued.issueId]],
          [theirLane, []],
        ]),
      )
      expect(await s.issueIdForOrder(mine.one.id)).toBe(mine.one.issueId)
      expect(await s.issueIdForOrder(theirs.one.id)).toBeNull()
      expect(await s.issueIdsForOrders([mine.one.id, theirs.one.id])).toEqual(
        new Map([[mine.one.id, mine.one.issueId]]),
      )
      expect(
        (await s.orderIdsForIssues([mine.one.issueId, theirs.one.issueId, theirs.queued.issueId]))
          .slice()
          .sort(),
      ).toEqual([mine.one.id])

      expect(await s.getAttempt(mine.attempt.id)).toMatchObject({
        id: mine.attempt.id,
        expectedTargetSha: `${tag}-target`,
      })
      expect(await s.getAttempt(theirs.attempt.id)).toBeNull()
      expect((await s.latestAttemptForOrder(mine.one.id))?.id).toBe(mine.attempt.id)
      expect(await s.latestAttemptForOrder(theirs.one.id)).toBeNull()
      expect(ids(await s.attemptsForOrder(mine.one.id))).toEqual([mine.attempt.id])
      expect(await s.attemptsForOrder(theirs.one.id)).toEqual([])

      expect(await s.stepById(mine.plannedStep.id)).toMatchObject({
        id: mine.plannedStep.id,
        summary: `${tag} planned`,
      })
      expect(await s.stepById(theirs.plannedStep.id)).toBeNull()
      expect(ids(await s.stepsForAttempt(mine.attempt.id))).toContain(mine.plannedStep.id)
      expect(await s.stepsForAttempt(theirs.attempt.id)).toEqual([])
      expect((await s.latestStepForEffect(mine.attempt.id, mine.plannedStep.effectKey))?.id).toBe(
        mine.plannedStep.id,
      )
      expect(
        await s.latestStepForEffect(theirs.attempt.id, theirs.plannedStep.effectKey),
      ).toBeNull()
      expect(await s.hasCancellationIntent(theirs.attempt.id, 1)).toBe(false)

      expect(await s.highestHoldGeneration(mine.one.id)).toBe(2)
      expect(await s.highestHoldGeneration(theirs.one.id)).toBe(0)
      expect((await s.openHoldForOrder(mine.one.id))?.generation).toBe(2)
      expect(await s.openHoldForOrder(theirs.one.id)).toBeNull()
      expect(ids(await s.listHolds())).toEqual([SHARED.hold(1), SHARED.hold(2)])
      expect([...(await s.openHoldsForOrders([mine.one.id, theirs.one.id])).keys()]).toEqual([
        mine.one.id,
      ])

      expect(await s.receiptForOrder(mine.covering.id)).toEqual(mine.coveringReceipt)
      expect(await s.receiptForOrder(theirs.covering.id)).toBeNull()
      expect(ids(await s.listReceipts())).toEqual(
        [mine.coveringReceipt.id, mine.lowerReceipt.id].sort(),
      )
      expect([
        ...(await s.receiptsForOrders([mine.lower.id, theirs.lower.id, theirs.covering.id])).keys(),
      ]).toEqual([mine.lower.id])
    })

    it(`workspace ${tag} reads its own trains, stack edges, evidence and recovery work`, async () => {
      const s = stores[tag].shipping
      const mine = seeded[tag]
      // The other workspace holds the same ids (seeded) and a lane only it holds (planted).
      const theirs = await seed(stores[other(tag)], other(tag), ONLY)

      expect(await s.trainManifestForAttempt(mine.coveringAttempt.id)).toEqual(mine.manifest)
      expect(await s.trainManifestForAttempt(theirs.coveringAttempt.id)).toBeNull()
      expect(await s.activeTrainForOrder(theirs.covering.id)).toBeNull()
      expect(await s.activeTrainsForLane(theirs.covering)).toEqual([])
      // The covering leader shipped and its train is still open: each workspace sees its own.
      expect(await s.shippedLeadersOfOpenTrains()).toEqual([mine.covering.id])

      expect(await s.nativeStackEdgesFrom([mine.queued.id, theirs.queued.id])).toEqual([
        { upperOrderId: mine.queued.id, lowerOrderId: mine.one.id },
      ])
      expect(await s.listNativeStackEdges()).toEqual([
        { upperOrderId: mine.queued.id, lowerOrderId: mine.one.id },
      ])
      expect(await s.hasNativeStackEdge(mine.queued.id, mine.one.id)).toBe(true)
      expect(await s.hasNativeStackEdge(theirs.queued.id, theirs.one.id)).toBe(false)

      // The same custody and source, each workspace's own content (so its own ref).
      expect(mine.evidenceRef).not.toBe(seeded[other(tag)].evidenceRef)
      expect((await s.shippingEvidence(mine.evidenceRef))?.ref).toBe(mine.evidenceRef)
      expect(await s.shippingEvidence(seeded[other(tag)].evidenceRef)).toBeNull()
      expect(await s.shippingEvidence(theirs.evidenceRef)).toBeNull()
      expect(
        (await s.shippingEvidenceForSource(mine.evidenceCustody, mine.evidenceSource))?.ref,
      ).toBe(mine.evidenceRef)
      expect(
        await s.shippingEvidenceForSource(theirs.evidenceCustody, theirs.evidenceSource),
      ).toBeNull()

      expect(
        (await s.repairCandidatesForAttempt(mine.attempt.id)).map((c) => c.candidateHeadSha),
      ).toEqual([`${tag}-candidate`])
      expect(await s.repairCandidatesForAttempt(theirs.attempt.id)).toEqual([])
      expect((await s.repairCandidateAtSequence(mine.attempt.id, 1))?.candidateHeadSha).toBe(
        `${tag}-candidate`,
      )
      expect(await s.repairCandidateAtSequence(theirs.attempt.id, 1)).toBeUndefined()

      expect(
        (await s.rootIntegrationReceipt(mine.one.issueId, mine.one.approvedHeadSha))?.rootIssueId,
      ).toBe(mine.one.issueId)
      expect(
        await s.rootIntegrationReceipt(theirs.one.issueId, theirs.one.approvedHeadSha),
      ).toBeNull()

      const work = [
        ...(await s.recoveryWork('descendants')),
        ...(await s.recoveryWork('repair-ack')),
        ...(await s.recoveryWork('daemon-ack')),
      ]
      expect(work.length).toBeGreaterThan(0)
      expect(work.every((row) => row.workspaceId === WS[tag])).toBe(true)
      expect(work.map((row) => row.key)).toContain(`admission:${mine.queued.id}:new`)
      expect(work.map((row) => row.key)).not.toContain(`admission:${theirs.queued.id}:new`)
    })
  }

  it('reads and advances each workspace its own recovery revision', async () => {
    // One row per workspace, keyed (workspace_id, id = 1) since POD-7024: A's ('local') was
    // seeded by the shipping migration, B's is made by its first advance (its seeding may
    // already have made it). Each advance moves its own workspace's revision only.
    const revisionOf = async (tag: Tag) => await stores[tag].shipping.recoveryRevision()
    const a0 = await revisionOf('a')
    const b0 = await revisionOf('b')
    await stores.a.shipping.assertRecoveryRevision(scope, a0)
    await stores.b.shipping.assertRecoveryRevision(scope, b0)
    const at = '2026-11-17T11:00:00.000Z'
    await stores.b.shipping.resolveHold(scope, seeded.b.one.id, 2, 'retry', 'queued', at)
    expect(await revisionOf('b')).toBe(b0 + 1)
    expect(await revisionOf('a')).toBe(a0)
    await stores.a.shipping.resolveHold(scope, seeded.a.one.id, 2, 'retry', 'queued', at)
    expect(await revisionOf('a')).toBe(a0 + 1)
    expect(await revisionOf('b')).toBe(b0 + 1)
    const rows = (
      await stores.a.all<{ workspaceId: string; revision: number }>(
        sql`SELECT workspace_id AS "workspaceId", revision FROM ship_recovery_revision`,
      )
    ).map((row) => ({ ...row, revision: Number(row.revision) }))
    expect(rows.sort((x, y) => x.workspaceId.localeCompare(y.workspaceId))).toEqual(
      [
        { workspaceId: WS.a, revision: a0 + 1 },
        { workspaceId: WS.b, revision: b0 + 1 },
      ].sort((x, y) => x.workspaceId.localeCompare(y.workspaceId)),
    )
    await expect(stores.b.shipping.assertRecoveryRevision(scope, b0)).rejects.toThrow(
      /revision fence failed/,
    )
  })
})

describe("shipping writes in one workspace leave the other's rows unchanged", () => {
  for (const tag of ['a', 'b'] as const) {
    it(`writes in workspace ${tag} aimed at ids only the other workspace holds change nothing there`, async () => {
      const s = stores[tag].shipping
      const theirTag = other(tag)
      // A lane of ids only the other workspace holds, seeded as the shared one is.
      const theirs = await seed(stores[theirTag], theirTag, ONLY)
      const before = await rowsOf(stores[theirTag], theirTag)
      const at = '2026-11-17T11:00:00.000Z'
      const attemptOf = (order: ShipOrder, attempt: ShipAttempt) => ({
        orderId: order.id,
        expectedState: 'held' as const,
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
      })

      // Order and attempt writes on the other's held order `one` and queued order.
      await expect(
        s.transitionOrder(scope, theirs.queued.id, 'queued', 'preflight', at),
      ).rejects.toThrow()
      await expect(
        s.claimAttempt(scope, {
          orderId: theirs.queued.id,
          expectedState: 'queued',
          expectedAttemptId: null,
          expectedGeneration: 0,
          machineId: theirs.ids.machine,
          startedAt: at,
        }),
      ).rejects.toThrow(/unknown ship order/)
      await expect(
        s.createAttempt(scope, {
          ...theirs.attempt,
          id: asShipAttemptId(`${tag}-aimed-attempt`),
          leaseGeneration: 2,
        }),
      ).rejects.toThrow()
      await expect(
        s.finishAttempt(scope, theirs.attempt.id, theirs.attempt.leaseGeneration, {
          finishedAt: at,
          outcome: 'failed',
        }),
      ).rejects.toThrow()
      expect(await s.hasAttemptCustody(attemptOf(theirs.one, theirs.attempt))).toBe(false)
      await expect(
        s.assertEffectDispatchCustody({
          ...attemptOf(theirs.one, theirs.attempt),
          effectKey: theirs.plannedStep.effectKey,
          operation: 'validation',
        }),
      ).rejects.toThrow()
      await expect(
        s.appendStep(scope, {
          ...theirs.plannedStep,
          id: asShipStepId(`${tag}-aimed-step`),
          idempotencyKey: `${tag}-aimed`,
        }),
      ).rejects.toThrow()
      await expect(
        s.requestCancellation(scope, {
          ...attemptOf(theirs.one, theirs.attempt),
          planned: { ...theirs.plannedStep, id: asShipStepId(`${tag}-aimed-cancel-planned`) },
          running: { ...theirs.plannedStep, id: asShipStepId(`${tag}-aimed-cancel-running`) },
        }),
      ).rejects.toThrow(/fence failed/)
      await expect(s.cancelAttemptAndOrder(scope, theirs.queued.id, 'queued', at)).rejects.toThrow(
        /cancellation fence failed/,
      )

      // Holds on the other's order.
      await expect(s.raiseHold(scope, hold(theirTag, theirs.one.id, 3, ONLY))).rejects.toThrow(
        /unknown ship order/,
      )
      await expect(s.resolveHold(scope, theirs.one.id, 2, 'retry', 'queued', at)).rejects.toThrow()
      await expect(
        s.commitCustodyHold(scope, {
          ...attemptOf(theirs.one, theirs.attempt),
          hold: hold(theirTag, theirs.one.id, 3, ONLY),
          attemptFinishedAt: at,
        }),
      ).rejects.toThrow(/fence failed/)
      await expect(
        s.commitCancellationHold(scope, {
          ...attemptOf(theirs.one, theirs.attempt),
          intentKey: 'cancel:1',
          terminalStep: theirs.plannedStep,
          hold: hold(theirTag, theirs.one.id, 3, ONLY),
          attemptFinishedAt: at,
        }),
      ).rejects.toThrow()
      const effect = {
        ...attemptOf(theirs.one, theirs.attempt),
        effectKey: theirs.plannedStep.effectKey,
        operation: 'validation' as const,
        terminalStep: { ...theirs.plannedStep, id: asShipStepId(`${tag}-aimed-terminal`) },
        outcome: { kind: 'transition' as const, nextState: 'queued' as const, stateChangedAt: at },
      }
      await expect(s.commitEffectResult(scope, effect)).rejects.toThrow()

      // Trains: the other's shipped train and its leader.
      await expect(
        s.claimTrain(scope, {
          leaderOrderId: theirs.queued.id,
          startedAt: at,
          members: [{ orderId: theirs.queued.id }],
        }),
      ).rejects.toThrow(/not queued/)
      await expect(s.releaseTrain(scope, theirs.manifest.id, at, 'aimed')).rejects.toThrow(
        /unknown ship train/,
      )
      await expect(
        s.isolateTrainFailure(scope, {
          trainId: theirs.manifest.id,
          leaderOrderId: theirs.covering.id,
          leaderAttemptId: theirs.coveringAttempt.id,
          generation: theirs.coveringAttempt.leaseGeneration,
          terminalStep: theirs.plannedStep,
          failureOrderIds: [theirs.lower.id],
          isolatedAt: at,
          detail: 'aimed',
        }),
      ).rejects.toThrow()
      await expect(
        s.completeVerifiedTrain(scope, {
          leader: { ...effect, orderId: theirs.covering.id, expectedState: 'verifying' },
          covered: [],
          release: { trainId: theirs.manifest.id, releasedAt: at, reason: 'aimed' },
        }),
      ).rejects.toThrow()

      // Completion, stack edges, evidence, receipts and recovery work.
      await expect(
        s.completeVerifiedOrder(scope, {
          ...theirs.coveringReceipt,
          id: asDeliveryReceiptId(`${tag}-aimed-receipt`),
        }),
      ).rejects.toThrow()
      await expect(
        s.completeCoveredOrder(scope, theirs.lowerReceipt, theirs.covering.id, theirs.envelopeKey),
      ).rejects.toThrow()
      await expect(
        s.recordNativeStackEdge(scope, {
          upperOrderId: theirs.one.id,
          lowerOrderId: theirs.queued.id,
          recordedAt: at,
        }),
      ).rejects.toThrow(/invalid native stack edge/)
      await expect(
        s.createOrder(scope, shipOrder(theirTag, 'aimed', { issueId: theirs.one.issueId }, ONLY)),
      ).rejects.toThrow()
      await expect(
        s.createOrReturnActiveOrder(
          scope,
          shipOrder(theirTag, 'aimed', { issueId: theirs.queued.issueId }, ONLY),
        ),
      ).rejects.toThrow()
      await s.completeRecoveryWork(scope, `admission:${theirs.queued.id}:new`)
      await s.completeRepairAcknowledgement(scope, ONLY.token)

      expect(await rowsOf(stores[theirTag], theirTag)).toEqual(before)
    })
  }

  it("writes of the ids both hold land in their own workspace and leave the other's rows unchanged", async () => {
    const beforeB = await rowsOf(stores.b, 'b')
    const s = stores.a.shipping
    const mine = seeded.a
    const at = '2026-11-17T11:00:00.000Z'
    await s.cancelAttemptAndOrder(scope, mine.queued.id, 'queued', at)
    await s.releaseTrain(scope, mine.manifest.id, at, 'done')
    await s.completeRecoveryWork(scope, `admission:${mine.queued.id}:new`)
    await s.queueAdmissionInvalidation(scope, mine.one.id, mine.covering.id, 'sha', 'again')
    await s.resolveHold(scope, mine.one.id, 2, 'retry', 'queued', at)
    await s.completeRepairAcknowledgement(scope, SHARED.token)
    expect((await s.getOrder(mine.queued.id))?.state).toBe('cancelled')
    expect((await s.getOrder(mine.one.id))?.state).toBe('queued')
    expect(await s.shippedLeadersOfOpenTrains()).toEqual([])
    expect(await rowsOf(stores.b, 'b')).toEqual(beforeB)
    expect(await stores.b.shipping.shippedLeadersOfOpenTrains()).toEqual([seeded.b.covering.id])
    // B's rows of the same ids read as they were.
    expect((await stores.b.shipping.getOrder(mine.queued.id))?.state).toBe('queued')
    expect((await stores.b.shipping.getOrder(mine.one.id))?.state).toBe('held')
    expect((await stores.b.shipping.openHoldForOrder(mine.one.id))?.generation).toBe(2)
  })
})

/**
 * THE SAME ID CREATED FIRST IN THE OTHER WORKSPACE (POD-7024): every key and ON CONFLICT target leads with
 * workspace_id, so an order A creates with an id B already holds is A's own row in a lane
 * both workspaces name alike, B's rows stay byte for byte as they were, and A's next writes
 * of that id and that lane (the lane-revision upsert, a transition) change A's rows only.
 */
describe('the same id in both workspaces, upserted through the repository (POD-7024)', () => {
  it("makes a second row, leaves the other workspace's as it was, and updates only its own", async () => {
    const SAME = asShipOrderId('same-order')
    const sameIssue = (name: string) => asIssueId(`same-iss-${name}`)
    for (const tag of ['a', 'b'] as const) {
      for (const [name, seq] of [
        ['one', 101],
        ['two', 102],
      ] as const) {
        await stores[tag].run(
          sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id,
               machine_id, branch, seq, title, stage, default_agent, created_at, updated_at)
             VALUES (${WS[tag]}, ${sameIssue(name)}, ${firstAdminMemberId()}, ${firstAdminMemberId()},
               '/r-same', 'same-repo', 'same-machine', ${`issue/same-${name}`}, ${seq},
               ${`same issue ${name}`}, 'review', 'codex', ${AT}, ${AT})`,
        )
      }
    }
    const sameOrder = (id: ShipOrder['id'], name: string) =>
      shipOrder('a', 'one', {
        id,
        issueId: sameIssue(name),
        repoId: asRepoId('same-repo'),
        repoPath: '/r-same',
        machineId: asMachineId('same-machine'),
        approvedBaseSha: 'same-base',
        approvedHeadSha: `same-${name}-head`,
      })
    const laneRows = async (tag: Tag) =>
      (
        await stores[tag].all<{ lane_key: string; revision: number }>(
          sql`SELECT lane_key, revision FROM ship_lane_revisions WHERE workspace_id = ${WS[tag]}`,
        )
      ).map((row) => ({ ...row, revision: Number(row.revision) }))
    const ordersOf = async (tag: Tag) =>
      await stores[tag].all(
        sql`SELECT id FROM ship_orders WHERE workspace_id = ${WS[tag]} AND id = ${SAME}`,
      )

    const lanesBefore = new Set((await laneRows('b')).map((row) => row.lane_key))
    await stores.b.shipping.createOrder(scope, sameOrder(SAME, 'one'))
    const lane = (await laneRows('b')).find((row) => !lanesBefore.has(row.lane_key))?.lane_key
    expect(lane).toBeDefined()
    const before = await rowsOf(stores.b, 'b')

    await stores.a.shipping.createOrder(scope, sameOrder(SAME, 'one'))
    expect(await ordersOf('a')).toHaveLength(1)
    expect((await laneRows('a')).find((row) => row.lane_key === lane)?.revision).toBe(1)
    expect(await rowsOf(stores.b, 'b')).toEqual(before)

    // The lane-revision upsert hits A's row of the lane, and the transition A's order.
    await stores.a.shipping.createOrder(scope, sameOrder(asShipOrderId('same-order-2'), 'two'))
    await stores.a.shipping.transitionOrder(scope, SAME, 'queued', 'cancelled', AT)
    expect((await laneRows('a')).find((row) => row.lane_key === lane)?.revision).toBe(2)
    expect((await stores.a.shipping.getOrder(SAME))?.state).toBe('cancelled')
    expect((await stores.b.shipping.getOrder(SAME))?.state).toBe('queued')
    expect((await laneRows('b')).find((row) => row.lane_key === lane)?.revision).toBe(1)
    expect(await rowsOf(stores.b, 'b')).toEqual(before)
  })
})
