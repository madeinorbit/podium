/**
 * SHIPPING IS A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7018).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * `ShippingRepository` with one lane's worth of shipping: a held order with an attempt, steps,
 * holds and a repair candidate; a queued order that depends on it and stacks on it; a two-member
 * train that shipped (manifest, members, claims, lane revision, effect envelope, both delivery
 * receipts, the covered completion); shipwright evidence, a root integration receipt and
 * recovery work. The ids and names differ between the workspaces: until the key migration (C1,
 * POD-7024) no unique constraint includes `workspace_id`, so the same id in both would collide
 * on the old key.
 *
 * For every repository method of `store/shipping.ts`:
 *   - a read answers only its own workspace's rows, including the whole-table listings, the
 *     scheduler's FIFO walks, the lane reads and the joins (train authority, claims, leaders);
 *   - a write in one workspace aimed at the other's ids (transition, claim, hold, resolve,
 *     cancel, finish, complete, release, isolate, stack edge, recovery work) finds nothing of
 *     the other's, and the other's rows stay byte for byte as they were.
 *
 * `store/guarded-move.ts` holds no statement of its own: its callers own the UPDATE.
 *
 * THE RECOVERY REVISION IS A SINGLETON with key `id = 1` until C1 rekeys it per workspace, so
 * only the boot workspace holds a row. Workspace A is the self-hosted one ('local') so that the
 * row is A's; B reads none and says so, and B's receipts do not advance A's revision.
 */

import { createHash } from 'node:crypto'
import {
  asDeliveryReceiptId,
  asIssueId,
  asMachineId,
  asRepoId,
  asShipAttemptId,
  asShipHoldId,
  asShipOrderId,
  asShipStepId,
  canonicalShippingDestination,
  type DeliveryReceipt,
  firstAdminMemberId,
  type IssueId,
  type ShipAttempt,
  type ShipOrder,
  type ShipStep,
  type ShipTrainManifest,
  shipLaneId,
} from '@podium/model'
import { shippingJobRequestFingerprint } from '@podium/protocol/daemon'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openWorkspaceStores } from '../test-support/workspace-stores'

type Tag = 'a' | 'b'
const WS: Record<Tag, string> = { a: 'local', b: 'ws_b' }
const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
const scope = fixtureWriteScope()
const AT = '2026-11-17T10:00:00.000Z'

const VALIDATION_PROFILE = {
  id: 'default',
  argv: ['bun', 'run', 'test'],
  cwd: 'integration-root' as const,
  timeoutMs: 60_000,
  resourceLocks: [] as string[],
}

const issueId = (tag: Tag, name: string): IssueId => asIssueId(`${tag}-iss-${name}`)
const orderId = (tag: Tag, name: string) => asShipOrderId(`${tag}-order-${name}`)
const machine = (tag: Tag) => asMachineId(`${tag}-machine`)
const repo = (tag: Tag) => asRepoId(`${tag}-repo`)
const repoPath = (tag: Tag) => `/r-${tag}`
const DESTINATION = 'origin/main'
/** The lane's canonical destination, as lane ids and lane reads name it. */
const LANE_DESTINATION = canonicalShippingDestination(DESTINATION, 'main')

interface RawDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

/** The tables `store/shipping.ts` reads and writes, read raw per workspace. */
const TABLES = [
  'ship_orders',
  'ship_attempts',
  'ship_steps',
  'ship_holds',
  'delivery_receipts',
  'ship_evidence',
  'ship_repair_candidates',
  'root_integration_receipts',
  'ship_lane_revisions',
  'ship_recovery_work',
  'ship_recovery_revision',
  'ship_order_stack_edges',
  'ship_train_manifests',
  'ship_train_members',
  'ship_train_active_claims',
  'ship_effect_envelopes',
  'issues',
] as const

