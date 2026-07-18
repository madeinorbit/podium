import { startLoopMetrics } from '@podium/runtime/loop-metrics'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../apps/server/src/relay'
import { SessionStore, type IssueRow } from '../apps/server/src/store'

const SESSION_COUNT = 588
const ISSUE_COUNT = 800
const INTERACTION_P95_TARGET_MS = 25
const INTERACTION_P99_TARGET_MS = 50
const LOOP_P99_TARGET_MS = 50

function issueRow(seq: number): IssueRow {
  const timestamp = '2026-07-18T00:00:00.000Z'
  return {
    id: `iss_load_${seq}`,
    repoPath: '/representative-load',
    seq,
    title: `Representative issue ${seq}`,
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'shell',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    design: null,
    acceptance: null,
    notes: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    supersededBy: null,
    duplicateOf: null,
    pinned: false,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
  }
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))
  return sorted[index] ?? 0
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for publication')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('loop split representative load [spec:SP-c29e]', () => {
  it('holds publication interaction and event-loop targets at 588 sessions / 800 issues', async () => {
    const store = new SessionStore(':memory:')
    store.transact(() => {
      for (let seq = 1; seq <= ISSUE_COUNT; seq += 1) store.issues.upsertIssue(issueRow(seq))
    })
    const registry = new SessionRegistry(store)
    const sessionIds: string[] = []
    let loop: ReturnType<typeof startLoopMetrics> | undefined
    try {
      for (let index = 0; index < SESSION_COUNT; index += 1) {
        sessionIds.push(
          registry.modules.sessions.createSession({
            agentKind: 'shell',
            cwd: `/representative-load/session-${index}`,
          }).sessionId,
        )
      }
      registry.modules.sessions.flushBroadcasts()
      expect(registry.modules.sessions.listSessions()).toHaveLength(SESSION_COUNT)
      expect(registry.modules.issues.list()).toHaveLength(ISSUE_COUNT)

      const publications: string[] = []
      const clientId = registry.modules.sessions.attachClient(() => {}, {
        sendPrepared: (bytes) => publications.push(bytes),
        principal: 'load-operator',
        scope: 'all',
        serverRole: 'standalone',
        protocolVersion: 1,
        global: true,
        snapshot: () => ({
          revision: 0,
          allowedSignature: 'global',
          allowedSessionIds: [],
        }),
      })
      registry.modules.sessions.onClientMessage(clientId, {
        type: 'hello',
        clientId: '',
        viewport: { cols: 80, rows: 24, dpr: 1 },
        caps: ['metadataDelta'],
      })
      await until(() => publications.length > 0)
      // Hello changes the ViewKey after the pre-capability bootstrap has already
      // been queued. Do not let that intentional bootstrap replacement bleed
      // into the measured steady-state window.
      await until(() => registry.modules.sessions.publicationMetrics().queueDepth === 0)
      await new Promise((resolve) => setTimeout(resolve, 250))

      registry.modules.perf.reset()
      const loopWarnings: string[] = []
      loop = startLoopMetrics({
        label: 'loop-split-acceptance',
        longTickMs: LOOP_P99_TARGET_MS,
        sampleMs: 50,
        log: (message) => loopWarnings.push(message),
      })
      await new Promise((resolve) => setTimeout(resolve, 25))

      const interactionMs: number[] = []
      const targetSession = sessionIds[0]
      if (!targetSession) throw new Error('representative session fixture is empty')
      for (let cycle = 0; cycle < 100; cycle += 1) {
        for (const type of ['attach', 'detach'] as const) {
          const publicationBefore = publications.length
          const startedAt = performance.now()
          registry.modules.sessions.onClientMessage(clientId, { type, sessionId: targetSession })
          registry.modules.sessions.flushBroadcasts()
          await until(() => publications.length > publicationBefore)
          interactionMs.push(performance.now() - startedAt)
        }
        // Representative interaction cadence; do not turn this into a worker
        // throughput benchmark that no human client can generate.
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await new Promise((resolve) => setTimeout(resolve, 25))

      const eventLoop = loop.snapshot()
      const perf = registry.modules.perf.snapshot().phases
      const worker = registry.modules.sessions.publicationMetrics()
      expect(percentile(interactionMs, 0.95)).toBeLessThan(INTERACTION_P95_TARGET_MS)
      expect(percentile(interactionMs, 0.99)).toBeLessThan(INTERACTION_P99_TARGET_MS)
      expect(loopWarnings.length).toBeLessThanOrEqual(2)
      expect(eventLoop.p99).toBeLessThan(LOOP_P99_TARGET_MS)
      expect(perf['ws.attach']).toMatchObject({ count: 100 })
      expect(perf['ws.detach']).toMatchObject({ count: 100 })
      expect(perf['ws.attach']?.p95Ms).toBeLessThan(INTERACTION_P95_TARGET_MS)
      expect(perf['ws.attach']?.p99Ms).toBeLessThan(INTERACTION_P99_TARGET_MS)
      expect(perf['ws.detach']?.p95Ms).toBeLessThan(INTERACTION_P95_TARGET_MS)
      expect(perf['ws.detach']?.p99Ms).toBeLessThan(INTERACTION_P99_TARGET_MS)
      expect(perf['sessionsBroadcast.total']?.p99Ms).toBeLessThan(LOOP_P99_TARGET_MS)
      expect(worker).toMatchObject({
        queueDepth: 0,
        failures: 0,
        shadowComparisons: 0,
        shadowMismatches: 0,
      })
      expect(worker.completedJobs).toBeGreaterThan(0)
      expect(worker.coalescedJobs).toBeGreaterThanOrEqual(0)
      expect(worker.supersededJobs).toBeGreaterThanOrEqual(0)
      expect(worker.maxUninterruptedSliceMs).toBeLessThan(LOOP_P99_TARGET_MS)
      expect(worker.maxJobAgeMs).toBeGreaterThanOrEqual(0)
    } finally {
      loop?.stop()
      registry.dispose()
      store.close()
    }
  }, 60_000)
})
