import type { SessionView } from '@podium/client-core/session-values'
import { CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS } from '@podium/model/browser'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { headerModel } from './header-companion'
import { headerEntities } from './header-entities'
import { headerWorkingSession } from './header-session'
import { HeaderSessions } from './header-sessions'
import { headerView } from './header-views'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const stamp = (at = NOW) => new Date(at).toISOString()
const issue = (id: string, seq: number) => ({ id, seq, title: `Task ${id}`, stage: 'in_progress',
  repoId: 'repo', parentId: null, deps: [], archived: false, createdAt: stamp(), updatedAt: stamp() })
const session = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  sessionId: id, title: `Agent ${id}`, name: `Name ${id}`, status: 'live', cwd: '/header',
  agentKind: 'codex', lastActiveAt: stamp(), refRepoId: 'repo', refSeq: 1, refLetter: 'A',
  agentState: { phase: 'working', since: stamp(), nativeSubagentCount: 0 }, ...patch,
} as SessionView)

function fixture() {
  const rows = new Map(['z', 'a', 'cold'].map(id => [id, session(id, id === 'cold'
    ? { status: 'exited', stoppedAt: stamp(NOW - 30 * 86_400_000) } : {})]))
  const pool = new MobxPool({ selectedIssueId: 'one', coarseNow: NOW }, undefined,
    { header: true, load: (_kind, id) => rows.get(id), schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [
    { kind: 'repo', id: 'repo', value: { id: 'repo', prefix: 'HEAD', repoPath: '/header' } as never },
    ...['one', 'two'].map((id, i) => ({ kind: 'issue' as const, id, value: issue(id, i + 1) })),
    ...[...rows].map(([id, value]) => ({ kind: 'session' as const, id, value: value as never })),
  ] })
  for (const [id, value] of rows) if (pool.tables.session.has(id)) headerEntities(pool).change('session', id, value)
  return { pool, rows, change(id: string, patch: Partial<SessionView>) {
    const value = { ...rows.get(id)!, ...patch }
    rows.set(id, value)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id, value: value as never }] })
  } }
}

const displayedIssue = (value: { id: string; seq: number; title: string; stage: string; displayRef: string;
  archived?: boolean; deletedAt?: string | null } | typeof LOADING | undefined) =>
  value === LOADING || value === undefined ? value : ({ id: value.id, seq: value.seq, title: value.title,
    stage: value.stage, displayRef: value.displayRef, archived: value.archived, deletedAt: value.deletedAt })
const displayedSession = (value: Pick<SessionView, 'sessionId' | 'title' | 'name' | 'displayRef' | 'agentKind'>) =>
  ({ sessionId: value.sessionId, title: value.title, name: value.name, displayRef: value.displayRef, agentKind: value.agentKind })

// Frozen display oracle from header-views/header-session before this change.
// Keep it independent of the new companion's membership and selection rules.
function oldSelected(pool: MobxPool) {
  const id = pool.selection.keys().next().value
  if (!id) return undefined
  const value = pool.row('issue', id) as ReturnType<typeof issue> & { deletedAt?: string | null } | typeof LOADING | undefined
  if (value === LOADING) return LOADING
  if (!value || value.deletedAt) return undefined
  return { ...value, displayRef: pool.model('issue', id)?.displayRef ?? `#${value.seq}` }
}

describe('header display answers', () => {
  it('compares old and new displayed values on the same changing fixtures', () => {
    const f = fixture(), index = new HeaderSessions(f.pool)
    const stop = autorun(() => { index.workingIds(); headerModel(f.pool).selectedIssue })
    const parity = () => {
      const expected = [...f.rows.keys()].map(id => headerWorkingSession(
        f.pool.sessionObject(id) as SessionView, at => f.pool.clock.passed(at)))
        .filter(value => value !== null && !f.rows.get(value.sessionId)?.archived)
        .sort((a, b) => a!.sessionId < b!.sessionId ? -1 : 1)
      expect(index.workingIds().map(id => displayedSession(f.pool.sessionObject(id)))).toEqual(expected)
      expect(headerView(f.pool).working().map(displayedSession)).toEqual(expected)
      expect(displayedIssue(headerModel(f.pool).selectedIssue)).toEqual(displayedIssue(oldSelected(f.pool)))
      expect(displayedIssue(headerView(f.pool).selectedIssue())).toEqual(displayedIssue(oldSelected(f.pool)))
    }
    try {
      parity()
      f.change('cold', { status: 'live', agentState: session('cold').agentState })
      parity()
      f.change('a', { name: undefined, title: 'Renamed agent', agentKind: 'shell' })
      parity()
      f.change('z', { archived: true })
      parity()
      f.change('a', { agentState: { phase: 'needs_user', since: stamp(), nativeSubagentCount: 0 } })
      parity()
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'one', value: { ...issue('one', 1), title: 'Renamed task' } }] })
      parity()
      f.pool.applyLocals({ selectedIssueId: 'two', coarseNow: NOW }, new Set(['selectedIssueId']))
      parity()
      f.pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'two', value: { ...issue('two', 2), deletedAt: stamp() } }] })
      parity()
      f.pool.applyLocals({ selectedIssueId: null, coarseNow: NOW }, new Set(['selectedIssueId']))
      parity()
      f.pool.applyLocals({ selectedIssueId: null, coarseNow: NOW + CONFIRMED_AGENT_ACTIVITY_MAX_AGE_MS + 1 }, new Set(['coarseNow']))
      parity()
      f.pool.applyLocals({ selectedIssueId: 'one', coarseNow: NOW }, new Set(['selectedIssueId', 'coarseNow']))
      parity()
    } finally { stop(); index.dispose(); f.pool.dispose() }
  })
})
