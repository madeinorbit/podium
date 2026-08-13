import { execFileSync } from 'node:child_process'
import { asMachineId, FIRST_ADMIN_USER_ID, type IssueWire } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { IssueService } from '../../../../server/src/modules/issues/service'
import {
  CompatibilityShippingPolicyResolver,
  ShippingService,
} from '../../../../server/src/modules/shipping'
import { SessionStore } from '../../../../server/src/store'

const [phase, dbPath, repoPath, daemonJournal] = process.argv.slice(2)
if (!phase || !dbPath || !repoPath || !daemonJournal) throw new Error('missing recovery arguments')
const machineId = asMachineId('shipping-recovery-machine')
const store = new SessionStore(dbPath, machineId)
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
  spawnSession: () => ({ sessionId: 'recovery-session' as never, machine: machineId }),
  repoOp: async () => ({ ok: true, output: '' }),
  funnel: { run: (op) => op.write() },
  ledger,
  publishSpecs: {
    issueUpdated: (issue) => ({ rows: [{ id: issue.id, value: issue }] }),
    issuesChanged: (rows) => ({ rows: rows.map((issue) => ({ id: issue.id, value: issue })) }),
  },
})
issues.boot()

const daemonWorker = new URL('./execution-worker.ts', import.meta.url).pathname
const git = (...argv: string[]): string =>
  execFileSync('git', ['-C', repoPath, ...argv], { encoding: 'utf8' }).trim()
const shippingJob: ConstructorParameters<typeof ShippingService>[0]['daemon']['shippingJob'] =
  async (input) => {
    const request = { type: 'shippingJobRequest', requestId: 'process-rpc', ...input }
    const output = execFileSync(
      'bun',
      [
        '--conditions=@podium/source',
        daemonWorker,
        daemonJournal,
        machineId,
        Buffer.from(JSON.stringify(request)).toString('base64url'),
      ],
      { encoding: 'utf8' },
    )
    return JSON.parse(output)
  }

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
  authorization: {
    attribution: () => ({
      actor: { kind: 'user', id: FIRST_ADMIN_USER_ID },
      onBehalfOf: FIRST_ADMIN_USER_ID,
    }),
    authorize: () => {},
    reauthorize: () => {},
  },
  evidence: {
    resolveIntegrationReceipt: () => null,
    persistAccepted: ({ order, evidenceManifestRef }) => {
      store.events.appendEvent({
        ts: new Date().toISOString(),
        kind: 'shipping.evidence_accepted',
        subject: order.id,
        payload: { evidenceManifestRef: evidenceManifestRef ?? null },
      })
    },
  },
  policy: new CompatibilityShippingPolicyResolver(() => 'main'),
  machineFor: () => machineId,
  resolveBranchTip: async (issue) => git('rev-parse', `refs/heads/${issue.branch}`),
  resolveRefTip: async (_issue, ref) => git('rev-parse', `refs/heads/${ref}`),
  ...(phase === 'crash'
    ? {
        beforeCompletionCommit: () => {
          process.stdout.write('completion-boundary\n')
          process.kill(process.pid, 'SIGKILL')
        },
      }
    : {}),
  background: false,
})

if (phase === 'crash') {
  const created = issues.create({ repoPath, title: 'process recovery', startNow: false })
  const started = await issues.start(created.id)
  if (!started.branch) throw new Error('started recovery issue has no branch')
  git('branch', started.branch, 'main')
  issues.update(created.id, { stage: 'review' })
  const head = git('rev-parse', started.branch)
  const { order } = await service.enqueue({
    issueId: created.id,
    principal: {
      kind: 'user',
      user: FIRST_ADMIN_USER_ID,
      capability: {
        role: 'admin',
        scope: { kind: 'all' },
        actorUser: FIRST_ADMIN_USER_ID,
        onBehalfOf: FIRST_ADMIN_USER_ID,
      },
    },
    requestedBy: {
      actor: { kind: 'user', id: FIRST_ADMIN_USER_ID },
      onBehalfOf: FIRST_ADMIN_USER_ID,
    },
    overrideScope: false,
    approved: {
      sourceBaseSha: head,
      sourceHeadSha: head,
      policyId: 'compatibility-local:main',
      previewLeaseIds: [],
    },
  })
  await service.runOrder(order.id)
  throw new Error('crash hook did not terminate the process')
}

await service.reconcile()
const order = store.shipping.listOrders()[0]
if (!order) throw new Error('recovery database has no order')
process.stdout.write(
  `${JSON.stringify({
    orderState: order.state,
    issueStage: store.issues.getIssue(order.issueId)?.stage,
    attempt: store.shipping.latestAttemptForOrder(order.id),
    receipt: store.shipping.receiptForOrder(order.id),
  })}\n`,
)
service.dispose()
store.close()
