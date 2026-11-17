// workspace-scoped (POD-6959)
import { createHash } from 'node:crypto'
import {
  type ActorKind,
  actorColumns,
  actorFromColumns,
  asIssueId,
  asShipAttemptId,
  asShipHoldId,
  asShipOrderId,
  asShipStepId,
  asShipTrainId,
  asShipTrainSubsetId,
  canonicalShippingDestination,
  DeliveryReceipt,
  type DeliveryReceipt as DeliveryReceiptValue,
  isLegalShipOrderTransition,
  isTerminalShipOrderState,
  isTerminalShipStepState,
  legalHoldResolutionStates,
  parseShipLaneId,
  RootIntegrationReceipt,
  type RootIntegrationReceipt as RootIntegrationReceiptValue,
  rawShippingDestinations,
  ShipAttempt,
  type ShipAttempt as ShipAttemptValue,
  ShipHold,
  type ShipHoldAction,
  type ShipHold as ShipHoldValue,
  ShipOrder,
  type ShipOrderState,
  type ShipOrder as ShipOrderValue,
  ShipStep,
  type ShipStep as ShipStepValue,
  ShipTrainManifest,
  type ShipTrainManifest as ShipTrainManifestValue,
  ShipTrainValidationProfile,
  serializeShipTrainManifest,
} from '@podium/model'
import {
  ShippingJobRequestMessage,
  ShippingJobResult,
  shippingJobRequestFingerprint,
  shippingJobRequestMatchesTrain,
  shippingTrainProofsMatch,
  shippingTrainSubsetFingerprint,
} from '@podium/protocol/daemon'
import type { WriteScope } from '@podium/sync'
import {
  and,
  asc,
  type Column,
  desc,
  eq,
  getTableColumns,
  gt,
  isNull,
  lt,
  lte,
  not,
  notInArray,
  or,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm'
import type {
  deliveryReceipts,
  rootIntegrationReceipts,
  shipAttempts,
  shipHolds,
  shipOrders,
  shipRecoveryWork,
  shipSteps,
} from '../migrations/schema'
import { captureWrite } from '../sync/capture-pg'
import { GUARD_TEXT, refusalTerm, writeGuard } from './append-only'
import { dialectOf } from './executor/dialect-prepared'
import type {
  StoreDrizzle,
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  sameWorkspace,
  WORKSPACE,
} from './executor/sync-drizzle'

/** RETAINED INPUT/MINT BRAND CASTS: shipping compatibility methods accept raw
 * ids, and deterministic step/attempt/hold keys are minted from strings. The
 * schema already brands every selected shipping identity. */
const TRAIN_MANIFEST_PREFIX = 'shipping-train:v1:'

/**
 * "How many members still claim this train", the correlated count two authority
 * reads share. drizzle has no builder form for a correlated subquery in a
 * projection, so it stays a `sql` fragment inside the builder query, which spec
 * rule 1 allows.
 *
 * THE OUTER COLUMN IS QUALIFIED BY HAND, and that is the whole reason this is a
 * named constant rather than two inline templates. drizzle emits an interpolated
 * column UNQUALIFIED when the enclosing query has a single FROM table — checked
 * with `.toSQL()`, not read off the builder: `completeVerifiedTrain`'s one-table
 * read emitted `WHERE c.train_id = "id"`, while `activeTrainForOrder`'s
 * two-table join emitted the qualified form. Inside the subquery a bare name
 * resolves against the SUBQUERY's table first, so the one-table form is correct
 * today only because `ship_train_active_claims` happens to have no `id` column.
 * Proven fragile rather than assumed: give that table an `id` and the bare form
 * counts 0 where the qualified form counts 2 — no error, no log, a plausible
 * number, and every train then reads as unclaimed.
 *
 * The claims are this workspace's only: `c` is held to the outer manifest's
 * workspace, qualified by hand for the same reason (POD-6959).
 */
const activeClaimCount = (t: StoreTables) =>
  sql<number>`(SELECT COUNT(*) FROM ${t.shipTrainActiveClaims} c WHERE c.workspace_id = ${sql.identifier('ship_train_manifests')}.${sql.identifier('workspace_id')} AND c.train_id = ${sql.identifier('ship_train_manifests')}.${sql.identifier('id')})`

/**
 * THE SIX ROW SHAPES THE MAPPERS BELOW READ [POD-3396, spec rule 3].
 *
 * Each is the schema's own inferred select row, replacing the
 * `Record<string, unknown>` this file used to cast to. Two things follow, and
 * they are the reason the shapes and the mappers convert as their own commit
 * ahead of the 54 methods that use them: the brands arrive through the schema's
 * `$type` rather than through a cast, and the FIELD NAMES are drizzle's own
 * mapping of the physical columns, so the five hand-written `SELECT … AS …`
 * strings this file carried are not replaced by anything — the aliases WERE the
 * mapping.
 *
 * THAT SUBSTITUTION IS EXACT, and it was derived rather than assumed: each of
 * the five hand-written selects names precisely the columns its table declares,
 * 25/25 for `ship_orders`, 16/16 attempts, 15/15 steps, 11/11 holds, 12/12
 * receipts, with no column in the table missing from the select and no selected
 * name absent from the table. So `select().from(table)` returns the same set of
 * fields under the same names, and no read gains or loses a column.
 */
type OrderRow = Omit<typeof shipOrders.$inferSelect, 'validationProfile'> & {
  validationProfile: string | null
}
type AttemptRow = typeof shipAttempts.$inferSelect
type StepRow = Omit<typeof shipSteps.$inferSelect, 'inputFence'> & { inputFence: string }
type HoldRow = typeof shipHolds.$inferSelect
type ReceiptRow = typeof deliveryReceipts.$inferSelect
type IntegrationReceiptRow = typeof rootIntegrationReceipts.$inferSelect

/**
 * THE FIVE COLUMNS THIS FILE READS AS TEXT THOUGH THE SCHEMA DECLARES THEM
 * `mode: 'json'` [POD-3396, and it is the sharpest thing this conversion found].
 *
 * Spec rule 28 says a converted read returns the SCHEMA's declared type, and
 * that is exactly the problem here rather than the answer. Under `mode: 'json'`
 * drizzle parses the column, and this file depends on the unparsed text in two
 * separate ways that a parsed value cannot serve:
 *
 *   THE BYTES ARE THE CUSTODY CHECK. `trainManifestForAttempt` compares
 *   `JSON.stringify(manifest.lane.validationProfile)` against the stored column
 *   and `JSON.stringify(providerRef ?? null)` against `String(row.providerRef ??
 *   'null')`, and the member check does the same for `delivery_depends_on`.
 *   Against a parsed object those comparisons are ALWAYS unequal, so every train
 *   fails its authority check — and "compare structurally instead" is not a
 *   like-for-like fix: a byte comparison rejects a re-serialised or
 *   whitespace-altered blob and a structural one accepts it, on a custody check.
 *
 *   THE THROW MOVES. A corrupt value under `mode: 'json'` throws AT THE DRIVER,
 *   before the method's own fences run and with drizzle's parse message rather
 *   than the model's. The corrupt-blob oracle pins the message for all five of
 *   these columns, so adopting the json mode changes what a caller sees on the
 *   arm the oracle exists to watch.
 *
 * Rule 4 says `mode: 'json'` is ACCEPTABLE for the five columns whose throw is
 * intended; it does not oblige a READER to take it, and §5.1 asks for no
 * behaviour change on SQLite. So each read below re-projects the column as raw
 * text, the quarantine and the parse stay exactly where they are, and no
 * assertion moves. Raised with the coordinator as a wave-wide question, because
 * 23 columns carry this mode and the other waves read them too.
 */
const orderColumns = (t: StoreTables) => ({
  ...getTableColumns(t.shipOrders),
  validationProfile: sql<string | null>`${t.shipOrders.validationProfile}`,
})
const stepColumns = (t: StoreTables) => ({
  ...getTableColumns(t.shipSteps),
  inputFence: sql<string>`${t.shipSteps.inputFence}`,
})
/**
 * THE TWO AD-HOC PROJECTIONS ARE NAMED COLUMN BY COLUMN, not spread from the
 * table, and that is the difference between them and the five above.
 *
 * The five mapper shapes may spread because each hand-written select named
 * EXACTLY its table's columns — derived, 25/25, 16/16, 15/15, 11/11, 12/12 — so
 * the whole table IS the old projection. These two never did: the manifest
 * authority read named 19 of 25 columns and the member read 10 of 12. Spreading
 * them widened both reads, which surfaced only when rule 36 made me PRINT the
 * emitted SQL rather than reason about it.
 *
 * Nothing observable changed while they were wide — both readers build an
 * explicit object from named fields, so the extra columns were ignored — but a
 * conversion that reads six columns the original did not is not the literal
 * conversion, and on the remote driver those are bytes over a network.
 */
const trainManifestColumns = (t: StoreTables) => ({
  id: t.shipTrainManifests.id,
  canonicalJson: t.shipTrainManifests.canonicalJson,
  canonicalDigest: t.shipTrainManifests.canonicalDigest,
  repoId: t.shipTrainManifests.repoId,
  repoPath: t.shipTrainManifests.repoPath,
  machineId: t.shipTrainManifests.machineId,
  laneKey: t.shipTrainManifests.laneKey,
  laneRevision: t.shipTrainManifests.laneRevision,
  targetBranch: t.shipTrainManifests.targetBranch,
  expectedTargetSha: t.shipTrainManifests.expectedTargetSha,
  destination: t.shipTrainManifests.destination,
  providerRef: sql<string | null>`${t.shipTrainManifests.providerRef}`,
  policyId: t.shipTrainManifests.policyId,
  validationProfile: sql<string>`${t.shipTrainManifests.validationProfile}`,
  validationProfileDigest: t.shipTrainManifests.validationProfileDigest,
  memberCount: t.shipTrainManifests.memberCount,
  leaderOrderId: t.shipTrainManifests.leaderOrderId,
  leaderAttemptId: t.shipTrainManifests.leaderAttemptId,
  leaderGeneration: t.shipTrainManifests.leaderGeneration,
})
const trainMemberColumns = (t: StoreTables) => ({
  ordinal: t.shipTrainMembers.ordinal,
  issueId: t.shipTrainMembers.issueId,
  orderId: t.shipTrainMembers.orderId,
  attemptId: t.shipTrainMembers.attemptId,
  generation: t.shipTrainMembers.generation,
  machineId: t.shipTrainMembers.machineId,
  sourceBranch: t.shipTrainMembers.sourceBranch,
  approvedBaseSha: t.shipTrainMembers.approvedBaseSha,
  approvedHeadSha: t.shipTrainMembers.approvedHeadSha,
  deliveryDependsOn: sql<string>`${t.shipTrainMembers.deliveryDependsOn}`,
})

export interface StoredShippingRepairCandidate {
  orderId: ShipOrderValue['id']
  attemptId: ShipAttemptValue['id']
  generation: number
  sequence: number
  round: number
  contextDigest: string
  repairRef: string
  candidateHeadSha: string
  resultToken: string
  recordedAt: string
}

export type ShippingDaemonAcknowledgement = Omit<ShippingJobRequestMessage, 'type' | 'requestId'>

export interface ShippingRepairAcknowledgement {
  resultToken: string
  orderId: ShipOrderValue['id']
  attemptId: ShipAttemptValue['id']
  generation: number
  contextDigest: string
  candidate?: { repairRef: string; candidateHeadSha: string }
}

export type StoredShippingRecoveryWork = typeof shipRecoveryWork.$inferSelect

export const daemonAcknowledgementKey = (request: ShippingDaemonAcknowledgement): string =>
  `daemon:${request.jobId}:${request.requestDigest}`

const repairAcknowledgementKey = (resultToken: string): string => `repair:${resultToken}`
const descendantInvalidationKey = (receipt: DeliveryReceiptValue): string =>
  `descendants:${receipt.id}`

export interface StoredShippingEvidence {
  ref: string
  custodyDigest: string
  contentDigest: string
  sourceRef: string
  content: string
  materializedAt: string
}

const frozenOrderFacts = (order: ShipOrderValue) => ({
  issueId: order.issueId,
  descendantManifest: order.descendantManifest,
  repoId: order.repoId,
  repoPath: order.repoPath,
  machineId: order.machineId,
  targetBranch: order.targetBranch,
  destination: order.destination,
  approvedBaseSha: order.approvedBaseSha,
  approvedHeadSha: order.approvedHeadSha,
  deliveryDependsOn: order.deliveryDependsOn,
  evidenceManifestRef: order.evidenceManifestRef,
  currentIntegrationReceipt: order.currentIntegrationReceipt,
  providerRef: order.providerRef,
  requestedBy: order.requestedBy,
  policyId: order.policyId,
  validationProfile: order.validationProfile,
  validationProfileDigest: order.validationProfileDigest,
  closeMode: order.closeMode,
})

export const sameFrozenShipOrder = (left: ShipOrderValue, right: ShipOrderValue): boolean =>
  JSON.stringify(frozenOrderFacts(left)) === JSON.stringify(frozenOrderFacts(right))

const jsonArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const jsonObject = (value: unknown): Record<string, unknown> | undefined => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The WHERE of the partial index `idx_ship_orders_one_active_issue`, spelled
 * exactly as the index spells it. A query that repeats it LITERALLY may scan that
 * index, which holds only active orders; a bound parameter would not match. */
export const ACTIVE_SHIP_ORDER_TERM = "state NOT IN ('shipped', 'cancelled')"

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const canonicalValidationProfile = (input: ShipTrainValidationProfile) =>
  ShipTrainValidationProfile.parse({
    ...input,
    resourceLocks: [...new Set(input.resourceLocks)].sort(),
  })

const validationProfileDigest = (profile: ShipTrainValidationProfile): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalValidationProfile(profile)))
    .digest('hex')

const shippingLaneKey = (
  order: ShipOrderValue,
  issue: { repoPath: string; machineId: string },
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        repoId: order.repoId,
        repoPath: issue.repoPath,
        machineId: issue.machineId,
        targetBranch: order.targetBranch,
        expectedTargetSha: order.approvedBaseSha,
        destination: canonicalShippingDestination(order.destination, order.targetBranch),
        providerRef: order.providerRef ?? null,
        policyId: order.policyId,
        validationProfileDigest: order.validationProfileDigest ?? null,
        closeMode: order.closeMode,
        requestedBy: order.requestedBy,
      }),
    )
    .digest('hex')

const canonicalIntegrationReceipt = (
  input: RootIntegrationReceiptValue,
): RootIntegrationReceiptValue => {
  const receipt = RootIntegrationReceipt.parse(input)
  return {
    ...receipt,
    descendants: [...receipt.descendants].sort(
      (left, right) =>
        left.issueId.localeCompare(right.issueId) ||
        left.approvedHeadSha.localeCompare(right.approvedHeadSha),
    ),
  }
}

function mapIntegrationReceipt(row: IntegrationReceiptRow): RootIntegrationReceiptValue {
  return canonicalIntegrationReceipt(
    RootIntegrationReceipt.parse({
      rootIssueId: row.rootIssueId,
      approvedHeadSha: row.approvedHeadSha,
      descendants: jsonArray(row.descendants),
    }),
  )
}

function mapOrder(row: OrderRow): ShipOrderValue {
  // The `ActorKind` narrowing is a DECISION and stays (rule 6): the column is a
  // CHECK-constrained text column, so the schema types it `string` and the union
  // it actually holds is the mapper's claim to make. The `String(…)` that used to
  // wrap the id has gone — it existed only because the raw handle returned
  // `unknown`, and the column is `text().notNull()`.
  const actor = actorFromColumns(row.requestedByActorKind as ActorKind, row.requestedByActorId)
  const providerRef = jsonObject(row.providerRef)
  const currentIntegrationReceipt = jsonObject(row.currentIntegrationReceipt)
  const validationProfile = jsonObject(row.validationProfile)
  return ShipOrder.parse({
    id: row.id,
    issueId: row.issueId,
    repoId: row.repoId,
    ...(optionalString(row.repoPath) ? { repoPath: row.repoPath } : {}),
    ...(optionalString(row.machineId) ? { machineId: row.machineId } : {}),
    targetBranch: row.targetBranch,
    destination: row.destination,
    approvedBaseSha: row.approvedBaseSha,
    approvedHeadSha: row.approvedHeadSha,
    // `resultCommitSha` was read here and `orderSelect` never returned it, so it
    // was always `undefined` — and `ShipOrder` does not declare the key, so the
    // parse dropped it. Removing it is behaviour-identical; keeping it would not
    // compile against the typed row, which is how the dead line surfaced.
    descendantManifest: jsonArray(row.descendantManifest),
    deliveryDependsOn: jsonArray(row.deliveryDependsOn),
    ...(optionalString(row.evidenceManifestRef)
      ? { evidenceManifestRef: row.evidenceManifestRef }
      : {}),
    ...(currentIntegrationReceipt ? { currentIntegrationReceipt } : {}),
    ...(providerRef ? { providerRef } : {}),
    requestedBy: { actor, onBehalfOf: row.requestedByOnBehalfOf ?? null },
    requestedAt: row.requestedAt,
    policyId: row.policyId,
    ...(validationProfile ? { validationProfile } : {}),
    ...(optionalString(row.validationProfileDigest)
      ? { validationProfileDigest: row.validationProfileDigest }
      : {}),
    closeMode: row.closeMode,
    state: row.state,
    stateChangedAt: row.stateChangedAt,
    ...(optionalString(row.holdCode) ? { holdCode: row.holdCode } : {}),
  })
}

function mapAttempt(row: AttemptRow): ShipAttemptValue {
  return ShipAttempt.parse({
    id: row.id,
    orderId: row.orderId,
    expectedSourceBaseSha: row.expectedSourceBaseSha,
    approvedHeadSha: row.approvedHeadSha,
    expectedTargetSha: row.expectedTargetSha,
    machineId: row.machineId,
    leaseGeneration: row.leaseGeneration,
    startedAt: row.startedAt,
    ...(optionalString(row.finishedAt) ? { finishedAt: row.finishedAt } : {}),
    ...(optionalString(row.outcome) ? { outcome: row.outcome } : {}),
    submittedHeadSha: row.submittedHeadSha,
    ...(optionalString(row.testedIntegrationSha)
      ? { testedIntegrationSha: row.testedIntegrationSha }
      : {}),
    ...(optionalString(row.landedRefSha) ? { landedRefSha: row.landedRefSha } : {}),
    ...(optionalString(row.destinationSha) ? { destinationSha: row.destinationSha } : {}),
    ...(optionalString(row.validationProfileId)
      ? { validationProfileId: row.validationProfileId }
      : {}),
    ...(optionalString(row.validationResult) ? { validationResult: row.validationResult } : {}),
  })
}

function mapStep(row: StepRow): ShipStepValue {
  return ShipStep.parse({
    id: row.id,
    orderId: row.orderId,
    attemptId: row.attemptId,
    effectKey: row.effectKey,
    idempotencyKey: row.idempotencyKey,
    generation: row.generation,
    inputFence: jsonObject(row.inputFence),
    kind: row.kind,
    state: row.state,
    ...(optionalString(row.outcome) ? { outcome: row.outcome } : {}),
    summary: row.summary,
    ...(optionalString(row.artifactRef) ? { artifactRef: row.artifactRef } : {}),
    recordedAt: row.recordedAt,
    ...(optionalString(row.startedAt) ? { startedAt: row.startedAt } : {}),
    ...(optionalString(row.finishedAt) ? { finishedAt: row.finishedAt } : {}),
  })
}

function mapHold(row: HoldRow): ShipHoldValue {
  return ShipHold.parse({
    id: row.id,
    orderId: row.orderId,
    generation: row.generation,
    reasonCode: row.reasonCode,
    headline: row.headline,
    detail: row.detail,
    evidenceRefs: jsonArray(row.evidenceRefs),
    actions: jsonArray(row.actions),
    raisedAt: row.raisedAt,
    ...(optionalString(row.resolvedAt) ? { resolvedAt: row.resolvedAt } : {}),
    ...(optionalString(row.resolution) ? { resolution: row.resolution } : {}),
  })
}

function mapReceipt(row: ReceiptRow): DeliveryReceiptValue {
  return DeliveryReceipt.parse({
    id: row.id,
    orderId: row.orderId,
    approvedBaseSha: row.approvedBaseSha,
    approvedHeadSha: row.approvedHeadSha,
    resultCommitSha: row.resultCommitSha,
    testedIntegrationSha: row.testedIntegrationSha,
    landedRefSha: row.landedRefSha,
    destinationSha: row.destinationSha,
    validationProfileId: row.validationProfileId,
    validationResult: row.validationResult,
    destination: row.destination,
    completedAt: row.completedAt,
  })
}

// Every query this repository runs, prepared once per store [POD-6147].

/** See {@link ShippingRepository.highestHoldGeneration}. */
const highestHoldGenerationOf = prepared((db, t) =>
  db
    .select({ generation: sql<number>`COALESCE(MAX(${t.shipHolds.generation}), 0)` })
    .from(t.shipHolds)
    .where(inWorkspace(t.shipHolds, eq(t.shipHolds.orderId, param(t.shipHolds.orderId, 'orderId'))))
    .prepare(),
)

const insertDeliveryReceiptRow = prepared((db, t) =>
  captureWrite(
    db.insert(t.deliveryReceipts).values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      orderId: sql.placeholder('orderId'),
      approvedBaseSha: sql.placeholder('approvedBaseSha'),
      approvedHeadSha: sql.placeholder('approvedHeadSha'),
      resultCommitSha: sql.placeholder('resultCommitSha'),
      testedIntegrationSha: sql.placeholder('testedIntegrationSha'),
      landedRefSha: sql.placeholder('landedRefSha'),
      destinationSha: sql.placeholder('destinationSha'),
      validationProfileId: sql.placeholder('validationProfileId'),
      validationResult: sql.placeholder('validationResult'),
      destination: sql.placeholder('destination'),
      completedAt: sql.placeholder('completedAt'),
    }),
  ).prepare(),
)

/**
 * The lane-revision upsert, which two call sites carried verbatim.
 *
 * `ON CONFLICT(lane_key)` names ONE target and `ship_lane_revisions` has
 * exactly one uniqueness constraint — `lane_key` is its whole primary key and
 * the table declares no other index. That is checked rather than assumed,
 * because it is the same question the coordinator's `OR REPLACE` ruling turns
 * on: `onConflictDoUpdate` resolves ONE named target and raises on any other,
 * so it is a like-for-like replacement only where there is nothing else to
 * conflict with. The increment reads the stored row and the timestamp reads
 * `excluded`, both exactly as before.
 */
