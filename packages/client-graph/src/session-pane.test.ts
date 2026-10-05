import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReferenceState as Store } from '@podium/client-graph/diagnostics/reference-state'
import type { SessionView } from '@podium/client-core/session-values'
import type { MachineWire } from '@podium/model/browser'
import { autorun, observable, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { checkSessionPanes } from '../diagnostics/session-pane-check'
import { sessionPaneFixture, SESSION_PANE_NOW } from '../diagnostics/session-pane-fixture'
import { MobxPool } from './pool'
import { paneSession, paneWindow, paneSpawnConfirmed, paneStampIssue, paneIssueColor } from './session-pane'
import { SessionPaneSource } from './session-pane-source'
import { SESSION_PANE_ENTITIES, SESSION_PANE_SUMMARIES } from './session-pane-schema'
import { LOADING } from './worklist/rollup'


function fixture(attachLog = true) {
  const sessions = sessionPaneFixture()
  const machines = [{ id: 'machine-a', name: 'Host', online: true }, { id: 'machine-b', name: 'Offline host', online: false, loggedOutHarnesses: ['codex'] }] as MachineWire[]
  let state = { sessions, machines, panelMode: { 'pane-0': 'chat' }, dockShells: { '/synthetic/w19': 'pane-19' },
    reposLoaded: true, coarseNow: SESSION_PANE_NOW, selectedIssueId: null } as unknown as Store
  const listeners = new Set<() => void>()
  const runtime = withKeyedInputs({ getSnapshot: () => state, subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } } }) as unknown as ClientRuntime
  const load = vi.fn((_entity: string, id: string) => sessions.find(row => row.sessionId === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW }, undefined,
    { summaries: SESSION_PANE_SUMMARIES, load: load as never, schedule: () => () => {} })
  const spawnPrompts = observable.map<string, string | null>([['pane-11', null]])
  if (attachLog) pool.attachTransactions({ mutate: vi.fn(), spawnPrompts } as never)
  pool.apply({ type: 'replace', rows: sessions.map(row => ({ kind: 'session' as const, id: row.sessionId, value: row as never })) })
  pool.header.apply(machines.map(row => ({ kind: 'machine', id: row.id, value: row })))
  pool.header.order('machine', machines.map(row => row.id))
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
    const window = f.pool.row('sessionPaneWindow', 'window') as { panelMode: Record<string, string> }
    expect(window.panelMode).toEqual({ 'pane-0': 'native' })
  } finally { f.pool.dispose() }
})

it('matches all pane status, urgency, header, recovery and control inputs over the synthetic corpus', () => {
  const f = fixture()
  try {
    expect(f.settle()).toMatchObject({ differences: 0, pending: 0, positions: f.sessions.length + f.machines.length })
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
    f.pool.header.apply([{ kind: 'machine', id: 'machine-a', value: { ...f.machines[0]!, online: false } }])
    expect(checkSessionPanes(f.pool, f.state()).first?.section).toBe(2)
    f.pool.header.apply([{ kind: 'machine', id: 'machine-a', value: f.machines[0]! }])
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
    expect(f.pool.row('session', cold.sessionId, 'summary')).not.toHaveProperty('configureFields')
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
    expect(f.pool.row('sessionPaneWindow', 'window')).toBe(LOADING)
  } finally { f.pool.dispose() }
})

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
it('inherits the selected issue tint through summary fields and stops on a parent cycle', () => {
  const pool = new MobxPool({ selectedIssueId: 'child', coarseNow: SESSION_PANE_NOW })
  try {
    pool.apply({ type: 'replace', rows: [issue('root', null, { color: 'violet' }), issue('child', null, { parentId: 'root' })].map(row => ({ kind: 'issue', id: row.id, value: row as never })) })
    const hex = (name: string | null | undefined) => name === 'violet' ? '#abc' : undefined
    expect(paneIssueColor(pool, 'child', hex)).toBe('#abc')
    const f = fixture()
    try {
      const rows = [issue('root', null, { color: 'violet' }), issue('child', null, { parentId: 'root' })]
      f.pool.apply({ type: 'update', rows: rows.map(row => ({ kind: 'issue', id: row.id, value: row as never })) })
      f.pool.applyLocals({ selectedIssueId: 'child', coarseNow: SESSION_PANE_NOW }, new Set(['selectedIssueId']))
      f.change({ selectedIssueId: 'child' as Store['selectedIssueId'] })
      f.settle()
      expect(checkSessionPanes(f.pool, f.state(), undefined, rows as never, hex).differences).toBe(0)
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root', value: issue('root', null) as never }] })
      expect(checkSessionPanes(f.pool, f.state(), undefined, rows as never, hex).first?.section).toBe(3)
    } finally { f.pool.dispose() }
    // Tint traversal owns its cycle guard; unrelated sidebar presence reactions
    // need not consume this malformed parent graph in the focused reader proof.
    const cycle = { row: (_entity: string, id: string) =>
      id === 'child' ? issue('child', null, { parentId: 'root' }) : issue('root', null, { parentId: 'child' }) } as unknown as MobxPool
    expect(paneIssueColor(cycle, 'child', hex)).toBeUndefined()
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
