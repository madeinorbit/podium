import { createHash } from 'node:crypto'
import {
  asMachineId,
  asShipOrderId,
  asShipStepId,
  FIRST_ADMIN_USER_ID,
  type IssueWire,
} from '@podium/model'
import type { ShippingJobResult } from '@podium/protocol/daemon'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { IssueService } from '../issues/service'
import { CompatibilityShippingPolicyResolver } from './policy'
import type { ShippingPolicyResolver } from './policy'
import {
  type AcceptedReviewEvidence,
  canonicalShippingDestination,
  ShippingOrderAccessError,
  shippingResourceHolderId,
  ShippingService,
} from './service'
import type { ShippingRepairPort } from './repair-contract'

const stores: SessionStore[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
})

function harness(
  shippingJob: NonNullable<
    ConstructorParameters<typeof ShippingService>[0]['daemon']
  >['shippingJob'] = async () => {
    throw new Error('not used by enqueue')
  },
  options: {
    authorize?: () => void
    reauthorize?: ConstructorParameters<typeof ShippingService>[0]['authorization']['reauthorize']
    beforeCompletionCommit?: () => void
    rootIntegrationReceipt?: ConstructorParameters<
      typeof ShippingService
    >[0]['evidence']['rootIntegrationReceipt']
    acceptedReviewEvidence?: ConstructorParameters<
      typeof ShippingService
    >[0]['evidence']['acceptedReviewEvidence']
    useStoredReceipts?: boolean
    resolveBranchTip?: ConstructorParameters<typeof ShippingService>[0]['resolveBranchTip']
    resolveRefTip?: ConstructorParameters<typeof ShippingService>[0]['resolveRefTip']
    isAncestor?: ConstructorParameters<typeof ShippingService>[0]['isAncestor']
    policy?: ShippingPolicyResolver
    takeBranchCustody?: ConstructorParameters<
      typeof ShippingService
    >[0]['issues']['takeBranchCustody']
    resourceAdmission?: ConstructorParameters<typeof ShippingService>[0]['resourceAdmission']
    repair?: ShippingRepairPort
    beforeRepairAcknowledge?: (resultToken: string) => void
  } = {},
) {
  const store = new SessionStore(':memory:')
  stores.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    now: Date.now,
    transact: (fn) => store.transact(fn),
  })
  const issues = new IssueService({
    store,
    listSessions: () => [],
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: 'main',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'codex' },
      }),
    spawnSession: () => ({
      sessionId: 'session-1' as never,
      machine: 'machine-1',
    }),
    repoOp: async () => ({ ok: true, output: '' }),
    funnel: { run: (op) => op.write() },
    ledger,
    publishSpecs: {
      issueUpdated: (issue) => ({ rows: [{ id: issue.id, value: issue }] }),
      issuesChanged: (rows) => ({
        rows: rows.map((issue) => ({ id: issue.id, value: issue })),
      }),
    },
  })
  const createIssue = issues.create.bind(issues)
  issues.create = ((input) =>
    createIssue({
      ...input,
      machineId: input.machineId ?? asMachineId('machine-1'),
    })) as typeof issues.create
  const issuePort = {
    get(id: string): IssueWire {
      const issue = issues.get(id)
      if (!issue) throw new Error(`unknown issue ${id}`)
      return {
        ...issue,
        branch: issue.branch ?? `issue/${issue.seq}-shipping-test`,
      }
    },
    children: (id: string, recursive?: boolean) =>
      issues.children(id, recursive).map((issue) => ({
        ...issue,
        branch: issue.branch ?? `issue/${issue.seq}-shipping-test`,
      })),
    shippingCommit: issues.shippingCommit.bind(issues),
    shippingCommitMany: issues.shippingCommitMany.bind(issues),
    ...(options.takeBranchCustody ? { takeBranchCustody: options.takeBranchCustody } : {}),
  }
  const deps: ConstructorParameters<typeof ShippingService>[0] = {
    repository: store.shipping,
    issues: issuePort,
    ledger,
    daemon: { shippingJob },
    authorization: {
      attribution: () => approval.requestedBy,
      authorize: options.authorize ?? (() => {}),
      reauthorize: options.reauthorize ?? (() => {}),
    },
    evidence: {
      rootIntegrationReceipt:
        options.rootIntegrationReceipt ??
        (options.useStoredReceipts
          ? store.shipping.rootIntegrationReceipt.bind(store.shipping)
          : (rootIssueId, approvedHeadSha) => ({
              rootIssueId,
              approvedHeadSha,
              descendants: issuePort.children(rootIssueId, true).map((child) => ({
                issueId: child.id,
                approvedHeadSha: 'head-sha',
              })),
            })),
      acceptedReviewEvidence: options.acceptedReviewEvidence ?? (() => null),
    },
    policy: options.policy ?? new CompatibilityShippingPolicyResolver(() => 'main'),
    ...(options.resourceAdmission ? { resourceAdmission: options.resourceAdmission } : {}),
    machineFor: () => asMachineId('machine-1'),
    machineCapabilities: () => ['shipping.train.v2'],
    resolveBranchTip: options.resolveBranchTip ?? (async () => 'head-sha'),
    resolveRefTip: options.resolveRefTip ?? (async () => 'base-sha'),
    isAncestor: options.isAncestor ?? (async () => false),
    now: () => '2026-08-13T10:00:00.000Z',
    ...(options.beforeCompletionCommit
      ? { beforeCompletionCommit: options.beforeCompletionCommit }
      : {}),
    ...(options.repair ? { repair: options.repair } : {}),
    ...(options.beforeRepairAcknowledge
      ? { beforeRepairAcknowledge: options.beforeRepairAcknowledge }
      : {}),
    background: false,
  }
  const service = new ShippingService(deps)
  return { store, ledger, issues, service, deps }
}

const approval = {
  principal: { kind: 'system' as const, job: 'shipping-test' },
  requestedBy: {
    actor: { kind: 'user' as const, id: FIRST_ADMIN_USER_ID },
    onBehalfOf: FIRST_ADMIN_USER_ID,
  },
  overrideScope: false,
  approved: {
    sourceBaseSha: 'base-sha',
    sourceHeadSha: 'head-sha',
    policyId: 'compatibility-local:main',
    previewLeaseIds: [],
  },
}

const provedShippingJob: NonNullable<
  ConstructorParameters<typeof ShippingService>[0]['daemon']
>['shippingJob'] = async (input, machineId) => ({
  jobId: input.jobId,
  requestDigest: input.requestDigest,
  orderId: input.orderId,
  attemptId: input.attemptId,
  machineId,
  generation: input.generation,
  operation: input.operation,
  state: 'succeeded',
  classification: 'proved',
  summary: `${input.operation} proved`,
  observedSourceSha: input.approvedHeadSha,
  observedTargetSha: input.approvedHeadSha,
  ...(input.operation === 'verify'
    ? {
        observedDestinationSha: input.approvedHeadSha,
        testedIntegrationSha: input.approvedHeadSha,
        landedRefSha: input.approvedHeadSha,
        validationProfileId: input.validationProfile.id,
        validationResult: 'passed' as const,
      }
    : {}),
  logs: [],
  artifactRefs: [],
  heartbeatedAt: '2026-08-13T10:00:00.000Z',
  finishedAt: '2026-08-13T10:00:00.000Z',
})

