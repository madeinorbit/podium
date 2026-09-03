import { createHash, randomUUID } from 'node:crypto'
import { createLogger } from '@podium/logger'
import {
  type Attribution,
  asDeliveryReceiptId,
  asShipHoldId,
  asShipOrderId,
  asShipStepId,
  asShipTrainSubsetId,
  type DeliveryReceipt,
  type DescendantTip,
  type IssueId,
  type IssueWire,
  integrationReceiptMatchesOrder,
  shipRepairRef,
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
import type { ShippingJobRequestMessage, ShippingJobResult } from '@podium/protocol/daemon'
import {
  SHIPPING_TRAIN_CAPABILITY,
  shippingEvidenceFingerprint,
  shippingJobRequestFingerprint,
  shippingTrainSubsetFingerprint,
} from '@podium/protocol/daemon'
import type { EntityChangeSpec } from '@podium/sync'
import type { CommandPrincipal } from '../../command-principal'
import {
  type RootIntegrationReceiptStore,
  sameFrozenShipOrder,
  type ShippingRepository,
  type StoredShippingRepairCandidate,
} from '../../store/shipping'
import type { ShippingIssueMutation } from '../issues/service/crud'
import type { ShippingPolicyResolver } from './policy'
import { shipOrderProjectionRow } from './projection'
import {
  canonicalShippingDestination,
  GreenPrefixCache,
  isolateShippingTrain,
  shippingCompatibilityKey,
  shippingQueue,
  shippingSchedule,
  type ShippingTrain,
} from './queue'
import {
  shippingRepairContextDigest,
  type ShippingRepairContext,
  type ShippingRepairDecision,
  type ShippingRepairPort,
} from './repair-contract'

const LEASE_MS = 45_000
const SCHEDULER_INTERVAL_MS = 2_000
const log = createLogger('server:shipping')

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

/** Command-facing nomination. Approval is the live review-stage repository
 * snapshot; no SHA, policy id, destination, or evidence claim crosses the
 * untrusted command input. */
export interface CurrentShipOrderInput {
  issueId: IssueId
  principal: CommandPrincipal
  overrideScope: boolean
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
  requestedBy?: Attribution
  overrideScope?: boolean
}

export interface ResolvedShipHold {
  order: ShipOrder
  projection: ShipOrderProjection
}

export interface CancelShipOrderInput {
  orderId: ShipOrderId
  principal: CommandPrincipal
  requestedBy?: Attribution
  overrideScope: boolean
}

export interface DeliveryReceiptDetailInput {
  orderId: ShipOrderId
  principal: CommandPrincipal
}

/** Deliberately collapses absent rows and rows whose delivery root is invisible.
 * Order-addressed commands use TARGETED_ERRORS, so revealing which arm failed
 * would turn an opaque order id into an issue-existence oracle. */
export class ShippingOrderAccessError extends Error {
  constructor() {
    super('shipping order not found or inaccessible')
    this.name = 'ShippingOrderAccessError'
  }
}

export interface ShippingIssuePort {
  get(id: string): IssueWire
  children(id: string, recursive?: boolean): IssueWire[]
  shippingCommit<T>(
    id: IssueId,
    mutation: ShippingIssueMutation,
    write: () => T,
  ): { issue: IssueWire; result: T }
  shippingCommitMany<T>(
    entries: readonly { id: IssueId; mutation: ShippingIssueMutation }[],
    write: () => T,
  ): { issues: IssueWire[]; result: T }
  takeBranchCustody?(issue: IssueWire): Promise<{ ok: boolean; detail: string }>
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
    action: 'enqueue' | 'resolve-hold' | 'cancel' | 'read-receipt'
    issue: IssueWire
    overrideScope: boolean
  }): void
  reauthorize(input: {
    order: ShipOrder
    issue: IssueWire
    machineId: MachineId
    effect:
      | 'preflight'
      | 'apply-repair'
      | 'prepare-merge-group'
      | 'validate'
      | 'commit-merge-group'
      | 'publish'
      | 'verify'
      | 'cancel'
  }): void
}

export interface ShippingResourceAdmissionPort {
  acquire(input: {
    order: ShipOrder
    attempt: ShipAttempt
    issue: IssueWire
    names: readonly string[]
    ttlSeconds: number
  }): boolean
  renew(input: {
    order: ShipOrder
    attempt: ShipAttempt
    issue: IssueWire
    names: readonly string[]
    ttlSeconds: number
  }): boolean
  release(input: {
    order: ShipOrder
    attempt: ShipAttempt
    issue: IssueWire
    names: readonly string[]
  }): void
}

export interface AcceptedReviewEvidence {
  issueId: IssueId
  sourceBaseSha: string
  sourceHeadSha: string
  policyId: string
  evidenceManifestRef: string
  previewLeaseIds: string[]
}

export interface ShippingEvidencePort
  extends Pick<RootIntegrationReceiptStore, 'rootIntegrationReceipt'> {
  acceptedReviewEvidence(input: {
    issueId: IssueId
    sourceBaseSha: string
    sourceHeadSha: string
    policyId: string
  }): AcceptedReviewEvidence | null
}

export interface ShippingServiceDeps {
  repository: ShippingRepository
  issues: ShippingIssuePort
  ledger: ShippingLedgerPort
  daemon: ShippingDaemonPort
  authorization: ShippingAuthorizationPort
  evidence: ShippingEvidencePort
  policy: ShippingPolicyResolver
  resourceAdmission?: ShippingResourceAdmissionPort
  machineFor(issue: IssueWire): MachineId
  machineCapabilities?(machineId: MachineId): readonly string[]
  resolveBranchTip(issue: IssueWire): Promise<string>
  resolveRefTip(issue: IssueWire, ref: string): Promise<string>
  isAncestor(issue: IssueWire, ancestorSha: string, descendantSha: string): Promise<boolean>
  now?: () => string
  audit?: (kind: string, issueId: IssueId, payload: Record<string, unknown>) => void
  beforeCompletionCommit?: (receipt: DeliveryReceipt) => void
  repair?: ShippingRepairPort
  beforeRepairAcknowledge?: (resultToken: string) => void
  background?: boolean
}

interface Lease {
  attemptId: ShipAttempt['id']
  generation: number
  expiresAt: number
}

export interface ResourceLease {
  lost: boolean
  expiresAt?: number
  ttlMs?: number
  renew?: () => boolean
  timer?: ReturnType<typeof setInterval>
  /** True while this lease's renew tick is running — its single-flight fence. */
  renewing?: boolean
}

const terminalStep = (step: ShipStep | null): boolean =>
  step?.state === 'succeeded' || step?.state === 'failed' || step?.state === 'cancelled'

const REPAIR_MARKER = 'shipping-repair:v2:'
const TRAIN_PROOF_MARKER = 'shipping-train-proof:v1:'
const CANCELLATION_MARKER = 'shipping-cancel:v1:'

const cancellationSummary = (targetOrderId: ShipOrderId, trainId?: string): string =>
  `${CANCELLATION_MARKER}${JSON.stringify({ targetOrderId, trainId: trainId ?? null })}`

const cancellationTarget = (summary: string): ShipOrderId | null => {
  if (!summary.startsWith(CANCELLATION_MARKER)) return null
  try {
    const parsed = JSON.parse(summary.slice(CANCELLATION_MARKER.length)) as {
      targetOrderId?: unknown
    }
    return typeof parsed.targetOrderId === 'string' ? (parsed.targetOrderId as ShipOrderId) : null
  } catch {
    return null
  }
}

interface DurableRepairMarker {
  decision: Exclude<ShippingRepairDecision, { kind: 'not-applicable' }>
  context: ShippingRepairContext
  acknowledgement: {
    resultToken: string
    orderId: ShipOrder['id']
    attemptId: ShipAttempt['id']
    generation: number
    contextDigest: string
    candidate?: { repairRef: string; candidateHeadSha: string }
  }
}

const repairMarker = (marker: DurableRepairMarker): string =>
  `${REPAIR_MARKER}${JSON.stringify(marker)}`

