import { omitGone, requireHere } from './lookup'
import { headerEntities } from './header-entities'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { ActiveWorktree } from '@podium/client-core/values'
import type { RepoId } from '@podium/model/browser'
import type { SessionView } from '@podium/client-core/session-values'
import { asSessionId, machinePathAncestors, machinePathSeparator } from '@podium/model/browser'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { shellFixture } from '../../../tests/worklist/diagnostics/shell-fixture'
import { sessionPaneFixture, SESSION_PANE_NOW } from '../../../tests/worklist/diagnostics/session-pane-fixture'
import { measureWork } from '../../../tests/worklist/harness/src/work-meter'
import type { HeaderRows } from './header-schema'
import { MobxPool } from './pool'
import { paneIssueColor, paneSession } from './session-pane'
import { sessionPaneView } from './session-pane-view'
import { ShellDockSession, shellViews } from './shell-views'
import { worklistView } from './worklist/view-model'
import { LOADING, type Loaded } from './worklist/rollup'

// Parity (old answer vs new answer on the same fixtures) for the facts this
// change moves off copied session/issue bundles, and the heartbeat proof.

/** The removed pane reader, verbatim (POD-5878): it took the whole session row. */
function paneStampIssue(pool: MobxPool, session: SessionView | undefined) {
  const eligible = (id: string) => {
    const summary = omitGone(pool.row('issue', id, 'summary')) as { archived?: boolean; deletedAt?: string | null } | undefined | typeof LOADING
    if (summary === LOADING) return LOADING
    return summary && !summary.archived && !summary.deletedAt ? summary : undefined
  }
  if (!session) return undefined
  if (session.issueId) {
    const attached = eligible(session.issueId)
    if (attached === LOADING) return LOADING
    if (attached) return omitGone(pool.row('issue', session.issueId)) as { id: string } | undefined | typeof LOADING
  }
  const paths = machinePathSeparator(session.cwd) === '\\' ? machinePathAncestors(session.cwd) : [session.cwd]
  if (machinePathSeparator(session.cwd) === '/') for (let at = session.cwd.lastIndexOf('/'); at >= 0; at = session.cwd.lastIndexOf('/', at - 1)) {
    paths.push(session.cwd.slice(0, at))
    if (at === 0) break
  }
  for (const path of paths) {
    for (const id of pool.relations.many('worktree', path, 'issues')) {
      const candidate = eligible(id)
      if (candidate === LOADING) return LOADING
      if (candidate) return omitGone(pool.row('issue', id)) as { id: string } | undefined | typeof LOADING
    }
  }
  return undefined
}

function issue(id: string, path: string | null, patch: Record<string, unknown> = {}) {
  return { id, seq: 1, title: id, stage: 'in_progress', repoPath: '/synthetic', deps: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', archived: false, worktreePath: path, ...patch }
}
const STAMP_ISSUES = [
  issue('outer', '/synthetic'), issue('inner', '/synthetic/nested'), issue('attached', '/elsewhere'),
  issue('deleted', '/synthetic/nested/file', { deletedAt: '2026-10-01T00:00:00Z' }),
  issue('archived', '/synthetic/archived', { archived: true }), issue('root-lane', '/'),
  issue('win', 'C:\\repo'), issue('win-inner', 'C:\\repo\\lane'), issue('twin-a', '/twin'), issue('twin-b', '/twin'),
]
const STAMP_SESSIONS: [string, string, string | null][] = [
  ['nested-deep', '/synthetic/nested/file/deep', null], ['nested-other', '/synthetic/nested-other/file', null],
  ['outside', '/synthetic-other/file', null], ['attached', '/synthetic/nested/file', 'attached'],
  ['attached-archived', '/synthetic/nested', 'archived'], ['attached-missing', '/synthetic', 'never-loaded'],
  ['root', '/top', null], ['exact', '/synthetic/nested', null], ['archived-lane', '/synthetic/archived/x', null],
  ['windows', 'C:\\repo\\lane\\src', null], ['windows-outer', 'C:\\repo\\other', null], ['twin', '/twin/a', null],
]

function stampPool() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW })
  const base = sessionPaneFixture()[0]!
  const sessions = STAMP_SESSIONS.map(([id, cwd, issueId]) => ({ ...base, sessionId: asSessionId(id), cwd, issueId }) as SessionView)
  pool.apply({ type: 'replace', rows: [
    ...STAMP_ISSUES.map(row => ({ kind: 'issue' as const, id: row.id, value: row as never })),
    ...sessions.map(row => ({ kind: 'session' as const, id: row.sessionId, value: row as never })),
  ] })
  return { pool, sessions }
}
function stamps(pool: MobxPool, ids: readonly string[]) {
  const panes = sessionPaneView(pool)
  return ids.map(id => {
    const row = paneSession(pool, id)
    const old = row === LOADING ? LOADING : paneStampIssue(pool, row)
    const stamp = panes.loaded(id)?.stampIssue
    return { id, old: old === LOADING ? 'loading' : old?.id ?? null, new: stamp === LOADING ? 'loading' : stamp?.id ?? null }
  })
}

