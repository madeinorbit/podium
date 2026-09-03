import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  asMachineId,
  asShipAttemptId,
  FIRST_ADMIN_USER_ID,
  type IssueWire,
  type MachineId,
} from '@podium/model'
import { shippingJobRequestFingerprint, type ControlMessage } from '@podium/protocol/daemon'
import { normalizeSettings } from '@podium/runtime'
import { Ledger } from '@podium/sync'
import { DaemonRpcService } from '../../../../server/src/modules/machines/rpc'
import { IssueService } from '../../../../server/src/modules/issues/service'
import {
  CompatibilityShippingPolicyResolver,
  ShippingService,
  type ShippingEvidencePort,
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
const issues = IssueService.create({
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

const daemonWorker = new URL('./daemon-rpc-worker.ts', import.meta.url).pathname
const git = (...argv: string[]): string =>
  execFileSync('git', ['-C', repoPath, ...argv], { encoding: 'utf8' }).trim()
const daemon = spawn(
  'bun',
  ['--conditions=@podium/source', daemonWorker, daemonJournal, machineId],
  { stdio: ['pipe', 'pipe', 'inherit'] },
)
const rpc = new DaemonRpcService({
  toMachine: (_target: MachineId, message: ControlMessage) =>
    daemon.stdin.write(`${JSON.stringify(message)}\n`),
  defaultMachine: () => machineId,
} as never)
const replies = createInterface({ input: daemon.stdout, crlfDelay: Number.POSITIVE_INFINITY })
replies.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'shippingJobResult') rpc.settleDaemonReply(machineId, message)
})

const issuePort = {
  get(id: string): IssueWire {
    const issue = issues.get(id)
    if (!issue) throw new Error(`unknown issue ${id}`)
    return issue
  },
  children: (id: string, recursive?: boolean) => issues.children(id, recursive),
  shippingCommit: issues.shippingCommit.bind(issues),
  shippingCommitMany: issues.shippingCommitMany.bind(issues),
}
const compatibilityPolicy = new CompatibilityShippingPolicyResolver(() => 'main')
const recoveryPolicy = {
  resolve: (issue: IssueWire) => ({
    ...compatibilityPolicy.resolve(issue),
    validationProfileId: 'recovery-proof',
    validationProfile: {
      id: 'recovery-proof',
      argv: ['git', 'diff', '--quiet'],
      cwd: 'integration-root' as const,
      timeoutMs: 30_000,
      resourceLocks: [],
    },
  }),
}
const evidence: ShippingEvidencePort = {
  rootIntegrationReceipt: (rootIssueId, approvedHeadSha) =>
    store.shipping.rootIntegrationReceipt(rootIssueId, approvedHeadSha),
  // The compatibility recovery fixture has no accepted-review repository.
  acceptedReviewEvidence: () => null,
}
const service = new ShippingService({
  repository: store.shipping,
  issues: issuePort,
  ledger,
  daemon: rpc,
  authorization: {
    attribution: () => ({
      actor: { kind: 'user', id: FIRST_ADMIN_USER_ID },
      onBehalfOf: FIRST_ADMIN_USER_ID,
    }),
    authorize: () => {},
    reauthorize: () => {},
  },
  evidence,
  policy: recoveryPolicy,
  machineFor: () => machineId,
  resolveBranchTip: async (issue) => git('rev-parse', `refs/heads/${issue.branch}`),
  resolveRefTip: async (_issue, ref) => git('rev-parse', `refs/heads/${ref}`),
  isAncestor: async (_issue, ancestorSha, descendantSha) => {
    try {
      git('merge-base', '--is-ancestor', ancestorSha, descendantSha)
      return true
    } catch {
      return false
    }
  },
  ...(phase === 'crash'
    ? {
        beforeCompletionCommit: () => {
          writeSync(process.stdout.fd, 'completion-boundary\n')
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
  issues.update(created.id, { stage: 'review', machineId })
  const head = git('rev-parse', started.branch)
  store.shipping.recordRootIntegrationReceipt({
    rootIssueId: created.id,
    approvedHeadSha: head,
    descendants: [],
  })
  const { order } = await service.enqueueCurrent({
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
    overrideScope: false,
  })
  await service.runOrder(order.id)
  throw new Error('crash hook did not terminate the process')
}

await service.reconcile()
const order = store.shipping.listOrders()[0]
if (!order) throw new Error('recovery database has no order')
const issue = issuePort.get(order.issueId)
const staleFacts = {
  jobId: `attempt:${order.id}:0:verify`,
  orderId: order.id,
  attemptId: asShipAttemptId(`attempt:${order.id}:0`),
  generation: 0,
  operation: 'verify' as const,
  shippingProtocolVersion: 2 as const,
  repoPath,
  repoId: order.repoId,
  sourceBranch: issue.branch!,
  targetBranch: order.targetBranch,
  approvedBaseSha: order.approvedBaseSha,
  approvedHeadSha: order.approvedHeadSha,
  expectedTargetSha: order.approvedBaseSha,
  destination: order.destination,
  policyId: order.policyId,
  validationProfile: recoveryPolicy.resolve(issue).validationProfile,
}
const staleGeneration = await rpc.shippingJob(
  {
    action: 'status',
    ...staleFacts,
    requestDigest: createHash('sha256')
      .update(shippingJobRequestFingerprint(staleFacts))
      .digest('hex'),
  },
  machineId,
)
process.stdout.write(
  `${JSON.stringify({
    orderState: order.state,
    issueStage: store.issues.getIssue(order.issueId)?.stage,
    attempt: store.shipping.latestAttemptForOrder(order.id),
    receipt: store.shipping.receiptForOrder(order.id),
    staleGeneration,
  })}\n`,
)
service.dispose()
store.close()
daemon.stdin.end()
await once(daemon, 'close')
