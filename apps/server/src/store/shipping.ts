import {
  type ActorKind,
  actorColumns,
  actorFromColumns,
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
} from '@podium/model'
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'

type SqlRow = Record<string, unknown>

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
        if (
          active.approvedBaseSha === candidate.approvedBaseSha &&
          active.approvedHeadSha === candidate.approvedHeadSha
        ) {
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

  /** Acquire the next durable lease generation and queued→preflight custody in
   * one compare-and-swap transaction. A restarted server resumes the existing
   * attempt; only an explicitly re-queued order can mint a later generation. */
  beginAttempt(input: {
    orderId: string
    machineId: ShipAttemptValue['machineId']
    startedAt: string
  }): { order: ShipOrderValue; attempt: ShipAttemptValue } {
    return transaction(this.db, () => {
      const order = this.getOrder(input.orderId)
      if (!order) throw new Error(`unknown ship order ${input.orderId}`)
      if (order.state !== 'queued') {
        throw new Error(`ship order ${order.id} lease fence failed: expected queued`)
      }
      const latest = this.latestAttemptForOrder(order.id)
      const generation = (latest?.leaseGeneration ?? 0) + 1
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
      const next = this.transitionOrder(order.id, 'queued', 'preflight', input.startedAt)
      return { order: next, attempt }
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
    if (attempt.finishedAt) {
      const identical =
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
  ): ShipOrderValue {
    return transaction(this.db, () => {
      const order = this.getOrder(orderId)
      if (!order || order.state !== expectedState) {
        throw new Error(
          `ship order ${orderId} cancellation fence failed: expected ${expectedState}`,
        )
      }
      const attempt = this.latestAttemptForOrder(orderId)
      if (attempt && !attempt.finishedAt) {
        this.finishAttempt(attempt.id, attempt.leaseGeneration, {
          finishedAt: cancelledAt,
          outcome: 'cancelled',
        })
      }
      return this.transitionOrder(orderId, expectedState, 'cancelled', cancelledAt)
    })
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
    const row = this.db
      .prepare(
        `${stepSelect} WHERE attempt_id = ? AND effect_key = ?
         ORDER BY recorded_at DESC, id DESC LIMIT 1`,
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
