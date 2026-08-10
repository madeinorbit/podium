import { asIssueId, FIRST_ADMIN_USER_ID, type SessionId } from '@podium/model'
import { WIRE_VERSION } from '@podium/protocol'
import { startLoopMetrics } from '@podium/runtime/loop-metrics'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../apps/server/src/relay'
import { type IssueRow, SessionStore } from '../apps/server/src/store'

const SESSION_COUNT = 588
const ISSUE_COUNT = 800
const INTERACTION_P95_TARGET_MS = 25
const INTERACTION_P99_TARGET_MS = 50
const LOOP_P99_TARGET_MS = 50
const INTERACTION_CYCLES = 250
const CLIENT_COUNT = 2

function issueRow(seq: number): IssueRow {
  const timestamp = '2026-07-18T00:00:00.000Z'
  return {
    id: asIssueId(`iss_load_${seq}`),
    ownerUserId: FIRST_ADMIN_USER_ID,
    visibility: 'personal',
    createdByActor: FIRST_ADMIN_USER_ID,
    createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
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
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
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
    const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
    const sessionIds: SessionId[] = []
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

      const clients: Array<{
        id: string
        publications: string[]
        allowedSessionIds: SessionId[]
      }> = []
      const sessionsPerWorld = Math.ceil(SESSION_COUNT / 4)
      for (let clientIndex = 0; clientIndex < CLIENT_COUNT; clientIndex += 1) {
        const publications: string[] = []
        // Two live transports for the same scoped operator model concurrent
        // browser tabs and exercise view-key coalescing. Differing-world and
        // revocation correctness is pinned separately in the focused suite.
        const allowedSessionIds = Array.from({ length: sessionsPerWorld }, (_, offset) => {
          const sessionId = sessionIds[offset % SESSION_COUNT]
          if (!sessionId) throw new Error('representative session fixture is empty')
          return sessionId
        })
        const id = registry.clientGateway.attachClient({
          send: (message) => {
            if (message.type === 'feedBootstrap' || message.type === 'feedDelta') {
              publications.push(JSON.stringify(message))
            }
          },
          userId: FIRST_ADMIN_USER_ID,
          userRole: 'admin',
        })
        clients.push({ id, publications, allowedSessionIds })
        registry.clientGateway.routeClientFrame(id, {
          type: 'hello',
          clientId: '',
          viewport: { cols: 80, rows: 24, dpr: 1 },
          wireVersion: WIRE_VERSION,
          caps: ['metadataDelta'],
        })
      }
      await until(() => clients.every((client) => client.publications.length > 0), 15_000)
      // Hello changes the ViewKey after the pre-capability bootstrap has already
      // been queued. Do not let that intentional bootstrap replacement bleed
      // into the measured steady-state window.
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
      for (let cycle = 0; cycle < INTERACTION_CYCLES; cycle += 1) {
        const client = clients[cycle % clients.length]
        if (!client) throw new Error('representative client fixture is empty')
        const targetSession = client.allowedSessionIds[cycle % client.allowedSessionIds.length]
        if (!targetSession) throw new Error('representative scoped world is empty')
        for (const type of ['attach', 'detach'] as const) {
          const publicationBefore = client.publications.length
          const startedAt = performance.now()
          registry.clientGateway.routeClientFrame(client.id, { type, sessionId: targetSession })
          registry.modules.sessions.flushBroadcasts()
          await until(() => client.publications.length > publicationBefore)
          interactionMs.push(performance.now() - startedAt)
        }
        // Representative interaction cadence; do not turn this into a worker
        // throughput benchmark that no human client can generate.
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      const eventLoop = loop.snapshot()
      const perf = registry.modules.perf.snapshot().phases
      expect(percentile(interactionMs, 0.95)).toBeLessThan(INTERACTION_P95_TARGET_MS)
      expect(percentile(interactionMs, 0.99)).toBeLessThan(INTERACTION_P99_TARGET_MS)
      expect(eventLoop.p99, loopWarnings.join('\n')).toBeLessThan(LOOP_P99_TARGET_MS)
      expect(perf['ws.attach']).toMatchObject({ count: INTERACTION_CYCLES })
      expect(perf['ws.detach']).toMatchObject({ count: INTERACTION_CYCLES })
      expect(perf['ws.attach']?.p95Ms).toBeLessThan(INTERACTION_P95_TARGET_MS)
      expect(perf['ws.attach']?.p99Ms).toBeLessThan(INTERACTION_P99_TARGET_MS)
      expect(perf['ws.detach']?.p95Ms).toBeLessThan(INTERACTION_P95_TARGET_MS)
      expect(perf['ws.detach']?.p99Ms).toBeLessThan(INTERACTION_P99_TARGET_MS)
      expect(perf['sessionsBroadcast.total']?.p99Ms).toBeLessThan(LOOP_P99_TARGET_MS)
    } finally {
      loop?.stop()
      registry.dispose()
      store.close()
    }
  }, 60_000)
})
