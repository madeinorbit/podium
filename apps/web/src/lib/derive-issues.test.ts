import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { filterIssueNav, issueNavList, subIssuesOf } from './derive'

const NOW = Date.parse('2026-06-29T12:00:00.000Z')

function sess(
  id: string,
  cwd: string,
  hoursAgo: number,
  over: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    sessionId: id,
    cwd,
    lastActiveAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    agentKind: 'claude-code',
    status: 'hibernated',
    busy: false,
    archived: false,
    agentState: { phase: 'idle', since: '', nativeSubagentCount: 0, idle: { kind: 'done' } },
    ...over,
  } as unknown as SessionMeta
}

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'i',
    repoPath: '/home/u/acme',
    seq: 1,
    title: 'Fix login',
    description: '',
    stage: 'in_progress',
    worktreePath: '/home/u/acme/.worktrees/issue-1',
    branch: 'issue/1',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedBy: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human' as const,
    draft: false,
    ...over,
  } as IssueWire
}

describe('issueNavList', () => {
  it('attaches live sessions whose cwd is the worktree or nested under it', () => {
    const sessions = [
      sess('a', '/home/u/acme/.worktrees/issue-1', 2),
      sess('b', '/home/u/acme/.worktrees/issue-1/packages/web', 1),
      sess('c', '/home/u/other', 1), // different worktree — excluded
    ]
    const [nav] = issueNavList([issue()], sessions, NOW)
    expect(nav?.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b'])
  })

  it('derives repoName from the repoPath basename', () => {
    const [nav] = issueNavList([issue()], [], NOW)
    expect(nav?.repoName).toBe('acme')
  })

  it('gives an unstarted issue (no worktree) an empty session list', () => {
    const [nav] = issueNavList([issue({ worktreePath: null })], [], NOW)
    expect(nav?.sessions).toEqual([])
  })

  it('excludes archived issues', () => {
    const list = issueNavList(
      [issue({ id: 'keep' }), issue({ id: 'gone', archived: true })],
      [],
      NOW,
    )
    expect(list.map((v) => v.issue.id)).toEqual(['keep'])
  })

  it('sorts by most-recent session activity, falling back to updatedAt', () => {
    const recent = issue({
      id: 'recent',
      worktreePath: '/wt/recent',
      updatedAt: '2026-01-01T00:00:00.000Z', // old issue, but a fresh session
    })
    const stale = issue({
      id: 'stale',
      worktreePath: '/wt/stale',
      updatedAt: '2026-06-25T00:00:00.000Z', // newer issue, no sessions
    })
    const sessions = [sess('s', '/wt/recent', 1)]
    const list = issueNavList([stale, recent], sessions, NOW)
    expect(list.map((v) => v.issue.id)).toEqual(['recent', 'stale'])
  })
})

describe('filterIssueNav', () => {
  const list = issueNavList(
    [
      issue({ id: 'a', title: 'Fix login', repoPath: '/home/u/acme', stage: 'in_progress' }),
      issue({ id: 'b', title: 'Add billing', repoPath: '/home/u/widgets', stage: 'backlog' }),
    ],
    [],
    NOW,
  )

  it('returns everything for an empty query', () => {
    expect(
      filterIssueNav(list, '  ')
        .map((v) => v.issue.id)
        .sort(),
    ).toEqual(['a', 'b'])
  })
  it('matches on issue title', () => {
    expect(filterIssueNav(list, 'login').map((v) => v.issue.id)).toEqual(['a'])
  })
  it('matches on repo name', () => {
    expect(filterIssueNav(list, 'widgets').map((v) => v.issue.id)).toEqual(['b'])
  })
  it('matches on stage', () => {
    expect(filterIssueNav(list, 'progress').map((v) => v.issue.id)).toEqual(['a'])
  })
})

describe('subIssuesOf (#133)', () => {
  it("returns a parent's children sorted by seq, INCLUDING archived ones", () => {
    const all = [
      issue({ id: 'p', seq: 1 }),
      issue({ id: 'c2', seq: 3, parentId: 'p' }),
      issue({ id: 'c1', seq: 2, parentId: 'p' }),
      issue({ id: 'gone', seq: 4, parentId: 'p', archived: true }),
      issue({ id: 'other', seq: 5, parentId: 'q' }),
    ]
    const kids = subIssuesOf(all, 'p')
    // Archived child retained (the UI marks it, doesn't drop it) and ordering by seq.
    expect(kids.map((k) => k.id)).toEqual(['c1', 'c2', 'gone'])
    expect(kids.find((k) => k.id === 'gone')?.archived).toBe(true)
  })

  it('returns an empty list when the issue has no children', () => {
    expect(subIssuesOf([issue({ id: 'p' })], 'p')).toEqual([])
  })
})