it('stamps the same issue as the old pane reader over attachment, checkout and path-boundary fixtures', () => {
  const { pool, sessions } = stampPool()
  const ids = sessions.map(row => row.sessionId)
  try {
    const check = () => {
      const rows = stamps(pool, ids)
      for (const row of rows) expect(row.new, row.id).toBe(row.old)
      return rows
    }
    const first = check()
    console.info('[pane stamp parity]', JSON.stringify(first.map(row => [row.id, row.new])))
    // The corpus reaches attachment, checkout, boundary and miss answers.
    expect(new Set(first.map(row => row.new)).size).toBeGreaterThanOrEqual(5)
    expect(first.some(row => row.new === 'loading')).toBe(false)
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'attached', value: issue('attached', '/elsewhere', { archived: true }) as never }] })
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'inner', value: issue('inner', '/synthetic/nested', { deletedAt: '2026-10-02T00:00:00Z' }) as never }] })
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'twin-a', value: issue('twin-a', '/twin', { archived: true }) as never }] })
    check()
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'outside', value: { ...sessions[2]!, cwd: '/synthetic/nested/x', issueId: 'win' } as never }] })
    expect(check().find(row => row.id === 'outside')!.new).toBe('win')
  } finally { pool.dispose() }
})

function dockFixture() {
  const f = shellFixture()
  f.pool.apply({ type: 'update', rows: [{ kind: 'repo', id: 'shell-repo',
    value: { id: 'shell-repo', prefix: 'SYN', repoPath: '/synthetic/project' } }] as never })
  return f
}
/** The removed dock reader (aeef0c4625), independent of the new routing fields. */
function legacyDock(pool: MobxPool, views: ReturnType<typeof shellViews>) {
  const { window, files, session, issue } = views
  const state = window(),
    fileTabs = files()
  if (!state || state === LOADING || fileTabs === LOADING) return LOADING
  let active: ActiveWorktree | null = null
  const selectedFile = fileTabs?.find((file) => file.id === state.paneA)
  let activeSession = state.paneA && !selectedFile ? session(state.paneA) : undefined
  if (activeSession === LOADING) return LOADING
  const selected = activeSession
  if (selected)
    active = { cwd: selected.cwd, machineId: selected.machineId, sessionId: selected.sessionId }
  else {
    const tab = selectedFile
    if (tab?.worktreePath)
      active = {
        cwd: tab.worktreePath,
        machineId: tab.scope.kind === 'worktree' ? tab.scope.machineId : undefined,
        ...(tab.issueId ? { issueId: tab.issueId } : {}),
      }
  }
  if (!active) {
    let latest: SessionView | undefined
    const excluded: string[] = []
    for (;;) {
      const id = pool.queries.indexed({ kind: 'headerRecentSession', excluded })[0]
      if (!id) break
      const candidate = session(id)
      if (candidate === LOADING) return LOADING
      if (candidate && !candidate.archived) {
        latest = candidate
        break
      }
      excluded.push(id)
    }
    if (latest)
      active = { cwd: latest.cwd, machineId: latest.machineId, sessionId: latest.sessionId }
    activeSession = latest
  }
  const containingId = active ? pool.queries.containingIssueId(active.cwd) : undefined
  const containing = containingId
    ? (issue(containingId) as Loaded<IssueViewModel>)
    : undefined
  if (containing === LOADING) return LOADING
  const attachedId = active?.issueId ?? activeSession?.issueId
  const attached = attachedId ? (issue(attachedId) as Loaded<IssueViewModel>) : containing
  if (attached === LOADING) return LOADING
  const discovered = active ? headerEntities(pool).shippingScope(active.cwd, active.machineId) : undefined
  let scope: { repoId: RepoId | null; repoPath: string } | null = discovered
    ? { repoId: discovered.repoId as RepoId | null, repoPath: discovered.repoPath }
    : null
  if (active && !scope && attached)
    scope = { repoId: attached.repoId ?? null, repoPath: attached.repoPath }
  const explicitGitIssue = active?.issueId
    ? (issue(active.issueId) as Loaded<IssueViewModel>)
    : undefined
  if (explicitGitIssue === LOADING) return LOADING
  return {
    active,
    scope,
    gitIssue: explicitGitIssue ?? containing,
    mailIssueId: activeSession?.issueId ?? containing?.id,
    issues: [],
    shipOrders: [],
    shipLanes: [],
    coarseNow: state.coarseNow,
    shipping: headerEntities(pool).shippingCounts(scope?.repoId ?? null),
  }
}