const bumpLaneRevisionUpsert = prepared((db, t) =>
  db
    .insert(t.shipLaneRevisions)
    .values({
      workspaceId: WORKSPACE,
      laneKey: sql.placeholder('laneKey'),
      revision: 1,
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: [t.shipLaneRevisions.workspaceId, t.shipLaneRevisions.laneKey],
      set: {
        revision: sql`${t.shipLaneRevisions.revision} + 1`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .prepare(),
)

const evidenceByRef = prepared((db, t) =>
  db
    .select()
    .from(t.shipEvidence)
    .where(inWorkspace(t.shipEvidence, eq(t.shipEvidence.ref, param(t.shipEvidence.ref, 'ref'))))
    .prepare(),
)

const evidenceBySource = prepared((db, t) =>
  db
    .select()
    .from(t.shipEvidence)
    .where(
      inWorkspace(
        t.shipEvidence,
        eq(t.shipEvidence.custodyDigest, param(t.shipEvidence.custodyDigest, 'custodyDigest')),
        eq(t.shipEvidence.sourceRef, param(t.shipEvidence.sourceRef, 'sourceRef')),
      ),
    )
    .limit(1)
    .prepare(),
)

const insertEvidence = prepared((db, t) =>
  db
    .insert(t.shipEvidence)
    .values({
      workspaceId: WORKSPACE,
      ref: sql.placeholder('ref'),
      custodyDigest: sql.placeholder('custodyDigest'),
      contentDigest: sql.placeholder('contentDigest'),
      sourceRef: sql.placeholder('sourceRef'),
      content: sql.placeholder('content'),
      materializedAt: sql.placeholder('materializedAt'),
    })
    .prepare(),
)

const repairCandidatesOfAttempt = prepared((db, t) =>
  db
    .select()
    .from(t.shipRepairCandidates)
    .where(
      inWorkspace(
        t.shipRepairCandidates,
        eq(t.shipRepairCandidates.attemptId, param(t.shipRepairCandidates.attemptId, 'attemptId')),
      ),
    )
    .orderBy(asc(t.shipRepairCandidates.sequence))
    .prepare(),
)

const repairCandidateOfSequence = prepared((db, t) =>
  db
    .select()
    .from(t.shipRepairCandidates)
    .where(
      inWorkspace(
        t.shipRepairCandidates,
        eq(t.shipRepairCandidates.attemptId, param(t.shipRepairCandidates.attemptId, 'attemptId')),
        eq(t.shipRepairCandidates.sequence, param(t.shipRepairCandidates.sequence, 'sequence')),
      ),
    )
    .prepare(),
)

const insertRepairCandidate = prepared((db, t) =>
  db
    .insert(t.shipRepairCandidates)
    .values({
      workspaceId: WORKSPACE,
      orderId: sql.placeholder('orderId'),
      attemptId: sql.placeholder('attemptId'),
      generation: sql.placeholder('generation'),
      sequence: sql.placeholder('sequence'),
      round: sql.placeholder('round'),
      contextDigest: sql.placeholder('contextDigest'),
      repairRef: sql.placeholder('repairRef'),
      candidateHeadSha: sql.placeholder('candidateHeadSha'),
      resultToken: sql.placeholder('resultToken'),
      recordedAt: sql.placeholder('recordedAt'),
    })
    .prepare(),
)

const integrationReceiptByRootHead = prepared((db, t) =>
  db
    .select()
    .from(t.rootIntegrationReceipts)
    .where(
      inWorkspace(
        t.rootIntegrationReceipts,
        eq(
          t.rootIntegrationReceipts.rootIssueId,
          param(t.rootIntegrationReceipts.rootIssueId, 'rootIssueId'),
        ),
        eq(
          t.rootIntegrationReceipts.approvedHeadSha,
          param(t.rootIntegrationReceipts.approvedHeadSha, 'approvedHeadSha'),
        ),
      ),
    )
    .prepare(),
)

const insertIntegrationReceipt = prepared((db, t) =>
  db
    .insert(t.rootIntegrationReceipts)
    .values({
      workspaceId: WORKSPACE,
      rootIssueId: sql.placeholder('rootIssueId'),
      approvedHeadSha: sql.placeholder('approvedHeadSha'),
      descendants: sql.placeholder('descendants'),
    })
    .prepare(),
)

const orderById = prepared((db, t) =>
  db
    .select(orderColumns(t))
    .from(t.shipOrders)
    .where(inWorkspace(t.shipOrders, eq(t.shipOrders.id, param(t.shipOrders.id, 'id'))))
    .prepare(),
)

const activeOrderOfIssue = prepared((db, t) =>
  db
    .select(orderColumns(t))
    .from(t.shipOrders)
    .where(
      inWorkspace(
        t.shipOrders,
        eq(t.shipOrders.issueId, param(t.shipOrders.issueId, 'issueId')),
        notInArray(t.shipOrders.state, ['shipped', 'cancelled']),
      ),
    )
    .prepare(),
)

const allOrders = prepared((db, t) =>
  db
    .select(orderColumns(t))
    .from(t.shipOrders)
    .where(inWorkspace(t.shipOrders))
    .orderBy(asc(t.shipOrders.requestedAt), asc(t.shipOrders.id))
    .prepare(),
)

/** Keyed by the bucketed size of the lane's raw destination spellings. */
const queuedOrdersOfLane = preparedFamily((db, t, size: number) =>
  db
    .select(orderColumns(t))
    .from(t.shipOrders)
    .where(
      inWorkspace(
        t.shipOrders,
        eq(t.shipOrders.repoId, param(t.shipOrders.repoId, 'repoId')),
        inListOf(t.shipOrders.destination, size, 'destination'),
        eq(t.shipOrders.state, 'queued'),
      ),
    )
    .orderBy(asc(t.shipOrders.requestedAt), asc(t.shipOrders.id))
    .prepare(),
)

// Queued orders of SEVERAL lanes in one read [POD-6149]: every listed repo
// crossed with every listed raw destination; callers keep only each lane's own
// (repo, canonical destination) pairs. Keyed by the two padded list sizes.
const queuedOrdersOfLanes = preparedFamily((db, t, shape: string) => {
  const [repoSize, destinationSize] = shape.split('x').map(Number) as [number, number]
  return db
    .select(orderColumns(t))
    .from(t.shipOrders)
    .where(
      inWorkspace(
        t.shipOrders,
        inListOf(t.shipOrders.repoId, repoSize, 'repo'),
        inListOf(t.shipOrders.destination, destinationSize, 'destination'),
        eq(t.shipOrders.state, 'queued'),
      ),
    )
    .orderBy(asc(t.shipOrders.requestedAt), asc(t.shipOrders.id))
    .prepare()
})

const ordersOfIds = preparedFamily((db, t, size: number) =>
  db
    .select(orderColumns(t))
    .from(t.shipOrders)
    .where(inWorkspace(t.shipOrders, inListOf(t.shipOrders.id, size, 'ids')))
    .prepare(),
)

/**
 * Every ACTIVE order (not shipped, not cancelled), FIFO (POD-6172): the
 * scheduler's input. The term is the literal WHERE of the partial index
 * `idx_ship_orders_one_active_issue` and the index is named with INDEXED BY, so
 * the walk covers active orders only, never the shipped history.
 */
// The same projection as `orderColumns`, named by bare column so the select
// does not need the table object in its FROM, which here is an INDEXED BY clause.
const indexedOrderColumns = (t: StoreTables) =>
  ({
    ...Object.fromEntries(
      Object.entries(getTableColumns(t.shipOrders)).map(([key, column]) => [
        key,
        sql`${sql.identifier(column.name)}`.mapWith(column),
      ]),
    ),
    validationProfile: sql<string | null>`${sql.identifier('validation_profile')}`,
  }) as unknown as ReturnType<typeof orderColumns>

//
// Postgres has no INDEXED BY: it plans the same partial index from the same literal
// term, so its form names the table itself and selects its columns.
const activeOrdersFifo = prepared((db, t) => {
  const pg = dialectOf(db) === 'pg'
  return db
    .select(pg ? orderColumns(t) : indexedOrderColumns(t))
    .from(pg ? t.shipOrders : sql`${t.shipOrders} INDEXED BY idx_ship_orders_one_active_issue`)
    .where(inWorkspace(t.shipOrders, sql.raw(ACTIVE_SHIP_ORDER_TERM))) // CONSTANT-IDENTIFIER STATEMENT POD-5612
    .orderBy(asc(t.shipOrders.requestedAt), asc(t.shipOrders.id))
    .prepare()
})

const resumableOrdersFifo = prepared((db, t) => {
  const pg = dialectOf(db) === 'pg'
  return db
    .select(pg ? orderColumns(t) : indexedOrderColumns(t))
    .from(pg ? t.shipOrders : sql`${t.shipOrders} INDEXED BY idx_ship_orders_recovery`)
    .where(
      inWorkspace(
        t.shipOrders,
        sql`state IN ('preflight', 'composing', 'validating', 'repairing', 'landing', 'publishing', 'verifying')`,
      ),
    )
    .orderBy(asc(t.shipOrders.requestedAt), asc(t.shipOrders.id))
    .prepare()
})

const recoveryWorkPage = prepared((db, t) =>
  db
    .select()
    .from(t.shipRecoveryWork)
    .where(
      inWorkspace(
        t.shipRecoveryWork,
        eq(t.shipRecoveryWork.kind, param(t.shipRecoveryWork.kind, 'kind')),
        gt(t.shipRecoveryWork.key, param(t.shipRecoveryWork.key, 'after')),
      ),
    )
    .orderBy(asc(t.shipRecoveryWork.key))
    .limit(100)
    .prepare(),
)

const recoveryRevision = prepared((db, t) =>
  db
    .select({ revision: t.shipRecoveryRevision.revision })
    .from(t.shipRecoveryRevision)
    .where(inWorkspace(t.shipRecoveryRevision, eq(t.shipRecoveryRevision.id, 1)))
    .prepare(),
)

/**
 * One revision row per workspace (POD-7018's finding, rekeyed by POD-7024): the shipping
 * migration seeded only the self-hosted workspace's, so a workspace with no row is at
 * revision 0 and its first advance creates the row. An upsert, so the advance stays one
 * statement and no workspace has to be seeded at provisioning (a global write to a workspace
 * table, which contract C3 keeps to the feed row).
 */
const advanceRecoveryRevision = prepared((db, t) =>
  db
    .insert(t.shipRecoveryRevision)
    .values({ workspaceId: WORKSPACE, id: 1, revision: 1 })
    .onConflictDoUpdate({
      target: [t.shipRecoveryRevision.workspaceId, t.shipRecoveryRevision.id],
      set: { revision: sql`${t.shipRecoveryRevision.revision} + 1` },
    })
    .prepare(),
)

const insertRecoveryWork = prepared((db, t) =>
  db
    .insert(t.shipRecoveryWork)
    .values({
      workspaceId: WORKSPACE,
      key: sql.placeholder('key'),
      kind: sql.placeholder('kind'),
      orderId: sql.placeholder('orderId'),
      payload: sql.placeholder('payload'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const deleteRecoveryWork = prepared((db, t) =>
  db
    .delete(t.shipRecoveryWork)
    .where(
      inWorkspace(
        t.shipRecoveryWork,
        eq(t.shipRecoveryWork.key, param(t.shipRecoveryWork.key, 'key')),
      ),
    )
    .prepare(),
)

// Shipped stateChangedAt is the receipt's completion time, not request order.
// Admission walks newest first and excludes destinations once their receipt is
// contained in the approved base. Startup never enumerates shipped history.
const shippedPredecessorsPage = preparedFamily((db, t, size: number) =>
  db
    .select({ ...orderColumns(t), destinationSha: t.deliveryReceipts.destinationSha })
    .from(t.shipOrders)
    .innerJoin(
      t.deliveryReceipts,
      and(
        sameWorkspace(t.deliveryReceipts, t.shipOrders),
        eq(t.deliveryReceipts.orderId, t.shipOrders.id),
      ),
    )
    .where(
      inWorkspace(
        t.shipOrders,
        eq(t.shipOrders.repoId, param(t.shipOrders.repoId, 'repoId')),
        eq(t.shipOrders.state, 'shipped'),
        lte(t.shipOrders.stateChangedAt, param(t.shipOrders.stateChangedAt, 'beforeAt')),
        or(
          lt(t.shipOrders.stateChangedAt, param(t.shipOrders.stateChangedAt, 'beforeAt')),
          lt(t.shipOrders.id, param(t.shipOrders.id, 'beforeId')),
        ),
        size === 0
          ? undefined
          : not(
              or(
                ...Array.from({ length: size }, (_, index) =>
                  and(
                    eq(
                      t.shipOrders.destination,
                      param(t.shipOrders.destination, `containedDestination${index}`),
                    ),
                    eq(
                      t.shipOrders.targetBranch,
                      param(t.shipOrders.targetBranch, `containedBranch${index}`),
                    ),
                  ),
                ),
              )!,
            ),
      ),
    )
    .orderBy(desc(t.shipOrders.stateChangedAt), desc(t.shipOrders.id))
    .limit(100)
    .prepare(),
)

/** The active orders of one repository under any of the listed raw
 *  destinations, through `idx_ship_orders_lane` (POD-6172). Keyed by the
 *  bucketed size of the destination list. */
const activeOrdersOfLane = preparedFamily((db, t, size: number) =>
  db
    .select(orderColumns(t))
    .from(t.shipOrders)
    .where(
      inWorkspace(
        t.shipOrders,
        eq(t.shipOrders.repoId, param(t.shipOrders.repoId, 'repoId')),
        inListOf(t.shipOrders.destination, size, 'destination'),
        sql.raw(ACTIVE_SHIP_ORDER_TERM), // CONSTANT-IDENTIFIER STATEMENT POD-5612
      ),
    )
    .orderBy(asc(t.shipOrders.requestedAt), asc(t.shipOrders.id))
    .prepare(),
)

/**
 * "The order's `delivery_depends_on` lists one of the `ids` placeholders." SQLite reads
 * the json array with `json_each`; Postgres with `json_array_elements_text`, whose text
 * is compared in byte order as SQLite compares it (design 2.3, rule 13).
 */
const dependsOnAny = (db: StoreDrizzle, t: StoreTables, size: number): SQL => {
  const ids = sql.join(
    Array.from({ length: size }, (_, index) => sql`${sql.placeholder(`ids${index}`)}`),
    sql`, `,
  )
  return dialectOf(db) === 'pg'
    ? sql`EXISTS (SELECT 1 FROM json_array_elements_text(${t.shipOrders.deliveryDependsOn}) AS depends_on(value) WHERE depends_on.value COLLATE "C" IN (${ids}))`
    : sql`EXISTS (SELECT 1 FROM json_each(${t.shipOrders.deliveryDependsOn}) WHERE json_each.value IN (${ids}))`
}

/** See {@link ShippingRepository.queuedDependentsOf}; keyed by the bucketed id count. */
const queuedDependentsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select(orderColumns(t))
    .from(t.shipOrders)
    .where(
      inWorkspace(
        t.shipOrders,
        // CONSTANT-IDENTIFIER STATEMENT POD-5612 — the term is the
        // `ACTIVE_SHIP_ORDER_TERM` source constant, never user input, and
        // `shipping-lane-reads.test.ts` derives it from the schema (index
        // SQL out of sqlite_master plus the EXPLAIN plan) and fails on drift.
        sql.raw(ACTIVE_SHIP_ORDER_TERM), // CONSTANT-IDENTIFIER STATEMENT POD-5612
        eq(t.shipOrders.state, 'queued'),
        dependsOnAny(db, t, size),
      ),
    )
    .orderBy(asc(t.shipOrders.requestedAt), asc(t.shipOrders.id))
    .prepare(),
)

const stackEdgesFromUppers = preparedFamily((db, t, size: number) =>
  db
    .select({
      upperOrderId: t.shipOrderStackEdges.upperOrderId,
      lowerOrderId: t.shipOrderStackEdges.lowerOrderId,
    })
    .from(t.shipOrderStackEdges)
    .where(
      inWorkspace(t.shipOrderStackEdges, inListOf(t.shipOrderStackEdges.upperOrderId, size, 'ids')),
    )
    .prepare(),
)

const allStackEdgesOrdered = prepared((db, t) =>
  db
    .select({
      upperOrderId: t.shipOrderStackEdges.upperOrderId,
      lowerOrderId: t.shipOrderStackEdges.lowerOrderId,
    })
    .from(t.shipOrderStackEdges)
    .where(inWorkspace(t.shipOrderStackEdges))
    .orderBy(asc(t.shipOrderStackEdges.upperOrderId), asc(t.shipOrderStackEdges.lowerOrderId))
    .prepare(),
)

const openHoldsOfOrders = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.shipHolds)
    .where(
      inWorkspace(
        t.shipHolds,
        inListOf(t.shipHolds.orderId, size, 'ids'),
        isNull(t.shipHolds.resolvedAt),
      ),
    )
    .prepare(),
)

const receiptsOfOrders = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.deliveryReceipts)
    .where(inWorkspace(t.deliveryReceipts, inListOf(t.deliveryReceipts.orderId, size, 'ids')))
    .prepare(),
)

const issueIdOfOrder = prepared((db, t) =>
  db
    .select({ issueId: t.shipOrders.issueId })
    .from(t.shipOrders)
    .where(inWorkspace(t.shipOrders, eq(t.shipOrders.id, param(t.shipOrders.id, 'id'))))
    .prepare(),
)

const issueIdsOfOrders = preparedFamily((db, t, size: number) =>
  db
    .select({ id: t.shipOrders.id, issueId: t.shipOrders.issueId })
    .from(t.shipOrders)
    .where(inWorkspace(t.shipOrders, inListOf(t.shipOrders.id, size, 'ids')))
    .prepare(),
)

/** Every order of these issues, in any state, on `idx_ship_orders_issue` [POD-6156]. */
const orderIdsOfIssues = preparedFamily((db, t, size: number) =>
  db
    .select({ id: t.shipOrders.id, issueId: t.shipOrders.issueId })
    .from(t.shipOrders)
    .where(inWorkspace(t.shipOrders, inListOf(t.shipOrders.issueId, size, 'issueIds')))
    .prepare(),
)

/** The lane custody an order's issue holds (createOrder, recordNativeStackEdge). */
const issueLaneCustody = prepared((db, t) =>
  db
    .select({ repoPath: t.issues.repoPath, machineId: t.issues.machineId })
    .from(t.issues)
    .where(inWorkspace(t.issues, eq(t.issues.id, param(t.issues.id, 'id'))))
    .prepare(),
)

/** The branch custody a train member's issue holds (claimTrain). */
const issueBranchCustody = prepared((db, t) =>
  db
    .select({
      branch: t.issues.branch,
      machineId: t.issues.machineId,
      repoPath: t.issues.repoPath,
    })
    .from(t.issues)
    .where(inWorkspace(t.issues, eq(t.issues.id, param(t.issues.id, 'id'))))
    .prepare(),
)

const insertOrder = prepared((db, t) =>
  captureWrite(
    db.insert(t.shipOrders).values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      issueId: sql.placeholder('issueId'),
      repoId: sql.placeholder('repoId'),
      repoPath: sql.placeholder('repoPath'),
      machineId: sql.placeholder('machineId'),
      targetBranch: sql.placeholder('targetBranch'),
      destination: sql.placeholder('destination'),
      approvedBaseSha: sql.placeholder('approvedBaseSha'),
      approvedHeadSha: sql.placeholder('approvedHeadSha'),
      descendantManifest: sql.placeholder('descendantManifest'),
      deliveryDependsOn: sql.placeholder('deliveryDependsOn'),
      evidenceManifestRef: sql.placeholder('evidenceManifestRef'),
      currentIntegrationReceipt: sql.placeholder('currentIntegrationReceipt'),
      providerRef: sql.placeholder('providerRef'),
      requestedByActorKind: sql.placeholder('requestedByActorKind'),
      requestedByActorId: sql.placeholder('requestedByActorId'),
      requestedByOnBehalfOf: sql.placeholder('requestedByOnBehalfOf'),
      requestedAt: sql.placeholder('requestedAt'),
      policyId: sql.placeholder('policyId'),
      validationProfile: sql.placeholder('validationProfile'),
      validationProfileDigest: sql.placeholder('validationProfileDigest'),
      closeMode: sql.placeholder('closeMode'),
      state: sql.placeholder('state'),
      stateChangedAt: sql.placeholder('stateChangedAt'),
      holdCode: sql.placeholder('holdCode'),
    }),
  ).prepare(),
)

/** `transitionOrder`'s compare-and-swap. */
const transitionOrderFenced = prepared((db, t) =>
  captureWrite(
    db
      .update(t.shipOrders)
      .set({
        state: sql.placeholder('nextState'),
        stateChangedAt: sql.placeholder('stateChangedAt'),
        holdCode: null,
      })
      .where(
        inWorkspace(
          t.shipOrders,
          eq(t.shipOrders.id, param(t.shipOrders.id, 'id')),
          eq(t.shipOrders.state, param(t.shipOrders.state, 'expectedState')),
          // Redundant against the equality above and kept verbatim: narrowing a
          // fence during a conversion is a behaviour change, not a tidy-up.
          notInArray(t.shipOrders.state, ['shipped', 'cancelled']),
        ),
      ),
  ).prepare(),
)

const attemptById = prepared((db, t) =>
  db
    .select()
    .from(t.shipAttempts)
    .where(inWorkspace(t.shipAttempts, eq(t.shipAttempts.id, param(t.shipAttempts.id, 'id'))))
    .prepare(),
)

const insertAttempt = prepared((db, t) =>
  db
    .insert(t.shipAttempts)
    .values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      orderId: sql.placeholder('orderId'),
      expectedSourceBaseSha: sql.placeholder('expectedSourceBaseSha'),
      approvedHeadSha: sql.placeholder('approvedHeadSha'),
      expectedTargetSha: sql.placeholder('expectedTargetSha'),
      machineId: sql.placeholder('machineId'),
      leaseGeneration: sql.placeholder('leaseGeneration'),
      startedAt: sql.placeholder('startedAt'),
      submittedHeadSha: sql.placeholder('submittedHeadSha'),
    })
    .prepare(),
)

const latestAttemptOfOrder = prepared((db, t) =>
  db
    .select()
    .from(t.shipAttempts)
    .where(
      inWorkspace(
        t.shipAttempts,
        eq(t.shipAttempts.orderId, param(t.shipAttempts.orderId, 'orderId')),
      ),
    )
    .orderBy(desc(t.shipAttempts.leaseGeneration))
    .limit(1)
    .prepare(),
)

