import type { ClientRuntime } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import type { MachineWire } from '@podium/model/browser'
import { autorun, observable, runInAction } from 'mobx'
import { beforeAll, expect, it, vi } from 'vitest'
import type { ReferenceState as Store } from '../../../tests/worklist/diagnostics/reference-state'
import { checkSessionPanes } from '../../../tests/worklist/diagnostics/session-pane-check'
import { SESSION_PANE_NOW, sessionPaneFixture } from '../../../tests/worklist/diagnostics/session-pane-fixture'
import { headerEntities } from './header-entities'
import { liveFixture, seedFixtureMachines } from './live-fixture'
import { omitGone } from './lookup'
import { loadSyncedModels } from './models'
import { MobxPool } from './pool'
import { paneSession, paneSpawnConfirmed, paneWindow } from './session-pane'
import { SESSION_PANE_ENTITIES, SESSION_PANE_SUMMARIES } from './session-pane-schema'
import { SessionPaneSource } from './session-pane-source'
import { sessionPaneView } from './session-pane-view'
import { LOADING } from './worklist/rollup'


// The pane's machines are machine models (POD-6644): load their classes first.
beforeAll(() => loadSyncedModels())

function fixture(attachLog = true) {
  const sessions = sessionPaneFixture()
  const machines = [{ id: 'machine-a', name: 'Host', online: true }, { id: 'machine-b', name: 'Offline host', online: false, loggedOutHarnesses: ['codex'] }] as MachineWire[]
  let state = { sessions, machines, panelMode: { 'pane-0': 'chat' }, dockShells: { '/synthetic/w19': 'pane-19' },
    coarseNow: SESSION_PANE_NOW, selectedIssueId: null } as unknown as Store
  const listeners = new Set<() => void>()
  const runtime = withKeyedInputs({ getSnapshot: () => state, subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } } }) as unknown as ClientRuntime
  const load = vi.fn((_entity: string, id: string) => sessions.find(row => row.sessionId === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW }, undefined,
    { summaries: SESSION_PANE_SUMMARIES, load: load as never, schedule: () => () => {} })
  const spawnPrompts = observable.map<string, string | null>([['pane-11', null]])
  if (attachLog) pool.attachTransactions({ mutate: vi.fn(), spawnPrompts } as never)
  pool.apply({ type: 'replace', rows: sessions.map(row => ({ kind: 'session' as const, id: row.sessionId, value: row as never })) })
  // Machine records, online on the LiveStore (POD-6644).
  headerEntities(pool).apply(seedFixtureMachines(pool, machines) as never)
  headerEntities(pool).order('machine', machines.map(row => row.id))
  pool.sources.view('test.paneFixture.ui', () => ({ dispose: () => runtime.ui.dispose() }))
  pool.sources.register(SESSION_PANE_ENTITIES, new SessionPaneSource(runtime))
  return { sessions, machines, pool, load, listeners, spawnPrompts,
    state: () => state, change(patch: Partial<Store>) { state = { ...state, ...patch }; for (const f of listeners) f() },
    settle() { checkSessionPanes(pool, state); pool.hydrate(); return checkSessionPanes(pool, state) },
  }
}


it('follows a panel-mode change through the keyed locals (POD-5433)', () => {
  const f = fixture()
  try {
    f.change({ panelMode: { 'pane-0': 'native' } } as never)
    const window = omitGone(f.pool.row('sessionPaneWindow', 'window')) as { panelMode: Record<string, string> }
    expect(window.panelMode).toEqual({ 'pane-0': 'native' })
  } finally { f.pool.dispose() }
})

it('matches all pane status, urgency, header, recovery and control inputs over the synthetic corpus', () => {
  const f = fixture()
  try {
    expect(f.settle()).toMatchObject({ differences: 0, pending: 0, first: null, positions: f.sessions.length + f.machines.length })
    const id = f.sessions[1]!.sessionId
    const next = { ...f.sessions[1]!, status: 'hibernated' as const, queuedMessageCount: 3 }
    f.sessions[1] = next
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: next as never }] })
    expect(f.settle().differences).toBe(0)
    f.change({ panelMode: { [id]: 'native' } })
    runInAction(() => f.spawnPrompts.clear())
    expect(paneSpawnConfirmed(f.pool, id)).toBe(true)
    expect(f.settle()).toMatchObject({ differences: 0, pending: 0 })
  } finally { f.pool.dispose() }
})

