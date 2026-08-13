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
      return issue
    },
    children: (id: string, recursive?: boolean) => issues.children(id, recursive),
    shippingCommit: issues.shippingCommit.bind(issues),
  }
  const service = new ShippingService({
    repository: store.shipping,
    issues: issuePort,
    ledger,
    daemon: { shippingJob },
    policy: new CompatibilityShippingPolicyResolver(() => 'main'),
    machineFor: () => asMachineId('machine-1'),
    resolveBranchTip: async () => 'head-sha',
    resolveRefTip: async () => 'base-sha',
    now: () => '2026-08-13T10:00:00.000Z',
    background: false,
  })
  return { store, ledger, issues, service }
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

  it('raises and generation-fences the typed hold before clearing needsHuman', async () => {
    const { store, issues, service } = harness(async (input, machineId) => ({
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
    service.dispose()
  })
})
