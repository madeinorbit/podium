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
  RootIntegrationReceipt,
  type RootIntegrationReceipt as RootIntegrationReceiptValue,
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
import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import {
  deliveryReceipts,
  issues,
  rootIntegrationReceipts,
  shipAttempts,
  shipEffectEnvelopes,
  shipEvidence,
  shipHolds,
  shipLaneRevisions,
  shipOrderStackEdges,
  shipOrders,
  shipRepairCandidates,
  shipSteps,
  shipTrainActiveClaims,
  shipTrainManifests,
  shipTrainMembers,
} from '../migrations/schema'
import type { SyncQueries } from './executor/sync-drizzle'

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
 */
const activeClaimCount = sql<number>`(SELECT COUNT(*) FROM ${shipTrainActiveClaims} c WHERE c.train_id = ${sql.identifier('ship_train_manifests')}.${sql.identifier('id')})`

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
const orderColumns = {
  ...getTableColumns(shipOrders),
  validationProfile: sql<string | null>`${shipOrders.validationProfile}`,
}
const stepColumns = {
  ...getTableColumns(shipSteps),
  inputFence: sql<string>`${shipSteps.inputFence}`,
}
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
const trainManifestColumns = {
  id: shipTrainManifests.id,
  canonicalJson: shipTrainManifests.canonicalJson,
  canonicalDigest: shipTrainManifests.canonicalDigest,
  repoId: shipTrainManifests.repoId,
  repoPath: shipTrainManifests.repoPath,
  machineId: shipTrainManifests.machineId,
  laneKey: shipTrainManifests.laneKey,
  laneRevision: shipTrainManifests.laneRevision,
  targetBranch: shipTrainManifests.targetBranch,
  expectedTargetSha: shipTrainManifests.expectedTargetSha,
  destination: shipTrainManifests.destination,
  providerRef: sql<string | null>`${shipTrainManifests.providerRef}`,
  policyId: shipTrainManifests.policyId,
  validationProfile: sql<string>`${shipTrainManifests.validationProfile}`,
  validationProfileDigest: shipTrainManifests.validationProfileDigest,
  memberCount: shipTrainManifests.memberCount,
  leaderOrderId: shipTrainManifests.leaderOrderId,
  leaderAttemptId: shipTrainManifests.leaderAttemptId,
  leaderGeneration: shipTrainManifests.leaderGeneration,
}
const trainMemberColumns = {
  ordinal: shipTrainMembers.ordinal,
  issueId: shipTrainMembers.issueId,
  orderId: shipTrainMembers.orderId,
  attemptId: shipTrainMembers.attemptId,
  generation: shipTrainMembers.generation,
  machineId: shipTrainMembers.machineId,
  sourceBranch: shipTrainMembers.sourceBranch,
  approvedBaseSha: shipTrainMembers.approvedBaseSha,
  approvedHeadSha: shipTrainMembers.approvedHeadSha,
  deliveryDependsOn: sql<string>`${shipTrainMembers.deliveryDependsOn}`,
}

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

/** Narrow typed producer/consumer port shared by issue integration and Shipping
 * admission. Its lookup key is the approved root head itself—not an evidence
 * manifest reference and not an event payload. */
export interface RootIntegrationReceiptStore {
  rootIntegrationReceipt(
    rootIssueId: RootIntegrationReceiptValue['rootIssueId'],
    approvedHeadSha: string,
  ): RootIntegrationReceiptValue | null
  recordRootIntegrationReceipt(input: RootIntegrationReceiptValue): RootIntegrationReceiptValue
}

/** Durable normalized shipping family. It owns persistence invariants only;
 * admission, scheduling, machine effects, and lifecycle orchestration live above
 * this repository. */
export class ShippingRepository implements RootIntegrationReceiptStore {
  /** The query builder, in the field this file's `SqlDatabase` used to occupy. */
  private readonly db: SyncQueries['db']
  /** The span, beside it, so a call site reads `this.transact(...)` (rule 34). */
  private readonly transact: SyncQueries['transact']

  constructor(queries: SyncQueries) {
    this.db = queries.db
    // Wrapped rather than assigned straight across, so the field cannot depend
    // on how the capability happens to be built today: `syncQueriesOver` returns
    // an arrow that closes over the handle, but a later implementation — the
    // async pair at B1 — is free to use `this`, and a detached method would
    // break silently there rather than here.
    this.transact = (fn) => queries.transact(fn)
  }

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
  /**
   * The next hold generation's predecessor, which five call sites carried
   * verbatim. `COALESCE(MAX(generation), 0)` returns 0 for an order with no
   * hold, and every caller adds one — so an order's first hold is generation 1.
   * Kept as one aggregate read rather than `max()` over a mapped list, because
   * the zero case is the aggregate's, not the caller's.
   */
  private highestHoldGeneration(orderId: ShipOrderValue['id']): number {
    const row = this.db
      .select({ generation: sql<number>`COALESCE(MAX(${shipHolds.generation}), 0)` })
      .from(shipHolds)
      .where(eq(shipHolds.orderId, orderId))
      .get()
    return row?.generation ?? 0
  }

