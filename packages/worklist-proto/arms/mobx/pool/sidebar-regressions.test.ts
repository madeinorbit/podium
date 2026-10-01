/** Small synthetic reductions of POD-5056–POD-5060. No operator records. */
import type { PodiumClientApi } from '@podium/client-core/api'
import { createClientRuntime, dedupeSessions } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { SocketHub } from '@podium/client-core/socket-transport'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createWorklistPool } from '@podium/client-graph/create'
import { checkSidebar, poolSidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { legacyDerivationFromStore, visibleIssueRows } from '@podium/client-graph/diagnostics/legacy'
import { legacySidebarRow } from '@podium/client-graph/diagnostics/oracle'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asUserId, type GitRepositoryWire, type IssueProjection, type IssueWire, type SessionMeta } from '@podium/model'
import { reaction, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { corpusFromLive, type LiveCollections } from '../../../harness/src/fixture/live-snapshot'
import { sidebarReplayStore } from '../../../harness/src/oracle/sidebar-replay'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { seedCacheFromCorpus } from '../../../shared/src/scenarios'

installMobxWarnTrap()
const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const STAMP = new Date(NOW - 60_000).toISOString()
const ROOT = '/synthetic/repo'
const REPO = { path: ROOT, repoId: 'synthetic-repo', name: 'Synthetic project', worktrees: [] } as unknown as GitRepositoryWire

function issue(id: string, patch: Partial<IssueWire> = {}): IssueWire {
  return { id, seq: 1, title: 'Synthetic task', stage: 'in_progress', audience: 'human',
    repoId: 'synthetic-repo', repoPath: ROOT, worktreePath: ROOT, parentId: null,
    archived: false, deletedAt: null, closedReason: null, closedAt: null,
    pinned: false, draft: false, origin: 'human', needsHuman: false, deps: [],
    createdAt: STAMP, updatedAt: STAMP, readAt: STAMP, ...patch } as unknown as IssueWire
}
function session(sessionId: string, owner: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return { sessionId, issueId: owner, cwd: ROOT, title: 'Synthetic agent', agentKind: 'codex',
    status: 'hibernated', archived: false, lastActiveAt: STAMP, createdAt: STAMP,
    readAt: STAMP, unread: false, agentState: { phase: 'idle', since: STAMP }, ...patch } as unknown as SessionMeta
}
function collections(issues: IssueWire[], sessions: SessionMeta[] = [], repos = [REPO]): LiveCollections {
  return { issues, sessions, repos, machines: [],
    issueDeps: issues.flatMap(row => (row.deps ?? []).map((edge, index) => ({ id: `synthetic-dep-${row.id}-${index}`, fromId: row.id, toId: edge.id, type: edge.type } as LiveCollections['issueDeps'][number]))),
    issueProjections: issues.map(row => ({ ...row, description: { value: '', revision: 0 }, isDraftVessel: row.draft ?? false, intentOrigin: 'human' }) as unknown as IssueProjection),
    repoProjections: [{ id: 'synthetic-repo', prefix: 'SYN' } as LiveCollections['repoProjections'][number]],
    pins: { repos: [], worktrees: [], panels: [] } }
}
/** Same app-owned replica/row-source seam as offline replay, with tiny inputs.
 * Keep observed payloads alive across publications to catch stale derivations. */
function replay(data: LiveCollections) {
  const corpus = corpusFromLive(data, NOW)
  const cache = seedCacheFromCorpus(corpus)
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const store = sidebarReplayStore(corpus, replica)
  const runtime = { getSnapshot: () => store, subscribe: () => () => {}, pendingOverlaysByRow: () => new Map() }
  const rows = createRowSource(runtime, replica, { mode: 'overlaid' })
  const locals = createEngineLocals(runtime)
  const handle = createWorklistPool(rows.source, locals.source)
  const stop = reaction(() => poolSidebarSnapshot(handle.pool), () => {}, { fireImmediately: true })
  const settle = () => {
    for (let round = 0; round < 64; round += 1) {
      runInAction(() => poolSidebarSnapshot(handle.pool))
      if (handle.pool.hydrate() === 0) return
    }
    throw new Error('Synthetic sidebar did not settle')
  }
  settle()
  return {
    pool: handle.pool,
    check: () => runInAction(() => checkSidebar(handle.pool, store)),
    row: (id: string) => runInAction(() => {
      const actual = handle.pool.sidebar.row(id)
      if (actual === undefined || actual === LOADING) throw new Error('Synthetic row absent/loading')
      const derivation = legacyDerivationFromStore(store, NOW)
      const legacy = visibleIssueRows(derivation, { coarseNow: NOW, selectedIssueId: null }).find(row => row.issue.id === id)
      if (!legacy) throw new Error('Synthetic legacy row absent')
      return { actual, expected: legacySidebarRow(legacy, derivation, NOW) }
    }),
    runtimeRow: (id: string) => {
      // Use the real hydrate-first legacy runtime, without starting any I/O.
      const app = createClientRuntime({
        principal: asClientPrincipal(asUserId('synthetic-operator')),
        config: { httpOrigin: 'http://synthetic.invalid', wsClientUrl: 'ws://synthetic.invalid' },
        api: {} as PodiumClientApi, onFatalError: () => {}, networkEnabled: false,
        createReplicaFn: () => replica, routerWindow: createMemoryRouterWindow(),
        createHub: () => ({ dispose: () => {} }) as unknown as SocketHub,
        coarseClock: { now: () => NOW, subscribe: () => () => {} },
      })
      try {
        const derivation = legacyDerivationFromStore(app.getSnapshot(), NOW)
        const row = visibleIssueRows(derivation, { coarseNow: NOW, selectedIssueId: null }).find(row => row.issue.id === id)
        if (!row) throw new Error('Synthetic runtime row absent')
        return legacySidebarRow(row, derivation, NOW)
      } finally { app.destroy() }
    },
    updateSession: (row: SessionMeta) => {
      cache.put('session', row.sessionId, row)
      replica.onKernelEvent({ type: 'upserted', record: { entity: 'session', entityId: row.sessionId, value: row, provenance: { seq: 1 } }, readmitted: false })
      store.sessions = dedupeSessions(replica.rows('sessions') as SessionMeta[])
      rows.flush(); settle()
    },
    dispose: () => { stop(); handle.dispose(); locals.dispose(); rows.dispose() },
  }
}

describe('POD-5056 fleet resume-twin ties', () => {
  it.each([true, false])('uses the runtime replica order on an exact tie (export head archived=%s)', archived => {
    const task = issue('iss_synthetic_fleet')
    const resume = { kind: 'codex-thread', value: 'synthetic-twin' } as SessionMeta['resume']
    const earlier = session('z-earlier', task.id, { resume, archived })
    const later = session('a-later', task.id, { resume, archived: !archived })
    const ctx = replay(collections([task], [earlier, later]))
    try {
      const { actual, expected } = ctx.row(task.id)
      const runtimeRow = ctx.runtimeRow(task.id)
      expect(expected.fleet).toEqual(runtimeRow.fleet)
      expect(expected.timing).toEqual(runtimeRow.timing)
      expect(actual.fleet.total).toBe(archived ? 1 : 0)
      expect(ctx.check().first).toBeNull()
      expect(ctx.check().pending).toBe(0)
      // An active twin keeps every Podium identity, regardless of tie order.
      ctx.updateSession({ ...later, status: 'live' })
      expect(ctx.check().first).toBeNull()
      expect(ctx.check().pending).toBe(0)
      ctx.updateSession(later)
      expect(ctx.row(task.id).actual.fleet.total).toBe(archived ? 1 : 0)
      expect(ctx.check().first).toBeNull()
      expect(ctx.check().pending).toBe(0)
    } finally { ctx.dispose() }
  })
  it('keeps the runtime winner when a twin joins an existing group', () => {
    const task = issue('iss_synthetic_fleet_join')
    const resume = { kind: 'codex-thread', value: 'synthetic-join' } as SessionMeta['resume']
    const earlier = session('z-earlier', task.id, { archived: true })
    const later = session('a-later', task.id, { resume })
    const ctx = replay(collections([task], [earlier, later]))
    try {
      ctx.updateSession({ ...earlier, resume })
      expect(ctx.row(task.id).actual.fleet.total).toBe(1)
      expect(ctx.check().first).toBeNull()
      expect(ctx.check().pending).toBe(0)
    } finally { ctx.dispose() }
  })
})


describe('POD-5057 timing after cross-owner resume collapse', () => {
  it('uses the retained session anchor instead of a false sessionless review anchor', () => {
    const task = issue('iss_synthetic_timer', { stage: 'review' })
    const other = issue('iss_synthetic_timer_other', { seq: 2 })
    const since = new Date(NOW - 3_600_000).toISOString()
    const resume = { kind: 'codex-thread', value: 'synthetic-timer-twin' } as SessionMeta['resume']
    const mine = session('a-timer', task.id, { resume, agentState: { phase: 'needs_user', since } as SessionMeta['agentState'] })
    const theirs = session('z-timer', other.id, { resume, agentState: mine.agentState })
    const ctx = replay(collections([task, other], [theirs, mine]))
    try {
      const { actual, expected } = ctx.row(task.id)
      expect(expected.timing).toEqual({ phase: 'waiting', sinceMs: Date.parse(since) })
      expect(actual.timing).toEqual(expected.timing)
      expect(ctx.check().first).toBeNull()
    } finally { ctx.dispose() }
  })
  it('preserves the zero session anchor of a completed sessionless row', () => {
    const task = issue('iss_synthetic_done_timer', { stage: 'done', closedReason: 'done', closedAt: STAMP })
    const ctx = replay(collections([task]))
    try {
      const { actual, expected } = ctx.row(task.id)
      expect(expected.timing).toEqual({ phase: 'done', sinceMs: 0 })
      expect(actual.timing).toEqual(expected.timing)
      expect(ctx.check().first).toBeNull()
    } finally { ctx.dispose() }
  })
})


describe('POD-5058 staffed continuation preference', () => {
  it.each([
    { nested: false, staffed: true, ref: 'SYN-2' }, { nested: true, staffed: true, ref: 'SYN-2' },
    { nested: false, staffed: false, ref: 'SYN-3' }, { nested: true, staffed: false, ref: 'SYN-3' },
  ])('preserves tip preference (nested=$nested, staffed=$staffed)', ({ nested, staffed, ref }) => {
    const origin = issue('iss_synthetic_origin', { stage: 'review' })
    const middle = issue('iss_synthetic_tip_middle', { seq: 4, stage: 'done', closedReason: 'done',
      deps: [{ id: origin.id, type: 'discovered-from' }] as IssueWire['deps'] })
    const newerAt = new Date(NOW - 120_000).toISOString()
    const olderAt = new Date(NOW - 600_000).toISOString()
    const newer = issue('iss_synthetic_tip_newer', { seq: 2, stage: 'done', closedReason: 'done', closedAt: newerAt, updatedAt: newerAt,
      deps: [{ id: nested ? middle.id : origin.id, type: 'discovered-from' }] as IssueWire['deps'] })
    const older = issue('iss_synthetic_tip_older', { seq: 3, updatedAt: olderAt,
      deps: [{ id: origin.id, type: 'discovered-from' }] as IssueWire['deps'] })
    const ctx = replay(collections([origin, older, newer, ...(nested ? [middle] : [])], staffed ? [
      session('newer-tip-seat', newer.id, { lastActiveAt: newerAt }),
      session('older-tip-seat', older.id, { lastActiveAt: olderAt }),
    ] : []))
    try {
      const { actual, expected } = ctx.row(origin.id)
      expect(expected.continuation).toEqual({ kind: 'continued', ref })
      expect(actual.continuation).toEqual(expected.continuation)
      expect(ctx.check().first).toBeNull()
    } finally { ctx.dispose() }
  })
})