/** One order's attempts, oldest first, through `idx_ship_attempts_order` (POD-6172). */
const attemptsOfOrder = prepared((db, t) =>
  db
    .select()
    .from(t.shipAttempts)
    .where(
      inWorkspace(
        t.shipAttempts,
        eq(t.shipAttempts.orderId, param(t.shipAttempts.orderId, 'orderId')),
      ),
    )
    .orderBy(asc(t.shipAttempts.startedAt), asc(t.shipAttempts.id))
    .prepare(),
)

const laneRevisionOf = prepared((db, t) =>
  db
    .select({ revision: t.shipLaneRevisions.revision })
    .from(t.shipLaneRevisions)
    .where(
      inWorkspace(
        t.shipLaneRevisions,
        eq(t.shipLaneRevisions.laneKey, param(t.shipLaneRevisions.laneKey, 'laneKey')),
      ),
    )
    .prepare(),
)

const insertTrainManifest = prepared((db, t) =>
  db
    .insert(t.shipTrainManifests)
    .values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      version: sql.placeholder('version'),
      subsetId: sql.placeholder('subsetId'),
      repairRound: sql.placeholder('repairRound'),
      canonicalDigest: sql.placeholder('canonicalDigest'),
      canonicalJson: sql.placeholder('canonicalJson'),
      repoId: sql.placeholder('repoId'),
      repoPath: sql.placeholder('repoPath'),
      machineId: sql.placeholder('machineId'),
      targetBranch: sql.placeholder('targetBranch'),
      expectedTargetSha: sql.placeholder('expectedTargetSha'),
      destination: sql.placeholder('destination'),
      providerRef: sql.placeholder('providerRef'),
      policyId: sql.placeholder('policyId'),
      validationProfile: sql.placeholder('validationProfile'),
      validationProfileDigest: sql.placeholder('validationProfileDigest'),
      laneKey: sql.placeholder('laneKey'),
      laneRevision: sql.placeholder('laneRevision'),
      memberCount: sql.placeholder('memberCount'),
      leaderOrderId: sql.placeholder('leaderOrderId'),
      leaderAttemptId: sql.placeholder('leaderAttemptId'),
      leaderGeneration: sql.placeholder('leaderGeneration'),
      createdAt: sql.placeholder('createdAt'),
    })
    .prepare(),
)

/**
 * The row of `INSERT INTO table (…) SELECT <row> FROM (VALUES (1)) … WHERE <refusal>`:
 * each named column's placeholder, bound to the column's encoder and cast to its
 * Postgres type. A parameter in a select list has no type of its own (Postgres reads it
 * as text, which does not assign to an integer or a timestamp), so the cast gives it the
 * column's. The twin's `text COLLATE "C"` is cast as `text`: a type name in a CAST
 * carries no collation, and an inserted value needs none.
 */
function insertedRow(table: Table, keys: readonly string[]): Record<string, SQL.Aliased> {
  const columns = getTableColumns(table) as Record<string, Column>
  return Object.fromEntries(
    keys.map((key) => {
      const target = columns[key]
      if (target === undefined) throw new Error(`insertedRow: no column ${key}`)
      const type = target.getSQLType().replace(/\s+COLLATE\s+.*$/i, '')
      return [key, sql`CAST(${param(target, key)} AS ${sql.raw(type)})`.as(target.name)]
    }),
  )
}

/**
 * The one row an in-statement guarded insert selects from: the row it writes is its
 * parameters, so the guard's lookups decide alone whether it is written or refused.
 */
const ONE_ROW = sql`(VALUES (1)) AS guarded(one)`

/** The member row's columns, as `insertTrainMember` writes them. */
const TRAIN_MEMBER_KEYS = [
  'workspaceId',
  'trainId',
  'ordinal',
  'issueId',
  'orderId',
  'attemptId',
  'generation',
  'machineId',
  'sourceBranch',
  'approvedBaseSha',
  'approvedHeadSha',
  'deliveryDependsOn',
] as const

/**
 * A train member's insert. SQLite's triggers guard it (`ship_train_members_insert_guard`,
 * then `ship_train_members_final_leader`); on Postgres the insert carries the same three
 * rules as its in-statement refusal (design 2.5, `refusalTerm`), in the triggers' order,
 * every lookup in the member's own workspace: an ordinal at or past the manifest's member
 * count, a train that already holds an active claim, a final member that is not the
 * manifest's leader. A manifest that is not there refuses nothing, as on SQLite: the
 * foreign key refuses the row.
 */
const insertTrainMember = prepared((db, t) => {
  if (dialectOf(db) !== 'pg') {
    return db
      .insert(t.shipTrainMembers)
      .values({
        workspaceId: WORKSPACE,
        trainId: sql.placeholder('trainId'),
        ordinal: sql.placeholder('ordinal'),
        issueId: sql.placeholder('issueId'),
        orderId: sql.placeholder('orderId'),
        attemptId: sql.placeholder('attemptId'),
        generation: sql.placeholder('generation'),
        machineId: sql.placeholder('machineId'),
        sourceBranch: sql.placeholder('sourceBranch'),
        approvedBaseSha: sql.placeholder('approvedBaseSha'),
        approvedHeadSha: sql.placeholder('approvedHeadSha'),
        deliveryDependsOn: sql.placeholder('deliveryDependsOn'),
      })
      .prepare()
  }
  const m = t.shipTrainManifests
  const member = t.shipTrainMembers
  const workspace = param(m.workspaceId, 'workspaceId')
  const train = param(m.id, 'trainId')
  const ordinal = sql`CAST(${param(member.ordinal, 'ordinal')} AS integer)`
  const memberCount = sql`(SELECT m.member_count FROM ${m} m WHERE m.workspace_id = ${workspace} AND m.id = ${train})`
  // drizzle types an insert's selection by the table's own column types; this row is
  // cast column by column (`insertedRow`), so its type is asserted here.
  const row = db
    .select(insertedRow(member, TRAIN_MEMBER_KEYS))
    .from(ONE_ROW)
    .where(
      refusalTerm([
        {
          when: sql`${ordinal} >= ${memberCount}`,
          text: GUARD_TEXT.ship_train_members_ordinal,
        },
        {
          when: sql`EXISTS (SELECT 1 FROM ${t.shipTrainActiveClaims} c WHERE c.workspace_id = ${workspace} AND c.train_id = ${train})`,
          text: GUARD_TEXT.ship_train_members_sealed,
        },
        {
          when: sql`${ordinal} + 1 = ${memberCount} AND NOT EXISTS (SELECT 1 FROM ${m} m WHERE m.workspace_id = ${workspace} AND m.id = ${train} AND m.leader_order_id = ${param(m.leaderOrderId, 'orderId')} AND m.leader_attempt_id = ${param(m.leaderAttemptId, 'attemptId')} AND m.leader_generation = ${param(m.leaderGeneration, 'generation')})`,
          text: GUARD_TEXT.ship_train_members_final_leader,
        },
      ]),
    )
  return db
    .insert(member)
    .select(row as never)
    .prepare()
})

/**
 * An active claim's insert. SQLite's `ship_train_active_claims_insert_guard` refuses a
 * claim without complete, normalized leader authority; on Postgres the insert carries
 * that rule as its in-statement refusal (design 2.5), every lookup in the claim's own
 * workspace: the manifest is open, the claim's member is recorded with this attempt and
 * generation, every member is recorded, the final one is the manifest's leader, and no
 * member has a generation below 1.
 */
const insertActiveClaim = prepared((db, t) => {
  if (dialectOf(db) !== 'pg') {
    return db
      .insert(t.shipTrainActiveClaims)
      .values({
        workspaceId: WORKSPACE,
        trainId: sql.placeholder('trainId'),
        orderId: sql.placeholder('orderId'),
        attemptId: sql.placeholder('attemptId'),
        generation: sql.placeholder('generation'),
      })
      .prepare()
  }
  const m = t.shipTrainManifests
  const tm = t.shipTrainMembers
  const claim = t.shipTrainActiveClaims
  const workspace = param(m.workspaceId, 'workspaceId')
  // drizzle types an insert's selection by the table's own column types; this row is
  // cast column by column (`insertedRow`), so its type is asserted here.
  const row = db
    .select(insertedRow(claim, ['workspaceId', 'trainId', 'orderId', 'attemptId', 'generation']))
    .from(ONE_ROW)
    .where(
      refusalTerm([
        {
          when: sql`NOT EXISTS (SELECT 1 FROM ${m} m JOIN ${tm} tm ON tm.workspace_id = m.workspace_id AND tm.train_id = m.id
            WHERE m.workspace_id = ${workspace} AND m.id = ${param(m.id, 'trainId')} AND m.released_at IS NULL
              AND tm.order_id = ${param(tm.orderId, 'orderId')} AND tm.attempt_id = ${param(tm.attemptId, 'attemptId')}
              AND tm.generation = ${param(tm.generation, 'generation')}
              AND (SELECT COUNT(*) FROM ${tm} all_members WHERE all_members.workspace_id = m.workspace_id AND all_members.train_id = m.id) = m.member_count
              AND EXISTS (SELECT 1 FROM ${tm} leader WHERE leader.workspace_id = m.workspace_id AND leader.train_id = m.id
                AND leader.ordinal = m.member_count - 1 AND leader.order_id = m.leader_order_id
                AND leader.attempt_id = m.leader_attempt_id AND leader.generation = m.leader_generation)
              AND NOT EXISTS (SELECT 1 FROM ${tm} generation_member WHERE generation_member.workspace_id = m.workspace_id
                AND generation_member.train_id = m.id AND generation_member.generation <= 0))`,
          text: GUARD_TEXT.ship_train_active_claims_insert_guard,
        },
      ]),
    )
  return db
    .insert(claim)
    .select(row as never)
    .prepare()
})

/** The projection named 19 of the manifest table's columns and the join adds
 * none, so `select()` over the joined table returns the same fields. */
const manifestOfAttempt = prepared((db, t) =>
  db
    .select(trainManifestColumns(t))
    .from(t.shipTrainManifests)
    .innerJoin(
      t.shipTrainMembers,
      and(
        sameWorkspace(t.shipTrainMembers, t.shipTrainManifests),
        eq(t.shipTrainMembers.trainId, t.shipTrainManifests.id),
      ),
    )
    .where(
      inWorkspace(
        t.shipTrainManifests,
        eq(t.shipTrainMembers.attemptId, param(t.shipTrainMembers.attemptId, 'attemptId')),
      ),
    )
    .prepare(),
)

const membersOfTrain = prepared((db, t) =>
  db
    .select(trainMemberColumns(t))
    .from(t.shipTrainMembers)
    .where(
      inWorkspace(
        t.shipTrainMembers,
        eq(t.shipTrainMembers.trainId, param(t.shipTrainMembers.trainId, 'trainId')),
      ),
    )
    .orderBy(asc(t.shipTrainMembers.ordinal))
    .prepare(),
)

const claimedAttemptOfOrder = prepared((db, t) =>
  db
    .select({ attemptId: t.shipTrainActiveClaims.attemptId })
    .from(t.shipTrainActiveClaims)
    .innerJoin(
      t.shipTrainManifests,
      and(
        sameWorkspace(t.shipTrainManifests, t.shipTrainActiveClaims),
        eq(t.shipTrainManifests.id, t.shipTrainActiveClaims.trainId),
      ),
    )
    .where(
      inWorkspace(
        t.shipTrainActiveClaims,
        eq(t.shipTrainActiveClaims.orderId, param(t.shipTrainActiveClaims.orderId, 'orderId')),
        isNull(t.shipTrainManifests.releasedAt),
      ),
    )
    .prepare(),
)

const trainLaneAuthority = prepared((db, t) =>
  db
    .select({
      releasedAt: t.shipTrainManifests.releasedAt,
      revision: t.shipLaneRevisions.revision,
      // The correlated count is a DECISION about what "still claimed" means,
      // and drizzle has no builder form for a correlated subquery in a
      // projection, so it stays a `sql` fragment inside the builder query
      // (spec rule 1). The predicate is unchanged.
      claimCount: activeClaimCount(t),
    })
    .from(t.shipTrainManifests)
    .innerJoin(
      t.shipLaneRevisions,
      and(
        sameWorkspace(t.shipLaneRevisions, t.shipTrainManifests),
        eq(t.shipLaneRevisions.laneKey, t.shipTrainManifests.laneKey),
      ),
    )
    .where(
      inWorkspace(
        t.shipTrainManifests,
        eq(t.shipTrainManifests.id, param(t.shipTrainManifests.id, 'id')),
      ),
    )
    .prepare(),
)

const activeClaimOrdersOfLane = prepared((db, t) =>
  db
    .select({ orderId: t.shipTrainActiveClaims.orderId })
    .from(t.shipTrainActiveClaims)
    .innerJoin(
      t.shipTrainManifests,
      and(
        sameWorkspace(t.shipTrainManifests, t.shipTrainActiveClaims),
        eq(t.shipTrainManifests.id, t.shipTrainActiveClaims.trainId),
      ),
    )
    .where(
      inWorkspace(
        t.shipTrainActiveClaims,
        eq(t.shipTrainManifests.laneKey, param(t.shipTrainManifests.laneKey, 'laneKey')),
        isNull(t.shipTrainManifests.releasedAt),
      ),
    )
    .orderBy(
      asc(t.shipTrainManifests.createdAt),
      asc(t.shipTrainManifests.id),
      asc(t.shipTrainActiveClaims.orderId),
    )
    .prepare(),
)

const trainReleaseState = prepared((db, t) =>
  db
    .select({
      releasedAt: t.shipTrainManifests.releasedAt,
      releaseReason: t.shipTrainManifests.releaseReason,
    })
    .from(t.shipTrainManifests)
    .where(
      inWorkspace(
        t.shipTrainManifests,
        eq(t.shipTrainManifests.id, param(t.shipTrainManifests.id, 'id')),
      ),
    )
    .prepare(),
)

/**
 * A train's one release. SQLite's `ship_train_manifests_release_only` refuses an update
 * of a released manifest (the WHERE never meets one) or one that leaves `released_at`
 * NULL; on Postgres the latter is the update's in-statement refusal (design 2.5).
 */
const releaseTrainFenced = prepared((db, t) => {
  const m = t.shipTrainManifests
  const fence = inWorkspace(m, eq(m.id, param(m.id, 'id')), isNull(m.releasedAt))
  return db
    .update(m)
    .set({
      releasedAt: sql.placeholder('releasedAt'),
      releaseReason: sql.placeholder('releaseReason'),
    })
    .where(
      dialectOf(db) === 'pg'
        ? and(
            fence,
            refusalTerm(
              [
                {
                  // The row's own column keeps the term per row: a parameter alone would
                  // be folded at planning, and refuse a release that meets no row.
                  when: sql`${m.releasedAt} IS NULL AND ${param(m.releasedAt, 'releasedAt')}::timestamptz IS NULL`,
                  text: GUARD_TEXT.ship_train_manifests_release_only,
                },
              ],
              fence,
            ),
          )
        : fence,
    )
    .prepare()
})

/**
 * The release of a train's claims. SQLite's `ship_train_active_claims_release_guard`
 * refuses to delete a claim while its manifest is open; on Postgres the delete carries
 * that rule (its declaration in `append-only.ts`) as its in-statement refusal.
 */
const deleteActiveClaimsOfTrain = prepared((db, t) => {
  const claims = t.shipTrainActiveClaims
  const scope = inWorkspace(claims, eq(claims.trainId, param(claims.trainId, 'trainId')))
  const guard =
    dialectOf(db) === 'pg' ? writeGuard({ table: 'ship_train_active_claims', op: 'd' }) : undefined
  return db
    .delete(claims)
    .where(guard?.where?.(scope) ?? scope)
    .prepare()
})

const trainMemberCountOf = prepared((db, t) =>
  db
    .select({ memberCount: t.shipTrainManifests.memberCount })
    .from(t.shipTrainManifests)
    .where(
      inWorkspace(
        t.shipTrainManifests,
        eq(t.shipTrainManifests.id, param(t.shipTrainManifests.id, 'id')),
      ),
    )
    .prepare(),
)

/** `isolateTrainFailure`'s green-member reset: any non-terminal, non-held state. */
const requeueLiveOrder = prepared((db, t) =>
  captureWrite(
    db
      .update(t.shipOrders)
      .set({ state: 'queued', stateChangedAt: sql.placeholder('stateChangedAt'), holdCode: null })
      .where(
        inWorkspace(
          t.shipOrders,
          eq(t.shipOrders.id, param(t.shipOrders.id, 'id')),
          notInArray(t.shipOrders.state, ['shipped', 'cancelled', 'held']),
        ),
      ),
  ).prepare(),
)

const openTrainsOfLane = prepared((db, t) =>
  db
    .select({ id: t.shipTrainManifests.id })
    .from(t.shipTrainManifests)
    .where(
      inWorkspace(
        t.shipTrainManifests,
        eq(t.shipTrainManifests.laneKey, param(t.shipTrainManifests.laneKey, 'laneKey')),
        isNull(t.shipTrainManifests.releasedAt),
      ),
    )
    .orderBy(asc(t.shipTrainManifests.createdAt), asc(t.shipTrainManifests.id))
    .prepare(),
)

/** The leaders of the open trains whose leader already shipped (POD-6207).
 *  Walks the partial index idx_ship_train_manifests_open_lane (named with
 *  INDEXED BY), so the cost follows the open trains, never the shipped
 *  history. */
const shippedLeadersOfOpenTrains = prepared((db, t) =>
  db
    // A column chunk rather than the column: the FROM is an INDEXED BY clause,
    // not the table object. Postgres has no INDEXED BY and plans the partial
    // index from the same `released_at IS NULL` term.
    .select({ leaderOrderId: sql<ShipOrderValue['id']>`${t.shipTrainManifests.leaderOrderId}` })
    .from(
      dialectOf(db) === 'pg'
        ? t.shipTrainManifests
        : sql`${t.shipTrainManifests} INDEXED BY idx_ship_train_manifests_open_lane`,
    )
    .innerJoin(
      t.shipOrders,
      and(
        sameWorkspace(t.shipOrders, t.shipTrainManifests),
        eq(t.shipOrders.id, t.shipTrainManifests.leaderOrderId),
      ),
    )
    .where(
      inWorkspace(
        t.shipTrainManifests,
        isNull(t.shipTrainManifests.releasedAt),
        eq(t.shipOrders.state, 'shipped'),
      ),
    )
    .prepare(),
)

const activeMembersOfTrain = prepared((db, t) =>
  db
    .select({
      orderId: t.shipTrainMembers.orderId,
      attemptId: t.shipTrainMembers.attemptId,
      generation: t.shipTrainMembers.generation,
    })
    .from(t.shipTrainMembers)
    .innerJoin(
      t.shipTrainActiveClaims,
      and(
        sameWorkspace(t.shipTrainActiveClaims, t.shipTrainMembers),
        eq(t.shipTrainActiveClaims.trainId, t.shipTrainMembers.trainId),
        eq(t.shipTrainActiveClaims.orderId, t.shipTrainMembers.orderId),
      ),
    )
    .where(
      inWorkspace(
        t.shipTrainMembers,
        eq(t.shipTrainMembers.trainId, param(t.shipTrainMembers.trainId, 'trainId')),
      ),
    )
    .orderBy(asc(t.shipTrainMembers.ordinal))
    .prepare(),
)

/** A train peer still in preflight goes back to the queue; three call sites. */
const requeuePreflightOrder = prepared((db, t) =>
  captureWrite(
    db
      .update(t.shipOrders)
      .set({ state: 'queued', stateChangedAt: sql.placeholder('stateChangedAt'), holdCode: null })
      .where(
        inWorkspace(
          t.shipOrders,
          eq(t.shipOrders.id, param(t.shipOrders.id, 'id')),
          eq(t.shipOrders.state, 'preflight'),
        ),
      ),
  ).prepare(),
)

const stackEdgeByPair = prepared((db, t) =>
  db
    .select()
    .from(t.shipOrderStackEdges)
    .where(
      inWorkspace(
        t.shipOrderStackEdges,
        eq(
          t.shipOrderStackEdges.upperOrderId,
          param(t.shipOrderStackEdges.upperOrderId, 'upperOrderId'),
        ),
        eq(
          t.shipOrderStackEdges.lowerOrderId,
          param(t.shipOrderStackEdges.lowerOrderId, 'lowerOrderId'),
        ),
      ),
    )
    .prepare(),
)

const insertStackEdge = prepared((db, t) =>
  captureWrite(
    db.insert(t.shipOrderStackEdges).values({
      workspaceId: WORKSPACE,
      upperOrderId: sql.placeholder('upperOrderId'),
      lowerOrderId: sql.placeholder('lowerOrderId'),
      upperApprovedHeadSha: sql.placeholder('upperApprovedHeadSha'),
      lowerApprovedHeadSha: sql.placeholder('lowerApprovedHeadSha'),
      recordedAt: sql.placeholder('recordedAt'),
    }),
  ).prepare(),
)

const stackEdgePresent = prepared((db, t) =>
  db
    .select({ present: sql<number>`1` })
    .from(t.shipOrderStackEdges)
    .where(
      inWorkspace(
        t.shipOrderStackEdges,
        eq(
          t.shipOrderStackEdges.upperOrderId,
          param(t.shipOrderStackEdges.upperOrderId, 'upperOrderId'),
        ),
        eq(
          t.shipOrderStackEdges.lowerOrderId,
          param(t.shipOrderStackEdges.lowerOrderId, 'lowerOrderId'),
        ),
      ),
    )
    .prepare(),
)

const finishAttemptFenced = prepared((db, t) =>
  db
    .update(t.shipAttempts)
    .set({
      finishedAt: sql.placeholder('finishedAt'),
      outcome: sql.placeholder('outcome'),
      // Every value stays an EXPLICIT null at the call site. An omitted key in
      // a drizzle `set` is not written at all, which would leave the previous
      // value standing where the raw statement cleared it.
      testedIntegrationSha: sql.placeholder('testedIntegrationSha'),
      landedRefSha: sql.placeholder('landedRefSha'),
      destinationSha: sql.placeholder('destinationSha'),
      validationProfileId: sql.placeholder('validationProfileId'),
      validationResult: sql.placeholder('validationResult'),
    })
    .where(
      inWorkspace(
        t.shipAttempts,
        eq(t.shipAttempts.id, param(t.shipAttempts.id, 'id')),
        eq(
          t.shipAttempts.leaseGeneration,
          param(t.shipAttempts.leaseGeneration, 'leaseGeneration'),
        ),
        isNull(t.shipAttempts.finishedAt),
      ),
    )
    .prepare(),
)

const stepByIdempotency = prepared((db, t) =>
  db
    .select(stepColumns(t))
    .from(t.shipSteps)
    .where(
      inWorkspace(
        t.shipSteps,
        eq(t.shipSteps.attemptId, param(t.shipSteps.attemptId, 'attemptId')),
        eq(t.shipSteps.idempotencyKey, param(t.shipSteps.idempotencyKey, 'idempotencyKey')),
      ),
    )
    .prepare(),
)

