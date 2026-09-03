import type { SessionMeta, SessionMetaInput, UnbrandIds } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { IssueNavigationModel } from '../issues'
import type { SidebarSections } from './nav'
import type { UnifiedWorkRow } from './row-types'
import { unifiedWorkList } from './rows'

const NOW = Date.parse('2026-08-17T12:00:00.000Z')

function issue(over: Partial<UnbrandIds<IssueNavigationModel>> = {}): IssueNavigationModel {
  return {
    id: 'i43',
    repoPath: '/r/a',
    seq: 43,
    displayRef: 'POD-43',
    title: 'Agent work',
    description: '',
    stage: 'in_progress',
    worktreePath: '/r/a',
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'opencode',
    blockedByNotes: [],
    deps: [],
    createdAt: '2026-08-17T10:00:00.000Z',
    updatedAt: '2026-08-17T11:00:00.000Z',
    archived: false,
    needsHuman: false,
    memberSessionIds: ['s43'],
    sessionSummary: { total: 1, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    unread: true,
    readAt: null,
    ...over,
  } as IssueNavigationModel
}

function session(over: Partial<SessionMetaInput> = {}): SessionMeta {
  return {
    sessionId: 's43',
    cwd: '/r/a',
    issueId: 'i43',
    createdAt: '2026-08-17T11:58:00.000Z',
    lastActiveAt: '2026-08-17T11:59:00.000Z',
    agentKind: 'opencode',
    status: 'live',
    archived: false,
    title: 'hello',
    unread: true,
    ...over,
  } as SessionMeta
}

const emptySections: SidebarSections = { pinnedWorktrees: [], pinnedRepos: [], repos: [] }

const worktreeSections = (worker: SessionMeta): SidebarSections => ({
  pinnedWorktrees: [
    { path: '/r/a', name: 'a', branch: 'main', sessions: [worker] } as never,
  ],
  pinnedRepos: [],
  repos: [],
})

function rosterIds(row: UnifiedWorkRow): string[] {
  return (row.kind === 'issue' ? row.sessions : row.worktree.sessions).map(
    (candidate) => candidate.sessionId,
  )
}

const exited = (over: Partial<SessionMetaInput> = {}): SessionMeta =>
  session({
    status: 'exited',
    stoppedAt: '2026-08-17T11:59:30.000Z',
    agentState: {
      phase: 'ended',
      since: '2026-08-17T11:59:30.000Z',
      nativeSubagentCount: 0,
    },
    ...over,
  })

describe('unified work-list row retention after agent exit', () => {
  it.each(['live', 'hibernated'] as const)(
    'keeps a %s agent in both the issue row and its live roster',
    (status) => {
      const worker = session({ status })
      const rows = unifiedWorkList(emptySections, [issue()], [worker], ['/r/a'], NOW)
      expect(rows).toHaveLength(1)
      expect(rosterIds(rows[0] as UnifiedWorkRow)).toEqual(['s43'])
    },
  )

  it.each(['in_progress', 'planning', 'backlog', 'done'] as const)(
    'keeps an %s issue row after exit but removes the agent from its live roster',
    (stage) => {
      const worker = exited()
      const rows = unifiedWorkList(
        emptySections,
        [issue({ stage })],
        [worker],
        ['/r/a'],
        NOW,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('issue')
      expect(rosterIds(rows[0] as UnifiedWorkRow)).toEqual([])
    },
  )

  it('keeps a repo-scoped worktree row after exit but removes the agent from its live roster', () => {
    const repoWorker = exited({ sessionId: 'repo1', issueId: undefined })
    const rows = unifiedWorkList(worktreeSections(repoWorker), [], [repoWorker], ['/r/a'], NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('worktree')
    expect(rosterIds(rows[0] as UnifiedWorkRow)).toEqual([])
  })
})
