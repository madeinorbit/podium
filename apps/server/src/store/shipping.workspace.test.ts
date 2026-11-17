/**
 * SHIPPING IS A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7018).
 *
 * Two workspaces over one database of the run's engine (`openShippingStoreSlices`), each
 * seeded through its own
 * `ShippingRepository` with one lane's worth of shipping: a held order with an attempt, steps,
 * holds and a repair candidate; a queued order that depends on it and stacks on it; a two-member
 * train that shipped (manifest, members, claims, lane revision, effect envelope, both delivery
 * receipts, the covered completion); shipwright evidence, a root integration receipt and
 * recovery work.
 * Both workspaces hold the SAME ids and natural keys (POD-7025): the same issues, orders,
 * repository, path, machine, lane, attempt, step, hold, receipt, repair token and evidence
 * source. Every key leads with workspace_id (POD-7024), so the same id is two rows, told apart
 * only by the workspace. The content differs (the approved and target shas, summaries, hold
 * headlines, repair candidates, evidence), so a read that crossed over would answer the other
 * workspace's content. For the misses, the other workspace also holds a whole lane of ids only
 * it holds (`only-…`, seeded as the shared one is).
 *
 * For every repository method of `store/shipping.ts`:
 *   - a read answers only its own workspace's rows, including the whole-table listings, the
 *     scheduler's FIFO walks, the lane reads and the joins (train authority, claims, leaders);
 *   - a write in one workspace aimed at ids only the other holds (transition, claim, hold,
 *     resolve, cancel, finish, complete, release, isolate, stack edge, recovery work) finds
 *     nothing of the other's, a write of the ids both hold changes its own rows only, and the
 *     other's rows stay byte for byte as they were.
 *
 * `store/guarded-move.ts` holds no statement of its own: its callers own the UPDATE.
 *
 * THE RECOVERY REVISION is one row per workspace, keyed `(workspace_id, id = 1)` (POD-7024).
 * Workspace A is the self-hosted one ('local'), which the shipping migration seeded; B has none
 * until its first advance makes it, and each workspace advances only its own.
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
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openShippingStoreSlices,
  type WorkspaceShippingSlice,
} from '../test-support/shipping-store-slice'

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

/**
 * The ids and natural keys a seed writes. `SHARED` (no prefix) is the set both workspaces
 * hold; `ONLY` is a lane of ids only the workspace it is seeded into holds.
 */
function idsFor(p: string) {
  return {
    issueId: (name: string): IssueId => asIssueId(`${p}iss-${name}`),
    orderId: (name: string) => asShipOrderId(`${p}order-${name}`),
    machine: asMachineId(`${p}machine-1`),
    repo: asRepoId(`${p}repo-1`),
    repoPath: `/${p}r`,
    attempt: asShipAttemptId(`${p}attempt-one`),
    step: asShipStepId(`${p}step-planned`),
    effectKey: `${p}validation`,
    hold: (generation: number) => asShipHoldId(`${p}hold-${generation}`),
    receipt: (name: string) => asDeliveryReceiptId(`${p}receipt-${name}`),
    token: `${p}token-1`,
    custody: `${p}custody`,
    source: `${p}source`,
  }
}
type Ids = ReturnType<typeof idsFor>
const SHARED = idsFor('')
const ONLY = idsFor('only-')
const DESTINATION = 'origin/main'
/** The lane's canonical destination, as lane ids and lane reads name it. */
const LANE_DESTINATION = canonicalShippingDestination(DESTINATION, 'main')

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

/** Each table's rows of the workspace, in one order on either engine (by their text). */
async function rowsOf(store: WorkspaceShippingSlice, tag: Tag): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of TABLES) {
    const rows = await store.all<Record<string, unknown>>(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE workspace_id = ${WS[tag]}`,
    )
    out[table] = rows
      .map((row) => [JSON.stringify(row), row] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, row]) => row)
  }
  return out
}

/** An issue row, raw: the issues repository is another task's (B2). */
async function insertIssue(
  store: WorkspaceShippingSlice,
  tag: Tag,
  name: string,
  seq: number,
  ids: Ids,
): Promise<void> {
  await store.run(
    sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id,
         machine_id, branch, seq, title, stage, default_agent, created_at, updated_at)
       VALUES (${WS[tag]}, ${ids.issueId(name)}, ${firstAdminMemberId()}, ${firstAdminMemberId()},
         ${ids.repoPath}, ${ids.repo}, ${ids.machine}, ${`issue/${tag}-${name}`}, ${seq},
         ${`${tag} issue ${name}`}, 'review', 'codex', ${AT}, ${AT})`,
  )
}

