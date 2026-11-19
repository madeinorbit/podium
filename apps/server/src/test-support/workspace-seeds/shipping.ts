/**
 * THE SAME-ID SEED OF SHIPPING, shared by its two-workspace test
 * (`store/shipping.workspace.test.ts`) and the completeness test
 * (`store/workspace-isolation.test.ts`, POD-7025). Moved here from that test unchanged: both
 * workspaces hold the same ids and natural keys, with content of their own (see the test's
 * header).
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
} from '@podium/model'
import { shippingJobRequestFingerprint } from '@podium/protocol/daemon'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import type { WorkspaceShippingSlice } from '../shipping-store-slice'

export type Tag = 'a' | 'b'
export const WS: Record<Tag, string> = { a: 'local', b: 'ws_b' }
export const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
export const scope = fixtureWriteScope()
export const AT = '2026-11-17T10:00:00.000Z'

export const VALIDATION_PROFILE = {
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
export function idsFor(p: string) {
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
export type Ids = ReturnType<typeof idsFor>
export const SHARED = idsFor('')
export const ONLY = idsFor('only-')
export const DESTINATION = 'origin/main'
/** The lane's canonical destination, as lane ids and lane reads name it. */
export const LANE_DESTINATION = canonicalShippingDestination(DESTINATION, 'main')

/** The tables `store/shipping.ts` reads and writes, read raw per workspace. */
export const TABLES = [
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
export async function rowsOf(
  store: WorkspaceShippingSlice,
  tag: Tag,
): Promise<Record<string, unknown[]>> {
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
export async function insertIssue(
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

export function shipOrder(
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
export interface Seeded {
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
export async function seed(
  store: WorkspaceShippingSlice,
  tag: Tag,
  ids: Ids = SHARED,
): Promise<Seeded> {
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
         ${`refs/repair/${ids.token}/${tag}`}, ${`${tag}-candidate`}, ${ids.token}, ${AT})`,
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

export function hold(tag: Tag, order: ShipOrder['id'], generation: number, ids: Ids = SHARED) {
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