function rowsOf(store: SessionStore, tag: Tag): Record<string, unknown[]> {
  const db = rawDb(store)
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`).all(WS[tag]),
    ]),
  )
}

/** An issue row, raw: the issues repository is another task's (B2). */
function insertIssue(store: SessionStore, tag: Tag, name: string, seq: number): void {
  rawDb(store)
    .prepare(
      `INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id,
         machine_id, branch, seq, title, stage, default_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'review', 'codex', ?, ?)`,
    )
    .run(
      WS[tag],
      issueId(tag, name),
      firstAdminMemberId(),
      firstAdminMemberId(),
      repoPath(tag),
      repo(tag),
      machine(tag),
      `issue/${tag}-${name}`,
      seq,
      `${tag} issue ${name}`,
      AT,
      AT,
    )
}

function shipOrder(tag: Tag, name: string, overrides: Partial<ShipOrder> = {}): ShipOrder {
  return {
    id: orderId(tag, name),
    issueId: issueId(tag, name),
    descendantManifest: [],
    repoId: repo(tag),
    repoPath: repoPath(tag),
    machineId: machine(tag),
    targetBranch: 'main',
    destination: DESTINATION,
    approvedBaseSha: `${tag}-base`,
    approvedHeadSha: `${tag}-${name}-head`,
    deliveryDependsOn: [],
    requestedBy: {
      actor: { kind: 'user', id: firstAdminMemberId() },
      onBehalfOf: firstAdminMemberId(),
    },
    requestedAt: '2026-11-17T09:00:00.000Z',
    policyId: 'default',
    validationProfile: VALIDATION_PROFILE,
    validationProfileDigest: createHash('sha256')
      .update(JSON.stringify(VALIDATION_PROFILE))
      .digest('hex'),
    closeMode: 'after-destination',
    state: 'queued',
    stateChangedAt: '2026-11-17T09:00:00.000Z',
    ...overrides,
  } as ShipOrder
}

/** What one workspace's seed made, by id, for the reads and the aimed writes. */
interface Seeded {
  one: ShipOrder
  queued: ShipOrder
  lower: ShipOrder
  covering: ShipOrder
  attempt: ShipAttempt
  plannedStep: ShipStep
  manifest: ShipTrainManifest
  coveringAttempt: ShipAttempt
  lowerReceipt: DeliveryReceipt
  coveringReceipt: DeliveryReceipt
  envelopeKey: string
  evidenceRef: string
  evidenceCustody: string
  evidenceSource: string
}

async function seed(store: SessionStore, tag: Tag): Promise<Seeded> {
  const s = store.shipping
  insertIssue(store, tag, 'one', 1)
  insertIssue(store, tag, 'queued', 2)
  insertIssue(store, tag, 'lower', 3)
  insertIssue(store, tag, 'covering', 4)

  // The single-order arm: order `one` held with an attempt, steps, two holds (one
  // resolved, one open) and a repair candidate.
  const one = shipOrder(tag, 'one')
  await s.createOrder(scope, one)
  const attempt: ShipAttempt = {
    id: asShipAttemptId(`${tag}-attempt-one`),
    orderId: one.id,
    expectedSourceBaseSha: one.approvedBaseSha,
    approvedHeadSha: one.approvedHeadSha,
    expectedTargetSha: `${tag}-target`,
    machineId: machine(tag),
    leaseGeneration: 1,
    startedAt: '2026-11-17T09:01:00.000Z',
    submittedHeadSha: one.approvedHeadSha,
  }
  await s.createAttempt(scope, attempt)
  const plannedStep: ShipStep = {
    id: asShipStepId(`${tag}-step-planned`),
    orderId: one.id,
    attemptId: attempt.id,
    effectKey: `${tag}-validation`,
    idempotencyKey: `${tag}-validate:planned`,
    generation: attempt.leaseGeneration,
    inputFence: {
      sourceBaseSha: attempt.expectedSourceBaseSha,
      approvedHeadSha: attempt.approvedHeadSha,
      targetSha: attempt.expectedTargetSha,
    },
    kind: 'validation',
    state: 'planned',
    summary: `${tag} planned`,
    recordedAt: '2026-11-17T09:02:00.000Z',
  }
  await s.appendStep(scope, plannedStep)
  await s.raiseHold(scope, hold(tag, one.id, 1))
  await s.resolveHold(scope, one.id, 1, 'retry', 'queued', '2026-11-17T09:03:30.000Z')
  await s.raiseHold(scope, hold(tag, one.id, 2))
  rawDb(store)
    .prepare(
      `INSERT INTO ship_repair_candidates (workspace_id, order_id, attempt_id, generation, sequence,
         round, context_digest, repair_ref, candidate_head_sha, result_token, recorded_at)
       VALUES (?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      WS[tag],
      one.id,
      attempt.id,
      'c'.repeat(64),
      `refs/repair/${tag}`,
      `${tag}-candidate`,
      `${tag}-token`,
      AT,
    )

  // The queued order: depends on `one` and stacks on it, so the dependents and stack reads
  // have rows.
  const queued = shipOrder(tag, 'queued', { deliveryDependsOn: [one.id] })
  await s.createOrder(scope, queued)
  await s.recordNativeStackEdge(scope, {
    upperOrderId: queued.id,
    lowerOrderId: one.id,
    recordedAt: '2026-11-17T09:04:00.000Z',
  })

  // The shipped train: lower + covering, the covering leader verified, lower covered by it.
  const lower = shipOrder(tag, 'lower')
  const covering = shipOrder(tag, 'covering', { deliveryDependsOn: [lower.id] })
  await s.createOrder(scope, lower)
  await s.createOrder(scope, covering)
  const train = await s.claimTrain(scope, {
    leaderOrderId: covering.id,
    startedAt: '2026-11-17T09:05:00.000Z',
    members: [{ orderId: lower.id }, { orderId: covering.id }],
  })
  const claimed = train.claimed.find((item) => item.order.id === covering.id)
  if (!claimed) throw new Error('the covering order was not claimed')
  for (const [from, to] of [
    ['preflight', 'composing'],
    ['composing', 'validating'],
    ['validating', 'landing'],
    ['landing', 'publishing'],
    ['publishing', 'verifying'],
  ] as const) {
    await s.transitionOrder(scope, covering.id, from, to, '2026-11-17T09:06:00.000Z')
  }
  const completedAt = '2026-11-17T09:07:00.000Z'
  const landed = `${tag}-landed`
  await s.finishAttempt(scope, claimed.attempt.id, claimed.attempt.leaseGeneration, {
    finishedAt: completedAt,
    outcome: 'succeeded',
    testedIntegrationSha: landed,
    landedRefSha: landed,
    destinationSha: landed,
    validationProfileId: 'default',
    validationResult: 'passed',
  })
  const coveringReceipt: DeliveryReceipt = {
    id: asDeliveryReceiptId(`${tag}-receipt-covering`),
    orderId: covering.id,
    approvedBaseSha: covering.approvedBaseSha,
    approvedHeadSha: covering.approvedHeadSha,
    resultCommitSha: landed,
    testedIntegrationSha: landed,
    landedRefSha: landed,
    destinationSha: landed,
    validationProfileId: 'default',
    validationResult: 'passed',
    destination: covering.destination,
    completedAt,
  }
  await s.completeVerifiedOrder(scope, coveringReceipt)
  const lowerReceipt: DeliveryReceipt = {
    ...coveringReceipt,
    id: asDeliveryReceiptId(`${tag}-receipt-lower`),
    orderId: lower.id,
    approvedHeadSha: lower.approvedHeadSha,
    resultCommitSha: lower.approvedHeadSha,
  }
  const requestFacts = {
    jobId: `${claimed.attempt.id}:verify`,
    orderId: covering.id,
    attemptId: claimed.attempt.id,
    generation: claimed.attempt.leaseGeneration,
    operation: 'verify' as const,
    shippingProtocolVersion: 2 as const,
    repoPath: train.manifest.lane.repoPath,
    repoId: covering.repoId,
    sourceBranch: `issue/${tag}-covering`,
    targetBranch: covering.targetBranch,
    approvedBaseSha: covering.approvedBaseSha,
    approvedHeadSha: covering.approvedHeadSha,
    expectedTargetSha: covering.approvedBaseSha,
    destination: DESTINATION,
    policyId: covering.policyId,
    validationProfile: VALIDATION_PROFILE,
    train: {
      version: 2 as const,
      capability: 'shipping.train.v2' as const,
      manifest: train.manifest,
      subsetId: train.manifest.subsetId,
      memberOrderIds: train.manifest.members.map((member) => member.orderId),
      repairRound: 0,
      candidate: { kind: 'approved' as const },
    },
  }
  const requestDigest = createHash('sha256')
    .update(shippingJobRequestFingerprint(requestFacts))
    .digest('hex')
  const envelopeKey = await s.recordEffectEnvelope(scope, {
    request: { action: 'start', requestDigest, ...requestFacts },
    result: {
      jobId: requestFacts.jobId,
      requestDigest,
      orderId: covering.id,
      attemptId: claimed.attempt.id,
      machineId: claimed.attempt.machineId,
      generation: claimed.attempt.leaseGeneration,
      operation: 'verify',
      state: 'succeeded',
      classification: 'proved',
      summary: 'verified',
      observedDestinationSha: landed,
      testedIntegrationSha: landed,
      landedRefSha: landed,
      validationProfileId: 'default',
      validationResult: 'passed',
      trainProofs: train.manifest.members.map((member) => ({
        issueId: member.issueId,
        orderId: member.orderId,
        attemptId: member.attemptId,
        generation: member.generation,
        sourceApprovedSha: member.approvedHeadSha,
        resultCommitSha:
          member.orderId === lower.id ? lower.approvedHeadSha : covering.approvedHeadSha,
        testedIntegrationSha: landed,
        landedRefSha: landed,
        providerLandedRefSha: landed,
        destinationSha: landed,
      })),
      logs: [],
      artifactRefs: [],
      heartbeatedAt: completedAt,
      finishedAt: completedAt,
    },
    recordedAt: completedAt,
  })
  await s.completeCoveredOrder(scope, lowerReceipt, covering.id, envelopeKey)

  // Evidence, the root integration receipt and one admission invalidation.
  const content = `${tag} evidence`
  const evidenceCustody = createHash('sha256').update(`${tag}-custody`).digest('hex')
  const evidenceSource = `${tag}-source`
  const contentDigest = createHash('sha256').update(content).digest('hex')
  const evidenceRef = `artifact://shipwright/${createHash('sha256')
    .update(`${evidenceCustody}\0${evidenceSource}\0${contentDigest}`)
    .digest('hex')}`
  await s.recordShippingEvidence({
    ref: evidenceRef,
    custodyDigest: evidenceCustody,
    contentDigest,
    sourceRef: evidenceSource,
    content,
    materializedAt: AT,
  })
  await s.recordRootIntegrationReceipt({
    rootIssueId: one.issueId,
    approvedHeadSha: one.approvedHeadSha,
    descendants: [{ issueId: queued.issueId, approvedHeadSha: queued.approvedHeadSha }],
  })
  await s.queueAdmissionInvalidation(scope, queued.id, covering.id, landed)

  return {
    one,
    queued,
    lower,
    covering,
    attempt,
    plannedStep,
    manifest: train.manifest,
    coveringAttempt: claimed.attempt,
    lowerReceipt,
    coveringReceipt,
    envelopeKey,
    evidenceRef,
    evidenceCustody,
    evidenceSource,
  }
}

