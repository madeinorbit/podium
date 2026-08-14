import { createHash } from 'node:crypto'
import {
  asShipTrainId,
  asShipTrainSubsetId,
  type ActorKind,
  actorColumns,
  actorFromColumns,
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
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'

type SqlRow = Record<string, unknown>
const TRAIN_MANIFEST_PREFIX = 'shipping-train:v1:'

export interface CoveredTrainMemberProof {
  issueId: ShipTrainManifestValue['members'][number]['issueId']
  orderId: ShipTrainManifestValue['members'][number]['orderId']
  attemptId: ShipTrainManifestValue['members'][number]['attemptId']
  generation: number
  sourceApprovedSha: string
  resultCommitSha: string
  testedIntegrationSha: string
  landedRefSha: string
  providerLandedRefSha: string
  destinationSha: string
}

const frozenOrderFacts = (order: ShipOrderValue) => ({
  issueId: order.issueId,
  descendantManifest: order.descendantManifest,
  repoId: order.repoId,
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

function mapIntegrationReceipt(row: SqlRow): RootIntegrationReceiptValue {
  return canonicalIntegrationReceipt(
    RootIntegrationReceipt.parse({
      rootIssueId: row.rootIssueId,
      approvedHeadSha: row.approvedHeadSha,
      descendants: jsonArray(row.descendants),
    }),
  )
}

function mapOrder(row: SqlRow): ShipOrderValue {
  const actor = actorFromColumns(
    row.requestedByActorKind as ActorKind,
    String(row.requestedByActorId),
  )
  const providerRef = jsonObject(row.providerRef)
  const currentIntegrationReceipt = jsonObject(row.currentIntegrationReceipt)
  return ShipOrder.parse({
    id: row.id,
    issueId: row.issueId,
    repoId: row.repoId,
    targetBranch: row.targetBranch,
    destination: row.destination,
    approvedBaseSha: row.approvedBaseSha,
    approvedHeadSha: row.approvedHeadSha,
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
    closeMode: row.closeMode,
    state: row.state,
    stateChangedAt: row.stateChangedAt,
    ...(optionalString(row.holdCode) ? { holdCode: row.holdCode } : {}),
  })
}

function mapAttempt(row: SqlRow): ShipAttemptValue {
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

function mapStep(row: SqlRow): ShipStepValue {
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

function mapHold(row: SqlRow): ShipHoldValue {
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

function mapReceipt(row: SqlRow): DeliveryReceiptValue {
  return DeliveryReceipt.parse({
    id: row.id,
    orderId: row.orderId,
    approvedBaseSha: row.approvedBaseSha,
    approvedHeadSha: row.approvedHeadSha,
    testedIntegrationSha: row.testedIntegrationSha,
    landedRefSha: row.landedRefSha,
    destinationSha: row.destinationSha,
    validationProfileId: row.validationProfileId,
    validationResult: row.validationResult,
    destination: row.destination,
    completedAt: row.completedAt,
  })
}

const orderSelect = `SELECT id, issue_id AS issueId, repo_id AS repoId,
  target_branch AS targetBranch, destination, approved_base_sha AS approvedBaseSha,
  approved_head_sha AS approvedHeadSha, descendant_manifest AS descendantManifest,
  delivery_depends_on AS deliveryDependsOn,
  evidence_manifest_ref AS evidenceManifestRef,
  current_integration_receipt AS currentIntegrationReceipt,
  provider_ref AS providerRef,
  requested_by_actor_kind AS requestedByActorKind,
  requested_by_actor_id AS requestedByActorId,
  requested_by_on_behalf_of AS requestedByOnBehalfOf, requested_at AS requestedAt,
  policy_id AS policyId, close_mode AS closeMode, state,
  state_changed_at AS stateChangedAt, hold_code AS holdCode FROM ship_orders`

const attemptSelect = `SELECT id, order_id AS orderId,
  expected_source_base_sha AS expectedSourceBaseSha, approved_head_sha AS approvedHeadSha,
  expected_target_sha AS expectedTargetSha, machine_id AS machineId,
  lease_generation AS leaseGeneration, started_at AS startedAt, finished_at AS finishedAt,
  outcome, submitted_head_sha AS submittedHeadSha,
  tested_integration_sha AS testedIntegrationSha, landed_ref_sha AS landedRefSha,
  destination_sha AS destinationSha, validation_profile_id AS validationProfileId,
  validation_result AS validationResult FROM ship_attempts`

const stepSelect = `SELECT id, order_id AS orderId, attempt_id AS attemptId,
  effect_key AS effectKey, idempotency_key AS idempotencyKey, generation,
  input_fence AS inputFence, kind, state, outcome, summary, artifact_ref AS artifactRef,
  recorded_at AS recordedAt, started_at AS startedAt, finished_at AS finishedAt
  FROM ship_steps`

const holdSelect = `SELECT id, order_id AS orderId, generation, reason_code AS reasonCode,
  headline, detail, evidence_refs AS evidenceRefs, actions, raised_at AS raisedAt,
  resolved_at AS resolvedAt, resolution FROM ship_holds`

const receiptSelect = `SELECT id, order_id AS orderId,
  approved_base_sha AS approvedBaseSha, approved_head_sha AS approvedHeadSha,
  tested_integration_sha AS testedIntegrationSha, landed_ref_sha AS landedRefSha,
  destination_sha AS destinationSha, validation_profile_id AS validationProfileId,
  validation_result AS validationResult, destination, completed_at AS completedAt
  FROM delivery_receipts`

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
  constructor(private readonly db: SqlDatabase) {}

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
      .prepare(
        `SELECT root_issue_id AS rootIssueId, approved_head_sha AS approvedHeadSha,
                descendants
           FROM root_integration_receipts
          WHERE root_issue_id = ? AND approved_head_sha = ?`,
      )
      .get(rootIssueId, approvedHeadSha) as SqlRow | undefined
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
      .prepare(
        `INSERT INTO root_integration_receipts
          (root_issue_id, approved_head_sha, descendants)
         VALUES (?, ?, ?)`,
      )
      .run(receipt.rootIssueId, receipt.approvedHeadSha, JSON.stringify(receipt.descendants))
    const stored = this.rootIntegrationReceipt(receipt.rootIssueId, receipt.approvedHeadSha)
    if (!stored) throw new Error('root integration receipt insert did not persist')
    return stored
  }

  getOrder(id: string): ShipOrderValue | null {
    const row = this.db.prepare(`${orderSelect} WHERE id = ?`).get(id) as SqlRow | undefined
    return row ? mapOrder(row) : null
  }

  activeOrderForIssue(issueId: string): ShipOrderValue | null {
    const row = this.db
      .prepare(`${orderSelect} WHERE issue_id = ? AND state NOT IN ('shipped', 'cancelled')`)
      .get(issueId) as SqlRow | undefined
    return row ? mapOrder(row) : null
  }

  listOrders(): ShipOrderValue[] {
    return (this.db.prepare(`${orderSelect} ORDER BY requested_at, id`).all() as SqlRow[]).map(
      mapOrder,
    )
  }

  issueIdForOrder(id: string): string | null {
    const row = this.db
      .prepare('SELECT issue_id AS issueId FROM ship_orders WHERE id = ?')
      .get(id) as { issueId: string } | undefined
    return row?.issueId ?? null
  }

  issueIdsForOrders(ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>()
    const unique = [...new Set(ids)]
    const chunkSize = 500
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize)
      const rows = this.db
        .prepare(
          `SELECT id, issue_id AS issueId FROM ship_orders
           WHERE id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as { id: string; issueId: string }[]
      for (const row of rows) out.set(row.id, row.issueId)
    }
    return out
  }

  createOrder(input: ShipOrderValue): ShipOrderValue {
    const order = ShipOrder.parse(input)
    if (order.state !== 'queued') {
      throw new Error(`ship order ${order.id} must be created queued`)
    }
    return transaction(this.db, () => {
      const existing = this.getOrder(order.id)
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(order)) return existing
        throw new Error(`ship order id ${order.id} already exists with different content`)
      }
      const active = this.activeOrderForIssue(order.issueId)
      if (active) {
        throw new Error(`issue ${order.issueId} already has active ship order ${active.id}`)
      }
      const actor = actorColumns(order.requestedBy.actor)
      this.db
        .prepare(
          `INSERT INTO ship_orders
            (id, issue_id, repo_id, target_branch, destination, approved_base_sha,
             approved_head_sha, descendant_manifest, delivery_depends_on,
             evidence_manifest_ref, current_integration_receipt, provider_ref,
             requested_by_actor_kind, requested_by_actor_id, requested_by_on_behalf_of,
             requested_at, policy_id, close_mode, state, state_changed_at, hold_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          order.id,
          order.issueId,
          order.repoId,
          order.targetBranch,
          order.destination,
          order.approvedBaseSha,
          order.approvedHeadSha,
          JSON.stringify(order.descendantManifest),
          JSON.stringify(order.deliveryDependsOn),
          order.evidenceManifestRef ?? null,
          order.currentIntegrationReceipt ? JSON.stringify(order.currentIntegrationReceipt) : null,
          order.providerRef ? JSON.stringify(order.providerRef) : null,
          actor.kind,
          actor.id,
          order.requestedBy.onBehalfOf,
          order.requestedAt,
          order.policyId,
          order.closeMode,
          order.state,
          order.stateChangedAt,
          order.holdCode ?? null,
        )
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
    return transaction(this.db, () => {
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
      .prepare(
        `UPDATE ship_orders SET state = ?, state_changed_at = ?, hold_code = NULL
         WHERE id = ? AND state = ? AND state NOT IN ('shipped', 'cancelled')`,
      )
      .run(nextState, stateChangedAt, id, expectedState)
    if (result.changes !== 1) {
      throw new Error(`ship order ${id} state fence failed: expected ${expectedState}`)
    }
    return this.getOrder(id) as ShipOrderValue
  }

  getAttempt(id: string): ShipAttemptValue | null {
    const row = this.db.prepare(`${attemptSelect} WHERE id = ?`).get(id) as SqlRow | undefined
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
      .prepare(
        `INSERT INTO ship_attempts
          (id, order_id, expected_source_base_sha, approved_head_sha, expected_target_sha,
           machine_id, lease_generation, started_at, submitted_head_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.orderId,
        attempt.expectedSourceBaseSha,
        attempt.approvedHeadSha,
        attempt.expectedTargetSha,
        attempt.machineId,
        attempt.leaseGeneration,
        attempt.startedAt,
        attempt.submittedHeadSha,
      )
    return this.getAttempt(attempt.id) as ShipAttemptValue
  }

  latestAttemptForOrder(orderId: string): ShipAttemptValue | null {
    const row = this.db
      .prepare(`${attemptSelect} WHERE order_id = ? ORDER BY lease_generation DESC LIMIT 1`)
      .get(orderId) as SqlRow | undefined
    return row ? mapAttempt(row) : null
  }

  listAttempts(): ShipAttemptValue[] {
    return (this.db.prepare(`${attemptSelect} ORDER BY started_at, id`).all() as SqlRow[]).map(
      mapAttempt,
    )
  }

  claimTrain(input: {
    leaderOrderId: ShipOrderValue['id']
    startedAt: string
    members: { orderId: ShipOrderValue['id'] }[]
    validationProfile: ShipTrainValidationProfile
  }): {
    manifest: ShipTrainManifestValue
    claimed: { order: ShipOrderValue; attempt: ShipAttemptValue }[]
  } {
    return transaction(this.db, () => {
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
      const sameLane = (order: ShipOrderValue): boolean =>
        order.state === 'queued' &&
        order.repoId === leaderOrder.repoId &&
        order.targetBranch === leaderOrder.targetBranch &&
        order.approvedBaseSha === leaderOrder.approvedBaseSha &&
        canonicalShippingDestination(order.destination, order.targetBranch) === laneDestination &&
        JSON.stringify(order.providerRef ?? null) === providerKey &&
        order.policyId === leaderOrder.policyId &&
        order.closeMode === leaderOrder.closeMode &&
        JSON.stringify(order.requestedBy) === attributionKey
      if (selected.some((order) => !sameLane(order))) {
        throw new Error('ship train members cross an immutable delivery lane')
      }
      const issueFacts = new Map(
        selected.map((order) => {
          const row = this.db
            .prepare(
              'SELECT branch, machine_id AS machineId, repo_path AS repoPath FROM issues WHERE id = ?',
            )
            .get(order.issueId) as
            | { branch?: string; machineId?: string; repoPath?: string }
            | undefined
          if (!row?.branch || !row.machineId || !row.repoPath) {
            throw new Error(`ship train issue ${order.issueId} has no durable branch custody`)
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
      const stackEdges = this.db
        .prepare(
          `SELECT upper_order_id AS upperOrderId, lower_order_id AS lowerOrderId
             FROM ship_order_stack_edges`,
        )
        .all() as { upperOrderId: ShipOrderValue['id']; lowerOrderId: ShipOrderValue['id'] }[]
      const stackLower = new Map<ShipOrderValue['id'], ShipOrderValue['id'][]>()
      for (const edge of stackEdges) {
        const lower = stackLower.get(edge.upperOrderId) ?? []
        lower.push(edge.lowerOrderId)
        stackLower.set(edge.upperOrderId, lower)
      }
      const dependencies = (order: ShipOrderValue): ShipOrderValue['deliveryDependsOn'] =>
        [
          ...new Set([
            ...order.deliveryDependsOn,
            ...(stackLower.get(order.id) ?? []),
          ]),
        ].sort()
      const laneOrders = this.listOrders().filter(sameLane)
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
      const profile = ShipTrainValidationProfile.parse({
        ...input.validationProfile,
        resourceLocks: [...input.validationProfile.resourceLocks].sort(),
      })
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
            ...new Set([
              ...dependencies(order),
              ...(index > 0 ? [prefix[index - 1]!.id] : []),
            ]),
          ].sort(),
        }
      })
      const validationProfileDigest = createHash('sha256')
        .update(JSON.stringify(profile))
        .digest('hex')
      const lane = {
        repoId: leaderOrder.repoId,
        repoPath: issueFacts.get(leaderOrder.id)!.repoPath,
        machineId,
        targetBranch: leaderOrder.targetBranch,
        expectedTargetSha: leaderOrder.approvedBaseSha,
        destination: laneDestination,
        ...(leaderOrder.providerRef ? { providerRef: leaderOrder.providerRef } : {}),
        policyId: leaderOrder.policyId,
        validationProfile: profile,
        validationProfileDigest,
      }
      const identity = JSON.stringify({ version: 1, repairRound: 0, lane, members })
      const id = asShipTrainId(`train:${createHash('sha256').update(identity).digest('hex')}`)
      const subsetId = asShipTrainSubsetId(
        `subset:${createHash('sha256')
          .update(
            JSON.stringify({
              trainId: id,
              repairRound: 0,
              orderIds: members.map((member) => member.orderId),
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
        leaderOrderId: input.leaderOrderId,
        members,
      })
      const leader = byOrder.get(input.leaderOrderId)
      if (!leader) throw new Error(`ship train ${manifest.id} has no claimed leader`)
      const canonicalJson = serializeShipTrainManifest(manifest)
      const canonicalDigest = createHash('sha256').update(canonicalJson).digest('hex')
      this.db
        .prepare(
          `INSERT INTO ship_train_manifests
            (id, version, subset_id, repair_round, canonical_digest, canonical_json,
             repo_id, repo_path, machine_id, target_branch, expected_target_sha,
             destination, provider_ref, policy_id, validation_profile,
             validation_profile_digest, leader_order_id, leader_attempt_id,
             leader_generation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          manifest.id,
          manifest.version,
          manifest.subsetId,
          manifest.repairRound,
          canonicalDigest,
          canonicalJson,
          manifest.lane.repoId,
          manifest.lane.repoPath,
          manifest.lane.machineId,
          manifest.lane.targetBranch,
          manifest.lane.expectedTargetSha,
          manifest.lane.destination,
          manifest.lane.providerRef ? JSON.stringify(manifest.lane.providerRef) : null,
          manifest.lane.policyId,
          JSON.stringify(manifest.lane.validationProfile),
          manifest.lane.validationProfileDigest,
          manifest.leaderOrderId,
          leader.attempt.id,
          leader.attempt.leaseGeneration,
          input.startedAt,
        )
      for (const [ordinal, member] of manifest.members.entries()) {
        this.db
          .prepare(
            `INSERT INTO ship_train_members
              (train_id, ordinal, issue_id, order_id, attempt_id, generation, machine_id,
               source_branch, approved_base_sha, approved_head_sha, delivery_depends_on)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            manifest.id,
            ordinal,
            member.issueId,
            member.orderId,
            member.attemptId,
            member.generation,
            member.machineId,
            member.sourceBranch,
            member.approvedBaseSha,
            member.approvedHeadSha,
            JSON.stringify(member.deliveryDependsOn),
          )
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
    const row = this.db
      .prepare(
        `SELECT m.id, m.canonical_json AS canonicalJson, m.canonical_digest AS canonicalDigest,
                m.repo_id AS repoId, m.repo_path AS repoPath, m.machine_id AS machineId,
                m.target_branch AS targetBranch,
                m.expected_target_sha AS expectedTargetSha, m.destination,
                m.provider_ref AS providerRef, m.policy_id AS policyId,
                m.validation_profile AS validationProfile,
                m.validation_profile_digest AS validationProfileDigest,
                m.leader_order_id AS leaderOrderId,
                m.leader_attempt_id AS leaderAttemptId, m.leader_generation AS leaderGeneration
           FROM ship_train_manifests m
           JOIN ship_train_members tm ON tm.train_id = m.id
          WHERE tm.attempt_id = ?`,
      )
      .get(attemptId) as SqlRow | undefined
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
      manifest.lane.targetBranch !== row.targetBranch ||
      manifest.lane.expectedTargetSha !== row.expectedTargetSha ||
      manifest.lane.destination !== row.destination ||
      JSON.stringify(manifest.lane.providerRef ?? null) !== String(row.providerRef ?? 'null') ||
      manifest.lane.policyId !== row.policyId ||
      JSON.stringify(manifest.lane.validationProfile) !== row.validationProfile ||
      manifest.lane.validationProfileDigest !== row.validationProfileDigest ||
      manifest.leaderOrderId !== row.leaderOrderId ||
      manifest.members.at(-1)?.attemptId !== row.leaderAttemptId ||
      manifest.members.at(-1)?.generation !== row.leaderGeneration
    ) {
      throw new Error(`ship train manifest ${manifest.id} normalized authority mismatch`)
    }
    const normalizedMembers = this.db
      .prepare(
        `SELECT ordinal, issue_id AS issueId, order_id AS orderId, attempt_id AS attemptId,
                generation, machine_id AS machineId, source_branch AS sourceBranch,
                approved_base_sha AS approvedBaseSha, approved_head_sha AS approvedHeadSha,
                delivery_depends_on AS deliveryDependsOn
           FROM ship_train_members WHERE train_id = ? ORDER BY ordinal`,
      )
      .all(manifest.id) as SqlRow[]
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
      .prepare(
        `SELECT tm.attempt_id AS attemptId
           FROM ship_train_members tm
           JOIN ship_train_manifests m ON m.id = tm.train_id
          WHERE tm.order_id = ? AND tm.released_at IS NULL AND m.released_at IS NULL`,
      )
      .get(orderId) as { attemptId: ShipAttemptValue['id'] } | undefined
    if (!row) return null
    return this.trainManifestForAttempt(row.attemptId)
  }

  activeTrainForOrder(orderId: ShipOrderValue['id']): ShipTrainManifestValue | null {
    const manifest = this.claimedTrainForOrder(orderId)
    if (!manifest) return null
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
        attempt.machineId !== member.machineId ||
        this.hasCancellationIntent(member.attemptId, member.generation)
      ) {
        return null
      }
    }
    return manifest
  }

  releaseTrain(trainId: ShipTrainManifestValue['id'], releasedAt: string, reason: string): void {
    transaction(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT released_at AS releasedAt, release_reason AS releaseReason
             FROM ship_train_manifests WHERE id = ?`,
        )
        .get(trainId) as { releasedAt?: string; releaseReason?: string } | undefined
      if (!row) throw new Error(`unknown ship train ${trainId}`)
      if (row.releasedAt) {
        if (row.releasedAt === releasedAt && row.releaseReason === reason) return
        throw new Error(`ship train ${trainId} was already released differently`)
      }
      this.db
        .prepare(
          `UPDATE ship_train_members SET released_at = ?
            WHERE train_id = ? AND released_at IS NULL`,
        )
        .run(releasedAt, trainId)
      const changed = this.db
        .prepare(
          `UPDATE ship_train_manifests SET released_at = ?, release_reason = ?
            WHERE id = ? AND released_at IS NULL`,
        )
        .run(releasedAt, reason, trainId)
      if (changed.changes !== 1) throw new Error(`ship train ${trainId} release fence failed`)
    })
  }

  recordNativeStackEdge(input: {
    upperOrderId: ShipOrderValue['id']
    lowerOrderId: ShipOrderValue['id']
    recordedAt: string
  }): void {
    transaction(this.db, () => {
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
      const existing = this.db
        .prepare(
          `SELECT lower_order_id AS lowerOrderId,
                  upper_approved_head_sha AS upperApprovedHeadSha,
                  lower_approved_head_sha AS lowerApprovedHeadSha
             FROM ship_order_stack_edges WHERE upper_order_id = ? AND lower_order_id = ?`,
        )
        .get(upper.id, lower.id) as SqlRow | undefined
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
        .prepare(
          `INSERT INTO ship_order_stack_edges
            (upper_order_id, lower_order_id, upper_approved_head_sha,
             lower_approved_head_sha, recorded_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(upper.id, lower.id, upper.approvedHeadSha, lower.approvedHeadSha, input.recordedAt)
    })
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
    return transaction(this.db, () => {
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
    transaction(this.db, () => {
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
    outcome:
      | {
          kind: 'transition'
          nextState: Exclude<ShipOrderState, 'held' | 'shipped'>
          stateChangedAt: string
        }
      | { kind: 'hold'; hold: ShipHoldValue; attemptFinishedAt: string }
      | {
          kind: 'verified'
          receipt: DeliveryReceiptValue
          attemptFinishedAt: string
        }
  }): ShipOrderValue {
    return transaction(this.db, () => {
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
        return this.transitionOrder(
          input.orderId,
          input.expectedState,
          input.outcome.nextState,
          input.outcome.stateChangedAt,
        )
      }
      if (input.outcome.kind === 'hold') {
        this.finishAttempt(input.attemptId, input.generation, {
          finishedAt: input.outcome.attemptFinishedAt,
          outcome: 'failed',
        })
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
    return transaction(this.db, () => {
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
    return transaction(this.db, () => {
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
      .prepare(
        `UPDATE ship_attempts SET finished_at = ?, outcome = ?, tested_integration_sha = ?,
           landed_ref_sha = ?, destination_sha = ?, validation_profile_id = ?,
           validation_result = ?
         WHERE id = ? AND lease_generation = ? AND finished_at IS NULL`,
      )
      .run(
        completed.finishedAt,
        completed.outcome,
        completed.testedIntegrationSha ?? null,
        completed.landedRefSha ?? null,
        completed.destinationSha ?? null,
        completed.validationProfileId ?? null,
        completed.validationResult ?? null,
        id,
        leaseGeneration,
      )
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
    return transaction(this.db, () => {
      const order = this.getOrder(orderId)
      if (!order || order.state !== expectedState) {
        throw new Error(
          `ship order ${orderId} cancellation fence failed: expected ${expectedState}`,
        )
      }
      const activeTrain = this.claimedTrainForOrder(order.id)
      const attempt = this.latestAttemptForOrder(orderId)
      if (
        custody &&
        (!attempt ||
          attempt.id !== custody.attemptId ||
          attempt.leaseGeneration !== custody.generation ||
          attempt.finishedAt !== undefined)
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
      if (activeTrain) this.releaseTrain(activeTrain.id, cancelledAt, 'cancelled')
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
    return transaction(this.db, () => {
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
      .prepare(`${stepSelect} WHERE attempt_id = ? AND idempotency_key = ?`)
      .get(step.attemptId, step.idempotencyKey) as SqlRow | undefined
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
      .prepare(
        `INSERT INTO ship_steps
          (id, order_id, attempt_id, effect_key, idempotency_key, generation,
           input_fence, kind, state, outcome, summary, artifact_ref, recorded_at,
           started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.id,
        step.orderId,
        step.attemptId,
        step.effectKey,
        step.idempotencyKey,
        step.generation,
        JSON.stringify(step.inputFence),
        step.kind,
        step.state,
        step.outcome ?? null,
        step.summary,
        step.artifactRef ?? null,
        step.recordedAt,
        step.startedAt ?? null,
        step.finishedAt ?? null,
      )
    return this.stepById(step.id) as ShipStepValue
  }

  stepById(id: string): ShipStepValue | null {
    const row = this.db.prepare(`${stepSelect} WHERE id = ?`).get(id) as SqlRow | undefined
    return row ? mapStep(row) : null
  }

  stepsForAttempt(attemptId: string): ShipStepValue[] {
    return (
      this.db
        .prepare(`${stepSelect} WHERE attempt_id = ? ORDER BY recorded_at, id`)
        .all(attemptId) as SqlRow[]
    ).map(mapStep)
  }

  latestStepForEffect(attemptId: string, effectKey: string): ShipStepValue | null {
    // A fixed test clock and fast production transitions can share one timestamp.
    // Lifecycle rank, not the textual step id, identifies the durable successor.
    const row = this.db
      .prepare(
        `${stepSelect} WHERE attempt_id = ? AND effect_key = ?
         ORDER BY CASE state
           WHEN 'planned' THEN 0
           WHEN 'running' THEN 1
           ELSE 2
         END DESC, recorded_at DESC, id DESC LIMIT 1`,
      )
      .get(attemptId, effectKey) as SqlRow | undefined
    return row ? mapStep(row) : null
  }

  openHoldForOrder(orderId: string): ShipHoldValue | null {
    const row = this.db
      .prepare(`${holdSelect} WHERE order_id = ? AND resolved_at IS NULL`)
      .get(orderId) as SqlRow | undefined
    return row ? mapHold(row) : null
  }

  listHolds(): ShipHoldValue[] {
    return (this.db.prepare(`${holdSelect} ORDER BY order_id, generation`).all() as SqlRow[]).map(
      mapHold,
    )
  }

  raiseHold(input: ShipHoldValue): ShipHoldValue {
    const hold = ShipHold.parse(input)
    if (hold.resolvedAt || hold.resolution) throw new Error(`new ship hold ${hold.id} is resolved`)
    return transaction(this.db, () => {
      const order = this.getOrder(hold.orderId)
      if (!order) throw new Error(`unknown ship order ${hold.orderId}`)
      if (isTerminalShipOrderState(order.state)) {
        throw new Error(`terminal ship order ${order.id} cannot be held`)
      }
      if (!isLegalShipOrderTransition(order.state, 'held')) {
        throw new Error(`illegal ship order transition ${order.state} → held`)
      }
      const activeTrain = this.activeTrainForOrder(order.id)
      const generationRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(generation), 0) AS generation FROM ship_holds WHERE order_id = ?',
        )
        .get(hold.orderId) as { generation: number }
      const expected = generationRow.generation + 1
      if (hold.generation !== expected) {
        throw new Error(`ship hold ${hold.id} generation fence failed: expected ${expected}`)
      }
      this.db
        .prepare(
          `INSERT INTO ship_holds
            (id, order_id, generation, reason_code, headline, detail, evidence_refs,
             actions, raised_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hold.id,
          hold.orderId,
          hold.generation,
          hold.reasonCode,
          hold.headline,
          hold.detail,
          JSON.stringify(hold.evidenceRefs),
          JSON.stringify(hold.actions),
          hold.raisedAt,
        )
      const orderChanged = this.db
        .prepare(
          `UPDATE ship_orders SET state = 'held', hold_code = ?, state_changed_at = ?
           WHERE id = ? AND state NOT IN ('shipped', 'cancelled')`,
        )
        .run(hold.reasonCode, hold.raisedAt, hold.orderId)
      if (orderChanged.changes !== 1) {
        throw new Error(`ship order ${hold.orderId} hold fence failed`)
      }
      if (activeTrain) {
        this.releaseTrain(activeTrain.id, hold.raisedAt, `held:${hold.reasonCode}`)
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
  ): ShipHoldValue {
    return transaction(this.db, () => {
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
      const changed = this.db
        .prepare(
          `UPDATE ship_holds SET resolved_at = ?, resolution = ?
           WHERE order_id = ? AND generation = ? AND resolved_at IS NULL`,
        )
        .run(resolvedAt, resolution, orderId, expectedGeneration)
      if (changed.changes !== 1) {
        throw new Error(
          `ship hold ${orderId} generation fence failed: expected ${expectedGeneration}`,
        )
      }
      const orderChanged = this.db
        .prepare(
          `UPDATE ship_orders SET state = ?, hold_code = NULL, state_changed_at = ?
           WHERE id = ? AND state = 'held'`,
        )
        .run(nextState, resolvedAt, orderId)
      if (orderChanged.changes !== 1) throw new Error(`ship order ${orderId} is not held`)
      const row = this.db
        .prepare(`${holdSelect} WHERE order_id = ? AND generation = ?`)
        .get(orderId, expectedGeneration) as SqlRow
      return mapHold(row)
    })
  }

  receiptForOrder(orderId: string): DeliveryReceiptValue | null {
    const row = this.db.prepare(`${receiptSelect} WHERE order_id = ?`).get(orderId) as
      | SqlRow
      | undefined
    return row ? mapReceipt(row) : null
  }

  listReceipts(): DeliveryReceiptValue[] {
    return (this.db.prepare(`${receiptSelect} ORDER BY completed_at, id`).all() as SqlRow[]).map(
      mapReceipt,
    )
  }

  /** Settle an earlier immutable train prefix from a later order's exact
   * destination proof. The covering order must durably depend on this member;
   * this is the only path which may cross queued → shipped without fabricating
   * a per-member executor attempt. */
  completeCoveredOrder(
    input: DeliveryReceiptValue,
    coveringOrderId: ShipOrderValue['id'],
    proof: CoveredTrainMemberProof,
  ): DeliveryReceiptValue {
    const receipt = DeliveryReceipt.parse(input)
    return transaction(this.db, () => {
      const order = this.getOrder(receipt.orderId)
      const covering = this.getOrder(coveringOrderId)
      const coveringReceipt = this.receiptForOrder(coveringOrderId)
      const coveringAttempt = this.latestAttemptForOrder(coveringOrderId)
      const manifest = coveringAttempt
        ? this.trainManifestForAttempt(coveringAttempt.id)
        : null
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
        manifest.leaderOrderId !== covering.id ||
        !member ||
        !memberAttempt ||
        memberAttempt.finishedAt ||
        memberAttempt.leaseGeneration !== member.generation ||
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
        receipt.landedRefSha !== proof.resultCommitSha ||
        receipt.testedIntegrationSha !== proof.testedIntegrationSha ||
        proof.testedIntegrationSha !== coveringReceipt.testedIntegrationSha ||
        proof.landedRefSha !== coveringReceipt.landedRefSha ||
        proof.providerLandedRefSha !== coveringReceipt.landedRefSha ||
        proof.destinationSha !== coveringReceipt.destinationSha ||
        receipt.testedIntegrationSha !== coveringReceipt.testedIntegrationSha ||
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
      this.db
        .prepare(
          `INSERT INTO delivery_receipts
            (id, order_id, approved_base_sha, approved_head_sha, tested_integration_sha,
             landed_ref_sha, destination_sha, validation_profile_id, validation_result,
             destination, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.id,
          receipt.orderId,
          receipt.approvedBaseSha,
          receipt.approvedHeadSha,
          receipt.testedIntegrationSha,
          receipt.landedRefSha,
          receipt.destinationSha,
          receipt.validationProfileId,
          receipt.validationResult,
          receipt.destination,
          receipt.completedAt,
        )
      const changed = this.db
        .prepare(
          `UPDATE ship_orders SET state = 'shipped', state_changed_at = ?, hold_code = NULL
           WHERE id = ? AND state = 'preflight'`,
        )
        .run(receipt.completedAt, receipt.orderId)
      if (changed.changes !== 1) throw new Error(`ship order ${order.id} coverage fence failed`)
      return this.receiptForOrder(order.id) as DeliveryReceiptValue
    })
  }

  /** Insert the order's one immutable receipt and cross the verifying→shipped
   * boundary atomically. Proof must match both the frozen approval and one
   * finished attempt's tested/landed/destination facts. */
  completeVerifiedOrder(input: DeliveryReceiptValue): DeliveryReceiptValue {
    const receipt = DeliveryReceipt.parse(input)
    return transaction(this.db, () => {
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
      if (
        receipt.approvedBaseSha !== order.approvedBaseSha ||
        receipt.approvedHeadSha !== order.approvedHeadSha ||
        receipt.destination !== order.destination
      ) {
        throw new Error(`delivery receipt ${receipt.id} does not match order ${order.id}`)
      }
      const proof = this.db
        .prepare(
          `SELECT id FROM ship_attempts
           WHERE order_id = ? AND finished_at IS NOT NULL AND outcome = 'succeeded'
             AND approved_head_sha = ?
             AND tested_integration_sha = ? AND landed_ref_sha = ? AND destination_sha = ?
             AND validation_profile_id = ? AND validation_result = 'passed'
           LIMIT 1`,
        )
        .get(
          order.id,
          receipt.approvedHeadSha,
          receipt.testedIntegrationSha,
          receipt.landedRefSha,
          receipt.destinationSha,
          receipt.validationProfileId,
        )
      if (!proof) {
        throw new Error(`delivery receipt ${receipt.id} has no matching successful proof`)
      }
      this.db
        .prepare(
          `INSERT INTO delivery_receipts
            (id, order_id, approved_base_sha, approved_head_sha, tested_integration_sha,
             landed_ref_sha, destination_sha, validation_profile_id, validation_result,
             destination, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.id,
          receipt.orderId,
          receipt.approvedBaseSha,
          receipt.approvedHeadSha,
          receipt.testedIntegrationSha,
          receipt.landedRefSha,
          receipt.destinationSha,
          receipt.validationProfileId,
          receipt.validationResult,
          receipt.destination,
          receipt.completedAt,
        )
      const changed = this.db
        .prepare(
          `UPDATE ship_orders SET state = 'shipped', state_changed_at = ?, hold_code = NULL
           WHERE id = ? AND state = 'verifying'`,
        )
        .run(receipt.completedAt, receipt.orderId)
      if (changed.changes !== 1) throw new Error(`ship order ${order.id} verification fence failed`)
      return this.receiptForOrder(receipt.orderId) as DeliveryReceiptValue
    })
  }
}