function shipOrder(
  tag: Tag,
  name: string,
  overrides: Partial<ShipOrder> = {},
  ids: Ids = SHARED,
): ShipOrder {
  return {
    id: ids.orderId(name),
    issueId: ids.issueId(name),
    descendantManifest: [],
    repoId: ids.repo,
    repoPath: ids.repoPath,
    machineId: ids.machine,
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
  ids: Ids
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

/** One workspace's lane of shipping, at the ids `ids` names (the shared set by default). */
async function seed(store: WorkspaceShippingSlice, tag: Tag, ids: Ids = SHARED): Promise<Seeded> {
  const s = store.shipping
  await insertIssue(store, tag, 'one', 1, ids)
  await insertIssue(store, tag, 'queued', 2, ids)
  await insertIssue(store, tag, 'lower', 3, ids)
  await insertIssue(store, tag, 'covering', 4, ids)

  // The single-order arm: order `one` held with an attempt, steps, two holds (one
  // resolved, one open) and a repair candidate.
  const one = shipOrder(tag, 'one', {}, ids)
  await s.createOrder(scope, one)
  const attempt: ShipAttempt = {
    id: ids.attempt,
    orderId: one.id,
    expectedSourceBaseSha: one.approvedBaseSha,
    approvedHeadSha: one.approvedHeadSha,
    expectedTargetSha: `${tag}-target`,
    machineId: ids.machine,
    leaseGeneration: 1,
    startedAt: '2026-11-17T09:01:00.000Z',
    submittedHeadSha: one.approvedHeadSha,
  }
  await s.createAttempt(scope, attempt)
  const plannedStep: ShipStep = {
    id: ids.step,
    orderId: one.id,
    attemptId: attempt.id,
    effectKey: ids.effectKey,
    idempotencyKey: `${ids.effectKey}:planned`,
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
  await s.raiseHold(scope, hold(tag, one.id, 1, ids))
  await s.resolveHold(scope, one.id, 1, 'retry', 'queued', '2026-11-17T09:03:30.000Z')
  await s.raiseHold(scope, hold(tag, one.id, 2, ids))
  await store.run(
    sql`INSERT INTO ship_repair_candidates (workspace_id, order_id, attempt_id, generation, sequence,
         round, context_digest, repair_ref, candidate_head_sha, result_token, recorded_at)
       VALUES (${WS[tag]}, ${one.id}, ${attempt.id}, 1, 1, 1, ${'c'.repeat(64)},
         ${`refs/repair/${tag}`}, ${`${tag}-candidate`}, ${ids.token}, ${AT})`,
  )

  // The queued order: depends on `one` and stacks on it, so the dependents and stack reads
  // have rows.
  const queued = shipOrder(tag, 'queued', { deliveryDependsOn: [one.id] }, ids)
  await s.createOrder(scope, queued)
  await s.recordNativeStackEdge(scope, {
    upperOrderId: queued.id,
    lowerOrderId: one.id,
    recordedAt: '2026-11-17T09:04:00.000Z',
  })

  // The shipped train: lower + covering, the covering leader verified, lower covered by it.
  const lower = shipOrder(tag, 'lower', {}, ids)
  const covering = shipOrder(tag, 'covering', { deliveryDependsOn: [lower.id] }, ids)
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
    id: ids.receipt('covering'),
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
    id: ids.receipt('lower'),
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
  const evidenceCustody = createHash('sha256').update(ids.custody).digest('hex')
  const evidenceSource = ids.source
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
    ids,
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

function hold(tag: Tag, order: ShipOrder['id'], generation: number, ids: Ids = SHARED) {
  return {
    id: ids.hold(generation),
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