it('reports a wrong status, model, queued wake, host and mode by position without disclosing their values', () => {
  const f = fixture()
  try {
    f.settle()
    const row = f.sessions[0]!
    for (const patch of [{ status: 'exited' }, { requestedModel: 'wrong-model' }, { queuedMessageCount: 99 }]) {
      f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: row.sessionId, value: { ...row, ...patch } as never }] })
      const result = checkSessionPanes(f.pool, f.state())
      expect(result.differences).toBeGreaterThan(0)
      expect(result.first?.index).toBe(0)
      expect(JSON.stringify(result)).not.toContain('wrong-model')
    }
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: row.sessionId, value: row as never }] })
    // A machine going offline is its live condition (POD-6644).
    liveFixture(f.pool).online('machine-a', false)
    expect(checkSessionPanes(f.pool, f.state()).first?.section).toBe(2)
    liveFixture(f.pool).online('machine-a', true)
    const changed = { ...f.state(), panelMode: { [row.sessionId]: 'native' as const } }
    expect(checkSessionPanes(f.pool, changed).first?.section).toBe(1)
  } finally { f.pool.dispose() }
})

it('loads cold pane detail through one batched reader, with no full payload retained in its summary', () => {
  const f = fixture()
  try {
    const cold = f.sessions.at(-1)!
    expect(f.pool.tables.session.has(cold.sessionId)).toBe(false)
    expect(paneSession(f.pool, cold.sessionId)).toBe(LOADING)
    expect(paneSession(f.pool, cold.sessionId)).toBe(LOADING)
    expect(f.load).not.toHaveBeenCalled()
    expect(omitGone(f.pool.row('session', cold.sessionId, 'summary'))).not.toHaveProperty('configureFields')
    expect(f.pool.hydrate()).toBe(1)
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(paneSession(f.pool, cold.sessionId)).toEqual(cold)
  } finally { f.pool.dispose() }
})

it('isolates addressed pane updates and releases the control source with its pool', () => {
  const f = fixture()
  try {
    const id = f.sessions[0]!.sessionId
    const read = vi.fn(() => paneSession(f.pool, id))
    const stop = autorun(read)
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'pane-1', value: { ...f.sessions[1]!, title: 'Changed elsewhere' } as never }] })
    expect(read).toHaveBeenCalledTimes(1)
    f.change({ panelMode: { [id]: 'native' } })
    expect(paneWindow(f.pool)).toMatchObject({ panelMode: { [id]: 'native' } })
    expect(read).toHaveBeenCalledTimes(1)
    stop()
    f.pool.dispose()
    expect(f.listeners.size).toBe(0)
    expect(omitGone(f.pool.row('sessionPaneWindow', 'window'))).toBe(LOADING)
  } finally { f.pool.dispose() }
})

/** The pane's stamp for this session row, through its shared session. */
function paneStampIssue(pool: MobxPool, session: SessionView) {
  pool.apply({ type: 'update', rows: [{ kind: 'session', id: session.sessionId, value: session as never }] })
  return sessionPaneView(pool).loaded(session.sessionId)?.stampIssue
}
function issue(id: string, path: string | null, patch: Record<string, unknown> = {}) {
  return { id, seq: 1, title: id, stage: 'in_progress', repoPath: '/synthetic', deps: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', archived: false, worktreePath: path, ...patch }
}
it('chooses the explicit eligible attachment even when a containing checkout appears first', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW })
  try {
    pool.apply({ type: 'replace', rows: [issue('outer', '/synthetic'), issue('attached', '/elsewhere')].map(row => ({ kind: 'issue', id: row.id, value: row as never })) })
    const session = { ...sessionPaneFixture()[0]!, issueId: 'attached', cwd: '/synthetic/nested/file' } as SessionView
    expect(paneStampIssue(pool, session)).toMatchObject({ id: 'attached' })
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'attached', value: issue('attached', '/elsewhere', { archived: true }) as never }] })
    expect(paneStampIssue(pool, session)).toMatchObject({ id: 'outer' })
  } finally { pool.dispose() }
})
it('chooses the nearest eligible cwd ancestor at exact slash boundaries, including a missing scanned lane', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW })
  try {
    const rows = [issue('outer', '/synthetic'), issue('inner', '/synthetic/nested'), issue('deleted', '/synthetic/nested/file', { deletedAt: '2026-10-01T00:00:00Z' })]
    pool.apply({ type: 'replace', rows: rows.map(row => ({ kind: 'issue', id: row.id, value: row as never })) })
    const session = { ...sessionPaneFixture()[0]!, cwd: '/synthetic/nested/file/deep' }
    expect(paneStampIssue(pool, session)).toMatchObject({ id: 'inner' })
    expect(paneStampIssue(pool, { ...session, cwd: '/synthetic/nested-other/file' })).toMatchObject({ id: 'outer' })
    expect(paneStampIssue(pool, { ...session, cwd: '/synthetic-other/file' })).toBeUndefined()
  } finally { pool.dispose() }
})