type Dock = ReturnType<typeof shellViews>['dock']
function dockAnswers(dock: Dock) {
  const id = (value: { id: string } | undefined | typeof LOADING) => value === LOADING ? LOADING : value?.id
  return { active: dock.active, scope: dock.scope, gitIssue: id(dock.gitIssue), mailIssueId: dock.mailIssueId, shipping: dock.shipping }
}
function oldAnswers(pool: MobxPool, views: ReturnType<typeof shellViews>) {
  const value = legacyDock(pool, views)
  if (!value || value === LOADING) return LOADING
  return { active: value.active, scope: value.scope, gitIssue: value.gitIssue?.id, mailIssueId: value.mailIssueId, shipping: value.shipping }
}

it('routes the dock exactly as the old dock bundle across pane, file, fallback, attachment and scope changes', () => {
  const f = dockFixture(), views = shellViews(f.pool), dock = views.dock
  const root = f.state().repos[0]!
  let stop = () => {}
  try {
    stop = autorun(() => { legacyDock(f.pool, views); dockAnswers(dock) })
    const checked: string[] = []
    const check = (label: string) => {
      if (oldAnswers(f.pool, views) === LOADING) f.pool.hydrate()
      const old = oldAnswers(f.pool, views)
      expect(old, label).not.toBe(LOADING)
      expect(dockAnswers(dock), label).toEqual(old)
      checked.push(label)
    }
    check('initial pane session')
    f.change({ paneA: asSessionId(f.fileTabs[0]!.id) })
    check('file tab with checkout and explicit issue')
    f.change({ fileTabs: [{ ...f.fileTabs[0]!, issueId: f.issues[0]!.id }] })
    check('file tab explicit issue wins git')
    f.change({ fileTabs: [{ ...f.fileTabs[0]!, worktreePath: undefined } as never] })
    check('file tab without checkout falls back to the recent session')
    f.change({ paneA: null as never, fileTabs: f.fileTabs })
    check('no pane: recent session fallback')
    expect(dock.active).toMatchObject({ sessionId: f.sessions[0]!.sessionId })
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: f.sessions[1]!.sessionId,
      value: { ...f.sessions[1]!, lastActiveAt: '2026-10-01T13:59:00Z' } }] as never })
    check('recent fallback follows newer activity')
    expect(dock.active).toMatchObject({ sessionId: f.sessions[1]!.sessionId })
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: f.sessions[1]!.sessionId,
      value: f.sessions[1]! }] as never })
    check('restored recent order picks the first session again')
    expect(dock.active).toMatchObject({ sessionId: f.sessions[0]!.sessionId })
    // Archive the session the fallback lands on: the next recent one serves.
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: f.sessions[0]!.sessionId,
      value: { ...f.sessions[0]!, archived: true } }] as never })
    check('fallback skips an archived recent session')
    expect(dock.active).toMatchObject({ sessionId: f.sessions[1]!.sessionId })
    f.change({ paneA: f.sessions[0]!.sessionId })
    const moved = { ...f.sessions[0]!, cwd: '/undiscovered/sub', issueId: f.issues[2]!.id }
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: moved.sessionId, value: moved }] as never })
    check('pane session moved outside every scan, attached elsewhere')
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: f.issues[2]!.id,
      value: { ...f.issues[2]!, worktreePath: '/undiscovered' } }] as never })
    check('attached issue gains the containing checkout')
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: moved.sessionId, value: { ...moved, issueId: null } }] as never })
    check('detached session: containing issue is the mail issue')
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: moved.sessionId, value: { ...moved, issueId: '' } }] as never })
    check('empty attachment retains its nullish mail answer')
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id: moved.sessionId, value: f.sessions[0]! }] as never })
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: f.issues[1]!.id, value: { ...f.issues[1]!, archived: true } }] as never })
    check('containing issue archived')
    headerEntities(f.pool).apply([{ kind: 'repository', id: JSON.stringify(['shell-machine', '/synthetic/project']),
      value: { ...root, repoId: 'other-scope' as HeaderRows['repository']['repoId'] } }])
    check('repository scope moves')
    f.change({ repos: [] })
    check('no scan: attached issue scope')
    f.change({ paneA: asSessionId('shell-session-missing') })
    check('unknown pane session falls back')
    expect(checked).toHaveLength(16)
  } finally {
    stop()
    f.pool.dispose()
  }
})