const insertStep = prepared((db, t) =>
  db
    .insert(t.shipSteps)
    .values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      orderId: sql.placeholder('orderId'),
      attemptId: sql.placeholder('attemptId'),
      effectKey: sql.placeholder('effectKey'),
      idempotencyKey: sql.placeholder('idempotencyKey'),
      generation: sql.placeholder('generation'),
      inputFence: sql.placeholder('inputFence'),
      kind: sql.placeholder('kind'),
      state: sql.placeholder('state'),
      outcome: sql.placeholder('outcome'),
      summary: sql.placeholder('summary'),
      artifactRef: sql.placeholder('artifactRef'),
      recordedAt: sql.placeholder('recordedAt'),
      startedAt: sql.placeholder('startedAt'),
      finishedAt: sql.placeholder('finishedAt'),
    })
    .prepare(),
)

const stepOfId = prepared((db, t) =>
  db
    .select(stepColumns(t))
    .from(t.shipSteps)
    .where(inWorkspace(t.shipSteps, eq(t.shipSteps.id, param(t.shipSteps.id, 'id'))))
    .prepare(),
)

const stepsOfAttempt = prepared((db, t) =>
  db
    .select(stepColumns(t))
    .from(t.shipSteps)
    .where(
      inWorkspace(
        t.shipSteps,
        eq(t.shipSteps.attemptId, param(t.shipSteps.attemptId, 'attemptId')),
      ),
    )
    .orderBy(asc(t.shipSteps.recordedAt), asc(t.shipSteps.id))
    .prepare(),
)

/** A fixed test clock and fast production transitions can share one timestamp.
 * Lifecycle rank, not the textual step id, identifies the durable successor. */
const latestStepOfEffect = prepared((db, t) =>
  db
    .select(stepColumns(t))
    .from(t.shipSteps)
    .where(
      inWorkspace(
        t.shipSteps,
        eq(t.shipSteps.attemptId, param(t.shipSteps.attemptId, 'attemptId')),
        eq(t.shipSteps.effectKey, param(t.shipSteps.effectKey, 'effectKey')),
      ),
    )
    // The lifecycle rank is an ordering DECISION, not a column, so it stays a
    // `sql` fragment inside the builder query — which spec rule 1 allows
    // anywhere. Its arms and their order are unchanged.
    .orderBy(
      sql`CASE ${t.shipSteps.state}
           WHEN 'planned' THEN 0
           WHEN 'running' THEN 1
           ELSE 2
         END DESC`,
      desc(t.shipSteps.recordedAt),
      desc(t.shipSteps.id),
    )
    .limit(1)
    .prepare(),
)

const openHoldOfOrder = prepared((db, t) =>
  db
    .select()
    .from(t.shipHolds)
    .where(
      inWorkspace(
        t.shipHolds,
        eq(t.shipHolds.orderId, param(t.shipHolds.orderId, 'orderId')),
        isNull(t.shipHolds.resolvedAt),
      ),
    )
    .prepare(),
)

const allHolds = prepared((db, t) =>
  db
    .select()
    .from(t.shipHolds)
    .where(inWorkspace(t.shipHolds))
    .orderBy(asc(t.shipHolds.orderId), asc(t.shipHolds.generation))
    .prepare(),
)

const insertHold = prepared((db, t) =>
  captureWrite(
    db.insert(t.shipHolds).values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      orderId: sql.placeholder('orderId'),
      generation: sql.placeholder('generation'),
      reasonCode: sql.placeholder('reasonCode'),
      headline: sql.placeholder('headline'),
      detail: sql.placeholder('detail'),
      evidenceRefs: sql.placeholder('evidenceRefs'),
      actions: sql.placeholder('actions'),
      raisedAt: sql.placeholder('raisedAt'),
    }),
  ).prepare(),
)

const holdOrderFenced = prepared((db, t) =>
  captureWrite(
    db
      .update(t.shipOrders)
      .set({
        state: 'held',
        holdCode: sql.placeholder('holdCode'),
        stateChangedAt: sql.placeholder('stateChangedAt'),
      })
      .where(
        inWorkspace(
          t.shipOrders,
          eq(t.shipOrders.id, param(t.shipOrders.id, 'id')),
          notInArray(t.shipOrders.state, ['shipped', 'cancelled']),
        ),
      ),
  ).prepare(),
)

const resolveHoldFenced = prepared((db, t) =>
  captureWrite(
    db
      .update(t.shipHolds)
      .set({ resolvedAt: sql.placeholder('resolvedAt'), resolution: sql.placeholder('resolution') })
      .where(
        inWorkspace(
          t.shipHolds,
          eq(t.shipHolds.orderId, param(t.shipHolds.orderId, 'orderId')),
          eq(t.shipHolds.generation, param(t.shipHolds.generation, 'generation')),
          isNull(t.shipHolds.resolvedAt),
        ),
      ),
  ).prepare(),
)

const releaseHeldOrder = prepared((db, t) =>
  captureWrite(
    db
      .update(t.shipOrders)
      .set({
        state: sql.placeholder('nextState'),
        holdCode: null,
        stateChangedAt: sql.placeholder('stateChangedAt'),
      })
      .where(
        inWorkspace(
          t.shipOrders,
          eq(t.shipOrders.id, param(t.shipOrders.id, 'id')),
          eq(t.shipOrders.state, 'held'),
        ),
      ),
  ).prepare(),
)

const holdOfOrderGeneration = prepared((db, t) =>
  db
    .select()
    .from(t.shipHolds)
    .where(
      inWorkspace(
        t.shipHolds,
        eq(t.shipHolds.orderId, param(t.shipHolds.orderId, 'orderId')),
        eq(t.shipHolds.generation, param(t.shipHolds.generation, 'generation')),
      ),
    )
    .prepare(),
)

const receiptOfOrder = prepared((db, t) =>
  db
    .select()
    .from(t.deliveryReceipts)
    .where(
      inWorkspace(
        t.deliveryReceipts,
        eq(t.deliveryReceipts.orderId, param(t.deliveryReceipts.orderId, 'orderId')),
      ),
    )
    .prepare(),
)

const allReceipts = prepared((db, t) =>
  db
    .select()
    .from(t.deliveryReceipts)
    .where(inWorkspace(t.deliveryReceipts))
    .orderBy(asc(t.deliveryReceipts.completedAt), asc(t.deliveryReceipts.id))
    .prepare(),
)

const envelopeRecordOf = prepared((db, t) =>
  db
    .select({
      requestJson: t.shipEffectEnvelopes.requestJson,
      resultJson: t.shipEffectEnvelopes.resultJson,
      recordedAt: t.shipEffectEnvelopes.recordedAt,
    })
    .from(t.shipEffectEnvelopes)
    .where(
      inWorkspace(
        t.shipEffectEnvelopes,
        eq(t.shipEffectEnvelopes.effectKey, param(t.shipEffectEnvelopes.effectKey, 'effectKey')),
      ),
    )
    .prepare(),
)

const insertEnvelope = prepared((db, t) =>
  db
    .insert(t.shipEffectEnvelopes)
    .values({
      workspaceId: WORKSPACE,
      effectKey: sql.placeholder('effectKey'),
      trainId: sql.placeholder('trainId'),
      attemptId: sql.placeholder('attemptId'),
      requestDigest: sql.placeholder('requestDigest'),
      requestJson: sql.placeholder('requestJson'),
      resultJson: sql.placeholder('resultJson'),
      recordedAt: sql.placeholder('recordedAt'),
    })
    .prepare(),
)

const envelopeProofOf = prepared((db, t) =>
  db
    .select({
      requestJson: t.shipEffectEnvelopes.requestJson,
      resultJson: t.shipEffectEnvelopes.resultJson,
    })
    .from(t.shipEffectEnvelopes)
    .where(
      inWorkspace(
        t.shipEffectEnvelopes,
        eq(t.shipEffectEnvelopes.effectKey, param(t.shipEffectEnvelopes.effectKey, 'effectKey')),
      ),
    )
    .prepare(),
)

const manifestClaimAuthority = prepared((db, t) =>
  db
    .select({
      releasedAt: t.shipTrainManifests.releasedAt,
      claimCount: activeClaimCount(t),
    })
    .from(t.shipTrainManifests)
    .where(
      inWorkspace(
        t.shipTrainManifests,
        eq(t.shipTrainManifests.id, param(t.shipTrainManifests.id, 'id')),
      ),
    )
    .prepare(),
)

const shipPreflightOrder = prepared((db, t) =>
  captureWrite(
    db
      .update(t.shipOrders)
      .set({ state: 'shipped', stateChangedAt: sql.placeholder('stateChangedAt'), holdCode: null })
      .where(
        inWorkspace(
          t.shipOrders,
          eq(t.shipOrders.id, param(t.shipOrders.id, 'id')),
          eq(t.shipOrders.state, 'preflight'),
        ),
      ),
  ).prepare(),
)

const envelopeProofsOfAttempt = prepared((db, t) =>
  db
    .select({
      requestJson: t.shipEffectEnvelopes.requestJson,
      resultJson: t.shipEffectEnvelopes.resultJson,
    })
    .from(t.shipEffectEnvelopes)
    .where(
      inWorkspace(
        t.shipEffectEnvelopes,
        eq(t.shipEffectEnvelopes.attemptId, param(t.shipEffectEnvelopes.attemptId, 'attemptId')),
      ),
    )
    .orderBy(desc(t.shipEffectEnvelopes.recordedAt))
    .prepare(),
)

const successfulProofAttempt = prepared((db, t) =>
  db
    .select({ id: t.shipAttempts.id })
    .from(t.shipAttempts)
    .where(
      inWorkspace(
        t.shipAttempts,
        eq(t.shipAttempts.orderId, param(t.shipAttempts.orderId, 'orderId')),
        sql`${t.shipAttempts.finishedAt} IS NOT NULL`,
        eq(t.shipAttempts.outcome, 'succeeded'),
        eq(
          t.shipAttempts.approvedHeadSha,
          param(t.shipAttempts.approvedHeadSha, 'approvedHeadSha'),
        ),
        eq(
          t.shipAttempts.testedIntegrationSha,
          param(t.shipAttempts.testedIntegrationSha, 'testedIntegrationSha'),
        ),
        eq(t.shipAttempts.landedRefSha, param(t.shipAttempts.landedRefSha, 'landedRefSha')),
        eq(t.shipAttempts.destinationSha, param(t.shipAttempts.destinationSha, 'destinationSha')),
        eq(
          t.shipAttempts.validationProfileId,
          param(t.shipAttempts.validationProfileId, 'validationProfileId'),
        ),
        eq(t.shipAttempts.validationResult, 'passed'),
      ),
    )
    .limit(1)
    .prepare(),
)

const shipVerifyingOrder = prepared((db, t) =>
  captureWrite(
    db
      .update(t.shipOrders)
      .set({ state: 'shipped', stateChangedAt: sql.placeholder('stateChangedAt'), holdCode: null })
      .where(
        inWorkspace(
          t.shipOrders,
          eq(t.shipOrders.id, param(t.shipOrders.id, 'id')),
          eq(t.shipOrders.state, 'verifying'),
        ),
      ),
  ).prepare(),
)

/** Narrow typed producer/consumer port shared by issue integration and Shipping
 * admission. Its lookup key is the approved root head itself—not an evidence
 * manifest reference and not an event payload. */
export interface RootIntegrationReceiptStore {
  rootIntegrationReceipt(
    rootIssueId: RootIntegrationReceiptValue['rootIssueId'],
    approvedHeadSha: string,
  ): Promise<RootIntegrationReceiptValue | null>
  recordRootIntegrationReceipt(
    input: RootIntegrationReceiptValue,
  ): Promise<RootIntegrationReceiptValue>
}

/** Durable normalized shipping family. It owns persistence invariants only;
 * admission, scheduling, machine effects, and lifecycle orchestration live above
 * this repository. */
export class ShippingRepository implements RootIntegrationReceiptStore {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query builder, read fresh on every access (rule 34a).
   *
   * A GETTER RATHER THAN A FIELD, and the difference is the whole of rule 35: a
   * field assigned in the constructor freezes this repository to the ROOT
   * instance, and ambient routing needs the enclosing transaction resolved per
   * access. B1 changes the body of this getter and nothing else in the file.
   */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  /**
   * The next hold generation's predecessor, which five call sites carried
   * verbatim. `COALESCE(MAX(generation), 0)` returns 0 for an order with no
   * hold, and every caller adds one — so an order's first hold is generation 1.
   * Kept as one aggregate read rather than `max()` over a mapped list, because
   * the zero case is the aggregate's, not the caller's.
   */
  async highestHoldGeneration(orderId: ShipOrderValue['id']): Promise<number> {
    const row = await highestHoldGenerationOf(this.db).get({ orderId })
    return row?.generation ?? 0
  }

  /** See {@link activeClaimCount}. */
  /** The immutable delivery receipt, inserted identically by the covered and
   *  the verified completion paths. */
  private async insertDeliveryReceipt(receipt: DeliveryReceiptValue): Promise<void> {
    await insertDeliveryReceiptRow(this.db).run({
      id: receipt.id,
      orderId: receipt.orderId,
      approvedBaseSha: receipt.approvedBaseSha,
      approvedHeadSha: receipt.approvedHeadSha,
      resultCommitSha: receipt.resultCommitSha,
      testedIntegrationSha: receipt.testedIntegrationSha,
      landedRefSha: receipt.landedRefSha,
      destinationSha: receipt.destinationSha,
      validationProfileId: receipt.validationProfileId,
      validationResult: receipt.validationResult,
      destination: receipt.destination,
      completedAt: receipt.completedAt,
    })
    await this.advanceRecoveryRevision()
    await this.queueDescendantInvalidation(
      descendantInvalidationKey(receipt),
      receipt.orderId,
      receipt.destinationSha,
    )
  }

  async recoveryWork(
    kind: StoredShippingRecoveryWork['kind'],
    after = '',
  ): Promise<StoredShippingRecoveryWork[]> {
    return await recoveryWorkPage(this.db).all({ kind, after })
  }

  async recoveryRevision(): Promise<number> {
    // No row yet: the workspace has never advanced its revision (see advanceRecoveryRevision).
    return (await recoveryRevision(this.db).get())?.revision ?? 0
  }

  async assertRecoveryRevision(_scope: WriteScope, expected: number): Promise<void> {
    if ((await this.recoveryRevision()) !== expected) {
      throw new Error('shipping recovery revision fence failed')
    }
  }

  private async advanceRecoveryRevision(): Promise<void> {
    await advanceRecoveryRevision(this.db).run()
  }

  async completeRecoveryWork(_scope: WriteScope, key: string): Promise<void> {
    await deleteRecoveryWork(this.db).run({ key })
  }

  private async queueDescendantInvalidation(
    key: string,
    orderId: ShipOrderValue['id'],
    destinationSha: string,
  ): Promise<void> {
    await insertRecoveryWork(this.db).run({
      key,
      kind: 'descendants',
      orderId,
      payload: JSON.stringify({ destinationSha }),
    })
  }

  async queueAdmissionInvalidation(
    _scope: WriteScope,
    admittedOrderId: ShipOrderValue['id'],
    landedOrderId: ShipOrderValue['id'],
    destinationSha: string,
    source = 'new',
  ): Promise<void> {
    await this.queueDescendantInvalidation(
      `admission:${admittedOrderId}:${source}`,
      landedOrderId,
      destinationSha,
    )
  }

  async shippedPredecessors(
    repoId: ShipOrderValue['repoId'],
    before?: Pick<ShipOrderValue, 'stateChangedAt' | 'id'>,
    containedDestinations: readonly Pick<ShipOrderValue, 'destination' | 'targetBranch'>[] = [],
  ): Promise<{ order: ShipOrderValue; destinationSha: string }[]> {
    const size = inListSize(containedDestinations.length)
    return (
      await shippedPredecessorsPage(this.db, size).all({
        repoId,
        beforeAt: before?.stateChangedAt ?? '\uffff',
        beforeId: before?.id ?? '\uffff',
        ...inListValues(
          containedDestinations.map((lane) => lane.destination),
          size,
          'containedDestination',
        ),
        ...inListValues(
          containedDestinations.map((lane) => lane.targetBranch),
          size,
          'containedBranch',
        ),
      })
    ).map((row) => ({ order: mapOrder(row), destinationSha: row.destinationSha }))
  }

  private async queueRepairAcknowledgement(input: ShippingRepairAcknowledgement): Promise<void> {
    await insertRecoveryWork(this.db).run({
      key: repairAcknowledgementKey(input.resultToken),
      kind: 'repair-ack',
      orderId: input.orderId,
      payload: JSON.stringify(input),
    })
  }

  private async queueDaemonAcknowledgement(request: ShippingDaemonAcknowledgement): Promise<void> {
    await insertRecoveryWork(this.db).run({
      key: daemonAcknowledgementKey(request),
      kind: 'daemon-ack',
      orderId: request.orderId,
      payload: JSON.stringify({ request }),
    })
  }

  async completeRepairAcknowledgement(_scope: WriteScope, resultToken: string): Promise<void> {
    await this.completeRecoveryWork(_scope, repairAcknowledgementKey(resultToken))
  }

  private async bumpLaneRevision(laneKey: string, updatedAt: string): Promise<void> {
    await bumpLaneRevisionUpsert(this.db).run({ laneKey, updatedAt })
  }

  async shippingEvidence(ref: string): Promise<StoredShippingEvidence | null> {
    const row = await evidenceByRef(this.db).get({ ref })
    return row ? { ...row } : null
  }

  async shippingEvidenceForSource(
    custodyDigest: string,
    sourceRef: string,
  ): Promise<StoredShippingEvidence | null> {
    const row = await evidenceBySource(this.db).get({ custodyDigest, sourceRef })
    return row ? { ...row } : null
  }

  async recordShippingEvidence(input: StoredShippingEvidence): Promise<StoredShippingEvidence> {
    if (createHash('sha256').update(input.content).digest('hex') !== input.contentDigest) {
      throw new Error(`shipwright evidence ${input.ref} content digest mismatch`)
    }
    const existing =
      (await this.shippingEvidence(input.ref)) ??
      (await this.shippingEvidenceForSource(input.custodyDigest, input.sourceRef))
    if (existing) {
      if (
        existing.ref !== input.ref ||
        existing.custodyDigest !== input.custodyDigest ||
        existing.contentDigest !== input.contentDigest ||
        existing.sourceRef !== input.sourceRef ||
        existing.content !== input.content
      ) {
        throw new Error(`shipwright evidence ${input.ref} immutable collision`)
      }
      return existing
    }
    await insertEvidence(this.db).run({
      ref: input.ref,
      custodyDigest: input.custodyDigest,
      contentDigest: input.contentDigest,
      sourceRef: input.sourceRef,
      content: input.content,
      materializedAt: input.materializedAt,
    })
    return { ...input }
  }

  async repairCandidatesForAttempt(
    attemptId: ShipAttemptValue['id'],
  ): Promise<StoredShippingRepairCandidate[]> {
    return (await repairCandidatesOfAttempt(this.db).all({ attemptId })).map((row) => ({ ...row }))
  }

  async repairCandidateAtSequence(
    attemptId: ShipAttemptValue['id'],
    sequence: number,
  ): Promise<StoredShippingRepairCandidate | undefined> {
    return await repairCandidateOfSequence(this.db).get({ attemptId, sequence })
  }

  private async recordRepairCandidate(input: StoredShippingRepairCandidate): Promise<void> {
    const attempt = await this.getAttempt(input.attemptId)
    const order = await this.getOrder(input.orderId)
    if (
      !attempt ||
      !order ||
      attempt.orderId !== input.orderId ||
      attempt.leaseGeneration !== input.generation ||
      attempt.finishedAt
    ) {
      throw new Error(`ship repair ${input.attemptId}:${input.sequence} custody fence failed`)
    }
    const prior = await this.repairCandidatesForAttempt(input.attemptId)
    if (input.sequence !== prior.length + 1 || input.round !== input.sequence) {
      throw new Error(`ship repair ${input.attemptId} causal sequence is not contiguous`)
    }
    if (!/^[a-f0-9]{64}$/.test(input.contextDigest)) {
      throw new Error(`ship repair ${input.attemptId}:${input.sequence} context digest is invalid`)
    }
    await insertRepairCandidate(this.db).run({
      orderId: input.orderId,
      attemptId: input.attemptId,
      generation: input.generation,
      sequence: input.sequence,
      round: input.round,
      contextDigest: input.contextDigest,
      repairRef: input.repairRef,
      candidateHeadSha: input.candidateHeadSha,
      resultToken: input.resultToken,
      recordedAt: input.recordedAt,
    })
    await this.queueRepairAcknowledgement({
      resultToken: input.resultToken,
      orderId: input.orderId,
      attemptId: input.attemptId,
      generation: input.generation,
      contextDigest: input.contextDigest,
      candidate: { repairRef: input.repairRef, candidateHeadSha: input.candidateHeadSha },
    })
  }

  /**
   * Typed pre-admission proof for one exact delivery-root head. The key includes
   * the immutable git commit, so callers never ask for an ambiguous "latest"
   * receipt and Shipping can compare it directly with the live approved head.
   */
  async rootIntegrationReceipt(
    rootIssueId: RootIntegrationReceiptValue['rootIssueId'],
    approvedHeadSha: string,
  ): Promise<RootIntegrationReceiptValue | null> {
    const row = await integrationReceiptByRootHead(this.db).get({ rootIssueId, approvedHeadSha })
    return row ? mapIntegrationReceipt(row) : null
  }

