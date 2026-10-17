/**
 * The scheduler pass reads the same statements whatever the shipped history
 * [POD-6207, server-data rule 8]. Its covered-prefix recovery used to read
 * every order and, for each shipped one, its receipt, latest attempt and train
 * manifest, every two seconds; it now reads the open trains whose leader
 * shipped, which is normally none.
 */

import { createHash } from 'node:crypto'
import { asDeliveryReceiptId, asMachineId, asShipOrderId, firstAdminMemberId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { sessionReadPorts } from '../../test-support/session-facts'
import { expectConstantStatements } from '../../test-support/statement-count'
import { IssueService } from '../issues/service'
import { CompatibilityShippingPolicyResolver } from './policy'
import { ShippingService } from './service'

const PROFILE = {
  id: 'default',
  argv: ['bun', 'run', 'test'],
  cwd: 'integration-root' as const,
  timeoutMs: 60_000,
  resourceLocks: [] as string[],
}
const requestedBy = {
  actor: { kind: 'user' as const, id: firstAdminMemberId() },
  onBehalfOf: firstAdminMemberId(),
}

/** A store holding `shipped` delivered orders on one history issue (shipped
 * orders are terminal, so one issue can hold any number), and a service over
 * it whose scheduler timer never starts. */
async function world(shipped: number): Promise<{ store: SessionStore; service: ShippingService }> {
  const store = await openTestStore(':memory:')
  const ledger = new Ledger({
    repo: store.sync,
    now: Date.now,
    transact: async (fn) => await store.transact(fn),
  })
  const issues = await IssueService.create({
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: 'main',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'codex' },
      }),
    spawnSession: async () => ({ sessionId: 'session-1' as never, machine: 'machine-1' }),
    repoOp: async () => ({ ok: true, output: '' }),
    funnel: { run: (op) => op.write() },
    ledger,
  })
  const service = new ShippingService({
    repository: store.shipping,
    issues: {
      get: async (id) => (await issues.reports.get(id))!,
      children: async (id, recursive) => await issues.reports.children(id, recursive),
      shippingCommit: issues.crud.shippingCommit.bind(issues.crud),
      shippingCommitMany: issues.crud.shippingCommitMany.bind(issues.crud),
    },
    ledger,
    daemon: {
      shippingJob: async () => {
        throw new Error('not used')
      },
    },
    authorization: { attribution: () => requestedBy, authorize: () => {}, reauthorize: () => {} },
    evidence: {
      rootIntegrationReceipt: async () => null,
      acceptedReviewEvidence: async () => null,
    },
    policy: new CompatibilityShippingPolicyResolver(() => 'main'),
    machineFor: () => asMachineId('machine-1'),
    resolveBranchTip: async () => 'head-sha',
    resolveRefTip: async () => 'base-sha',
    isAncestor: async () => false,
    now: () => '2026-08-13T10:00:00.000Z',
    background: false,
  })
  const created = await issues.crud.create({
    repoPath: '/history',
    title: 'history',
    startNow: false,
    machineId: asMachineId('machine-1'),
  })
  const history = (await issues.reports.get(created.id))!
  for (let index = 0; index < shipped; index += 1) {
    const at = new Date(Date.UTC(2026, 7, 13, 0, index)).toISOString()
    const order = await store.shipping.createOrder({
      id: asShipOrderId(`shipped-${index}`),
      issueId: history.id,
      descendantManifest: [],
      repoId: history.repoId!,
      repoPath: '/history',
      machineId: asMachineId('machine-1'),
      targetBranch: 'main',
      destination: 'local:main',
      approvedBaseSha: 'base-sha',
      approvedHeadSha: `head-${index}`,
      deliveryDependsOn: [],
      requestedBy,
      requestedAt: at,
      policyId: 'compatibility-local:main',
      validationProfile: PROFILE,
      validationProfileDigest: createHash('sha256').update(JSON.stringify(PROFILE)).digest('hex'),
      closeMode: 'after-destination',
      state: 'queued',
      stateChangedAt: at,
    })
    const { attempt } = await store.shipping.claimAttempt({
      orderId: order.id,
      expectedState: 'queued',
      expectedAttemptId: null,
      expectedGeneration: 0,
      machineId: asMachineId('machine-1'),
      startedAt: at,
    })
    for (const [from, to] of [
      ['preflight', 'composing'],
      ['composing', 'validating'],
      ['validating', 'landing'],
      ['landing', 'verifying'],
    ] as const) {
      await store.shipping.transitionOrder(order.id, from, to, at)
    }
    await store.shipping.finishAttempt(attempt.id, attempt.leaseGeneration, {
      finishedAt: at,
      outcome: 'succeeded',
      testedIntegrationSha: `head-${index}`,
      landedRefSha: `head-${index}`,
      destinationSha: `head-${index}`,
      validationProfileId: 'default',
      validationResult: 'passed',
    })
    await store.shipping.completeVerifiedOrder({
      id: asDeliveryReceiptId(`receipt-${index}`),
      orderId: order.id,
      approvedBaseSha: order.approvedBaseSha,
      approvedHeadSha: order.approvedHeadSha,
      resultCommitSha: `head-${index}`,
      testedIntegrationSha: `head-${index}`,
      landedRefSha: `head-${index}`,
      destinationSha: `head-${index}`,
      validationProfileId: 'default',
      validationResult: 'passed',
      destination: order.destination,
      completedAt: at,
    })
  }
  return { store, service }
}

describe('scheduler pass: pinned statement count at 5 and 200 shipped orders (POD-6207)', () => {
  it('reads no shipped history to recover covered prefixes', async () => {
    await expectConstantStatements<{ store: SessionStore; service: ShippingService }>(
      {
        name: 'ShippingService.tick',
        setup: async (size) => await world(size),
        target: ({ store }) => store,
        run: async ({ service }) => await service.tick(),
        check: async (_result, { store }, size) => {
          const orders = await store.shipping.listOrders()
          expect(orders.filter((order) => order.state === 'shipped')).toHaveLength(size)
          expect(await store.shipping.shippedLeadersOfOpenTrains()).toEqual([])
        },
        teardown: async ({ store, service }) => {
          service.dispose()
          await store.close()
        },
      },
      // The recovery's one read of the open trains, and the schedule's two
      // reads of the active orders.
      3,
    )
  })
})