it('re-runs no stamp, ownership, chrome or dock routing on a heartbeat of the pane session', async () => {
  const f = dockFixture(), views = shellViews(f.pool), dock = views.dock, panes = sessionPaneView(f.pool)
  const id = f.sessions[0]!.sessionId
  const runs = { stamp: 0, owner: 0, chrome: 0, dock: 0, legacyStamp: 0, legacyDock: 0 }
  const stops = [
    autorun(() => { runs.stamp++; panes.loaded(id)?.stampIssue }),
    autorun(() => { runs.owner++; panes.selectedIssueId; panes.issueHex(color => color ?? undefined) }),
    autorun(() => { runs.chrome++; views.chrome() }),
    autorun(() => { runs.dock++; dockAnswers(dock) }),
    // Legacy control arm: the old readers took the whole session row.
    autorun(() => { runs.legacyStamp++; const row = paneSession(f.pool, id); if (row !== LOADING) paneStampIssue(f.pool, row) }),
    autorun(() => { runs.legacyDock++; legacyDock(f.pool, views) }),
  ]
  try {
    expect(panes.loaded(id)?.stampIssue).toMatchObject({ id: f.issues[0]!.id })
    expect(dock.active).toMatchObject({ sessionId: id })
    const before = { ...runs }
    const heartbeat = await measureWork(async () => {
      f.pool.apply({ type: 'update', rows: [{ kind: 'session', id,
        value: { ...f.sessions[0]!, lastActiveAt: '2026-10-01T13:59:00Z', agentState: { phase: 'idle', since: '2026-10-01T13:59:00Z' } } }] as never })
    }, { pool: f.pool })
    const ran = Object.fromEntries(Object.entries(runs).map(([key, value]) => [key, value - before[key as keyof typeof runs]]))
    const moved = Object.entries(heartbeat.work.derivationsBy).filter(([name]) =>
      /PaneSession\.stampIssue|SessionPanes\.selectedIssueId|ShellDock\.|ShellChrome\.value/.test(name))
    console.info('[pane heartbeat]', JSON.stringify({ ran, derivations: heartbeat.work.derivations, by: heartbeat.work.derivationsBy }))
    expect(ran).toMatchObject({ stamp: 0, owner: 0, chrome: 0, dock: 0 })
    expect(moved).toEqual([])
    // The control arm proves the heartbeat reached the readers.
    expect(ran.legacyStamp).toBeGreaterThan(0)
    // A shown field still moves the new readers.
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: { ...f.sessions[0]!, issueId: null } }] as never })
    expect(panes.loaded(id)?.stampIssue).toMatchObject({ id: f.issues[1]!.id })
    f.pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: { ...f.sessions[0]!, cwd: '/synthetic/project/w0' } }] as never })
    expect(dock.active).toMatchObject({ cwd: '/synthetic/project/w0' })
    expect(runs.stamp - before.stamp).toBeGreaterThan(0)
    expect(runs.dock - before.dock).toBeGreaterThan(0)
  } finally {
    for (const stop of stops) stop()
    f.pool.dispose()
  }
})


