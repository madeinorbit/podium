import { asIssueId, asMachineId, asSessionId, asUserId, NO_SESSION_USER_STATE, type SessionMeta } from '@podium/model'
import { formatSessionRef } from '@podium/protocol'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Resolve profiling before importing the store/driver instrumentation.
const previousProfile = vi.hoisted(() => {
  const previous = process.env.PODIUM_LOOP_PROFILE
  process.env.PODIUM_LOOP_PROFILE = 'attribution'
  return previous
})
afterAll(() => {
  if (previousProfile === undefined) delete process.env.PODIUM_LOOP_PROFILE
  else process.env.PODIUM_LOOP_PROFILE = previousProfile
})
import { queryAttributionSnapshot, resetQueryAttribution } from '@podium/runtime/sqlite'
import { harnessCapabilitiesFor } from '../../harness-manifest'
import { openTestStore } from '../../test-support/open-test-store'
import { Session } from './session'
import { SessionAuthz } from './session-authz'
import { SessionRepository } from './repository'
import { SessionStateService, type SessionStatePrincipal } from './session-state/service'
import { SessionView } from './view'

const reader = asUserId('projection-reader')
const principal = { userId: reader, capability: { role: 'worker', scope: { kind: 'none' } } } as SessionStatePrincipal
const machineId = asMachineId('projection-machine')

async function fixture(count: number) {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/projection', machineId, undefined, 'PASS')
  await store.issues.upsertIssue({
    id: asIssueId('projection-issue'),
    ownerUserId: reader,
    visibility: 'personal',
    createdByActor: reader,
    createdByOnBehalfOf: reader,
    repoPath: '/projection',
    seq: 1,
    title: 'X',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'dev/mw',
    defaultAgent: 'claude-code',
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
    createdAt: 't',
    updatedAt: 't',
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
  })
  const rows = Array.from({ length: count }, (_, i) => {
    const session = new Session({
      sessionId: asSessionId(`projection-${i}`), durableLabel: `projection-${i}`,
      agentKind: 'claude-code', cwd: `/projection/work-${i}`, title: `Session ${i}`,
      origin: { kind: 'spawn' }, createdAt: '2026-09-10T00:00:00.000Z',
      geometry: { cols: 80, rows: 24 }, machineId, toDaemon: () => {},
      ownerUserId: [1, 3, 4].includes(i % 5) ? asUserId('other') : reader,
    })
    // Unique absent issues exercise negative caching as the corpus grows.
    if (i % 5 === 0) session.issueId = asIssueId(`missing-${i}`)
    if (i % 5 === 1) { session.refIssueId = asIssueId(`missing-ref-${i}`); session.refLetter = 'a' }
    if (i % 5 === 2) session.refDraft = i + 1
    if (i % 5 === 3) { session.issueId = asIssueId('projection-issue'); session.refIssueId = session.issueId; session.refLetter = 'b' }
    return session
  })
  for (const [index, row] of rows.entries()) {
    if (index % 5 === 1) await store.grants.upsert({
      resourceKind: 'session', resourceId: row.sessionId, grantee: reader, verb: 'read',
      owner: 'other', visibility: 'private', createdAt: '2026-09-10T00:00:00.000Z',
      actorKind: 'user', actorId: 'other', onBehalfOf: null,
    })
    await store.sync.enqueueMessage({ id: `queue-${row.sessionId}`, sessionId: row.sessionId, text: 'queued', queuedAt: 1 })
  }
  await store.sessions.markSessionRead(reader, rows[0]!.sessionId, '2026-09-11T00:00:00.000Z')
  await store.sessions.setSnooze(reader, rows[1]!.sessionId, null)
  const sessions = new Map(rows.map(s => [s.sessionId, s]))
  const authz = new SessionAuthz({ sessions, store } as never)
  const state = new SessionStateService({ store, getSession: (id: string) => sessions.get(asSessionId(id)),
    sessionOwner: ({ sessionId, memo }: Parameters<ConstructorParameters<typeof SessionStateService>[0]['sessionOwner']>[0]) => authz.sessionOwner(sessionId, memo),
    primeOwnerMemo: (memo: Parameters<SessionAuthz['primeOwnerMemo']>[0], ids: Parameters<SessionAuthz['primeOwnerMemo']>[1]) => authz.primeOwnerMemo(memo, ids),
  } as never)
  const machines = { factsSnapshot: vi.fn(async () => ({ name: () => 'Build box', loginCondition: () => 'logged-out' as const })),
    machineName: async () => 'Build box', agentLoginCondition: async () => 'logged-out' as const }
  const view = new SessionView({ sessions, store, state, machines: machines as never, sessionOccupancyCount: () => 3 })
  // Broadcast still resolves its default principal exactly once.
  vi.spyOn(view, 'defaultPrincipal').mockResolvedValue(principal)
  return { store, rows, sessions, state, machines, view }
}