it('reads the issue outcome through real pool models, whose fields are prototype getters (POD-2151)', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW })
  try {
    const closed = { stage: 'done', closedAt: '2026-10-01T00:00:10Z', parentBranch: 'tf.dev' }
    pool.apply({ type: 'replace', rows: [
      issue('landed', null, { ...closed, audience: 'human', closedReason: 'done', landedAt: '2026-10-01T00:00:09Z', landedSha: 'fcd1385aa9e0' }),
      issue('cancelled', null, { ...closed, audience: 'human', closedReason: 'cancelled' }),
      // Human audience, so only the parent rule can refuse the tuck.
      issue('sub', null, { ...closed, audience: 'human', parentId: 'landed', closedReason: 'done' }),
      issue('tucked', null, { ...closed, audience: 'human', closedReason: 'done', tuckedAt: '2026-10-01T00:00:12Z' }),
      // Still wants the human: the sidebar keeps the row, so a tuck would fold nothing.
      issue('asks', null, { ...closed, audience: 'human', closedReason: 'done', needsHuman: true }),
    ].map(row => ({ kind: 'issue', id: row.id, value: row as never })) })
    const stopped = { ...sessionPaneFixture()[0]!, status: 'hibernated', stopReason: 'parent', stoppedAt: '2026-10-01T00:00:11Z' } as SessionView
    const outcome = (issueId: string) => {
      pool.apply({ type: 'update', rows: [{ kind: 'session', id: stopped.sessionId, value: { ...stopped, issueId } as never }] })
      return sessionPaneView(pool).loaded(stopped.sessionId)?.issueOutcome
    }
    expect(outcome('landed')).toEqual({ kind: 'landed', at: '2026-10-01T00:00:09Z', branch: 'tf.dev', sha: 'fcd1385', issueId: 'landed', tuckable: true, tucked: false })
    expect(outcome('cancelled')).toEqual({ kind: 'closed', at: '2026-10-01T00:00:10Z', reason: 'cancelled', issueId: 'cancelled', tuckable: false, tucked: false })
    // The card reads the sidebar row's own tuck verdicts (POD-2293). A cancelled
    // row folds by itself, so no tuck is offered; a sub-task has no row to fold.
    expect(outcome('sub')).toMatchObject({ kind: 'closed', issueId: 'sub', tuckable: false })
    // Already tucked: the card shows it as done rather than offering it again.
    expect(outcome('tucked')).toMatchObject({ kind: 'closed', issueId: 'tucked', tuckable: false, tucked: true })
    expect(outcome('asks')).toMatchObject({ kind: 'closed', issueId: 'asks', tuckable: false })
  } finally { pool.dispose() }
})

it('reads spawn confirmation only from an attached pool log (POD-5432)', () => {
  for (const ownsSessions of [true, false]) {
    const f = fixture(false)
    try {
      const spawnPrompts = observable.map<string, string | null>()
      f.pool.attachTransactions({ mutate: vi.fn(), spawnPrompts } as never, ownsSessions)
      const seen: boolean[] = []
      const stop = autorun(() => seen.push(paneSpawnConfirmed(f.pool, 'pane-3')))
      // An empty owned log confirms the row; an unowned fixture stays unconfirmed.
      expect(paneSpawnConfirmed(f.pool, 'pane-11')).toBe(ownsSessions)
      runInAction(() => spawnPrompts.set('pane-3', 'First turn'))
      expect(seen).toEqual(ownsSessions ? [true, false] : [false])
      runInAction(() => spawnPrompts.delete('pane-3'))
      expect(seen).toEqual(ownsSessions ? [true, false, true] : [false])
      stop()
    } finally { f.pool.dispose() }
  }
})
