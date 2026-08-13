import { asMachineId, FIRST_ADMIN_USER_ID, type IssueWire } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { IssueService } from '../issues/service'
import { CompatibilityShippingPolicyResolver } from './policy'
import { ShippingService } from './service'

const stores: SessionStore[] = []
afterEach(() => {
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
    reauthorize?: () => void
    beforeCompletionCommit?: () => void
    resolveIntegrationReceipt?: ConstructorParameters<
      typeof ShippingService
    >[0]['evidence']['resolveIntegrationReceipt']
    persistAccepted?: ConstructorParameters<
      typeof ShippingService
    >[0]['evidence']['persistAccepted']
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
    spawnSession: () => ({ sessionId: 'session-1' as never, machine: 'machine-1' }),
    repoOp: async () => ({ ok: true, output: '' }),
    funnel: { run: (op) => op.write() },
    ledger,
    publishSpecs: {
      issueUpdated: (issue) => ({ rows: [{ id: issue.id, value: issue }] }),
      issuesChanged: (rows) => ({ rows: rows.map((issue) => ({ id: issue.id, value: issue })) }),
    },
  })
  const issuePort = {
    get(id: string): IssueWire {
      const issue = issues.get(id)
      if (!issue) throw new Error(`unknown issue ${id}`)
      return { ...issue, branch: issue.branch ?? `issue/${issue.seq}-shipping-test` }
    },
    children: (id: string, recursive?: boolean) =>
      issues.children(id, recursive).map((issue) => ({
        ...issue,
        branch: issue.branch ?? `issue/${issue.seq}-shipping-test`,
      })),
    shippingCommit: issues.shippingCommit.bind(issues),
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
      resolveIntegrationReceipt: options.resolveIntegrationReceipt ?? (() => null),
      persistAccepted: options.persistAccepted ?? (() => {}),
    },
    policy: new CompatibilityShippingPolicyResolver(() => 'main'),
    machineFor: () => asMachineId('machine-1'),
    resolveBranchTip: async () => 'head-sha',
    resolveRefTip: async () => 'base-sha',
    now: () => '2026-08-13T10:00:00.000Z',
    ...(options.beforeCompletionCommit
      ? { beforeCompletionCommit: options.beforeCompletionCommit }
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

describe('ShippingService enqueue transaction', () => {
  it('atomically freezes the order, moves review to shipping, and publishes compact rows', async () => {
    const { store, ledger, issues, service } = harness()
    const issue = issues.create({ repoPath: '/repo', title: 'approved', startNow: false })
    issues.update(issue.id, { stage: 'review' })
    const cursor = ledger.cursor()

    const receipt = await service.enqueue({ issueId: issue.id, ...approval })
    expect(receipt.created).toBe(true)
    expect(store.issues.getIssue(issue.id)?.stage).toBe('shipping')
    expect(store.shipping.getOrder(receipt.order.id)).toEqual(receipt.order)
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
    service.dispose()
  })

  it('rolls back issue custody and the order when the ledger append fails', async () => {
    const { store, issues, service } = harness()
    const issue = issues.create({ repoPath: '/repo', title: 'rollback', startNow: false })
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
    const issue = issues.create({ repoPath: '/repo', title: 'concurrent', startNow: false })
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

  it('requires a current integration receipt for descendants and persists the accepted evidence', async () => {
    const persistAccepted = vi.fn()
    let integratedDescendants: { issueId: IssueWire['id']; approvedHeadSha: string }[] = []
    const { issues, service } = harness(undefined, {
      persistAccepted,
      resolveIntegrationReceipt: (ref) => ({
        ref,
        rootHeadSha: 'head-sha',
        descendantManifest: integratedDescendants,
      }),
    })
    const root = issues.create({ repoPath: '/repo', title: 'root', startNow: false })
    const child = issues.create({
      repoPath: '/repo',
      title: 'child',
      startNow: false,
      parentId: root.id,
    })
    integratedDescendants = [{ issueId: child.id, approvedHeadSha: 'head-sha' }]
    issues.update(child.id, { stage: 'done' })
    issues.update(root.id, { stage: 'review' })

    await expect(service.enqueue({ issueId: root.id, ...approval })).rejects.toMatchObject({
      code: 'evidence',
    })
    const accepted = await service.enqueue({
      issueId: root.id,
      ...approval,
      approved: { ...approval.approved, evidenceManifestRef: 'evidence:root' },
    })
    expect(accepted.descendantManifest).toEqual([
      { issueId: child.id, approvedHeadSha: 'head-sha' },
    ])
    expect(persistAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        order: expect.objectContaining({ id: accepted.order.id }),
        evidenceManifestRef: 'evidence:root',
        integrationReceiptRef: 'evidence:root',
      }),
    )
    service.dispose()
  })

  it('raises and generation-fences the typed hold before clearing needsHuman', async () => {
    const { store, ledger, issues, service } = harness(async (input, machineId) => ({
      jobId: input.jobId,
      orderId: input.orderId,
      attemptId: input.attemptId,
      machineId,
      generation: input.generation,
      operation: input.operation,
      state: input.operation === 'compatibility-land' ? 'held' : 'succeeded',
      classification:
        input.operation === 'compatibility-land' ? 'unsupported-destination-effect' : 'observed',
      summary:
        input.operation === 'compatibility-land'
          ? 'executor stopped before mutation'
          : 'fences match',
      observedSourceSha: input.approvedHeadSha,
      observedTargetSha: input.expectedTargetSha,
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
      finishedAt: '2026-08-13T10:00:00.000Z',
    }))
    const issue = issues.create({ repoPath: '/repo', title: 'held', startNow: false })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    expect(store.shipping.getOrder(order.id)?.state).toBe('held')
    expect(store.issues.getIssue(issue.id)?.needsHuman).toBe(true)
    const hold = store.shipping.openHoldForOrder(order.id)
    expect(hold).toMatchObject({ generation: 1, actions: ['retry', 'return-to-issue'] })
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
    const projected = ledger.authority.snapshot('shipOrder') as { id: string; hold?: unknown }[]
    expect(projected.find((row) => row.id === order.id)).not.toHaveProperty('hold')
    await service.runOrder(order.id)
    expect(store.shipping.latestAttemptForOrder(order.id)?.leaseGeneration).toBe(2)
    expect(store.shipping.openHoldForOrder(order.id)?.generation).toBe(2)
    service.dispose()
  })

  it('authorizes admission and hold resolution and reauthorizes before landing', async () => {
    const authorize = vi.fn()
    const reauthorize = vi.fn(() => {
      throw new Error('grant revoked')
    })
    const { issues, service, store } = harness(
      async (input, machineId) => ({
        jobId: input.jobId,
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
    const issue = issues.create({ repoPath: '/repo', title: 'auth', startNow: false })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'enqueue' }))
    expect(reauthorize).toHaveBeenCalledWith(
      expect.objectContaining({ effect: 'compatibility-land' }),
    )
    expect(store.shipping.getOrder(order.id)?.state).toBe('held')
    expect(store.shipping.getOrder(order.id)?.holdCode).toBe('policy-refused')
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
      ...(input.operation === 'verify' ? { observedDestinationSha: input.expectedTargetSha } : {}),
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
    const issue = issues.create({ repoPath: '/repo', title: 'recover', startNow: false })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })

    await expect(service.runOrder(order.id)).rejects.toThrow(/simulated server crash/)
    expect(store.shipping.getOrder(order.id)?.state).toBe('verifying')
    expect(store.shipping.latestAttemptForOrder(order.id)?.finishedAt).toBeUndefined()
    expect(store.shipping.receiptForOrder(order.id)).toBeNull()
    expect(store.issues.getIssue(issue.id)?.stage).toBe('shipping')
    service.dispose()

    crash = false
    const restarted = new ShippingService({ ...deps, beforeCompletionCommit: () => {} })
    await restarted.reconcile()
    expect(store.shipping.getOrder(order.id)?.state).toBe('shipped')
    expect(store.shipping.latestAttemptForOrder(order.id)).toMatchObject({
      outcome: 'succeeded',
      validationResult: 'passed',
    })
    expect(store.shipping.receiptForOrder(order.id)).not.toBeNull()
    expect(store.issues.getIssue(issue.id)?.stage).toBe('done')
    restarted.dispose()
  })

  it('settles and fences daemon cancellation before releasing issue custody', async () => {
    const authorize = vi.fn()
    const { store, issues, service } = harness(
      async (input, machineId) => ({
        jobId: input.jobId,
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
    const issue = issues.create({ repoPath: '/repo', title: 'cancel', startNow: false })
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
})