/** Frozen pre-pass wire algorithm: the oracle deliberately performs row reads. */
async function legacyWire(s: Session, f: Awaited<ReturnType<typeof fixture>>): Promise<SessionMeta> {
  const overlay = await f.state.overlay(reader, s.sessionId)
  const meta = s.toMeta(overlay ?? NO_SESSION_USER_STATE)
  const queuedMessageCount = (await f.store.sync.queuedMessageCounts(s.sessionId)).get(s.sessionId) ?? 0
  const loginCondition = await f.machines.agentLoginCondition()
  const capabilities = harnessCapabilitiesFor(s.agentKind)
  let displayRef: string | undefined
  if (s.refIssueId && s.refLetter) {
    const issue = await f.store.issues.getIssue(s.refIssueId)
    if (issue) {
      const prefix = await f.store.repos.prefixForPath(issue.repoPath)
      if (prefix) displayRef = formatSessionRef({ prefix, seq: issue.seq, letter: s.refLetter })
    }
  } else if (s.refDraft != null) {
    const prefix = await f.store.repos.prefixForPath(s.cwd)
    if (prefix) displayRef = formatSessionRef({ prefix, draft: s.refDraft })
  }
  return { ...meta, ...(queuedMessageCount > 0 ? { queuedMessageCount } : {}), clientCount: 3,
    machineName: await f.machines.machineName(), ...(loginCondition ? { condition: loginCondition } : {}),
    ...(capabilities ? { harnessHandoff: capabilities.handoff, harnessPromptModeHints: capabilities.promptModeHints } : {}),
    ...(s.refIssueId ? { refIssueId: s.refIssueId } : {}), ...(s.refLetter ? { refLetter: s.refLetter } : {}),
    ...(s.refDraft != null ? { refDraft: s.refDraft } : {}), ...(displayRef ? { displayRef } : {}),
  }
}

function statementCount() {
  return [...queryAttributionSnapshot().values()].reduce((sum, cost) => sum + cost.count, 0)
}

describe('one projection pass', () => {
  it('preserves the old reader-scoped SessionMeta array deeply', async () => {
    const f = await fixture(10)
    try {
      const expected = []
      for (const s of f.rows) if (await f.state.canReadSession(principal, s.sessionId)) expected.push(await legacyWire(s, f))
      expect(await f.view.list(principal, 'rpc')).toEqual(expected)
      expect(expected).toHaveLength(8)
      expect(expected.some(s => s.displayRef)).toBe(true)
      expect(expected.some(s => s.snoozedUntil === null)).toBe(true)
    } finally { await f.store.close() }
  })

  it('has a constant statement budget for 5, 50 and 200 sessions', async () => {
    const counts = []
    for (const size of [5, 50, 200]) {
      const f = await fixture(size)
      try {
        resetQueryAttribution()
        await f.store.sync.queuedMessageCounts(asSessionId('calibration-only'))
        const recordingsPerStatement = statementCount()
        expect([1, 2]).toContain(recordingsPerStatement)
        resetQueryAttribution()
        const start = performance.now()
        const result = await f.view.list(principal, 'rpc')
        counts.push(statementCount() / recordingsPerStatement)
        process.stdout.write(`projection ${size}: ${counts.at(-1)} physical statements, ${(performance.now() - start).toFixed(2)} ms\n`)
        expect(result).toHaveLength(size * 4 / 5)
        expect(f.machines.factsSnapshot).toHaveBeenCalledTimes(1)
      } finally { await f.store.close() }
    }
    // Repo registry is warm from fixture creation. Six physical reads: issues,
    // two grant kinds, queue counts and two overlays. Calibration accounts for
    // POD-3852 double recording, and still works after that fix lands.
    expect(counts[0]).toBe(6)
    expect(counts).toEqual([counts[0], counts[0], counts[0]])
  })

  it('has the same constant read budget for a broadcast slice of 5, 50 and 200 dirty sessions', async () => {
    const counts = []
    for (const size of [5, 50, 200]) {
      const f = await fixture(size)
      const repo = new SessionRepository({ sessions: f.sessions, store: f.store, view: f.view,
        now: () => Date.now(), runScheduledBroadcast: async () => {},
        ledger: { capture: async (specs: { entity: string; id: string; op: string; value: unknown }[]) => specs.map((s, i) => ({ ...s, entityId: s.id, seq: i + 1 })) },
      } as never)
      try {
        for (const s of f.rows) repo.markVolatileSessionDirty(s.sessionId)
        resetQueryAttribution()
        await f.store.sync.queuedMessageCounts(asSessionId('calibration-only'))
        const recordingsPerStatement = statementCount()
        expect([1, 2]).toContain(recordingsPerStatement)
        resetQueryAttribution()
        const start = performance.now()
        const result = await repo.drainVolatileCaptureSlice({ maxItems: size, maxCpuMs: Infinity })
        counts.push(statementCount() / recordingsPerStatement)
        process.stdout.write(`broadcast ${size}: ${counts.at(-1)} physical read statements, ${(performance.now() - start).toFixed(2)} ms\n`)
        expect(result.changes).toHaveLength(size)
        expect(result.remaining).toBe(0)
        expect(f.view.defaultPrincipal).toHaveBeenCalledTimes(1)
        expect(f.machines.factsSnapshot).toHaveBeenCalledTimes(1)
      } finally { await f.store.close() }
    }
    // Repo registry is warm from fixture creation. Six physical reads: issues,
    // two grant kinds, queue counts and two overlays. Calibration accounts for
    // POD-3852 double recording, and still works after that fix lands.
    expect(counts[0]).toBe(6)
    expect(counts).toEqual([counts[0], counts[0], counts[0]])
  })

  it('restricts queue counts to the requested set without a per-id parameter limit', async () => {
    const f = await fixture(5)
    try {
      const ids = [f.rows[0]!.sessionId, ...Array.from({ length: 1200 }, (_, i) => asSessionId(`absent-${i}`))]
      expect(await f.store.sync.queuedMessageCounts(ids)).toEqual(new Map([[f.rows[0]!.sessionId, 1]]))
      expect(await f.store.sync.queuedMessageCounts([])).toEqual(new Map())
    } finally { await f.store.close() }
  })

  it('does no IO once a pass has been built', async () => {
    const f = await fixture(5)
    try {
      const pass = await f.view.buildProjectionPass(f.rows, principal)
      resetQueryAttribution()
      f.rows.map(s => f.view.wire(s, pass))
      expect(statementCount()).toBe(0)
      expect(f.machines.factsSnapshot).toHaveBeenCalledTimes(1)
    } finally { await f.store.close() }
  })
})