function hold(tag: Tag, order: ShipOrder['id'], generation: number) {
  return {
    id: asShipHoldId(`${tag}-hold-${generation}`),
    orderId: order,
    generation,
    reasonCode: 'validation-failed' as const,
    headline: `${tag} hold ${generation}`,
    detail: 'The configured validation profile failed.',
    evidenceRefs: [],
    actions: ['retry' as const],
    raisedAt: `2026-11-17T09:0${2 + generation}:00.000Z`,
  }
}

let stores: Record<Tag, SessionStore>
let seeded: Record<Tag, Seeded>

beforeEach(async () => {
  const [a, b] = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  stores = { a, b }
  seeded = { a: await seed(a, 'a'), b: await seed(b, 'b') }
})

afterEach(async () => {
  await stores.a.close()
})

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id).sort()

describe('shipping reads answer only their own workspace', () => {
  for (const tag of ['a', 'b'] as const) {
    it(`workspace ${tag} reads its own orders, attempts, steps, holds and receipts`, async () => {
      const s = stores[tag].shipping
      const mine = seeded[tag]
      const theirs = seeded[other(tag)]
      const mineIds = [mine.one.id, mine.queued.id, mine.lower.id, mine.covering.id].sort()

      expect(ids(await s.listOrders())).toEqual(mineIds)
      expect(await s.getOrder(mine.one.id)).toMatchObject({ id: mine.one.id, state: 'held' })
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

      expect(await s.getAttempt(mine.attempt.id)).toMatchObject({ id: mine.attempt.id })
      expect(await s.getAttempt(theirs.attempt.id)).toBeNull()
      expect((await s.latestAttemptForOrder(mine.one.id))?.id).toBe(mine.attempt.id)
      expect(await s.latestAttemptForOrder(theirs.one.id)).toBeNull()
      expect(ids(await s.attemptsForOrder(mine.one.id))).toEqual([mine.attempt.id])
      expect(await s.attemptsForOrder(theirs.one.id)).toEqual([])

      expect(await s.stepById(mine.plannedStep.id)).toMatchObject({ id: mine.plannedStep.id })
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
      expect(ids(await s.listHolds())).toEqual([`${tag}-hold-1`, `${tag}-hold-2`])
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
      const theirs = seeded[other(tag)]

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

      expect((await s.shippingEvidence(mine.evidenceRef))?.ref).toBe(mine.evidenceRef)
      expect(await s.shippingEvidence(theirs.evidenceRef)).toBeNull()
      expect(
        (await s.shippingEvidenceForSource(mine.evidenceCustody, mine.evidenceSource))?.ref,
      ).toBe(mine.evidenceRef)
      expect(
        await s.shippingEvidenceForSource(theirs.evidenceCustody, theirs.evidenceSource),
      ).toBeNull()

      expect(
        (await s.repairCandidatesForAttempt(mine.attempt.id)).map((c) => c.resultToken),
      ).toEqual([`${tag}-token`])
      expect(await s.repairCandidatesForAttempt(theirs.attempt.id)).toEqual([])
      expect((await s.repairCandidateAtSequence(mine.attempt.id, 1))?.resultToken).toBe(
        `${tag}-token`,
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

  it('reads and advances the singleton recovery revision of its own workspace only (one row until C1)', async () => {
    // A ('local') holds the migration's row. B holds none, so it reads none.
    const rows = rawDb(stores.a)
      .prepare('SELECT workspace_id AS workspaceId, revision FROM ship_recovery_revision')
      .all() as { workspaceId: string; revision: number }[]
    expect(rows).toEqual([{ workspaceId: WS.a, revision: expect.any(Number) }])
    const revision = rows[0]!.revision
    expect(await stores.a.shipping.recoveryRevision()).toBe(revision)
    await stores.a.shipping.assertRecoveryRevision(scope, revision)
    await expect(stores.b.shipping.recoveryRevision()).rejects.toThrow(/revision is missing/)
    await expect(stores.b.shipping.assertRecoveryRevision(scope, revision)).rejects.toThrow(
      /revision is missing/,
    )
    // A requeue in B advances B's revision (none), not A's; the same move in A advances A's.
    const at = '2026-11-17T11:00:00.000Z'
    await stores.b.shipping.resolveHold(scope, seeded.b.one.id, 2, 'retry', 'queued', at)
    expect(await stores.a.shipping.recoveryRevision()).toBe(revision)
    await stores.a.shipping.resolveHold(scope, seeded.a.one.id, 2, 'retry', 'queued', at)
    expect(await stores.a.shipping.recoveryRevision()).toBe(revision + 1)
  })
})

describe("shipping writes in one workspace leave the other's rows unchanged", () => {
  for (const tag of ['a', 'b'] as const) {
    it(`writes in workspace ${tag} aimed at the other workspace's ids change nothing there`, async () => {
      const s = stores[tag].shipping
      const theirTag = other(tag)
      const theirs = seeded[theirTag]
      const before = rowsOf(stores[theirTag], theirTag)
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
          machineId: machine(theirTag),
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
      await expect(s.raiseHold(scope, hold(theirTag, theirs.one.id, 3))).rejects.toThrow(
        /unknown ship order/,
      )
      await expect(s.resolveHold(scope, theirs.one.id, 2, 'retry', 'queued', at)).rejects.toThrow()
      await expect(
        s.commitCustodyHold(scope, {
          ...attemptOf(theirs.one, theirs.attempt),
          hold: hold(theirTag, theirs.one.id, 3),
          attemptFinishedAt: at,
        }),
      ).rejects.toThrow(/fence failed/)
      await expect(
        s.commitCancellationHold(scope, {
          ...attemptOf(theirs.one, theirs.attempt),
          intentKey: 'cancel:1',
          terminalStep: theirs.plannedStep,
          hold: hold(theirTag, theirs.one.id, 3),
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
        s.createOrder(scope, shipOrder(theirTag, 'aimed', { issueId: theirs.one.issueId })),
      ).rejects.toThrow()
      await expect(
        s.createOrReturnActiveOrder(
          scope,
          shipOrder(theirTag, 'aimed', { issueId: theirs.queued.issueId }),
        ),
      ).rejects.toThrow()
      await s.completeRecoveryWork(scope, `admission:${theirs.queued.id}:new`)
      await s.completeRepairAcknowledgement(scope, `${theirTag}-token`)

      expect(rowsOf(stores[theirTag], theirTag)).toEqual(before)
    })
  }

  it("writes in their own workspace land there and leave the other's rows unchanged", async () => {
    const beforeB = rowsOf(stores.b, 'b')
    const s = stores.a.shipping
    const mine = seeded.a
    const at = '2026-11-17T11:00:00.000Z'
    await s.cancelAttemptAndOrder(scope, mine.queued.id, 'queued', at)
    await s.releaseTrain(scope, mine.manifest.id, at, 'done')
    await s.completeRecoveryWork(scope, `admission:${mine.queued.id}:new`)
    await s.queueAdmissionInvalidation(scope, mine.one.id, mine.covering.id, 'sha', 'again')
    await s.resolveHold(scope, mine.one.id, 2, 'retry', 'queued', at)
    expect((await s.getOrder(mine.queued.id))?.state).toBe('cancelled')
    expect((await s.getOrder(mine.one.id))?.state).toBe('queued')
    expect(await s.shippedLeadersOfOpenTrains()).toEqual([])
    expect(rowsOf(stores.b, 'b')).toEqual(beforeB)
    expect(await stores.b.shipping.shippedLeadersOfOpenTrains()).toEqual([seeded.b.covering.id])
  })
})
