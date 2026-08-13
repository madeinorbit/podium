import { asMachineId, FIRST_ADMIN_USER_ID, type IssueWire } from '@podium/model'
import type { ShippingJobResult } from '@podium/protocol'
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
    reauthorize?: ConstructorParameters<typeof ShippingService>[0]['authorization']['reauthorize']
    beforeCompletionCommit?: () => void
    rootIntegrationReceipt?: ConstructorParameters<
      typeof ShippingService
    >[0]['evidence']['rootIntegrationReceipt']
    useStoredReceipts?: boolean
    resolveBranchTip?: ConstructorParameters<typeof ShippingService>[0]['resolveBranchTip']
    resolveRefTip?: ConstructorParameters<typeof ShippingService>[0]['resolveRefTip']
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
    },
    policy: new CompatibilityShippingPolicyResolver(() => 'main'),
    machineFor: () => asMachineId('machine-1'),
    resolveBranchTip: options.resolveBranchTip ?? (async () => 'head-sha'),
    resolveRefTip: options.resolveRefTip ?? (async () => 'base-sha'),
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
    const issue = issues.create({ repoPath: '/repo', title: 'frozen replay', startNow: false })
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
        approved: { ...approval.approved, evidenceManifestRef: 'evidence:changed' },
      }),
    ).rejects.toMatchObject({ code: 'source-stale' })
    service.dispose()
  })

  it('refuses active-order replay when the live root head moved', async () => {
    let liveHead = 'head-sha'
    const { issues, service } = harness(undefined, {
      resolveBranchTip: async () => liveHead,
    })
    const issue = issues.create({ repoPath: '/repo', title: 'live replay fence', startNow: false })
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
    const issue = issues.create({ repoPath: '/repo', title: 'admission ref race', startNow: false })
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

  it('rejects a nested issue with the highest root and exact safe retry command', async () => {
    const { issues, service } = harness()
    const root = issues.create({ repoPath: '/repo', title: 'root', startNow: false })
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
    const { store, issues, service } = harness(undefined, { useStoredReceipts: true })
    const root = issues.create({ repoPath: '/repo', title: 'root', startNow: false })
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
    const { store, issues, service } = harness(undefined, { useStoredReceipts: true })
    const root = issues.create({ repoPath: '/repo', title: 'root refusal', startNow: false })
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
        approved: { ...approval.approved, evidenceManifestRef: 'evidence:root' },
      }),
    ).rejects.toMatchObject({ code: 'evidence' })
    expect(store.shipping.activeOrderForIssue(root.id)).toBeNull()
    expect(store.issues.getIssue(root.id)?.stage).toBe('review')
    service.dispose()
  })

  it('admits a top-level leaf without fabricating a descendant integration receipt', async () => {
    const { store, issues, service } = harness(undefined, { rootIntegrationReceipt: () => null })
    const issue = issues.create({ repoPath: '/repo', title: 'top-level leaf', startNow: false })
    issues.update(issue.id, { stage: 'review' })

    const accepted = await service.enqueue({ issueId: issue.id, ...approval })
    expect(accepted.descendantManifest).toEqual([])
    expect(accepted.order.currentIntegrationReceipt).toBeUndefined()
    expect(store.shipping.activeOrderForIssue(issue.id)?.id).toBe(accepted.order.id)
    expect(store.issues.getIssue(issue.id)?.stage).toBe('shipping')
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
    const reauthorize = vi.fn((input: { effect: string }) => {
      if (input.effect === 'compatibility-land') throw new Error('grant revoked')
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
      expect.objectContaining({ effect: 'compatibility-land', machineId: 'machine-1' }),
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

  it('supersedes an unfinished attempt with one durable generation on restart', async () => {
    const generations: number[] = []
    const { store, issues, service, deps } = harness(async (input, machineId) => {
      generations.push(input.generation)
      return {
        jobId: input.jobId,
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
    const issue = issues.create({ repoPath: '/repo', title: 'supersede', startNow: false })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const first = store.shipping.latestAttemptForOrder(order.id)
    expect(first).toMatchObject({ leaseGeneration: 1, outcome: undefined })
    service.dispose()

    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect(generations).toEqual([1, 2])
    expect(store.shipping.getAttempt(first!.id)).toMatchObject({ outcome: 'failed' })
    expect(store.shipping.latestAttemptForOrder(order.id)).toMatchObject({ leaseGeneration: 2 })
    restarted.dispose()
  })

  it('rejects a stale attempt claimant and requires exact terminal timestamps', async () => {
    const { store, issues, service } = harness(async (input, machineId) => ({
      jobId: input.jobId,
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
    const issue = issues.create({ repoPath: '/repo', title: 'claim cas', startNow: false })
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
    let crashCancel = true
    const generations: number[] = []
    const { store, issues, service, deps } = harness(async (input, machineId) => {
      generations.push(input.generation)
      if (input.action === 'cancel' && crashCancel) {
        throw new Error('simulated server crash after cancellation intent')
      }
      return {
        jobId: input.jobId,
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
    const issue = issues.create({ repoPath: '/repo', title: 'cancel recovery', startNow: false })
    issues.update(issue.id, { stage: 'review' })
    const { order } = await service.enqueue({ issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const first = store.shipping.latestAttemptForOrder(order.id)!

    await expect(
      service.cancel({
        orderId: order.id,
        principal: approval.principal,
        requestedBy: approval.requestedBy,
        overrideScope: false,
      }),
    ).rejects.toThrow(/simulated server crash/)
    expect(
      store.shipping.latestStepForEffect(first.id, `cancel:${first.leaseGeneration}`),
    ).toMatchObject({ state: 'running' })
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

    crashCancel = false
    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect(store.shipping.getOrder(order.id)?.state).toBe('cancelled')
    expect(store.shipping.latestAttemptForOrder(order.id)).toMatchObject({
      id: first.id,
      leaseGeneration: 1,
      outcome: 'cancelled',
    })
    expect(generations).toEqual([1, 1, 1])
    restarted.dispose()
  })

  it('terminalizes cancellation intent atomically when live authorization is refused', async () => {
    const { store, issues, service } = harness(
      async (input, machineId) => ({
        jobId: input.jobId,
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
    const issue = issues.create({ repoPath: '/repo', title: 'cancel refusal', startNow: false })
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
    expect(store.shipping.getAttempt(attempt.id)).toMatchObject({ outcome: 'failed' })
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
    const issue = issues.create({ repoPath: '/repo', title: 'cancel rpc refusal', startNow: false })
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
    expect(held).toMatchObject({ state: 'held', holdCode: 'machine-unavailable' })
    expect(store.shipping.getAttempt(attempt.id)).toMatchObject({ outcome: 'failed' })
    expect(
      store.shipping.latestStepForEffect(attempt.id, `cancel:${attempt.leaseGeneration}`),
    ).toMatchObject({ state: 'failed', outcome: 'cancel-error', summary: 'daemon disconnected' })
    expect(store.shipping.hasCancellationIntent(attempt.id, attempt.leaseGeneration)).toBe(false)
    service.dispose()
  })

  it('persists cancellation intent before awaiting and refuses the late effect result', async () => {
    let resolveStart!: (result: ShippingJobResult) => void
    let sawStart!: () => void
    const started = new Promise<void>((resolve) => {
      sawStart = resolve
    })
    const { store, issues, service } = harness(async (input, machineId) => {
      const base = {
        jobId: input.jobId,
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
      sawStart()
      return new Promise((resolve) => {
        resolveStart = resolve
      })
    })
    const issue = issues.create({ repoPath: '/repo', title: 'late result', startNow: false })
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
})
