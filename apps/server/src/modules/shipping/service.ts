import { createHash } from 'node:crypto'
import {
  type Attribution,
  asDeliveryReceiptId,
  asShipHoldId,
  asShipOrderId,
  asShipStepId,
  type DeliveryReceipt,
  type DescendantTip,
  type IssueId,
  type IssueWire,
  type MachineId,
  type ShipAttempt,
  type ShipHold,
  type ShipHoldAction,
  type ShipOrder,
  type ShipOrderId,
  type ShipOrderProjection,
  type ShipOrderState,
  type ShipStep,
} from '@podium/model'
import type { ShippingJobRequestMessage, ShippingJobResult } from '@podium/protocol'
import type { EntityChangeSpec } from '@podium/sync'
import type { CommandPrincipal } from '../../command-principal'
import type { ShippingRepository } from '../../store/shipping'
import type { ShippingIssueMutation } from '../issues/service/crud'
import type { ShippingPolicyResolver } from './policy'
import { shipOrderProjectionRow } from './projection'
import { shippingQueue } from './queue'

const LEASE_MS = 45_000
const SCHEDULER_INTERVAL_MS = 2_000

export interface ApprovedShipOrderInput {
  issueId: IssueId
  principal: CommandPrincipal
  requestedBy: Attribution
  overrideScope: boolean
  approved: {
    sourceBaseSha: string
    sourceHeadSha: string
    policyId: string
    evidenceManifestRef?: string
    previewLeaseIds: string[]
  }
}

export interface EnqueuedShipOrder {
  order: ShipOrder
  projection: ShipOrderProjection
  descendantManifest: DescendantTip[]
  created: boolean
}

export type ShippingAdmissionCode =
  | 'nested-root'
  | 'blocked'
  | 'stage'
  | 'policy'
  | 'evidence'
  | 'source-stale'
  | 'descendant-incomplete'
  | 'missing-repository'
  | 'missing-branch'

export class ShippingAdmissionError extends Error {
  constructor(
    readonly code: ShippingAdmissionCode,
    message: string,
    readonly rootIssueId?: IssueId,
  ) {
    super(message)
    this.name = 'ShippingAdmissionError'
  }
}

export interface ResolveShipHoldInput {
  orderId: ShipOrderId
  action: ShipHoldAction
  expectedGeneration: number
  principal: CommandPrincipal
  requestedBy: Attribution
}

export interface ResolvedShipHold {
  order: ShipOrder
  projection: ShipOrderProjection
}

export interface CancelShipOrderInput {
  orderId: ShipOrderId
  principal: CommandPrincipal
  requestedBy: Attribution
  overrideScope: boolean
}

export interface ShippingIssuePort {
  get(id: string): IssueWire
  children(id: string, recursive?: boolean): IssueWire[]
  shippingCommit<T>(
    id: IssueId,
    mutation: ShippingIssueMutation,
    write: () => T,
  ): { issue: IssueWire; result: T }
}

export interface ShippingLedgerPort {
  commit<T>(op: { write: () => T; changes: (result: T) => EntityChangeSpec[] }): { result: T }
  reconcile(entity: 'shipOrder', rows: { id: string; value: unknown }[]): unknown
}

export interface ShippingDaemonPort {
  shippingJob(
    input: Omit<ShippingJobRequestMessage, 'type' | 'requestId'>,
    machineId: MachineId,
  ): Promise<ShippingJobResult>
}

export interface ShippingAuthorizationPort {
  attribution(principal: CommandPrincipal): Attribution
  authorize(input: {
    principal: CommandPrincipal
    action: 'enqueue' | 'resolve-hold' | 'cancel'
    issue: IssueWire
    overrideScope: boolean
  }): void
  reauthorize(input: { order: ShipOrder; issue: IssueWire; effect: 'compatibility-land' }): void
}

export interface ShippingIntegrationReceipt {
  ref: string
  rootHeadSha: string
  descendantManifest: DescendantTip[]
}

export interface ShippingEvidencePort {
  resolveIntegrationReceipt(ref: string, issue: IssueWire): ShippingIntegrationReceipt | null
  persistAccepted(input: {
    order: ShipOrder
    evidenceManifestRef?: string
    integrationReceiptRef?: string
  }): void
}