it('keeps pane lifecycle, host and birth grid equal to the row and quiet on activity', () => {
  const f = dockFixture(), panes = sessionPaneView(f.pool), id = f.sessions[0]!.sessionId
  const session = f.pool.sessionObject(id)
  const facts = () => ({ cwd: session.cwd, issueId: session.issueId, machineId: session.machineId,
    status: session.status, archived: session.archived, geometry: session.geometry })
  const old = (row: SessionView) => ({ cwd: row.cwd, issueId: row.issueId, machineId: row.machineId,
    status: row.status, archived: row.archived, geometry: row.geometry })
  let runs = 0
  const stop = autorun(() => { runs++; facts() })
  try {
    expect(panes.loaded(id)?.session).toBe(session)
    expect(facts()).toEqual(old(f.sessions[0]!))
    const grid = { cols: 100, rows: 30 }
    for (const status of ['starting', 'live', 'reconnecting', 'hibernated', 'exited'] as const) {
      const row: SessionView = { ...f.sessions[0]!, status, cwd: '/moved', issueId: undefined, geometry: grid }
      f.pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: row }] as never })
      expect(facts()).toEqual(old(row))
      const before = runs
      f.pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: { ...row,
        geometry: { ...grid }, lastActiveAt: '2026-10-01T13:59:00Z' } }] as never })
      expect(runs).toBe(before)
    }
  } finally { stop(); f.pool.dispose() }
})

it('keeps selected-issue ownership and inherited tint equal and live through the worklist selection', () => {
  const f = dockFixture(), panes = sessionPaneView(f.pool), worklist = worklistView(f.pool)
  const hex = (color: string | null | undefined) => color ?? undefined
  const stop = autorun(() => { panes.selectedIssueId; panes.issueHex(hex) })
  try {
    for (const id of [f.issues[1]!.id, f.issues[0]!.id, null]) {
      worklist.select(id)
      expect(panes.selectedIssueId).toBe(id)
      expect(panes.issueHex(hex)).toBe(paneIssueColor(f.pool, id, hex))
    }
    worklist.select(f.issues[1]!.id)
    expect(panes.issueHex(hex)).toBe('red')
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: f.issues[0]!.id,
      value: { ...f.issues[0]!, color: 'violet' } }] as never })
    expect(panes.issueHex(hex)).toBe('violet')
    f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: f.issues[1]!.id,
      value: { ...f.issues[1]!, archived: true } }] as never })
    expect(panes.issueHex(hex)).toBeUndefined()
  } finally { stop(); f.pool.dispose() }
})


it('omits gone pane sessions and attachments while preserving a pending stamp and dock lookup', () => {
  const base = sessionPaneFixture()[0]!
  const sessions = [
    { ...base, sessionId: asSessionId('pane'), issueId: 'private-issue', cwd: '/elsewhere' },
    { ...base, sessionId: asSessionId('gone-attachment'), issueId: 'removed-issue', cwd: '/elsewhere' },
  ]
  const exits = new Set(['removed-session', 'removed-issue'])
  const load = vi.fn((_entity: string, _id: string) => undefined)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW }, undefined, {
    load, schedule: () => () => {}, exitKind: (_entity, id) => exits.has(id) ? 'removed' : undefined,
  })
  pool.apply({ type: 'replace', rows: sessions.map(value => ({ kind: 'session', id: value.sessionId, value })) as never })
  const panes = sessionPaneView(pool)
  try {
    const removed = panes.pane(pool.sessionObject('removed-session'))
    expect(removed.present).toBe(false)
    expect(panes.loaded('removed-session')).toBeUndefined()
    expect(removed.stampIssue).toBeUndefined()
    expect(panes.loaded('gone-attachment')!.stampIssue).toBeUndefined()
    const pane = panes.pane(requireHere(pool.model('session', 'pane')))
    expect(pane.present).toBe(true)
    expect(pane.stampIssue).toBe(LOADING)
    expect(panes.pane(pool.sessionObject('private-session')).present).toBe(LOADING)
    const dock = new ShellDockSession(pool.sessionObject('private-session'), pool)
    expect(dock.known).toBe(LOADING)
    expect(new ShellDockSession(removed.session, pool).known).toBeUndefined()
    expect(pool.hydrate()).toBe(2)
    expect(pane.stampIssue).toBeUndefined()
    expect(panes.loaded('private-session')).toBeUndefined()
    expect(dock.known).toBeUndefined()
    expect(pool.hydrate()).toBe(0)
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls.flat()).not.toContain('removed-session')
    expect(load.mock.calls.flat()).not.toContain('removed-issue')
  } finally { pool.dispose() }
})