  /** See {@link activeClaimCount}. */
  /** The immutable delivery receipt, inserted identically by the covered and
   *  the verified completion paths. */
  private insertDeliveryReceipt(receipt: DeliveryReceiptValue): void {
    this.db
      .insert(deliveryReceipts)
      .values({
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
      .run()
  }

  private bumpLaneRevision(laneKey: string, updatedAt: string): void {
    this.db
      .insert(shipLaneRevisions)
      .values({ laneKey, revision: 1, updatedAt })
      .onConflictDoUpdate({
        target: shipLaneRevisions.laneKey,
        set: {
          revision: sql`${shipLaneRevisions.revision} + 1`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .run()
  }

  shippingEvidence(ref: string): StoredShippingEvidence | null {
    const row = this.db.select().from(shipEvidence).where(eq(shipEvidence.ref, ref)).get()
    return row ? { ...row } : null
  }

  shippingEvidenceForSource(
    custodyDigest: string,
    sourceRef: string,
  ): StoredShippingEvidence | null {
    const row = this.db
      .select()
      .from(shipEvidence)
      .where(
        and(eq(shipEvidence.custodyDigest, custodyDigest), eq(shipEvidence.sourceRef, sourceRef)),
      )
      .limit(1)
      .get()
    return row ? { ...row } : null
  }

  recordShippingEvidence(input: StoredShippingEvidence): StoredShippingEvidence {
    if (createHash('sha256').update(input.content).digest('hex') !== input.contentDigest) {
      throw new Error(`shipwright evidence ${input.ref} content digest mismatch`)
    }
    const existing =
      this.shippingEvidence(input.ref) ??
      this.shippingEvidenceForSource(input.custodyDigest, input.sourceRef)
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
    this.db
      .insert(shipEvidence)
      .values({
        ref: input.ref,
        custodyDigest: input.custodyDigest,
        contentDigest: input.contentDigest,
        sourceRef: input.sourceRef,
        content: input.content,
        materializedAt: input.materializedAt,
      })
      .run()
    return { ...input }
  }

  repairCandidatesForAttempt(attemptId: ShipAttemptValue['id']): StoredShippingRepairCandidate[] {
    return this.db
      .select()
      .from(shipRepairCandidates)
      .where(eq(shipRepairCandidates.attemptId, attemptId))
      .orderBy(asc(shipRepairCandidates.sequence))
      .all()
      .map((row) => ({ ...row }))
  }

  private recordRepairCandidate(input: StoredShippingRepairCandidate): void {
    const attempt = this.getAttempt(input.attemptId)
    const order = this.getOrder(input.orderId)
    if (
      !attempt ||
      !order ||
      attempt.orderId !== input.orderId ||
      attempt.leaseGeneration !== input.generation ||
      attempt.finishedAt
    ) {
      throw new Error(`ship repair ${input.attemptId}:${input.sequence} custody fence failed`)
    }
    const prior = this.repairCandidatesForAttempt(input.attemptId)
    if (input.sequence !== prior.length + 1 || input.round !== input.sequence) {
      throw new Error(`ship repair ${input.attemptId} causal sequence is not contiguous`)
    }
    if (!/^[a-f0-9]{64}$/.test(input.contextDigest)) {
      throw new Error(`ship repair ${input.attemptId}:${input.sequence} context digest is invalid`)
    }
    this.db
      .insert(shipRepairCandidates)
      .values({
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
      .run()
  }

  /**
   * Typed pre-admission proof for one exact delivery-root head. The key includes
   * the immutable git commit, so callers never ask for an ambiguous "latest"
   * receipt and Shipping can compare it directly with the live approved head.
   */
  rootIntegrationReceipt(
    rootIssueId: RootIntegrationReceiptValue['rootIssueId'],
    approvedHeadSha: string,
  ): RootIntegrationReceiptValue | null {
    const row = this.db
      .select()
      .from(rootIntegrationReceipts)
      .where(
        and(
          eq(rootIntegrationReceipts.rootIssueId, rootIssueId),
          eq(rootIntegrationReceipts.approvedHeadSha, approvedHeadSha),
        ),
      )
      .get()
    return row ? mapIntegrationReceipt(row) : null
  }

  /**
   * Append an integration receipt, idempotently. An exact replay returns the
   * stored value; the same root/head with different descendant facts is an
   * immutable-history collision and is refused rather than overwritten.
   */
  recordRootIntegrationReceipt(input: RootIntegrationReceiptValue): RootIntegrationReceiptValue {
    const receipt = canonicalIntegrationReceipt(input)
    const existing = this.rootIntegrationReceipt(receipt.rootIssueId, receipt.approvedHeadSha)
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(receipt)) return existing
      throw new Error(
        `root integration receipt ${receipt.rootIssueId}@${receipt.approvedHeadSha} already exists with different descendants`,
      )
    }
    this.db
      .insert(rootIntegrationReceipts)
      .values({
        rootIssueId: receipt.rootIssueId,
        approvedHeadSha: receipt.approvedHeadSha,
        // `descendants` is plain `text()`, so the serialisation stays the
        // caller's, exactly as the raw statement had it.
        descendants: JSON.stringify(receipt.descendants),
      })
      .run()
    const stored = this.rootIntegrationReceipt(receipt.rootIssueId, receipt.approvedHeadSha)
    if (!stored) throw new Error('root integration receipt insert did not persist')
    return stored
  }

  getOrder(id: string): ShipOrderValue | null {
    // The public signature takes a plain `string` and widening it to the brand
    // is a caller change, not a conversion; `asShipOrderId` is the identity cast
    // the model exports for exactly this boundary.
    const row = this.db
      .select(orderColumns)
      .from(shipOrders)
      .where(eq(shipOrders.id, asShipOrderId(id)))
      .get()
    return row ? mapOrder(row) : null
  }

  activeOrderForIssue(issueId: string): ShipOrderValue | null {
    const row = this.db
      .select(orderColumns)
      .from(shipOrders)
      .where(
        and(
          eq(shipOrders.issueId, asIssueId(issueId)),
          notInArray(shipOrders.state, ['shipped', 'cancelled']),
        ),
      )
      .get()
    return row ? mapOrder(row) : null
  }

  listOrders(): ShipOrderValue[] {
    return this.db
      .select(orderColumns)
      .from(shipOrders)
      .orderBy(asc(shipOrders.requestedAt), asc(shipOrders.id))
      .all()
      .map(mapOrder)
  }

  issueIdForOrder(id: string): string | null {
    const row = this.db
      .select({ issueId: shipOrders.issueId })
      .from(shipOrders)
      .where(eq(shipOrders.id, asShipOrderId(id)))
      .get()
    return row?.issueId ?? null
  }

  issueIdsForOrders(ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>()
    const unique = [...new Set(ids)]
    const chunkSize = 500
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize)
      // The 500-id chunk stays: it bounds the number of distinct SQL texts the
      // statement cache sees, and drizzle's `inArray` emits one placeholder per
      // id exactly as the hand-built list did.
      const rows = this.db
        .select({ id: shipOrders.id, issueId: shipOrders.issueId })
        .from(shipOrders)
        .where(inArray(shipOrders.id, chunk.map(asShipOrderId)))
        .all()
      for (const row of rows) out.set(row.id, row.issueId)
    }
    return out
  }

  createOrder(input: ShipOrderValue): ShipOrderValue {
    const order = ShipOrder.parse(input)
    if (order.state !== 'queued') {
      throw new Error(`ship order ${order.id} must be created queued`)
    }
    return this.transact(() => {
      const existing = this.getOrder(order.id)
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(order)) return existing
        throw new Error(`ship order id ${order.id} already exists with different content`)
      }
      const active = this.activeOrderForIssue(order.issueId)
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
      const issue = this.db
        .select({ repoPath: issues.repoPath, machineId: issues.machineId })
        .from(issues)
        .where(eq(issues.id, order.issueId))
        .get()
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
      this.db
        .insert(shipOrders)
        .values({
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
        .run()
      this.bumpLaneRevision(laneKey, order.requestedAt)
      this.invalidateActiveLane(laneKey, order.requestedAt, 'lane-enqueue')
      return this.getOrder(order.id) as ShipOrderValue
    })
  }

  /** The admission race closes here, inside the caller's outer transaction.
   * An identical active approval is the same command; a changed approval is a
   * new review and must not replace the frozen order. */
  createOrReturnActiveOrder(input: ShipOrderValue): {
    order: ShipOrderValue
    created: boolean
  } {
    const candidate = ShipOrder.parse(input)
    return this.transact(() => {
      const active = this.activeOrderForIssue(candidate.issueId)
      if (active) {
        if (sameFrozenShipOrder(active, candidate)) {
          return { order: active, created: false }
        }
        throw new Error(`issue ${candidate.issueId} already has a different active ship order`)
      }
      return { order: this.createOrder(candidate), created: true }
    })
  }

  /** Compare-and-swap an operational state. Held and verified-terminal changes
   * have dedicated methods because they must update their normalized child row
   * in the same transaction. */
  transitionOrder(
    id: string,
    expectedState: ShipOrderState,
    nextState: Exclude<ShipOrderState, 'held' | 'shipped'>,
    stateChangedAt: string,
  ): ShipOrderValue {
    const current = this.getOrder(id)
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
    const attempt = this.latestAttemptForOrder(id)
    if (
      nextState !== 'cancelled' &&
      attempt &&
      this.hasCancellationIntent(attempt.id, attempt.leaseGeneration)
    ) {
      throw new Error(`ship order ${id} has durable cancellation intent`)
    }
    const result = this.db
      .update(shipOrders)
      .set({ state: nextState, stateChangedAt, holdCode: null })
      .where(
        and(
          eq(shipOrders.id, asShipOrderId(id)),
          eq(shipOrders.state, expectedState),
          // Redundant against the equality above and kept verbatim: narrowing a
          // fence during a conversion is a behaviour change, not a tidy-up.
          notInArray(shipOrders.state, ['shipped', 'cancelled']),
        ),
      )
      .run()
    if (result.changes !== 1) {
      throw new Error(`ship order ${id} state fence failed: expected ${expectedState}`)
    }
    return this.getOrder(id) as ShipOrderValue
  }

  getAttempt(id: string): ShipAttemptValue | null {
    const row = this.db
      .select()
      .from(shipAttempts)
      .where(eq(shipAttempts.id, asShipAttemptId(id)))
      .get()
    return row ? mapAttempt(row) : null
  }

  createAttempt(input: ShipAttemptValue): ShipAttemptValue {
    const attempt = ShipAttempt.parse(input)
    const existing = this.getAttempt(attempt.id)
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(attempt)) return existing
      throw new Error(`ship attempt id ${attempt.id} already exists with different content`)
    }
    const order = this.getOrder(attempt.orderId)
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
    this.db
      .insert(shipAttempts)
      .values({
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
      .run()
    return this.getAttempt(attempt.id) as ShipAttemptValue
  }

  latestAttemptForOrder(orderId: string): ShipAttemptValue | null {
    const row = this.db
      .select()
      .from(shipAttempts)
      .where(eq(shipAttempts.orderId, asShipOrderId(orderId)))
      .orderBy(desc(shipAttempts.leaseGeneration))
      .limit(1)
      .get()
    return row ? mapAttempt(row) : null
  }

  listAttempts(): ShipAttemptValue[] {
    return this.db
      .select()
      .from(shipAttempts)
      .orderBy(asc(shipAttempts.startedAt), asc(shipAttempts.id))
      .all()
      .map(mapAttempt)
  }

  claimTrain(input: {
    leaderOrderId: ShipOrderValue['id']
    startedAt: string
    members: { orderId: ShipOrderValue['id'] }[]
  }): {
    manifest: ShipTrainManifestValue
    claimed: { order: ShipOrderValue; attempt: ShipAttemptValue }[]
  } {
    return this.transact(() => {
      const requestedIds = [...new Set(input.members.map((member) => member.orderId))]
      if (requestedIds.length === 0 || requestedIds.length !== input.members.length) {
        throw new Error('ship train claim requires unique non-empty order ids')
      }
      const selected = requestedIds.map((id) => {
        const order = this.getOrder(id)
        if (!order || order.state !== 'queued') {
          throw new Error(`ship train member ${id} is not queued`)
        }
        return order
      })
      const leaderOrder = this.getOrder(input.leaderOrderId)
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
        selected.map((order) => {
          const row = this.db
            .select({
              branch: issues.branch,
              machineId: issues.machineId,
              repoPath: issues.repoPath,
            })
            .from(issues)
            .where(eq(issues.id, order.issueId))
            .get()
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
      const laneRevisionRow = this.db
        .select({ revision: shipLaneRevisions.revision })
        .from(shipLaneRevisions)
        .where(eq(shipLaneRevisions.laneKey, laneKey))
        .get()
      if (!laneRevisionRow || laneRevisionRow.revision < 1) {
        throw new Error('ship train lane has no durable revision')
      }
      const occupiedLane = this.listOrders().find(
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
      const stackEdges = this.db
        .select({
          upperOrderId: shipOrderStackEdges.upperOrderId,
          lowerOrderId: shipOrderStackEdges.lowerOrderId,
        })
        .from(shipOrderStackEdges)
        .all()
      const stackLower = new Map<ShipOrderValue['id'], ShipOrderValue['id'][]>()
      for (const edge of stackEdges) {
        const lower = stackLower.get(edge.upperOrderId) ?? []
        lower.push(edge.lowerOrderId)
        stackLower.set(edge.upperOrderId, lower)
      }
      const dependencies = (order: ShipOrderValue): ShipOrderValue['deliveryDependsOn'] =>
        [...new Set([...order.deliveryDependsOn, ...(stackLower.get(order.id) ?? [])])].sort()
      const laneOrders = this.listOrders().filter(
        (order) => order.state === 'queued' && compatible(order),
      )
      const allOrders = new Map(this.listOrders().map((order) => [order.id, order]))
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
      const claimed = prefix.map((order) => {
        const previous = this.latestAttemptForOrder(order.id)
        return this.claimAttempt({
          orderId: order.id,
          expectedState: 'queued',
          expectedAttemptId: previous?.id ?? null,
          expectedGeneration: previous?.leaseGeneration ?? 0,
          machineId,
          startedAt: input.startedAt,
        })
      })
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
      this.db
        .insert(shipTrainManifests)
        .values({
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
          // absent-means-NULL arm rather than storing the string "null".
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
        .run()
      for (const [ordinal, member] of manifest.members.entries()) {
        this.db
          .insert(shipTrainMembers)
          .values({
            trainId: manifest.id,
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
          .run()
      }
      for (const member of manifest.members) {
        this.db
          .insert(shipTrainActiveClaims)
          .values({
            trainId: manifest.id,
            orderId: member.orderId,
            attemptId: member.attemptId,
            generation: member.generation,
          })
          .run()
      }
      const finalRevision = this.db
        .select({ revision: shipLaneRevisions.revision })
        .from(shipLaneRevisions)
        .where(eq(shipLaneRevisions.laneKey, laneKey))
        .get()
      if (finalRevision?.revision !== laneRevisionRow.revision) {
        throw new Error('ship train lane changed during claim')
      }
      const effectKey = `train-membership:${manifest.id}:${canonicalDigest}`
      this.appendStep({
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

  trainManifestForAttempt(attemptId: ShipAttemptValue['id']): ShipTrainManifestValue | null {
    // The projection named 19 of the manifest table's columns and the join adds
    // none, so `select()` over the joined table returns the same fields.
    const row = this.db
      .select(trainManifestColumns)
      .from(shipTrainManifests)
      .innerJoin(shipTrainMembers, eq(shipTrainMembers.trainId, shipTrainManifests.id))
      .where(eq(shipTrainMembers.attemptId, attemptId))
      .get()
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
    const normalizedMembers = this.db
      .select(trainMemberColumns)
      .from(shipTrainMembers)
      .where(eq(shipTrainMembers.trainId, manifest.id))
      .orderBy(asc(shipTrainMembers.ordinal))
      .all()
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
    const auditMarker = this.stepsForAttempt(leader.attemptId).find(
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

  private claimedTrainForOrder(orderId: ShipOrderValue['id']): ShipTrainManifestValue | null {
    const row = this.db
      .select({ attemptId: shipTrainActiveClaims.attemptId })
      .from(shipTrainActiveClaims)
      .innerJoin(shipTrainManifests, eq(shipTrainManifests.id, shipTrainActiveClaims.trainId))
      .where(and(eq(shipTrainActiveClaims.orderId, orderId), isNull(shipTrainManifests.releasedAt)))
      .get()
    if (!row) return null
    return this.trainManifestForAttempt(row.attemptId)
  }

  activeTrainForOrder(orderId: ShipOrderValue['id']): ShipTrainManifestValue | null {
    const manifest = this.claimedTrainForOrder(orderId)
    if (!manifest) return null
    const authority = this.db
      .select({
        releasedAt: shipTrainManifests.releasedAt,
        revision: shipLaneRevisions.revision,
        // The correlated count is a DECISION about what "still claimed" means,
        // and drizzle has no builder form for a correlated subquery in a
        // projection, so it stays a `sql` fragment inside the builder query
        // (spec rule 1). The predicate is unchanged.
        claimCount: activeClaimCount,
      })
      .from(shipTrainManifests)
      .innerJoin(shipLaneRevisions, eq(shipLaneRevisions.laneKey, shipTrainManifests.laneKey))
      .where(eq(shipTrainManifests.id, manifest.id))
      .get()
    if (
      !authority ||
      authority.releasedAt ||
      authority.revision !== manifest.lane.laneRevision ||
      authority.claimCount !== manifest.memberCount
    ) {
      return null
    }
    for (const member of manifest.members) {
      const order = this.getOrder(member.orderId)
      const attempt = this.getAttempt(member.attemptId)
      const latest = this.latestAttemptForOrder(member.orderId)
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
  activeTrainsForLane(order: ShipOrderValue): ShipTrainManifestValue[] {
    if (!order.repoPath || !order.machineId) return []
    const laneKey = shippingLaneKey(order, {
      repoPath: order.repoPath,
      machineId: order.machineId,
    })
    const rows = this.db
      .select({ orderId: shipTrainActiveClaims.orderId })
      .from(shipTrainActiveClaims)
      .innerJoin(shipTrainManifests, eq(shipTrainManifests.id, shipTrainActiveClaims.trainId))
      .where(and(eq(shipTrainManifests.laneKey, laneKey), isNull(shipTrainManifests.releasedAt)))
      .orderBy(
        asc(shipTrainManifests.createdAt),
        asc(shipTrainManifests.id),
        asc(shipTrainActiveClaims.orderId),
      )
      .all()
    const manifests = new Map<string, ShipTrainManifestValue>()
    for (const row of rows) {
      const manifest = this.claimedTrainForOrder(row.orderId)
      if (manifest) manifests.set(manifest.id, manifest)
    }
    return [...manifests.values()]
  }

  releaseTrain(trainId: ShipTrainManifestValue['id'], releasedAt: string, reason: string): void {
    this.transact(() => {
      const row = this.db
        .select({
          releasedAt: shipTrainManifests.releasedAt,
          releaseReason: shipTrainManifests.releaseReason,
        })
        .from(shipTrainManifests)
        .where(eq(shipTrainManifests.id, trainId))
        .get()
      if (!row) throw new Error(`unknown ship train ${trainId}`)
      if (row.releasedAt) {
        if (row.releasedAt === releasedAt && row.releaseReason === reason) return
        throw new Error(`ship train ${trainId} was already released differently`)
      }
      const changed = this.db
        .update(shipTrainManifests)
        .set({ releasedAt, releaseReason: reason })
        .where(and(eq(shipTrainManifests.id, trainId), isNull(shipTrainManifests.releasedAt)))
        .run()
      if (changed.changes !== 1) throw new Error(`ship train ${trainId} release fence failed`)
      const claims = this.db
        .delete(shipTrainActiveClaims)
        .where(eq(shipTrainActiveClaims.trainId, trainId))
        .run()
      const memberCount = this.db
        .select({ memberCount: shipTrainManifests.memberCount })
        .from(shipTrainManifests)
        .where(eq(shipTrainManifests.id, trainId))
        .get()
      if (claims.changes !== memberCount?.memberCount) {
        throw new Error(`ship train ${trainId} did not release every active member claim`)
      }
    })
  }

  isolateTrainFailure(input: {
    trainId: ShipTrainManifestValue['id']
    leaderOrderId: ShipOrderValue['id']
    leaderAttemptId: ShipAttemptValue['id']
    generation: number
    terminalStep: ShipStepValue
    failureOrderIds: ShipOrderValue['id'][]
    isolatedAt: string
    detail: string
  }): void {
    this.transact(() => {
      const manifest = this.claimedTrainForOrder(input.leaderOrderId)
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
      this.appendStep(input.terminalStep)
      this.releaseTrain(manifest.id, input.isolatedAt, 'validation-isolated')
      for (const member of manifest.members) {
        const order = this.getOrder(member.orderId)
        const attempt = this.getAttempt(member.attemptId)
        if (!order || isTerminalShipOrderState(order.state)) continue
        if (attempt && !attempt.finishedAt) {
          this.finishAttempt(member.attemptId, member.generation, {
            finishedAt: input.isolatedAt,
            outcome: 'failed',
          })
        }
        if (!failures.has(member.orderId)) {
          const changed = this.db
            .update(shipOrders)
            .set({ state: 'queued', stateChangedAt: input.isolatedAt, holdCode: null })
            .where(
              and(
                eq(shipOrders.id, member.orderId),
                notInArray(shipOrders.state, ['shipped', 'cancelled', 'held']),
              ),
            )
            .run()
          if (changed.changes !== 1)
            throw new Error(`ship train ${manifest.id} green member reset failed`)
          continue
        }
        const generationRow = { generation: this.highestHoldGeneration(member.orderId) }
        this.raiseHold({
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

  private invalidateActiveLane(laneKey: string, at: string, reason: string): void {
    const rows = this.db
      .select({ id: shipTrainManifests.id })
      .from(shipTrainManifests)
      .where(and(eq(shipTrainManifests.laneKey, laneKey), isNull(shipTrainManifests.releasedAt)))
      .orderBy(asc(shipTrainManifests.createdAt), asc(shipTrainManifests.id))
      .all()
    for (const row of rows) {
      const memberRows = this.db
        .select({
          orderId: shipTrainMembers.orderId,
          attemptId: shipTrainMembers.attemptId,
          generation: shipTrainMembers.generation,
        })
        .from(shipTrainMembers)
        .innerJoin(
          shipTrainActiveClaims,
          and(
            eq(shipTrainActiveClaims.trainId, shipTrainMembers.trainId),
            eq(shipTrainActiveClaims.orderId, shipTrainMembers.orderId),
          ),
        )
        .where(eq(shipTrainMembers.trainId, row.id))
        .orderBy(asc(shipTrainMembers.ordinal))
        .all()
      const orders = memberRows.map((member) => this.getOrder(member.orderId))
      const resettable =
        memberRows.length > 0 &&
        orders.every((order) => order?.state === 'preflight') &&
        memberRows.every((member) => !this.getAttempt(member.attemptId)?.finishedAt)
      this.releaseTrain(row.id, at, reason)
      if (resettable) {
        for (const member of memberRows) {
          this.finishAttempt(member.attemptId, member.generation, {
            finishedAt: at,
            outcome: 'failed',
          })
          const changed = this.db
            .update(shipOrders)
            .set({ state: 'queued', stateChangedAt: at, holdCode: null })
            .where(and(eq(shipOrders.id, member.orderId), eq(shipOrders.state, 'preflight')))
            .run()
          if (changed.changes !== 1)
            throw new Error(`ship train ${row.id} reset was not manifest-wide`)
        }
        continue
      }
      for (const member of memberRows) {
        const order = this.getOrder(member.orderId)
        const attempt = this.getAttempt(member.attemptId)
        if (!order || isTerminalShipOrderState(order.state)) continue
        if (attempt && !attempt.finishedAt) {
          this.finishAttempt(member.attemptId, member.generation, {
            finishedAt: at,
            outcome: 'failed',
          })
        }
        const generationRow = { generation: this.highestHoldGeneration(member.orderId) }
        this.raiseHold({
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

  recordNativeStackEdge(input: {
    upperOrderId: ShipOrderValue['id']
    lowerOrderId: ShipOrderValue['id']
    recordedAt: string
  }): void {
    this.transact(() => {
      const upper = this.getOrder(input.upperOrderId)
      const lower = this.getOrder(input.lowerOrderId)
      if (!upper || !lower || upper.id === lower.id) throw new Error('invalid native stack edge')
      if (
        upper.repoId !== lower.repoId ||
        upper.targetBranch !== lower.targetBranch ||
        canonicalShippingDestination(upper.destination, upper.targetBranch) !==
          canonicalShippingDestination(lower.destination, lower.targetBranch)
      ) {
        throw new Error('native stack edge crosses a delivery lane')
      }
      const issueRows = [upper, lower].map((order) => {
        const issue = this.db
          .select({ repoPath: issues.repoPath, machineId: issues.machineId })
          .from(issues)
          .where(eq(issues.id, order.issueId))
          .get()
        if (!issue?.repoPath || !issue.machineId)
          throw new Error('native stack edge has no lane custody')
        return { repoPath: issue.repoPath, machineId: issue.machineId }
      })
      const laneKey = shippingLaneKey(upper, issueRows[0]!)
      if (shippingLaneKey(lower, issueRows[1]!) !== laneKey) {
        throw new Error('native stack edge crosses immutable compatibility')
      }
      const existing = this.db
        .select()
        .from(shipOrderStackEdges)
        .where(
          and(
            eq(shipOrderStackEdges.upperOrderId, upper.id),
            eq(shipOrderStackEdges.lowerOrderId, lower.id),
          ),
        )
        .get()
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
      this.db
        .insert(shipOrderStackEdges)
        .values({
          upperOrderId: upper.id,
          lowerOrderId: lower.id,
          upperApprovedHeadSha: upper.approvedHeadSha,
          lowerApprovedHeadSha: lower.approvedHeadSha,
          recordedAt: input.recordedAt,
        })
        .run()
      this.bumpLaneRevision(laneKey, input.recordedAt)
      this.invalidateActiveLane(laneKey, input.recordedAt, 'native-stack-change')
    })
  }

  hasNativeStackEdge(
    upperOrderId: ShipOrderValue['id'],
    lowerOrderId: ShipOrderValue['id'],
  ): boolean {
    return Boolean(
      this.db
        .select({ present: sql<number>`1` })
        .from(shipOrderStackEdges)
        .where(
          and(
            eq(shipOrderStackEdges.upperOrderId, upperOrderId),
            eq(shipOrderStackEdges.lowerOrderId, lowerOrderId),
          ),
        )
        .get(),
    )
  }

  /** Claim one active order through its durable order/attempt winner. Recovery
   * supersedes an unfinished prior attempt and mints generation + 1 unless the
   * old winner has durable cancellation intent, which must settle in place. */
  claimAttempt(input: {
    orderId: string
    expectedState: Exclude<ShipOrderState, 'held' | 'shipped' | 'cancelled'>
    expectedAttemptId: string | null
    expectedGeneration: number
    machineId: ShipAttemptValue['machineId']
    startedAt: string
  }): { order: ShipOrderValue; attempt: ShipAttemptValue } {
    return this.transact(() => {
      const order = this.getOrder(input.orderId)
      if (!order) throw new Error(`unknown ship order ${input.orderId}`)
      if (order.state !== input.expectedState) {
        throw new Error(
          `ship order ${order.id} claim fence failed: expected ${input.expectedState}`,
        )
      }
      const latest = this.latestAttemptForOrder(order.id)
      if (
        (latest?.id ?? null) !== input.expectedAttemptId ||
        (latest?.leaseGeneration ?? 0) !== input.expectedGeneration
      ) {
        throw new Error(`ship order ${order.id} attempt claim was superseded`)
      }
      if (latest && this.hasCancellationIntent(latest.id, latest.leaseGeneration)) {
        throw new Error(`ship order ${order.id} has durable cancellation intent`)
      }
      if (latest && !latest.finishedAt) {
        this.finishAttempt(latest.id, latest.leaseGeneration, {
          finishedAt: input.startedAt,
          outcome: 'failed',
        })
      }
      const generation = input.expectedGeneration + 1
      const attempt = this.createAttempt({
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
          ? this.transitionOrder(order.id, 'queued', 'preflight', input.startedAt)
          : order
      return { order: next, attempt }
    })
  }

  hasAttemptCustody(input: {
    orderId: string
    expectedState: ShipOrderState
    attemptId: string
    generation: number
  }): boolean {
    const order = this.getOrder(input.orderId)
    const latest = this.latestAttemptForOrder(input.orderId)
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
  assertEffectDispatchCustody(input: {
    orderId: string
    expectedState: ShipOrderState
    attemptId: string
    generation: number
    effectKey: string
    operation: ShipStepValue['kind']
  }): void {
    this.transact(() => {
      const order = this.getOrder(input.orderId)
      const attempt = this.latestAttemptForOrder(input.orderId)
      const step = this.latestStepForEffect(input.attemptId, input.effectKey)
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
      if (this.hasCancellationIntent(input.attemptId, input.generation)) {
        throw new Error(`ship order ${input.orderId} has durable cancellation intent`)
      }
    })
  }

  /** Commit the result of one awaited daemon effect while its durable custody
   * facts are still current. The journal append and the state change it
   * authorizes share one transaction, so cancellation or a newer generation
   * cannot win between a read fence and a write. */
  commitEffectResult(input: {
    orderId: string
    expectedState: ShipOrderState
    attemptId: string
    generation: number
    effectKey: string
    operation: ShipStepValue['kind']
    terminalStep: ShipStepValue
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
  }): ShipOrderValue {
    return this.transact(() => {
      const order = this.getOrder(input.orderId)
      const latestAttempt = this.latestAttemptForOrder(input.orderId)
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
      if (this.hasCancellationIntent(input.attemptId, input.generation)) {
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
      const latestStep = this.latestStepForEffect(input.attemptId, input.effectKey)
      if (
        !latestStep ||
        latestStep.effectKey !== input.effectKey ||
        latestStep.kind !== input.operation ||
        latestStep.generation !== input.generation
      ) {
        throw new Error(`ship order ${input.orderId} effect step fence failed`)
      }
      if (latestStep.state === 'running') {
        this.appendStep(input.terminalStep)
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

      if (input.outcome.kind === 'transition') {
        if (input.repairCandidate) this.recordRepairCandidate(input.repairCandidate)
        return this.transitionOrder(
          input.orderId,
          input.expectedState,
          input.outcome.nextState,
          input.outcome.stateChangedAt,
        )
      }
      if (input.outcome.kind === 'hold') {
        if (!input.outcome.preserveAttempt) {
          this.finishAttempt(input.attemptId, input.generation, {
            finishedAt: input.outcome.attemptFinishedAt,
            outcome: 'failed',
          })
        }
        this.raiseHold(input.outcome.hold)
        return this.getOrder(input.orderId) as ShipOrderValue
      }
      const receipt = input.outcome.receipt
      this.finishAttempt(input.attemptId, input.generation, {
        finishedAt: input.outcome.attemptFinishedAt,
        outcome: 'succeeded',
        testedIntegrationSha: receipt.testedIntegrationSha,
        landedRefSha: receipt.landedRefSha,
        destinationSha: receipt.destinationSha,
        validationProfileId: receipt.validationProfileId,
        validationResult: 'passed',
      })
      this.completeVerifiedOrder(receipt)
      return this.getOrder(input.orderId) as ShipOrderValue
    })
  }

  /** Atomically close a cancellation intent that cannot be completed and move
   * the order into a human hold. This prevents any crash boundary from leaving
   * a finished attempt paired with a supersedable running cancel journal. */
  commitCancellationHold(input: {
    orderId: string
    expectedState: ShipOrderState
    attemptId: string
    generation: number
    intentKey: string
    terminalStep: ShipStepValue
    hold: ShipHoldValue
    attemptFinishedAt: string
  }): ShipOrderValue {
    return this.transact(() => {
      const order = this.getOrder(input.orderId)
      const latestAttempt = this.latestAttemptForOrder(input.orderId)
      const intent = this.latestStepForEffect(input.attemptId, input.intentKey)
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
      this.appendStep(input.terminalStep)
      this.finishAttempt(input.attemptId, input.generation, {
        finishedAt: input.attemptFinishedAt,
        outcome: 'failed',
      })
      this.raiseHold(input.hold)
      return this.getOrder(input.orderId) as ShipOrderValue
    })
  }

  /** Raise a pre-effect hold under the same order/attempt custody fence used
   * for daemon results. No journal result exists yet, but generation and
   * cancellation intent must still be checked atomically with the transition. */
  commitCustodyHold(input: {
    orderId: string
    expectedState: ShipOrderState
    attemptId: string
    generation: number
    hold: ShipHoldValue
    attemptFinishedAt: string
  }): ShipOrderValue {
    return this.transact(() => {
      const order = this.getOrder(input.orderId)
      const latestAttempt = this.latestAttemptForOrder(input.orderId)
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
      if (this.hasCancellationIntent(input.attemptId, input.generation)) {
        throw new Error(`ship order ${input.orderId} has durable cancellation intent`)
      }
      this.finishAttempt(input.attemptId, input.generation, {
        finishedAt: input.attemptFinishedAt,
        outcome: 'failed',
      })
      this.raiseHold(input.hold)
      return this.getOrder(input.orderId) as ShipOrderValue
    })
  }

  finishAttempt(
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
  ): ShipAttemptValue {
    const attempt = this.getAttempt(id)
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
    const changed = this.db
      .update(shipAttempts)
      .set({
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
      })
      .where(
        and(
          eq(shipAttempts.id, asShipAttemptId(id)),
          eq(shipAttempts.leaseGeneration, leaseGeneration),
          isNull(shipAttempts.finishedAt),
        ),
      )
      .run()
    if (changed.changes !== 1) {
      throw new Error(`ship attempt ${id} generation fence failed: expected ${leaseGeneration}`)
    }
    return this.getAttempt(id) as ShipAttemptValue
  }

  cancelAttemptAndOrder(
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
    },
  ): ShipOrderValue {
    return this.transact(() => {
      const order = this.getOrder(orderId)
      if (!order || order.state !== expectedState) {
        throw new Error(
          `ship order ${orderId} cancellation fence failed: expected ${expectedState}`,
        )
      }
      const activeTrain = this.claimedTrainForOrder(order.id)
      const attempt = this.latestAttemptForOrder(orderId)
      const custodyAttempt = custody ? this.getAttempt(custody.attemptId) : null
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
      for (const step of custody?.terminalSteps ?? []) this.appendStep(step)
      if (attempt && !attempt.finishedAt) {
        this.finishAttempt(attempt.id, attempt.leaseGeneration, {
          finishedAt: cancelledAt,
          outcome: 'cancelled',
        })
      }
      const cancelled = this.transitionOrder(orderId, expectedState, 'cancelled', cancelledAt)
      if (activeTrain) {
        this.releaseTrain(activeTrain.id, cancelledAt, 'cancelled')
        for (const member of activeTrain.members) {
          if (member.orderId === orderId) continue
          const sibling = this.getOrder(member.orderId)
          const siblingAttempt = this.getAttempt(member.attemptId)
          if (!sibling || isTerminalShipOrderState(sibling.state)) continue
          if (siblingAttempt && !siblingAttempt.finishedAt) {
            this.finishAttempt(member.attemptId, member.generation, {
              finishedAt: cancelledAt,
              outcome: 'failed',
            })
          }
          if (sibling.state === 'preflight') {
            this.db
              .update(shipOrders)
              .set({ state: 'queued', stateChangedAt: cancelledAt, holdCode: null })
              .where(and(eq(shipOrders.id, sibling.id), eq(shipOrders.state, 'preflight')))
              .run()
          } else {
            const holdGeneration = { generation: this.highestHoldGeneration(sibling.id) }
            this.raiseHold({
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

  requestCancellation(input: {
    orderId: string
    expectedState: ShipOrderState
    attemptId: string
    generation: number
    planned: ShipStepValue
    running: ShipStepValue
  }): ShipStepValue {
    return this.transact(() => {
      if (
        !this.hasAttemptCustody({
          orderId: input.orderId,
          expectedState: input.expectedState,
          attemptId: input.attemptId,
          generation: input.generation,
        })
      ) {
        throw new Error(`ship order ${input.orderId} cancellation intent fence failed`)
      }
      const existing = this.latestStepForEffect(input.attemptId, input.planned.effectKey)
      if (existing) return existing
      this.appendStep(input.planned)
      return this.appendStep(input.running)
    })
  }

  hasCancellationIntent(attemptId: string, generation: number): boolean {
    const step = this.latestStepForEffect(attemptId, `cancel:${generation}`)
    return step?.state === 'planned' || step?.state === 'running'
  }

  appendStep(input: ShipStepValue): ShipStepValue {
    const step = ShipStep.parse(input)
    const attempt = this.getAttempt(step.attemptId)
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
    const existingRow = this.db
      .select(stepColumns)
      .from(shipSteps)
      .where(
        and(
          eq(shipSteps.attemptId, step.attemptId),
          eq(shipSteps.idempotencyKey, step.idempotencyKey),
        ),
      )
      .get()
    if (existingRow) {
      const existing = mapStep(existingRow)
      if (JSON.stringify(existing) === JSON.stringify(step)) return existing
      throw new Error(
        `ship step idempotency collision for ${step.attemptId}:${step.idempotencyKey}`,
      )
    }
    const previous = this.latestStepForEffect(step.attemptId, step.effectKey)
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
    this.db
      .insert(shipSteps)
      .values({
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
      .run()
    return this.stepById(step.id) as ShipStepValue
  }

  stepById(id: string): ShipStepValue | null {
    const row = this.db
      .select(stepColumns)
      .from(shipSteps)
      .where(eq(shipSteps.id, asShipStepId(id)))
      .get()
    return row ? mapStep(row) : null
  }

  stepsForAttempt(attemptId: string): ShipStepValue[] {
    return this.db
      .select(stepColumns)
      .from(shipSteps)
      .where(eq(shipSteps.attemptId, asShipAttemptId(attemptId)))
      .orderBy(asc(shipSteps.recordedAt), asc(shipSteps.id))
      .all()
      .map(mapStep)
  }

  latestStepForEffect(attemptId: string, effectKey: string): ShipStepValue | null {
    // A fixed test clock and fast production transitions can share one timestamp.
    // Lifecycle rank, not the textual step id, identifies the durable successor.
    const row = this.db
      .select(stepColumns)
      .from(shipSteps)
      .where(
        and(
          eq(shipSteps.attemptId, asShipAttemptId(attemptId)),
          eq(shipSteps.effectKey, effectKey),
        ),
      )
      // The lifecycle rank is an ordering DECISION, not a column, so it stays a
      // `sql` fragment inside the builder query — which spec rule 1 allows
      // anywhere. Its arms and their order are unchanged.
      .orderBy(
        sql`CASE ${shipSteps.state}
           WHEN 'planned' THEN 0
           WHEN 'running' THEN 1
           ELSE 2
         END DESC`,
        desc(shipSteps.recordedAt),
        desc(shipSteps.id),
      )
      .limit(1)
      .get()
    return row ? mapStep(row) : null
  }

  openHoldForOrder(orderId: string): ShipHoldValue | null {
    const row = this.db
      .select()
      .from(shipHolds)
      .where(and(eq(shipHolds.orderId, asShipOrderId(orderId)), isNull(shipHolds.resolvedAt)))
      .get()
    return row ? mapHold(row) : null
  }

  listHolds(): ShipHoldValue[] {
    return this.db
      .select()
      .from(shipHolds)
      .orderBy(asc(shipHolds.orderId), asc(shipHolds.generation))
      .all()
      .map(mapHold)
  }

  raiseHold(input: ShipHoldValue): ShipHoldValue {
    const hold = ShipHold.parse(input)
    if (hold.resolvedAt || hold.resolution) throw new Error(`new ship hold ${hold.id} is resolved`)
    return this.transact(() => {
      const order = this.getOrder(hold.orderId)
      if (!order) throw new Error(`unknown ship order ${hold.orderId}`)
      if (isTerminalShipOrderState(order.state)) {
        throw new Error(`terminal ship order ${order.id} cannot be held`)
      }
      if (!isLegalShipOrderTransition(order.state, 'held')) {
        throw new Error(`illegal ship order transition ${order.state} → held`)
      }
      const activeTrain = this.claimedTrainForOrder(order.id)
      const generationRow = { generation: this.highestHoldGeneration(hold.orderId) }
      const expected = generationRow.generation + 1
      if (hold.generation !== expected) {
        throw new Error(`ship hold ${hold.id} generation fence failed: expected ${expected}`)
      }
      this.db
        .insert(shipHolds)
        .values({
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
        .run()
      const orderChanged = this.db
        .update(shipOrders)
        .set({ state: 'held', holdCode: hold.reasonCode, stateChangedAt: hold.raisedAt })
        .where(
          and(
            eq(shipOrders.id, hold.orderId),
            notInArray(shipOrders.state, ['shipped', 'cancelled']),
          ),
        )
        .run()
      if (orderChanged.changes !== 1) {
        throw new Error(`ship order ${hold.orderId} hold fence failed`)
      }
      if (activeTrain) {
        this.releaseTrain(activeTrain.id, hold.raisedAt, `held:${hold.reasonCode}`)
        for (const member of activeTrain.members) {
          if (member.orderId === hold.orderId) continue
          const sibling = this.getOrder(member.orderId)
          const attempt = this.getAttempt(member.attemptId)
          if (!sibling || isTerminalShipOrderState(sibling.state)) continue
          if (attempt && !attempt.finishedAt) {
            this.finishAttempt(member.attemptId, member.generation, {
              finishedAt: hold.raisedAt,
              outcome: 'failed',
            })
          }
          if (sibling.state === 'preflight') {
            this.db
              .update(shipOrders)
              .set({ state: 'queued', stateChangedAt: hold.raisedAt, holdCode: null })
              .where(and(eq(shipOrders.id, sibling.id), eq(shipOrders.state, 'preflight')))
              .run()
            continue
          }
          const siblingGeneration = { generation: this.highestHoldGeneration(sibling.id) }
          this.raiseHold({
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
      return this.openHoldForOrder(hold.orderId) as ShipHoldValue
    })
  }

  resolveHold(
    orderId: string,
    expectedGeneration: number,
    resolution: ShipHoldAction,
    nextState: Extract<ShipOrderState, 'queued' | 'repairing' | 'cancelled'>,
    resolvedAt: string,
    repairCandidate?: StoredShippingRepairCandidate,
  ): ShipHoldValue {
    return this.transact(() => {
      const hold = this.openHoldForOrder(orderId)
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
      const attempt = this.latestAttemptForOrder(orderId)
      if (nextState === 'repairing') {
        if (!repairCandidate || !attempt || attempt.finishedAt) {
          throw new Error(`ship hold ${hold.id} cannot open repair without a live candidate`)
        }
        this.recordRepairCandidate(repairCandidate)
      } else if (attempt && !attempt.finishedAt) {
        this.finishAttempt(attempt.id, attempt.leaseGeneration, {
          finishedAt: resolvedAt,
          outcome: nextState === 'cancelled' ? 'cancelled' : 'failed',
        })
      }
      const changed = this.db
        .update(shipHolds)
        .set({ resolvedAt, resolution })
        .where(
          and(
            eq(shipHolds.orderId, asShipOrderId(orderId)),
            eq(shipHolds.generation, expectedGeneration),
            isNull(shipHolds.resolvedAt),
          ),
        )
        .run()
      if (changed.changes !== 1) {
        throw new Error(
          `ship hold ${orderId} generation fence failed: expected ${expectedGeneration}`,
        )
      }
      const orderChanged = this.db
        .update(shipOrders)
        .set({ state: nextState, holdCode: null, stateChangedAt: resolvedAt })
        .where(and(eq(shipOrders.id, asShipOrderId(orderId)), eq(shipOrders.state, 'held')))
        .run()
      if (orderChanged.changes !== 1) throw new Error(`ship order ${orderId} is not held`)
      const row = this.db
        .select()
        .from(shipHolds)
        .where(
          and(
            eq(shipHolds.orderId, asShipOrderId(orderId)),
            eq(shipHolds.generation, expectedGeneration),
          ),
        )
        .get()
      // The row is guaranteed by the fenced update above; the raw form asserted
      // it with a bare `as SqlRow` and would have thrown inside the mapper.
      if (!row) throw new Error(`ship hold ${orderId}@${expectedGeneration} vanished mid-span`)
      return mapHold(row)
    })
  }

  receiptForOrder(orderId: string): DeliveryReceiptValue | null {
    const row = this.db
      .select()
      .from(deliveryReceipts)
      .where(eq(deliveryReceipts.orderId, asShipOrderId(orderId)))
      .get()
    return row ? mapReceipt(row) : null
  }

  listReceipts(): DeliveryReceiptValue[] {
    return this.db
      .select()
      .from(deliveryReceipts)
      .orderBy(asc(deliveryReceipts.completedAt), asc(deliveryReceipts.id))
      .all()
      .map(mapReceipt)
  }

  recordEffectEnvelope(input: { request: unknown; result: unknown; recordedAt: string }): string {
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
    const stored = this.trainManifestForAttempt(request.attemptId)
    if (!stored || serializeShipTrainManifest(stored) !== serializeShipTrainManifest(manifest)) {
      throw new Error(`shipping effect ${request.jobId} has no matching durable manifest`)
    }
    const effectKey = `${request.jobId}:${request.requestDigest}`
    const requestJson = JSON.stringify(request)
    const resultJson = JSON.stringify(result)
    return this.transact(() => {
      const existing = this.db
        .select({
          requestJson: shipEffectEnvelopes.requestJson,
          resultJson: shipEffectEnvelopes.resultJson,
          recordedAt: shipEffectEnvelopes.recordedAt,
        })
        .from(shipEffectEnvelopes)
        .where(eq(shipEffectEnvelopes.effectKey, effectKey))
        .get()
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
      this.db
        .insert(shipEffectEnvelopes)
        .values({
          effectKey,
          trainId: manifest.id,
          attemptId: request.attemptId,
          requestDigest: request.requestDigest,
          requestJson,
          resultJson,
          recordedAt: input.recordedAt,
        })
        .run()
      return effectKey
    })
  }

  /** Settle an earlier immutable train prefix from a later order's exact
   * destination proof. The covering order must durably depend on this member;
   * this is the only path which may cross queued → shipped without fabricating
   * a per-member executor attempt. */
  completeCoveredOrder(
    input: DeliveryReceiptValue,
    coveringOrderId: ShipOrderValue['id'],
    effectEnvelopeKey: string,
  ): DeliveryReceiptValue {
    const receipt = DeliveryReceipt.parse(input)
    return this.transact(() => {
      const order = this.getOrder(receipt.orderId)
      const covering = this.getOrder(coveringOrderId)
      const coveringReceipt = this.receiptForOrder(coveringOrderId)
      const envelope = this.db
        .select({
          requestJson: shipEffectEnvelopes.requestJson,
          resultJson: shipEffectEnvelopes.resultJson,
        })
        .from(shipEffectEnvelopes)
        .where(eq(shipEffectEnvelopes.effectKey, effectEnvelopeKey))
        .get()
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
      const manifestAuthority = this.db
        .select({
          releasedAt: shipTrainManifests.releasedAt,
          claimCount: activeClaimCount,
        })
        .from(shipTrainManifests)
        .where(eq(shipTrainManifests.id, manifest.id))
        .get()
      if (!order || !covering || !coveringReceipt || covering.state !== 'shipped') {
        throw new Error(`covered delivery receipt ${receipt.id} has no shipped covering order`)
      }
      const existing = this.receiptForOrder(order.id)
      if (order.state === 'shipped' && existing) {
        if (JSON.stringify(existing) === JSON.stringify(receipt)) return existing
        throw new Error(`ship order ${order.id} already has different immutable receipt`)
      }
      if (order.state !== 'preflight') {
        throw new Error(`covered ship order ${order.id} is ${order.state}, not preflight`)
      }
      const member = manifest?.members.find((candidate) => candidate.orderId === order.id)
      const memberAttempt = member ? this.getAttempt(member.attemptId) : null
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
        this.latestAttemptForOrder(member.orderId)?.id !== member.attemptId ||
        this.hasCancellationIntent(member.attemptId, member.generation) ||
        this.openHoldForOrder(member.orderId) !== null ||
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
      this.finishAttempt(memberAttempt.id, memberAttempt.leaseGeneration, {
        finishedAt: receipt.completedAt,
        outcome: 'succeeded',
        testedIntegrationSha: receipt.testedIntegrationSha,
        landedRefSha: receipt.landedRefSha,
        destinationSha: receipt.destinationSha,
        validationProfileId: receipt.validationProfileId,
        validationResult: 'passed',
      })
      this.insertDeliveryReceipt(receipt)
      const changed = this.db
        .update(shipOrders)
        .set({ state: 'shipped', stateChangedAt: receipt.completedAt, holdCode: null })
        .where(and(eq(shipOrders.id, receipt.orderId), eq(shipOrders.state, 'preflight')))
        .run()
      if (changed.changes !== 1) throw new Error(`ship order ${order.id} coverage fence failed`)
      return this.receiptForOrder(order.id) as DeliveryReceiptValue
    })
  }

  completeVerifiedTrain(input: {
    leader: Parameters<ShippingRepository['commitEffectResult']>[0]
    covered: {
      receipt: DeliveryReceiptValue
      coveringOrderId: ShipOrderValue['id']
      effectEnvelopeKey: string
    }[]
    invalidations?: ShipHoldValue[]
    release?: { trainId: ShipTrainManifestValue['id']; releasedAt: string; reason: string }
  }): ShipOrderValue {
    return this.transact(() => {
      const leader = this.commitEffectResult(input.leader)
      for (const covered of input.covered) {
        this.completeCoveredOrder(
          covered.receipt,
          covered.coveringOrderId,
          covered.effectEnvelopeKey,
        )
      }
      if (input.release) {
        this.releaseTrain(input.release.trainId, input.release.releasedAt, input.release.reason)
      }
      for (const hold of input.invalidations ?? []) this.raiseHold(hold)
      return leader
    })
  }

  /** Insert the order's one immutable receipt and cross the verifying→shipped
   * boundary atomically. Proof must match both the frozen approval and one
   * finished attempt's tested/landed/destination facts. */
  completeVerifiedOrder(input: DeliveryReceiptValue): DeliveryReceiptValue {
    const receipt = DeliveryReceipt.parse(input)
    return this.transact(() => {
      const order = this.getOrder(receipt.orderId)
      if (!order) throw new Error(`unknown ship order ${receipt.orderId}`)
      const existing = this.receiptForOrder(receipt.orderId)
      if (order.state === 'shipped' && existing) {
        if (JSON.stringify(existing) === JSON.stringify(receipt)) return existing
        throw new Error(`ship order ${order.id} already has different immutable receipt`)
      }
      if (order.state !== 'verifying') {
        throw new Error(`ship order ${order.id} is ${order.state}, not verifying`)
      }
      if (existing) throw new Error(`ship order ${order.id} already has a receipt`)
      const trainReceiptProof = this.db
        .select({
          requestJson: shipEffectEnvelopes.requestJson,
          resultJson: shipEffectEnvelopes.resultJson,
        })
        .from(shipEffectEnvelopes)
        .where(
          eq(
            shipEffectEnvelopes.attemptId,
            // The empty-string fallback is preserved: it matches no attempt
            // and the raw statement relied on that rather than short-circuiting.
            this.latestAttemptForOrder(order.id)?.id ?? asShipAttemptId(''),
          ),
        )
        .orderBy(desc(shipEffectEnvelopes.recordedAt))
        .all()
        .some((envelope) => {
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
      const proof = this.db
        .select({ id: shipAttempts.id })
        .from(shipAttempts)
        .where(
          and(
            eq(shipAttempts.orderId, order.id),
            sql`${shipAttempts.finishedAt} IS NOT NULL`,
            eq(shipAttempts.outcome, 'succeeded'),
            eq(shipAttempts.approvedHeadSha, receipt.approvedHeadSha),
            eq(shipAttempts.testedIntegrationSha, receipt.testedIntegrationSha),
            eq(shipAttempts.landedRefSha, receipt.landedRefSha),
            eq(shipAttempts.destinationSha, receipt.destinationSha),
            eq(shipAttempts.validationProfileId, receipt.validationProfileId),
            eq(shipAttempts.validationResult, 'passed'),
          ),
        )
        .limit(1)
        .get()
      if (!proof) {
        throw new Error(`delivery receipt ${receipt.id} has no matching successful proof`)
      }
      this.insertDeliveryReceipt(receipt)
      const changed = this.db
        .update(shipOrders)
        .set({ state: 'shipped', stateChangedAt: receipt.completedAt, holdCode: null })
        .where(and(eq(shipOrders.id, receipt.orderId), eq(shipOrders.state, 'verifying')))
        .run()
      if (changed.changes !== 1) throw new Error(`ship order ${order.id} verification fence failed`)
      return this.receiptForOrder(receipt.orderId) as DeliveryReceiptValue
    })
  }
}
