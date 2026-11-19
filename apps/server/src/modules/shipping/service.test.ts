import { createHash } from 'node:crypto'
import {
  asMachineId,
  asShipOrderId,
  asShipStepId,
  firstAdminMemberId,
  type IssueReport,
  type ShipLaneProjection,
  type ShipOrder,
  type ShipOrderProjection,
  shipRepairRef,
} from '@podium/model'
import { type ShippingJobResult, shippingEvidenceFingerprint } from '@podium/protocol/daemon'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { fixtureWriteScope, testLedgerWriter } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { logStoreRecords } from '../../test-support/record-writer'
import { seedRows } from '../../test-support/seed-rows'
import { sessionReadPorts } from '../../test-support/session-facts'
import {
  countStatements,
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { storeSql } from '../../test-support/store-sql'
import { IssueService } from '../issues/service'
import type { ShippingPolicyResolver } from './policy'
import { CompatibilityShippingPolicyResolver } from './policy'
import { shipLaneIdOf, shippingSchedule } from './queue'
import type { ShippingRepairContext, ShippingRepairPort } from './repair-contract'
import {
  type AcceptedReviewEvidence,
  canonicalShippingDestination,
  type ResourceLease,
  type ShippingIssuePort,
  ShippingOrderAccessError,
  ShippingService,
  type ShippingWriter,
  shippingResourceHolderId,
} from './service'
import { ShippingEvidenceRegistry } from './shipwright'

const stores: SessionStore[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) await store.close()
})

async function harness(
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
    audit?: ConstructorParameters<typeof ShippingService>[0]['audit']
    now?: ConstructorParameters<typeof ShippingService>[0]['now']
    /** POD-4974 O2: after every top-level shipping commit, the published order
     * plane must equal a full recompute. Off only for tests that seed orders
     * straight into the store, which no commit has published yet. */
    checkOrderPlane?: boolean
  } = {},
) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    records: await logStoreRecords(store),
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
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'codex' },
      }),
    spawnSession: async () => ({
      sessionId: 'session-1' as never,
      machine: 'machine-1',
    }),
    repoOp: async () => ({ ok: true, output: '' }),
    funnel: { run: (op) => op.write() },
    ledger: testLedgerWriter(ledger),
  })
  const createIssue = issues.crud.create.bind(issues.crud)
  issues.crud.create = (async (writer, input) =>
    await createIssue(writer, {
      ...input,
      machineId: input.machineId ?? asMachineId('machine-1'),
    })) as typeof issues.crud.create
  // THE ORDER-PLANE CROSS-CHECK (POD-4974 O2). A commit now recomputes only the
  // lanes of the orders it names, so a commit that forgets one leaves a stale
  // row that nothing else would ever fix. Every scenario in this file therefore
  // compares, after each top-level commit, what the ledger holds against the
  // full truth the boot path computes.
  let commitDepth = 0
  let orderPlaneService: ShippingService | undefined
  const assertOrderPlaneCurrent = async (): Promise<void> => {
    if (options.checkOrderPlane === false || !orderPlaneService) return
    const truth = await orderPlaneService['fullProjection']()
    const byId = (rows: readonly unknown[]) =>
      new Map(rows.map((row) => [(row as { id: string }).id, row]))
    expect(byId(await ledger.authority.snapshot('shipOrder'))).toEqual(
      byId(truth.orders.map((row) => row.value)),
    )
    expect(byId(await ledger.authority.snapshot('shipLane'))).toEqual(
      byId(truth.lanes.map((row) => row.value)),
    )
  }
  const checked =
    <A extends unknown[], R>(commit: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      commitDepth += 1
      let result: R
      try {
        result = await commit(...args)
      } finally {
        commitDepth -= 1
      }
      if (commitDepth === 0) await assertOrderPlaneCurrent()
      return result
    }
  const issuePort = {
    async get(id: string): Promise<IssueReport> {
      const issue = await issues.reports.get(id)
      if (!issue) throw new Error(`unknown issue ${id}`)
      return {
        ...issue,
        branch: issue.branch ?? `issue/${issue.seq}-shipping-test`,
      }
    },
    children: async (id: string, recursive?: boolean) =>
      (await issues.reports.children(id, recursive)).map((issue) => ({
        ...issue,
        branch: issue.branch ?? `issue/${issue.seq}-shipping-test`,
      })),
    // The issue writes a ship order makes, under the issue service's own writer.
    shippingCommit: checked(((writer, id, mutation, write) =>
      issues.crud.shippingCommit(
        writer,
        id,
        mutation,
        write,
      )) as ShippingIssuePort['shippingCommit']),
    shippingCommitMany: checked(((writer, entries, write) =>
      issues.crud.shippingCommitMany(
        writer,
        entries,
        write,
      )) as ShippingIssuePort['shippingCommitMany']),
    ...(options.takeBranchCustody ? { takeBranchCustody: options.takeBranchCustody } : {}),
  }
  const deps: ConstructorParameters<typeof ShippingService>[0] = {
    workspaceId: store.workspaceId,
    repository: store.shipping,
    issues: issuePort,
    ledger: {
      commit: checked(async (op) => await testLedgerWriter(ledger).commit(op)) as ReturnType<
        typeof testLedgerWriter
      >['commit'],
    },
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
          : async (rootIssueId, approvedHeadSha) => ({
              rootIssueId,
              approvedHeadSha,
              descendants: (await issuePort.children(rootIssueId, true)).map((child) => ({
                issueId: child.id,
                approvedHeadSha: 'head-sha',
              })),
            })),
      acceptedReviewEvidence: options.acceptedReviewEvidence ?? (async () => null),
    },
    policy: options.policy ?? new CompatibilityShippingPolicyResolver(() => 'main'),
    ...(options.resourceAdmission ? { resourceAdmission: options.resourceAdmission } : {}),
    machineFor: () => asMachineId('machine-1'),
    machineCapabilities: () => ['shipping.train.v2'],
    resolveBranchTip: options.resolveBranchTip ?? (async () => 'head-sha'),
    resolveRefTip: options.resolveRefTip ?? (async () => 'base-sha'),
    isAncestor: options.isAncestor ?? (async () => false),
    now: options.now ?? (() => '2026-08-13T10:00:00.000Z'),
    ...(options.beforeCompletionCommit
      ? { beforeCompletionCommit: options.beforeCompletionCommit }
      : {}),
    ...(options.repair ? { repair: options.repair } : {}),
    ...(options.beforeRepairAcknowledge
      ? { beforeRepairAcknowledge: options.beforeRepairAcknowledge }
      : {}),
    ...(options.audit ? { audit: options.audit } : {}),
    background: false,
  }
  const service = new ShippingService(deps)
  orderPlaneService = service
  return { store, ledger, issues, service, deps }
}

const approval = {
  principal: { kind: 'system' as const, job: 'shipping-test' },
  requestedBy: {
    actor: { kind: 'user' as const, id: firstAdminMemberId() },
    onBehalfOf: firstAdminMemberId(),
  },
  overrideScope: false,
  approved: {
    sourceBaseSha: 'base-sha',
    sourceHeadSha: 'head-sha',
    policyId: 'compatibility-local:main',
    previewLeaseIds: [],
  },
}

type ShippingJob = NonNullable<
  ConstructorParameters<typeof ShippingService>[0]['daemon']
>['shippingJob']

const provedShippingJob = async (
  input: Parameters<ShippingJob>[0],
  machineId: Parameters<ShippingJob>[1],
  final: Partial<Pick<ShippingJobResult, 'state' | 'classification' | 'artifactRefs'>> = {},
): Promise<ShippingJobResult> => ({
  jobId: input.jobId,
  requestDigest: input.requestDigest,
  orderId: input.orderId,
  attemptId: input.attemptId,
  machineId,
  generation: input.generation,
  operation: input.operation,
  state: final.state ?? 'succeeded',
  classification: final.classification ?? 'proved',
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
  artifactRefs: final.artifactRefs ?? [],
  heartbeatedAt: '2026-08-13T10:00:00.000Z',
  finishedAt: '2026-08-13T10:00:00.000Z',
})

/** The service's own lane writer: these tests drive the ship commands outside a
 *  sync command, so they write as the lanes do (ADR 12 D9). */
/**
 * Fake timers for a test whose store has connected: postgres.js connects through
 * `setTimeout(connect, 0)` and flushes its writes on `setImmediate`, so the store opens
 * under real timers and `setImmediate` stays real (docs/agents/testing.md, Postgres lane).
 */
function useFakeTimersAfterConnect(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
}

const laneWriter = (service: ShippingService): ShippingWriter =>
  (service as unknown as { deps: { ledger: ShippingWriter } }).deps.ledger

