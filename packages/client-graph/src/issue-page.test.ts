import type { SessionView } from '@podium/client-core/session-values'
import { presenceNote } from '@podium/client-core/values'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createIssuePageViews, type IssuePageData } from './issue-page'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'
import { LOADING, type Loaded } from './worklist/rollup'

const old = '2020-01-01T00:00:00Z'
const issue = (id: string, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
  id, seq: id === 'tip' ? 3 : 1, title: id, repoId: 'repo', repoPath: '/repo',
  stage: 'done', createdAt: old, updatedAt: old, description: '', deps: [], labels: [],
  deletedAt: null, archived: false, readAt: null, ...patch,
} } as RowRecord)
const seat = (id: string, patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
  sessionId: id, issueId: 'root', refIssueId: 'root', cwd: '/repo', title: id,
  agentKind: 'codex', status: 'exited', archived: true, lastActiveAt: old, ...patch,
} } as RowRecord)

it('preserves detail catalogs, continuations and roster lifecycle while read markers reuse worktree choices', () => {
  const root = issue('root'), hop = issue('hop', { deps: [{ id: 'root', type: 'discovered-from' }] }),
    tip = issue('tip', { stage: 'planning', deps: [{ id: 'hop', type: 'discovered-from' }] })
  const history = Array.from({ length: 48 }, (_, n) => seat(`history-${String(n).padStart(3, '0')}`))
  const worktrees = Array.from({ length: 64 }, (_, n) => ({ kind: 'worktree', id: `/repo/w${n}`, value: {
    path: `/repo/w${n}`, projectRoot: false,
  } } as RowRecord))
  const rows = [root, hop, tip, ...history, ...worktrees,
    { kind: 'worktree', id: '/repo', value: {
      path: '/repo', repoId: 'repo', repoPath: '/repo', repoName: 'Repo', prefix: 'P', projectRoot: true,
    } } as RowRecord,
    seat('tip-agent', { issueId: 'tip', archived: false, status: 'running' })]
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(old) })
  pool.apply({ type: 'replace', rows })
  const views = createIssuePageViews(pool)
  let current: Loaded<IssuePageData> = LOADING
  const stop = autorun(() => { current = views.data('root') })
  const page = () => {
    expect(current).not.toBe(LOADING)
    expect(current).toBeDefined()
    return current as IssuePageData
  }
  const parity = () => {
    const value = page(), world = views.issues()
    expect(world).not.toBe(LOADING)
    const byId = new Map((world as IssuePageData['issues']).map(row => [row.id as string, row]))
    expect(value.issues.map(row => row.id).sort()).toEqual([...byId.keys()].sort())
    expect(value.presence).toEqual(presenceNote(value.issue,
      views.attachedSessions('root') as SessionView[], byId, value.sessions))
    return value
  }
  try {
    const first = parity()
    expect(first.presence?.text).toBe('Work continued in P-3')
    expect(first.memberSessions.map(row => row.sessionId)).toEqual(history.map(row => row.id))
    expect(first.worktreePaths).toEqual(worktrees.map(row => row.id))
    const reads = vi.spyOn(pool, 'row')
    pool.apply({ type: 'update', rows: [issue('root', { readAt: '2026-10-04T12:00:00Z' })] })
    expect(page().issue.readAt).toBe('2026-10-04T12:00:00Z')
    expect(page().memberSessions).toBe(first.memberSessions)
    expect(page().worktreePaths).toBe(first.worktreePaths)
    expect(reads.mock.calls.filter(([kind]) => kind === 'worktree')).toEqual([])
    parity()

    pool.apply({ type: 'update', rows: [seat('history-000', { title: 'Renamed' })] })
    expect(parity().memberSessions[0]?.title).toBe('Renamed')
    pool.apply({ type: 'update', rows: [seat('history-000', { issueId: 'tip' })] })
    expect(parity().memberSessions.map(row => row.sessionId)).toEqual(history.slice(1).map(row => row.id))
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'history-001', value: undefined }] })
    expect(parity().memberSessions).toHaveLength(46)
    pool.apply({ type: 'update', rows: [seat('history-001')] })
    expect(parity().memberSessions).toHaveLength(47)

    pool.apply({ type: 'update', rows: [issue('hop', { ...hop.value, archived: true })] })
    expect(parity().presence?.kind).toBe('done')
    pool.apply({ type: 'update', rows: [hop] })
    expect(parity().presence?.kind).toBe('moved')
    pool.apply({ type: 'update', rows: [issue('tip', { ...tip.value, deletedAt: old })] })
    expect(parity().presence?.text).toBe('Work continued in P-1')
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'tip', value: undefined }] })
    expect(parity().presence?.text).toBe('Work continued in P-1')
    pool.apply({ type: 'update', rows: [tip] })
    expect(parity().presence?.kind).toBe('moved')
    pool.apply({ type: 'update', rows: [issue('root', { supersededBy: 'tip' })] })
    expect(parity().presence?.text).toBe('Work continued in P-3')

    pool.apply({ type: 'replace', rows: [root, history[0]!, worktrees[0]!] })
    expect(parity().memberSessions.map(row => row.sessionId)).toEqual(['history-000'])
    expect(page().worktreePaths).toEqual(['/repo/w0'])
    reads.mockClear()
    stop()
    pool.apply({ type: 'update', rows: [seat('history-000', { title: 'After release' })] })
    // Pool maintenance still uses mark/peek; released page readers demand no rows.
    expect(reads.mock.calls.filter(([, , mode]) =>
      mode === undefined || mode === 'load' || mode === 'summary' || mode === 'summary-fields',
    )).toEqual([])
    views.dispose()
    expect(views.memberSessions('root')).toBe(LOADING)
  } finally { stop(); views.dispose(); pool.dispose(); vi.restoreAllMocks() }
})