describe('ShippingService enqueue transaction', () => {
  it('atomically freezes the order, moves review to shipping, and publishes compact rows', async () => {
    const { store, ledger, issues, service } = harness()
    const issue = issues.create({
      repoPath: '/repo',
      title: 'approved',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const cursor = ledger.cursor()

    const receipt = await service.enqueue({ issueId: issue.id, ...approval })
    expect(receipt.created).toBe(true)
    expect(store.issues.getIssue(issue.id)?.stage).toBe('shipping')
    expect(store.shipping.getOrder(receipt.order.id)).toEqual(receipt.order)
    expect(receipt.order.currentIntegrationReceipt).toEqual({
      rootIssueId: issue.id,
      approvedHeadSha: 'head-sha',
      descendants: [],
    })
    const changes = ledger.changesSince(cursor) ?? []
    expect(changes.some((change) => change.entity === 'issue' && change.id === issue.id)).toBe(true)
    expect(
      changes.some(
        (change) =>
          change.entity === 'shipOrder' &&
          change.id === receipt.order.id &&
          change.op === 'upsert' &&
          (change.value as { queueRank?: number }).queueRank === 1,
      ),
    ).toBe(true)

    await expect(service.enqueue({ issueId: issue.id, ...approval })).resolves.toMatchObject({
      created: false,
      order: { id: receipt.order.id },
    })
    expect(receipt.order.id).toMatch(/^ship_[0-9a-f-]{36}$/)
    expect(store.events.listEventsSince(0, { kinds: ['issue.shipping_enqueued'] })).toHaveLength(1)
    service.dispose()
  })

  it('rejects a replay when any frozen admission fact differs', async () => {
    const { issues, service } = harness()
    const issue = issues.create({
      repoPath: '/repo',
      title: 'frozen replay',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    await service.enqueue({
      issueId: issue.id,
      ...approval,
      approved: { ...approval.approved, evidenceManifestRef: 'evidence:first' },
    })

    await expect(
      service.enqueue({
        issueId: issue.id,
        ...approval,
        approved: {
          ...approval.approved,
          evidenceManifestRef: 'evidence:changed',
        },
      }),
    ).rejects.toMatchObject({ code: 'source-stale' })
    service.dispose()
  })

  it('freezes the nearest native Git-stack predecessor as a delivery edge', async () => {
    let lowerIssueId = ''
    const { issues, service } = harness(undefined, {
      resolveBranchTip: async (issue) => (issue.id === lowerIssueId ? 'lower-head' : 'upper-head'),
      isAncestor: async (_issue, ancestor, descendant) =>
        ancestor === 'lower-head' && descendant === 'upper-head',
    })
    const lower = issues.create({
      repoPath: '/repo',
      title: 'lower layer',
      startNow: false,
    })
    lowerIssueId = lower.id
    const upper = issues.create({
      repoPath: '/repo',
      title: 'upper layer',
      startNow: false,
    })
    issues.update(lower.id, { stage: 'review' })
    issues.update(upper.id, { stage: 'review' })
    const lowerOrder = await service.enqueue({
      issueId: lower.id,
      ...approval,
      approved: { ...approval.approved, sourceHeadSha: 'lower-head' },
    })
    const upperOrder = await service.enqueue({
      issueId: upper.id,
      ...approval,
      approved: { ...approval.approved, sourceHeadSha: 'upper-head' },
    })

    expect(upperOrder.order.deliveryDependsOn).toEqual([lowerOrder.order.id])
    service.dispose()
  })

  it('refuses active-order replay when the live root head moved', async () => {
    let liveHead = 'head-sha'
    const { issues, service } = harness(undefined, {
      resolveBranchTip: async () => liveHead,
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'live replay fence',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    await service.enqueue({ issueId: issue.id, ...approval })

    liveHead = 'advanced-head-sha'
    await expect(service.enqueue({ issueId: issue.id, ...approval })).rejects.toMatchObject({
      code: 'source-stale',
    })
    service.dispose()
  })

  it('refuses admission when repository refs move before custody commits', async () => {
    let sourceReads = 0
    const { store, issues, service } = harness(undefined, {
      resolveBranchTip: async () => (++sourceReads === 1 ? 'head-sha' : 'advanced-head-sha'),
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'admission ref race',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })

    await expect(service.enqueue({ issueId: issue.id, ...approval })).rejects.toMatchObject({
      code: 'source-stale',
    })
    expect(store.shipping.activeOrderForIssue(issue.id)).toBeNull()
    expect(store.issues.getIssue(issue.id)?.stage).toBe('review')
    service.dispose()
  })

  it('rolls back issue custody and the order when the ledger append fails', async () => {
    const { store, issues, service } = harness()
    const issue = issues.create({
      repoPath: '/repo',
      title: 'rollback',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const append = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })

    await expect(service.enqueue({ issueId: issue.id, ...approval })).rejects.toThrow(
      'append failed',
    )
    append.mockRestore()
    expect(store.issues.getIssue(issue.id)?.stage).toBe('review')
    expect(store.shipping.activeOrderForIssue(issue.id)).toBeNull()
    service.dispose()
  })

  it('atomically creates or returns one order when identical admissions race', async () => {
    const { store, issues, service } = harness()
    const issue = issues.create({
      repoPath: '/repo',
      title: 'concurrent',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })

    const receipts = await Promise.all([
      service.enqueue({ issueId: issue.id, ...approval }),
      service.enqueue({ issueId: issue.id, ...approval }),
    ])
    expect(receipts.map((receipt) => receipt.created).sort()).toEqual([false, true])
    expect(new Set(receipts.map((receipt) => receipt.order.id)).size).toBe(1)
    expect(store.shipping.listOrders()).toHaveLength(1)
    expect(store.issues.getIssue(issue.id)?.stage).toBe('shipping')
    service.dispose()
  })

  it('rejects a nested issue with the highest root and exact safe retry command', async () => {
    const { issues, service } = harness()
    const root = issues.create({
      repoPath: '/repo',
      title: 'root',
      startNow: false,
    })
    const middle = issues.create({
      repoPath: '/repo',
      title: 'middle',
      parentId: root.id,
      startNow: false,
    })
    const leaf = issues.create({
      repoPath: '/repo',
      title: 'leaf',
      parentId: middle.id,
      startNow: false,
    })
    const rootRef = issues.get(root.id)?.displayRef ?? root.id
    const leafRef = issues.get(leaf.id)?.displayRef ?? leaf.id

    await expect(service.enqueue({ issueId: leaf.id, ...approval })).rejects.toMatchObject({
      code: 'nested-root',
      rootIssueId: root.id,
      message:
        `${leafRef} is a sub-issue of delivery root ${rootRef} and cannot ship separately.\n` +
        `To nominate the approved root: podium issue ship ${rootRef} --outside-scope`,
    })
    service.dispose()
  })

  it('freezes the exact typed integration receipt for the live root and descendant tips', async () => {
    const { store, issues, service } = harness(undefined, {
      useStoredReceipts: true,
    })
    const root = issues.create({
      repoPath: '/repo',
      title: 'root',
      startNow: false,
    })
    const child = issues.create({
      repoPath: '/repo',
      title: 'child',
      startNow: false,
      parentId: root.id,
    })
    issues.update(child.id, { stage: 'done' })
    issues.update(root.id, { stage: 'review' })

    await expect(service.enqueue({ issueId: root.id, ...approval })).rejects.toMatchObject({
      code: 'evidence',
    })
    const immutableReceipt = store.shipping.recordRootIntegrationReceipt({
      rootIssueId: root.id,
      approvedHeadSha: 'head-sha',
      descendants: [{ issueId: child.id, approvedHeadSha: 'head-sha' }],
    })
    const accepted = await service.enqueue({
      issueId: root.id,
      ...approval,
      approved: { ...approval.approved, evidenceManifestRef: 'evidence:root' },
    })
    expect(accepted.descendantManifest).toEqual([
      { issueId: child.id, approvedHeadSha: 'head-sha' },
    ])
    expect(accepted.order.currentIntegrationReceipt).toEqual(immutableReceipt)
    expect(store.shipping.getOrder(accepted.order.id)?.currentIntegrationReceipt).toEqual(
      immutableReceipt,
    )
    service.dispose()
  })

  it('refuses stale or manifest-mismatched immutable integration proof', async () => {
    const { store, issues, service } = harness(undefined, {
      useStoredReceipts: true,
    })
    const root = issues.create({
      repoPath: '/repo',
      title: 'root refusal',
      startNow: false,
    })
    const child = issues.create({
      repoPath: '/repo',
      title: 'child refusal',
      startNow: false,
      parentId: root.id,
    })
    issues.update(child.id, { stage: 'done' })
    issues.update(root.id, { stage: 'review' })
    store.shipping.recordRootIntegrationReceipt({
      rootIssueId: root.id,
      approvedHeadSha: 'head-sha',
      descendants: [{ issueId: child.id, approvedHeadSha: 'stale-child-sha' }],
    })

    await expect(
      service.enqueue({
        issueId: root.id,
        ...approval,
        approved: {
          ...approval.approved,
          evidenceManifestRef: 'evidence:root',
        },
      }),
    ).rejects.toMatchObject({ code: 'evidence' })
    expect(store.shipping.activeOrderForIssue(root.id)).toBeNull()
    expect(store.issues.getIssue(root.id)?.stage).toBe('review')
    service.dispose()
  })

  it('admits a top-level leaf without fabricating a descendant integration receipt', async () => {
    const { store, issues, service } = harness(undefined, {
      rootIntegrationReceipt: () => null,
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'top-level leaf',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })

    const accepted = await service.enqueue({ issueId: issue.id, ...approval })
    expect(accepted.descendantManifest).toEqual([])
    expect(accepted.order.currentIntegrationReceipt).toBeUndefined()
    expect(store.shipping.activeOrderForIssue(issue.id)?.id).toBe(accepted.order.id)
    expect(store.issues.getIssue(issue.id)?.stage).toBe('shipping')
    service.dispose()
  })

  it('freezes only typed review evidence bound to the exact live approval', async () => {
    const compatibility = new CompatibilityShippingPolicyResolver(() => 'main')
    const policy: ShippingPolicyResolver = {
      resolve: (issue) => ({
        ...compatibility.resolve(issue),
        evidenceOptional: false,
      }),
    }
    const acceptedReviewEvidence = vi.fn(
      (input: Omit<AcceptedReviewEvidence, 'evidenceManifestRef' | 'previewLeaseIds'>) => ({
        ...input,
        evidenceManifestRef: 'review-evidence-snapshot',
        previewLeaseIds: ['preview-1'],
      }),
    )
    const { issues, service } = harness(undefined, {
      policy,
      acceptedReviewEvidence,
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'evidence required',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })

    const accepted = await service.enqueueCurrent({
      issueId: issue.id,
      principal: approval.principal,
      overrideScope: false,
    })
    expect(acceptedReviewEvidence).toHaveBeenCalledWith({
      issueId: issue.id,
      sourceBaseSha: 'base-sha',
      sourceHeadSha: 'head-sha',
      policyId: 'compatibility-local:main',
    })
    expect(accepted.order.evidenceManifestRef).toBe('review-evidence-snapshot')
    service.dispose()
  })

  it('allows compatibility null evidence and rejects strict null or mismatched evidence unchanged', async () => {
    const compatibility = new CompatibilityShippingPolicyResolver(() => 'main')
    const compatible = harness()
    const compatibleIssue = compatible.issues.create({
      repoPath: '/repo',
      title: 'compatibility evidence',
      startNow: false,
    })
    compatible.issues.update(compatibleIssue.id, { stage: 'review' })
    const accepted = await compatible.service.enqueueCurrent({
      issueId: compatibleIssue.id,
      principal: approval.principal,
      overrideScope: false,
    })
    expect(accepted.order.evidenceManifestRef).toBeUndefined()
    compatible.service.dispose()

    const strictPolicy: ShippingPolicyResolver = {
      resolve: (issue) => ({
        ...compatibility.resolve(issue),
        evidenceOptional: false,
      }),
    }
    for (const acceptedReviewEvidence of [
      () => null,
      (input: Omit<AcceptedReviewEvidence, 'evidenceManifestRef' | 'previewLeaseIds'>) => ({
        ...input,
        sourceHeadSha: 'different-reviewed-head',
        evidenceManifestRef: 'mismatched-evidence',
        previewLeaseIds: [],
      }),
    ]) {
      const strict = harness(undefined, {
        policy: strictPolicy,
        acceptedReviewEvidence,
      })
      const issue = strict.issues.create({
        repoPath: '/repo',
        title: 'strict evidence',
        startNow: false,
      })
      strict.issues.update(issue.id, { stage: 'review' })
      await expect(
        strict.service.enqueueCurrent({
          issueId: issue.id,
          principal: approval.principal,
          overrideScope: false,
        }),
      ).rejects.toMatchObject({ code: 'evidence' })
      expect(strict.store.shipping.activeOrderForIssue(issue.id)).toBeNull()
      expect(strict.store.issues.getIssue(issue.id)?.stage).toBe('review')
      strict.service.dispose()
    }
  })

  it('collapses unknown and invisible order identities before hold or receipt state leaks', async () => {
    let hidden = false
    const { issues, service } = harness(undefined, {
      authorize: () => {
        if (hidden) throw Object.assign(new Error('hidden root'), { code: 'NOT_FOUND' })
      },
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'opaque order',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    hidden = true

    for (const orderId of [order.id, asShipOrderId('ship_absent')]) {
      expect(() =>
        service.deliveryReceipt({
          orderId,
          principal: approval.principal,
        }),
      ).toThrow(ShippingOrderAccessError)
      await expect(
        service.resolveHold({
          orderId,
          action: 'retry',
          expectedGeneration: 1,
          principal: approval.principal,
        }),
      ).rejects.toThrow('shipping order not found or inaccessible')
      await expect(
        service.cancel({
          orderId,
          principal: approval.principal,
          overrideScope: false,
        }),
      ).rejects.toThrow('shipping order not found or inaccessible')
    }
    service.dispose()
  })

  it('raises and generation-fences the typed hold before clearing needsHuman', async () => {
    const { store, ledger, issues, service } = harness(async (input, machineId) => ({
      jobId: input.jobId,
      requestDigest: input.requestDigest,
      orderId: input.orderId,
      attemptId: input.attemptId,
      machineId,
      generation: input.generation,
      operation: input.operation,
      state: input.operation === 'commit-merge-group' ? 'held' : 'succeeded',
      classification:
        input.operation === 'commit-merge-group' ? 'unsupported-destination-effect' : 'observed',
      summary:
        input.operation === 'commit-merge-group'
          ? 'executor stopped before mutation'
          : 'fences match',
      observedSourceSha: input.approvedHeadSha,
      observedTargetSha: input.expectedTargetSha,
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
      finishedAt: '2026-08-13T10:00:00.000Z',
    }))
    const issue = issues.create({
      repoPath: '/repo',
      title: 'held',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    expect(store.shipping.getOrder(order.id)?.state).toBe('held')
    expect(store.issues.getIssue(issue.id)?.needsHuman).toBe(true)
    const hold = store.shipping.openHoldForOrder(order.id)
    expect(hold).toMatchObject({
      generation: 1,
      actions: ['retry', 'return-to-issue'],
    })
    await expect(
      service.resolveHold({
        orderId: order.id,
        action: 'retry',
        expectedGeneration: 2,
        principal: approval.principal,
        requestedBy: approval.requestedBy,
      }),
    ).rejects.toThrow(/generation fence/)
    expect(store.issues.getIssue(issue.id)?.needsHuman).toBe(true)

    await service.resolveHold({
      orderId: order.id,
      action: 'retry',
      expectedGeneration: 1,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
    })
    expect(store.shipping.getOrder(order.id)?.state).toBe('queued')
    expect(store.issues.getIssue(issue.id)?.needsHuman).toBe(false)
    const projected = ledger.authority.snapshot('shipOrder') as {
      id: string
      hold?: unknown
    }[]
    expect(projected.find((row) => row.id === order.id)).not.toHaveProperty('hold')
    await service.runOrder(order.id)
    expect(store.shipping.latestAttemptForOrder(order.id)?.leaseGeneration).toBe(2)
    expect(store.shipping.openHoldForOrder(order.id)?.generation).toBe(2)
    service.dispose()
  })

  it('authorizes admission and hold resolution and reauthorizes before landing', async () => {
    const authorize = vi.fn()
    const reauthorize = vi.fn((input: { effect: string }) => {
      if (input.effect === 'commit-merge-group') throw new Error('grant revoked')
    })
    const { issues, service, store } = harness(
      async (input, machineId) => ({
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        orderId: input.orderId,
        attemptId: input.attemptId,
        machineId,
        generation: input.generation,
        operation: input.operation,
        state: 'succeeded',
        classification: 'observed',
        summary: 'fences match',
        observedSourceSha: input.approvedHeadSha,
        observedTargetSha: input.expectedTargetSha,
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
        finishedAt: '2026-08-13T10:00:00.000Z',
      }),
      { authorize, reauthorize },
    )
    const issue = issues.create({
      repoPath: '/repo',
      title: 'auth',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'enqueue' }))
    expect(reauthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: 'commit-merge-group',
        machineId: 'machine-1',
      }),
    )
    expect(store.shipping.getOrder(order.id)?.state).toBe('held')
    expect(store.shipping.getOrder(order.id)?.holdCode).toBe('policy-refused')
    service.dispose()
  })

  it('takes non-forcing branch custody before dispatching preflight', async () => {
    const shippingJob = vi.fn(provedShippingJob)
    const takeBranchCustody = vi.fn(async () => ({
      ok: false,
      detail: 'source worktree has unsaved changes',
    }))
    const { store, issues, service } = harness(shippingJob, {
      takeBranchCustody,
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'custody',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    expect(takeBranchCustody).toHaveBeenCalledOnce()
    expect(shippingJob).not.toHaveBeenCalled()
    expect(store.shipping.getOrder(order.id)).toMatchObject({
      state: 'held',
      holdCode: 'policy:branch-custody',
    })
    expect(store.shipping.openHoldForOrder(order.id)?.detail).toContain('unsaved changes')
    service.dispose()
  })

  it('refuses daemon-native evidence paths before hold persistence', async () => {
    const { store, issues, service } = harness(async (input, machineId) => ({
      ...(await provedShippingJob(input, machineId)),
      state: 'held',
      classification: 'validation-failed',
      artifactRefs: ['/native/daemon/validation.log'],
    }))
    const issue = issues.create({ repoPath: '/repo', title: 'opaque evidence', startNow: false })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await service.runOrder(order.id)

    expect(store.shipping.openHoldForOrder(order.id)?.evidenceRefs).not.toContain(
      '/native/daemon/validation.log',
    )
    service.dispose()
  })

  it('uses attempt-scoped admission, a short merge lock, and a separate publish lock', async () => {
    const events: string[] = []
    const resourceAdmission = {
      acquire: vi.fn(
        ({
          names,
          attempt,
        }: Parameters<
          NonNullable<
            ConstructorParameters<typeof ShippingService>[0]['resourceAdmission']
          >['acquire']
        >[0]) => {
          events.push(`acquire:${attempt.id}:${attempt.leaseGeneration}:${names.join(',')}`)
          return true
        },
      ),
      renew: vi.fn(() => true),
      release: vi.fn(
        ({
          names,
          attempt,
        }: Parameters<
          NonNullable<
            ConstructorParameters<typeof ShippingService>[0]['resourceAdmission']
          >['release']
        >[0]) => {
          events.push(`release:${attempt.id}:${attempt.leaseGeneration}:${names.join(',')}`)
        },
      ),
    }
    const { store, issues, service } = harness(provedShippingJob, {
      resourceAdmission,
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'resource locks',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    expect(store.shipping.getOrder(order.id)?.state).toBe('shipped')
    const attempt = store.shipping.latestAttemptForOrder(order.id)!
    const prefix = `${attempt.id}:${attempt.leaseGeneration}`
    expect(events).toEqual([
      `acquire:${prefix}:validation:agent`,
      `release:${prefix}:validation:agent`,
      `acquire:${prefix}:merge:main`,
      `release:${prefix}:merge:main`,
      `acquire:${prefix}:publish:${createHash('sha256').update('local:main').digest('hex')}`,
      `release:${prefix}:publish:${createHash('sha256').update('local:main').digest('hex')}`,
    ])
    service.dispose()
  })

  it('gives equivalent local destinations one publication lock key', () => {
    const destinations = ['main', 'local:main', 'refs/heads/main']
    const canonical = destinations.map((destination) =>
      canonicalShippingDestination(destination, 'main'),
    )
    expect(new Set(canonical)).toEqual(new Set(['local:main']))
    expect(
      new Set(
        canonical.map(
          (destination) => `publish:${createHash('sha256').update(destination).digest('hex')}`,
        ),
      ).size,
    ).toBe(1)
    expect(canonicalShippingDestination('remote:origin/main', 'main')).toBe('git:origin/main')
    expect(canonicalShippingDestination('git:origin/main', 'main')).toBe('git:origin/main')
  })

  it('includes worker incarnation in the resource holder identity', () => {
    const facts = ['order-1', 'attempt-1', 1] as const
    const first = shippingResourceHolderId('worker-a', ...facts)
    const restarted = shippingResourceHolderId('worker-b', ...facts)
    expect(first).not.toBe(restarted)
    expect(first).toBe('system:shipping:worker-a:order-1:attempt-1:1')
  })

  it('renews an active merge lease while its daemon effect is still running', async () => {
    vi.useFakeTimers()
    let markCommitStarted!: () => void
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve
    })
    let finishCommit!: () => void
    const daemon: NonNullable<
      ConstructorParameters<typeof ShippingService>[0]['daemon']
    >['shippingJob'] = async (input, machineId) => {
      if (input.action === 'start' && input.operation === 'commit-merge-group') {
        markCommitStarted()
        return new Promise<ShippingJobResult>((resolve) => {
          finishCommit = () => {
            void provedShippingJob(input, machineId).then(resolve)
          }
        })
      }
      return provedShippingJob(input, machineId)
    }
    const renew = vi.fn(() => true)
    const release = vi.fn()
    const resourceAdmission = { acquire: vi.fn(() => true), renew, release }
    const { store, issues, service } = harness(daemon, { resourceAdmission })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'renew lease',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    const running = service.runOrder(order.id)
    await commitStarted
    await vi.advanceTimersByTimeAsync(40_000)
    expect(renew).toHaveBeenCalledWith(
      expect.objectContaining({ names: ['merge:main'], ttlSeconds: 120 }),
    )
    finishCommit()
    await running
    expect(store.shipping.getOrder(order.id)?.state).toBe('shipped')
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ names: ['merge:main'] }))
    service.dispose()
  })

  it('stops durable progress and refuses release after renewal loses the lease', async () => {
    vi.useFakeTimers()
    const dispatched: string[] = []
    let mergeRenewals = 0
    let markCommitStarted!: () => void
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve
    })
    let finishCommit!: () => void
    const daemon: NonNullable<
      ConstructorParameters<typeof ShippingService>[0]['daemon']
    >['shippingJob'] = async (input, machineId) => {
      if (input.action === 'start') dispatched.push(input.operation)
      if (input.action === 'start' && input.operation === 'commit-merge-group') {
        markCommitStarted()
        return new Promise<ShippingJobResult>((resolve) => {
          finishCommit = () => {
            void provedShippingJob(input, machineId).then(resolve)
          }
        })
      }
      return provedShippingJob(input, machineId)
    }
    const renew = vi.fn(
      (
        input: Parameters<
          NonNullable<
            ConstructorParameters<typeof ShippingService>[0]['resourceAdmission']
          >['renew']
        >[0],
      ) => !input.names.includes('merge:main') || ++mergeRenewals === 1,
    )
    const release = vi.fn()
    const resourceAdmission = { acquire: vi.fn(() => true), renew, release }
    const { store, issues, service } = harness(daemon, { resourceAdmission })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'lost lease',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    const running = service.runOrder(order.id)
    await commitStarted
    await vi.advanceTimersByTimeAsync(40_000)
    finishCommit()
    await running
    expect(store.shipping.getOrder(order.id)?.state).toBe('landing')
    expect(dispatched).not.toContain('publish')
    expect(release).not.toHaveBeenCalledWith(expect.objectContaining({ names: ['merge:main'] }))
    service.dispose()
  })

  it('rechecks lock ownership after the effect before committing durable progress', async () => {
    let mergeRenewals = 0
    const renew = vi.fn(
      (
        input: Parameters<
          NonNullable<
            ConstructorParameters<typeof ShippingService>[0]['resourceAdmission']
          >['renew']
        >[0],
      ) => !input.names.includes('merge:main') || ++mergeRenewals === 1,
    )
    const release = vi.fn()
    const { store, issues, service } = harness(provedShippingJob, {
      resourceAdmission: { acquire: vi.fn(() => true), renew, release },
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'post effect fence',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await service.runOrder(order.id)

    expect(renew).toHaveBeenCalledWith(
      expect.objectContaining({ names: ['merge:main'], ttlSeconds: 120 }),
    )
    expect(store.shipping.getOrder(order.id)?.state).toBe('landing')
    expect(release).not.toHaveBeenCalledWith(expect.objectContaining({ names: ['merge:main'] }))
    service.dispose()
  })

  it('refuses daemon mutation when ownership is stolen after acquire but before dispatch', async () => {
    const daemon = vi.fn(provedShippingJob)
    const renew = vi.fn(
      (
        input: Parameters<
          NonNullable<
            ConstructorParameters<typeof ShippingService>[0]['resourceAdmission']
          >['renew']
        >[0],
      ) => !input.names.includes('merge:main'),
    )
    const release = vi.fn()
    const { store, issues, service } = harness(daemon, {
      resourceAdmission: { acquire: vi.fn(() => true), renew, release },
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'dispatch lease',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await service.runOrder(order.id)

    expect(
      daemon.mock.calls.some(
        ([input]) => input.action === 'start' && input.operation === 'commit-merge-group',
      ),
    ).toBe(false)
    expect(store.shipping.getOrder(order.id)?.state).toBe('landing')
    expect(release).not.toHaveBeenCalledWith(expect.objectContaining({ names: ['merge:main'] }))
    service.dispose()
  })

  it('stops renewing active resource leases when disposed during a hung effect', async () => {
    vi.useFakeTimers()
    let markCommitStarted!: () => void
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve
    })
    let finishCommit!: () => void
    const daemon: NonNullable<
      ConstructorParameters<typeof ShippingService>[0]['daemon']
    >['shippingJob'] = async (input, machineId) => {
      if (input.action === 'start' && input.operation === 'commit-merge-group') {
        markCommitStarted()
        return new Promise<ShippingJobResult>((resolve) => {
          finishCommit = () => {
            void provedShippingJob(input, machineId).then(resolve)
          }
        })
      }
      return provedShippingJob(input, machineId)
    }
    const renew = vi.fn(() => true)
    const release = vi.fn()
    const { store, issues, service } = harness(daemon, {
      resourceAdmission: { acquire: vi.fn(() => true), renew, release },
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'dispose lease',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    const running = service.runOrder(order.id)
    await commitStarted
    await vi.advanceTimersByTimeAsync(40_000)
    const renewalsBeforeDispose = renew.mock.calls.length
    service.dispose()
    await vi.advanceTimersByTimeAsync(80_000)
    expect(renew).toHaveBeenCalledTimes(renewalsBeforeDispose)
    finishCommit()
    await running
    expect(store.shipping.getOrder(order.id)?.state).toBe('landing')
    expect(release).not.toHaveBeenCalledWith(expect.objectContaining({ names: ['merge:main'] }))
  })

  it('refuses a mutating dispatch when durable cancellation wins immediately beforehand', async () => {
    const calls: Array<{ action: string; operation: string }> = []
    const daemon = async (
      input: Parameters<typeof provedShippingJob>[0],
      machineId: Parameters<typeof provedShippingJob>[1],
    ) => {
      calls.push({ action: input.action, operation: input.operation })
      if (input.action === 'cancel') {
        return {
          ...(await provedShippingJob(input, machineId)),
          state: 'cancelled' as const,
          classification: 'cancelled' as const,
          summary: 'cancelled before dispatch',
        }
      }
      return provedShippingJob(input, machineId)
    }
    let service!: ShippingService
    let cancellation: Promise<unknown> | undefined
    const resourceAdmission = {
      acquire: vi.fn(
        (
          input: Parameters<
            NonNullable<
              ConstructorParameters<typeof ShippingService>[0]['resourceAdmission']
            >['acquire']
          >[0],
        ) => {
          if (input.names.includes('validation:agent')) {
            cancellation = service.cancel({
              orderId: input.order.id,
              principal: approval.principal,
              requestedBy: approval.requestedBy,
              overrideScope: false,
            })
          }
          return true
        },
      ),
      renew: vi.fn(() => true),
      release: vi.fn(),
    }
    const setup = harness(daemon, { resourceAdmission })
    service = setup.service
    const issue = setup.issues.create({
      repoPath: '/repo',
      title: 'cancel fence',
      startNow: false,
    })
    setup.issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    await cancellation
    expect(calls).not.toContainEqual({
      action: 'start',
      operation: 'validate',
    })
    expect(setup.store.shipping.getOrder(order.id)?.state).toBe('cancelled')
    service.dispose()
  })

  it('recovers a crash after daemon verification without splitting attempt and receipt commits', async () => {
    let crash = true
    const daemon = async (
      input: Parameters<
        NonNullable<ConstructorParameters<typeof ShippingService>[0]['daemon']>['shippingJob']
      >[0],
      machineId: Parameters<
        NonNullable<ConstructorParameters<typeof ShippingService>[0]['daemon']>['shippingJob']
      >[1],
    ) => ({
      jobId: input.jobId,
      requestDigest: input.requestDigest,
      orderId: input.orderId,
      attemptId: input.attemptId,
      machineId,
      generation: input.generation,
      operation: input.operation,
      state: 'succeeded' as const,
      classification: 'proved' as const,
      summary: 'durable proof',
      observedSourceSha: input.approvedHeadSha,
      observedTargetSha: input.expectedTargetSha,
      ...(input.operation === 'verify'
        ? {
            observedDestinationSha: input.approvedHeadSha,
            testedIntegrationSha: input.approvedHeadSha,
            landedRefSha: input.approvedHeadSha,
            validationProfileId: input.validationProfile.id,
            validationResult: 'passed' as const,
          }
        : {}),
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
      finishedAt: '2026-08-13T10:00:00.000Z',
    })
    const { store, issues, service, deps } = harness(daemon, {
      beforeCompletionCommit: () => {
        if (crash) throw new Error('simulated server crash before completion commit')
      },
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'recover',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await expect(service.runOrder(order.id)).rejects.toThrow(/simulated server crash/)
    expect(store.shipping.getOrder(order.id)?.state).toBe('verifying')
    expect(store.shipping.latestAttemptForOrder(order.id)?.finishedAt).toBeUndefined()
    expect(store.shipping.receiptForOrder(order.id)).toBeNull()
    expect(store.issues.getIssue(issue.id)?.stage).toBe('shipping')
    service.dispose()

    crash = false
    const restarted = new ShippingService({
      ...deps,
      beforeCompletionCommit: () => {},
    })
    await restarted.reconcile()
    expect(store.shipping.getOrder(order.id)?.state).toBe('shipped')
    expect(store.shipping.latestAttemptForOrder(order.id)).toMatchObject({
      outcome: 'succeeded',
      validationResult: 'passed',
    })
    expect(store.shipping.receiptForOrder(order.id)).not.toBeNull()
    const storedReceipt = store.shipping.receiptForOrder(order.id)!
    expect(
      restarted.deliveryReceipt({
        orderId: order.id,
        principal: approval.principal,
      }),
    ).toEqual(storedReceipt)
    expect(storedReceipt).toMatchObject({
      approvedBaseSha: 'base-sha',
      approvedHeadSha: 'head-sha',
      testedIntegrationSha: 'head-sha',
      landedRefSha: 'head-sha',
      destinationSha: 'head-sha',
      validationResult: 'passed',
    })
    expect(store.issues.getIssue(issue.id)?.stage).toBe('done')
    restarted.dispose()
  })

  it('settles and fences daemon cancellation before releasing issue custody', async () => {
    const authorize = vi.fn()
    const { store, issues, service } = harness(
      async (input, machineId) => ({
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        orderId: input.orderId,
        attemptId: input.attemptId,
        machineId,
        generation: input.generation,
        operation: input.operation,
        state: input.action === 'cancel' ? ('cancelled' as const) : ('running' as const),
        classification: input.action === 'cancel' ? ('cancelled' as const) : ('observed' as const),
        summary: input.action === 'cancel' ? 'cancelled durably' : 'running',
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
        ...(input.action === 'cancel' ? { finishedAt: '2026-08-13T10:00:00.000Z' } : {}),
      }),
      { authorize },
    )
    const issue = issues.create({
      repoPath: '/repo',
      title: 'cancel',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    expect(store.shipping.getOrder(order.id)?.state).toBe('preflight')

    await service.cancel({
      orderId: order.id,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
      overrideScope: false,
    })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel' }))
    expect(store.shipping.getOrder(order.id)?.state).toBe('cancelled')
    expect(store.shipping.latestAttemptForOrder(order.id)?.outcome).toBe('cancelled')
    expect(store.issues.getIssue(issue.id)?.stage).toBe('review')
    service.dispose()
  })

  it('resumes the durable attempt generation after restart', async () => {
    const generations: number[] = []
    const { store, issues, service, deps } = harness(async (input, machineId) => {
      generations.push(input.generation)
      return {
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        orderId: input.orderId,
        attemptId: input.attemptId,
        machineId,
        generation: input.generation,
        operation: input.operation,
        state: 'running',
        classification: 'observed',
        summary: 'still running',
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
      }
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'supersede',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const first = store.shipping.latestAttemptForOrder(order.id)
    expect(first?.leaseGeneration).toBe(1)
    expect(first?.outcome).toBeUndefined()
    service.dispose()

    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect(generations).toEqual([1, 1])
    expect(store.shipping.getAttempt(first!.id)?.outcome).toBeUndefined()
    expect(store.shipping.latestAttemptForOrder(order.id)).toMatchObject({
      leaseGeneration: 1,
    })
    restarted.dispose()
  })

  it('rejects a stale attempt claimant and requires exact terminal timestamps', async () => {
    const { store, issues, service } = harness(async (input, machineId) => ({
      jobId: input.jobId,
      requestDigest: input.requestDigest,
      orderId: input.orderId,
      attemptId: input.attemptId,
      machineId,
      generation: input.generation,
      operation: input.operation,
      state: 'running',
      classification: 'observed',
      summary: 'still running',
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
    }))
    const issue = issues.create({
      repoPath: '/repo',
      title: 'claim cas',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const first = store.shipping.latestAttemptForOrder(order.id)!
    const claimed = store.shipping.claimAttempt({
      orderId: order.id,
      expectedState: 'preflight',
      expectedAttemptId: first.id,
      expectedGeneration: first.leaseGeneration,
      machineId: first.machineId,
      startedAt: '2026-08-13T10:00:01.000Z',
    })
    expect(claimed.attempt.leaseGeneration).toBe(2)
    expect(() =>
      store.shipping.claimAttempt({
        orderId: order.id,
        expectedState: 'preflight',
        expectedAttemptId: first.id,
        expectedGeneration: first.leaseGeneration,
        machineId: first.machineId,
        startedAt: '2026-08-13T10:00:01.000Z',
      }),
    ).toThrow(/superseded/)
    store.shipping.finishAttempt(claimed.attempt.id, 2, {
      finishedAt: '2026-08-13T10:00:02.000Z',
      outcome: 'failed',
    })
    expect(() =>
      store.shipping.finishAttempt(claimed.attempt.id, 2, {
        finishedAt: '2026-08-13T10:00:03.000Z',
        outcome: 'failed',
      }),
    ).toThrow(/immutable/)
    expect(() =>
      store.shipping.finishAttempt(claimed.attempt.id, 1, {
        finishedAt: '2026-08-13T10:00:02.000Z',
        outcome: 'failed',
      }),
    ).toThrow(/generation fence/)
    service.dispose()
  })

  it('recovers durable cancellation intent without superseding its attempt', async () => {
    const generations: number[] = []
    const { store, issues, service, deps } = harness(async (input, machineId) => {
      generations.push(input.generation)
      return {
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        orderId: input.orderId,
        attemptId: input.attemptId,
        machineId,
        generation: input.generation,
        operation: input.operation,
        state: input.action === 'cancel' ? ('cancelled' as const) : ('running' as const),
        classification: input.action === 'cancel' ? ('cancelled' as const) : ('observed' as const),
        summary: input.action === 'cancel' ? 'cancelled durably' : 'still running',
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
        ...(input.action === 'cancel' ? { finishedAt: '2026-08-13T10:00:00.000Z' } : {}),
      }
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'cancel recovery',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const first = store.shipping.latestAttemptForOrder(order.id)!
    const effectKey = `cancel:${first.leaseGeneration}`
    const inputFence = {
      sourceBaseSha: first.expectedSourceBaseSha,
      approvedHeadSha: first.approvedHeadSha,
      targetSha: first.expectedTargetSha,
    }
    const recordedAt = '2026-08-13T10:00:00.000Z'
    store.shipping.requestCancellation({
      orderId: order.id,
      expectedState: 'preflight',
      attemptId: first.id,
      generation: first.leaseGeneration,
      planned: {
        id: asShipStepId(`step:${first.id}:${effectKey}:planned`),
        orderId: order.id,
        attemptId: first.id,
        effectKey,
        idempotencyKey: `${effectKey}:planned`,
        generation: first.leaseGeneration,
        inputFence,
        kind: 'cancel',
        state: 'planned',
        summary: 'effect planned',
        recordedAt,
      },
      running: {
        id: asShipStepId(`step:${first.id}:${effectKey}:running`),
        orderId: order.id,
        attemptId: first.id,
        effectKey,
        idempotencyKey: `${effectKey}:running`,
        generation: first.leaseGeneration,
        inputFence,
        kind: 'cancel',
        state: 'running',
        summary: 'effect dispatched',
        recordedAt,
        startedAt: recordedAt,
      },
    })
    expect(store.shipping.latestStepForEffect(first.id, effectKey)).toMatchObject({
      state: 'running',
    })
    expect(() =>
      store.shipping.claimAttempt({
        orderId: order.id,
        expectedState: 'preflight',
        expectedAttemptId: first.id,
        expectedGeneration: first.leaseGeneration,
        machineId: first.machineId,
        startedAt: '2026-08-13T10:00:01.000Z',
      }),
    ).toThrow(/durable cancellation intent/)
    service.dispose()

    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect(store.shipping.getOrder(order.id)?.state).toBe('cancelled')
    expect(store.shipping.latestAttemptForOrder(order.id)).toMatchObject({
      id: first.id,
      leaseGeneration: 1,
      outcome: 'cancelled',
    })
    expect(generations).toEqual([1, 1])
    restarted.dispose()
  })

  it('terminalizes cancellation intent atomically when live authorization is refused', async () => {
    const { store, issues, service } = harness(
      async (input, machineId) => ({
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        orderId: input.orderId,
        attemptId: input.attemptId,
        machineId,
        generation: input.generation,
        operation: input.operation,
        state: 'running',
        classification: 'observed',
        summary: 'still running',
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
      }),
      {
        reauthorize: ({ effect }) => {
          if (effect === 'cancel') throw new Error('delegation revoked')
        },
      },
    )
    const issue = issues.create({
      repoPath: '/repo',
      title: 'cancel refusal',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const attempt = store.shipping.latestAttemptForOrder(order.id)!

    const held = await service.cancel({
      orderId: order.id,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
      overrideScope: false,
    })
    expect(held).toMatchObject({ state: 'held', holdCode: 'policy-refused' })
    expect(store.shipping.getAttempt(attempt.id)).toMatchObject({
      outcome: 'failed',
    })
    expect(
      store.shipping.latestStepForEffect(attempt.id, `cancel:${attempt.leaseGeneration}`),
    ).toMatchObject({
      state: 'failed',
      outcome: 'authorization-refused',
      summary: 'delegation revoked',
    })
    expect(store.shipping.hasCancellationIntent(attempt.id, attempt.leaseGeneration)).toBe(false)
    service.dispose()
  })

  it('terminalizes cancellation intent atomically when daemon cancellation rejects', async () => {
    const { store, issues, service } = harness(async (input, machineId) => {
      if (input.action === 'cancel') throw new Error('daemon disconnected')
      return {
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        orderId: input.orderId,
        attemptId: input.attemptId,
        machineId,
        generation: input.generation,
        operation: input.operation,
        state: 'running',
        classification: 'observed',
        summary: 'still running',
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
      }
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'cancel rpc refusal',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const attempt = store.shipping.latestAttemptForOrder(order.id)!

    const held = await service.cancel({
      orderId: order.id,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
      overrideScope: false,
    })
    expect(held).toMatchObject({
      state: 'held',
      holdCode: 'machine-unavailable',
    })
    expect(store.shipping.getAttempt(attempt.id)).toMatchObject({
      outcome: 'failed',
    })
    expect(
      store.shipping.latestStepForEffect(attempt.id, `cancel:${attempt.leaseGeneration}`),
    ).toMatchObject({
      state: 'failed',
      outcome: 'cancel-error',
      summary: 'daemon disconnected',
    })
    expect(store.shipping.hasCancellationIntent(attempt.id, attempt.leaseGeneration)).toBe(false)
    service.dispose()
  })

  it('persists cancellation intent before awaiting and refuses the late effect result', async () => {
    let resolveStart!: (result: ShippingJobResult) => void
    let startRequestDigest = ''
    let sawStart!: () => void
    const started = new Promise<void>((resolve) => {
      sawStart = resolve
    })
    const { store, issues, service } = harness(async (input, machineId) => {
      const base = {
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        orderId: input.orderId,
        attemptId: input.attemptId,
        machineId,
        generation: input.generation,
        operation: input.operation,
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
      }
      if (input.action === 'cancel') {
        return {
          ...base,
          state: 'cancelled',
          classification: 'cancelled',
          summary: 'cancelled durably',
          finishedAt: '2026-08-13T10:00:00.000Z',
        }
      }
      startRequestDigest = input.requestDigest
      sawStart()
      return new Promise((resolve) => {
        resolveStart = resolve
      })
    })
    const issue = issues.create({
      repoPath: '/repo',
      title: 'late result',
      startNow: false,
    })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    const execution = service.runOrder(order.id)
    await started
    const cancellation = service.cancel({
      orderId: order.id,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
      overrideScope: false,
    })
    await cancellation
    const attempt = store.shipping.latestAttemptForOrder(order.id)!
    expect(
      store.shipping.latestStepForEffect(attempt.id, `cancel:${attempt.leaseGeneration}`),
    ).toMatchObject({ state: 'succeeded', outcome: 'cancelled' })
    resolveStart({
      jobId: `${attempt.id}:preflight`,
      requestDigest: startRequestDigest,
      orderId: order.id,
      attemptId: attempt.id,
      machineId: attempt.machineId,
      generation: attempt.leaseGeneration,
      operation: 'preflight',
      state: 'succeeded',
      classification: 'observed',
      summary: 'late success',
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
      finishedAt: '2026-08-13T10:00:00.000Z',
    })
    await execution
    expect(store.shipping.getOrder(order.id)?.state).toBe('cancelled')
    expect(
      store.shipping.latestStepForEffect(attempt.id, `preflight:${attempt.leaseGeneration}`),
    ).toMatchObject({ state: 'cancelled' })
    expect(store.issues.getIssue(issue.id)?.stage).toBe('review')
    service.dispose()
  })

  it('replays an identical repair result and acknowledges only after the hold commits', async () => {
    let crashBeforeAcknowledgement = true
    const decision = {
      kind: 'needs-decision' as const,
      resultToken: 'repair-result-1',
      reasonCode: 'policy:behavior-change' as const,
      headline: 'Behavior changed',
      detail: 'The repair changes behavior and needs review.',
      evidenceRefs: ['artifact:repair'],
      actions: ['return-to-issue' as const],
    }
    const consider = vi.fn(
      async (_input: Parameters<ShippingRepairPort['consider']>[0]) => decision,
    )
    const acknowledge = vi.fn(async (input: Parameters<ShippingRepairPort['acknowledge']>[0]) => {
      if (input.generation !== 1) throw new Error('stale repair generation')
    })
    const repair: ShippingRepairPort = { consider, acknowledge }
    const daemon: Parameters<typeof harness>[0] = async (input, machineId) => {
      if (input.action === 'start' && input.operation === 'validate') {
        return {
          jobId: input.jobId,
          requestDigest: input.requestDigest,
          orderId: input.orderId,
          attemptId: input.attemptId,
          machineId,
          generation: input.generation,
          operation: input.operation,
          state: 'held',
          classification: 'validation-failed',
          summary: 'validation failed',
          validationProfileId: input.validationProfile.id,
          validationResult: 'failed',
          logs: [],
          artifactRefs: [],
          heartbeatedAt: '2026-08-13T10:00:00.000Z',
          finishedAt: '2026-08-13T10:00:00.000Z',
        }
      }
      return provedShippingJob(input, machineId)
    }
    const { store, issues, service, deps } = harness(daemon, {
      repair,
      beforeRepairAcknowledge: () => {
        if (crashBeforeAcknowledgement) throw new Error('crash before repair ack')
      },
    })
    const issue = issues.create({ repoPath: '/repo', title: 'repair ack', startNow: false })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await expect(service.runOrder(order.id)).rejects.toThrow(/crash before repair ack/)
    expect(store.shipping.getOrder(order.id)).toMatchObject({
      state: 'held',
      holdCode: 'policy:behavior-change',
    })
    expect(acknowledge).not.toHaveBeenCalled()
    service.dispose()

    crashBeforeAcknowledgement = false
    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect(consider).toHaveBeenCalledTimes(2)
    const firstContext = consider.mock.calls[0]![0]
    const replayContext = consider.mock.calls[1]![0]
    expect({ ...replayContext, issue: undefined }).toEqual({ ...firstContext, issue: undefined })
    expect(acknowledge).toHaveBeenCalledWith({
      resultToken: decision.resultToken,
      orderId: order.id,
      attemptId: `attempt:${order.id}:1`,
      generation: 1,
      contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    restarted.dispose()
  })
})