const parseRepairMarker = (summary: string): DurableRepairMarker | null => {
  if (!summary.startsWith(REPAIR_MARKER)) return null
  try {
    const parsed = JSON.parse(summary.slice(REPAIR_MARKER.length)) as DurableRepairMarker
    if (
      !parsed ||
      (parsed.decision?.kind !== 'patched' && parsed.decision?.kind !== 'needs-decision') ||
      !parsed.decision.resultToken ||
      parsed.acknowledgement?.resultToken !== parsed.decision.resultToken ||
      parsed.acknowledgement?.orderId !== parsed.context?.order?.id ||
      parsed.acknowledgement?.attemptId !== parsed.context?.attempt?.id ||
      parsed.acknowledgement?.generation !== parsed.context?.attempt?.leaseGeneration ||
      !/^[a-f0-9]{64}$/.test(parsed.acknowledgement?.contextDigest ?? '') ||
      parsed.context?.contextDigest !== parsed.acknowledgement?.contextDigest ||
      parsed.context?.custody?.attemptId !== parsed.context?.attempt?.id ||
      parsed.context?.custody?.generation !== parsed.context?.attempt?.leaseGeneration ||
      parsed.context?.custody?.machineId !== parsed.context?.attempt?.machineId ||
      parsed.context?.authority?.orderId !== parsed.context?.order?.id ||
      parsed.context?.authority?.attemptId !== parsed.context?.attempt?.id ||
      parsed.context?.authority?.generation !== parsed.context?.attempt?.leaseGeneration ||
      typeof parsed.context?.failure?.repairBaseSha !== 'string' ||
      parsed.context.failure.repairBaseSha.length === 0 ||
      shippingRepairContextDigest({
        order: parsed.context.order,
        attempt: parsed.context.attempt,
        issue: parsed.context.issue,
        failure: parsed.context.failure,
        custody: parsed.context.custody,
        authority: parsed.context.authority,
      }) !== parsed.context.contextDigest ||
      (parsed.context?.failure?.operation !== 'prepare-merge-group' &&
        parsed.context?.failure?.operation !== 'validate')
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export const shippingResourceHolderId = (
  incarnation: string,
  orderId: string,
  attemptId: string,
  generation: number,
): `system:${string}` => `system:shipping:${incarnation}:${orderId}:${attemptId}:${generation}`

export { canonicalShippingDestination } from './queue'

export class ShippingService {
  private readonly greenPrefixes = new GreenPrefixCache()
  private readonly now: () => string
  private readonly leases = new Map<string, Lease>()
  private readonly activeResourceLeases = new Set<ResourceLease>()
  private readonly inFlight = new Set<string>()
  private admissionTail: Promise<void> = Promise.resolve()
  private admissionsInFlight = 0
  private timer: ReturnType<typeof setInterval> | undefined
  /** True while a scheduler pass is running — see {@link ShippingService.tick}. */
  private ticking = false

  constructor(private readonly deps: ShippingServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
    if (deps.background !== false) this.start()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.warn('scheduler tick failed', { err }))
    }, SCHEDULER_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Resolve the intentionally tiny `issues.ship` command into the live approval
   * snapshot, then enter the same atomic/idempotent admission transaction used by
   * every other Shipping caller. */
  async enqueueCurrent(input: CurrentShipOrderInput): Promise<EnqueuedShipOrder> {
    const issue = this.deps.issues.get(input.issueId)
    const policy = this.deps.policy.resolve(issue)
    const [sourceHeadSha, sourceBaseSha] = await Promise.all([
      this.deps.resolveBranchTip(issue),
      this.deps.resolveRefTip(issue, policy.targetBranch),
    ])
    const evidenceKey = {
      issueId: issue.id,
      sourceBaseSha,
      sourceHeadSha,
      policyId: policy.id,
    }
    const accepted = this.deps.evidence.acceptedReviewEvidence(evidenceKey)
    if (
      accepted &&
      (accepted.issueId !== evidenceKey.issueId ||
        accepted.sourceBaseSha !== evidenceKey.sourceBaseSha ||
        accepted.sourceHeadSha !== evidenceKey.sourceHeadSha ||
        accepted.policyId !== evidenceKey.policyId)
    ) {
      throw new ShippingAdmissionError(
        'evidence',
        'accepted review evidence does not match the live approval boundary',
      )
    }
    if (!accepted && !policy.evidenceOptional) {
      throw new ShippingAdmissionError('evidence', 'accepted review evidence is required by policy')
    }
    return this.enqueue({
      ...input,
      requestedBy: this.deps.authorization.attribution(input.principal),
      approved: {
        sourceBaseSha,
        sourceHeadSha,
        policyId: policy.id,
        ...(accepted ? { evidenceManifestRef: accepted.evidenceManifestRef } : {}),
        previewLeaseIds: accepted?.previewLeaseIds ?? [],
      },
    })
  }

  /** Admission + handoff port consumed by the command layer. All reads finish
   * before the single outer commit; order, issue custody and replica rows then
   * commit or roll back together. */
  async enqueue(input: ApprovedShipOrderInput): Promise<EnqueuedShipOrder> {
    this.admissionsInFlight += 1
    let release!: () => void
    const previous = this.admissionTail
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await this.enqueueSerial(input)
    } finally {
      this.admissionsInFlight -= 1
      release()
    }
  }

  private async enqueueSerial(input: ApprovedShipOrderInput): Promise<EnqueuedShipOrder> {
    const issue = this.deps.issues.get(input.issueId)
    this.deps.authorization.authorize({
      principal: input.principal,
      action: 'enqueue',
      issue,
      overrideScope: input.overrideScope,
    })
    const requestedBy = this.deps.authorization.attribution(input.principal)
    const existing = this.deps.repository.activeOrderForIssue(issue.id)
    if (!existing) this.assertAdmission(issue)
    else if (issue.stage !== 'shipping') {
      throw new Error(`issue ${issue.id} has an active shipping order outside shipping custody`)
    }
    const repoId = issue.repoId
    if (!repoId) {
      throw new ShippingAdmissionError('missing-repository', `issue ${issue.id} has no repository`)
    }
    const policy = this.deps.policy.resolve(issue)
    const machineId = this.deps.machineFor(issue)
    const validationProfile = {
      ...policy.validationProfile,
      resourceLocks: [...new Set(policy.validationProfile.resourceLocks)].sort(),
    }
    const validationProfileDigest = createHash('sha256')
      .update(JSON.stringify(validationProfile))
      .digest('hex')
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
    const deliveryDependsOn =
      existing?.deliveryDependsOn ??
      (await this.deliveryDependencies(
        issue,
        repoId,
        policy.destination,
        policy.targetBranch,
        currentSourceHead,
        policy.deliveryDependsOn,
      ))
    const descendants = this.deps.issues.children(issue.id, true)
    const incomplete = descendants.filter((child) => child.stage !== 'done')
    if (incomplete.length > 0) {
      const firstIncomplete = incomplete[0]
      throw new ShippingAdmissionError(
        'descendant-incomplete',
        `shipping requires every descendant complete (${
          firstIncomplete?.displayRef ?? firstIncomplete?.id ?? 'unknown'
        })`,
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
    if (existing) {
      let replayManifest: DescendantTip[] = []
      let replayReceipt: ShipOrder['currentIntegrationReceipt']
      const receipt = this.deps.evidence.rootIntegrationReceipt(issue.id, currentSourceHead)
      if (
        descendantManifest.length > 0 &&
        (!receipt ||
          !integrationReceiptMatchesOrder(receipt, {
            issueId: issue.id,
            approvedHeadSha: currentSourceHead,
            descendantManifest,
          }))
      ) {
        throw new ShippingAdmissionError(
          'evidence',
          'the active shipping order no longer has its exact immutable integration receipt',
        )
      }
      replayManifest = descendantManifest
      replayReceipt = receipt ?? undefined
      const candidate: ShipOrder = {
        id: asShipOrderId(`ship_${randomUUID()}`),
        issueId: issue.id,
        descendantManifest: replayManifest,
        repoId,
        repoPath: issue.repoPath,
        machineId,
        targetBranch: policy.targetBranch,
        destination: policy.destination,
        approvedBaseSha: input.approved.sourceBaseSha,
        approvedHeadSha: input.approved.sourceHeadSha,
        deliveryDependsOn,
        ...(input.approved.evidenceManifestRef
          ? { evidenceManifestRef: input.approved.evidenceManifestRef }
          : {}),
        ...(replayReceipt ? { currentIntegrationReceipt: replayReceipt } : {}),
        ...(policy.providerRef ? { providerRef: policy.providerRef } : {}),
        requestedBy,
        requestedAt: existing.requestedAt,
        policyId: policy.id,
        validationProfile,
        validationProfileDigest,
        closeMode: policy.closeMode,
        state: existing.state,
        stateChangedAt: existing.stateChangedAt,
        ...(existing.holdCode ? { holdCode: existing.holdCode } : {}),
      }
      if (sameFrozenShipOrder(existing, candidate)) {
        await this.assertLiveAdmissionSnapshot(
          issue,
          policy.targetBranch,
          currentSourceHead,
          currentTargetHead,
          descendantManifest,
        )
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
    const currentIntegrationReceipt = this.deps.evidence.rootIntegrationReceipt(
      issue.id,
      currentSourceHead,
    )
    if (
      descendantManifest.length > 0 &&
      (!currentIntegrationReceipt ||
        !integrationReceiptMatchesOrder(currentIntegrationReceipt, {
          issueId: issue.id,
          approvedHeadSha: currentSourceHead,
          descendantManifest,
        }))
    ) {
      throw new ShippingAdmissionError(
        'evidence',
        'integration receipt does not describe the current root and descendant tips',
      )
    }
    const at = this.now()
    const order: ShipOrder = {
      id: asShipOrderId(`ship_${randomUUID()}`),
      issueId: issue.id,
      descendantManifest,
      repoId,
      repoPath: issue.repoPath,
      machineId,
      targetBranch: policy.targetBranch,
      destination: policy.destination,
      approvedBaseSha: input.approved.sourceBaseSha,
      approvedHeadSha: input.approved.sourceHeadSha,
      deliveryDependsOn,
      ...(input.approved.evidenceManifestRef
        ? { evidenceManifestRef: input.approved.evidenceManifestRef }
        : {}),
      ...(currentIntegrationReceipt ? { currentIntegrationReceipt } : {}),
      ...(policy.providerRef ? { providerRef: policy.providerRef } : {}),
      requestedBy,
      requestedAt: at,
      policyId: policy.id,
      validationProfile,
      validationProfileDigest,
      closeMode: policy.closeMode,
      state: 'queued',
      stateChangedAt: at,
    }
    await this.assertLiveAdmissionSnapshot(
      issue,
      policy.targetBranch,
      currentSourceHead,
      currentTargetHead,
      descendantManifest,
    )
    const displaced = this.deps.repository.activeTrainsForLane(order)
    const displacedMembers = [
      ...new Map(
        displaced
          .flatMap((manifest) =>
            manifest.members.map((member) => this.requiredOrder(member.orderId)),
          )
          .filter((member) => member.issueId !== issue.id)
          .map((member) => [member.id, member]),
      ).values(),
    ]
    let admission: { order: ShipOrder; created: boolean }
    try {
      admission = this.deps.issues.shippingCommitMany(
        [
          {
            id: issue.id,
            mutation: {
              expectedStage: ['review', 'shipping'] as const,
              nextStage: 'shipping' as const,
              shipOrderChanges: () => this.projectionSpecs(),
              event: (result: unknown) =>
                (result as { created: boolean }).created
                  ? {
                      kind: 'issue.shipping_enqueued',
                      payload: {
                        orderId: order.id,
                        destination: order.destination,
                        evidenceManifestRef: input.approved.evidenceManifestRef ?? null,
                        integrationReceiptHeadSha:
                          currentIntegrationReceipt?.approvedHeadSha ?? null,
                        requestedBy: order.requestedBy,
                        overrideScope: input.overrideScope,
                        previewLeaseIds: input.approved.previewLeaseIds,
                      },
                    }
                  : undefined,
            },
          },
          ...displacedMembers.map((member) => ({
            id: member.issueId,
            mutation: {
              expectedStage: 'shipping' as const,
              needsHuman: member.state !== 'preflight',
              shipOrderChanges: () => this.projectionSpecs(),
              event: () => {
                const hold = this.deps.repository.openHoldForOrder(member.id)
                return hold
                  ? {
                      kind: 'issue.ship_hold_raised',
                      payload: {
                        orderId: member.id,
                        holdId: hold.id,
                        generation: hold.generation,
                        reasonCode: hold.reasonCode,
                        actions: hold.actions,
                      },
                    }
                  : {
                      kind: 'issue.shipping_train_reset',
                      payload: { orderId: member.id, reason: 'lane-enqueue' },
                    }
              },
            },
          })),
        ],
        () => {
          const live = this.deps.issues.get(issue.id)
          if (this.deps.policy.resolve(live).id !== policy.id) {
            throw new ShippingAdmissionError('policy', 'repository shipping policy changed')
          }
          const receipt = this.deps.evidence.rootIntegrationReceipt(issue.id, currentSourceHead)
          if (
            (descendantManifest.length > 0 &&
              (!receipt ||
                !integrationReceiptMatchesOrder(receipt, {
                  issueId: issue.id,
                  approvedHeadSha: currentSourceHead,
                  descendantManifest,
                }))) ||
            JSON.stringify(receipt ?? null) !== JSON.stringify(currentIntegrationReceipt ?? null)
          ) {
            throw new ShippingAdmissionError(
              'evidence',
              'integration receipt changed before shipping custody committed',
            )
          }
          const result = this.deps.repository.createOrReturnActiveOrder({
            ...order,
            ...(receipt ? { currentIntegrationReceipt: receipt } : {}),
          })
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
    return shippingQueue(
      this.deps.repository.listOrders(),
      this.deps.repository.listReceipts(),
      Date.parse(this.now()),
      this.turnSamples(),
    )
  }

  heartbeat(orderId: ShipOrderId, attemptId: ShipAttempt['id'], generation: number): boolean {
    const current = this.leases.get(orderId)
    if (!current || current.attemptId !== attemptId || current.generation !== generation)
      return false
    current.expiresAt = Date.now() + LEASE_MS
    return true
  }

  async tick(): Promise<void> {
    // SINGLE-FLIGHT ON THE PASS (POD-3258). `admissionsInFlight` and `inFlight`
    // fence the ADMISSION, not the pass that decides it, and everything before
    // the first admission already awaits: the covered-prefix recovery, the order
    // read, the schedule build. Two ticks overlapping both build a schedule from
    // the same pre-admission snapshot and both pick the same head order; the
    // custody check in `runOrder` is then the only thing between them and a
    // double admission. Skipped, not queued: the schedule is recomputed from
    // durable order state every pass, so a dropped tick decides the same queue
    // one interval later.
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runTick()
    } finally {
      this.ticking = false
    }
  }

  private async runTick(): Promise<void> {
    if (this.admissionsInFlight > 0) return
    await this.recoverCoveredPrefixes()
    const now = Date.now()
    const orders = await this.ordersWithNativeStackEdges()
    const schedule = shippingSchedule(
      orders,
      this.deps.repository.listReceipts(),
      Date.parse(this.now()),
      this.turnSamples(),
    )
    const trains = [...schedule.trains].sort(
      (left, right) =>
        right.orders.length - left.orders.length ||
        left.orders[0]!.requestedAt.localeCompare(right.orders[0]!.requestedAt) ||
        left.id.localeCompare(right.id),
    )
    let next: ShipOrder | undefined
    let coveredPrefix: ShipOrder[] = []
    for (const train of trains) {
      const available = train.orders.filter((order) => !this.inFlight.has(order.id))
      if (available.length === 0) continue
      const tail = available.at(-1)!
      if (
        available.length > 1 &&
        (await this.claimableExactPrefix({ ...train, orders: available }))
      ) {
        this.claimDurableTrain({ ...train, orders: available })
        next = tail
        coveredPrefix = available.slice(0, -1)
      } else {
        next = available[0]
      }
      break
    }
    next ??= schedule.entries.find(({ order, blockedBy }) => {
      if (blockedBy.length > 0 || this.inFlight.has(order.id)) return false
      if (order.state === 'queued') return true
      if (order.state === 'held' || order.state === 'shipped' || order.state === 'cancelled') {
        return false
      }
      const lease = this.leases.get(order.id)
      return !lease || lease.expiresAt <= now
    })?.order
    if (next) await this.runOrder(next.id, coveredPrefix)
  }

  /** Boot/reconnect reconciliation. Every active state is resumed from durable
   * order/attempt/step and daemon-journal truth; no originating session exists
   * in this API. */
  async reconcile(): Promise<void> {
    this.deps.ledger.reconcile('shipOrder', this.currentProjectionRows())
    await this.recoverDescendantInvalidations()
    for (const order of this.deps.repository.listOrders()) {
      await this.replayDaemonAcknowledgements(order)
      await this.replayRepairAcknowledgement(order)
      if (order.state === 'shipped' || order.state === 'cancelled' || order.state === 'held')
        continue
      if (order.state === 'queued') continue
      const train = this.deps.repository.activeTrainForOrder(order.id)
      if (train && train.leaderOrderId !== order.id) continue
      const prefix = train
        ? train.members
            .filter((member) => member.orderId !== order.id)
            .map((member) => this.requiredOrder(member.orderId))
        : []
      await this.runOrder(order.id, prefix)
    }
    await this.tick()
  }

  async runOrder(orderId: ShipOrderId, coveredPrefix: readonly ShipOrder[] = []): Promise<void> {
    const custodyIds = [orderId, ...coveredPrefix.map((order) => order.id)]
    if (custodyIds.some((id) => this.inFlight.has(id))) return
    for (const id of custodyIds) this.inFlight.add(id)
    try {
      let order = this.requiredOrder(orderId)
      if (order.state === 'held' || order.state === 'shipped' || order.state === 'cancelled') return
      let attempt = this.latestAttempt(order)
      if (
        attempt &&
        !attempt.finishedAt &&
        this.deps.repository.hasCancellationIntent(attempt.id, attempt.leaseGeneration)
      ) {
        await this.settleCancellation(order, attempt, this.deps.issues.get(order.issueId))
        return
      }
      const lease = attempt ? this.leases.get(order.id) : undefined
      if (!attempt || attempt.finishedAt) {
        const claimed = this.claimAttempt(order, attempt)
        order = claimed.order
        attempt = claimed.attempt
      } else if (
        !lease ||
        lease.attemptId !== attempt.id ||
        lease.generation !== attempt.leaseGeneration ||
        lease.expiresAt <= Date.now()
      ) {
        // The durable attempt remains the winner across a server restart or an
        // RPC deadline. Reconstituting its lease lets the daemon replay/observe
        // the same generation and proof chain instead of abandoning a commit
        // that may already have crossed an external effect boundary.
        this.leases.set(order.id, {
          attemptId: attempt.id,
          generation: attempt.leaseGeneration,
          expiresAt: Date.now() + LEASE_MS,
        })
      }
      const issue = this.deps.issues.get(order.issueId)
      const policy = this.deps.policy.resolve(issue)
      const liveValidationProfile = {
        ...policy.validationProfile,
        resourceLocks: [...new Set(policy.validationProfile.resourceLocks)].sort(),
      }
      const liveValidationDigest = createHash('sha256')
        .update(JSON.stringify(liveValidationProfile))
        .digest('hex')

      if (
        policy.id !== order.policyId ||
        policy.validationProfile.id !== policy.validationProfileId ||
        (order.validationProfileDigest !== undefined &&
          order.validationProfileDigest !== liveValidationDigest)
      ) {
        await this.hold(
          order,
          attempt,
          'policy-refused',
          'Shipping policy changed',
          'Repository policy or its named validation profile changed after approval.',
        )
        return
      }

      if (order.state === 'preflight') {
        if (this.deps.issues.takeBranchCustody) {
          const custody = await this.deps.issues.takeBranchCustody(issue)
          if (!custody.ok) {
            await this.hold(
              order,
              attempt,
              'policy:branch-custody',
              'Source branch custody is not available',
              custody.detail,
            )
            return
          }
        }
        const result = await this.runEffect(order, attempt, issue, 'preflight', 'composing')
        if (result?.state !== 'succeeded') return
        order = this.requiredOrder(order.id)
      }
      if (order.state === 'composing') {
        const prefixRefusal = this.reauthorizePrefix(
          coveredPrefix,
          attempt.machineId,
          'prepare-merge-group',
        )
        if (prefixRefusal) {
          await this.hold(
            order,
            attempt,
            'policy-refused',
            'Train authorization changed',
            prefixRefusal,
          )
          return
        }
        const result = await this.runEffect(
          order,
          attempt,
          issue,
          'prepare-merge-group',
          'validating',
        )
        if (result?.state !== 'succeeded') return
        order = this.requiredOrder(order.id)
      }
      if (order.state === 'repairing') {
        const result = await this.runEffect(order, attempt, issue, 'apply-repair', 'composing')
        if (result?.state !== 'succeeded') return
        order = this.requiredOrder(order.id)
      }
      if (order.state === 'validating') {
        const prefixRefusal = this.reauthorizePrefix(coveredPrefix, attempt.machineId, 'validate')
        if (prefixRefusal) {
          await this.hold(
            order,
            attempt,
            'policy-refused',
            'Train authorization changed',
            prefixRefusal,
          )
          return
        }
        const names = order.validationProfile?.resourceLocks ?? liveValidationProfile.resourceLocks
        const resourceLease = this.acquireResources(
          order,
          attempt,
          issue,
          names,
          Math.ceil(
            (order.validationProfile?.timeoutMs ?? liveValidationProfile.timeoutMs) / 1000,
          ) + 30,
        )
        if (!resourceLease) return
        try {
          const result = await this.runEffect(
            order,
            attempt,
            issue,
            'validate',
            'landing',
            resourceLease,
          )
          if (result?.state !== 'succeeded') return
          order = this.requiredOrder(order.id)
        } finally {
          this.releaseResources(order, attempt, issue, names, resourceLease)
        }
      }

      if (order.state === 'landing') {
        if (coveredPrefix.length > 0 && !(await this.trainPrefixStillExact(coveredPrefix, order))) {
          await this.hold(
            order,
            attempt,
            'approval-stale',
            'A train prefix changed',
            'An approved dependency moved after shared validation; the train was invalidated before landing.',
          )
          return
        }
        const prefixRefusal = this.reauthorizePrefix(
          coveredPrefix,
          attempt.machineId,
          'commit-merge-group',
        )
        if (prefixRefusal) {
          await this.hold(
            order,
            attempt,
            'policy-refused',
            'Train authorization changed',
            prefixRefusal,
          )
          return
        }
        const mergeLock = [`merge:${order.targetBranch}`]
        const resourceLease = this.acquireResources(order, attempt, issue, mergeLock, 120)
        if (!resourceLease) return
        try {
          const result = await this.runEffect(
            order,
            attempt,
            issue,
            'commit-merge-group',
            'publishing',
            resourceLease,
          )
          if (result?.state !== 'succeeded') return
          order = this.requiredOrder(order.id)
        } finally {
          this.releaseResources(order, attempt, issue, mergeLock, resourceLease)
        }
      }
      if (order.state === 'publishing') {
        const prefixRefusal = this.reauthorizePrefix(coveredPrefix, attempt.machineId, 'publish')
        if (prefixRefusal) {
          await this.hold(
            order,
            attempt,
            'policy-refused',
            'Train authorization changed',
            prefixRefusal,
          )
          return
        }
        const publicationLock = [this.publicationLockName(order)]
        const resourceLease = this.acquireResources(order, attempt, issue, publicationLock, 120)
        if (!resourceLease) return
        try {
          const result = await this.runEffect(
            order,
            attempt,
            issue,
            'publish',
            'verifying',
            resourceLease,
          )
          if (result?.state !== 'succeeded') return
          order = this.requiredOrder(order.id)
        } finally {
          this.releaseResources(order, attempt, issue, publicationLock, resourceLease)
        }
      }
      if (order.state === 'verifying') {
        const result = await this.runEffect(order, attempt, issue, 'verify')
        if (result?.state !== 'succeeded') return
        const destinationSha = result.observedDestinationSha
        const testedIntegrationSha = result.testedIntegrationSha
        const landedRefSha = result.landedRefSha
        if (
          !destinationSha ||
          !testedIntegrationSha ||
          !landedRefSha ||
          result.validationProfileId !==
            (order.validationProfile?.id ?? policy.validationProfileId) ||
          result.validationResult !== 'passed'
        ) {
          await this.hold(
            order,
            attempt,
            'destination-mismatch',
            'Destination proof is incomplete',
            result.summary,
            result.artifactRefs,
            this.effectCommit(order, attempt, 'verify', result),
          )
          return
        }
        const finishedAt = this.now()
        const leaderResultCommitSha =
          result.trainProofs?.find((proof) => proof.orderId === order.id)?.resultCommitSha ??
          landedRefSha
        const receipt: DeliveryReceipt = {
          id: asDeliveryReceiptId(`receipt_${order.id}`),
          orderId: order.id,
          approvedBaseSha: order.approvedBaseSha,
          approvedHeadSha: order.approvedHeadSha,
          resultCommitSha: leaderResultCommitSha,
          testedIntegrationSha,
          landedRefSha,
          destinationSha,
          validationProfileId: result.validationProfileId,
          validationResult: 'passed',
          destination: order.destination,
          completedAt: finishedAt,
        }
        const coveredSettlements = coveredPrefix.flatMap((covered) => {
          const live = this.deps.repository.getOrder(covered.id)
          const proof = result.trainProofs?.find((candidate) => candidate.orderId === covered.id)
          if (
            !live ||
            live.state !== 'preflight' ||
            !proof ||
            proof.sourceApprovedSha !== live.approvedHeadSha ||
            !proof.resultCommitSha ||
            !proof.testedIntegrationSha ||
            !proof.landedRefSha ||
            !proof.providerLandedRefSha ||
            !proof.destinationSha
          ) {
            return []
          }
          const coveredReceipt: DeliveryReceipt = {
            id: asDeliveryReceiptId(`receipt_${live.id}`),
            orderId: live.id,
            approvedBaseSha: live.approvedBaseSha,
            approvedHeadSha: live.approvedHeadSha,
            resultCommitSha: proof.resultCommitSha,
            testedIntegrationSha,
            landedRefSha,
            destinationSha,
            validationProfileId: result.validationProfileId!,
            validationResult: 'passed',
            destination: live.destination,
            completedAt: finishedAt,
          }
          return [{ order: live, receipt: coveredReceipt }]
        })
        if (coveredSettlements.length !== coveredPrefix.length) {
          await this.hold(
            order,
            attempt,
            'approval-stale',
            'Train membership changed before settlement',
            'The verified train proof no longer covers every claimed immutable prefix member.',
            result.artifactRefs,
            this.effectCommit(order, attempt, 'verify', result),
          )
          return
        }
        const landingTrain = this.deps.repository.trainManifestForAttempt(attempt.id)
        const descendantInvalidations = await this.planStaleDescendants(
          [order, ...coveredSettlements.map((covered) => covered.order)],
          destinationSha,
        )
        this.deps.beforeCompletionCommit?.(receipt)
        for (const covered of coveredSettlements) {
          this.deps.beforeCompletionCommit?.(covered.receipt)
        }
        try {
          this.deps.issues.shippingCommitMany(
            [
              {
                id: order.issueId,
                mutation: {
                  expectedStage: 'shipping' as const,
                  nextStage: 'done' as const,
                  needsHuman: false,
                  shipOrderChanges: () => this.projectionSpecs(),
                  event: {
                    kind: 'issue.shipped',
                    payload: { orderId: order.id, receiptId: receipt.id },
                  },
                },
              },
              ...coveredSettlements.map((covered) => ({
                id: covered.order.issueId,
                mutation: {
                  expectedStage: 'shipping' as const,
                  nextStage: 'done' as const,
                  needsHuman: false,
                  shipOrderChanges: () => this.projectionSpecs(),
                  event: {
                    kind: 'issue.shipped',
                    payload: {
                      orderId: covered.order.id,
                      receiptId: covered.receipt.id,
                      coveredBy: order.id,
                    },
                  },
                },
              })),
              ...descendantInvalidations.map(({ order: descendant, hold, invalidatedBy }) => ({
                id: descendant.issueId,
                mutation: {
                  expectedStage: 'shipping' as const,
                  needsHuman: true,
                  shipOrderChanges: () => this.projectionSpecs(),
                  event: {
                    kind: 'issue.ship_hold_raised' as const,
                    payload: {
                      orderId: descendant.id,
                      holdId: hold.id,
                      generation: hold.generation,
                      reasonCode: hold.reasonCode,
                      actions: hold.actions,
                      invalidatedBy,
                    },
                  },
                },
              })),
            ],
            () =>
              this.deps.repository.completeVerifiedTrain({
                leader: {
                  orderId: order.id,
                  expectedState: 'verifying',
                  attemptId: attempt.id,
                  generation: attempt.leaseGeneration,
                  ...this.effectCommit(order, attempt, 'verify', result),
                  outcome: {
                    kind: 'verified',
                    receipt,
                    attemptFinishedAt: finishedAt,
                  },
                },
                covered: coveredSettlements.map((covered) => ({
                  receipt: covered.receipt,
                  coveringOrderId: order.id,
                  effectEnvelopeKey: `${result.jobId}:${result.requestDigest}`,
                })),
                invalidations: descendantInvalidations.map(({ hold }) => hold),
                ...(landingTrain
                  ? {
                      release: {
                        trainId: landingTrain.id,
                        releasedAt: finishedAt,
                        reason: 'landed',
                      },
                    }
                  : {}),
              }),
          )
        } catch (error) {
          if (this.isEffectCustodyRefusal(error)) return
          throw error
        }
        await this.acknowledgeEffect(order, attempt, issue, 'verify')
        this.audit('shipping.order_shipped', order.issueId, {
          orderId: order.id,
          receiptId: receipt.id,
        })
        this.leases.delete(order.id)
        for (const covered of coveredSettlements) {
          this.audit('shipping.order_shipped', covered.order.issueId, {
            orderId: covered.order.id,
            receiptId: covered.receipt.id,
            coveredBy: order.id,
          })
          this.leases.delete(covered.order.id)
        }
      }
    } finally {
      for (const id of custodyIds) this.inFlight.delete(id)
    }
  }

  async cancel(input: CancelShipOrderInput): Promise<ShipOrder> {
    const { order, issue } = this.authorizedOrder(
      input.orderId,
      input.principal,
      'cancel',
      input.overrideScope,
    )
    if (order.state === 'held') {
      const hold = this.deps.repository.openHoldForOrder(order.id)
      if (!hold) throw new Error(`held shipping order ${order.id} has no open hold`)
      return (
        await this.resolveHold({
          orderId: order.id,
          action: 'return-to-issue',
          expectedGeneration: hold.generation,
          principal: input.principal,
          overrideScope: input.overrideScope,
        })
      ).order
    }
    if (!['queued', 'preflight', 'composing', 'validating', 'repairing'].includes(order.state)) {
      throw new Error(`shipping order ${order.id} can no longer be safely cancelled`)
    }
    const activeTrain = this.deps.repository.activeTrainForOrder(order.id)
    const activeLeader = activeTrain ? this.requiredOrder(activeTrain.leaderOrderId) : undefined
    if (
      activeLeader &&
      !['preflight', 'composing', 'validating', 'repairing'].includes(activeLeader.state)
    ) {
      throw new Error(
        `shipping train ${activeTrain!.id} crossed its reversible cancellation boundary`,
      )
    }
    const latestAttempt = this.latestAttempt(order)
    const attempt = latestAttempt?.finishedAt ? null : latestAttempt
    if (attempt) {
      const intentMember = activeTrain?.members.find(
        (member) => member.orderId === activeTrain.leaderOrderId,
      )
      const intentOrder = intentMember ? this.requiredOrder(intentMember.orderId) : order
      const intentAttempt = intentMember
        ? this.deps.repository.getAttempt(intentMember.attemptId)
        : attempt
      if (!intentAttempt || intentAttempt.finishedAt) {
        throw new Error(`shipping cancellation has no live leader custody`)
      }
      const intentKey = `cancel:${intentAttempt.leaseGeneration}`
      const intentStartedAt = this.now()
      const summary = cancellationSummary(order.id, activeTrain?.id)
      this.deps.repository.requestCancellation({
        orderId: intentOrder.id,
        expectedState: intentOrder.state,
        attemptId: intentAttempt.id,
        generation: intentAttempt.leaseGeneration,
        planned: {
          ...this.step(intentOrder, intentAttempt, intentKey, 'cancel', 'planned', intentStartedAt),
          summary,
        },
        running: {
          ...this.step(intentOrder, intentAttempt, intentKey, 'cancel', 'running', intentStartedAt),
          summary,
        },
      })
      await this.settleCancellation(
        intentOrder,
        intentAttempt,
        intentOrder.id === order.id ? issue : this.deps.issues.get(intentOrder.issueId),
      )
      return this.requiredOrder(order.id)
    }
    const at = this.now()
    const cancellationMembers = activeTrain
      ? activeTrain.members.map((member) => this.requiredOrder(member.orderId))
      : [order]
    const result = this.deps.issues.shippingCommitMany(
      cancellationMembers.map((member) => ({
        id: member.issueId,
        mutation:
          member.id === order.id
            ? {
                expectedStage: 'shipping' as const,
                nextStage: 'review' as const,
                needsHuman: false,
                shipOrderChanges: () => this.projectionSpecs(),
                event: {
                  kind: 'issue.shipping_cancelled',
                  payload: { orderId: order.id },
                },
              }
            : {
                expectedStage: 'shipping' as const,
                needsHuman: member.state !== 'preflight',
                shipOrderChanges: () => this.projectionSpecs(),
                event: () => {
                  const sibling = this.requiredOrder(member.id)
                  const hold = this.deps.repository.openHoldForOrder(member.id)
                  return hold
                    ? {
                        kind: 'issue.ship_hold_raised',
                        payload: {
                          orderId: member.id,
                          holdId: hold.id,
                          generation: hold.generation,
                          reasonCode: hold.reasonCode,
                          actions: hold.actions,
                        },
                      }
                    : {
                        kind: 'issue.shipping_train_reset',
                        payload: { orderId: sibling.id, cancelledPeer: order.id },
                      }
                },
              },
      })),
      () => {
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

  private async settleCancellation(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
  ): Promise<ShipOrder> {
    const intentKey = `cancel:${attempt.leaseGeneration}`
    const intent = this.deps.repository.latestStepForEffect(attempt.id, intentKey)
    if (!intent || (intent.state !== 'planned' && intent.state !== 'running')) {
      throw new Error(`ship order ${order.id} has no unsettled durable cancellation intent`)
    }
    const targetOrder = this.requiredOrder(cancellationTarget(intent.summary) ?? order.id)
    const terminalSteps: ShipStep[] = []
    const train = this.deps.repository.activeTrainForOrder(order.id)
    const trainLeader = train
      ? train.members.find((member) => member.orderId === train.leaderOrderId)
      : undefined
    const executionOrder = trainLeader ? this.requiredOrder(trainLeader.orderId) : order
    const executionAttempt = trainLeader
      ? this.deps.repository.getAttempt(trainLeader.attemptId)
      : attempt
    if (trainLeader && (!executionAttempt || executionAttempt.finishedAt)) {
      throw new Error(`ship train ${train!.id} has no live leader cancellation custody`)
    }
    const effectAttempt = executionAttempt ?? attempt
    const executionIssue =
      executionOrder.id === order.id ? issue : this.deps.issues.get(executionOrder.issueId)
    const operation = this.operationFor(executionOrder.state)
    if (operation) {
      try {
        this.deps.authorization.reauthorize({
          order: executionOrder,
          issue: executionIssue,
          machineId: effectAttempt.machineId,
          effect: 'cancel',
        })
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error)
        await this.hold(
          order,
          attempt,
          'policy-refused',
          'Shipping cancellation authorization changed',
          summary,
          [],
          undefined,
          this.cancellationFailure(order, attempt, intentKey, 'authorization-refused', summary),
        )
        return this.requiredOrder(order.id)
      }
      let result: ShippingJobResult
      try {
        result = await this.deps.daemon.shippingJob(
          this.jobInput(executionOrder, effectAttempt, executionIssue, operation, 'cancel'),
          effectAttempt.machineId,
        )
        this.assertJobResultFence(executionOrder, effectAttempt, operation, result)
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error)
        await this.hold(
          order,
          attempt,
          'machine-unavailable',
          'Shipping cancellation could not be dispatched',
          summary,
          [],
          undefined,
          this.cancellationFailure(order, attempt, intentKey, 'cancel-error', summary),
        )
        return this.requiredOrder(order.id)
      }
      if (result.state !== 'cancelled' && result.state !== 'succeeded') {
        await this.hold(
          order,
          attempt,
          'machine-unavailable',
          'Shipping cancellation could not be settled',
          result.summary,
          result.artifactRefs,
          undefined,
          this.cancellationFailure(
            order,
            attempt,
            intentKey,
            result.classification,
            result.summary,
          ),
        )
        return this.requiredOrder(order.id)
      }
      const effectKey = this.effectKeyFor(effectAttempt, operation)
      const latest = this.deps.repository.latestStepForEffect(effectAttempt.id, effectKey)
      if (latest && !terminalStep(latest)) {
        const finishedAt = result.finishedAt ?? this.now()
        terminalSteps.push({
          ...this.step(
            executionOrder,
            effectAttempt,
            effectKey,
            operation,
            'cancelled',
            latest.startedAt ?? finishedAt,
          ),
          outcome: result.classification,
          summary: result.summary,
          finishedAt,
          ...(result.artifactRefs[0] ? { artifactRef: result.artifactRefs[0] } : {}),
        })
      }
    }
    const liveIntent = this.deps.repository.latestStepForEffect(attempt.id, intentKey)
    if (!liveIntent || (liveIntent.state !== 'planned' && liveIntent.state !== 'running')) {
      throw new Error(`ship order ${order.id} lost durable cancellation intent`)
    }
    const at = this.now()
    terminalSteps.push({
      ...this.step(order, attempt, intentKey, 'cancel', 'succeeded', liveIntent.startedAt ?? at),
      outcome: 'cancelled',
      summary: 'shipping cancellation settled before custody release',
      finishedAt: at,
    })
    const cancellationMembers = train
      ? train.members.map((member) => this.requiredOrder(member.orderId))
      : [targetOrder]
    const result = this.deps.issues.shippingCommitMany(
      cancellationMembers.map((member) => ({
        id: member.issueId,
        mutation:
          member.id === targetOrder.id
            ? {
                expectedStage: 'shipping' as const,
                nextStage: 'review' as const,
                needsHuman: false,
                shipOrderChanges: () => this.projectionSpecs(),
                event: { kind: 'issue.shipping_cancelled', payload: { orderId: targetOrder.id } },
              }
            : {
                expectedStage: 'shipping' as const,
                needsHuman: member.state !== 'preflight',
                shipOrderChanges: () => this.projectionSpecs(),
                event: () => {
                  const hold = this.deps.repository.openHoldForOrder(member.id)
                  return hold
                    ? {
                        kind: 'issue.ship_hold_raised',
                        payload: {
                          orderId: member.id,
                          holdId: hold.id,
                          generation: hold.generation,
                          reasonCode: hold.reasonCode,
                          actions: hold.actions,
                        },
                      }
                    : {
                        kind: 'issue.shipping_train_reset',
                        payload: { orderId: member.id, cancelledPeer: targetOrder.id },
                      }
                },
              },
      })),
      () =>
        this.deps.repository.cancelAttemptAndOrder(
          targetOrder.id,
          targetOrder.state as Extract<
            ShipOrderState,
            'queued' | 'preflight' | 'composing' | 'validating' | 'repairing'
          >,
          at,
          {
            attemptId: attempt.id,
            generation: attempt.leaseGeneration,
            terminalSteps,
          },
        ),
    ).result
    this.leases.delete(targetOrder.id)
    return result
  }

  async resolveHold(input: ResolveShipHoldInput): Promise<ResolvedShipHold> {
    const { orderId, action, expectedGeneration } = input
    const { order, issue } = this.authorizedOrder(
      orderId,
      input.principal,
      'resolve-hold',
      input.overrideScope === true,
    )
    const requestedBy = this.deps.authorization.attribution(input.principal)
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
    let openedRepair:
      | {
          candidate: StoredShippingRepairCandidate
          decision: Extract<ShippingRepairDecision, { kind: 'patched' }>
        }
      | undefined
    if (action === 'open-repair') {
      const repair = this.deps.repair
      const attempt = this.deps.repository.latestAttemptForOrder(order.id)
      const marker = attempt
        ? this.deps.repository
            .stepsForAttempt(attempt.id)
            .map((step) => parseRepairMarker(step.summary))
            .findLast((candidate) => candidate !== null)
        : null
      if (!repair || !attempt || attempt.finishedAt || !marker) {
        throw new Error(`ship hold ${hold.id} has no live repair context`)
      }
      const context = marker.context
      if (
        context.order.id !== order.id ||
        context.attempt.id !== attempt.id ||
        context.attempt.leaseGeneration !== attempt.leaseGeneration ||
        context.custody.attemptId !== attempt.id ||
        context.custody.generation !== attempt.leaseGeneration
      ) {
        throw new Error(`ship hold ${hold.id} repair context custody changed`)
      }
      const decision = await repair.consider(context)
      if (decision.kind !== 'patched') {
        throw new Error(`ship hold ${hold.id} did not produce an immutable repair candidate`)
      }
      openedRepair = {
        candidate: this.durableRepairCandidate(order, attempt, context, decision, at),
        decision,
      }
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
          payload: {
            orderId: order.id,
            action,
            generation: expectedGeneration,
          },
        },
      },
      () => {
        this.deps.repository.resolveHold(
          order.id,
          expectedGeneration,
          action,
          nextState,
          at,
          openedRepair?.candidate,
        )
        return this.requiredOrder(order.id)
      },
    ).result
    if (openedRepair && this.deps.repair) {
      this.deps.beforeRepairAcknowledge?.(openedRepair.decision.resultToken)
      await this.deps.repair.acknowledge({
        resultToken: openedRepair.decision.resultToken,
        orderId: order.id,
        attemptId: openedRepair.candidate.attemptId,
        generation: openedRepair.candidate.generation,
        contextDigest: openedRepair.candidate.contextDigest,
        candidate: {
          repairRef: openedRepair.candidate.repairRef,
          candidateHeadSha: openedRepair.candidate.candidateHeadSha,
        },
      })
    }
    this.audit('shipping.hold_resolved', order.issueId, {
      orderId: order.id,
      action,
      generation: expectedGeneration,
      principalKind: input.principal.kind,
      requestedBy,
    })
    return { order: result, projection: this.requiredProjection(result.id) }
  }

  /** Resolve order -> delivery root and authorize before reporting whether the
   * immutable proof exists, so an opaque order id cannot become an issue oracle. */
  deliveryReceipt(input: DeliveryReceiptDetailInput): DeliveryReceipt | null {
    this.authorizedOrder(input.orderId, input.principal, 'read-receipt', false)
    return this.deps.repository.receiptForOrder(input.orderId)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const lease of this.activeResourceLeases) {
      lease.lost = true
      if (lease.timer) clearInterval(lease.timer)
    }
    this.activeResourceLeases.clear()
  }

  private async claimableExactPrefix(train: ShippingTrain): Promise<boolean> {
    const tail = train.orders.at(-1)
    if (!tail || !(await this.trainPrefixStillExact(train.orders.slice(0, -1), tail))) return false
    try {
      const tailMachine = this.deps.machineFor(this.deps.issues.get(tail.issueId))
      if (
        train.orders.length > 1 &&
        (!this.deps.machineCapabilities ||
          !this.deps.machineCapabilities(tailMachine).includes(SHIPPING_TRAIN_CAPABILITY))
      ) {
        return false
      }
      for (const order of train.orders) {
        const issue = this.deps.issues.get(order.issueId)
        if (this.deps.machineFor(issue) !== tailMachine) return false
        this.deps.authorization.reauthorize({
          order,
          issue,
          machineId: tailMachine,
          effect: 'preflight',
        })
      }
      if (this.deps.issues.takeBranchCustody) {
        for (const order of train.orders) {
          const custody = await this.deps.issues.takeBranchCustody(
            this.deps.issues.get(order.issueId),
          )
          if (!custody.ok) return false
        }
      }
      return true
    } catch (error) {
      this.audit('shipping.train_prefix_skipped', tail.issueId, {
        trainId: train.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  private claimDurableTrain(train: ShippingTrain): void {
    const startedAt = this.now()
    const result = this.deps.ledger.commit({
      write: () =>
        this.deps.repository.claimTrain({
          leaderOrderId: train.orders.at(-1)!.id,
          startedAt,
          members: train.orders.map((order) => {
            return {
              orderId: order.id,
            }
          }),
        }),
      changes: () => this.projectionSpecs(),
    }).result
    for (const { order, attempt } of result.claimed) {
      this.leases.set(order.id, {
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        expiresAt: Date.now() + LEASE_MS,
      })
    }
    this.audit('shipping.train_claimed', train.orders.at(-1)!.issueId, {
      trainId: result.manifest.id,
      members: result.manifest.members.map((member) => ({
        orderId: member.orderId,
        attemptId: member.attemptId,
        generation: member.generation,
      })),
    })
  }

  private reauthorizePrefix(
    prefix: readonly ShipOrder[],
    machineId: MachineId,
    effect: Parameters<ShippingAuthorizationPort['reauthorize']>[0]['effect'],
  ): string | null {
    try {
      for (const order of prefix) {
        this.deps.authorization.reauthorize({
          order,
          issue: this.deps.issues.get(order.issueId),
          machineId,
          effect,
        })
      }
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private async trainPrefixStillExact(
    prefix: readonly ShipOrder[],
    tail: ShipOrder,
  ): Promise<boolean> {
    const tailPolicy = this.deps.policy.resolve(this.deps.issues.get(tail.issueId))
    if (!tail.validationProfile || !tail.validationProfileDigest) return false
    for (const member of prefix) {
      const live = this.deps.repository.getOrder(member.id)
      if (!live || (live.state !== 'queued' && live.state !== 'preflight')) return false
      if (
        !member.validationProfile ||
        member.validationProfileDigest !== tail.validationProfileDigest
      ) {
        return false
      }
      if (shippingCompatibilityKey(member) !== shippingCompatibilityKey(tail)) {
        return false
      }
      const issue = this.deps.issues.get(member.issueId)
      const policy = this.deps.policy.resolve(issue)
      if (
        policy.id !== member.policyId ||
        policy.validationProfileId !== tailPolicy.validationProfileId
      ) {
        return false
      }
      if ((await this.deps.resolveBranchTip(issue)) !== member.approvedHeadSha) return false
      if (!(await this.deps.isAncestor(issue, member.approvedHeadSha, tail.approvedHeadSha))) {
        return false
      }
    }
    return true
  }

  private coveredDependencies(covering: ShipOrder): ShipOrder[] {
    const byId = new Map(this.deps.repository.listOrders().map((order) => [order.id, order]))
    const covered = new Map<ShipOrderId, ShipOrder>()
    const visit = (order: ShipOrder): void => {
      for (const id of order.deliveryDependsOn) {
        const dependency = byId.get(id)
        if (!dependency || covered.has(dependency.id)) continue
        if (
          dependency.repoId !== covering.repoId ||
          dependency.destination !== covering.destination ||
          dependency.targetBranch !== covering.targetBranch ||
          dependency.policyId !== covering.policyId
        ) {
          continue
        }
        covered.set(dependency.id, dependency)
        visit(dependency)
      }
    }
    visit(covering)
    return [...covered.values()].sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id),
    )
  }

  private async settleCoveredPrefix(
    covering: ShipOrder,
    coveringReceipt: DeliveryReceipt,
    prefix: readonly ShipOrder[],
    trainProofs: NonNullable<ShippingJobResult['trainProofs']>,
    effectEnvelopeKey: string,
  ): Promise<void> {
    const settlements: { order: ShipOrder; receipt: DeliveryReceipt }[] = []
    for (const frozen of prefix) {
      const order = this.deps.repository.getOrder(frozen.id)
      if (!order || order.state === 'shipped') continue
      if (order.state !== 'preflight') continue
      const proof = trainProofs.find((candidate) => candidate.orderId === order.id)
      if (
        !proof ||
        proof.sourceApprovedSha !== order.approvedHeadSha ||
        !proof.resultCommitSha ||
        !proof.testedIntegrationSha ||
        !proof.landedRefSha ||
        !proof.providerLandedRefSha ||
        !proof.destinationSha
      ) {
        continue
      }
      const completedAt = this.now()
      const receipt: DeliveryReceipt = {
        id: asDeliveryReceiptId(`receipt_${order.id}`),
        orderId: order.id,
        approvedBaseSha: order.approvedBaseSha,
        approvedHeadSha: order.approvedHeadSha,
        resultCommitSha: proof.resultCommitSha,
        testedIntegrationSha: coveringReceipt.testedIntegrationSha,
        landedRefSha: coveringReceipt.landedRefSha,
        destinationSha: coveringReceipt.destinationSha,
        validationProfileId: coveringReceipt.validationProfileId,
        validationResult: 'passed',
        destination: order.destination,
        completedAt,
      }
      this.deps.beforeCompletionCommit?.(receipt)
      settlements.push({ order, receipt })
    }
    if (settlements.length === 0) return
    this.deps.issues.shippingCommitMany(
      settlements.map(({ order, receipt }) => ({
        id: order.issueId,
        mutation: {
          expectedStage: 'shipping' as const,
          nextStage: 'done' as const,
          needsHuman: false,
          shipOrderChanges: () => this.projectionSpecs(),
          event: {
            kind: 'issue.shipped',
            payload: { orderId: order.id, receiptId: receipt.id, coveredBy: covering.id },
          },
        },
      })),
      () => {
        for (const { receipt } of settlements) {
          this.deps.repository.completeCoveredOrder(receipt, covering.id, effectEnvelopeKey)
        }
      },
    )
    for (const { order, receipt } of settlements) {
      this.audit('shipping.order_shipped', order.issueId, {
        orderId: order.id,
        receiptId: receipt.id,
        coveredBy: covering.id,
      })
      await this.invalidateStaleDescendants(order, coveringReceipt.destinationSha)
    }
  }

  private async recoverCoveredPrefixes(): Promise<void> {
    for (const covering of this.deps.repository.listOrders()) {
      if (covering.state !== 'shipped') continue
      const receipt = this.deps.repository.receiptForOrder(covering.id)
      const attempt = this.deps.repository.latestAttemptForOrder(covering.id)
      const manifest = attempt ? this.deps.repository.trainManifestForAttempt(attempt.id) : null
      if (!receipt || !manifest || manifest.leaderOrderId !== covering.id) continue
      const verifyStep = attempt
        ? this.deps.repository
            .stepsForAttempt(attempt.id)
            .findLast(
              (step) => step.kind === 'verify' && step.summary.startsWith(TRAIN_PROOF_MARKER),
            )
        : undefined
      const trainProofs = verifyStep
        ? (JSON.parse(verifyStep.summary.slice(TRAIN_PROOF_MARKER.length)) as NonNullable<
            ShippingJobResult['trainProofs']
          >)
        : []
      await this.settleCoveredPrefix(
        covering,
        receipt,
        manifest.members
          .filter((member) => member.orderId !== covering.id)
          .map((member) => this.requiredOrder(member.orderId)),
        trainProofs,
        attempt
          ? `${attempt.id}:verify:${
              this.jobInput(
                covering,
                attempt,
                this.deps.issues.get(covering.issueId),
                'verify',
                'status',
              ).requestDigest
            }`
          : '',
      )
      this.deps.issues.shippingCommitMany(
        manifest.members.map((member) => ({
          id: member.issueId,
          mutation: {
            expectedStage: ['shipping', 'done'] as const,
            shipOrderChanges: () => this.projectionSpecs(),
          },
        })),
        () => this.deps.repository.releaseTrain(manifest.id, receipt.completedAt, 'landed'),
      )
    }
  }

  private async planStaleDescendants(
    landedOrders: readonly ShipOrder[],
    destinationSha: string,
  ): Promise<{ order: ShipOrder; hold: ShipHold; invalidatedBy: ShipOrderId }[]> {
    const invalidating = new Set<ShipOrderId>(landedOrders.map((order) => order.id))
    const invalidatedBy = landedOrders.at(-1)?.id
    if (!invalidatedBy) return []
    const remaining = this.deps.repository.listOrders()
    const pending: { order: ShipOrder; hold: ShipHold; invalidatedBy: ShipOrderId }[] = []
    let advanced = true
    while (advanced) {
      advanced = false
      for (const order of remaining) {
        const issue = this.deps.issues.get(order.issueId)
        let causallyDepends = order.deliveryDependsOn.some((id) => invalidating.has(id))
        if (!causallyDepends && landedOrders.some((landed) => order.repoId === landed.repoId)) {
          for (const id of invalidating) {
            const predecessor = this.deps.repository.getOrder(id)
            if (
              predecessor &&
              (await this.deps.isAncestor(
                issue,
                predecessor.approvedHeadSha,
                order.approvedHeadSha,
              ))
            ) {
              causallyDepends = true
              break
            }
          }
        }
        if (order.state !== 'queued' || invalidating.has(order.id) || !causallyDepends) {
          continue
        }
        if (
          order.approvedBaseSha === destinationSha ||
          (await this.deps.isAncestor(issue, destinationSha, order.approvedBaseSha))
        ) {
          continue
        }
        const generation =
          Math.max(
            0,
            ...this.deps.repository
              .listHolds()
              .filter((hold) => hold.orderId === order.id)
              .map((hold) => hold.generation),
          ) + 1
        const raisedAt = this.now()
        const hold: ShipHold = {
          id: asShipHoldId(`hold:${order.id}:${generation}`),
          orderId: order.id,
          generation,
          reasonCode: 'approval-stale',
          headline: 'A stack dependency landed',
          detail:
            'The approved descendant was based on an older destination. Return it to review so it can be recomposed against the landed prefix.',
          evidenceRefs: [],
          actions: ['return-to-issue'],
          raisedAt,
        }
        pending.push({ order, hold, invalidatedBy })
        invalidating.add(order.id)
        advanced = true
      }
    }
    return pending
  }

  private async invalidateStaleDescendants(
    landed: ShipOrder,
    destinationSha: string,
  ): Promise<void> {
    const pending = await this.planStaleDescendants([landed], destinationSha)
    if (pending.length === 0) return
    this.deps.issues.shippingCommitMany(
      pending.map(({ order, hold, invalidatedBy }) => ({
        id: order.issueId,
        mutation: {
          expectedStage: 'shipping' as const,
          needsHuman: true,
          shipOrderChanges: () => this.projectionSpecs(),
          event: {
            kind: 'issue.ship_hold_raised',
            payload: {
              orderId: order.id,
              holdId: hold.id,
              generation: hold.generation,
              reasonCode: hold.reasonCode,
              actions: hold.actions,
              invalidatedBy,
            },
          },
        },
      })),
      () => {
        for (const { hold } of pending) this.deps.repository.raiseHold(hold)
      },
    )
  }

  private async recoverDescendantInvalidations(): Promise<void> {
    for (const landed of this.deps.repository.listOrders()) {
      if (landed.state !== 'shipped') continue
      const receipt = this.deps.repository.receiptForOrder(landed.id)
      if (receipt) await this.invalidateStaleDescendants(landed, receipt.destinationSha)
    }
  }

  private assertAdmission(issue: IssueWire): void {
    if (issue.parentId) {
      let root = this.deps.issues.get(issue.parentId)
      while (root.parentId) root = this.deps.issues.get(root.parentId)
      const issueRef = issue.displayRef ?? issue.id
      const rootRef = root.displayRef ?? root.id
      throw new ShippingAdmissionError(
        'nested-root',
        `${issueRef} is a sub-issue of delivery root ${rootRef} and cannot ship separately.\n` +
          `To nominate the approved root: podium issue ship ${rootRef} --outside-scope`,
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

  private async ordersWithNativeStackEdges(): Promise<ShipOrder[]> {
    const orders = this.deps.repository.listOrders()
    const queued = orders.filter((order) => order.state === 'queued')
    const inferred = new Map<ShipOrderId, ShipOrderId[]>()
    const discovered: { upper: ShipOrder; lowerOrderId: ShipOrderId; recordedAt: string }[] = []
    for (const upper of queued) {
      const issue = this.deps.issues.get(upper.issueId)
      const ancestors: ShipOrder[] = []
      for (const lower of queued) {
        if (
          lower.id === upper.id ||
          shippingCompatibilityKey(lower) !== shippingCompatibilityKey(upper)
        ) {
          continue
        }
        if (await this.deps.isAncestor(issue, lower.approvedHeadSha, upper.approvedHeadSha)) {
          ancestors.push(lower)
        }
      }
      const nearest: ShipOrderId[] = []
      for (const candidate of ancestors) {
        let shadowed = false
        for (const other of ancestors) {
          if (candidate.id === other.id) continue
          if (await this.deps.isAncestor(issue, candidate.approvedHeadSha, other.approvedHeadSha)) {
            shadowed = true
            break
          }
        }
        if (!shadowed) nearest.push(candidate.id)
      }
      inferred.set(upper.id, nearest)
      for (const lowerOrderId of nearest) {
        if (!this.deps.repository.hasNativeStackEdge(upper.id, lowerOrderId)) {
          discovered.push({ upper, lowerOrderId, recordedAt: this.now() })
        }
      }
    }
    if (discovered.length > 0) {
      const affected = new Map<ShipOrderId, ShipOrder>()
      for (const edge of discovered) {
        for (const manifest of this.deps.repository.activeTrainsForLane(edge.upper)) {
          for (const member of manifest.members) {
            affected.set(member.orderId, this.requiredOrder(member.orderId))
          }
        }
      }
      const write = () => {
        for (const edge of discovered) {
          this.deps.repository.recordNativeStackEdge({
            upperOrderId: edge.upper.id,
            lowerOrderId: edge.lowerOrderId,
            recordedAt: edge.recordedAt,
          })
        }
      }
      if (affected.size === 0) {
        this.deps.ledger.commit({ write, changes: () => this.projectionSpecs() })
      } else {
        this.deps.issues.shippingCommitMany(
          [...affected.values()].map((member) => ({
            id: member.issueId,
            mutation: {
              expectedStage: 'shipping' as const,
              needsHuman: member.state !== 'preflight',
              shipOrderChanges: () => this.projectionSpecs(),
              event: () => {
                const hold = this.deps.repository.openHoldForOrder(member.id)
                return hold
                  ? {
                      kind: 'issue.ship_hold_raised',
                      payload: {
                        orderId: member.id,
                        holdId: hold.id,
                        generation: hold.generation,
                        reasonCode: hold.reasonCode,
                        actions: hold.actions,
                      },
                    }
                  : {
                      kind: 'issue.shipping_train_reset',
                      payload: { orderId: member.id, reason: 'native-stack-change' },
                    }
              },
            },
          })),
          write,
        )
      }
    }
    const result = this.deps.repository.listOrders().map((order) => {
      const edges = inferred.get(order.id)
      return edges?.length
        ? {
            ...order,
            deliveryDependsOn: [...new Set([...order.deliveryDependsOn, ...edges])].sort(),
          }
        : order
    })
    return result
  }

  /** Freeze the nearest authorized native Git-stack predecessors as delivery
   * edges. Issue hierarchy remains untouched; explicit policy edges always win. */
  private async deliveryDependencies(
    issue: IssueWire,
    repoId: ShipOrder['repoId'],
    destination: string,
    targetBranch: string,
    approvedHeadSha: string,
    declared: readonly ShipOrderId[],
  ): Promise<ShipOrderId[]> {
    const candidates = this.deps.repository
      .listOrders()
      .filter(
        (order) =>
          order.issueId !== issue.id &&
          order.repoId === repoId &&
          order.destination === destination &&
          order.targetBranch === targetBranch &&
          order.state !== 'cancelled' &&
          order.state !== 'shipped',
      )
    const ancestors: ShipOrder[] = []
    for (const candidate of candidates) {
      if (await this.deps.isAncestor(issue, candidate.approvedHeadSha, approvedHeadSha)) {
        ancestors.push(candidate)
      }
    }
    const nearest: ShipOrderId[] = []
    for (const candidate of ancestors) {
      let shadowed = false
      for (const other of ancestors) {
        if (candidate.id === other.id) continue
        if (await this.deps.isAncestor(issue, candidate.approvedHeadSha, other.approvedHeadSha)) {
          shadowed = true
          break
        }
      }
      if (!shadowed && candidate.state !== 'shipped') nearest.push(candidate.id)
    }
    return [...new Set([...declared, ...nearest])].sort()
  }

  private claimAttempt(
    order: ShipOrder,
    previous: ShipAttempt | null,
  ): { order: ShipOrder; attempt: ShipAttempt } {
    const issue = this.deps.issues.get(order.issueId)
    const startedAt = this.now()
    const acquired = this.deps.ledger.commit({
      write: () =>
        this.deps.repository.claimAttempt({
          orderId: order.id,
          expectedState: order.state as Exclude<ShipOrderState, 'held' | 'shipped' | 'cancelled'>,
          expectedAttemptId: previous?.id ?? null,
          expectedGeneration: previous?.leaseGeneration ?? 0,
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
    return acquired
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
    operation: ShippingJobResult['operation'],
    nextState?: Exclude<ShipOrderState, 'held' | 'shipped'>,
    resourceLease?: ResourceLease,
  ): Promise<ShippingJobResult | null> {
    const effectKey = this.effectKeyFor(attempt, operation)
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
    if (this.deps.repository.hasCancellationIntent(attempt.id, attempt.leaseGeneration)) return null
    const lease = this.leases.get(order.id)
    if (!lease || lease.attemptId !== attempt.id || lease.generation !== attempt.leaseGeneration) {
      this.leases.set(order.id, {
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        expiresAt: Date.now() + LEASE_MS,
      })
    }
    try {
      this.deps.authorization.reauthorize({
        order,
        issue,
        machineId: attempt.machineId,
        effect: operation,
      })
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error)
      await this.hold(
        order,
        attempt,
        'policy-refused',
        'Shipping authorization changed',
        summary,
        [],
        {
          effectKey,
          operation,
          terminalStep: {
            ...this.step(order, attempt, effectKey, operation, 'failed', startedAt),
            outcome: 'authorization-refused',
            summary,
            finishedAt: this.now(),
          },
        },
      )
      return null
    }
    try {
      this.deps.repository.assertEffectDispatchCustody({
        orderId: order.id,
        expectedState: order.state,
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        effectKey,
        operation,
      })
    } catch (error) {
      if (this.isEffectCustodyRefusal(error)) return null
      throw error
    }
    if (!this.renewResourceLease(resourceLease)) {
      this.audit('shipping.resource_lease_lost', order.issueId, {
        orderId: order.id,
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        operation,
        boundary: 'before-dispatch',
      })
      return null
    }
    const request = this.jobInput(order, attempt, issue, operation, 'start')
    const result = await this.deps.daemon.shippingJob(request, attempt.machineId)
    this.assertJobResultFence(order, attempt, operation, result)
    if (!this.renewResourceLease(resourceLease)) {
      this.audit('shipping.resource_lease_lost', order.issueId, {
        orderId: order.id,
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        operation,
        boundary: 'after-effect',
      })
      return null
    }
    this.heartbeat(order.id, attempt.id, attempt.leaseGeneration)
    if (result.state === 'running') return null
    if (result.state === 'succeeded' && request.train && operation === 'verify') {
      this.deps.repository.recordEffectEnvelope({
        request,
        result,
        recordedAt: result.finishedAt ?? this.now(),
      })
    }
    const effect = this.effectCommit(order, attempt, operation, result, startedAt)
    if (result.state === 'succeeded' && nextState) {
      const changedAt = result.finishedAt ?? this.now()
      try {
        this.deps.ledger.commit({
          write: () =>
            this.deps.repository.commitEffectResult({
              orderId: order.id,
              expectedState: order.state,
              attemptId: attempt.id,
              generation: attempt.leaseGeneration,
              ...effect,
              outcome: {
                kind: 'transition',
                nextState,
                stateChangedAt: changedAt,
              },
            }),
          changes: () => this.projectionSpecs(),
        })
      } catch (error) {
        if (this.isEffectCustodyRefusal(error)) return null
        throw error
      }
      this.audit('shipping.order_state_changed', order.issueId, {
        orderId: order.id,
        from: order.state,
        to: nextState,
      })
      await this.acknowledgeEffect(order, attempt, issue, operation)
    }
    if (
      result.state === 'held' &&
      result.classification === 'validation-failed' &&
      operation === 'validate' &&
      request.train &&
      'manifest' in request.train &&
      request.train.manifest.members.length > 1 &&
      (await this.isolateValidationFailure(order, attempt, issue, result, effect, resourceLease))
    ) {
      return result
    }
    if (
      result.state === 'held' &&
      (await this.handleRepairFailure(order, attempt, issue, result, effect))
    ) {
      return result
    }
    if (result.state === 'held') {
      await this.hold(
        order,
        attempt,
        this.holdCode(result.classification),
        this.holdHeadline(result),
        result.summary,
        result.artifactRefs,
        effect,
      )
      await this.acknowledgeEffect(order, attempt, issue, operation)
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
        effect,
      )
      await this.acknowledgeEffect(order, attempt, issue, operation)
    }
    return result
  }

  private async isolateValidationFailure(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    failed: ShippingJobResult,
    effect: ReturnType<ShippingService['effectCommit']>,
    resourceLease?: ResourceLease,
  ): Promise<boolean> {
    const manifest = this.deps.repository.activeTrainForOrder(order.id)
    if (!manifest) return false
    const members = manifest.members.map((member) => this.requiredOrder(member.orderId))
    const durableRepair = this.repairCandidate(attempt)
    const scope = {
      repoId: manifest.lane.repoId,
      targetBranch: manifest.lane.targetBranch,
      targetSha: manifest.lane.expectedTargetSha,
      destination: manifest.lane.destination,
      provider: manifest.lane.providerRef ?? null,
      validationProfile: manifest.lane.validationProfile,
      repair: durableRepair
        ? {
            round: durableRepair.round,
            contextDigest: durableRepair.contextDigest,
            repairRef: durableRepair.repairRef,
            candidateHeadSha: durableRepair.candidateHeadSha,
          }
        : null,
      members: manifest.members.map((member) => ({
        orderId: member.orderId,
        attemptId: member.attemptId,
        generation: member.generation,
        approvedHeadSha: member.approvedHeadSha,
      })),
    }
    const isolation = await isolateShippingTrain(
      members,
      async (subset) => {
        if (!this.renewResourceLease(resourceLease)) {
          return { passed: false, summary: 'validation resource lease expired' }
        }
        const memberOrderIds = subset.map((candidate) => candidate.id)
        const repair = durableRepair
        const approvedExecution = {
          memberOrderIds,
          repairRound: 0,
          candidate: { kind: 'approved' as const },
        }
        if (repair) {
          const approvedRequest = this.jobInput(
            order,
            attempt,
            issue,
            'prepare-merge-group',
            'start',
            approvedExecution,
            null,
          )
          const approved = await this.deps.daemon.shippingJob(approvedRequest, attempt.machineId)
          this.assertJobResultAuthority(approvedRequest, attempt, approved)
          if (approved.state !== 'succeeded') {
            return { passed: false, summary: approved.summary }
          }
        }
        const execution = repair
          ? {
              memberOrderIds,
              repairRound: repair.round,
              candidate: {
                kind: 'repair' as const,
                contextDigest: repair.contextDigest,
                repairRef: repair.repairRef,
                candidateHeadSha: repair.candidateHeadSha,
              },
            }
          : approvedExecution
        if (repair) {
          const applyRequest = this.jobInput(
            order,
            attempt,
            issue,
            'apply-repair',
            'start',
            execution,
            repair,
          )
          const applied = await this.deps.daemon.shippingJob(applyRequest, attempt.machineId)
          this.assertJobResultAuthority(applyRequest, attempt, applied)
          if (applied.state !== 'succeeded') {
            return { passed: false, summary: applied.summary }
          }
        }
        const prepareRequest = this.jobInput(
          order,
          attempt,
          issue,
          'prepare-merge-group',
          'start',
          execution,
        )
        const prepared = await this.deps.daemon.shippingJob(prepareRequest, attempt.machineId)
        this.assertJobResultAuthority(prepareRequest, attempt, prepared)
        if (
          prepared.jobId !== prepareRequest.jobId ||
          prepared.requestDigest !== prepareRequest.requestDigest ||
          prepared.state !== 'succeeded'
        ) {
          return { passed: false, summary: prepared.summary }
        }
        const validateRequest = this.jobInput(order, attempt, issue, 'validate', 'start', execution)
        const validated = await this.deps.daemon.shippingJob(validateRequest, attempt.machineId)
        this.assertJobResultAuthority(validateRequest, attempt, validated)
        const passed =
          validated.jobId === validateRequest.jobId &&
          validated.requestDigest === validateRequest.requestDigest &&
          validated.state === 'succeeded' &&
          validated.classification === 'proved' &&
          validated.validationResult === 'passed'
        return { passed, summary: validated.summary }
      },
      this.greenPrefixes,
      scope,
      true,
    )
    const failureOrderIds = [
      ...new Set([...isolation.failures.flat(), ...isolation.interactions.flat()]),
    ]
    if (failureOrderIds.length === 0) return false
    const detail =
      isolation.interactions.length > 0
        ? `Validation isolated an interaction among ${failureOrderIds.join(', ')}.`
        : `Validation isolated failing changes: ${failureOrderIds.join(', ')}.`
    const failures = new Set(failureOrderIds)
    this.deps.issues.shippingCommitMany(
      members.map((member) => ({
        id: member.issueId,
        mutation: {
          expectedStage: 'shipping' as const,
          needsHuman: failures.has(member.id),
          shipOrderChanges: () => this.projectionSpecs(),
          event: () => {
            const hold = this.deps.repository.openHoldForOrder(member.id)
            return hold
              ? {
                  kind: 'issue.ship_hold_raised',
                  payload: {
                    orderId: member.id,
                    holdId: hold.id,
                    generation: hold.generation,
                    reasonCode: hold.reasonCode,
                    actions: hold.actions,
                  },
                }
              : {
                  kind: 'issue.shipping_train_reset',
                  payload: { orderId: member.id, isolatedFrom: manifest.id },
                }
          },
        },
      })),
      () =>
        this.deps.repository.isolateTrainFailure({
          trainId: manifest.id,
          leaderOrderId: order.id,
          leaderAttemptId: attempt.id,
          generation: attempt.leaseGeneration,
          terminalStep: effect.terminalStep,
          failureOrderIds,
          isolatedAt: failed.finishedAt ?? this.now(),
          detail,
        }),
    )
    for (const member of manifest.members) {
      this.leases.delete(member.orderId)
      this.greenPrefixes.invalidateOrder(member.orderId)
    }
    this.audit('shipping.train_validation_isolated', order.issueId, {
      trainId: manifest.id,
      failures: isolation.failures,
      interactions: isolation.interactions,
      validationCount: isolation.validationCount,
    })
    return true
  }

  private repairContext(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    failure: ShippingRepairContext['failure'],
  ): ShippingRepairContext {
    const context = {
      order,
      attempt,
      issue,
      failure,
      custody: {
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        machineId: attempt.machineId,
      },
      authority: {
        type: 'shippingJobRequest' as const,
        requestId: 'shipwright-context',
        ...this.jobInput(order, attempt, issue, failure.operation, 'status'),
      },
    }
    return { ...context, contextDigest: shippingRepairContextDigest(context) }
  }

  private durableRepairCandidate(
    order: ShipOrder,
    attempt: ShipAttempt,
    context: ShippingRepairContext,
    decision: Extract<ShippingRepairDecision, { kind: 'patched' }>,
    recordedAt: string,
  ): StoredShippingRepairCandidate {
    const sequence = this.deps.repository.repairCandidatesForAttempt(attempt.id).length + 1
    const expectedRef = shipRepairRef(
      order.id,
      attempt.id,
      attempt.leaseGeneration,
      context.contextDigest,
    )
    if (decision.repairRef !== expectedRef) {
      throw new Error(`shipping repair ref does not match exact context custody`)
    }
    return {
      orderId: order.id,
      attemptId: attempt.id,
      generation: attempt.leaseGeneration,
      sequence,
      round: sequence,
      contextDigest: context.contextDigest,
      repairRef: decision.repairRef,
      candidateHeadSha: decision.candidateHeadSha,
      resultToken: decision.resultToken,
      recordedAt,
    }
  }

  private async handleRepairFailure(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    result: ShippingJobResult,
    effect: { effectKey: string; operation: ShipStep['kind']; terminalStep: ShipStep },
  ): Promise<boolean> {
    const repair = this.deps.repair
    if (
      !repair ||
      (result.operation !== 'prepare-merge-group' && result.operation !== 'validate') ||
      !result.repairBaseSha
    ) {
      return false
    }
    const failure: ShippingRepairContext['failure'] = {
      operation: result.operation,
      classification: result.classification,
      summary: result.summary,
      artifactRefs: result.artifactRefs,
      repairBaseSha: result.repairBaseSha,
    }
    const context = this.repairContext(order, attempt, issue, failure)
    let decision: ShippingRepairDecision
    try {
      decision = await repair.consider(context)
    } catch (error) {
      this.audit('shipping.repair_consider_failed', order.issueId, {
        orderId: order.id,
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
    if (decision.kind === 'not-applicable') return false

    const failedEffectAcknowledgement = this.jobInput(
      order,
      attempt,
      issue,
      result.operation,
      'acknowledge',
    )

    const repairAcknowledgement = {
      resultToken: decision.resultToken,
      orderId: order.id,
      attemptId: attempt.id,
      generation: attempt.leaseGeneration,
      contextDigest: context.contextDigest,
      ...(decision.kind === 'patched'
        ? {
            candidate: {
              repairRef: decision.repairRef,
              candidateHeadSha: decision.candidateHeadSha,
            },
          }
        : {}),
    }

    effect.terminalStep = {
      ...effect.terminalStep,
      summary: repairMarker({
        decision,
        context,
        acknowledgement: repairAcknowledgement,
      }),
    }
    if (decision.kind === 'patched') {
      const changedAt = result.finishedAt ?? this.now()
      const repairCandidate = this.durableRepairCandidate(
        order,
        attempt,
        context,
        decision,
        changedAt,
      )
      this.deps.ledger.commit({
        write: () =>
          this.deps.repository.commitEffectResult({
            orderId: order.id,
            expectedState: order.state,
            attemptId: attempt.id,
            generation: attempt.leaseGeneration,
            ...effect,
            repairCandidate,
            outcome: { kind: 'transition', nextState: 'repairing', stateChangedAt: changedAt },
          }),
        changes: () => this.projectionSpecs(),
      })
      this.audit('shipping.order_state_changed', order.issueId, {
        orderId: order.id,
        from: order.state,
        to: 'repairing',
        repairRef: decision.repairRef,
        candidateHeadSha: decision.candidateHeadSha,
      })
    } else {
      await this.hold(
        order,
        attempt,
        decision.reasonCode,
        decision.headline,
        decision.detail,
        decision.evidenceRefs,
        effect,
        undefined,
        decision.actions,
        true,
      )
    }
    await this.acknowledgeEffect(
      order,
      attempt,
      issue,
      result.operation,
      failedEffectAcknowledgement,
    )
    this.deps.beforeRepairAcknowledge?.(decision.resultToken)
    await repair.acknowledge(repairAcknowledgement)
    return true
  }

  private async replayRepairAcknowledgement(order: ShipOrder): Promise<void> {
    const repair = this.deps.repair
    if (!repair) return
    const attempt = this.deps.repository.latestAttemptForOrder(order.id)
    if (!attempt) return
    const candidate = this.deps.repository.repairCandidatesForAttempt(attempt.id).at(-1)
    if (!candidate) {
      const marker = this.deps.repository
        .stepsForAttempt(attempt.id)
        .map((step) => parseRepairMarker(step.summary))
        .findLast((entry) => entry?.decision.kind === 'needs-decision')
      if (!marker || marker.decision.kind !== 'needs-decision') return
      this.deps.beforeRepairAcknowledge?.(marker.decision.resultToken)
      await repair.acknowledge(marker.acknowledgement)
      return
    }
    this.deps.beforeRepairAcknowledge?.(candidate.resultToken)
    await repair.acknowledge({
      resultToken: candidate.resultToken,
      orderId: order.id,
      attemptId: candidate.attemptId,
      generation: candidate.generation,
      contextDigest: candidate.contextDigest,
      candidate: {
        repairRef: candidate.repairRef,
        candidateHeadSha: candidate.candidateHeadSha,
      },
    })
  }

  private async replayDaemonAcknowledgements(order: ShipOrder): Promise<void> {
    const issue = this.deps.issues.get(order.issueId)
    for (const attempt of this.deps.repository
      .listAttempts()
      .filter((candidate) => candidate.orderId === order.id)) {
      const repairCandidates = this.deps.repository.repairCandidatesForAttempt(attempt.id)
      for (const step of this.deps.repository.stepsForAttempt(attempt.id)) {
        if (!terminalStep(step)) continue
        if (
          step.kind === 'preflight' ||
          step.kind === 'apply-repair' ||
          step.kind === 'prepare-merge-group' ||
          step.kind === 'validate' ||
          step.kind === 'commit-merge-group' ||
          step.kind === 'publish' ||
          step.kind === 'verify'
        ) {
          const repairMatch = step.effectKey.match(/:repair-(\d+)-([a-f0-9]{64})-([a-f0-9]{64})$/)
          const repair = repairMatch ? repairCandidates[Number(repairMatch[1]) - 1] : null
          if (repairMatch && !repair) {
            throw new Error(`shipping repair effect ${step.effectKey} has no durable candidate`)
          }
          if (
            (repairMatch &&
              repair &&
              createHash('sha256')
                .update(`${repair.repairRef}\0${repair.candidateHeadSha}`)
                .digest('hex') !== repairMatch[3]) ||
            (repairMatch && repair && repair.contextDigest !== repairMatch[2])
          ) {
            throw new Error(`shipping repair effect ${step.effectKey} candidate digest changed`)
          }
          const request = this.jobInput(
            order,
            attempt,
            issue,
            step.kind,
            'acknowledge',
            undefined,
            repair,
          )
          await this.acknowledgeEffect(order, attempt, issue, step.kind, request)
        }
      }
    }
  }

  private async hold(
    order: ShipOrder,
    attempt: ShipAttempt,
    reasonCode: ShipHold['reasonCode'],
    headline: string,
    detail: string,
    evidenceRefs: string[] = [],
    effect?: {
      effectKey: string
      operation: ShipStep['kind']
      terminalStep: ShipStep
    },
    cancellationFailure?: { intentKey: string; terminalStep: ShipStep },
    actions: ShipHoldAction[] = ['retry', 'return-to-issue'],
    preserveAttempt = false,
  ): Promise<void> {
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
      actions,
      raisedAt,
    }
    const train = this.deps.repository.activeTrainForOrder(order.id)
    const affected = train
      ? train.members.map((member) => this.requiredOrder(member.orderId))
      : [order]
    this.deps.issues.shippingCommitMany(
      affected.map((member) => ({
        id: member.issueId,
        mutation: {
          expectedStage: 'shipping' as const,
          needsHuman: member.id === order.id || member.state !== 'preflight',
          shipOrderChanges: () => this.projectionSpecs(),
          event: () => {
            const liveHold = this.deps.repository.openHoldForOrder(member.id)
            return liveHold
              ? {
                  kind: 'issue.ship_hold_raised',
                  payload: {
                    orderId: member.id,
                    holdId: liveHold.id,
                    generation: liveHold.generation,
                    reasonCode: liveHold.reasonCode,
                    actions: liveHold.actions,
                  },
                }
              : {
                  kind: 'issue.shipping_train_reset',
                  payload: { orderId: member.id, heldPeer: order.id },
                }
          },
        },
      })),
      () =>
        effect
          ? this.deps.repository.commitEffectResult({
              orderId: order.id,
              expectedState: order.state,
              attemptId: attempt.id,
              generation: attempt.leaseGeneration,
              ...effect,
              outcome: { kind: 'hold', hold, attemptFinishedAt: raisedAt, preserveAttempt },
            })
          : cancellationFailure
            ? this.deps.repository.commitCancellationHold({
                orderId: order.id,
                expectedState: order.state,
                attemptId: attempt.id,
                generation: attempt.leaseGeneration,
                ...cancellationFailure,
                hold,
                attemptFinishedAt: raisedAt,
              })
            : this.deps.repository.commitCustodyHold({
                orderId: order.id,
                expectedState: order.state,
                attemptId: attempt.id,
                generation: attempt.leaseGeneration,
                hold,
                attemptFinishedAt: raisedAt,
              }),
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

  private effectCommit(
    order: ShipOrder,
    attempt: ShipAttempt,
    operation: ShippingJobResult['operation'],
    result: ShippingJobResult,
    startedAt = this.deps.repository.latestStepForEffect(
      attempt.id,
      this.effectKeyFor(attempt, operation),
    )?.startedAt ?? this.now(),
  ): {
    effectKey: string
    operation: ShipStep['kind']
    terminalStep: ShipStep
  } {
    const effectKey = this.effectKeyFor(attempt, operation)
    return {
      effectKey,
      operation,
      terminalStep: {
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
        summary: result.trainProofs
          ? `${TRAIN_PROOF_MARKER}${JSON.stringify(result.trainProofs)}`
          : result.summary,
        finishedAt: result.finishedAt ?? this.now(),
        ...(result.artifactRefs[0] ? { artifactRef: result.artifactRefs[0] } : {}),
      },
    }
  }

  private cancellationFailure(
    order: ShipOrder,
    attempt: ShipAttempt,
    intentKey: string,
    outcome: string,
    summary: string,
  ): { intentKey: string; terminalStep: ShipStep } {
    const intent = this.deps.repository.latestStepForEffect(attempt.id, intentKey)
    const finishedAt = this.now()
    return {
      intentKey,
      terminalStep: {
        ...this.step(
          order,
          attempt,
          intentKey,
          'cancel',
          'failed',
          intent?.startedAt ?? finishedAt,
        ),
        outcome,
        summary,
        finishedAt,
      },
    }
  }

  private async assertLiveAdmissionSnapshot(
    issue: IssueWire,
    targetBranch: string,
    expectedSourceHead: string,
    expectedTargetHead: string,
    expectedDescendants: readonly DescendantTip[],
  ): Promise<void> {
    const descendants = this.deps.issues.children(issue.id, true)
    if (descendants.some((child) => child.stage !== 'done' || !child.branch)) {
      throw new ShippingAdmissionError(
        'descendant-incomplete',
        'descendant shipping eligibility changed before custody could commit',
      )
    }
    const [sourceHead, targetHead, ...descendantHeads] = await Promise.all([
      this.deps.resolveBranchTip(issue),
      this.deps.resolveRefTip(issue, targetBranch),
      ...descendants.map((child) => this.deps.resolveBranchTip(child)),
    ])
    const liveDescendants = descendants.map((child, index) => ({
      issueId: child.id,
      approvedHeadSha: descendantHeads[index] as string,
    }))
    if (
      sourceHead !== expectedSourceHead ||
      targetHead !== expectedTargetHead ||
      !integrationReceiptMatchesOrder(
        {
          rootIssueId: issue.id,
          approvedHeadSha: expectedSourceHead,
          descendants: expectedDescendants as DescendantTip[],
        },
        {
          issueId: issue.id,
          approvedHeadSha: sourceHead,
          descendantManifest: liveDescendants,
        },
      )
    ) {
      throw new ShippingAdmissionError(
        'source-stale',
        'repository refs changed before shipping custody could commit',
      )
    }
  }

  private isEffectCustodyRefusal(error: unknown): boolean {
    return (
      error instanceof Error &&
      /effect (?:dispatch )?custody fence failed|durable cancellation intent/.test(error.message)
    )
  }

  private jobInput(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    operation: ShippingJobResult['operation'],
    action: 'start' | 'status' | 'cancel' | 'acknowledge',
    execution?: {
      memberOrderIds: ShipOrderId[]
      repairRound?: number
      candidate?:
        | { kind: 'approved' }
        | {
            kind: 'repair'
            contextDigest: string
            repairRef: string
            candidateHeadSha: string
          }
    },
    repairOverride?: {
      round: number
      contextDigest: string
      repairRef: string
      candidateHeadSha: string
    } | null,
  ): Omit<ShippingJobRequestMessage, 'type' | 'requestId'> {
    const train = this.deps.repository.trainManifestForAttempt(attempt.id)
    const policy = this.deps.policy.resolve(issue)
    const durableRepair =
      repairOverride === null ? undefined : (repairOverride ?? this.repairCandidate(attempt))
    const repairFacts = durableRepair
      ? {
          round: durableRepair.round,
          contextDigest: durableRepair.contextDigest,
          repairRef: durableRepair.repairRef,
          candidateHeadSha: durableRepair.candidateHeadSha,
        }
      : undefined
    const memberOrderIds =
      execution?.memberOrderIds ?? train?.members.map((member) => member.orderId)
    const repairRound = execution?.repairRound ?? durableRepair?.round ?? 0
    const candidate =
      execution?.candidate ??
      (durableRepair
        ? {
            kind: 'repair' as const,
            contextDigest: durableRepair.contextDigest,
            repairRef: durableRepair.repairRef,
            candidateHeadSha: durableRepair.candidateHeadSha,
          }
        : ({ kind: 'approved' } as const))
    const subsetId =
      train && memberOrderIds
        ? asShipTrainSubsetId(
            `subset:${createHash('sha256')
              .update(
                shippingTrainSubsetFingerprint({
                  manifest: train,
                  memberOrderIds,
                  repairRound,
                  candidate,
                }),
              )
              .digest('hex')}`,
          )
        : undefined
    const facts = {
      jobId:
        train && subsetId
          ? `${attempt.id}:${operation}:${subsetId}`
          : durableRepair
            ? `${attempt.id}:${operation}:repair-${durableRepair.round}-${durableRepair.contextDigest}-${createHash(
                'sha256',
              )
                .update(`${durableRepair.repairRef}\0${durableRepair.candidateHeadSha}`)
                .digest('hex')}`
            : `${attempt.id}:${operation}`,
      orderId: order.id,
      attemptId: attempt.id,
      generation: attempt.leaseGeneration,
      operation,
      shippingProtocolVersion: (train ? 2 : 1) as 1 | 2,
      repoPath: issue.repoPath,
      repoId: order.repoId,
      sourceBranch: this.requiredBranch(issue),
      targetBranch: order.targetBranch,
      approvedBaseSha: order.approvedBaseSha,
      approvedHeadSha: order.approvedHeadSha,
      expectedTargetSha: attempt.expectedTargetSha,
      destination:
        train?.lane.destination ??
        canonicalShippingDestination(order.destination, order.targetBranch),
      policyId: order.policyId,
      validationProfile: train?.lane.validationProfile ??
        order.validationProfile ?? {
          ...policy.validationProfile,
          resourceLocks: [...policy.validationProfile.resourceLocks].sort(),
        },
      ...(repairFacts ? { repair: repairFacts } : {}),
      ...(train
        ? {
            train: {
              version: 2 as const,
              capability: SHIPPING_TRAIN_CAPABILITY,
              manifest: train,
              subsetId: subsetId!,
              memberOrderIds: memberOrderIds!,
              repairRound,
              candidate,
            },
          }
        : {}),
      ...(order.providerRef ? { providerRef: order.providerRef } : {}),
    }
    return {
      action,
      ...facts,
      requestDigest: createHash('sha256')
        .update(shippingJobRequestFingerprint(facts))
        .digest('hex'),
    }
  }

  private repairCandidate(attempt: ShipAttempt): StoredShippingRepairCandidate | undefined {
    return this.deps.repository.repairCandidatesForAttempt(attempt.id).at(-1)
  }

  private effectKeyFor(attempt: ShipAttempt, operation: ShippingJobResult['operation']): string {
    const repair = this.repairCandidate(attempt)
    if (!repair) return `${operation}:${attempt.leaseGeneration}`
    const repairDigest = createHash('sha256')
      .update(`${repair.repairRef}\0${repair.candidateHeadSha}`)
      .digest('hex')
    return `${operation}:${attempt.leaseGeneration}:repair-${repair.round}-${repair.contextDigest}-${repairDigest}`
  }

  private operationFor(state: ShipOrderState): ShippingJobResult['operation'] | null {
    if (state === 'preflight') return 'preflight'
    if (state === 'composing') return 'prepare-merge-group'
    if (state === 'repairing') return 'apply-repair'
    if (state === 'validating') return 'validate'
    if (state === 'landing') return 'commit-merge-group'
    if (state === 'publishing') return 'publish'
    if (state === 'verifying') return 'verify'
    return null
  }

  private acquireResources(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    names: readonly string[],
    ttlSeconds: number,
  ): ResourceLease | null {
    if (names.length === 0 || !this.deps.resourceAdmission) return { lost: false }
    if (
      !this.deps.resourceAdmission.acquire({
        order,
        attempt,
        issue,
        names,
        ttlSeconds,
      })
    ) {
      return null
    }
    const lease: ResourceLease = {
      lost: false,
      expiresAt: Date.now() + ttlSeconds * 1_000,
      ttlMs: ttlSeconds * 1_000,
      renew: () =>
        this.deps.resourceAdmission?.renew({
          order,
          attempt,
          issue,
          names,
          ttlSeconds,
        }) === true,
    }
    const renewEveryMs = Math.max(250, Math.floor((ttlSeconds * 1_000) / 3))
    lease.timer = setInterval(() => this.renewResourceLeaseTick(lease, ttlSeconds), renewEveryMs)
    lease.timer.unref?.()
    this.activeResourceLeases.add(lease)
    return lease
  }

  /**
   * One renew tick for a resource lease.
   *
   * SINGLE-FLIGHT PER LEASE (POD-3258). `renew` reaches the lock service, which
   * is a read-decide-write over the durable lock rows, and this tick fires every
   * ttl/3 — so a renew that takes longer than a third of the TTL is met by the
   * next tick while it is still out. Two renews for one lease race on
   * `lease.lost` and `lease.expiresAt`: the loser's stale verdict can overwrite
   * the winner's, either extending a lease that was actually lost or condemning
   * one that was renewed. Skipped, not queued — the tick is pure heartbeat, and
   * the next one is a third of a TTL away, which is the margin the cadence was
   * chosen to leave.
   *
   * A NAMED METHOD RATHER THAN THE INTERVAL'S CLOSURE, so the fence is testable:
   * fake timers will not re-fire an interval that is currently executing, so an
   * anonymous callback here has no seam a unit test can produce an overlap
   * through. This is the same extraction the other guarded passes in this epic
   * took (`runStalledSweep`, `runTurnReap`, `runTick`).
   */
  renewResourceLeaseTick(lease: ResourceLease, ttlSeconds: number): void {
    if (!this.resourceLeaseLive(lease)) return
    if (lease.renewing === true) return
    lease.renewing = true
    try {
      if (!lease.renew?.()) {
        lease.lost = true
      } else {
        lease.expiresAt = Date.now() + ttlSeconds * 1_000
      }
    } catch {
      lease.lost = true
    } finally {
      lease.renewing = false
    }
    if (lease.lost && lease.timer) clearInterval(lease.timer)
  }

  private releaseResources(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    names: readonly string[],
    lease: ResourceLease,
  ): void {
    if (lease.timer) clearInterval(lease.timer)
    this.activeResourceLeases.delete(lease)
    if (names.length === 0 || !this.deps.resourceAdmission) return
    // A failed renew means this incarnation no longer owns a release right.
    // Its lease may already have expired and advanced to a successor.
    if (!this.resourceLeaseLive(lease)) return
    try {
      this.deps.resourceAdmission.release({ order, attempt, issue, names })
    } catch (error) {
      this.audit('shipping.resource_release_failed', order.issueId, {
        orderId: order.id,
        names,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private resourceLeaseLive(lease?: ResourceLease): boolean {
    if (!lease) return true
    if (lease.lost) return false
    if (lease.expiresAt !== undefined && lease.expiresAt <= Date.now()) {
      lease.lost = true
      if (lease.timer) clearInterval(lease.timer)
      return false
    }
    return true
  }

  private renewResourceLease(lease?: ResourceLease): boolean {
    if (!lease?.renew) return this.resourceLeaseLive(lease)
    if (!this.resourceLeaseLive(lease)) return false
    try {
      if (!lease.renew()) {
        lease.lost = true
        return false
      }
      if (lease.ttlMs !== undefined) lease.expiresAt = Date.now() + lease.ttlMs
      return true
    } catch {
      lease.lost = true
      return false
    }
  }

  private publicationLockName(order: ShipOrder): string {
    const canonicalDestination = canonicalShippingDestination(order.destination, order.targetBranch)
    return `publish:${createHash('sha256').update(canonicalDestination).digest('hex')}`
  }

  private async acknowledgeEffect(
    order: ShipOrder,
    attempt: ShipAttempt,
    issue: IssueWire,
    operation: ShippingJobResult['operation'],
    authorityRequest?: Omit<ShippingJobRequestMessage, 'type' | 'requestId'>,
  ): Promise<void> {
    try {
      const request =
        authorityRequest ?? this.jobInput(order, attempt, issue, operation, 'acknowledge')
      const result = await this.deps.daemon.shippingJob(request, attempt.machineId)
      this.assertJobResultAuthority(request, attempt, result)
    } catch (error) {
      // The server commit is authoritative. A missing ack retains the daemon
      // journal for reconciliation; it must never roll back a committed effect.
      this.audit('shipping.effect_ack_pending', order.issueId, {
        orderId: order.id,
        attemptId: attempt.id,
        operation,
        error: error instanceof Error ? error.message : String(error),
      })
    }
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
    const authorityRequest = this.jobInput(
      order,
      attempt,
      this.deps.issues.get(order.issueId),
      operation,
      'status',
    )
    this.assertJobResultAuthority(authorityRequest, attempt, result)
  }

  private assertJobResultAuthority(
    authorityRequest: Omit<ShippingJobRequestMessage, 'type' | 'requestId'>,
    attempt: ShipAttempt,
    result: ShippingJobResult,
  ): void {
    const evidenceRefsMatch = result.artifactRefs.every(
      (artifactRef, ordinal) =>
        artifactRef ===
        `artifact://shipping/${createHash('sha256')
          .update(
            shippingEvidenceFingerprint(
              { type: 'shippingJobRequest', requestId: 'evidence', ...authorityRequest },
              attempt.machineId,
              ordinal,
            ),
          )
          .digest('hex')}`,
    )
    if (
      result.orderId !== authorityRequest.orderId ||
      result.requestDigest !== authorityRequest.requestDigest ||
      result.attemptId !== attempt.id ||
      result.generation !== attempt.leaseGeneration ||
      result.operation !== authorityRequest.operation ||
      result.machineId !== attempt.machineId ||
      !evidenceRefsMatch
    ) {
      throw new Error(
        `shipping daemon result fence failed for ${attempt.id}:${authorityRequest.operation}`,
      )
    }
  }

  private holdCode(classification: ShippingJobResult['classification']): ShipHold['reasonCode'] {
    if (classification === 'source-moved') return 'approval-stale'
    if (classification === 'target-moved') return 'landing-conflict'
    if (classification === 'merge-conflict') return 'landing-conflict'
    if (classification === 'validation-failed') return 'validation-failed'
    if (classification === 'destination-mismatch') return 'destination-mismatch'
    if (classification === 'publish-rejected' || classification === 'provider-failed') {
      return 'destination-mismatch'
    }
    if (classification === 'stale-generation') return 'machine-unavailable'
    return 'policy-refused'
  }

  private holdHeadline(result: ShippingJobResult): string {
    if (result.classification === 'source-moved') return 'Approved source changed'
    if (result.classification === 'target-moved') return 'Target changed during shipping'
    if (result.classification === 'merge-conflict') return 'Approved work no longer composes'
    if (result.classification === 'validation-failed') return 'Named validation profile failed'
    if (result.classification === 'dirty-worktree') return 'Repository checkout is not clean'
    if (result.classification === 'wrong-target-checkout') return 'Target checkout needs adoption'
    if (result.classification === 'publish-rejected') return 'Destination rejected publication'
    if (result.classification === 'destination-mismatch') return 'Destination proof failed'
    return 'Shipping needs a supported destination executor'
  }

  private requiredOrder(id: ShipOrderId): ShipOrder {
    const order = this.deps.repository.getOrder(id)
    if (!order) throw new Error(`unknown shipping order ${id}`)
    return order
  }

  private authorizedOrder(
    id: ShipOrderId,
    principal: CommandPrincipal,
    action: 'resolve-hold' | 'cancel' | 'read-receipt',
    overrideScope: boolean,
  ): { order: ShipOrder; issue: IssueWire } {
    const order = this.deps.repository.getOrder(id)
    if (!order) throw new ShippingOrderAccessError()
    let issue: IssueWire
    try {
      issue = this.deps.issues.get(order.issueId)
    } catch {
      throw new ShippingOrderAccessError()
    }
    try {
      this.deps.authorization.authorize({
        principal,
        action,
        issue,
        overrideScope,
      })
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'NOT_FOUND'
      ) {
        throw new ShippingOrderAccessError()
      }
      throw error
    }
    return { order, issue }
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
    if (replacementHold?.resolvedAt) holdByOrder.delete(replacementHold.orderId)
    else if (replacementHold) holdByOrder.set(replacementHold.orderId, replacementHold)
    const receiptByOrder = new Map(receipts.map((receipt) => [receipt.orderId, receipt] as const))
    if (replacementReceipt) receiptByOrder.set(replacementReceipt.orderId, replacementReceipt)
    return shippingQueue(
      orders,
      [...receiptByOrder.values()],
      Date.parse(this.now()),
      this.turnSamples(),
    ).map(({ order, queueRank, waitEstimate, trainId, trainIndex, trainSize }) => {
      const train =
        trainId && trainIndex !== undefined && trainSize !== undefined
          ? { id: trainId, index: trainIndex, size: trainSize }
          : undefined
      const row = shipOrderProjectionRow(
        order,
        holdByOrder.get(order.id),
        receiptByOrder.get(order.id),
        queueRank,
        waitEstimate,
        train,
      )
      return row
        ? {
            entity: 'shipOrder' as const,
            id: row.id,
            op: 'upsert' as const,
            value: row.value,
          }
        : {
            entity: 'shipOrder' as const,
            id: order.id,
            op: 'remove' as const,
          }
    })
  }

  private turnSamples(): import('./queue').ShippingTurnSample[] {
    return this.deps.repository.listAttempts().flatMap((attempt) => {
      if (!attempt.finishedAt || attempt.outcome !== 'succeeded') return []
      const durationMs = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)
      return Number.isFinite(durationMs) && durationMs >= 0
        ? [{ orderId: attempt.orderId, durationMs, completedAt: attempt.finishedAt }]
        : []
    })
  }

  private currentProjectionRows(): {
    id: string
    value: ShipOrderProjection
  }[] {
    return this.projectionSpecs().flatMap((spec) =>
      spec.op === 'upsert' ? [{ id: spec.id, value: spec.value as ShipOrderProjection }] : [],
    )
  }

  private audit(kind: string, issueId: IssueId, payload: Record<string, unknown>): void {
    this.deps.audit?.(kind, issueId, payload)
  }
}