export interface ShippingServiceDeps {
  repository: ShippingRepository
  issues: ShippingIssuePort
  ledger: ShippingLedgerPort
  daemon: ShippingDaemonPort
  authorization: ShippingAuthorizationPort
  evidence: ShippingEvidencePort
  policy: ShippingPolicyResolver
  machineFor(issue: IssueWire): MachineId
  resolveBranchTip(issue: IssueWire): Promise<string>
  resolveRefTip(issue: IssueWire, ref: string): Promise<string>
  now?: () => string
  audit?: (kind: string, issueId: IssueId, payload: Record<string, unknown>) => void
  beforeCompletionCommit?: (receipt: DeliveryReceipt) => void
  background?: boolean
}

interface Lease {
  attemptId: ShipAttempt['id']
  generation: number
  expiresAt: number
}

const terminalStep = (step: ShipStep | null): boolean =>
  step?.state === 'succeeded' || step?.state === 'failed' || step?.state === 'cancelled'

export class ShippingService {
  private readonly now: () => string
  private readonly leases = new Map<string, Lease>()
  private readonly inFlight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: ShippingServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    if (deps.background !== false) {
      this.timer = setInterval(() => void this.tick(), SCHEDULER_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  /** Admission + handoff port consumed by the command layer. All reads finish
   * before the single outer commit; order, issue custody and replica rows then
   * commit or roll back together. */
  async enqueue(input: ApprovedShipOrderInput): Promise<EnqueuedShipOrder> {
    const issue = this.deps.issues.get(input.issueId)
    this.deps.authorization.authorize({
      principal: input.principal,
      action: 'enqueue',
      issue,
      overrideScope: input.overrideScope,
    })
    const existing = this.deps.repository.activeOrderForIssue(issue.id)
    if (existing) {
      if (
        existing.approvedBaseSha === input.approved.sourceBaseSha &&
        existing.approvedHeadSha === input.approved.sourceHeadSha
      ) {
        return {
          order: existing,
          projection: this.requiredProjection(existing.id),
          descendantManifest: existing.descendantManifest,
          created: false,
        }
      }
      throw new ShippingAdmissionError(
        'source-stale',
        `issue ${issue.id} already has a different active shipping order`,
      )
    }
    this.assertAdmission(issue)
    const repoId = issue.repoId
    if (!repoId) {
      throw new ShippingAdmissionError('missing-repository', `issue ${issue.id} has no repository`)
    }
    const policy = this.deps.policy.resolve(issue)
    if (input.approved.policyId !== policy.id) {
      throw new ShippingAdmissionError(
        'policy',
        'approved policy does not match live repository policy',
      )
    }
    if (!input.approved.evidenceManifestRef && !policy.evidenceOptional) {
      throw new ShippingAdmissionError('evidence', 'accepted review evidence is required by policy')
    }
    const [currentSourceHead, currentTargetHead] = await Promise.all([
      this.deps.resolveBranchTip(issue),
      this.deps.resolveRefTip(issue, policy.targetBranch),
    ])
    if (
      currentSourceHead !== input.approved.sourceHeadSha ||
      currentTargetHead !== input.approved.sourceBaseSha
    ) {
      throw new ShippingAdmissionError(
        'source-stale',
        'approved source base/head no longer match repository refs',
      )
    }
    const descendants = this.deps.issues.children(issue.id, true)
    const incomplete = descendants.filter((child) => child.stage !== 'done')
    if (incomplete.length > 0) {
      const firstIncomplete = incomplete[0]
      throw new ShippingAdmissionError(
        'descendant-incomplete',
        `shipping requires every descendant complete (${firstIncomplete?.displayRef ?? firstIncomplete?.id ?? 'unknown'})`,
      )
    }
    const descendantManifest: DescendantTip[] = []
    for (const child of descendants) {
      if (!child.branch) {
        throw new ShippingAdmissionError(
          'missing-branch',
          `descendant ${child.displayRef ?? child.id} has no branch`,
        )
      }
      descendantManifest.push({
        issueId: child.id,
        approvedHeadSha: await this.deps.resolveBranchTip(child),
      })
    }
    let integrationReceiptRef: string | undefined
    if (descendantManifest.length > 0) {
      if (!input.approved.evidenceManifestRef) {
        throw new ShippingAdmissionError(
          'evidence',
          'shipping a delivery root with descendants requires an integration receipt',
        )
      }
      const integrationReceipt = this.deps.evidence.resolveIntegrationReceipt(
        input.approved.evidenceManifestRef,
        issue,
      )
      if (
        !integrationReceipt ||
        integrationReceipt.rootHeadSha !== currentSourceHead ||
        JSON.stringify(integrationReceipt.descendantManifest) !== JSON.stringify(descendantManifest)
      ) {
        throw new ShippingAdmissionError(
          'evidence',
          'integration receipt does not describe the current root and descendant tips',
        )
      }
      integrationReceiptRef = integrationReceipt.ref
    }
    const at = this.now()
    const order: ShipOrder = {
      id: asShipOrderId(
        `ship_${createHash('sha256')
          .update(`${issue.id}\0${input.approved.sourceBaseSha}\0${input.approved.sourceHeadSha}`)
          .digest('hex')}`,
      ),
      issueId: issue.id,
      descendantManifest,
      repoId,
      targetBranch: policy.targetBranch,
      destination: policy.destination,
      approvedBaseSha: input.approved.sourceBaseSha,
      approvedHeadSha: input.approved.sourceHeadSha,
      deliveryDependsOn: policy.deliveryDependsOn,
      ...(policy.providerRef ? { providerRef: policy.providerRef } : {}),
      requestedBy: this.deps.authorization.attribution(input.principal),
      requestedAt: at,
      policyId: policy.id,
      closeMode: policy.closeMode,
      state: 'queued',
      stateChangedAt: at,
    }
    let admission: { order: ShipOrder; created: boolean }
    try {
      admission = this.deps.issues.shippingCommit(
        issue.id,
        {
          expectedStage: ['review', 'shipping'],
          nextStage: 'shipping',
          shipOrderChanges: (result) => {
            void result
            return this.projectionSpecs()
          },
          event: (result) =>
            (result as { created: boolean }).created
              ? {
                  kind: 'issue.shipping_enqueued',
                  payload: {
                    orderId: order.id,
                    destination: order.destination,
                    evidenceManifestRef: input.approved.evidenceManifestRef ?? null,
                    integrationReceiptRef: integrationReceiptRef ?? null,
                    requestedBy: input.requestedBy,
                    overrideScope: input.overrideScope,
                    previewLeaseIds: input.approved.previewLeaseIds,
                  },
                }
              : undefined,
        },
        () => {
          const live = this.deps.issues.get(issue.id)
          if (this.deps.policy.resolve(live).id !== policy.id) {
            throw new ShippingAdmissionError('policy', 'repository shipping policy changed')
          }
          const result = this.deps.repository.createOrReturnActiveOrder(order)
          if (result.created) {
            this.deps.evidence.persistAccepted({
              order: result.order,
              evidenceManifestRef: input.approved.evidenceManifestRef,
              integrationReceiptRef,
            })
          }
          return result
        },
      ).result
    } catch (error) {
      if (error instanceof Error && /different active ship order/.test(error.message)) {
        throw new ShippingAdmissionError('source-stale', error.message)
      }
      throw error
    }
    if (admission.created) {
      this.audit('shipping.order_enqueued', issue.id, {
        orderId: admission.order.id,
        destination: admission.order.destination,
        evidenceManifestRef: input.approved.evidenceManifestRef ?? null,
        principalKind: input.principal.kind,
      })
    }
    return {
      order: admission.order,
      projection: this.requiredProjection(admission.order.id),
      descendantManifest: admission.order.descendantManifest,
      created: admission.created,
    }
  }

  queue(): ReturnType<typeof shippingQueue> {
    return shippingQueue(this.deps.repository.listOrders())
  }

  heartbeat(orderId: ShipOrderId, attemptId: ShipAttempt['id'], generation: number): boolean {
    const current = this.leases.get(orderId)
    if (!current || current.attemptId !== attemptId || current.generation !== generation)
      return false
    current.expiresAt = Date.now() + LEASE_MS
    return true
  }

  async tick(): Promise<void> {
    const now = Date.now()
    const next = this.queue().find(({ order, blockedBy }) => {
      if (blockedBy.length > 0 || this.inFlight.has(order.id)) return false
      if (order.state === 'queued') return true
      if (order.state === 'held' || order.state === 'shipped' || order.state === 'cancelled') {
        return false
      }
      const lease = this.leases.get(order.id)
      return !lease || lease.expiresAt <= now
    })?.order
    if (next) await this.runOrder(next.id)
  }

  /** Boot/reconnect reconciliation. Every active state is resumed from durable
   * order/attempt/step and daemon-journal truth; no originating session exists
   * in this API. */
  async reconcile(): Promise<void> {
    this.deps.ledger.reconcile('shipOrder', this.currentProjectionRows())
    for (const order of this.deps.repository.listOrders()) {
      if (order.state === 'shipped' || order.state === 'cancelled' || order.state === 'held')
        continue
      await this.runOrder(order.id)
    }
  }

  async runOrder(orderId: ShipOrderId): Promise<void> {
    if (this.inFlight.has(orderId)) return
    this.inFlight.add(orderId)
    try {
      let order = this.requiredOrder(orderId)
      if (order.state === 'queued') order = this.beginAttempt(order)
      const attempt = this.latestAttempt(order)
      if (!attempt) throw new Error(`shipping order ${order.id} has no execution attempt`)
      const issue = this.deps.issues.get(order.issueId)
      const policy = this.deps.policy.resolve(issue)

      if (order.state === 'preflight') {
        const result = await this.runEffect(order, attempt, issue, 'preflight')
        if (result?.state !== 'succeeded') return
        order = this.transition(order, 'composing')
      }
      if (order.state === 'composing') order = this.transition(order, 'validating')
      if (order.state === 'validating') order = this.transition(order, 'landing')
      if (order.state === 'landing') {
        try {
          if (policy.id !== order.policyId) {
            throw new Error('repository shipping policy changed after admission')
          }
          this.deps.authorization.reauthorize({
            order,
            issue,
            effect: 'compatibility-land',
          })
        } catch (error) {
          await this.hold(
            order,
            attempt,
            'policy-refused',
            'Shipping authorization changed',
            error instanceof Error ? error.message : String(error),
          )
          return
        }
        const result = await this.runEffect(order, attempt, issue, 'compatibility-land')
        if (result?.state !== 'succeeded') return
        order = this.transition(order, 'verifying')
      }
      if (order.state === 'verifying') {
        const result = await this.runEffect(order, attempt, issue, 'verify')
        if (result?.state !== 'succeeded') return
        const destinationSha = result.observedDestinationSha ?? result.observedTargetSha
        if (!destinationSha) {
          await this.hold(
            order,
            attempt,
            'destination-mismatch',
            'Destination proof is incomplete',
            result.summary,
          )
          return
        }
        const finishedAt = this.now()
        const receipt: DeliveryReceipt = {
          id: asDeliveryReceiptId(`receipt_${order.id}`),
          orderId: order.id,
          approvedBaseSha: order.approvedBaseSha,
          approvedHeadSha: order.approvedHeadSha,
          testedIntegrationSha: order.approvedHeadSha,
          landedRefSha: result.observedTargetSha ?? destinationSha,
          destinationSha,
          validationProfileId: policy.validationProfileId,
          validationResult: 'passed',
          destination: order.destination,
          completedAt: finishedAt,
        }
        const shipped = { ...order, state: 'shipped' as const, stateChangedAt: finishedAt }
        const specs = this.projectionSpecs(this.replaceOrder(shipped), undefined, receipt)
        this.deps.beforeCompletionCommit?.(receipt)
        this.deps.issues.shippingCommit(
          order.issueId,
          {
            expectedStage: 'shipping',
            nextStage: 'done',
            needsHuman: false,
            shipOrderChanges: specs,
            event: { kind: 'issue.shipped', payload: { orderId: order.id, receiptId: receipt.id } },
          },
          () => {
            this.deps.repository.finishAttempt(attempt.id, attempt.leaseGeneration, {
              finishedAt,
              outcome: 'succeeded',
              testedIntegrationSha: receipt.testedIntegrationSha,
              landedRefSha: receipt.landedRefSha,
              destinationSha: receipt.destinationSha,
              validationProfileId: receipt.validationProfileId,
              validationResult: 'passed',
            })
            return this.deps.repository.completeVerifiedOrder(receipt)
          },
        )
        this.audit('shipping.order_shipped', order.issueId, {
          orderId: order.id,
          receiptId: receipt.id,
        })
        this.leases.delete(order.id)
      }
    } finally {
      this.inFlight.delete(orderId)
    }
  }

  async cancel(input: CancelShipOrderInput): Promise<ShipOrder> {
    const order = this.requiredOrder(input.orderId)
    const issue = this.deps.issues.get(order.issueId)
    this.deps.authorization.authorize({
      principal: input.principal,
      action: 'cancel',
      issue,
      overrideScope: input.overrideScope,
    })
    if (order.state === 'held') {
      const hold = this.deps.repository.openHoldForOrder(order.id)
      if (!hold) throw new Error(`held shipping order ${order.id} has no open hold`)
      return (
        await this.resolveHold({
          orderId: order.id,
          action: 'return-to-issue',
          expectedGeneration: hold.generation,
          principal: input.principal,
          requestedBy: input.requestedBy,
        })
      ).order
    }
    if (!['queued', 'preflight', 'composing', 'validating', 'repairing'].includes(order.state)) {
      throw new Error(`shipping order ${order.id} can no longer be safely cancelled`)
    }
    const attempt = this.latestAttempt(order)
    let cancellationStep: ShipStep | undefined
    if (attempt) {
      const operation = this.operationFor(order.state)
      if (operation) {
        const result = await this.deps.daemon.shippingJob(
          this.jobInput(order, attempt, issue, operation, 'cancel'),
          attempt.machineId,
        )
        this.assertJobResultFence(order, attempt, operation, result)
        if (result.state !== 'cancelled' && result.state !== 'succeeded') {
          await this.hold(
            order,
            attempt,
            'machine-unavailable',
            'Shipping cancellation could not be settled',
            result.summary,
            result.artifactRefs,
          )
          return this.requiredOrder(order.id)
        }
        const effectKey = `${operation}:${attempt.leaseGeneration}`
        const latest = this.deps.repository.latestStepForEffect(attempt.id, effectKey)
        if (latest && !terminalStep(latest)) {
          const finishedAt = result.finishedAt ?? this.now()
          cancellationStep = {
            ...this.step(
              order,
              attempt,
              effectKey,
              operation,
              'cancelled',
              latest.startedAt ?? finishedAt,
            ),
            outcome: result.classification,
            summary: result.summary,
            finishedAt,
            ...(result.artifactRefs[0] ? { artifactRef: result.artifactRefs[0] } : {}),
          }
        }
      }
    }
    const at = this.now()
    const cancelled = { ...order, state: 'cancelled' as const, stateChangedAt: at }
    const result = this.deps.issues.shippingCommit(
      order.issueId,
      {
        expectedStage: 'shipping',
        nextStage: 'review',
        needsHuman: false,
        shipOrderChanges: this.projectionSpecs(this.replaceOrder(cancelled)),
        event: { kind: 'issue.shipping_cancelled', payload: { orderId: order.id } },
      },
      () => {
        if (cancellationStep) this.deps.repository.appendStep(cancellationStep)
        return this.deps.repository.cancelAttemptAndOrder(
          order.id,
          order.state as Extract<
            ShipOrderState,
            'queued' | 'preflight' | 'composing' | 'validating' | 'repairing'
          >,
          at,
        )
      },
    ).result
    this.leases.delete(order.id)
    return result
  }

  async resolveHold(input: ResolveShipHoldInput): Promise<ResolvedShipHold> {
    const { orderId, action, expectedGeneration } = input
    const order = this.requiredOrder(orderId)
    const issue = this.deps.issues.get(order.issueId)
    this.deps.authorization.authorize({
      principal: input.principal,
      action: 'resolve-hold',
      issue,
      overrideScope: false,
    })
    if (order.state !== 'held') throw new Error(`shipping order ${order.id} is not held`)
    const nextState =
      action === 'return-to-issue' ? 'cancelled' : action === 'open-repair' ? 'repairing' : 'queued'
    const at = this.now()
    const next = {
      ...order,
      state: nextState,
      stateChangedAt: at,
      holdCode: undefined,
    } as ShipOrder
    const hold = this.deps.repository.openHoldForOrder(order.id)
    if (!hold || hold.generation !== expectedGeneration) {
      throw new Error(
        `ship hold ${order.id} generation fence failed: expected ${expectedGeneration}`,
      )
    }
    const resolvedHold: ShipHold = {
      ...hold,
      resolvedAt: at,
      resolution: action,
    }
    const result = this.deps.issues.shippingCommit(
      order.issueId,
      {
        expectedStage: 'shipping',
        ...(nextState === 'cancelled' ? { nextStage: 'review' as const } : {}),
        needsHuman: false,
        shipOrderChanges: this.projectionSpecs(this.replaceOrder(next), resolvedHold),
        event: {
          kind: 'issue.ship_hold_resolved',
          payload: { orderId: order.id, action, generation: expectedGeneration },
        },
      },
      () => {
        this.deps.repository.resolveHold(order.id, expectedGeneration, action, nextState, at)
        return this.requiredOrder(order.id)
      },
    ).result
    this.audit('shipping.hold_resolved', order.issueId, {
      orderId: order.id,
      action,
      generation: expectedGeneration,
      principalKind: input.principal.kind,
      requestedBy: input.requestedBy,
    })
    return { order: result, projection: this.requiredProjection(result.id) }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private assertAdmission(issue: IssueWire): void {
    if (issue.parentId) {
      let root = this.deps.issues.get(issue.parentId)
      while (root.parentId) root = this.deps.issues.get(root.parentId)
      throw new ShippingAdmissionError(
        'nested-root',
        `issue ${issue.id} is nested and cannot ship separately`,
        root.id,
      )
    }
    if (issue.stage !== 'review') {
      throw new ShippingAdmissionError('stage', 'shipping requires review stage')
    }
    if (issue.blocked) throw new ShippingAdmissionError('blocked', 'blocked issue cannot ship')
    if (!issue.repoId) {
      throw new ShippingAdmissionError(
        'missing-repository',
        'shipping requires stable repository identity',
      )
    }
    if (!issue.branch) {
      throw new ShippingAdmissionError('missing-branch', 'shipping requires an issue branch')
    }
  }

  private beginAttempt(order: ShipOrder): ShipOrder {
    const issue = this.deps.issues.get(order.issueId)
    const startedAt = this.now()
    const acquired = this.deps.ledger.commit({
      write: () =>
        this.deps.repository.beginAttempt({
          orderId: order.id,
          machineId: this.deps.machineFor(issue),
          startedAt,
        }),
      changes: () => this.projectionSpecs(),
    }).result
    this.leases.set(order.id, {
      attemptId: acquired.attempt.id,
      generation: acquired.attempt.leaseGeneration,
      expiresAt: Date.now() + LEASE_MS,
    })
    this.audit('shipping.attempt_started', order.issueId, {
      orderId: order.id,
      attemptId: acquired.attempt.id,
      generation: acquired.attempt.leaseGeneration,
    })
    return acquired.order
  }

  private transition(
    order: ShipOrder,
    next: Exclude<ShipOrderState, 'held' | 'shipped'>,
  ): ShipOrder {
    const at = this.now()
    const result = this.deps.ledger.commit({
      write: () => this.deps.repository.transitionOrder(order.id, order.state, next, at),
      changes: () => this.projectionSpecs(),
    }).result
    this.audit('shipping.order_state_changed', order.issueId, {
      orderId: order.id,
      from: order.state,
      to: next,
    })
    return result
  }

  private async runEffect(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    operation: 'preflight' | 'compatibility-land' | 'verify',
  ): Promise<ShippingJobResult | null> {
    const effectKey = `${operation}:${attempt.leaseGeneration}`
    let latest = this.deps.repository.latestStepForEffect(attempt.id, effectKey)
    const startedAt = latest?.startedAt ?? this.now()
    if (!latest) {
      latest = this.deps.repository.appendStep(
        this.step(order, attempt, effectKey, operation, 'planned', startedAt),
      )
    }
    if (latest.state === 'planned') {
      latest = this.deps.repository.appendStep(
        this.step(order, attempt, effectKey, operation, 'running', startedAt),
      )
    }
    const lease = this.leases.get(order.id)
    if (!lease || lease.attemptId !== attempt.id || lease.generation !== attempt.leaseGeneration) {
      this.leases.set(order.id, {
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        expiresAt: Date.now() + LEASE_MS,
      })
    }
    const result = await this.deps.daemon.shippingJob(
      this.jobInput(order, attempt, issue, operation, 'start'),
      attempt.machineId,
    )
    this.assertJobResultFence(order, attempt, operation, result)
    this.heartbeat(order.id, attempt.id, attempt.leaseGeneration)
    if (result.state === 'running') return null
    if (!terminalStep(this.deps.repository.latestStepForEffect(attempt.id, effectKey))) {
      this.deps.repository.appendStep({
        ...this.step(
          order,
          attempt,
          effectKey,
          operation,
          result.state === 'succeeded'
            ? 'succeeded'
            : result.state === 'cancelled'
              ? 'cancelled'
              : 'failed',
          startedAt,
        ),
        outcome: result.classification,
        summary: result.summary,
        finishedAt: result.finishedAt ?? this.now(),
        artifactRef: result.artifactRefs[0],
      })
    }
    if (result.state === 'held') {
      await this.hold(
        order,
        attempt,
        this.holdCode(result.classification),
        this.holdHeadline(result),
        result.summary,
        result.artifactRefs,
      )
    } else if (result.state === 'cancelled') {
      // The daemon may durably record cancellation before the server commits
      // its own cancellation transition. Recovery must classify that boundary
      // instead of redispatching the cancelled effect forever.
      await this.hold(
        order,
        attempt,
        'machine-unavailable',
        'Shipping execution was cancelled',
        'The daemon journal recorded cancellation before server custody settled; choose retry or return to the issue.',
        result.artifactRefs,
      )
    }
    return result
  }

  private async hold(
    order: ShipOrder,
    attempt: ShipAttempt,
    reasonCode: ShipHold['reasonCode'],
    headline: string,
    detail: string,
    evidenceRefs: string[] = [],
  ): Promise<void> {
    if (!attempt.finishedAt) {
      this.deps.repository.finishAttempt(attempt.id, attempt.leaseGeneration, {
        finishedAt: this.now(),
        outcome: 'failed',
      })
    }
    const generation =
      Math.max(
        0,
        ...this.deps.repository
          .listHolds()
          .filter((item) => item.orderId === order.id)
          .map((item) => item.generation),
      ) + 1
    const raisedAt = this.now()
    const hold: ShipHold = {
      id: asShipHoldId(`hold:${order.id}:${generation}`),
      orderId: order.id,
      generation,
      reasonCode,
      headline,
      detail,
      evidenceRefs,
      actions: ['retry', 'return-to-issue'],
      raisedAt,
    }
    const heldOrder: ShipOrder = {
      ...order,
      state: 'held',
      stateChangedAt: raisedAt,
      holdCode: reasonCode,
    }
    this.deps.issues.shippingCommit(
      order.issueId,
      {
        expectedStage: 'shipping',
        needsHuman: true,
        shipOrderChanges: this.projectionSpecs(this.replaceOrder(heldOrder), hold),
        event: {
          kind: 'issue.ship_hold_raised',
          payload: {
            orderId: order.id,
            holdId: hold.id,
            generation,
            reasonCode,
            actions: hold.actions,
          },
        },
      },
      () => this.deps.repository.raiseHold(hold),
    )
    this.leases.delete(order.id)
  }

  private latestAttempt(order: ShipOrder): ShipAttempt | null {
    return this.deps.repository.latestAttemptForOrder(order.id)
  }

  private step(
    order: ShipOrder,
    attempt: ShipAttempt,
    effectKey: string,
    kind: string,
    state: ShipStep['state'],
    startedAt: string,
  ): ShipStep {
    const at = this.now()
    return {
      id: asShipStepId(`step:${attempt.id}:${effectKey}:${state}`),
      orderId: order.id,
      attemptId: attempt.id,
      effectKey,
      idempotencyKey: `${effectKey}:${state}`,
      generation: attempt.leaseGeneration,
      inputFence: {
        sourceBaseSha: attempt.expectedSourceBaseSha,
        approvedHeadSha: attempt.approvedHeadSha,
        targetSha: attempt.expectedTargetSha,
      },
      kind,
      state,
      summary:
        state === 'planned' ? 'effect planned' : state === 'running' ? 'effect dispatched' : '',
      recordedAt: at,
      ...(state === 'planned' ? {} : { startedAt }),
    }
  }

  private jobInput(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    operation: 'preflight' | 'compatibility-land' | 'verify',
    action: 'start' | 'status' | 'cancel',
  ): Omit<ShippingJobRequestMessage, 'type' | 'requestId'> {
    return {
      action,
      jobId: `${attempt.id}:${operation}`,
      orderId: order.id,
      attemptId: attempt.id,
      generation: attempt.leaseGeneration,
      operation,
      repoPath: issue.repoPath,
      sourceBranch: this.requiredBranch(issue),
      targetBranch: order.targetBranch,
      approvedBaseSha: order.approvedBaseSha,
      approvedHeadSha: order.approvedHeadSha,
      expectedTargetSha: attempt.expectedTargetSha,
      destination: order.destination,
    }
  }

  private operationFor(
    state: ShipOrderState,
  ): 'preflight' | 'compatibility-land' | 'verify' | null {
    if (state === 'preflight') return 'preflight'
    if (state === 'landing') return 'compatibility-land'
    if (state === 'verifying') return 'verify'
    return null
  }

  private requiredBranch(issue: IssueWire): string {
    if (!issue.branch) throw new Error(`shipping issue ${issue.id} no longer has a source branch`)
    return issue.branch
  }

  private assertJobResultFence(
    order: ShipOrder,
    attempt: ShipAttempt,
    operation: ShippingJobResult['operation'],
    result: ShippingJobResult,
  ): void {
    if (
      result.orderId !== order.id ||
      result.attemptId !== attempt.id ||
      result.generation !== attempt.leaseGeneration ||
      result.operation !== operation ||
      result.machineId !== attempt.machineId
    ) {
      throw new Error(`shipping daemon result fence failed for ${attempt.id}:${operation}`)
    }
  }

  private holdCode(classification: ShippingJobResult['classification']): ShipHold['reasonCode'] {
    if (classification === 'source-moved') return 'approval-stale'
    if (classification === 'target-moved') return 'landing-conflict'
    if (classification === 'destination-mismatch') return 'destination-mismatch'
    if (classification === 'stale-generation') return 'machine-unavailable'
    return 'policy-refused'
  }

  private holdHeadline(result: ShippingJobResult): string {
    if (result.classification === 'source-moved') return 'Approved source changed'
    if (result.classification === 'target-moved') return 'Target changed during shipping'
    if (result.classification === 'dirty-worktree') return 'Repository checkout is not clean'
    if (result.classification === 'destination-mismatch') return 'Destination proof failed'
    return 'Shipping needs a supported destination executor'
  }

  private requiredOrder(id: ShipOrderId): ShipOrder {
    const order = this.deps.repository.getOrder(id)
    if (!order) throw new Error(`unknown shipping order ${id}`)
    return order
  }

  private requiredProjection(id: ShipOrderId): ShipOrderProjection {
    const row = this.currentProjectionRows().find((candidate) => candidate.id === id)
    if (!row) throw new Error(`shipping order ${id} has no active projection`)
    return row.value
  }

  private replaceOrder(next: ShipOrder): ShipOrder[] {
    return this.deps.repository.listOrders().map((order) => (order.id === next.id ? next : order))
  }

  private projectionSpecs(
    orders = this.deps.repository.listOrders(),
    replacementHold?: ShipHold,
    replacementReceipt?: DeliveryReceipt,
  ): EntityChangeSpec[] {
    const holds = this.deps.repository.listHolds()
    const receipts = this.deps.repository.listReceipts()
    const holdByOrder = new Map(
      holds.filter((hold) => !hold.resolvedAt).map((hold) => [hold.orderId, hold] as const),
    )
    if (replacementHold) holdByOrder.set(replacementHold.orderId, replacementHold)
    const receiptByOrder = new Map(receipts.map((receipt) => [receipt.orderId, receipt] as const))
    if (replacementReceipt) receiptByOrder.set(replacementReceipt.orderId, replacementReceipt)
    return shippingQueue(orders).map(({ order, queueRank }) => {
      const row = shipOrderProjectionRow(
        order,
        holdByOrder.get(order.id),
        receiptByOrder.get(order.id),
        queueRank,
      )
      return row
        ? { entity: 'shipOrder' as const, id: row.id, op: 'upsert' as const, value: row.value }
        : { entity: 'shipOrder' as const, id: order.id, op: 'remove' as const }
    })
  }

  private currentProjectionRows(): { id: string; value: ShipOrderProjection }[] {
    return this.projectionSpecs().flatMap((spec) =>
      spec.op === 'upsert' ? [{ id: spec.id, value: spec.value as ShipOrderProjection }] : [],
    )
  }

  private audit(kind: string, issueId: IssueId, payload: Record<string, unknown>): void {
    this.deps.audit?.(kind, issueId, payload)
  }
}