// Real terminal history, without replaying hundreds of external effects in
// setup. The cloned immutable rows intentionally carry no outstanding debt.
async function cloneShippingHistory(
  store: SessionStore,
  orderId: string,
  copies: number,
  overrides: (table: string, copy: number) => Record<string, string> = () => ({}),
): Promise<void> {
  const raw = storeSql(store)
  const tables = ['ship_orders', 'ship_attempts', 'ship_steps', 'delivery_receipts'] as const
  const sources: { table: (typeof tables)[number]; rows: Record<string, unknown>[] }[] = []
  for (const table of tables) {
    const key = sql.identifier(table === 'ship_orders' ? 'id' : 'order_id')
    sources.push({
      table,
      rows: await raw.all<Record<string, unknown>>(
        sql`SELECT * FROM ${sql.identifier(table)} WHERE ${key} = ${orderId}`,
      ),
    })
  }
  const seed = async (): Promise<void> => {
    for (let i = 0; i < copies; i++) {
      const suffix = `:history:${i}`
      for (const { table, rows } of sources) {
        for (const row of rows) {
          const columns = Object.keys(row)
          const patch = overrides(table, i)
          const values = columns.map(
            (column) =>
              patch[column] ??
              (column === 'id' || column === 'order_id' || column === 'attempt_id'
                ? `${row[column]}${suffix}`
                : (row[column] ?? null)),
          )
          await raw.run(
            sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
              columns.map((column) => sql.identifier(column)),
              sql`, `,
            )}) VALUES (${sql.join(
              values.map((value) => sql`${value}`),
              sql`, `,
            )})`,
          )
        }
      }
    }
    // A raw fixture seed reaches the tables, not the log (POD-6920).
    await raw.run(sql`DELETE FROM sync_capture`)
  }
  // StoreSql.transaction is the test store's own port, joining its workspace transaction.
  await raw.transaction(seed) // DECISION POD-7103
}

/** A trigger that refuses every `podium_events` insert with 'event refused', on either engine. */
async function refuseEventInserts(store: SessionStore): Promise<void> {
  const raw = storeSql(store)
  if (raw.engine === 'sqlite') {
    await raw.run(sql`CREATE TRIGGER refuse_shipping_event BEFORE INSERT ON podium_events
      BEGIN SELECT RAISE(ABORT, 'event refused'); END`)
    return
  }
  await raw.run(sql`CREATE FUNCTION refuse_shipping_event() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'event refused'; END $$`)
  await raw.run(sql`CREATE TRIGGER refuse_shipping_event BEFORE INSERT ON podium_events
    FOR EACH ROW EXECUTE FUNCTION refuse_shipping_event()`)
}

async function recoveryFixture(shippingJob: ShippingJob = provedShippingJob) {
  const fixture = await harness(shippingJob, { checkOrderPlane: false })
  const issue = await fixture.issues.crud.create(fixture.issues.reports.store.serverWriter, {
    repoPath: '/repo',
    title: 'recovery debt',
    startNow: false,
  })
  await fixture.issues.crud.update(fixture.issues.reports.store.serverWriter, issue.id, {
    stage: 'review',
  })
  const { order } = await fixture.service.enqueue(laneWriter(fixture.service), {
    issueId: issue.id,
    ...approval,
  })
  return { ...fixture, order }
}

describe('ShippingService durable recovery debt', () => {
  it('commits every event of a multi-event issue write in the same transaction', async () => {
    const { store, issues, service } = await harness()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'multi-event shipping write',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const events = () =>
      store.events.listEventsSince(0, {
        subject: issue.id,
        kinds: ['issue.shipping_enqueued', 'issue.needs_human'],
      })
    await store.transact(async () => {
      const committed = await issues.crud.shippingCommitMany(
        issues.reports.store.serverWriter,
        [
          {
            id: issue.id,
            mutation: {
              expectedStage: 'review',
              nextStage: 'shipping',
              needsHuman: true,
              event: { kind: 'issue.shipping_enqueued', payload: { orderId: 'multi-event-order' } },
            },
          },
        ],
        () => 42,
      )
      expect(committed.result).toBe(42)
      expect((await events()).map((event) => event.kind)).toEqual([
        'issue.shipping_enqueued',
        'issue.needs_human',
      ])
      expect((await store.issues.getIssue(issue.id))?.stage).toBe('shipping')
    })
    expect(await events()).toHaveLength(2)
    service.dispose()
  })

  it('refuses receipt settlement when an admission overtakes its descendant plan', async () => {
    const { store, issues, service, deps } = await harness(provedShippingJob, {
      resolveBranchTip: async (issue) =>
        issue.title === 'racing predecessor' ? 'lower-head' : 'upper-head',
      isAncestor: async (_issue, ancestor, descendant) =>
        ancestor === 'lower-head' && descendant === 'upper-head',
    })
    const lowerIssue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'racing predecessor',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, lowerIssue.id, { stage: 'review' })
    const lower = await service.enqueue(laneWriter(service), {
      issueId: lowerIssue.id,
      ...approval,
      approved: { ...approval.approved, sourceHeadSha: 'lower-head' },
    })
    let upperId: ShipOrder['id'] | undefined
    const active = store.shipping.activeOrders.bind(store.shipping)
    const spy = vi.spyOn(store.shipping, 'activeOrders').mockImplementationOnce(async () => {
      const snapshot = await active()
      const upperIssue = await issues.crud.create(issues.reports.store.serverWriter, {
        repoPath: '/repo',
        title: 'racing descendant',
        startNow: false,
      })
      await issues.crud.update(issues.reports.store.serverWriter, upperIssue.id, {
        stage: 'review',
      })
      upperId = (
        await service.enqueue(laneWriter(service), {
          issueId: upperIssue.id,
          ...approval,
          approved: { ...approval.approved, sourceHeadSha: 'upper-head' },
        })
      ).order.id
      return snapshot
    })
    await service.runOrder(lower.order.id)
    spy.mockRestore()
    expect(upperId).toBeDefined()
    expect((await store.shipping.getOrder(lower.order.id))?.state).toBe('verifying')
    expect(await store.shipping.receiptForOrder(lower.order.id)).toBeNull()
    expect((await store.shipping.getOrder(upperId!))?.state).toBe('queued')
    service.dispose()
    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect((await store.shipping.getOrder(lower.order.id))?.state).toBe('shipped')
    expect((await store.shipping.getOrder(upperId!))?.holdCode).toBe('approval-stale')
    expect(await store.shipping.recoveryWork('descendants')).toEqual([])
    restarted.dispose()
  })

  it('rolls back an admission whose predecessor snapshot moved before its commit', async () => {
    const { store, issues, service, deps } = await harness()
    const first = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'first admission',
      startNow: false,
    })
    const second = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'overtaking admission',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, first.id, { stage: 'review' })
    await issues.crud.update(issues.reports.store.serverWriter, second.id, { stage: 'review' })
    const other = new ShippingService(deps)
    const read = store.shipping.shippedPredecessors.bind(store.shipping)
    const spy = vi
      .spyOn(store.shipping, 'shippedPredecessors')
      .mockImplementationOnce(async (...args) => {
        const snapshot = await read(...args)
        await other.enqueue(laneWriter(other), { issueId: second.id, ...approval })
        return snapshot
      })
    await expect(
      service.enqueue(laneWriter(service), { issueId: first.id, ...approval }),
    ).rejects.toThrow(/shipping changed while predecessor ancestry was checked/)
    expect(await store.shipping.activeOrderForIssue(first.id)).toBeNull()
    expect((await store.issues.getIssue(first.id))?.stage).toBe('review')
    expect(await store.shipping.activeOrderForIssue(second.id)).not.toBeNull()
    spy.mockRestore()
    service.dispose()
    other.dispose()
  })

  it('retains a shipped acknowledgement through repeated failures and clears it only on success', async () => {
    let fail = true
    const requests: Parameters<ShippingJob>[0][] = []
    const fixture = await recoveryFixture(async (input, machineId) => {
      if (input.action === 'acknowledge' && input.operation === 'verify') {
        requests.push(input)
        if (fail) throw new Error('acknowledgement offline')
      }
      return await provedShippingJob(input, machineId)
    })
    const { store, service, deps, order } = fixture
    await service.runOrder(order.id)
    expect((await store.shipping.getOrder(order.id))?.state).toBe('shipped')
    expect(await store.shipping.recoveryWork('daemon-ack')).toHaveLength(1)
    expect(await store.shipping.recoveryWork('descendants')).toEqual([])
    service.dispose()
    const restarted = new ShippingService(deps)
    const history = vi
      .spyOn(store.shipping, 'listOrders')
      .mockRejectedValue(new Error('history read'))
    const attempts = vi
      .spyOn(store.shipping, 'attemptsForOrder')
      .mockRejectedValue(new Error('attempt history read'))
    const steps = vi
      .spyOn(store.shipping, 'stepsForAttempt')
      .mockRejectedValue(new Error('step history read'))
    await restarted.reconcile()
    expect(await store.shipping.recoveryWork('daemon-ack')).toHaveLength(1)
    expect(requests).toHaveLength(2)
    fail = false
    // The stored request survives live issue/policy changes after shipping.
    deps.policy = {
      resolve: async () => {
        throw new Error('live policy unavailable')
      },
    }
    await restarted.reconcile()
    expect(requests).toHaveLength(3)
    expect(requests[2]).toEqual(requests[0])
    expect(await store.shipping.recoveryWork('daemon-ack')).toEqual([])
    await restarted.reconcile()
    expect(requests).toHaveLength(3)
    expect(history).not.toHaveBeenCalled()
    expect(attempts).not.toHaveBeenCalled()
    expect(steps).not.toHaveBeenCalled()
    restarted.dispose()
  })

  it('replays held acknowledgements and retains daemon refusals', async () => {
    let refuse = true
    const fixture = await recoveryFixture(async (input, machineId) => {
      if (input.action === 'acknowledge' && refuse) {
        return await provedShippingJob(input, machineId, {
          state: 'held',
          classification: 'invalid-request',
        })
      }
      return await provedShippingJob(input, machineId, {
        state: 'held',
        classification: 'validation-failed',
      })
    })
    const { store, service, deps, order } = fixture
    await service.runOrder(order.id)
    expect((await store.shipping.getOrder(order.id))?.state).toBe('held')
    expect(await store.shipping.recoveryWork('daemon-ack')).toHaveLength(1)
    service.dispose()
    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect(await store.shipping.recoveryWork('daemon-ack')).toHaveLength(1)
    refuse = false
    await restarted.reconcile()
    expect(await store.shipping.recoveryWork('daemon-ack')).toEqual([])
    restarted.dispose()
  })

  const historyPin: StatementPin<Awaited<ReturnType<typeof recoveryFixture>>> = {
    name: 'shipping restart with acknowledged terminal history',
    sizes: [5, 200],
    setup: async (size) => {
      const fixture = await recoveryFixture()
      await fixture.service.runOrder(fixture.order.id)
      await cloneShippingHistory(fixture.store, fixture.order.id, size - 1)
      return fixture
    },
    target: ({ store }) => store,
    run: ({ service }) => service.reconcile(),
    check: async (_result, { store, order }, size) => {
      expect(await store.shipping.listOrders()).toHaveLength(size)
      expect((await store.shipping.getOrder(order.id))?.state).toBe('shipped')
      expect(await store.shipping.recoveryWork('daemon-ack')).toEqual([])
      expect(await store.shipping.recoveryWork('descendants')).toEqual([])
    },
    teardown: ({ service }) => service.dispose(),
  }

  it('runs six indexed restart statements at five and two hundred shipped orders', async () => {
    await expectConstantStatements(historyPin, 6)
  })

  it('arms the history pin against a planted historical recovery loop', async () => {
    await expectArmed(historyPin, 6, ({ store }) => {
      const real = store.shipping.resumableOrders.bind(store.shipping)
      const spy = vi.spyOn(store.shipping, 'resumableOrders').mockImplementation(async () => {
        for (const order of await store.shipping.listOrders())
          await store.shipping.receiptForOrder(order.id)
        return await real()
      })
      return () => spy.mockRestore()
    })
  })

  it('pages past failed daemon debt without retrying it within the same pass', async () => {
    let fail = true
    let replayed = 0
    const { store, service, deps, order } = await recoveryFixture(async (input, machineId) => {
      if (input.action === 'acknowledge' && input.operation === 'verify') {
        replayed++
        if (fail) throw new Error('offline')
      }
      return await provedShippingJob(input, machineId)
    })
    await service.runOrder(order.id)
    for (let i = 0; i < 205; i++) {
      await storeSql(store).run(
        sql`INSERT INTO ship_recovery_work (key, kind, order_id, payload, workspace_id) SELECT ${`page-test:${String(i).padStart(3, '0')}`}, kind, order_id, payload, workspace_id FROM ship_recovery_work WHERE kind = 'daemon-ack' LIMIT 1`,
      )
    }
    service.dispose()
    const restarted = new ShippingService(deps)
    replayed = 0
    await restarted.reconcile()
    expect(replayed).toBe(206)
    fail = false
    replayed = 0
    await restarted.reconcile()
    expect(replayed).toBe(206)
    expect(await store.shipping.recoveryWork('daemon-ack')).toEqual([])
    restarted.dispose()
  })

  it.each([
    'admission',
    'held retry',
  ] as const)('bounds %s daemon calls at five and two hundred shipped orders', async (operation) => {
    const totals: number[] = []
    const pages: number[] = []
    const calls: number[] = []
    for (const size of [5, 200]) {
      const { store, issues, service, deps } = await historyPin.setup(size)
      const isAncestor = vi.fn<typeof deps.isAncestor>(async () => true)
      deps.isAncestor = isAncestor
      const predecessors = vi.spyOn(store.shipping, 'shippedPredecessors')
      try {
        const issue = await issues.crud.create(issues.reports.store.serverWriter, {
          repoPath: '/repo',
          title: `${operation} at ${size}`,
          startNow: false,
        })
        await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
        const admit = () => service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
        let run: () => Promise<unknown> = admit
        if (operation === 'held retry') {
          const { order } = await admit()
          deps.daemon!.shippingJob = (input, machineId) =>
            provedShippingJob(input, machineId, {
              state: 'held',
              classification: 'validation-failed',
            })
          await service.runOrder(order.id)
          const hold = await store.shipping.openHoldForOrder(order.id)
          expect(hold).not.toBeNull()
          run = () =>
            service.resolveHold(laneWriter(service), {
              orderId: order.id,
              action: 'retry',
              expectedGeneration: hold!.generation,
              principal: approval.principal,
            })
        }
        predecessors.mockClear()
        isAncestor.mockClear()
        const count = await countStatements(store, run)
        expect((await store.shipping.activeOrderForIssue(issue.id))?.state).toBe('queued')
        totals.push(count.statements)
        pages.push(predecessors.mock.calls.length)
        calls.push(isAncestor.mock.calls.length)
      } finally {
        predecessors.mockRestore()
        service.dispose()
      }
    }
    expect(calls).toEqual([1, 1])
    expect(pages).toEqual([2, 2])
    expect(totals[1]).toBe(totals[0])
    console.info('Shipping admission cost', { operation, sizes: [5, 200], totals, pages, calls })
  })

  it('walks receipts by completion newest first and stops each destination independently', async () => {
    const { store, service, deps, order } = await historyPin.setup(1)
    // IDs and request times do not encode landing order. The newest unrelated
    // receipt must not hide an older stale source on a different destination.
    const rows = [
      { destination: 'main', sha: 'old-contained', head: 'old-source', at: '01' },
      {
        destination: 'local:main',
        sha: 'contained',
        head: 'contained-source',
        at: '02',
      },
      {
        destination: 'refs/heads/main',
        sha: 'new-unrelated',
        head: 'unrelated-source',
        at: '04',
      },
      {
        destination: 'git:origin/release',
        sha: 'release-stale',
        head: 'release-source',
        at: '03',
      },
      {
        destination: 'remote:origin/release',
        sha: 'release-unrelated',
        head: 'release-unrelated-source',
        at: '05',
      },
    ]
    await cloneShippingHistory(
      store,
      order.id,
      rows.length,
      (table, index): Record<string, string> => {
        const row = rows[index]!
        const at = `2026-08-13T10:00:${row.at}.000Z`
        return table === 'ship_orders'
          ? {
              destination: row.destination,
              approved_head_sha: row.head,
              state_changed_at: at,
              current_integration_receipt: JSON.stringify({
                ...order.currentIntegrationReceipt,
                approvedHeadSha: row.head,
              }),
            }
          : table === 'delivery_receipts'
            ? { destination: row.destination, destination_sha: row.sha, completed_at: at }
            : {}
      },
    )
    const isAncestor = vi.fn<typeof deps.isAncestor>(
      async (_issue, ancestor, descendant) =>
        (ancestor === 'contained' && descendant === 'approved-base') ||
        (ancestor === 'release-source' && descendant === 'approved-head'),
    )
    deps.isAncestor = isAncestor
    try {
      const stale = await service['staleAdmissionPredecessor'](
        {
          ...order,
          approvedBaseSha: 'approved-base',
          approvedHeadSha: 'approved-head',
        },
        await deps.issues.get(order.issueId),
      )
      expect(stale?.order.id).toBe(`${order.id}:history:3`)
      expect(isAncestor.mock.calls.map(([, ancestor]) => ancestor)).toEqual([
        'release-unrelated',
        'release-unrelated-source',
        'new-unrelated',
        'unrelated-source',
        'release-stale',
        'release-source',
      ])
      // Once the release source is unrelated too, main reaches its contained
      // receipt and skips the older alias, even though that old source matches.
      isAncestor.mockImplementation(
        async (_issue, ancestor, descendant) =>
          (ancestor === 'contained' && descendant === 'approved-base') ||
          (ancestor === 'old-source' && descendant === 'approved-head'),
      )
      isAncestor.mockClear()
      expect(
        await service['staleAdmissionPredecessor'](
          {
            ...order,
            approvedBaseSha: 'approved-base',
            approvedHeadSha: 'approved-head',
          },
          await deps.issues.get(order.issueId),
        ),
      ).toBeUndefined()
      expect(isAncestor.mock.calls.map(([, ancestor]) => ancestor)).not.toContain('old-contained')
    } finally {
      service.dispose()
    }
  })

  it('pages newest receipts until containment and skips the older destination history', async () => {
    const { store, service, deps, order } = await historyPin.setup(1)
    await cloneShippingHistory(store, order.id, 201, (table, index): Record<string, string> => {
      const at = new Date(Date.parse(order.stateChangedAt) + (index + 1) * 1_000).toISOString()
      return table === 'ship_orders'
        ? {
            approved_head_sha: `source-${index}`,
            state_changed_at: at,
            current_integration_receipt: JSON.stringify({
              ...order.currentIntegrationReceipt,
              approvedHeadSha: `source-${index}`,
            }),
          }
        : table === 'delivery_receipts'
          ? { destination_sha: `receipt-${index}`, completed_at: at }
          : {}
    })
    const isAncestor = vi.fn<typeof deps.isAncestor>(
      async (_issue, ancestor, descendant) =>
        (ancestor === 'receipt-50' && descendant === 'approved-base') ||
        (ancestor === 'source-49' && descendant === 'approved-head'),
    )
    deps.isAncestor = isAncestor
    const pages = vi.spyOn(store.shipping, 'shippedPredecessors')
    try {
      expect(
        await service['staleAdmissionPredecessor'](
          {
            ...order,
            approvedBaseSha: 'approved-base',
            approvedHeadSha: 'approved-head',
          },
          await deps.issues.get(order.issueId),
        ),
      ).toBeUndefined()
      expect(pages).toHaveBeenCalledTimes(3)
      expect(isAncestor).toHaveBeenCalledTimes(301)
      expect(isAncestor.mock.calls.at(-1)?.slice(1)).toEqual(['receipt-50', 'approved-base'])
    } finally {
      pages.mockRestore()
      service.dispose()
    }
  })

  it('checks explicit delivery dependencies before a newer contained receipt', async () => {
    const { service, deps, order } = await historyPin.setup(5)
    const isAncestor = vi.fn<typeof deps.isAncestor>(
      async (_issue, ancestor, descendant) =>
        ancestor === 'head-sha' && descendant === 'approved-base',
    )
    deps.isAncestor = isAncestor
    const receipt = await deps.repository.receiptForOrder(order.id)
    const original = deps.repository.receiptForOrder.bind(deps.repository)
    const receiptRead = vi
      .spyOn(deps.repository, 'receiptForOrder')
      .mockImplementation(async (id) =>
        id === order.id ? { ...receipt!, destinationSha: 'explicit-stale' } : await original(id),
      )
    try {
      const stale = await service['staleAdmissionPredecessor'](
        {
          ...order,
          approvedBaseSha: 'approved-base',
          deliveryDependsOn: [order.id],
        },
        await deps.issues.get(order.issueId),
      )
      expect(stale).toMatchObject({ order: { id: order.id }, destinationSha: 'explicit-stale' })
      expect(isAncestor.mock.calls.map(([, ancestor]) => ancestor)).toEqual(['explicit-stale'])
    } finally {
      receiptRead.mockRestore()
      service.dispose()
    }
  })

  it('does not clear a repair acknowledgement when the external repair port fails', async () => {
    let fail = true
    const acknowledge = vi.fn(async () => {
      if (fail) throw new Error('repair acknowledgement offline')
    })
    const { store, issues, service, deps } = await harness(
      async (input, machineId) => ({
        ...(await provedShippingJob(input, machineId)),
        ...(input.operation === 'prepare-merge-group'
          ? {
              state: 'held' as const,
              classification: 'merge-conflict' as const,
              repairBaseSha: 'base-sha',
            }
          : {}),
      }),
      {
        repair: {
          consider: async () => ({
            kind: 'needs-decision',
            resultToken: 'repair-pending',
            reasonCode: 'policy:behavior-change',
            headline: 'Decision required',
            detail: 'Choose a repair',
            evidenceRefs: [],
            actions: ['return-to-issue'],
          }),
          acknowledge,
        },
      },
    )
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'repair debt',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await expect(service.runOrder(order.id)).rejects.toThrow('repair acknowledgement offline')
    expect(await store.shipping.recoveryWork('repair-ack')).toHaveLength(1)
    service.dispose()
    const restarted = new ShippingService(deps)
    await expect(restarted.reconcile()).rejects.toThrow('repair acknowledgement offline')
    expect(await store.shipping.recoveryWork('repair-ack')).toHaveLength(1)
    fail = false
    await restarted.reconcile()
    expect(await store.shipping.recoveryWork('repair-ack')).toEqual([])
    const calls = acknowledge.mock.calls.length
    await restarted.reconcile()
    expect(acknowledge).toHaveBeenCalledTimes(calls)
    restarted.dispose()
  })
})

describe('ShippingService enqueue transaction', () => {
  it('O1 scheduler tick does not scan attempt history', async () => {
    const { store, service } = await harness()
    const attempts = vi.spyOn(store.shipping, 'attemptsForOrder')
    try {
      await service.tick()
      expect(attempts).not.toHaveBeenCalled()
    } finally {
      attempts.mockRestore()
      service.dispose()
    }
  })

  it('O1 commits and reads queue ranks without scanning attempt history', async () => {
    const { store, ledger, issues, service } = await harness()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'compact order',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const attempts = vi.spyOn(store.shipping, 'attemptsForOrder')
    try {
      const cursor = await ledger.cursor()
      const admitted = await service.enqueue(laneWriter(service), {
        issueId: issue.id,
        ...approval,
      })
      const changes = (await ledger.changesSince(cursor)) ?? []
      expect(
        changes.some((change) => change.entity === 'shipOrder' && change.op === 'upsert'),
      ).toBe(true)
      expect(admitted.projection).not.toHaveProperty('queueRank')
      expect(attempts).not.toHaveBeenCalled()

      // Its queue rank is its train in the published lane: the first.
      expect(
        ((await ledger.authority.snapshot('shipLane')) as ShipLaneProjection[]).map(
          (lane) => lane.trains,
        ),
      ).toEqual([[{ orderIds: [admitted.order.id] }]])
      expect(attempts).not.toHaveBeenCalled()

      const cancelCursor = await ledger.cursor()
      await service.cancel(laneWriter(service), {
        orderId: admitted.order.id,
        principal: approval.principal,
        overrideScope: false,
      })
      expect(await ledger.changesSince(cancelCursor)).toContainEqual(
        expect.objectContaining({ entity: 'shipOrder', id: admitted.order.id, op: 'remove' }),
      )
      expect(attempts).not.toHaveBeenCalled()
    } finally {
      attempts.mockRestore()
      service.dispose()
    }
  })

  it('O1 publishes live order rows without train or waitEstimate', async () => {
    const { store, ledger, issues, service } = await harness()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'compact wire',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    try {
      const cursor = await ledger.cursor()
      const admitted = await service.enqueue(laneWriter(service), {
        issueId: issue.id,
        ...approval,
      })
      const rows = ((await ledger.changesSince(cursor)) ?? []).filter(
        (change) => change.entity === 'shipOrder' && change.op === 'upsert',
      )
      expect(rows).toHaveLength(1)
      for (const value of [rows[0]!.value, admitted.projection]) {
        expect(value).toMatchObject({
          id: admitted.order.id,
          humanState: 'waiting',
        })
        expect(value).not.toHaveProperty('queueRank')
        expect(value).not.toHaveProperty('train')
        expect(value).not.toHaveProperty('waitEstimate')
      }
    } finally {
      service.dispose()
    }
  })

  it('O1 scheduler claims the same compatible train and leader', async () => {
    let now = '2026-08-13T10:00:00.000Z'
    const { store, issues, service } = await harness(undefined, {
      now: () => now,
      resolveBranchTip: async (issue) => (issue.title === 'upper' ? 'head-upper' : 'head-sha'),
      isAncestor: async (_issue, ancestor, descendant) =>
        ancestor === 'head-sha' && descendant === 'head-upper',
    })
    try {
      for (const [index, repoPath] of ['/repo', '/repo', '/other'].entries()) {
        now = `2026-08-13T10:00:0${index}.000Z`
        const title = ['lower', 'upper', 'other'][index]!
        const issue = await issues.crud.create(issues.reports.store.serverWriter, {
          repoPath,
          title,
          startNow: false,
        })
        await issues.crud.update(issues.reports.store.serverWriter, issue.id, {
          stage: 'review',
          branch: `issue/${title}`,
        })
        await service.enqueue(laneWriter(service), {
          issueId: issue.id,
          ...approval,
          approved: {
            ...approval.approved,
            sourceHeadSha: title === 'upper' ? 'head-upper' : 'head-sha',
          },
        })
      }
      now = '2026-08-13T10:00:00.000Z'
      const orders = await store.shipping.listOrders()
      const members = orders
        .filter((order) => order.repoPath === '/repo')
        .sort(
          (left, right) =>
            left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id),
        )
      expect(
        shippingSchedule(orders).trains.map((train) => train.orders.map((order) => order.id)),
      ).toContainEqual(members.map((order) => order.id))
      const claims = vi.spyOn(store.shipping, 'claimTrain')
      const run = vi.spyOn(service, 'runOrder').mockResolvedValue()
      try {
        await service.tick()
        expect(claims).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
          leaderOrderId: members[1]!.id,
          startedAt: '2026-08-13T10:00:00.000Z',
          members: members.map((order) => ({ orderId: order.id })),
        })
        expect(run).toHaveBeenCalledExactlyOnceWith(members[1]!.id, [members[0]])
        const manifest = await store.shipping.activeTrainForOrder(members[0]!.id)
        expect(manifest?.leaderOrderId).toBe(members[1]!.id)
        expect(manifest?.members.map((member) => member.orderId)).toEqual(
          members.map((order) => order.id),
        )
        expect(
          (await store.shipping.listOrders())
            .filter((order) => order.state === 'preflight')
            .map((order) => order.id)
            .sort(),
        ).toEqual(members.map((order) => order.id).sort())
      } finally {
        claims.mockRestore()
        run.mockRestore()
      }
    } finally {
      service.dispose()
    }
  })

  it('atomically freezes the order, moves review to shipping, and publishes compact rows', async () => {
    const { store, ledger, issues, service } = await harness()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'approved',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const cursor = await ledger.cursor()

    const receipt = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    expect(receipt.created).toBe(true)
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('shipping')
    expect(await store.shipping.getOrder(receipt.order.id)).toEqual(receipt.order)
    expect(receipt.order.currentIntegrationReceipt).toEqual({
      rootIssueId: issue.id,
      approvedHeadSha: 'head-sha',
      descendants: [],
    })
    const changes = (await ledger.changesSince(cursor)) ?? []
    expect(
      changes.some((change) => change.entity === 'issueProjection' && change.id === issue.id),
    ).toBe(true)
    expect(
      changes.some(
        (change) =>
          change.entity === 'shipOrder' && change.id === receipt.order.id && change.op === 'upsert',
      ),
    ).toBe(true)
    expect(
      changes.find((change) => change.entity === 'shipOrder' && change.id === receipt.order.id)
        ?.value,
    ).not.toHaveProperty('queueRank')

    await expect(
      service.enqueue(laneWriter(service), { issueId: issue.id, ...approval }),
    ).resolves.toMatchObject({
      created: false,
      order: { id: receipt.order.id },
    })
    expect(receipt.order.id).toMatch(/^ship_[0-9a-f-]{36}$/)
    expect(
      await store.events.listEventsSince(0, { kinds: ['issue.shipping_enqueued'] }),
    ).toHaveLength(1)
    service.dispose()
  })

  it('rejects a replay when any frozen admission fact differs', async () => {
    const { issues, service } = await harness()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'frozen replay',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    await service.enqueue(laneWriter(service), {
      issueId: issue.id,
      ...approval,
      approved: { ...approval.approved, evidenceManifestRef: 'evidence:first' },
    })

    await expect(
      service.enqueue(laneWriter(service), {
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
    const { issues, service } = await harness(undefined, {
      resolveBranchTip: async (issue) => (issue.id === lowerIssueId ? 'lower-head' : 'upper-head'),
      isAncestor: async (_issue, ancestor, descendant) =>
        ancestor === 'lower-head' && descendant === 'upper-head',
    })
    const lower = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'lower layer',
      startNow: false,
    })
    lowerIssueId = lower.id
    const upper = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'upper layer',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, lower.id, { stage: 'review' })
    await issues.crud.update(issues.reports.store.serverWriter, upper.id, { stage: 'review' })
    const lowerOrder = await service.enqueue(laneWriter(service), {
      issueId: lower.id,
      ...approval,
      approved: { ...approval.approved, sourceHeadSha: 'lower-head' },
    })
    const upperOrder = await service.enqueue(laneWriter(service), {
      issueId: upper.id,
      ...approval,
      approved: { ...approval.approved, sourceHeadSha: 'upper-head' },
    })

    expect(upperOrder.order.deliveryDependsOn).toEqual([lowerOrder.order.id])
    service.dispose()
  })

  it('refuses active-order replay when the live root head moved', async () => {
    let liveHead = 'head-sha'
    const { issues, service } = await harness(undefined, {
      resolveBranchTip: async () => liveHead,
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'live replay fence',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    liveHead = 'advanced-head-sha'
    await expect(
      service.enqueue(laneWriter(service), { issueId: issue.id, ...approval }),
    ).rejects.toMatchObject({
      code: 'source-stale',
    })
    service.dispose()
  })

  it('refuses admission when repository refs move before custody commits', async () => {
    let sourceReads = 0
    const { store, issues, service } = await harness(undefined, {
      resolveBranchTip: async () => (++sourceReads === 1 ? 'head-sha' : 'advanced-head-sha'),
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'admission ref race',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })

    await expect(
      service.enqueue(laneWriter(service), { issueId: issue.id, ...approval }),
    ).rejects.toMatchObject({
      code: 'source-stale',
    })
    expect(await store.shipping.activeOrderForIssue(issue.id)).toBeNull()
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('review')
    service.dispose()
  })

  it('rolls back issue custody and the order when the ledger append fails', async () => {
    const { store, issues, service } = await harness()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'rollback',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const append = vi.spyOn(store.sync, 'appendChanges').mockImplementationOnce(() => {
      throw new Error('append failed')
    })

    await expect(
      service.enqueue(laneWriter(service), { issueId: issue.id, ...approval }),
    ).rejects.toThrow('append failed')
    append.mockRestore()
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('review')
    expect(await store.shipping.activeOrderForIssue(issue.id)).toBeNull()
    service.dispose()
  })

  it('atomically creates or returns one order when identical admissions race', async () => {
    const { store, issues, service } = await harness()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'concurrent',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })

    const receipts = await Promise.all([
      service.enqueue(laneWriter(service), { issueId: issue.id, ...approval }),
      service.enqueue(laneWriter(service), { issueId: issue.id, ...approval }),
    ])
    expect(receipts.map((receipt) => receipt.created).sort()).toEqual([false, true])
    expect(new Set(receipts.map((receipt) => receipt.order.id)).size).toBe(1)
    expect(await store.shipping.listOrders()).toHaveLength(1)
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('shipping')
    service.dispose()
  })

  it('rejects a nested issue with the highest root and exact safe retry command', async () => {
    const { issues, service } = await harness()
    const root = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'root',
      startNow: false,
    })
    const middle = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'middle',
      parentId: root.id,
      startNow: false,
    })
    const leaf = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'leaf',
      parentId: middle.id,
      startNow: false,
    })
    const rootRef = (await issues.reports.get(root.id))?.displayRef ?? root.id
    const leafRef = (await issues.reports.get(leaf.id))?.displayRef ?? leaf.id

    await expect(
      service.enqueue(laneWriter(service), { issueId: leaf.id, ...approval }),
    ).rejects.toMatchObject({
      code: 'nested-root',
      rootIssueId: root.id,
      message:
        `${leafRef} is a sub-issue of delivery root ${rootRef} and cannot ship separately.\n` +
        `To nominate the approved root: podium issue ship ${rootRef} --outside-scope`,
    })
    service.dispose()
  })

  it('freezes the exact typed integration receipt for the live root and descendant tips', async () => {
    const { store, issues, service } = await harness(undefined, {
      useStoredReceipts: true,
    })
    const root = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'root',
      startNow: false,
    })
    const child = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'child',
      startNow: false,
      parentId: root.id,
    })
    await issues.crud.update(issues.reports.store.serverWriter, child.id, { stage: 'done' })
    await issues.crud.update(issues.reports.store.serverWriter, root.id, { stage: 'review' })

    await expect(
      service.enqueue(laneWriter(service), { issueId: root.id, ...approval }),
    ).rejects.toMatchObject({
      code: 'evidence',
    })
    const immutableReceipt = await store.shipping.recordRootIntegrationReceipt({
      rootIssueId: root.id,
      approvedHeadSha: 'head-sha',
      descendants: [{ issueId: child.id, approvedHeadSha: 'head-sha' }],
    })
    const accepted = await service.enqueue(laneWriter(service), {
      issueId: root.id,
      ...approval,
      approved: { ...approval.approved, evidenceManifestRef: 'evidence:root' },
    })
    expect(accepted.descendantManifest).toEqual([
      { issueId: child.id, approvedHeadSha: 'head-sha' },
    ])
    expect(accepted.order.currentIntegrationReceipt).toEqual(immutableReceipt)
    expect((await store.shipping.getOrder(accepted.order.id))?.currentIntegrationReceipt).toEqual(
      immutableReceipt,
    )
    service.dispose()
  })

  it('refuses stale or manifest-mismatched immutable integration proof', async () => {
    const { store, issues, service } = await harness(undefined, {
      useStoredReceipts: true,
    })
    const root = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'root refusal',
      startNow: false,
    })
    const child = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'child refusal',
      startNow: false,
      parentId: root.id,
    })
    await issues.crud.update(issues.reports.store.serverWriter, child.id, { stage: 'done' })
    await issues.crud.update(issues.reports.store.serverWriter, root.id, { stage: 'review' })
    await store.shipping.recordRootIntegrationReceipt({
      rootIssueId: root.id,
      approvedHeadSha: 'head-sha',
      descendants: [{ issueId: child.id, approvedHeadSha: 'stale-child-sha' }],
    })

    await expect(
      service.enqueue(laneWriter(service), {
        issueId: root.id,
        ...approval,
        approved: {
          ...approval.approved,
          evidenceManifestRef: 'evidence:root',
        },
      }),
    ).rejects.toMatchObject({ code: 'evidence' })
    expect(await store.shipping.activeOrderForIssue(root.id)).toBeNull()
    expect((await store.issues.getIssue(root.id))?.stage).toBe('review')
    service.dispose()
  })

  it('admits a top-level leaf without fabricating a descendant integration receipt', async () => {
    const { store, issues, service } = await harness(undefined, {
      rootIntegrationReceipt: async () => null,
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'top-level leaf',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })

    const accepted = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    expect(accepted.descendantManifest).toEqual([])
    expect(accepted.order.currentIntegrationReceipt).toBeUndefined()
    expect((await store.shipping.activeOrderForIssue(issue.id))?.id).toBe(accepted.order.id)
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('shipping')
    service.dispose()
  })

  it('freezes only typed review evidence bound to the exact live approval', async () => {
    const compatibility = new CompatibilityShippingPolicyResolver(() => 'main')
    const policy: ShippingPolicyResolver = {
      resolve: async (issue) => ({
        ...(await compatibility.resolve(issue)),
        evidenceOptional: false,
      }),
    }
    const acceptedReviewEvidence = vi.fn(
      async (input: Omit<AcceptedReviewEvidence, 'evidenceManifestRef' | 'previewLeaseIds'>) => ({
        ...input,
        evidenceManifestRef: 'review-evidence-snapshot',
        previewLeaseIds: ['preview-1'],
      }),
    )
    const { issues, service } = await harness(undefined, {
      policy,
      acceptedReviewEvidence,
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'evidence required',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })

    const accepted = await service.enqueueCurrent(laneWriter(service), {
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
    const compatible = await harness()
    const compatibleIssue = await compatible.issues.crud.create(
      compatible.issues.reports.store.serverWriter,
      {
        repoPath: '/repo',
        title: 'compatibility evidence',
        startNow: false,
      },
    )
    await compatible.issues.crud.update(
      compatible.issues.reports.store.serverWriter,
      compatibleIssue.id,
      { stage: 'review' },
    )
    const accepted = await compatible.service.enqueueCurrent(laneWriter(compatible.service), {
      issueId: compatibleIssue.id,
      principal: approval.principal,
      overrideScope: false,
    })
    expect(accepted.order.evidenceManifestRef).toBeUndefined()
    compatible.service.dispose()

    const strictPolicy: ShippingPolicyResolver = {
      resolve: async (issue) => ({
        ...(await compatibility.resolve(issue)),
        evidenceOptional: false,
      }),
    }
    for (const acceptedReviewEvidence of [
      async () => null,
      async (input: Omit<AcceptedReviewEvidence, 'evidenceManifestRef' | 'previewLeaseIds'>) => ({
        ...input,
        sourceHeadSha: 'different-reviewed-head',
        evidenceManifestRef: 'mismatched-evidence',
        previewLeaseIds: [],
      }),
    ]) {
      const strict = await harness(undefined, {
        policy: strictPolicy,
        acceptedReviewEvidence,
      })
      const issue = await strict.issues.crud.create(strict.issues.reports.store.serverWriter, {
        repoPath: '/repo',
        title: 'strict evidence',
        startNow: false,
      })
      await strict.issues.crud.update(strict.issues.reports.store.serverWriter, issue.id, {
        stage: 'review',
      })
      await expect(
        strict.service.enqueueCurrent(laneWriter(strict.service), {
          issueId: issue.id,
          principal: approval.principal,
          overrideScope: false,
        }),
      ).rejects.toMatchObject({ code: 'evidence' })
      expect(await strict.store.shipping.activeOrderForIssue(issue.id)).toBeNull()
      expect((await strict.store.issues.getIssue(issue.id))?.stage).toBe('review')
      strict.service.dispose()
    }
  })

  it('collapses unknown and invisible order identities before hold or receipt state leaks', async () => {
    let hidden = false
    const { issues, service } = await harness(undefined, {
      authorize: () => {
        if (hidden) throw Object.assign(new Error('hidden root'), { code: 'NOT_FOUND' })
      },
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'opaque order',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    hidden = true

    for (const orderId of [order.id, asShipOrderId('ship_absent')]) {
      await expect(
        service.deliveryReceipt({
          orderId,
          principal: approval.principal,
        }),
      ).rejects.toThrow(ShippingOrderAccessError)
      await expect(
        service.resolveHold(laneWriter(service), {
          orderId,
          action: 'retry',
          expectedGeneration: 1,
          principal: approval.principal,
        }),
      ).rejects.toThrow('shipping order not found or inaccessible')
      await expect(
        service.cancel(laneWriter(service), {
          orderId,
          principal: approval.principal,
          overrideScope: false,
        }),
      ).rejects.toThrow('shipping order not found or inaccessible')
    }
    service.dispose()
  })

  it('raises and generation-fences the typed hold before clearing needsHuman', async () => {
    const { store, ledger, issues, service } = await harness(async (input, machineId) => ({
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'held',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    expect((await store.shipping.getOrder(order.id))?.state).toBe('held')
    expect((await store.issues.getIssue(issue.id))?.needsHuman).toBe(true)
    const hold = await store.shipping.openHoldForOrder(order.id)
    expect(hold).toMatchObject({
      generation: 1,
      actions: ['retry', 'return-to-issue'],
    })
    await expect(
      service.resolveHold(laneWriter(service), {
        orderId: order.id,
        action: 'retry',
        expectedGeneration: 2,
        principal: approval.principal,
        requestedBy: approval.requestedBy,
      }),
    ).rejects.toThrow(/generation fence/)
    expect((await store.issues.getIssue(issue.id))?.needsHuman).toBe(true)

    await service.resolveHold(laneWriter(service), {
      orderId: order.id,
      action: 'retry',
      expectedGeneration: 1,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
    })
    expect((await store.shipping.getOrder(order.id))?.state).toBe('queued')
    expect((await store.issues.getIssue(issue.id))?.needsHuman).toBe(false)
    const projected = (await ledger.authority.snapshot('shipOrder')) as {
      id: string
      hold?: unknown
    }[]
    expect(projected.find((row) => row.id === order.id)).not.toHaveProperty('hold')
    await service.runOrder(order.id)
    expect((await store.shipping.latestAttemptForOrder(order.id))?.leaseGeneration).toBe(2)
    expect((await store.shipping.openHoldForOrder(order.id))?.generation).toBe(2)
    service.dispose()
  })

  it('authorizes admission and hold resolution and reauthorizes before landing', async () => {
    const authorize = vi.fn()
    const reauthorize = vi.fn((input: { effect: string }) => {
      if (input.effect === 'commit-merge-group') throw new Error('grant revoked')
    })
    const { issues, service, store } = await harness(
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'auth',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'enqueue' }))
    expect(reauthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: 'commit-merge-group',
        machineId: 'machine-1',
      }),
    )
    expect((await store.shipping.getOrder(order.id))?.state).toBe('held')
    expect((await store.shipping.getOrder(order.id))?.holdCode).toBe('policy-refused')
    service.dispose()
  })

  it('takes non-forcing branch custody before dispatching preflight', async () => {
    const shippingJob = vi.fn(provedShippingJob)
    const takeBranchCustody = vi.fn(async () => ({
      ok: false,
      detail: 'source worktree has unsaved changes',
    }))
    const { store, issues, service } = await harness(shippingJob, {
      takeBranchCustody,
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'custody',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    expect(takeBranchCustody).toHaveBeenCalledOnce()
    expect(shippingJob).not.toHaveBeenCalled()
    expect(await store.shipping.getOrder(order.id)).toMatchObject({
      state: 'held',
      holdCode: 'policy:branch-custody',
    })
    expect((await store.shipping.openHoldForOrder(order.id))?.detail).toContain('unsaved changes')
    service.dispose()
  })

  it('refuses daemon-native evidence paths before hold persistence', async () => {
    const { store, issues, service } = await harness(
      async (input, machineId) =>
        await provedShippingJob(input, machineId, {
          state: 'held',
          classification: 'validation-failed',
          artifactRefs: ['/native/daemon/validation.log'],
        }),
    )
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'opaque evidence',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await expect(service.runOrder(order.id)).rejects.toThrow(
      `shipping daemon result fence failed for attempt:${order.id}:1:preflight`,
    )

    expect(await store.shipping.openHoldForOrder(order.id)).toBeNull()
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
    const { store, issues, service } = await harness(provedShippingJob, {
      resourceAdmission,
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'resource locks',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    expect((await store.shipping.getOrder(order.id))?.state).toBe('shipped')
    const attempt = (await store.shipping.latestAttemptForOrder(order.id))!
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
      return await provedShippingJob(input, machineId)
    }
    const renew = vi.fn(() => true)
    const release = vi.fn()
    const resourceAdmission = { acquire: vi.fn(() => true), renew, release }
    const { store, issues, service } = await harness(daemon, { resourceAdmission })
    useFakeTimersAfterConnect()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'renew lease',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    const running = service.runOrder(order.id)
    await commitStarted
    await vi.advanceTimersByTimeAsync(40_000)
    expect(renew).toHaveBeenCalledWith(
      expect.objectContaining({ names: ['merge:main'], ttlSeconds: 120 }),
    )
    finishCommit()
    await running
    expect((await store.shipping.getOrder(order.id))?.state).toBe('shipped')
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ names: ['merge:main'] }))
    service.dispose()
  })

  it('stops durable progress and refuses release after renewal loses the lease', async () => {
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
      return await provedShippingJob(input, machineId)
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
    const { store, issues, service } = await harness(daemon, { resourceAdmission })
    useFakeTimersAfterConnect()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'lost lease',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    const running = service.runOrder(order.id)
    await commitStarted
    await vi.advanceTimersByTimeAsync(40_000)
    finishCommit()
    await running
    expect((await store.shipping.getOrder(order.id))?.state).toBe('landing')
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
    const { store, issues, service } = await harness(provedShippingJob, {
      resourceAdmission: { acquire: vi.fn(() => true), renew, release },
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'post effect fence',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await service.runOrder(order.id)

    expect(renew).toHaveBeenCalledWith(
      expect.objectContaining({ names: ['merge:main'], ttlSeconds: 120 }),
    )
    expect((await store.shipping.getOrder(order.id))?.state).toBe('landing')
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
    const { store, issues, service } = await harness(daemon, {
      resourceAdmission: { acquire: vi.fn(() => true), renew, release },
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'dispatch lease',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await service.runOrder(order.id)

    expect(
      daemon.mock.calls.some(
        ([input]) => input.action === 'start' && input.operation === 'commit-merge-group',
      ),
    ).toBe(false)
    expect((await store.shipping.getOrder(order.id))?.state).toBe('landing')
    expect(release).not.toHaveBeenCalledWith(expect.objectContaining({ names: ['merge:main'] }))
    service.dispose()
  })

  it('stops renewing active resource leases when disposed during a hung effect', async () => {
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
      return await provedShippingJob(input, machineId)
    }
    const renew = vi.fn(() => true)
    const release = vi.fn()
    const { store, issues, service } = await harness(daemon, {
      resourceAdmission: { acquire: vi.fn(() => true), renew, release },
    })
    useFakeTimersAfterConnect()
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'dispose lease',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    const running = service.runOrder(order.id)
    await commitStarted
    await vi.advanceTimersByTimeAsync(40_000)
    const renewalsBeforeDispose = renew.mock.calls.length
    service.dispose()
    await vi.advanceTimersByTimeAsync(80_000)
    expect(renew).toHaveBeenCalledTimes(renewalsBeforeDispose)
    finishCommit()
    await running
    expect((await store.shipping.getOrder(order.id))?.state).toBe('landing')
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
      return await provedShippingJob(input, machineId)
    }
    let service!: ShippingService
    let cancellation: Promise<unknown> | undefined
    const resourceAdmission = {
      acquire: vi.fn(
        async (
          input: Parameters<
            NonNullable<
              ConstructorParameters<typeof ShippingService>[0]['resourceAdmission']
            >['acquire']
          >[0],
        ) => {
          if (input.names.includes('validation:agent')) {
            cancellation = service.cancel(laneWriter(service), {
              orderId: input.order.id,
              principal: approval.principal,
              requestedBy: approval.requestedBy,
              overrideScope: false,
            })
            // "Immediately beforehand": the cancellation is durable before the
            // dispatch fence runs. Its issue read is a database read since
            // POD-6158, so without the wait its commit could land after it.
            await cancellation
          }
          return true
        },
      ),
      renew: vi.fn(() => true),
      release: vi.fn(),
    }
    const setup = await harness(daemon, { resourceAdmission })
    service = setup.service
    const issue = await setup.issues.crud.create(setup.issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'cancel fence',
      startNow: false,
    })
    await setup.issues.crud.update(setup.issues.reports.store.serverWriter, issue.id, {
      stage: 'review',
    })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await service.runOrder(order.id)
    await cancellation
    expect(calls).not.toContainEqual({
      action: 'start',
      operation: 'validate',
    })
    expect((await setup.store.shipping.getOrder(order.id))?.state).toBe('cancelled')
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
    const { store, issues, service, deps } = await harness(daemon, {
      beforeCompletionCommit: () => {
        if (crash) throw new Error('simulated server crash before completion commit')
      },
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'recover',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await expect(service.runOrder(order.id)).rejects.toThrow(/simulated server crash/)
    expect((await store.shipping.getOrder(order.id))?.state).toBe('verifying')
    expect((await store.shipping.latestAttemptForOrder(order.id))?.finishedAt).toBeUndefined()
    expect(await store.shipping.receiptForOrder(order.id)).toBeNull()
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('shipping')
    service.dispose()

    crash = false
    const restarted = new ShippingService({
      ...deps,
      beforeCompletionCommit: () => {},
    })
    await restarted.reconcile()
    expect((await store.shipping.getOrder(order.id))?.state).toBe('shipped')
    expect(await store.shipping.latestAttemptForOrder(order.id)).toMatchObject({
      outcome: 'succeeded',
      validationResult: 'passed',
    })
    expect(await store.shipping.receiptForOrder(order.id)).not.toBeNull()
    const storedReceipt = (await store.shipping.receiptForOrder(order.id))!
    expect(
      await restarted.deliveryReceipt({
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
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('done')
    restarted.dispose()
  })

  it('settles a covered train prefix on the next pass when only the leader landed (POD-6207)', async () => {
    // Every phase proves the whole train: the leader's result commit is the
    // tested integration, which lands and becomes the destination.
    const trainDaemon: ShippingJob = async (input, machineId) => {
      const proved = await provedShippingJob(input, machineId)
      const train = input.train && 'manifest' in input.train ? input.train : undefined
      if (!train) return proved
      return {
        ...proved,
        observedDestinationSha: 'train-head',
        testedIntegrationSha: 'train-head',
        landedRefSha: 'train-head',
        validationProfileId: input.validationProfile.id,
        validationResult: 'passed' as const,
        trainProofs: train.memberOrderIds.map((orderId) => {
          const member = train.manifest.members.find((candidate) => candidate.orderId === orderId)!
          return {
            issueId: member.issueId,
            orderId: member.orderId,
            attemptId: member.attemptId,
            generation: member.generation,
            sourceApprovedSha: member.approvedHeadSha,
            resultCommitSha:
              orderId === train.manifest.leaderOrderId ? 'train-head' : member.approvedHeadSha,
            testedIntegrationSha: 'train-head',
            landedRefSha: 'train-head',
            providerLandedRefSha: 'train-head',
            destinationSha: 'train-head',
          }
        }),
      }
    }
    // The train is claimed straight through the store below, which no commit
    // publishes, so the order-plane cross-check is off. The covered member is
    // the leader's Git ancestor, as a train prefix must stay.
    const { store, issues, service, deps } = await harness(trainDaemon, {
      checkOrderPlane: false,
      isAncestor: async () => true,
    })
    const issueA = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'covered a',
      startNow: false,
    })
    const issueB = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'covered b',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueA.id, {
      branch: 'issue/covered-a',
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueB.id, {
      branch: 'issue/covered-b',
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueA.id, { stage: 'review' })
    await issues.crud.update(issues.reports.store.serverWriter, issueB.id, { stage: 'review' })
    // B is stacked on A, so A is the covered prefix and B leads.
    const admitted = [
      {
        issue: issueA,
        receipt: await service.enqueue(laneWriter(service), { issueId: issueA.id, ...approval }),
      },
      {
        issue: issueB,
        receipt: await service.enqueue(laneWriter(service), { issueId: issueB.id, ...approval }),
      },
    ]
    const covered = admitted[0]!
    const leader = admitted[1]!
    expect(leader.receipt.order.deliveryDependsOn).toEqual([covered.receipt.order.id])
    await seedRows(store, () =>
      store.shipping.claimTrain(fixtureWriteScope(), {
        leaderOrderId: leader.receipt.order.id,
        startedAt: '2026-08-13T10:00:00.000Z',
        members: admitted.map(({ receipt }) => ({ orderId: receipt.order.id })),
      }),
    )

    // A crash between the leader's settlement and its covered prefix's, as a
    // build before the one atomic train completion could leave it: the leader
    // ships alone and the train stays open.
    const completeTrain = vi
      .spyOn(store.shipping, 'completeVerifiedTrain')
      .mockImplementation(
        async (scope, input) => await store.shipping.commitEffectResult(scope, input.leader),
      )
    const commitMany = deps.issues.shippingCommitMany
    deps.issues.shippingCommitMany = async (writer, entries, write) =>
      await commitMany(
        writer,
        entries.filter(
          ({ mutation: { event } }) => typeof event === 'function' || !event?.payload.coveredBy,
        ),
        write,
      )
    try {
      await service.runOrder(leader.receipt.order.id, [covered.receipt.order])
    } finally {
      completeTrain.mockRestore()
      deps.issues.shippingCommitMany = commitMany
    }
    expect((await store.shipping.getOrder(leader.receipt.order.id))?.state).toBe('shipped')
    expect((await store.shipping.getOrder(covered.receipt.order.id))?.state).toBe('preflight')
    expect((await store.issues.getIssue(covered.issue.id))?.stage).toBe('shipping')
    expect(await store.shipping.shippedLeadersOfOpenTrains()).toEqual([leader.receipt.order.id])

    await service.tick()

    expect((await store.shipping.getOrder(covered.receipt.order.id))?.state).toBe('shipped')
    expect(await store.shipping.receiptForOrder(covered.receipt.order.id)).toMatchObject({
      landedRefSha: 'train-head',
      destinationSha: 'train-head',
    })
    expect((await store.issues.getIssue(covered.issue.id))?.stage).toBe('done')
    expect(
      (await store.events.listEventsSince(0, { kinds: ['issue.shipped'] })).find(
        (event) => event.subject === covered.issue.id,
      )?.payload,
    ).toMatchObject({ coveredBy: leader.receipt.order.id })
    // The train is released as landed, so the next pass has nothing to read.
    expect(await store.shipping.shippedLeadersOfOpenTrains()).toEqual([])
    const reads = vi.spyOn(store.shipping, 'receiptForOrder')
    await service.tick()
    expect(reads).not.toHaveBeenCalled()
    reads.mockRestore()
    service.dispose()
  })

  it('settles and fences daemon cancellation before releasing issue custody', async () => {
    const authorize = vi.fn()
    const { store, issues, service } = await harness(
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'cancel',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    expect((await store.shipping.getOrder(order.id))?.state).toBe('preflight')

    await service.cancel(laneWriter(service), {
      orderId: order.id,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
      overrideScope: false,
    })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel' }))
    expect((await store.shipping.getOrder(order.id))?.state).toBe('cancelled')
    expect((await store.shipping.latestAttemptForOrder(order.id))?.outcome).toBe('cancelled')
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('review')
    service.dispose()
  })

  it('rolls back cancellation state when its durable issue event cannot commit', async () => {
    const { store, issues, service } = await harness(provedShippingJob)
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'atomic cancel',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await refuseEventInserts(store)

    await expect(
      service.cancel(laneWriter(service), {
        orderId: order.id,
        principal: approval.principal,
        requestedBy: approval.requestedBy,
        overrideScope: false,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/event refused/),
      }),
    })
    expect((await store.shipping.getOrder(order.id))?.state).toBe('queued')
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('shipping')
    service.dispose()
  })

  it('resumes the durable attempt generation after restart', async () => {
    const generations: number[] = []
    const { store, issues, service, deps } = await harness(async (input, machineId) => {
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'supersede',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const first = await store.shipping.latestAttemptForOrder(order.id)
    expect(first?.leaseGeneration).toBe(1)
    expect(first?.outcome).toBeUndefined()
    service.dispose()

    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect(generations).toEqual([1, 1])
    expect((await store.shipping.getAttempt(first!.id))?.outcome).toBeUndefined()
    expect(await store.shipping.latestAttemptForOrder(order.id)).toMatchObject({
      leaseGeneration: 1,
    })
    restarted.dispose()
  })

  it('rejects a stale attempt claimant and requires exact terminal timestamps', async () => {
    const { store, issues, service } = await harness(async (input, machineId) => ({
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'claim cas',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const first = (await store.shipping.latestAttemptForOrder(order.id))!
    const claimed = await store.shipping.claimAttempt(fixtureWriteScope(), {
      orderId: order.id,
      expectedState: 'preflight',
      expectedAttemptId: first.id,
      expectedGeneration: first.leaseGeneration,
      machineId: first.machineId,
      startedAt: '2026-08-13T10:00:01.000Z',
    })
    expect(claimed.attempt.leaseGeneration).toBe(2)
    await expect(
      store.shipping.claimAttempt(fixtureWriteScope(), {
        orderId: order.id,
        expectedState: 'preflight',
        expectedAttemptId: first.id,
        expectedGeneration: first.leaseGeneration,
        machineId: first.machineId,
        startedAt: '2026-08-13T10:00:01.000Z',
      }),
    ).rejects.toThrow(/superseded/)
    await store.shipping.finishAttempt(fixtureWriteScope(), claimed.attempt.id, 2, {
      finishedAt: '2026-08-13T10:00:02.000Z',
      outcome: 'failed',
    })
    await expect(
      store.shipping.finishAttempt(fixtureWriteScope(), claimed.attempt.id, 2, {
        finishedAt: '2026-08-13T10:00:03.000Z',
        outcome: 'failed',
      }),
    ).rejects.toThrow(/immutable/)
    await expect(
      store.shipping.finishAttempt(fixtureWriteScope(), claimed.attempt.id, 1, {
        finishedAt: '2026-08-13T10:00:02.000Z',
        outcome: 'failed',
      }),
    ).rejects.toThrow(/generation fence/)
    service.dispose()
  })

  it('recovers durable cancellation intent without superseding its attempt', async () => {
    const generations: number[] = []
    const { store, issues, service, deps } = await harness(async (input, machineId) => {
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'cancel recovery',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const first = (await store.shipping.latestAttemptForOrder(order.id))!
    const effectKey = `cancel:${first.leaseGeneration}`
    const inputFence = {
      sourceBaseSha: first.expectedSourceBaseSha,
      approvedHeadSha: first.approvedHeadSha,
      targetSha: first.expectedTargetSha,
    }
    const recordedAt = '2026-08-13T10:00:00.000Z'
    await store.shipping.requestCancellation(fixtureWriteScope(), {
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
    expect(await store.shipping.latestStepForEffect(first.id, effectKey)).toMatchObject({
      state: 'running',
    })
    await expect(
      store.shipping.claimAttempt(fixtureWriteScope(), {
        orderId: order.id,
        expectedState: 'preflight',
        expectedAttemptId: first.id,
        expectedGeneration: first.leaseGeneration,
        machineId: first.machineId,
        startedAt: '2026-08-13T10:00:01.000Z',
      }),
    ).rejects.toThrow(/durable cancellation intent/)
    service.dispose()

    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect((await store.shipping.getOrder(order.id))?.state).toBe('cancelled')
    expect(await store.shipping.latestAttemptForOrder(order.id)).toMatchObject({
      id: first.id,
      leaseGeneration: 1,
      outcome: 'cancelled',
    })
    expect(generations).toEqual([1, 1])
    restarted.dispose()
  })

  it('terminalizes cancellation intent atomically when live authorization is refused', async () => {
    const { store, issues, service } = await harness(
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'cancel refusal',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const attempt = (await store.shipping.latestAttemptForOrder(order.id))!

    const held = await service.cancel(laneWriter(service), {
      orderId: order.id,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
      overrideScope: false,
    })
    expect(held).toMatchObject({ state: 'held', holdCode: 'policy-refused' })
    expect(await store.shipping.getAttempt(attempt.id)).toMatchObject({
      outcome: 'failed',
    })
    expect(
      await store.shipping.latestStepForEffect(attempt.id, `cancel:${attempt.leaseGeneration}`),
    ).toMatchObject({
      state: 'failed',
      outcome: 'authorization-refused',
      summary: 'delegation revoked',
    })
    expect(await store.shipping.hasCancellationIntent(attempt.id, attempt.leaseGeneration)).toBe(
      false,
    )
    service.dispose()
  })

  it('terminalizes cancellation intent atomically when daemon cancellation rejects', async () => {
    const { store, issues, service } = await harness(async (input, machineId) => {
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'cancel rpc refusal',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    await service.runOrder(order.id)
    const attempt = (await store.shipping.latestAttemptForOrder(order.id))!

    const held = await service.cancel(laneWriter(service), {
      orderId: order.id,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
      overrideScope: false,
    })
    expect(held).toMatchObject({
      state: 'held',
      holdCode: 'machine-unavailable',
    })
    expect(await store.shipping.getAttempt(attempt.id)).toMatchObject({
      outcome: 'failed',
    })
    expect(
      await store.shipping.latestStepForEffect(attempt.id, `cancel:${attempt.leaseGeneration}`),
    ).toMatchObject({
      state: 'failed',
      outcome: 'cancel-error',
      summary: 'daemon disconnected',
    })
    expect(await store.shipping.hasCancellationIntent(attempt.id, attempt.leaseGeneration)).toBe(
      false,
    )
    service.dispose()
  })

  it('persists cancellation intent before awaiting and refuses the late effect result', async () => {
    let resolveStart!: (result: ShippingJobResult) => void
    let startRequestDigest = ''
    let sawStart!: () => void
    const started = new Promise<void>((resolve) => {
      sawStart = resolve
    })
    const { store, issues, service } = await harness(async (input, machineId) => {
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
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'late result',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
    const execution = service.runOrder(order.id)
    await started
    const cancellation = service.cancel(laneWriter(service), {
      orderId: order.id,
      principal: approval.principal,
      requestedBy: approval.requestedBy,
      overrideScope: false,
    })
    await cancellation
    const attempt = (await store.shipping.latestAttemptForOrder(order.id))!
    expect(
      await store.shipping.latestStepForEffect(attempt.id, `cancel:${attempt.leaseGeneration}`),
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
    expect((await store.shipping.getOrder(order.id))?.state).toBe('cancelled')
    expect(
      await store.shipping.latestStepForEffect(attempt.id, `preflight:${attempt.leaseGeneration}`),
    ).toMatchObject({ state: 'cancelled' })
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('review')
    service.dispose()
  })

  it('replays an identical repair result and acknowledges only after the hold commits', async () => {
    let crashBeforeAcknowledgement = true
    let originalContextDigest = ''
    const decision = {
      kind: 'needs-decision' as const,
      resultToken: 'repair-result-1',
      reasonCode: 'policy:behavior-change' as const,
      headline: 'Behavior changed',
      detail: 'The repair changes behavior and needs review.',
      evidenceRefs: ['artifact:repair'],
      actions: ['return-to-issue' as const],
    }
    const consider = vi.fn(async (input: Parameters<ShippingRepairPort['consider']>[0]) => {
      originalContextDigest = input.contextDigest
      return decision
    })
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
          repairBaseSha: input.approvedHeadSha,
          validationProfileId: input.validationProfile.id,
          validationResult: 'failed',
          logs: [],
          artifactRefs: [],
          heartbeatedAt: '2026-08-13T10:00:00.000Z',
          finishedAt: '2026-08-13T10:00:00.000Z',
        }
      }
      return await provedShippingJob(input, machineId)
    }
    const { store, issues, service, deps } = await harness(daemon, {
      repair,
      beforeRepairAcknowledge: () => {
        if (crashBeforeAcknowledgement) throw new Error('crash before repair ack')
      },
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'repair ack',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
    const { order } = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })

    await expect(service.runOrder(order.id)).rejects.toThrow(/crash before repair ack/)
    expect(await store.shipping.getOrder(order.id)).toMatchObject({
      state: 'held',
      holdCode: 'policy:behavior-change',
    })
    expect(acknowledge).not.toHaveBeenCalled()
    service.dispose()

    crashBeforeAcknowledgement = false
    await issues.crud.shippingCommit(
      issues.reports.store.serverWriter,
      issue.id,
      {
        expectedStage: 'shipping',
        nextStage: 'review',
        needsHuman: false,
      },
      () => {},
    )
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, {
      branch: 'issue/drifted-after-repair-decision',
    })
    const restarted = new ShippingService(deps)
    await restarted.reconcile()
    expect(consider).toHaveBeenCalledTimes(1)
    expect(acknowledge).toHaveBeenCalledWith({
      resultToken: decision.resultToken,
      orderId: order.id,
      attemptId: `attempt:${order.id}:1`,
      generation: 1,
      contextDigest: originalContextDigest,
    })
    restarted.dispose()
  })

  it('reopens a released train repair from its persisted context after restart and daemon loss', async () => {
    let daemonEvidenceRef: string | undefined
    let evidenceRegistry: ShippingEvidenceRegistry | undefined
    let persistedEvidenceRef:
      | Awaited<ReturnType<ShippingEvidenceRegistry['materialize']>>
      | undefined
    let originalContext: ShippingRepairContext | undefined
    let reopenedContext: ShippingRepairContext | undefined
    const consider = vi.fn(async (input: ShippingRepairContext) => {
      if (!originalContext) {
        if (!daemonEvidenceRef) throw new Error('daemon evidence ref was not constructed')
        originalContext = JSON.parse(JSON.stringify(input)) as ShippingRepairContext
        persistedEvidenceRef = await evidenceRegistry!.materialize({
          sourceRef: daemonEvidenceRef,
          content: 'persisted train failure evidence',
          order: input.order,
          attempt: input.attempt,
          custody: input.custody,
          authority: input.authority,
        })
        return {
          kind: 'needs-decision' as const,
          resultToken: 'train-repair-decision',
          reasonCode: 'landing-conflict' as const,
          headline: 'Train repair needs approval',
          detail: 'Approve the bounded train repair.',
          evidenceRefs: [],
          actions: ['return-to-issue' as const, 'open-repair' as const],
        }
      }
      reopenedContext = input
      return {
        kind: 'patched' as const,
        resultToken: 'train-repair-patch',
        repairRef: shipRepairRef(
          input.order.id,
          input.attempt.id,
          input.attempt.leaseGeneration,
          input.contextDigest,
        ),
        candidateHeadSha: 'reopened-train-candidate',
      }
    })
    const repair: ShippingRepairPort = { consider, acknowledge: vi.fn(async () => {}) }
    const daemon: Parameters<typeof harness>[0] = async (input, machineId) => {
      if (input.action === 'start' && input.operation === 'prepare-merge-group') {
        daemonEvidenceRef = `artifact://shipping/${createHash('sha256')
          .update(
            shippingEvidenceFingerprint(
              { type: 'shippingJobRequest', requestId: 'evidence', ...input },
              machineId,
              0,
            ),
          )
          .digest('hex')}`
        return {
          jobId: input.jobId,
          requestDigest: input.requestDigest,
          orderId: input.orderId,
          attemptId: input.attemptId,
          machineId,
          generation: input.generation,
          operation: input.operation,
          state: 'held',
          classification: 'merge-conflict',
          summary: 'train composition conflicted',
          repairBaseSha: 'partial-train-candidate',
          logs: [],
          artifactRefs: [daemonEvidenceRef],
          heartbeatedAt: '2026-08-13T10:00:00.000Z',
          finishedAt: '2026-08-13T10:00:00.000Z',
        }
      }
      return await provedShippingJob(input, machineId)
    }
    // The train is claimed straight through the store below, which no commit
    // publishes, so the order-plane cross-check would only report that shortcut.
    const { store, issues, service, deps } = await harness(daemon, {
      repair,
      checkOrderPlane: false,
    })
    evidenceRegistry = new ShippingEvidenceRegistry(store.shipping)
    const issueA = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'repair train a',
      startNow: false,
    })
    const issueB = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'repair train b',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueA.id, {
      branch: 'issue/repair-train-a',
      machineId: asMachineId('machine-1'),
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueB.id, {
      branch: 'issue/repair-train-b',
      machineId: asMachineId('machine-1'),
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueA.id, { stage: 'review' })
    await issues.crud.update(issues.reports.store.serverWriter, issueB.id, { stage: 'review' })
    const admitted = [
      {
        issue: issueA,
        receipt: await service.enqueue(laneWriter(service), { issueId: issueA.id, ...approval }),
      },
      {
        issue: issueB,
        receipt: await service.enqueue(laneWriter(service), { issueId: issueB.id, ...approval }),
      },
    ].sort(
      (left, right) =>
        left.receipt.order.requestedAt.localeCompare(right.receipt.order.requestedAt) ||
        left.receipt.order.id.localeCompare(right.receipt.order.id),
    )
    const sibling = admitted[0]!
    const leader = admitted[1]!
    await seedRows(store, () =>
      store.shipping.claimTrain(fixtureWriteScope(), {
        leaderOrderId: leader.receipt.order.id,
        startedAt: '2026-08-13T10:00:00.000Z',
        members: admitted.map(({ receipt }) => ({ orderId: receipt.order.id })),
      }),
    )

    await service.runOrder(leader.receipt.order.id, [sibling.receipt.order])
    const hold = (await store.shipping.openHoldForOrder(leader.receipt.order.id))!
    expect(hold.actions).toContain('open-repair')
    expect(await store.shipping.activeTrainForOrder(leader.receipt.order.id)).toBeNull()
    expect(originalContext?.authority.train).toBeDefined()
    expect(originalContext?.failure.repairBaseSha).toBe('partial-train-candidate')
    const evidenceRef = daemonEvidenceRef
    expect(evidenceRef).toMatch(/^artifact:\/\/shipping\/[a-f0-9]{64}$/)
    if (!evidenceRef) throw new Error('daemon evidence ref was not recorded')
    service.dispose()

    await issues.crud.shippingCommit(
      issues.reports.store.serverWriter,
      leader.issue.id,
      {
        expectedStage: 'shipping',
        nextStage: 'review',
        needsHuman: false,
      },
      () => {},
    )
    await issues.crud.update(issues.reports.store.serverWriter, leader.issue.id, {
      branch: 'issue/drifted-after-train-release',
    })
    await issues.crud.shippingCommit(
      issues.reports.store.serverWriter,
      leader.issue.id,
      {
        expectedStage: 'review',
        nextStage: 'shipping',
        needsHuman: true,
      },
      () => {},
    )
    const unavailableDaemon = vi.fn(async () => {
      throw new Error('daemon journal and logs unavailable')
    })
    deps.daemon.shippingJob = unavailableDaemon
    const restarted = new ShippingService(deps)
    const resolved = await restarted.resolveHold(laneWriter(restarted), {
      orderId: leader.receipt.order.id,
      action: 'open-repair',
      expectedGeneration: hold.generation,
      principal: approval.principal,
      overrideScope: false,
    })

    expect(resolved.order.state).toBe('repairing')
    expect(reopenedContext).toEqual(originalContext)
    expect(unavailableDaemon).not.toHaveBeenCalled()
    const restartedEvidence = new ShippingEvidenceRegistry(store.shipping)
    expect(
      await restartedEvidence.resolve({
        sourceRef: evidenceRef,
        order: reopenedContext!.order,
        attempt: reopenedContext!.attempt,
        custody: reopenedContext!.custody,
        authority: reopenedContext!.authority,
      }),
    ).toBe(persistedEvidenceRef)
    expect(
      await restartedEvidence.read(
        {
          ...reopenedContext!,
          failure: { ...reopenedContext!.failure, artifactRefs: [persistedEvidenceRef!] },
        },
        persistedEvidenceRef!,
        1024,
      ),
    ).toBe('persisted train failure evidence')
    expect(
      (await store.shipping.repairCandidatesForAttempt(originalContext!.attempt.id)).at(-1),
    ).toMatchObject({
      contextDigest: originalContext!.contextDigest,
      candidateHeadSha: 'reopened-train-candidate',
    })
    restarted.dispose()
  })

  it('recovers late descendant invalidation debt and retains it across a failed ancestry check', async () => {
    const { store, issues, service, deps } = await harness(provedShippingJob, {
      resolveBranchTip: async (issue) =>
        issue.title === 'landed predecessor' ? 'lower-head' : 'upper-head',
      isAncestor: async (_issue, ancestor, descendant) =>
        ancestor === 'lower-head' && descendant === 'upper-head',
    })
    const lowerIssue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'landed predecessor',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, lowerIssue.id, { stage: 'review' })
    const lower = await service.enqueue(laneWriter(service), {
      issueId: lowerIssue.id,
      ...approval,
      approved: { ...approval.approved, sourceHeadSha: 'lower-head' },
    })
    await service.runOrder(lower.order.id)
    expect((await store.shipping.getOrder(lower.order.id))?.state).toBe('shipped')

    const upperIssue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'stale descendant',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, upperIssue.id, { stage: 'review' })
    const upper = await service.enqueue(laneWriter(service), {
      issueId: upperIssue.id,
      ...approval,
      approved: { ...approval.approved, sourceHeadSha: 'upper-head' },
    })
    expect(await store.shipping.recoveryWork('descendants')).toHaveLength(1)
    service.dispose()

    const isAncestor = deps.isAncestor
    deps.isAncestor = async () => {
      throw new Error('ancestry unavailable')
    }
    const restarted = new ShippingService(deps)
    await expect(restarted.reconcile()).rejects.toThrow('ancestry unavailable')
    expect(await store.shipping.recoveryWork('descendants')).toHaveLength(1)
    expect((await store.shipping.getOrder(upper.order.id))?.state).toBe('queued')
    deps.isAncestor = isAncestor
    await restarted.reconcile()
    expect(await store.shipping.recoveryWork('descendants')).toEqual([])
    expect(await store.shipping.getOrder(upper.order.id)).toMatchObject({
      state: 'held',
      holdCode: 'approval-stale',
    })
    expect((await store.issues.getIssue(upperIssue.id))?.needsHuman).toBe(true)
    restarted.dispose()
  })

  it('keeps a queued D2-based descendant valid when boot replays historical D1', async () => {
    const { store, issues, service, deps } = await harness(provedShippingJob, {
      resolveBranchTip: async (issue) =>
        issue.title === 'historical D1'
          ? 'landing-d1'
          : issue.title === 'D2 blocker'
            ? 'blocker-head'
            : 'descendant-head',
      resolveRefTip: async (issue) =>
        issue.title === 'historical D1' ? 'base-before-d1' : 'destination-d2',
      isAncestor: async (_issue, ancestor, descendant) =>
        (ancestor === 'landing-d1' && descendant === 'descendant-head') ||
        (ancestor === 'landing-d1' && descendant === 'destination-d2') ||
        (ancestor === 'blocker-head' && descendant === 'descendant-head'),
    })
    const landedIssue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'historical D1',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, landedIssue.id, { stage: 'review' })
    const landed = await service.enqueue(laneWriter(service), {
      issueId: landedIssue.id,
      ...approval,
      approved: {
        ...approval.approved,
        sourceBaseSha: 'base-before-d1',
        sourceHeadSha: 'landing-d1',
      },
    })
    await service.runOrder(landed.order.id)
    expect((await store.shipping.getOrder(landed.order.id))?.state).toBe('shipped')

    const blockerIssue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'D2 blocker',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, blockerIssue.id, {
      stage: 'review',
    })
    await service.enqueue(laneWriter(service), {
      issueId: blockerIssue.id,
      ...approval,
      approved: {
        ...approval.approved,
        sourceBaseSha: 'destination-d2',
        sourceHeadSha: 'blocker-head',
      },
    })
    const descendantIssue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'D2 descendant',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, descendantIssue.id, {
      stage: 'review',
    })
    const descendant = await service.enqueue(laneWriter(service), {
      issueId: descendantIssue.id,
      ...approval,
      approved: {
        ...approval.approved,
        sourceBaseSha: 'destination-d2',
        sourceHeadSha: 'descendant-head',
      },
    })
    service.dispose()

    deps.daemon.shippingJob = async () => {
      throw new Error('daemon unavailable during boot')
    }
    deps.machineCapabilities = () => []
    const restarted = new ShippingService(deps)
    await expect(restarted.reconcile()).rejects.toThrow(/daemon unavailable during boot/)
    expect((await store.shipping.getOrder(descendant.order.id))?.state).toBe('queued')
    expect(await store.shipping.openHoldForOrder(descendant.order.id)).toBeNull()
    expect((await store.issues.getIssue(descendantIssue.id))?.needsHuman).toBe(false)
    restarted.dispose()
  })

  it('keeps a preflight train sibling queued and non-human when its leader holds', async () => {
    const heldDaemon: Parameters<typeof harness>[0] = async (input, machineId) => ({
      jobId: input.jobId,
      requestDigest: input.requestDigest,
      orderId: input.orderId,
      attemptId: input.attemptId,
      machineId,
      generation: input.generation,
      operation: input.operation,
      state: 'held',
      classification: 'dirty-worktree',
      summary: 'leader requires attention',
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
      finishedAt: '2026-08-13T10:00:00.000Z',
    })
    const { store, ledger, issues, service } = await harness(heldDaemon)
    const issueA = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'train a',
      startNow: false,
    })
    const issueB = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'train b',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueA.id, {
      branch: 'issue/train-a',
      machineId: asMachineId('machine-1'),
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueB.id, {
      branch: 'issue/train-b',
      machineId: asMachineId('machine-1'),
    })
    await issues.crud.update(issues.reports.store.serverWriter, issueA.id, { stage: 'review' })
    await issues.crud.update(issues.reports.store.serverWriter, issueB.id, { stage: 'review' })
    const admitted = [
      {
        issue: issueA,
        receipt: await service.enqueue(laneWriter(service), { issueId: issueA.id, ...approval }),
      },
      {
        issue: issueB,
        receipt: await service.enqueue(laneWriter(service), { issueId: issueB.id, ...approval }),
      },
    ].sort(
      (left, right) =>
        left.receipt.order.requestedAt.localeCompare(right.receipt.order.requestedAt) ||
        left.receipt.order.id.localeCompare(right.receipt.order.id),
    )
    const sibling = admitted[0]!
    const leader = admitted[1]!
    await seedRows(store, () =>
      store.shipping.claimTrain(fixtureWriteScope(), {
        leaderOrderId: leader.receipt.order.id,
        startedAt: '2026-08-13T10:00:00.000Z',
        members: admitted.map(({ receipt }) => ({ orderId: receipt.order.id })),
      }),
    )
    await expect(
      service.enqueue(laneWriter(service), { issueId: sibling.issue.id, ...approval }),
    ).resolves.toMatchObject({
      created: false,
      order: { id: sibling.receipt.order.id },
    })

    await service.runOrder(leader.receipt.order.id, [sibling.receipt.order])
    expect((await store.shipping.getOrder(leader.receipt.order.id))?.state).toBe('held')
    expect((await store.issues.getIssue(leader.issue.id))?.needsHuman).toBe(true)
    expect((await store.shipping.getOrder(sibling.receipt.order.id))?.state).toBe('queued')
    expect((await store.issues.getIssue(sibling.issue.id))?.needsHuman).toBe(false)
    expect(
      (await store.events.listEventsSince(0, { kinds: ['issue.shipping_train_reset'] })).some(
        (event) => event.subject === sibling.issue.id,
      ),
    ).toBe(true)
    service.dispose()
  })
})

/**
 * SINGLE-FLIGHT GUARDS (POD-3258). Two timer callbacks in this service reach the
 * store and had no fence of their own: the scheduler pass, and each resource
 * lease's renew tick.
 */
describe('ShippingService single-flight guards (POD-3258)', () => {
  /**
   * `admissionsInFlight` and `inFlight` fence the ADMISSION, not the pass that
   * decides it — and everything before the first admission already awaits: the
   * covered-prefix recovery, the order read, the schedule build. So two ticks
   * could both build a schedule from the same pre-admission snapshot and both
   * pick the same head order, leaving the custody check in `runOrder` as the
   * only thing between them and a double admission.
   *
   * The probe re-enters from inside `activeOrders`, which the schedule build
   * reads twice on every pass (before and after it records native-stack edges)
   * — after the awaits and before any admission.
   */
  it('the scheduler pass skips a tick that lands on a pass already running', async () => {
    const { store, service } = await harness()
    let calls = 0
    let inner: Promise<void> | undefined
    const original = store.shipping.activeOrders.bind(store.shipping)
    const spy = vi.spyOn(store.shipping, 'activeOrders').mockImplementation(async () => {
      calls += 1
      if (!inner) inner = service.tick()
      return await original()
    })

    await service.tick()
    await inner

    expect(inner).toBeDefined()
    // One pass's two reads: the re-entered tick read nothing.
    expect(calls).toBe(2)
    spy.mockRestore()
    service.dispose()
  })

  it('the scheduler pass runs normally once the previous pass has finished', async () => {
    const { store, service } = await harness()
    let calls = 0
    const original = store.shipping.activeOrders.bind(store.shipping)
    const spy = vi.spyOn(store.shipping, 'activeOrders').mockImplementation(async () => {
      calls += 1
      return await original()
    })

    await service.tick()
    await service.tick()

    expect(calls).toBe(4)
    spy.mockRestore()
    service.dispose()
  })

  /**
   * The renew tick fires every ttl/3 and reaches the lock service, so a renew
   * slower than a third of the TTL is met by the next tick while it is still
   * out. Two renews for one lease race on `lease.lost` and `lease.expiresAt`:
   * the loser's stale verdict can overwrite the winner's, either extending a
   * lease that was actually lost or condemning one that was renewed.
   *
   * Driven through `renewResourceLeaseTick` rather than the interval, because
   * fake timers will not re-fire an interval that is currently executing — a
   * nested advance produces no second call, and the test would pass vacuously
   * whether the fence existed or not.
   */
  it('a lease renew skips a tick that lands on a renew already running', async () => {
    const { service } = await harness()
    let renews = 0
    let reentered = false
    // Renews that happened DURING the re-entrant call — the overlapping tick
    // only, which is the thing the fence is supposed to refuse.
    let renewsDuringReentry = -1
    const lease: ResourceLease = {
      lost: false,
      expiresAt: Date.now() + 120_000,
      ttlMs: 120_000,
      renew: async () => {
        renews += 1
        if (!reentered) {
          reentered = true
          const before = renews
          void service.renewResourceLeaseTick(lease, 120)
          renewsDuringReentry = renews - before
        }
        return true
      },
    }

    await service.renewResourceLeaseTick(lease, 120)

    expect(reentered).toBe(true)
    expect(renewsDuringReentry).toBe(0)
    expect(renews).toBe(1)
    expect(lease.lost).toBe(false)
    service.dispose()
  })

  it('a later, non-overlapping lease renew runs normally', async () => {
    const { service } = await harness()
    let renews = 0
    const lease: ResourceLease = {
      lost: false,
      expiresAt: Date.now() + 120_000,
      ttlMs: 120_000,
      renew: async () => {
        renews += 1
        return true
      },
    }

    await service.renewResourceLeaseTick(lease, 120)
    await service.renewResourceLeaseTick(lease, 120)

    expect(renews).toBe(2)
    service.dispose()
  })

  it('releases the lease fence when a renew throws, and marks the lease lost', async () => {
    const { service } = await harness()
    let renews = 0
    const lease: ResourceLease = {
      lost: false,
      expiresAt: Date.now() + 120_000,
      ttlMs: 120_000,
      // ASYNC, so the rejection can only be caught by awaiting the call. A
      // synchronous `throw` here would be caught by the tick's `try` whether or
      // not it awaited `renew`, which is exactly the blind spot POD-3488 was.
      renew: async () => {
        renews += 1
        throw new Error('lock service is gone')
      },
    }

    await service.renewResourceLeaseTick(lease, 120)

    expect(renews).toBe(1)
    expect(lease.lost).toBe(true)
    expect(lease.renewing).toBe(false)
    service.dispose()
  })
})

/**
 * BOUNDARY LEASE RE-CHECK (POD-3488). `renewResourceLease` is what stands between
 * a lost resource lease and a dispatch or a durable commit. Its refusal arm was
 * unreachable: `ResourceLease.renew` was typed `() => boolean | Promise<boolean>`
 * while the only implementation is async, so `if (!lease.renew())` negated a
 * promise — always false — and every boundary was told the lease was still held.
 *
 * TWO LEVELS, and both are needed. The method's own tests fix its contract. The
 * `runEffect` tests below fix the CALLER side, which the compiler cannot: the
 * narrowed port stops an implementation being synchronous, but negating a promise
 * is legal at every type, so a caller that drops the `await` still compiles
 * [POD-3221 rule 52b, as amended]. Each test here goes red when the `await` at
 * the boundary it covers is removed.
 */
describe('ShippingService resource lease boundary re-check (POD-3488)', () => {
  const liveLease = (renew: ResourceLease['renew']): ResourceLease => ({
    lost: false,
    expiresAt: Date.now() + 120_000,
    ttlMs: 120_000,
    renew,
  })

  it('refuses the boundary and marks the lease lost when the renewal fails', async () => {
    const { service } = await harness()
    let renews = 0
    const lease = liveLease(async () => {
      renews += 1
      return false
    })

    const held = await service.renewResourceLease(lease)

    expect(renews).toBe(1)
    expect(held).toBe(false)
    expect(lease.lost).toBe(true)
    service.dispose()
  })

  it('refuses the boundary and marks the lease lost when the renewal rejects', async () => {
    const { service } = await harness()
    const lease = liveLease(async () => {
      throw new Error('lock service is gone')
    })

    const held = await service.renewResourceLease(lease)

    expect(held).toBe(false)
    expect(lease.lost).toBe(true)
    service.dispose()
  })

  it('holds the boundary and extends the lease when the renewal succeeds', async () => {
    const { service } = await harness()
    const lease = liveLease(async () => true)
    lease.expiresAt = Date.now() + 1_000

    const held = await service.renewResourceLease(lease)

    expect(held).toBe(true)
    expect(lease.lost).toBe(false)
    expect(lease.expiresAt).toBeGreaterThan(Date.now() + 100_000)
    service.dispose()
  })

  it('refuses a lease that is already lost without asking the lock service', async () => {
    const { service } = await harness()
    let renews = 0
    const lease = liveLease(async () => {
      renews += 1
      return true
    })
    lease.lost = true

    expect(await service.renewResourceLease(lease)).toBe(false)
    expect(renews).toBe(0)
    service.dispose()
  })

  /**
   * THE TWO BOUNDARIES INSIDE `runEffect`, driven against stub ports rather than
   * through a full order run: a run reaches them only via the store, and what is
   * under test is the branch, not the route to it. The order/attempt/issue and the
   * policy profile are only as complete as `jobInput` needs to BUILD — so that a
   * dropped `await` fails on the assertion below rather than on a stub the correct
   * path never reaches.
   */
  const runEffectHarness = () => {
    const audits: { kind: string; payload: Record<string, unknown> }[] = []
    const order = {
      id: asShipOrderId('order-1'),
      issueId: 'iss_boundary',
      state: 'landing',
      repoId: 'repo_boundary',
      targetBranch: 'main',
      destination: 'main',
      policyId: 'policy-1',
      approvedBaseSha: 'base-sha',
      approvedHeadSha: 'head-sha',
    }
    const attempt = {
      id: 'attempt-1',
      leaseGeneration: 3,
      machineId: asMachineId('machine-1'),
      expectedTargetSha: 'target-sha',
      expectedSourceBaseSha: 'base-sha',
      approvedHeadSha: 'head-sha',
    }
    const issue = { id: 'iss_boundary', repoPath: '/repo', branch: 'issue/boundary' } as IssueReport
    // Echoes the request it was given, so the post-effect authority fence passes
    // and the test can reach the second boundary. `running` keeps the effect from
    // committing anything afterwards.
    const shippingJob = vi.fn(
      async (request: { orderId: string; requestDigest: string; operation: string }) => ({
        orderId: request.orderId,
        requestDigest: request.requestDigest,
        attemptId: attempt.id,
        generation: attempt.leaseGeneration,
        operation: request.operation,
        machineId: attempt.machineId,
        artifactRefs: [],
        state: 'running',
      }),
    )
    const service = new ShippingService({
      repository: {
        repairCandidatesForAttempt: async () => [],
        latestStepForEffect: async () => ({
          state: 'running',
          startedAt: '2026-09-06T00:00:00.000Z',
        }),
        hasCancellationIntent: async () => false,
        assertEffectDispatchCustody: async () => {},
        trainManifestForAttempt: async () => null,
      },
      issues: { get: async () => issue },
      ledger: {},
      daemon: { shippingJob },
      authorization: { reauthorize: async () => {} },
      evidence: {},
      policy: {
        resolve: async () => ({
          id: 'policy-1',
          validationProfile: {
            id: 'profile-1',
            argv: ['true'],
            cwd: '/repo',
            timeoutMs: 1_000,
            resourceLocks: [],
          },
        }),
      },
      machineFor: () => asMachineId('machine-1'),
      resolveBranchTip: async () => 'head-sha',
      resolveRefTip: async () => 'target-sha',
      isAncestor: async () => true,
      audit: (kind: string, _issueId: unknown, payload: Record<string, unknown>) =>
        audits.push({ kind, payload }),
      background: false,
    } as unknown as ConstructorParameters<typeof ShippingService>[0])
    const runEffect = (lease: ResourceLease) =>
      (
        service as unknown as {
          runEffect(
            order: unknown,
            attempt: unknown,
            issue: IssueReport,
            operation: ShippingJobResult['operation'],
            nextState: undefined,
            resourceLease: ResourceLease,
          ): Promise<unknown>
        }
      ).runEffect(order, attempt, issue, 'commit-merge-group', undefined, lease)
    return { service, shippingJob, audits, runEffect }
  }

  it('refuses to dispatch the effect when the renewal before dispatch resolves false', async () => {
    const { service, shippingJob, audits, runEffect } = runEffectHarness()
    const lease = liveLease(async () => false)

    const result = await runEffect(lease)

    expect(shippingJob).not.toHaveBeenCalled()
    expect(result).toBeNull()
    expect(lease.lost).toBe(true)
    expect(audits).toEqual([
      {
        kind: 'shipping.resource_lease_lost',
        payload: expect.objectContaining({
          boundary: 'before-dispatch',
          operation: 'commit-merge-group',
        }),
      },
    ])
    service.dispose()
  })

  /**
   * The SECOND boundary, after the daemon effect and before durable progress. It
   * needs its own case because the first one returns early: a lease that is still
   * held at dispatch and lost by the time the effect lands is exactly the window
   * this check exists for, and the audit is how the refusal is observable — the
   * `running` result would return null either way.
   */
  it('refuses durable progress when the renewal after the effect resolves false', async () => {
    const { service, shippingJob, audits, runEffect } = runEffectHarness()
    let renews = 0
    const lease = liveLease(async () => {
      renews += 1
      return renews === 1
    })

    const result = await runEffect(lease)

    expect(shippingJob).toHaveBeenCalledTimes(1)
    expect(renews).toBe(2)
    expect(result).toBeNull()
    expect(lease.lost).toBe(true)
    expect(audits).toEqual([
      {
        kind: 'shipping.resource_lease_lost',
        payload: expect.objectContaining({
          boundary: 'after-effect',
          operation: 'commit-merge-group',
        }),
      },
    ])
    service.dispose()
  })
})

/**
 * `audit` USED TO BE TYPED `=> void` (POD-3820), and the twenty-odd call sites
 * in this service all fired it and moved on.
 *
 * The composition root wires it to `store.events.appendEvent` plus an issue
 * read — an `async` function, which a `void` return type accepts without a
 * murmur (TypeScript's void-return special case). Under the async store
 * executor that discarded transaction JOINS the shipping span as a savepoint:
 * the span's next statement addresses a frame with an open child and is refused,
 * and the savepoint dies when the span closes. That is the lock bug (POD-3802)
 * with a different caller.
 *
 * The dep now returns `Promise<void>` and `ShippingService.audit` hands it to
 * `afterCommit`. The audit below is production-shaped — it opens a REAL store
 * transaction — which is the one thing a `vi.fn()` stub cannot show.
 */
describe('ShippingService under the async store (POD-3820)', () => {
  it('an audit that opens its own transaction neither breaks the enqueue nor is lost', async () => {
    const audited: string[] = []
    const { store, issues, service } = await harness(undefined, {
      audit: async (kind, issueId) => {
        audited.push(kind)
        await store.transact(async () => {
          await store.issues.getIssue(issueId)
        })
      },
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'approved',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })

    await store.transact(async () => {
      const receipt = await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
      expect(receipt.created).toBe(true)
      // The statement the lock bug died on: the same span, one line after the
      // audit fired. A dropped promise makes this a refusal, and the enqueue's
      // own writes go down with the frame.
      expect((await store.issues.getIssue(issue.id))?.stage).toBe('shipping')
    })

    expect(audited).toContain('shipping.order_enqueued')
    service.dispose()
  })

  it('a rolled-back enqueue writes no audit row: the trail cannot claim work that did not happen', async () => {
    const audited: string[] = []
    const { store, issues, service } = await harness(undefined, {
      audit: async (kind, issueId) => {
        audited.push(kind)
        await store.transact(async () => {
          await store.issues.getIssue(issueId)
        })
      },
    })
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'approved',
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })

    await expect(
      store.transact(async () => {
        await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
        throw new Error('caller rolled back after the enqueue')
      }),
    ).rejects.toThrow('caller rolled back after the enqueue')

    expect(audited).toEqual([])
    expect((await store.issues.getIssue(issue.id))?.stage).toBe('review')
    service.dispose()
  })
})

describe('POD-4974 O2 ship lanes', () => {
  const PROFILE = {
    id: 'default',
    argv: ['bun', 'run', 'test'],
    cwd: 'integration-root' as const,
    timeoutMs: 60_000,
    resourceLocks: [] as string[],
  }
  /** One queued order written straight into the store, as admission would
   * freeze it; nothing is published until a commit names it. */
  const seedOrder = async (
    issues: IssueService,
    store: SessionStore,
    input: {
      title: string
      minute: number
      repoPath?: string
      headSha?: string
      baseSha?: string
      deliveryDependsOn?: ShipOrder['deliveryDependsOn']
    },
  ): Promise<ShipOrder> => {
    const repoPath = input.repoPath ?? '/repo'
    const created = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath,
      title: input.title,
      startNow: false,
    })
    await issues.crud.update(issues.reports.store.serverWriter, created.id, {
      stage: 'review',
      branch: `issue/${input.title}`,
    })
    const issue = (await issues.reports.get(created.id))!
    const at = `2026-08-13T10:${String(input.minute).padStart(2, '0')}:00.000Z`
    return await seedRows(store, () =>
      store.shipping.createOrder(fixtureWriteScope(), {
        id: asShipOrderId(`order-${input.title}`),
        issueId: issue.id,
        descendantManifest: [],
        repoId: issue.repoId!,
        repoPath,
        machineId: asMachineId('machine-1'),
        targetBranch: 'main',
        destination: 'local:main',
        approvedBaseSha: input.baseSha ?? 'base-sha',
        approvedHeadSha: input.headSha ?? `head-${input.title}`,
        deliveryDependsOn: input.deliveryDependsOn ?? [],
        requestedBy: approval.requestedBy,
        requestedAt: at,
        policyId: 'compatibility-local:main',
        validationProfile: PROFILE,
        validationProfileDigest: createHash('sha256').update(JSON.stringify(PROFILE)).digest('hex'),
        closeMode: 'after-destination',
        state: 'queued',
        stateChangedAt: at,
      }),
    )
  }
  /** Bootstrap reads seeded model truth without starting the lane machine. */
  const publishSeeded = async (_service: ShippingService, ledger: Ledger) => {
    await ledger.authority.snapshot('shipOrder')
    await ledger.authority.snapshot('shipLane')
  }
  const published = async (ledger: Ledger) => {
    const lanes = (await ledger.authority.snapshot('shipLane')) as ShipLaneProjection[]
    return {
      orders: (await ledger.authority.snapshot('shipOrder')) as ShipOrderProjection[],
      ranks: new Map(
        lanes.flatMap((lane) =>
          lane.trains.flatMap((train, index) =>
            train.orderIds.map((id) => [id, index + 1] as const),
          ),
        ),
      ),
      lanes,
    }
  }

  it('O4 boot and reconnect truth omit order ranks while preserving lane positions', async () => {
    const { store, ledger, issues, service } = await harness(undefined, { checkOrderPlane: false })
    try {
      const first = await seedOrder(issues, store, { title: 'first', minute: 1 })
      const second = await seedOrder(issues, store, {
        title: 'second',
        minute: 2,
        baseSha: 'other-base',
      })
      const truth = await service['fullProjection']()
      expect(truth.orders.map((row) => row.id)).toEqual([first.id, second.id])
      for (const row of truth.orders) expect(row.value).not.toHaveProperty('queueRank')
      expect(truth.lanes[0]?.value.trains).toEqual([
        { orderIds: [first.id] },
        { orderIds: [second.id] },
      ])
      await publishSeeded(service, ledger)
      const after = await published(ledger)
      for (const row of after.orders) expect(row).not.toHaveProperty('queueRank')
      expect(after.ranks).toEqual(
        new Map([
          [first.id, 1],
          [second.id, 2],
        ]),
      )
    } finally {
      service.dispose()
    }
  })

  it('O4 clears legacy ledger ranks then publishes a lane change without resending unchanged orders', async () => {
    const { store, ledger, issues, service } = await harness(undefined, { checkOrderPlane: false })
    try {
      const first = await seedOrder(issues, store, { title: 'first', minute: 1 })
      const second = await seedOrder(issues, store, {
        title: 'second',
        minute: 2,
        baseSha: 'other-base',
      })
      const elsewhere = await seedOrder(issues, store, {
        title: 'elsewhere',
        minute: 3,
        repoPath: '/other',
      })
      // Bootstrap uses model rows, so obsolete ranks in old log rows are absent.
      expect((await published(ledger)).orders.every((row) => !('queueRank' in row))).toBe(true)
      await publishSeeded(service, ledger)
      const before = await published(ledger)
      for (const row of before.orders) expect(row).not.toHaveProperty('queueRank')

      const cursor = await ledger.cursor()
      await service['transition'](first, 'preflight')
      const changes = ((await ledger.changesSince(cursor)) ?? []).filter(
        (change) => change.entity === 'shipOrder' || change.entity === 'shipLane',
      )
      expect(changes.map((change) => `${change.entity}:${change.id}`).sort()).toEqual(
        [`shipOrder:${first.id}`, `shipLane:${shipLaneIdOf(first)}`].sort(),
      )
      const changedOrder = changes.find((change) => change.entity === 'shipOrder')!
      expect(changedOrder.value).toMatchObject({ id: first.id, state: 'preflight' })
      expect(changedOrder.value).not.toHaveProperty('queueRank')
      const after = await published(ledger)
      expect(after.ranks.get(second.id)).toBe(1)
      for (const id of [second.id, elsewhere.id]) {
        expect(after.orders.find((row) => row.id === id)).toEqual(
          before.orders.find((row) => row.id === id),
        )
      }
      expect(new Map(after.orders.map((row) => [row.id, row]))).toEqual(
        new Map((await service['fullProjection']()).orders.map((row) => [row.id, row.value])),
      )
    } finally {
      service.dispose()
    }
  })

  it('O2 publishes the order the scheduler runs, native-stack edges included', async () => {
    const { store, ledger, issues, service } = await harness(undefined, {
      checkOrderPlane: false,
      isAncestor: async (_issue, ancestor, descendant) =>
        ancestor === 'lower-head' && descendant === 'upper-head',
    })
    try {
      // The upper half of a stack is admitted FIRST; an unrelated order sits
      // between them. FIFO alone would run upper before lower.
      const upper = await seedOrder(issues, store, {
        title: 'upper',
        minute: 1,
        headSha: 'upper-head',
      })
      const unrelated = await seedOrder(issues, store, {
        title: 'unrelated',
        minute: 2,
        baseSha: 'other-base',
      })
      const lower = await seedOrder(issues, store, {
        title: 'lower',
        minute: 3,
        headSha: 'lower-head',
      })
      await publishSeeded(service, ledger)

      // The scheduler's own pass: it records the native-stack edge it infers
      // and schedules over it, exactly as `runTick` does.
      const orders = await service['ordersWithNativeStackEdges']()
      const schedule = shippingSchedule(orders)
      const rank = (id: string) =>
        schedule.entries.find((entry) => entry.order.id === id)?.queueRank
      expect([rank(upper.id), rank(unrelated.id), rank(lower.id)]).toEqual([2, 1, 2])

      const after = await published(ledger)
      expect(after.ranks).toEqual(
        new Map([
          [upper.id, 2],
          [unrelated.id, 1],
          [lower.id, 2],
        ]),
      )
      expect(after.lanes).toEqual([
        {
          id: shipLaneIdOf(upper),
          repoId: upper.repoId,
          destination: 'local:main',
          trains: schedule.trains.map((train) => ({
            orderIds: train.orders.map((order) => order.id),
          })),
          blockedOrderIds: [],
        },
      ])
      expect(after.lanes[0]!.trains).toEqual([
        { orderIds: [unrelated.id] },
        { orderIds: [lower.id, upper.id] },
      ])
    } finally {
      service.dispose()
    }
  })

  it('O2 a commit reads and publishes only the lane it touched', async () => {
    const { store, ledger, issues, service } = await harness(undefined, { checkOrderPlane: false })
    try {
      const first = await seedOrder(issues, store, { title: 'first', minute: 1 })
      const second = await seedOrder(issues, store, {
        title: 'second',
        minute: 2,
        deliveryDependsOn: [asShipOrderId('order-first')],
      })
      const elsewhere = await seedOrder(issues, store, {
        title: 'elsewhere',
        minute: 3,
        repoPath: '/other',
      })
      await publishSeeded(service, ledger)
      const scans = [
        vi.spyOn(store.shipping, 'listOrders'),
        vi.spyOn(store.shipping, 'listHolds'),
        vi.spyOn(store.shipping, 'listReceipts'),
        vi.spyOn(store.shipping, 'listNativeStackEdges'),
      ]
      for (const scan of scans) scan.mockClear()
      const head = await ledger.cursor()
      await service['transition'](first, 'preflight')
      for (const scan of scans) expect(scan).not.toHaveBeenCalled()
      const appended = (await ledger.changesSince(head)) ?? []
      // The lane and the order that moved are logged; the queued order whose
      // record did not change is not, and nothing of the other repo is.
      expect(appended.map((change) => `${change.entity}:${change.id}`).sort()).toEqual(
        [`shipLane:${shipLaneIdOf(first)}`, `shipOrder:${first.id}`].sort(),
      )
      expect(
        (appended.find((change) => change.entity === 'shipLane') as { value?: unknown }).value,
      ).toMatchObject({ trains: [], blockedOrderIds: [second.id] })
      expect(appended.some((change) => change.id === elsewhere.id)).toBe(false)
    } finally {
      service.dispose()
    }
  })

  it('O2 a dependency that ships unblocks its dependent in another lane', async () => {
    const { store, ledger, issues, service } = await harness(provedShippingJob)
    try {
      const issue = await issues.crud.create(issues.reports.store.serverWriter, {
        repoPath: '/repo',
        title: 'dependency',
        startNow: false,
      })
      await issues.crud.update(issues.reports.store.serverWriter, issue.id, { stage: 'review' })
      const dependency = (
        await service.enqueue(laneWriter(service), { issueId: issue.id, ...approval })
      ).order
      const dependent = await seedOrder(issues, store, {
        title: 'dependent',
        minute: 30,
        repoPath: '/other',
        // Based on what the dependency lands, so landing it does not send the
        // dependent back to review as a stale descendant.
        baseSha: dependency.approvedHeadSha,
        deliveryDependsOn: [dependency.id],
      })
      await publishSeeded(service, ledger)
      expect(
        (await published(ledger)).lanes.find((lane) => lane.id === shipLaneIdOf(dependent)),
      ).toMatchObject({
        trains: [],
        blockedOrderIds: [dependent.id],
      })

      await service.runOrder(dependency.id)
      expect((await store.shipping.getOrder(dependency.id))?.state).toBe('shipped')
      const after = await published(ledger)
      expect(after.lanes.find((lane) => lane.id === shipLaneIdOf(dependent))).toMatchObject({
        trains: [{ orderIds: [dependent.id] }],
        blockedOrderIds: [],
      })
      expect(after.ranks.get(dependent.id)).toBe(1)
      // The dependency's own lane emptied, so its row is removed.
      expect(after.lanes.some((lane) => lane.id === shipLaneIdOf(dependency))).toBe(false)
    } finally {
      service.dispose()
    }
  })
})

describe('ship rows are written only inside their commit (ADR 12 D9)', () => {
  it('a ship repository writer without the commit scope, or a ship command without a writer, does not typecheck', () => {
    const typeOnly = async (store: SessionStore, service: ShippingService) => {
      // @ts-expect-error a ship row is written with its commit's scope
      await store.shipping.appendStep({} as never)
      // @ts-expect-error an order transition too
      await store.shipping.transitionOrder('order', 'queued', 'composing', 'now')
      // @ts-expect-error a ship command writes through the writer it is given
      await service.cancel({} as never)
    }
    void typeOnly
  })
})