  /**
   * Append an integration receipt, idempotently. An exact replay returns the
   * stored value; the same root/head with different descendant facts is an
   * immutable-history collision and is refused rather than overwritten.
   */
  async recordRootIntegrationReceipt(
    input: RootIntegrationReceiptValue,
  ): Promise<RootIntegrationReceiptValue> {
    const receipt = canonicalIntegrationReceipt(input)
    const existing = await this.rootIntegrationReceipt(receipt.rootIssueId, receipt.approvedHeadSha)
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(receipt)) return existing
      throw new Error(
        `root integration receipt ${receipt.rootIssueId}@${receipt.approvedHeadSha} already exists with different descendants`,
      )
    }
    await insertIntegrationReceipt(this.db).run({
      rootIssueId: receipt.rootIssueId,
      approvedHeadSha: receipt.approvedHeadSha,
      // `descendants` is plain `text()`, so the serialisation stays the
      // caller's, exactly as the raw statement had it.
      descendants: JSON.stringify(receipt.descendants),
    })
    const stored = await this.rootIntegrationReceipt(receipt.rootIssueId, receipt.approvedHeadSha)
    if (!stored) throw new Error('root integration receipt insert did not persist')
    return stored
  }

  async getOrder(id: string): Promise<ShipOrderValue | null> {
    // The public signature takes a plain `string` and widening it to the brand
    // is a caller change, not a conversion; `asShipOrderId` is the identity cast
    // the model exports for exactly this boundary.
    const row = await orderById(this.db).get({ id: asShipOrderId(id) })
    return row ? mapOrder(row) : null
  }

  async activeOrderForIssue(issueId: string): Promise<ShipOrderValue | null> {
    const row = await activeOrderOfIssue(this.db).get({ issueId: asIssueId(issueId) })
    return row ? mapOrder(row) : null
  }

  /** Historical listing for the record builders. Recovery reads only its debt. */
  async listOrders(): Promise<ShipOrderValue[]> {
    return (await allOrders(this.db).all()).map(mapOrder)
  }

  /** Every active order (not shipped, not cancelled), FIFO; the shipped and
   *  cancelled history is never read (POD-6172). */
  async activeOrders(): Promise<ShipOrderValue[]> {
    return (await activeOrdersFifo(this.db).all()).map(mapOrder)
  }

  async resumableOrders(): Promise<ShipOrderValue[]> {
    return (await resumableOrdersFifo(this.db).all()).map(mapOrder)
  }

  /** The active orders of one repository under these RAW destination
   *  spellings, FIFO, read through the lane index (POD-6172). */
  async activeOrdersOfLane(
    repoId: ShipOrderValue['repoId'],
    destinations: readonly string[],
  ): Promise<ShipOrderValue[]> {
    const unique = [...new Set(destinations)]
    if (unique.length === 0) return []
    const size = inListSize(unique.length)
    return (
      await activeOrdersOfLane(this.db, size).all(
        inListValues(unique, size, 'destination', { repoId }),
      )
    ).map(mapOrder)
  }

  /**
   * The QUEUED orders of one delivery lane, FIFO, read through the lane index
   * (POD-4974 O2). `destination` is the CANONICAL destination: every raw spelling
   * that canonicalizes to it is asked for, and the canonical check below drops a
   * raw spelling that canonicalizes elsewhere under its own target branch. The
   * cost follows the lane, never the orders outside it.
   */
  async queuedLaneOrders(
    repoId: ShipOrderValue['repoId'],
    destination: string,
  ): Promise<ShipOrderValue[]> {
    const destinations = rawShippingDestinations(destination)
    const size = inListSize(destinations.length)
    return (
      await queuedOrdersOfLane(this.db, size).all(
        inListValues(destinations, size, 'destination', { repoId }),
      )
    )
      .map(mapOrder)
      .filter(
        (order) =>
          canonicalShippingDestination(order.destination, order.targetBranch) === destination,
      )
  }

  /** Point reads for a known set of orders, in one query per 500 ids. */
  async ordersByIds(ids: readonly string[]): Promise<ShipOrderValue[]> {
    const unique = [...new Set(ids)]
    const out: ShipOrderValue[] = []
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500).map(asShipOrderId)
      const size = inListSize(chunk.length)
      out.push(
        ...(await ordersOfIds(this.db, size).all(inListValues(chunk, size, 'ids'))).map(mapOrder),
      )
    }
    return out
  }

  /**
   * Queued orders that name any of `ids` as a delivery dependency. A dependency
   * that ships unblocks its dependents, and an explicit policy edge may cross
   * lanes, so a shipping commit has to find them without reading history.
   *
   * THE STATE TERM IS A LITERAL ON PURPOSE: it is the WHERE of the partial index
   * `idx_ship_orders_one_active_issue`, and SQLite uses a partial index only when
   * the query repeats that term; a bound parameter would not match it. So the
   * scan covers active orders, never shipped or cancelled ones.
   */
  async queuedDependentsOf(ids: readonly string[]): Promise<ShipOrderValue[]> {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    // The term and the IN list live in the prepared definition
    // (`queuedDependentsOfIds`); the list is bucketed by size, padded by
    // repeating its last id, which matches nothing a single copy does not.
    const size = inListSize(unique.length)
    return (await queuedDependentsOfIds(this.db, size).all(inListValues(unique, size, 'ids'))).map(
      mapOrder,
    )
  }

  /** Recorded native-stack edges whose upper order is one of `upperIds`. */
  async nativeStackEdgesFrom(
    upperIds: readonly string[],
  ): Promise<{ upperOrderId: ShipOrderValue['id']; lowerOrderId: ShipOrderValue['id'] }[]> {
    const unique = [...new Set(upperIds)]
    const out: { upperOrderId: ShipOrderValue['id']; lowerOrderId: ShipOrderValue['id'] }[] = []
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500).map(asShipOrderId)
      const size = inListSize(chunk.length)
      out.push(...(await stackEdgesFromUppers(this.db, size).all(inListValues(chunk, size, 'ids'))))
    }
    return out
  }

  /** Every recorded native-stack edge: the boot and reconcile full truth only. */
  async listNativeStackEdges(): Promise<
    { upperOrderId: ShipOrderValue['id']; lowerOrderId: ShipOrderValue['id'] }[]
  > {
    return await allStackEdgesOrdered(this.db).all()
  }

  /** The open hold of each listed order, keyed by order id. */
  async openHoldsForOrders(
    ids: readonly string[],
  ): Promise<Map<ShipOrderValue['id'], ShipHoldValue>> {
    const unique = [...new Set(ids)]
    const out = new Map<ShipOrderValue['id'], ShipHoldValue>()
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500).map(asShipOrderId)
      const size = inListSize(chunk.length)
      for (const row of await openHoldsOfOrders(this.db, size).all(
        inListValues(chunk, size, 'ids'),
      )) {
        const hold = mapHold(row)
        out.set(hold.orderId, hold)
      }
    }
    return out
  }

  /** The delivery receipt of each listed order, keyed by order id. */
  async receiptsForOrders(
    ids: readonly string[],
  ): Promise<Map<ShipOrderValue['id'], DeliveryReceiptValue>> {
    const unique = [...new Set(ids)]
    const out = new Map<ShipOrderValue['id'], DeliveryReceiptValue>()
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500).map(asShipOrderId)
      const size = inListSize(chunk.length)
      for (const row of await receiptsOfOrders(this.db, size).all(
        inListValues(chunk, size, 'ids'),
      )) {
        const receipt = mapReceipt(row)
        out.set(receipt.orderId, receipt)
      }
    }
    return out
  }

  /** The issues of a lane's queued orders: who may read the lane (POD-4974
   * decision 2). Unparseable ids name no lane. */
  async laneMemberIssueIds(laneId: string): Promise<string[]> {
    let lane: { repoId: ShipOrderValue['repoId']; destination: string }
    try {
      lane = parseShipLaneId(laneId)
    } catch {
      return []
    }
    return [
      ...new Set(
        (await this.queuedLaneOrders(lane.repoId, lane.destination)).map((order) => order.issueId),
      ),
    ]
  }

  /**
   * {@link laneMemberIssueIds} for many lanes in one read [POD-6149]. Each lane
   * gets exactly the ids, in the same order, the one-lane read returns: the
   * query is the one-lane query widened to every listed repo and raw
   * destination, and each lane keeps only its own orders. Unparseable ids name
   * no lane and map to `[]`.
   */
  async laneMemberIssueIdsMany(laneIds: Iterable<string>): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    const lanes: { laneId: string; repoId: ShipOrderValue['repoId']; destination: string }[] = []
    for (const laneId of new Set(laneIds)) {
      out.set(laneId, [])
      try {
        lanes.push({ laneId, ...parseShipLaneId(laneId) })
      } catch {
        // No lane: no members.
      }
    }
    if (lanes.length === 0) return out
    const repoIds = [...new Set(lanes.map((lane) => lane.repoId))]
    const destinations = [
      ...new Set(lanes.flatMap((lane) => rawShippingDestinations(lane.destination))),
    ]
    const repoSize = inListSize(repoIds.length)
    const destinationSize = inListSize(destinations.length)
    const orders = (
      await queuedOrdersOfLanes(this.db, `${repoSize}x${destinationSize}`).all(
        inListValues(
          destinations,
          destinationSize,
          'destination',
          inListValues(repoIds, repoSize, 'repo'),
        ),
      )
    ).map(mapOrder)
    for (const lane of lanes) {
      const members = new Set<string>()
      for (const order of orders) {
        if (order.repoId !== lane.repoId) continue
        if (
          canonicalShippingDestination(order.destination, order.targetBranch) !== lane.destination
        )
          continue
        members.add(order.issueId)
      }
      out.set(lane.laneId, [...members])
    }
    return out
  }

  async issueIdForOrder(id: string): Promise<string | null> {
    const row = await issueIdOfOrder(this.db).get({ id: asShipOrderId(id) })
    return row?.issueId ?? null
  }

  async issueIdsForOrders(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unique = [...new Set(ids)]
    const chunkSize = 500
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize)
      // The 500-id chunk stays: with the bucketed IN list it bounds the
      // prepared shapes, one placeholder per (padded) id.
      const size = inListSize(chunk.length)
      const rows = await issueIdsOfOrders(this.db, size).all(
        inListValues(chunk.map(asShipOrderId), size, 'ids'),
      )
      for (const row of rows) out.set(row.id, row.issueId)
    }
    return out
  }

  /**
   * The ids of every order of these issues, in any state [POD-6156]. Orders are
   * never deleted and never change issue, so this is every order the feed can
   * carry for them.
   */
  async orderIdsForIssues(issueIds: readonly string[]): Promise<string[]> {
    const out: string[] = []
    const unique = [...new Set(issueIds)]
    const chunkSize = 500
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize)
      const size = inListSize(chunk.length)
      const rows = await orderIdsOfIssues(this.db, size).all(
        inListValues(chunk.map(asIssueId), size, 'issueIds'),
      )
      for (const row of rows) out.push(row.id)
    }
    return out
  }

  async createOrder(_scope: WriteScope, input: ShipOrderValue): Promise<ShipOrderValue> {
    const order = ShipOrder.parse(input)
    if (order.state !== 'queued') {
      throw new Error(`ship order ${order.id} must be created queued`)
    }
    return await this.createOrJoinTransaction(async () => {
      const existing = await this.getOrder(order.id)
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(order)) return existing
        throw new Error(`ship order id ${order.id} already exists with different content`)
      }
      const active = await this.activeOrderForIssue(order.issueId)
      if (active) {
        throw new Error(`issue ${order.issueId} already has active ship order ${active.id}`)
      }
      if (!order.validationProfile || !order.validationProfileDigest) {
        throw new Error(`ship order ${order.id} has no frozen validation policy`)
      }
      const profile = canonicalValidationProfile(order.validationProfile)
      if (
        JSON.stringify(profile) !== JSON.stringify(order.validationProfile) ||
        validationProfileDigest(profile) !== order.validationProfileDigest
      ) {
        throw new Error(`ship order ${order.id} validation policy digest does not match`)
      }
      const issue = await issueLaneCustody(this.db).get({ id: order.issueId })
      if (!issue?.repoPath || !issue.machineId) {
        throw new Error(`ship order ${order.id} issue has no durable lane custody`)
      }
      if (order.repoPath !== issue.repoPath || order.machineId !== issue.machineId) {
        throw new Error(`ship order ${order.id} frozen lane custody does not match its issue`)
      }
      const laneKey = shippingLaneKey(order, {
        repoPath: issue.repoPath,
        machineId: issue.machineId,
      })
      const actor = actorColumns(order.requestedBy.actor)
      await insertOrder(this.db).run({
        id: order.id,
        issueId: order.issueId,
        repoId: order.repoId,
        repoPath: order.repoPath,
        machineId: order.machineId,
        targetBranch: order.targetBranch,
        destination: order.destination,
        approvedBaseSha: order.approvedBaseSha,
        approvedHeadSha: order.approvedHeadSha,
        // Plain `text()` columns: the serialisation stays this file's, byte
        // for byte, because the reads compare and quarantine that text.
        descendantManifest: JSON.stringify(order.descendantManifest),
        deliveryDependsOn: JSON.stringify(order.deliveryDependsOn),
        evidenceManifestRef: order.evidenceManifestRef ?? null,
        currentIntegrationReceipt: order.currentIntegrationReceipt
          ? JSON.stringify(order.currentIntegrationReceipt)
          : null,
        providerRef: order.providerRef ? JSON.stringify(order.providerRef) : null,
        requestedByActorKind: actor.kind,
        requestedByActorId: actor.id,
        requestedByOnBehalfOf: order.requestedBy.onBehalfOf,
        requestedAt: order.requestedAt,
        policyId: order.policyId,
        // `validation_profile` IS `mode: 'json'`, so the OBJECT goes in and
        // drizzle serialises it. Verified at the source rather than assumed:
        // `SQLiteTextJson.mapToDriverValue` is `JSON.stringify`, so the bytes
        // are identical to the `JSON.stringify(profile)` this replaces — which
        // matters because the train custody check compares those bytes.
        validationProfile: profile,
        validationProfileDigest: order.validationProfileDigest,
        closeMode: order.closeMode,
        state: order.state,
        stateChangedAt: order.stateChangedAt,
        holdCode: order.holdCode ?? null,
      })
      await this.advanceRecoveryRevision()
      await this.bumpLaneRevision(laneKey, order.requestedAt)
      await this.invalidateActiveLane(_scope, laneKey, order.requestedAt, 'lane-enqueue')
      return (await this.getOrder(order.id)) as ShipOrderValue
    })
  }

  /** The admission race closes here, inside the caller's outer transaction.
   * An identical active approval is the same command; a changed approval is a
   * new review and must not replace the frozen order. */
  async createOrReturnActiveOrder(
    _scope: WriteScope,
    input: ShipOrderValue,
  ): Promise<{
    order: ShipOrderValue
    created: boolean
  }> {
    const candidate = ShipOrder.parse(input)
    return await this.createOrJoinTransaction(async () => {
      const active = await this.activeOrderForIssue(candidate.issueId)
      if (active) {
        if (sameFrozenShipOrder(active, candidate)) {
          return { order: active, created: false }
        }
        throw new Error(`issue ${candidate.issueId} already has a different active ship order`)
      }
      return { order: await this.createOrder(_scope, candidate), created: true }
    })
  }

  /** Compare-and-swap an operational state. Held and verified-terminal changes
   * have dedicated methods because they must update their normalized child row
   * in the same transaction. */
  async transitionOrder(
    _scope: WriteScope,
    id: string,
    expectedState: ShipOrderState,
    nextState: Exclude<ShipOrderState, 'held' | 'shipped'>,
    stateChangedAt: string,
  ): Promise<ShipOrderValue> {
    const current = await this.getOrder(id)
    if (!current) throw new Error(`unknown ship order ${id}`)
    if (isTerminalShipOrderState(current.state)) {
      throw new Error(`terminal ship order ${id} is immutable (${current.state})`)
    }
    if (current.state === 'held')
      throw new Error(`held ship order ${id} requires fenced resolution`)
    if (current.state !== expectedState) {
      throw new Error(`ship order ${id} state fence failed: expected ${expectedState}`)
    }
    if (!isLegalShipOrderTransition(expectedState, nextState)) {
      throw new Error(`illegal ship order transition ${expectedState} → ${nextState}`)
    }
    const attempt = await this.latestAttemptForOrder(id)
    if (
      nextState !== 'cancelled' &&
      attempt &&
      (await this.hasCancellationIntent(attempt.id, attempt.leaseGeneration))
    ) {
      throw new Error(`ship order ${id} has durable cancellation intent`)
    }
    const result = await transitionOrderFenced(this.db).run({
      nextState,
      stateChangedAt,
      id: asShipOrderId(id),
      expectedState,
    })
    if (result.changes !== 1) {
      throw new Error(`ship order ${id} state fence failed: expected ${expectedState}`)
    }
    if (nextState === 'queued') await this.advanceRecoveryRevision()
    return (await this.getOrder(id)) as ShipOrderValue
  }

  async getAttempt(id: string): Promise<ShipAttemptValue | null> {
    const row = await attemptById(this.db).get({ id: asShipAttemptId(id) })
    return row ? mapAttempt(row) : null
  }

  async createAttempt(_scope: WriteScope, input: ShipAttemptValue): Promise<ShipAttemptValue> {
    const attempt = ShipAttempt.parse(input)
    const existing = await this.getAttempt(attempt.id)
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(attempt)) return existing
      throw new Error(`ship attempt id ${attempt.id} already exists with different content`)
    }
    const order = await this.getOrder(attempt.orderId)
    if (!order) throw new Error(`unknown ship order ${attempt.orderId}`)
    if (isTerminalShipOrderState(order.state)) {
      throw new Error(`terminal ship order ${order.id} cannot start an attempt`)
    }
    if (
      attempt.expectedSourceBaseSha !== order.approvedBaseSha ||
      attempt.approvedHeadSha !== order.approvedHeadSha
    ) {
      throw new Error(`ship attempt ${attempt.id} does not match order ${order.id} approval fence`)
    }
    if (
      attempt.finishedAt ||
      attempt.outcome ||
      attempt.validationProfileId ||
      attempt.validationResult ||
      attempt.testedIntegrationSha ||
      attempt.landedRefSha ||
      attempt.destinationSha
    ) {
      throw new Error(`ship attempt ${attempt.id} must be created unfinished`)
    }
    await insertAttempt(this.db).run({
      id: attempt.id,
      orderId: attempt.orderId,
      expectedSourceBaseSha: attempt.expectedSourceBaseSha,
      approvedHeadSha: attempt.approvedHeadSha,
      expectedTargetSha: attempt.expectedTargetSha,
      machineId: attempt.machineId,
      leaseGeneration: attempt.leaseGeneration,
      startedAt: attempt.startedAt,
      submittedHeadSha: attempt.submittedHeadSha,
    })
    return (await this.getAttempt(attempt.id)) as ShipAttemptValue
  }

  async latestAttemptForOrder(orderId: string): Promise<ShipAttemptValue | null> {
    const row = await latestAttemptOfOrder(this.db).get({ orderId: asShipOrderId(orderId) })
    return row ? mapAttempt(row) : null
  }

  /** One order's attempts, oldest first. */
  async attemptsForOrder(orderId: ShipOrderValue['id']): Promise<ShipAttemptValue[]> {
    return (await attemptsOfOrder(this.db).all({ orderId })).map(mapAttempt)
  }

  async claimTrain(
    _scope: WriteScope,
    input: {
      leaderOrderId: ShipOrderValue['id']
      startedAt: string
      members: { orderId: ShipOrderValue['id'] }[]
    },
  ): Promise<{
    manifest: ShipTrainManifestValue
    claimed: { order: ShipOrderValue; attempt: ShipAttemptValue }[]
  }> {
    return await this.createOrJoinTransaction(async () => {
      const requestedIds = [...new Set(input.members.map((member) => member.orderId))]
      if (requestedIds.length === 0 || requestedIds.length !== input.members.length) {
        throw new Error('ship train claim requires unique non-empty order ids')
      }
      const selected = await Promise.all(
        requestedIds.map(async (id) => {
          const order = await this.getOrder(id)
          if (!order || order.state !== 'queued') {
            throw new Error(`ship train member ${id} is not queued`)
          }
          return order
        }),
      )
      const leaderOrder = await this.getOrder(input.leaderOrderId)
      if (!leaderOrder || !requestedIds.includes(leaderOrder.id)) {
        throw new Error('ship train leader is absent from its claimed prefix')
      }
      const laneDestination = canonicalShippingDestination(
        leaderOrder.destination,
        leaderOrder.targetBranch,
      )
      const providerKey = JSON.stringify(leaderOrder.providerRef ?? null)
      const attributionKey = JSON.stringify(leaderOrder.requestedBy)
      const compatible = (order: ShipOrderValue): boolean =>
        order.repoId === leaderOrder.repoId &&
        order.repoPath === leaderOrder.repoPath &&
        order.machineId === leaderOrder.machineId &&
        order.targetBranch === leaderOrder.targetBranch &&
        order.approvedBaseSha === leaderOrder.approvedBaseSha &&
        canonicalShippingDestination(order.destination, order.targetBranch) === laneDestination &&
        JSON.stringify(order.providerRef ?? null) === providerKey &&
        order.policyId === leaderOrder.policyId &&
        order.validationProfileDigest === leaderOrder.validationProfileDigest &&
        order.closeMode === leaderOrder.closeMode &&
        JSON.stringify(order.requestedBy) === attributionKey
      if (selected.some((order) => !compatible(order))) {
        throw new Error('ship train members cross an immutable delivery lane')
      }
      const issueFacts = new Map(
        await Promise.all(
          selected.map(async (order) => {
            const row = await issueBranchCustody(this.db).get({ id: order.issueId })
            if (!row?.branch || !row.machineId || !row.repoPath) {
              throw new Error(`ship train issue ${order.issueId} has no durable branch custody`)
            }
            if (order.repoPath !== row.repoPath || order.machineId !== row.machineId) {
              throw new Error(`ship train order ${order.id} frozen lane custody changed`)
            }
            return [
              order.id,
              { branch: row.branch, machineId: row.machineId, repoPath: row.repoPath },
            ] as const
          }),
        ),
      )
      if (new Set([...issueFacts.values()].map((facts) => facts.machineId)).size !== 1) {
        throw new Error('ship train members cross machine custody')
      }
      if (new Set([...issueFacts.values()].map((facts) => facts.branch)).size !== selected.length) {
        throw new Error('ship train source branches must be unique')
      }
      if (new Set([...issueFacts.values()].map((facts) => facts.repoPath)).size !== 1) {
        throw new Error('ship train members cross repository paths')
      }
      const laneKey = shippingLaneKey(leaderOrder, issueFacts.get(leaderOrder.id)!)
      if (selected.some((order) => shippingLaneKey(order, issueFacts.get(order.id)!) !== laneKey)) {
        throw new Error('ship train members cross canonical lane authority')
      }
      const laneRevisionRow = await laneRevisionOf(this.db).get({ laneKey })
      if (!laneRevisionRow || laneRevisionRow.revision < 1) {
        throw new Error('ship train lane has no durable revision')
      }
      // The lane's own active orders, never the whole order history (POD-6172):
      // `compatible` requires the leader's repository and canonical destination,
      // and every raw spelling of that destination is asked for.
      const occupiedLane = (
        await this.activeOrdersOfLane(leaderOrder.repoId, rawShippingDestinations(laneDestination))
      ).find(
        (order) =>
          compatible(order) &&
          !isTerminalShipOrderState(order.state) &&
          order.state !== 'held' &&
          order.state !== 'queued',
      )
      if (occupiedLane) {
        throw new Error(
          `ship train lane is already occupied by earlier ${occupiedLane.state} order ${occupiedLane.id}`,
        )
      }
      const laneOrders = (await this.queuedLaneOrders(leaderOrder.repoId, laneDestination)).filter(
        (order) => order.state === 'queued' && compatible(order),
      )
      // Only the lane's queued orders are asked for their dependencies, so only
      // their stack edges and the orders they name are read.
      const stackEdges = await this.nativeStackEdgesFrom(laneOrders.map((order) => order.id))
      const stackLower = new Map<ShipOrderValue['id'], ShipOrderValue['id'][]>()
      for (const edge of stackEdges) {
        const lower = stackLower.get(edge.upperOrderId) ?? []
        lower.push(edge.lowerOrderId)
        stackLower.set(edge.upperOrderId, lower)
      }
      const dependencies = (order: ShipOrderValue): ShipOrderValue['deliveryDependsOn'] =>
        [...new Set([...order.deliveryDependsOn, ...(stackLower.get(order.id) ?? [])])].sort()
      const allOrders = new Map(
        (await this.ordersByIds(laneOrders.flatMap((order) => dependencies(order)))).map(
          (order) => [order.id, order],
        ),
      )
      const remaining = new Map(laneOrders.map((order) => [order.id, order]))
      const topological: ShipOrderValue[] = []
      while (remaining.size > 0) {
        const ready = [...remaining.values()]
          .filter((order) =>
            dependencies(order).every((dependencyId) => {
              const dependency = allOrders.get(dependencyId)
              return (
                dependency?.state === 'shipped' ||
                topological.some((candidate) => candidate.id === dependencyId)
              )
            }),
          )
          .sort(
            (left, right) =>
              left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id),
          )
        const next = ready[0]
        if (!next) break
        topological.push(next)
        remaining.delete(next.id)
      }
      const canonical: ShipOrderValue[] = []
      const unordered = [...topological]
      const laneIds = new Set(topological.map((order) => order.id))
      while (unordered.length > 0) {
        const run = [unordered.shift()!]
        while (true) {
          const predecessor = run.at(-1)!
          const successorIndex = unordered.findIndex(
            (order) =>
              dependencies(order).includes(predecessor.id) &&
              dependencies(order).every(
                (id) => !laneIds.has(id) || run.some((member) => member.id === id),
              ),
          )
          if (successorIndex < 0) break
          run.push(unordered.splice(successorIndex, 1)[0]!)
        }
        canonical.push(...run)
      }
      const prefix = canonical.slice(0, selected.length)
      if (
        prefix.length !== selected.length ||
        prefix.some((order) => !requestedIds.includes(order.id)) ||
        prefix.at(-1)?.id !== input.leaderOrderId
      ) {
        throw new Error('ship train claim is not the canonical contiguous dependency/FIFO prefix')
      }
      if (!leaderOrder.validationProfile || !leaderOrder.validationProfileDigest) {
        throw new Error(`ship train leader ${leaderOrder.id} has no frozen validation policy`)
      }
      const profile = canonicalValidationProfile(leaderOrder.validationProfile)
      if (validationProfileDigest(profile) !== leaderOrder.validationProfileDigest) {
        throw new Error(`ship train leader ${leaderOrder.id} validation policy drifted`)
      }
      const machineId = issueFacts.get(prefix[0]!.id)!.machineId as ShipAttemptValue['machineId']
      // SEQUENTIAL, not Promise.all. Every claim opens a nested transaction
      // under this one, and savepoints are a stack: two of them in flight at
      // once release out of order. The pre-flip code was a synchronous map, so
      // the ordering was free; awaiting each claim in turn is what preserves it
      // (POD-3499).
      const claimed: { order: ShipOrderValue; attempt: ShipAttemptValue }[] = []
      for (const order of prefix) {
        const previous = await this.latestAttemptForOrder(order.id)
        claimed.push(
          await this.claimAttempt(_scope, {
            orderId: order.id,
            expectedState: 'queued',
            expectedAttemptId: previous?.id ?? null,
            expectedGeneration: previous?.leaseGeneration ?? 0,
            machineId,
            startedAt: input.startedAt,
          }),
        )
      }
      const byOrder = new Map(claimed.map((item) => [item.order.id, item]))
      const members = prefix.map((order, index) => {
        const item = byOrder.get(order.id)!
        const issue = issueFacts.get(order.id)!
        return {
          orderId: order.id,
          issueId: order.issueId,
          attemptId: item.attempt.id,
          generation: item.attempt.leaseGeneration,
          machineId: item.attempt.machineId,
          sourceBranch: issue.branch,
          approvedBaseSha: order.approvedBaseSha,
          approvedHeadSha: order.approvedHeadSha,
          deliveryDependsOn: [
            ...new Set([...dependencies(order), ...(index > 0 ? [prefix[index - 1]!.id] : [])]),
          ].sort(),
        }
      })
      const lane = {
        repoId: leaderOrder.repoId,
        repoPath: issueFacts.get(leaderOrder.id)!.repoPath,
        machineId,
        laneKey,
        laneRevision: laneRevisionRow.revision,
        targetBranch: leaderOrder.targetBranch,
        expectedTargetSha: leaderOrder.approvedBaseSha,
        destination: laneDestination,
        ...(leaderOrder.providerRef ? { providerRef: leaderOrder.providerRef } : {}),
        policyId: leaderOrder.policyId,
        validationProfile: profile,
        validationProfileDigest: leaderOrder.validationProfileDigest,
      }
      const identity = JSON.stringify({ version: 1, repairRound: 0, lane, members })
      const id = asShipTrainId(`train:${createHash('sha256').update(identity).digest('hex')}`)
      const subsetId = asShipTrainSubsetId(
        `subset:${createHash('sha256')
          .update(
            shippingTrainSubsetFingerprint({
              manifest: { id },
              repairRound: 0,
              memberOrderIds: members.map((member) => member.orderId),
              candidate: { kind: 'approved' },
            }),
          )
          .digest('hex')}`,
      )
      const manifest = ShipTrainManifest.parse({
        version: 1,
        id,
        subsetId,
        repairRound: 0,
        lane,
        memberCount: members.length,
        leaderOrderId: input.leaderOrderId,
        members,
      })
      const leader = byOrder.get(input.leaderOrderId)
      if (!leader) throw new Error(`ship train ${manifest.id} has no claimed leader`)
      const canonicalJson = serializeShipTrainManifest(manifest)
      const canonicalDigest = createHash('sha256').update(canonicalJson).digest('hex')
      await insertTrainManifest(this.db).run({
        id: manifest.id,
        version: manifest.version,
        subsetId: manifest.subsetId,
        repairRound: manifest.repairRound,
        canonicalDigest,
        canonicalJson,
        repoId: manifest.lane.repoId,
        repoPath: manifest.lane.repoPath,
        machineId: manifest.lane.machineId,
        targetBranch: manifest.lane.targetBranch,
        expectedTargetSha: manifest.lane.expectedTargetSha,
        destination: manifest.lane.destination,
        // `provider_ref` and `validation_profile` are `mode: 'json'`, so the
        // OBJECT goes in and drizzle serialises it with `JSON.stringify` —
        // byte-identical to the calls this replaces, which the custody check
        // in `trainManifestForAttempt` depends on. `providerRef` keeps its
        // absent-means-NULL arm rather than storing the string "null" (the
        // prepared fill passes a null through unencoded, as the literal did).
        providerRef: manifest.lane.providerRef ?? null,
        policyId: manifest.lane.policyId,
        validationProfile: manifest.lane.validationProfile,
        validationProfileDigest: manifest.lane.validationProfileDigest,
        laneKey: manifest.lane.laneKey,
        laneRevision: manifest.lane.laneRevision,
        memberCount: manifest.memberCount,
        leaderOrderId: manifest.leaderOrderId,
        leaderAttemptId: leader.attempt.id,
        leaderGeneration: leader.attempt.leaseGeneration,
        createdAt: input.startedAt,
      })
      for (const [ordinal, member] of manifest.members.entries()) {
        await this.recordTrainMember(manifest.id, ordinal, member)
      }
      for (const member of manifest.members) {
        await this.recordActiveClaim(manifest.id, member)
      }
      const finalRevision = await laneRevisionOf(this.db).get({ laneKey })
      if (finalRevision?.revision !== laneRevisionRow.revision) {
        throw new Error('ship train lane changed during claim')
      }
      const effectKey = `train-membership:${manifest.id}:${canonicalDigest}`
      await this.appendStep(_scope, {
        id: `step:${leader.attempt.id}:${effectKey}:planned` as ShipStepValue['id'],
        orderId: leader.order.id,
        attemptId: leader.attempt.id,
        effectKey,
        idempotencyKey: `${effectKey}:planned`,
        generation: leader.attempt.leaseGeneration,
        inputFence: {
          sourceBaseSha: leader.attempt.expectedSourceBaseSha,
          approvedHeadSha: leader.attempt.approvedHeadSha,
          targetSha: leader.attempt.expectedTargetSha,
        },
        kind: 'train-membership',
        state: 'planned',
        summary: `${TRAIN_MANIFEST_PREFIX}${canonicalDigest}`,
        recordedAt: input.startedAt,
      })
      return { manifest, claimed }
    })
  }

  async trainManifestForAttempt(
    attemptId: ShipAttemptValue['id'],
  ): Promise<ShipTrainManifestValue | null> {
    // See `manifestOfAttempt` for the projection.
    const row = await manifestOfAttempt(this.db).get({ attemptId })
    if (!row) return null
    let manifest: ShipTrainManifestValue
    try {
      manifest = ShipTrainManifest.parse(JSON.parse(String(row.canonicalJson)))
    } catch {
      throw new Error(`ship train manifest for ${attemptId} is invalid`)
    }
    const canonicalJson = serializeShipTrainManifest(manifest)
    if (
      canonicalJson !== row.canonicalJson ||
      createHash('sha256').update(canonicalJson).digest('hex') !== row.canonicalDigest ||
      manifest.id !== row.id ||
      manifest.lane.repoId !== row.repoId ||
      manifest.lane.repoPath !== row.repoPath ||
      manifest.lane.machineId !== row.machineId ||
      manifest.lane.laneKey !== row.laneKey ||
      manifest.lane.laneRevision !== row.laneRevision ||
      manifest.lane.targetBranch !== row.targetBranch ||
      manifest.lane.expectedTargetSha !== row.expectedTargetSha ||
      manifest.lane.destination !== row.destination ||
      JSON.stringify(manifest.lane.providerRef ?? null) !== String(row.providerRef ?? 'null') ||
      manifest.lane.policyId !== row.policyId ||
      JSON.stringify(manifest.lane.validationProfile) !== row.validationProfile ||
      manifest.lane.validationProfileDigest !== row.validationProfileDigest ||
      manifest.memberCount !== row.memberCount ||
      manifest.leaderOrderId !== row.leaderOrderId ||
      manifest.members.at(-1)?.attemptId !== row.leaderAttemptId ||
      manifest.members.at(-1)?.generation !== row.leaderGeneration
    ) {
      throw new Error(`ship train manifest ${manifest.id} normalized authority mismatch`)
    }
    const normalizedMembers = await membersOfTrain(this.db).all({ trainId: manifest.id })
    if (
      normalizedMembers.length !== manifest.members.length ||
      normalizedMembers.some(
        (member, index) =>
          JSON.stringify({
            orderId: member.orderId,
            issueId: member.issueId,
            attemptId: member.attemptId,
            generation: member.generation,
            machineId: member.machineId,
            sourceBranch: member.sourceBranch,
            approvedBaseSha: member.approvedBaseSha,
            approvedHeadSha: member.approvedHeadSha,
            deliveryDependsOn: jsonArray(member.deliveryDependsOn),
          }) !== JSON.stringify(manifest.members[index]),
      )
    ) {
      throw new Error(`ship train manifest ${manifest.id} member authority mismatch`)
    }
    const leader = manifest.members.at(-1)!
    const expectedEffectKey = `train-membership:${manifest.id}:${row.canonicalDigest}`
    const auditMarker = (await this.stepsForAttempt(leader.attemptId)).find(
      (step) => step.effectKey === expectedEffectKey,
    )
    if (
      !auditMarker ||
      auditMarker.kind !== 'train-membership' ||
      auditMarker.state !== 'planned' ||
      auditMarker.orderId !== leader.orderId ||
      auditMarker.attemptId !== leader.attemptId ||
      auditMarker.generation !== leader.generation ||
      auditMarker.summary !== `${TRAIN_MANIFEST_PREFIX}${row.canonicalDigest}` ||
      auditMarker.inputFence.sourceBaseSha !== leader.approvedBaseSha ||
      auditMarker.inputFence.approvedHeadSha !== leader.approvedHeadSha ||
      auditMarker.inputFence.targetSha !== manifest.lane.expectedTargetSha
    ) {
      throw new Error(`ship train manifest ${manifest.id} audit marker mismatch`)
    }
    return manifest
  }

  private async claimedTrainForOrder(
    orderId: ShipOrderValue['id'],
  ): Promise<ShipTrainManifestValue | null> {
    const row = await claimedAttemptOfOrder(this.db).get({ orderId })
    if (!row) return null
    return await this.trainManifestForAttempt(row.attemptId)
  }

  async activeTrainForOrder(orderId: ShipOrderValue['id']): Promise<ShipTrainManifestValue | null> {
    const manifest = await this.claimedTrainForOrder(orderId)
    if (!manifest) return null
    const authority = await trainLaneAuthority(this.db).get({ id: manifest.id })
    if (
      !authority ||
      authority.releasedAt ||
      authority.revision !== manifest.lane.laneRevision ||
      authority.claimCount !== manifest.memberCount
    ) {
      return null
    }
    for (const member of manifest.members) {
      const order = await this.getOrder(member.orderId)
      const attempt = await this.getAttempt(member.attemptId)
      const latest = await this.latestAttemptForOrder(member.orderId)
      if (
        !order ||
        order.state === 'held' ||
        isTerminalShipOrderState(order.state) ||
        !attempt ||
        attempt.finishedAt ||
        latest?.id !== member.attemptId ||
        attempt.leaseGeneration !== member.generation ||
        attempt.machineId !== member.machineId
      ) {
        return null
      }
    }
    return manifest
  }

  /** Read-only manifest discovery for a lane mutation. Callers use the result
   * to place every affected issue in one outer ledger transaction before the
   * repository releases or resets any member. */
  async activeTrainsForLane(order: ShipOrderValue): Promise<ShipTrainManifestValue[]> {
    if (!order.repoPath || !order.machineId) return []
    const laneKey = shippingLaneKey(order, {
      repoPath: order.repoPath,
      machineId: order.machineId,
    })
    const rows = await activeClaimOrdersOfLane(this.db).all({ laneKey })
    const manifests = new Map<string, ShipTrainManifestValue>()
    for (const row of rows) {
      const manifest = await this.claimedTrainForOrder(row.orderId)
      if (manifest) manifests.set(manifest.id, manifest)
    }
    return [...manifests.values()]
  }

  /** The shipped leaders of trains not yet released: the only trains whose
   *  covered prefix can still need settling. A released train refuses
   *  settlement (`completeCoveredOrder`), and an unshipped leader has no
   *  proof to settle from. Normally none (POD-6207). */
  async shippedLeadersOfOpenTrains(): Promise<ShipOrderValue['id'][]> {
    const rows = await shippedLeadersOfOpenTrains(this.db).all()
    return [...new Set(rows.map((row) => row.leaderOrderId))]
  }

  /**
   * THE GUARDED TRAIN WRITES (design 2.5). Each writes one row as SQLite's triggers allow
   * it: on SQLite the trigger refuses a row that breaks a rule, on Postgres the
   * statement's own refusal does, with the trigger's text and error (`append-only.ts`). The
   * claim path only writes rows that keep the rules; the guards are for the rows it must
   * never write, and `shipping-guards.test.ts` drives them with such rows on both engines.
   */
  protected async recordTrainMember(
    trainId: ShipTrainManifestValue['id'],
    ordinal: number,
    member: ShipTrainManifestValue['members'][number],
  ): Promise<void> {
    await insertTrainMember(this.db).run({
      trainId,
      ordinal,
      issueId: member.issueId,
      orderId: member.orderId,
      attemptId: member.attemptId,
      generation: member.generation,
      machineId: member.machineId,
      sourceBranch: member.sourceBranch,
      approvedBaseSha: member.approvedBaseSha,
      approvedHeadSha: member.approvedHeadSha,
      // `mode: 'json'`, so the array goes in unserialised. Same bytes.
      deliveryDependsOn: member.deliveryDependsOn,
    })
  }

  /** See {@link recordTrainMember}. */
  protected async recordActiveClaim(
    trainId: ShipTrainManifestValue['id'],
    member: Pick<ShipTrainManifestValue['members'][number], 'orderId' | 'attemptId' | 'generation'>,
  ): Promise<void> {
    await insertActiveClaim(this.db).run({
      trainId,
      orderId: member.orderId,
      attemptId: member.attemptId,
      generation: member.generation,
    })
  }

  /** Delete a released train's claims and return how many; see {@link recordTrainMember}. */
  protected async releaseActiveClaims(trainId: ShipTrainManifestValue['id']): Promise<number> {
    return Number((await deleteActiveClaimsOfTrain(this.db).run({ trainId })).changes)
  }

  async releaseTrain(
    _scope: WriteScope,
    trainId: ShipTrainManifestValue['id'],
    releasedAt: string,
    reason: string,
  ): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const row = await trainReleaseState(this.db).get({ id: trainId })
      if (!row) throw new Error(`unknown ship train ${trainId}`)
      if (row.releasedAt) {
        if (row.releasedAt === releasedAt && row.releaseReason === reason) return
        throw new Error(`ship train ${trainId} was already released differently`)
      }
      const changed = await releaseTrainFenced(this.db).run({
        releasedAt,
        releaseReason: reason,
        id: trainId,
      })
      if (changed.changes !== 1) throw new Error(`ship train ${trainId} release fence failed`)
      const released = await this.releaseActiveClaims(trainId)
      const memberCount = await trainMemberCountOf(this.db).get({ id: trainId })
      if (released !== memberCount?.memberCount) {
        throw new Error(`ship train ${trainId} did not release every active member claim`)
      }
    })
  }

  async isolateTrainFailure(
    _scope: WriteScope,
    input: {
      trainId: ShipTrainManifestValue['id']
      leaderOrderId: ShipOrderValue['id']
      leaderAttemptId: ShipAttemptValue['id']
      generation: number
      terminalStep: ShipStepValue
      daemonAcknowledgement?: ShippingDaemonAcknowledgement
      failureOrderIds: ShipOrderValue['id'][]
      isolatedAt: string
      detail: string
    },
  ): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const manifest = await this.claimedTrainForOrder(input.leaderOrderId)
      if (
        !manifest ||
        manifest.id !== input.trainId ||
        manifest.leaderOrderId !== input.leaderOrderId ||
        manifest.members.at(-1)?.attemptId !== input.leaderAttemptId ||
        manifest.members.at(-1)?.generation !== input.generation
      ) {
        throw new Error(`ship train ${input.trainId} isolation custody fence failed`)
      }
      const failures = new Set(input.failureOrderIds)
      if (
        failures.size === 0 ||
        [...failures].some((id) => !manifest.members.some((m) => m.orderId === id))
      ) {
        throw new Error(`ship train ${input.trainId} isolation set is invalid`)
      }
      await this.appendStep(_scope, input.terminalStep)
      if (input.daemonAcknowledgement)
        await this.queueDaemonAcknowledgement(input.daemonAcknowledgement)
      await this.releaseTrain(_scope, manifest.id, input.isolatedAt, 'validation-isolated')
      for (const member of manifest.members) {
        const order = await this.getOrder(member.orderId)
        const attempt = await this.getAttempt(member.attemptId)
        if (!order || isTerminalShipOrderState(order.state)) continue
        if (attempt && !attempt.finishedAt) {
          await this.finishAttempt(_scope, member.attemptId, member.generation, {
            finishedAt: input.isolatedAt,
            outcome: 'failed',
          })
        }
        if (!failures.has(member.orderId)) {
          const changed = await requeueLiveOrder(this.db).run({
            stateChangedAt: input.isolatedAt,
            id: member.orderId,
          })
          await this.advanceRecoveryRevision()
          if (changed.changes !== 1)
            throw new Error(`ship train ${manifest.id} green member reset failed`)
          continue
        }
        const generationRow = { generation: await this.highestHoldGeneration(member.orderId) }
        await this.raiseHold(_scope, {
          id: asShipHoldId(`hold:${member.orderId}:isolation:${generationRow.generation + 1}`),
          orderId: member.orderId,
          generation: generationRow.generation + 1,
          reasonCode: 'validation-failed',
          headline: failures.size > 1 ? 'Delivery changes interact' : 'Delivery validation failed',
          detail: input.detail,
          evidenceRefs: [manifest.id],
          actions: ['open-repair', 'retry'],
          raisedAt: input.isolatedAt,
        })
      }
    })
  }

  private async invalidateActiveLane(
    scope: WriteScope,
    laneKey: string,
    at: string,
    reason: string,
  ): Promise<void> {
    const rows = await openTrainsOfLane(this.db).all({ laneKey })
    for (const row of rows) {
      const memberRows = await activeMembersOfTrain(this.db).all({ trainId: row.id })
      const orders = await Promise.all(
        memberRows.map(async (member) => await this.getOrder(member.orderId)),
      )
      const attempts = await Promise.all(
        memberRows.map(async (member) => await this.getAttempt(member.attemptId)),
      )
      const resettable =
        memberRows.length > 0 &&
        orders.every((order) => order?.state === 'preflight') &&
        attempts.every((attempt) => !attempt?.finishedAt)
      await this.releaseTrain(scope, row.id, at, reason)
      if (resettable) {
        for (const member of memberRows) {
          await this.finishAttempt(scope, member.attemptId, member.generation, {
            finishedAt: at,
            outcome: 'failed',
          })
          const changed = await requeuePreflightOrder(this.db).run({
            stateChangedAt: at,
            id: member.orderId,
          })
          await this.advanceRecoveryRevision()
          if (changed.changes !== 1)
            throw new Error(`ship train ${row.id} reset was not manifest-wide`)
        }
        continue
      }
      for (const member of memberRows) {
        const order = await this.getOrder(member.orderId)
        const attempt = await this.getAttempt(member.attemptId)
        if (!order || isTerminalShipOrderState(order.state)) continue
        if (attempt && !attempt.finishedAt) {
          await this.finishAttempt(scope, member.attemptId, member.generation, {
            finishedAt: at,
            outcome: 'failed',
          })
        }
        const generationRow = { generation: await this.highestHoldGeneration(member.orderId) }
        await this.raiseHold(scope, {
          id: asShipHoldId(`hold:${member.orderId}:lane:${generationRow.generation + 1}`),
          orderId: member.orderId,
          generation: generationRow.generation + 1,
          reasonCode: 'approval-stale',
          headline: 'Delivery lane changed during execution',
          detail: 'A newly admitted order or native stack edge changed the immutable train prefix.',
          evidenceRefs: [row.id],
          actions: ['retry'],
          raisedAt: at,
        })
      }
    }
  }

  async recordNativeStackEdge(
    _scope: WriteScope,
    input: {
      upperOrderId: ShipOrderValue['id']
      lowerOrderId: ShipOrderValue['id']
      recordedAt: string
    },
  ): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const upper = await this.getOrder(input.upperOrderId)
      const lower = await this.getOrder(input.lowerOrderId)
      if (!upper || !lower || upper.id === lower.id) throw new Error('invalid native stack edge')
      if (
        upper.repoId !== lower.repoId ||
        upper.targetBranch !== lower.targetBranch ||
        canonicalShippingDestination(upper.destination, upper.targetBranch) !==
          canonicalShippingDestination(lower.destination, lower.targetBranch)
      ) {
        throw new Error('native stack edge crosses a delivery lane')
      }
      const issueRows = await Promise.all(
        [upper, lower].map(async (order) => {
          const issue = await issueLaneCustody(this.db).get({ id: order.issueId })
          if (!issue?.repoPath || !issue.machineId)
            throw new Error('native stack edge has no lane custody')
          return { repoPath: issue.repoPath, machineId: issue.machineId }
        }),
      )
      const laneKey = shippingLaneKey(upper, issueRows[0]!)
      if (shippingLaneKey(lower, issueRows[1]!) !== laneKey) {
        throw new Error('native stack edge crosses immutable compatibility')
      }
      const existing = await stackEdgeByPair(this.db).get({
        upperOrderId: upper.id,
        lowerOrderId: lower.id,
      })
      if (existing) {
        if (
          existing.lowerOrderId === lower.id &&
          existing.upperApprovedHeadSha === upper.approvedHeadSha &&
          existing.lowerApprovedHeadSha === lower.approvedHeadSha
        ) {
          return
        }
        throw new Error(`native stack edge ${upper.id} → ${lower.id} is immutable`)
      }
      await insertStackEdge(this.db).run({
        upperOrderId: upper.id,
        lowerOrderId: lower.id,
        upperApprovedHeadSha: upper.approvedHeadSha,
        lowerApprovedHeadSha: lower.approvedHeadSha,
        recordedAt: input.recordedAt,
      })
      await this.bumpLaneRevision(laneKey, input.recordedAt)
      await this.invalidateActiveLane(_scope, laneKey, input.recordedAt, 'native-stack-change')
    })
  }

  async hasNativeStackEdge(
    upperOrderId: ShipOrderValue['id'],
    lowerOrderId: ShipOrderValue['id'],
  ): Promise<boolean> {
    return Boolean(await stackEdgePresent(this.db).get({ upperOrderId, lowerOrderId }))
  }

  /** Claim one active order through its durable order/attempt winner. Recovery
   * supersedes an unfinished prior attempt and mints generation + 1 unless the
   * old winner has durable cancellation intent, which must settle in place. */
  async claimAttempt(
    _scope: WriteScope,
    input: {
      orderId: string
      expectedState: Exclude<ShipOrderState, 'held' | 'shipped' | 'cancelled'>
      expectedAttemptId: string | null
      expectedGeneration: number
      machineId: ShipAttemptValue['machineId']
      startedAt: string
    },
  ): Promise<{ order: ShipOrderValue; attempt: ShipAttemptValue }> {
    return await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(input.orderId)
      if (!order) throw new Error(`unknown ship order ${input.orderId}`)
      if (order.state !== input.expectedState) {
        throw new Error(
          `ship order ${order.id} claim fence failed: expected ${input.expectedState}`,
        )
      }
      const latest = await this.latestAttemptForOrder(order.id)
      if (
        (latest?.id ?? null) !== input.expectedAttemptId ||
        (latest?.leaseGeneration ?? 0) !== input.expectedGeneration
      ) {
        throw new Error(`ship order ${order.id} attempt claim was superseded`)
      }
      if (latest && (await this.hasCancellationIntent(latest.id, latest.leaseGeneration))) {
        throw new Error(`ship order ${order.id} has durable cancellation intent`)
      }
      if (latest && !latest.finishedAt) {
        await this.finishAttempt(_scope, latest.id, latest.leaseGeneration, {
          finishedAt: input.startedAt,
          outcome: 'failed',
        })
      }
      const generation = input.expectedGeneration + 1
      const attempt = await this.createAttempt(_scope, {
        id: `attempt:${order.id}:${generation}` as ShipAttemptValue['id'],
        orderId: order.id,
        expectedSourceBaseSha: order.approvedBaseSha,
        approvedHeadSha: order.approvedHeadSha,
        expectedTargetSha: order.approvedBaseSha,
        machineId: input.machineId,
        leaseGeneration: generation,
        startedAt: input.startedAt,
        submittedHeadSha: order.approvedHeadSha,
      })
      const next =
        order.state === 'queued'
          ? await this.transitionOrder(_scope, order.id, 'queued', 'preflight', input.startedAt)
          : order
      return { order: next, attempt }
    })
  }

  async hasAttemptCustody(input: {
    orderId: string
    expectedState: ShipOrderState
    attemptId: string
    generation: number
  }): Promise<boolean> {
    const order = await this.getOrder(input.orderId)
    const latest = await this.latestAttemptForOrder(input.orderId)
    return (
      order?.state === input.expectedState &&
      latest?.id === input.attemptId &&
      latest.leaseGeneration === input.generation &&
      latest.finishedAt === undefined
    )
  }

  /** Read the complete durable dispatch fence in one database transaction.
   * This is called immediately before an external mutation. The matching
   * post-effect transaction below prevents a crossed effect from advancing a
   * cancelled, superseded, or otherwise stale order. */
  async assertEffectDispatchCustody(input: {
    orderId: string
    expectedState: ShipOrderState
    attemptId: string
    generation: number
    effectKey: string
    operation: ShipStepValue['kind']
  }): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(input.orderId)
      const attempt = await this.latestAttemptForOrder(input.orderId)
      const step = await this.latestStepForEffect(input.attemptId, input.effectKey)
      if (
        !order ||
        order.state !== input.expectedState ||
        !attempt ||
        attempt.id !== input.attemptId ||
        attempt.leaseGeneration !== input.generation ||
        attempt.finishedAt !== undefined ||
        !step ||
        step.state !== 'running' ||
        step.effectKey !== input.effectKey ||
        step.kind !== input.operation ||
        step.generation !== input.generation
      ) {
        throw new Error(`ship order ${input.orderId} effect dispatch custody fence failed`)
      }
      if (await this.hasCancellationIntent(input.attemptId, input.generation)) {
        throw new Error(`ship order ${input.orderId} has durable cancellation intent`)
      }
    })
  }

  /** Commit the result of one awaited daemon effect while its durable custody
   * facts are still current. The journal append and the state change it
   * authorizes share one transaction, so cancellation or a newer generation
   * cannot win between a read fence and a write. */
  async commitEffectResult(
    _scope: WriteScope,
    input: {
      orderId: string
      expectedState: ShipOrderState
      attemptId: string
      generation: number
      effectKey: string
      operation: ShipStepValue['kind']
      terminalStep: ShipStepValue
      daemonAcknowledgement?: ShippingDaemonAcknowledgement
      repairAcknowledgement?: ShippingRepairAcknowledgement
      repairCandidate?: StoredShippingRepairCandidate
      outcome:
        | {
            kind: 'transition'
            nextState: Exclude<ShipOrderState, 'held' | 'shipped'>
            stateChangedAt: string
          }
        | {
            kind: 'hold'
            hold: ShipHoldValue
            attemptFinishedAt: string
            preserveAttempt?: boolean
          }
        | {
            kind: 'verified'
            receipt: DeliveryReceiptValue
            attemptFinishedAt: string
          }
    },
  ): Promise<ShipOrderValue> {
    return await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(input.orderId)
      const latestAttempt = await this.latestAttemptForOrder(input.orderId)
      if (
        !order ||
        order.state !== input.expectedState ||
        !latestAttempt ||
        latestAttempt.id !== input.attemptId ||
        latestAttempt.leaseGeneration !== input.generation ||
        latestAttempt.finishedAt !== undefined
      ) {
        throw new Error(`ship order ${input.orderId} effect custody fence failed`)
      }
      if (await this.hasCancellationIntent(input.attemptId, input.generation)) {
        throw new Error(`ship order ${input.orderId} has durable cancellation intent`)
      }
      if (
        input.terminalStep.orderId !== input.orderId ||
        input.terminalStep.attemptId !== input.attemptId ||
        input.terminalStep.generation !== input.generation ||
        input.terminalStep.effectKey !== input.effectKey ||
        input.terminalStep.kind !== input.operation ||
        !isTerminalShipStepState(input.terminalStep.state)
      ) {
        throw new Error(`ship order ${input.orderId} terminal effect step fence failed`)
      }
      const latestStep = await this.latestStepForEffect(input.attemptId, input.effectKey)
      if (
        !latestStep ||
        latestStep.effectKey !== input.effectKey ||
        latestStep.kind !== input.operation ||
        latestStep.generation !== input.generation
      ) {
        throw new Error(`ship order ${input.orderId} effect step fence failed`)
      }
      if (latestStep.state === 'running') {
        await this.appendStep(_scope, input.terminalStep)
      } else if (
        !isTerminalShipStepState(latestStep.state) ||
        latestStep.state !== input.terminalStep.state ||
        latestStep.outcome !== input.terminalStep.outcome ||
        latestStep.summary !== input.terminalStep.summary ||
        latestStep.finishedAt !== input.terminalStep.finishedAt ||
        latestStep.artifactRef !== input.terminalStep.artifactRef
      ) {
        throw new Error(`ship order ${input.orderId} effect result is not an exact replay`)
      }

      if (input.daemonAcknowledgement) {
        const request = input.daemonAcknowledgement
        if (
          request.orderId !== order.id ||
          request.attemptId !== latestAttempt.id ||
          request.generation !== input.generation ||
          request.operation !== input.operation ||
          request.action !== 'acknowledge'
        ) {
          throw new Error(`ship order ${input.orderId} acknowledgement custody fence failed`)
        }
        await this.queueDaemonAcknowledgement(request)
      }
      if (input.repairAcknowledgement) {
        await this.queueRepairAcknowledgement(input.repairAcknowledgement)
      }

      if (input.outcome.kind === 'transition') {
        if (input.repairCandidate) await this.recordRepairCandidate(input.repairCandidate)
        return await this.transitionOrder(
          _scope,
          input.orderId,
          input.expectedState,
          input.outcome.nextState,
          input.outcome.stateChangedAt,
        )
      }
      if (input.outcome.kind === 'hold') {
        if (!input.outcome.preserveAttempt) {
          await this.finishAttempt(_scope, input.attemptId, input.generation, {
            finishedAt: input.outcome.attemptFinishedAt,
            outcome: 'failed',
          })
        }
        await this.raiseHold(_scope, input.outcome.hold)
        return (await this.getOrder(input.orderId)) as ShipOrderValue
      }
      const receipt = input.outcome.receipt
      await this.finishAttempt(_scope, input.attemptId, input.generation, {
        finishedAt: input.outcome.attemptFinishedAt,
        outcome: 'succeeded',
        testedIntegrationSha: receipt.testedIntegrationSha,
        landedRefSha: receipt.landedRefSha,
        destinationSha: receipt.destinationSha,
        validationProfileId: receipt.validationProfileId,
        validationResult: 'passed',
      })
      await this.completeVerifiedOrder(_scope, receipt)
      return (await this.getOrder(input.orderId)) as ShipOrderValue
    })
  }

  /** Atomically close a cancellation intent that cannot be completed and move
   * the order into a human hold. This prevents any crash boundary from leaving
   * a finished attempt paired with a supersedable running cancel journal. */
  async commitCancellationHold(
    _scope: WriteScope,
    input: {
      orderId: string
      expectedState: ShipOrderState
      attemptId: string
      generation: number
      intentKey: string
      terminalStep: ShipStepValue
      hold: ShipHoldValue
      attemptFinishedAt: string
    },
  ): Promise<ShipOrderValue> {
    return await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(input.orderId)
      const latestAttempt = await this.latestAttemptForOrder(input.orderId)
      const intent = await this.latestStepForEffect(input.attemptId, input.intentKey)
      if (
        !order ||
        order.state !== input.expectedState ||
        !latestAttempt ||
        latestAttempt.id !== input.attemptId ||
        latestAttempt.leaseGeneration !== input.generation ||
        latestAttempt.finishedAt !== undefined ||
        !intent ||
        intent.effectKey !== input.intentKey ||
        intent.kind !== 'cancel' ||
        intent.generation !== input.generation ||
        (intent.state !== 'planned' && intent.state !== 'running')
      ) {
        throw new Error(`ship order ${input.orderId} cancellation hold custody fence failed`)
      }
      if (
        input.terminalStep.orderId !== input.orderId ||
        input.terminalStep.attemptId !== input.attemptId ||
        input.terminalStep.effectKey !== input.intentKey ||
        input.terminalStep.generation !== input.generation ||
        input.terminalStep.kind !== 'cancel' ||
        !isTerminalShipStepState(input.terminalStep.state)
      ) {
        throw new Error(`ship order ${input.orderId} cancellation hold step fence failed`)
      }
      if (intent.state === 'planned') {
        throw new Error(`ship order ${input.orderId} cancellation intent was not dispatched`)
      }
      await this.appendStep(_scope, input.terminalStep)
      await this.finishAttempt(_scope, input.attemptId, input.generation, {
        finishedAt: input.attemptFinishedAt,
        outcome: 'failed',
      })
      await this.raiseHold(_scope, input.hold)
      return (await this.getOrder(input.orderId)) as ShipOrderValue
    })
  }

  /** Raise a pre-effect hold under the same order/attempt custody fence used
   * for daemon results. No journal result exists yet, but generation and
   * cancellation intent must still be checked atomically with the transition. */
  async commitCustodyHold(
    _scope: WriteScope,
    input: {
      orderId: string
      expectedState: ShipOrderState
      attemptId: string
      generation: number
      hold: ShipHoldValue
      attemptFinishedAt: string
    },
  ): Promise<ShipOrderValue> {
    return await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(input.orderId)
      const latestAttempt = await this.latestAttemptForOrder(input.orderId)
      if (
        !order ||
        order.state !== input.expectedState ||
        !latestAttempt ||
        latestAttempt.id !== input.attemptId ||
        latestAttempt.leaseGeneration !== input.generation ||
        latestAttempt.finishedAt !== undefined
      ) {
        throw new Error(`ship order ${input.orderId} hold custody fence failed`)
      }
      if (await this.hasCancellationIntent(input.attemptId, input.generation)) {
        throw new Error(`ship order ${input.orderId} has durable cancellation intent`)
      }
      await this.finishAttempt(_scope, input.attemptId, input.generation, {
        finishedAt: input.attemptFinishedAt,
        outcome: 'failed',
      })
      await this.raiseHold(_scope, input.hold)
      return (await this.getOrder(input.orderId)) as ShipOrderValue
    })
  }

  async finishAttempt(
    _scope: WriteScope,
    id: string,
    leaseGeneration: number,
    result: {
      finishedAt: string
      outcome: NonNullable<ShipAttemptValue['outcome']>
      testedIntegrationSha?: string
      landedRefSha?: string
      destinationSha?: string
      validationProfileId?: string
      validationResult?: ShipAttemptValue['validationResult']
    },
  ): Promise<ShipAttemptValue> {
    const attempt = await this.getAttempt(id)
    if (!attempt) throw new Error(`unknown ship attempt ${id}`)
    if (attempt.leaseGeneration !== leaseGeneration) {
      throw new Error(`ship attempt ${id} generation fence failed: expected ${leaseGeneration}`)
    }
    if (attempt.finishedAt) {
      const identical =
        attempt.finishedAt === result.finishedAt &&
        attempt.outcome === result.outcome &&
        attempt.testedIntegrationSha === result.testedIntegrationSha &&
        attempt.landedRefSha === result.landedRefSha &&
        attempt.destinationSha === result.destinationSha &&
        attempt.validationProfileId === result.validationProfileId &&
        attempt.validationResult === result.validationResult
      if (identical) return attempt
      throw new Error(`terminal ship attempt ${id} is immutable`)
    }
    const completed = ShipAttempt.parse({ ...attempt, ...result })
    if (completed.finishedAt === undefined || completed.outcome === undefined) {
      throw new Error(`completed ship attempt ${id} is missing finishedAt/outcome`)
    }
    const changed = await finishAttemptFenced(this.db).run({
      finishedAt: completed.finishedAt,
      outcome: completed.outcome,
      // Every `?? null` stays an EXPLICIT null. An omitted key in a drizzle
      // `set` is not written at all, which would leave the previous value
      // standing where the raw statement cleared it.
      testedIntegrationSha: completed.testedIntegrationSha ?? null,
      landedRefSha: completed.landedRefSha ?? null,
      destinationSha: completed.destinationSha ?? null,
      validationProfileId: completed.validationProfileId ?? null,
      validationResult: completed.validationResult ?? null,
      id: asShipAttemptId(id),
      leaseGeneration,
    })
    if (changed.changes !== 1) {
      throw new Error(`ship attempt ${id} generation fence failed: expected ${leaseGeneration}`)
    }
    return (await this.getAttempt(id)) as ShipAttemptValue
  }

  async cancelAttemptAndOrder(
    _scope: WriteScope,
    orderId: string,
    expectedState: Extract<
      ShipOrderState,
      'queued' | 'preflight' | 'composing' | 'validating' | 'repairing'
    >,
    cancelledAt: string,
    custody?: {
      attemptId: string
      generation: number
      terminalSteps: ShipStepValue[]
      daemonAcknowledgement?: ShippingDaemonAcknowledgement
    },
  ): Promise<ShipOrderValue> {
    return await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(orderId)
      if (!order || order.state !== expectedState) {
        throw new Error(
          `ship order ${orderId} cancellation fence failed: expected ${expectedState}`,
        )
      }
      const activeTrain = await this.claimedTrainForOrder(order.id)
      const attempt = await this.latestAttemptForOrder(orderId)
      const custodyAttempt = custody ? await this.getAttempt(custody.attemptId) : null
      const custodyMember = activeTrain?.members.find(
        (member) => member.attemptId === custody?.attemptId,
      )
      if (
        custody &&
        (!custodyAttempt ||
          custodyAttempt.leaseGeneration !== custody.generation ||
          custodyAttempt.finishedAt !== undefined ||
          (activeTrain ? !custodyMember : attempt?.id !== custody.attemptId))
      ) {
        throw new Error(`ship order ${orderId} cancellation custody fence failed`)
      }
      for (const step of custody?.terminalSteps ?? []) await this.appendStep(_scope, step)
      if (custody?.daemonAcknowledgement)
        await this.queueDaemonAcknowledgement(custody.daemonAcknowledgement)
      if (attempt && !attempt.finishedAt) {
        await this.finishAttempt(_scope, attempt.id, attempt.leaseGeneration, {
          finishedAt: cancelledAt,
          outcome: 'cancelled',
        })
      }
      const cancelled = await this.transitionOrder(
        _scope,
        orderId,
        expectedState,
        'cancelled',
        cancelledAt,
      )
      if (activeTrain) {
        await this.releaseTrain(_scope, activeTrain.id, cancelledAt, 'cancelled')
        for (const member of activeTrain.members) {
          if (member.orderId === orderId) continue
          const sibling = await this.getOrder(member.orderId)
          const siblingAttempt = await this.getAttempt(member.attemptId)
          if (!sibling || isTerminalShipOrderState(sibling.state)) continue
          if (siblingAttempt && !siblingAttempt.finishedAt) {
            await this.finishAttempt(_scope, member.attemptId, member.generation, {
              finishedAt: cancelledAt,
              outcome: 'failed',
            })
          }
          if (sibling.state === 'preflight') {
            await requeuePreflightOrder(this.db).run({
              stateChangedAt: cancelledAt,
              id: sibling.id,
            })
            await this.advanceRecoveryRevision()
          } else {
            const holdGeneration = { generation: await this.highestHoldGeneration(sibling.id) }
            await this.raiseHold(_scope, {
              id: asShipHoldId(`hold:${sibling.id}:train:${holdGeneration.generation + 1}`),
              orderId: sibling.id,
              generation: holdGeneration.generation + 1,
              reasonCode: 'approval-stale',
              headline: 'Delivery train was cancelled',
              detail: `Train peer ${orderId} was cancelled after shared execution began.`,
              evidenceRefs: [activeTrain.id],
              actions: ['retry'],
              raisedAt: cancelledAt,
            })
          }
        }
      }
      return cancelled
    })
  }

  async requestCancellation(
    _scope: WriteScope,
    input: {
      orderId: string
      expectedState: ShipOrderState
      attemptId: string
      generation: number
      planned: ShipStepValue
      running: ShipStepValue
    },
  ): Promise<ShipStepValue> {
    return await this.createOrJoinTransaction(async () => {
      if (
        !(await this.hasAttemptCustody({
          orderId: input.orderId,
          expectedState: input.expectedState,
          attemptId: input.attemptId,
          generation: input.generation,
        }))
      ) {
        throw new Error(`ship order ${input.orderId} cancellation intent fence failed`)
      }
      const existing = await this.latestStepForEffect(input.attemptId, input.planned.effectKey)
      if (existing) return existing
      await this.appendStep(_scope, input.planned)
      return await this.appendStep(_scope, input.running)
    })
  }

  async hasCancellationIntent(attemptId: string, generation: number): Promise<boolean> {
    const step = await this.latestStepForEffect(attemptId, `cancel:${generation}`)
    return step?.state === 'planned' || step?.state === 'running'
  }

  async appendStep(_scope: WriteScope, input: ShipStepValue): Promise<ShipStepValue> {
    const step = ShipStep.parse(input)
    const attempt = await this.getAttempt(step.attemptId)
    if (!attempt || attempt.orderId !== step.orderId) {
      throw new Error(`ship step ${step.id} does not belong to attempt ${step.attemptId}`)
    }
    if (step.generation !== attempt.leaseGeneration) {
      throw new Error(
        `ship step ${step.id} generation fence failed: expected ${attempt.leaseGeneration}`,
      )
    }
    const expectedFence = {
      sourceBaseSha: attempt.expectedSourceBaseSha,
      approvedHeadSha: attempt.approvedHeadSha,
      targetSha: attempt.expectedTargetSha,
    }
    if (JSON.stringify(step.inputFence) !== JSON.stringify(expectedFence)) {
      throw new Error(`ship step ${step.id} input fence does not match attempt ${attempt.id}`)
    }
    const existingRow = await stepByIdempotency(this.db).get({
      attemptId: step.attemptId,
      idempotencyKey: step.idempotencyKey,
    })
    if (existingRow) {
      const existing = mapStep(existingRow)
      if (JSON.stringify(existing) === JSON.stringify(step)) return existing
      throw new Error(
        `ship step idempotency collision for ${step.attemptId}:${step.idempotencyKey}`,
      )
    }
    const previous = await this.latestStepForEffect(step.attemptId, step.effectKey)
    if (!previous && step.state !== 'planned') {
      throw new Error(`ship step effect ${step.effectKey} must begin planned`)
    }
    if (previous?.state === 'planned' && step.state !== 'running') {
      throw new Error(`ship step effect ${step.effectKey} must move planned → running`)
    }
    if (previous?.state === 'running' && !isTerminalShipStepState(step.state)) {
      throw new Error(`ship step effect ${step.effectKey} must move running → terminal`)
    }
    if (previous && isTerminalShipStepState(previous.state)) {
      throw new Error(`ship step effect ${step.effectKey} is already terminal`)
    }
    await insertStep(this.db).run({
      id: step.id,
      orderId: step.orderId,
      attemptId: step.attemptId,
      effectKey: step.effectKey,
      idempotencyKey: step.idempotencyKey,
      generation: step.generation,
      // `input_fence` is `mode: 'json'`, so the object goes in and drizzle
      // serialises it — the same bytes `appendStep`'s own fence comparison
      // and `mapStep`'s quarantine read back.
      inputFence: step.inputFence,
      kind: step.kind,
      state: step.state,
      outcome: step.outcome ?? null,
      summary: step.summary,
      artifactRef: step.artifactRef ?? null,
      recordedAt: step.recordedAt,
      startedAt: step.startedAt ?? null,
      finishedAt: step.finishedAt ?? null,
    })
    return (await this.stepById(step.id)) as ShipStepValue
  }

  async stepById(id: string): Promise<ShipStepValue | null> {
    const row = await stepOfId(this.db).get({ id: asShipStepId(id) })
    return row ? mapStep(row) : null
  }

  async stepsForAttempt(attemptId: string): Promise<ShipStepValue[]> {
    return (await stepsOfAttempt(this.db).all({ attemptId: asShipAttemptId(attemptId) })).map(
      mapStep,
    )
  }

  async latestStepForEffect(attemptId: string, effectKey: string): Promise<ShipStepValue | null> {
    // Ordered by lifecycle rank; see `latestStepOfEffect`.
    const row = await latestStepOfEffect(this.db).get({
      attemptId: asShipAttemptId(attemptId),
      effectKey,
    })
    return row ? mapStep(row) : null
  }

  async openHoldForOrder(orderId: string): Promise<ShipHoldValue | null> {
    const row = await openHoldOfOrder(this.db).get({ orderId: asShipOrderId(orderId) })
    return row ? mapHold(row) : null
  }

  async listHolds(): Promise<ShipHoldValue[]> {
    return (await allHolds(this.db).all()).map(mapHold)
  }

  async raiseHold(_scope: WriteScope, input: ShipHoldValue): Promise<ShipHoldValue> {
    const hold = ShipHold.parse(input)
    if (hold.resolvedAt || hold.resolution) throw new Error(`new ship hold ${hold.id} is resolved`)
    return await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(hold.orderId)
      if (!order) throw new Error(`unknown ship order ${hold.orderId}`)
      if (isTerminalShipOrderState(order.state)) {
        throw new Error(`terminal ship order ${order.id} cannot be held`)
      }
      if (!isLegalShipOrderTransition(order.state, 'held')) {
        throw new Error(`illegal ship order transition ${order.state} → held`)
      }
      const activeTrain = await this.claimedTrainForOrder(order.id)
      const generationRow = { generation: await this.highestHoldGeneration(hold.orderId) }
      const expected = generationRow.generation + 1
      if (hold.generation !== expected) {
        throw new Error(`ship hold ${hold.id} generation fence failed: expected ${expected}`)
      }
      await insertHold(this.db).run({
        id: hold.id,
        orderId: hold.orderId,
        generation: hold.generation,
        reasonCode: hold.reasonCode,
        headline: hold.headline,
        detail: hold.detail,
        // Both are plain `text()`, so the serialisation stays this file's —
        // `actions` in particular, whose quarantine-then-refuse behaviour on
        // a corrupt value the oracle pins (spec rule 4).
        evidenceRefs: JSON.stringify(hold.evidenceRefs),
        actions: JSON.stringify(hold.actions),
        raisedAt: hold.raisedAt,
      })
      const orderChanged = await holdOrderFenced(this.db).run({
        holdCode: hold.reasonCode,
        stateChangedAt: hold.raisedAt,
        id: hold.orderId,
      })
      if (orderChanged.changes !== 1) {
        throw new Error(`ship order ${hold.orderId} hold fence failed`)
      }
      if (activeTrain) {
        await this.releaseTrain(_scope, activeTrain.id, hold.raisedAt, `held:${hold.reasonCode}`)
        for (const member of activeTrain.members) {
          if (member.orderId === hold.orderId) continue
          const sibling = await this.getOrder(member.orderId)
          const attempt = await this.getAttempt(member.attemptId)
          if (!sibling || isTerminalShipOrderState(sibling.state)) continue
          if (attempt && !attempt.finishedAt) {
            await this.finishAttempt(_scope, member.attemptId, member.generation, {
              finishedAt: hold.raisedAt,
              outcome: 'failed',
            })
          }
          if (sibling.state === 'preflight') {
            await requeuePreflightOrder(this.db).run({
              stateChangedAt: hold.raisedAt,
              id: sibling.id,
            })
            await this.advanceRecoveryRevision()
            continue
          }
          const siblingGeneration = { generation: await this.highestHoldGeneration(sibling.id) }
          await this.raiseHold(_scope, {
            id: asShipHoldId(`hold:${sibling.id}:train:${siblingGeneration.generation + 1}`),
            orderId: sibling.id,
            generation: siblingGeneration.generation + 1,
            reasonCode: hold.reasonCode,
            headline: hold.headline,
            detail: `Train peer ${hold.orderId} was held. ${hold.detail}`,
            evidenceRefs: [...new Set([...hold.evidenceRefs, activeTrain.id])],
            actions: hold.actions,
            raisedAt: hold.raisedAt,
          })
        }
      }
      return (await this.openHoldForOrder(hold.orderId)) as ShipHoldValue
    })
  }

  async resolveHold(
    _scope: WriteScope,
    orderId: string,
    expectedGeneration: number,
    resolution: ShipHoldAction,
    nextState: Extract<ShipOrderState, 'queued' | 'repairing' | 'cancelled'>,
    resolvedAt: string,
    repairCandidate?: StoredShippingRepairCandidate,
  ): Promise<ShipHoldValue> {
    return await this.createOrJoinTransaction(async () => {
      const hold = await this.openHoldForOrder(orderId)
      if (!hold || hold.generation !== expectedGeneration) {
        throw new Error(
          `ship hold ${orderId} generation fence failed: expected ${expectedGeneration}`,
        )
      }
      if (!hold.actions.includes(resolution)) {
        throw new Error(`ship hold ${hold.id} does not offer action ${resolution}`)
      }
      if (
        !(legalHoldResolutionStates(resolution) as readonly ShipOrderState[]).includes(nextState)
      ) {
        throw new Error(`ship hold action ${resolution} cannot transition to ${nextState}`)
      }
      const attempt = await this.latestAttemptForOrder(orderId)
      if (nextState === 'repairing') {
        if (!repairCandidate || !attempt || attempt.finishedAt) {
          throw new Error(`ship hold ${hold.id} cannot open repair without a live candidate`)
        }
        await this.recordRepairCandidate(repairCandidate)
      } else if (attempt && !attempt.finishedAt) {
        await this.finishAttempt(_scope, attempt.id, attempt.leaseGeneration, {
          finishedAt: resolvedAt,
          outcome: nextState === 'cancelled' ? 'cancelled' : 'failed',
        })
      }
      const changed = await resolveHoldFenced(this.db).run({
        resolvedAt,
        resolution,
        orderId: asShipOrderId(orderId),
        generation: expectedGeneration,
      })
      if (changed.changes !== 1) {
        throw new Error(
          `ship hold ${orderId} generation fence failed: expected ${expectedGeneration}`,
        )
      }
      const orderChanged = await releaseHeldOrder(this.db).run({
        nextState,
        stateChangedAt: resolvedAt,
        id: asShipOrderId(orderId),
      })
      if (orderChanged.changes !== 1) throw new Error(`ship order ${orderId} is not held`)
      if (nextState === 'queued') await this.advanceRecoveryRevision()
      const row = await holdOfOrderGeneration(this.db).get({
        orderId: asShipOrderId(orderId),
        generation: expectedGeneration,
      })
      // The row is guaranteed by the fenced update above; the raw form asserted
      // it with a bare `as SqlRow` and would have thrown inside the mapper.
      if (!row) throw new Error(`ship hold ${orderId}@${expectedGeneration} vanished mid-span`)
      return mapHold(row)
    })
  }

  async receiptForOrder(orderId: string): Promise<DeliveryReceiptValue | null> {
    const row = await receiptOfOrder(this.db).get({ orderId: asShipOrderId(orderId) })
    return row ? mapReceipt(row) : null
  }

  async listReceipts(): Promise<DeliveryReceiptValue[]> {
    return (await allReceipts(this.db).all()).map(mapReceipt)
  }

  async recordEffectEnvelope(
    _scope: WriteScope,
    input: { request: unknown; result: unknown; recordedAt: string },
  ): Promise<string> {
    const rawRequest = input.request as Record<string, unknown>
    const request = ShippingJobRequestMessage.parse({
      type: 'shippingJobRequest',
      requestId: `envelope:${String(rawRequest.jobId ?? 'unknown')}`,
      ...rawRequest,
    })
    const result = ShippingJobResult.parse(input.result)
    const {
      type: _type,
      requestId: _requestId,
      action: _action,
      requestDigest: _requestDigest,
      ...fingerprintInput
    } = request
    const calculatedDigest = createHash('sha256')
      .update(shippingJobRequestFingerprint(fingerprintInput))
      .digest('hex')
    if (
      request.requestDigest !== calculatedDigest ||
      !shippingJobRequestMatchesTrain(request) ||
      result.state !== 'succeeded' ||
      result.classification !== 'proved' ||
      !result.finishedAt ||
      !request.train ||
      !('manifest' in request.train) ||
      !shippingTrainProofsMatch(request, result)
    ) {
      throw new Error(`shipping effect ${request.jobId} has no exact successful train proof`)
    }
    const manifest = request.train.manifest
    const stored = await this.trainManifestForAttempt(request.attemptId)
    if (!stored || serializeShipTrainManifest(stored) !== serializeShipTrainManifest(manifest)) {
      throw new Error(`shipping effect ${request.jobId} has no matching durable manifest`)
    }
    const effectKey = `${request.jobId}:${request.requestDigest}`
    const requestJson = JSON.stringify(request)
    const resultJson = JSON.stringify(result)
    return await this.createOrJoinTransaction(async () => {
      const existing = await envelopeRecordOf(this.db).get({ effectKey })
      if (existing) {
        if (
          existing.requestJson === requestJson &&
          existing.resultJson === resultJson &&
          existing.recordedAt === input.recordedAt
        ) {
          return effectKey
        }
        throw new Error(`shipping effect envelope ${effectKey} is immutable`)
      }
      await insertEnvelope(this.db).run({
        effectKey,
        trainId: manifest.id,
        attemptId: request.attemptId,
        requestDigest: request.requestDigest,
        requestJson,
        resultJson,
        recordedAt: input.recordedAt,
      })
      return effectKey
    })
  }

  /** Settle an earlier immutable train prefix from a later order's exact
   * destination proof. The covering order must durably depend on this member;
   * this is the only path which may cross queued → shipped without fabricating
   * a per-member executor attempt. */
  async completeCoveredOrder(
    _scope: WriteScope,
    input: DeliveryReceiptValue,
    coveringOrderId: ShipOrderValue['id'],
    effectEnvelopeKey: string,
  ): Promise<DeliveryReceiptValue> {
    const receipt = DeliveryReceipt.parse(input)
    return await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(receipt.orderId)
      const covering = await this.getOrder(coveringOrderId)
      const coveringReceipt = await this.receiptForOrder(coveringOrderId)
      const envelope = await envelopeProofOf(this.db).get({ effectKey: effectEnvelopeKey })
      if (!envelope) throw new Error(`unknown shipping effect envelope ${effectEnvelopeKey}`)
      const request = ShippingJobRequestMessage.parse(JSON.parse(envelope.requestJson))
      const result = ShippingJobResult.parse(JSON.parse(envelope.resultJson))
      if (
        request.operation !== 'verify' ||
        result.state !== 'succeeded' ||
        result.classification !== 'proved' ||
        !shippingTrainProofsMatch(request, result) ||
        !request.train ||
        !('manifest' in request.train)
      ) {
        throw new Error(`shipping effect envelope ${effectEnvelopeKey} is not verified train proof`)
      }
      const manifest = request.train.manifest
      const proof = result.trainProofs?.find((candidate) => candidate.orderId === receipt.orderId)
      const manifestAuthority = await manifestClaimAuthority(this.db).get({ id: manifest.id })
      if (!order || !covering || !coveringReceipt || covering.state !== 'shipped') {
        throw new Error(`covered delivery receipt ${receipt.id} has no shipped covering order`)
      }
      const existing = await this.receiptForOrder(order.id)
      if (order.state === 'shipped' && existing) {
        if (JSON.stringify(existing) === JSON.stringify(receipt)) return existing
        throw new Error(`ship order ${order.id} already has different immutable receipt`)
      }
      if (order.state !== 'preflight') {
        throw new Error(`covered ship order ${order.id} is ${order.state}, not preflight`)
      }
      const member = manifest?.members.find((candidate) => candidate.orderId === order.id)
      const memberAttempt = member ? await this.getAttempt(member.attemptId) : null
      if (
        !manifest ||
        !proof ||
        !manifestAuthority ||
        manifestAuthority.releasedAt ||
        manifestAuthority.claimCount !== manifest.memberCount ||
        manifest.leaderOrderId !== covering.id ||
        !member ||
        !memberAttempt ||
        memberAttempt.finishedAt ||
        memberAttempt.leaseGeneration !== member.generation ||
        (await this.latestAttemptForOrder(member.orderId))?.id !== member.attemptId ||
        (await this.hasCancellationIntent(member.attemptId, member.generation)) ||
        (await this.openHoldForOrder(member.orderId)) !== null ||
        member.approvedBaseSha !== order.approvedBaseSha ||
        member.approvedHeadSha !== order.approvedHeadSha ||
        proof.issueId !== member.issueId ||
        proof.orderId !== member.orderId ||
        proof.attemptId !== member.attemptId ||
        proof.generation !== member.generation ||
        proof.sourceApprovedSha !== member.approvedHeadSha
      ) {
        throw new Error(`ship order ${order.id} has no exact claimed train membership`)
      }
      if (
        order.repoId !== covering.repoId ||
        order.destination !== covering.destination ||
        order.targetBranch !== covering.targetBranch ||
        order.policyId !== covering.policyId ||
        receipt.approvedBaseSha !== order.approvedBaseSha ||
        receipt.approvedHeadSha !== order.approvedHeadSha ||
        receipt.destination !== order.destination ||
        !proof.resultCommitSha ||
        !proof.testedIntegrationSha ||
        !proof.landedRefSha ||
        !proof.providerLandedRefSha ||
        !proof.destinationSha ||
        receipt.resultCommitSha !== proof.resultCommitSha ||
        receipt.testedIntegrationSha !== proof.testedIntegrationSha ||
        proof.testedIntegrationSha !== coveringReceipt.testedIntegrationSha ||
        proof.landedRefSha !== coveringReceipt.landedRefSha ||
        proof.providerLandedRefSha !== coveringReceipt.landedRefSha ||
        proof.destinationSha !== coveringReceipt.destinationSha ||
        receipt.testedIntegrationSha !== coveringReceipt.testedIntegrationSha ||
        receipt.landedRefSha !== coveringReceipt.landedRefSha ||
        receipt.destinationSha !== coveringReceipt.destinationSha ||
        receipt.validationProfileId !== coveringReceipt.validationProfileId
      ) {
        throw new Error(`covered delivery receipt ${receipt.id} does not match its train proof`)
      }
      await this.finishAttempt(_scope, memberAttempt.id, memberAttempt.leaseGeneration, {
        finishedAt: receipt.completedAt,
        outcome: 'succeeded',
        testedIntegrationSha: receipt.testedIntegrationSha,
        landedRefSha: receipt.landedRefSha,
        destinationSha: receipt.destinationSha,
        validationProfileId: receipt.validationProfileId,
        validationResult: 'passed',
      })
      await this.insertDeliveryReceipt(receipt)
      const changed = await shipPreflightOrder(this.db).run({
        stateChangedAt: receipt.completedAt,
        id: receipt.orderId,
      })
      if (changed.changes !== 1) throw new Error(`ship order ${order.id} coverage fence failed`)
      return (await this.receiptForOrder(order.id)) as DeliveryReceiptValue
    })
  }

  async completeVerifiedTrain(
    _scope: WriteScope,
    input: {
      leader: Parameters<ShippingRepository['commitEffectResult']>[1]
      covered: {
        receipt: DeliveryReceiptValue
        coveringOrderId: ShipOrderValue['id']
        effectEnvelopeKey: string
      }[]
      invalidations?: ShipHoldValue[]
      expectedRecoveryRevision?: number
      release?: { trainId: ShipTrainManifestValue['id']; releasedAt: string; reason: string }
    },
  ): Promise<ShipOrderValue> {
    return await this.createOrJoinTransaction(async () => {
      if (input.expectedRecoveryRevision !== undefined) {
        await this.assertRecoveryRevision(_scope, input.expectedRecoveryRevision)
      }
      const leader = await this.commitEffectResult(_scope, input.leader)
      for (const covered of input.covered) {
        await this.completeCoveredOrder(
          _scope,
          covered.receipt,
          covered.coveringOrderId,
          covered.effectEnvelopeKey,
        )
      }
      if (input.release) {
        await this.releaseTrain(
          _scope,
          input.release.trainId,
          input.release.releasedAt,
          input.release.reason,
        )
      }
      for (const hold of input.invalidations ?? []) await this.raiseHold(_scope, hold)
      // The planned invalidations and all of these receipts share this commit.
      if (
        input.expectedRecoveryRevision !== undefined &&
        input.invalidations !== undefined &&
        input.leader.outcome.kind === 'verified' &&
        (await this.recoveryRevision()) ===
          input.expectedRecoveryRevision + 1 + input.covered.length
      ) {
        for (const receipt of [
          input.leader.outcome.receipt,
          ...input.covered.map((c) => c.receipt),
        ]) {
          await this.completeRecoveryWork(_scope, descendantInvalidationKey(receipt))
        }
      }
      return leader
    })
  }

  /** Insert the order's one immutable receipt and cross the verifying→shipped
   * boundary atomically. Proof must match both the frozen approval and one
   * finished attempt's tested/landed/destination facts. */
  async completeVerifiedOrder(
    _scope: WriteScope,
    input: DeliveryReceiptValue,
  ): Promise<DeliveryReceiptValue> {
    const receipt = DeliveryReceipt.parse(input)
    return await this.createOrJoinTransaction(async () => {
      const order = await this.getOrder(receipt.orderId)
      if (!order) throw new Error(`unknown ship order ${receipt.orderId}`)
      const existing = await this.receiptForOrder(receipt.orderId)
      if (order.state === 'shipped' && existing) {
        if (JSON.stringify(existing) === JSON.stringify(receipt)) return existing
        throw new Error(`ship order ${order.id} already has different immutable receipt`)
      }
      if (order.state !== 'verifying') {
        throw new Error(`ship order ${order.id} is ${order.state}, not verifying`)
      }
      if (existing) throw new Error(`ship order ${order.id} already has a receipt`)
      const trainReceiptProof = (
        await envelopeProofsOfAttempt(this.db).all({
          // The empty-string fallback is preserved: it matches no attempt
          // and the raw statement relied on that rather than short-circuiting.
          attemptId: (await this.latestAttemptForOrder(order.id))?.id ?? asShipAttemptId(''),
        })
      ).some((envelope) => {
        try {
          const request = ShippingJobRequestMessage.parse(JSON.parse(envelope.requestJson))
          const result = ShippingJobResult.parse(JSON.parse(envelope.resultJson))
          if (
            request.operation !== 'verify' ||
            result.state !== 'succeeded' ||
            !request.train ||
            !('manifest' in request.train) ||
            request.train.manifest.leaderOrderId !== order.id ||
            !shippingTrainProofsMatch(request, result)
          ) {
            return false
          }
          const proof = result.trainProofs?.find((candidate) => candidate.orderId === order.id)
          return (
            proof?.resultCommitSha === receipt.resultCommitSha &&
            proof.testedIntegrationSha === receipt.testedIntegrationSha &&
            proof.providerLandedRefSha === receipt.landedRefSha &&
            proof.destinationSha === receipt.destinationSha &&
            result.validationProfileId === receipt.validationProfileId
          )
        } catch {
          return false
        }
      })
      if (
        receipt.approvedBaseSha !== order.approvedBaseSha ||
        receipt.approvedHeadSha !== order.approvedHeadSha ||
        (receipt.resultCommitSha !== receipt.landedRefSha && !trainReceiptProof) ||
        receipt.destination !== order.destination
      ) {
        throw new Error(`delivery receipt ${receipt.id} does not match order ${order.id}`)
      }
      const proof = await successfulProofAttempt(this.db).get({
        orderId: order.id,
        approvedHeadSha: receipt.approvedHeadSha,
        testedIntegrationSha: receipt.testedIntegrationSha,
        landedRefSha: receipt.landedRefSha,
        destinationSha: receipt.destinationSha,
        validationProfileId: receipt.validationProfileId,
      })
      if (!proof) {
        throw new Error(`delivery receipt ${receipt.id} has no matching successful proof`)
      }
      await this.insertDeliveryReceipt(receipt)
      const changed = await shipVerifyingOrder(this.db).run({
        stateChangedAt: receipt.completedAt,
        id: receipt.orderId,
      })
      if (changed.changes !== 1) throw new Error(`ship order ${order.id} verification fence failed`)
      return (await this.receiptForOrder(receipt.orderId)) as DeliveryReceiptValue
    })
  }
}
