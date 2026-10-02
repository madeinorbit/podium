/**
 * COMMIT COST AGAINST THE ORDERS OUTSIDE THE LANE (POD-4974 O2, "Done when").
 *
 * One shipping commit in a lane, with 10, 100 and 1,000 orders stored outside
 * it: cancelled history plus queued work in other lanes. The always-on case
 * counts the rows the commit reads back from the shipping store, which must not
 * move with the outside count. The timing case runs only under
 * PODIUM_SHIP_LANE_BENCH=1 (bench:flatblock) and prints a mean per commit; it
 * uses nothing O2 added, so the same file times the code before O2 as well.
 */

import { createHash } from 'node:crypto'
import { asMachineId, asShipOrderId, firstAdminMemberId, type ShipOrder } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { sessionReadPorts } from '../../test-support/session-facts'
import { IssueService } from '../issues/service'
import { CompatibilityShippingPolicyResolver } from './policy'
import { ShippingService } from './service'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

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

async function world(outside: number, laneSize: number) {
  const store = await openTestStore(':memory:')
  stores.push(store)
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
      get: async (id) => (await issues.get(id))!,
      children: async (id, recursive) => await issues.children(id, recursive),
      shippingCommit: issues.shippingCommit.bind(issues),
      shippingCommitMany: issues.shippingCommitMany.bind(issues),
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
  let minute = 0
  const order = async (
    issueId: ShipOrder['issueId'],
    repoId: ShipOrder['repoId'],
    repoPath: string,
    id: string,
  ) => {
    const at = new Date(Date.UTC(2026, 7, 13, 0, minute++)).toISOString()
    return await store.shipping.createOrder({
      id: asShipOrderId(id),
      issueId,
      descendantManifest: [],
      repoId,
      repoPath,
      machineId: asMachineId('machine-1'),
      targetBranch: 'main',
      destination: 'local:main',
      approvedBaseSha: 'base-sha',
      approvedHeadSha: `head-${id}`,
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
  }
  const issueIn = async (repoPath: string, title: string) => {
    const created = await issues.create({
      repoPath,
      title,
      startNow: false,
      machineId: asMachineId('machine-1'),
    })
    return (await issues.get(created.id))!
  }
  // Outside the lane: nine in ten are history on one issue (cancelled orders
  // are terminal, so one issue can hold any number), one in ten is queued work
  // in other repositories' lanes.
  const history = await issueIn('/history', 'history')
  for (let index = 0; index < outside; index += 1) {
    if (index % 10 === 9) {
      const other = await issueIn(`/other-${index}`, `other-${index}`)
      await order(other.id, other.repoId!, `/other-${index}`, `outside-${index}`)
    } else {
      const old = await order(history.id, history.repoId!, '/history', `outside-${index}`)
      await store.shipping.transitionOrder(
        old.id,
        'queued',
        'cancelled',
        '2026-08-13T09:00:00.000Z',
      )
    }
  }
  const lane: ShipOrder[] = []
  for (let index = 0; index < laneSize; index += 1) {
    const member = await issueIn('/lane', `lane-${index}`)
    lane.push(await order(member.id, member.repoId!, '/lane', `lane-${index}`))
  }
  // One warm-up commit in the lane: before O2 it published every row once, so
  // the measured commits diff against a full baseline in both arms.
  const warm = lane.pop()!
  await service['transition'](warm, 'preflight')
  return { store, service, lane }
}

/** Rows the shipping store hands back while `run` executes. */
async function rowsRead(store: SessionStore, run: () => Promise<unknown>): Promise<number> {
  const repository = store.shipping as unknown as Record<string, unknown>
  const originals = new Map<string, (...args: unknown[]) => unknown>()
  let rows = 0
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store.shipping))) {
    const method = repository[name]
    if (name === 'constructor' || typeof method !== 'function') continue
    originals.set(name, method as (...args: unknown[]) => unknown)
    repository[name] = async (...args: unknown[]) => {
      const result = await (method as (...a: unknown[]) => unknown).apply(store.shipping, args)
      rows += Array.isArray(result)
        ? result.length
        : result instanceof Map
          ? result.size
          : result
            ? 1
            : 0
      return result
    }
  }
  try {
    await run()
  } finally {
    for (const [name, method] of originals) repository[name] = method
  }
  return rows
}

describe('POD-4974 O2 commit cost against orders outside the lane', () => {
  it('reads the same rows per commit at 10, 100 and 1,000 orders outside the lane', async () => {
    const counts: number[] = []
    for (const outside of [10, 100, 1_000]) {
      const { store, service, lane } = await world(outside, 4)
      counts.push(
        await rowsRead(store, async () => await service['transition'](lane[0]!, 'preflight')),
      )
      service.dispose()
    }
    expect(counts[0]).toBeGreaterThan(0)
    expect(counts).toEqual([counts[0], counts[0], counts[0]])
  }, 120_000)

  it.runIf(process.env.PODIUM_SHIP_LANE_BENCH === '1')(
    'times one lane commit at 10, 100 and 1,000 orders outside the lane',
    async () => {
      const commits = 20
      const report: Record<number, { meanMs: number; rowsRead: number }> = {}
      for (const outside of [10, 100, 1_000]) {
        const { store, service, lane } = await world(outside, commits + 1)
        let rows = 0
        const started = performance.now()
        for (const member of lane.slice(0, commits)) {
          rows += await rowsRead(
            store,
            async () => await service['transition'](member, 'preflight'),
          )
        }
        report[outside] = {
          meanMs: Number(((performance.now() - started) / commits).toFixed(3)),
          rowsRead: rows / commits,
        }
        service.dispose()
      }
      console.log(`SHIP_LANE_BENCH ${JSON.stringify(report)}`)
    },
    600_000,
  )
})
