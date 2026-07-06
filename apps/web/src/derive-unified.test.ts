import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  mostUrgentSession,
  type RepoNavView,
  type SidebarSections,
  sessionUrgencyRank,
  spawnTargetForRepo,
  UNIFIED_ROW_EMPTY_RANK,
  unifiedWorkList,
  type WorktreeNavView,
} from './derive'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')
const HOUR = 3_600_000

function sess(id: string, cwd: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    cwd,
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: 't',
    ...over,
  } as unknown as SessionMeta
}

const needsYou = (id: string, cwd: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  sess(id, cwd, { agentState: { phase: 'needs_user' }, ...over } as Partial<SessionMeta>)
const working = (id: string, cwd: string): SessionMeta =>
  sess(id, cwd, { agentState: { phase: 'working' } } as Partial<SessionMeta>)
const idle = (id: string, cwd: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  sess(id, cwd, {
    agentState: { phase: 'idle', idle: { kind: 'done' } },
    ...over,
  } as Partial<SessionMeta>)

function navWt(path: string, over: Partial<WorktreeNavView> = {}): WorktreeNavView {
  return {
    path,
    repoPath: over.repoPath ?? path,
    isMain: over.isMain ?? true,
    repoName: path.split('/').pop() ?? path,
    sessions: [],
    issues: [],
    ...over,
  }
}

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'i1',
    repoPath: '/r/a',
    seq: 1,
    title: 'Fix login',
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
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
    childCount: 0,
    childDoneCount: 0,
    ...over,
  } as IssueWire
}

const emptySections = (worktrees: WorktreeNavView[]): SidebarSections => ({
  pinnedPanels: [],
  pinnedWorktrees: [],
  pinnedRepos: [],
  repos: worktrees.length > 0 ? [{ path: '/r/a', name: 'a', worktrees }] : [],
})

describe('spawnTargetForRepo', () => {
  const repo = (worktrees: WorktreeNavView[]): RepoNavView => ({
    path: '/src/podium-conv-identity',
    name: 'podium-conv-identity',
    worktrees,
  })
  const clone1 = navWt('/src/podium-conv-identity')
  const clone2 = navWt('/src/podium', { repoPath: '/src/podium' })
  const branch = navWt('/src/podium/.worktrees/x', { isMain: false, repoPath: '/src/podium' })

  it('picks the main clone with the highest activity, not the first', () => {
    const byWorktree = new Map([
      ['/src/podium-conv-identity', NOW - 100 * HOUR],
      ['/src/podium', NOW - HOUR],
    ])
    const t = spawnTargetForRepo(repo([clone1, clone2, branch]), byWorktree)
    expect(t.worktree.path).toBe('/src/podium')
    expect(t.repoName).toBe('podium')
  })

  it('never picks a non-main worktree even when it is the most active', () => {
    const byWorktree = new Map([['/src/podium/.worktrees/x', NOW]])
    const t = spawnTargetForRepo(repo([clone1, clone2, branch]), byWorktree)
    expect(t.worktree.isMain).toBe(true)
  })

  it('with no activity anywhere, falls back to the RepoView path match', () => {
    const t = spawnTargetForRepo(repo([clone2, clone1]), new Map())
    expect(t.worktree.path).toBe('/src/podium-conv-identity')
    expect(t.repoName).toBe('podium-conv-identity')
  })

  it('falls back to the first main when nothing matches the repo path', () => {
    const t = spawnTargetForRepo(
      { path: '/gone', name: 'gone', worktrees: [clone2, clone1] },
      new Map(),
    )
    expect(t.worktree.path).toBe('/src/podium')
  })

  it('reconstructs the main checkout when the nav list is empty', () => {
    const t = spawnTargetForRepo({ path: '/r/a', name: 'a', worktrees: [] }, new Map())
    expect(t.worktree).toEqual({ path: '/r/a', repoPath: '/r/a', isMain: true })
    expect(t.repoName).toBe('a')
  })
})

describe('sessionUrgencyRank / mostUrgentSession', () => {
  it('ranks needs-you 0, working 1, recent idle 2, stale/exited 3', () => {
    expect(sessionUrgencyRank(needsYou('a', '/w'), NOW)).toBe(0)
    expect(sessionUrgencyRank(working('b', '/w'), NOW)).toBe(1)
    expect(sessionUrgencyRank(idle('c', '/w'), NOW)).toBe(2)
    expect(
      sessionUrgencyRank(
        idle('d', '/w', { lastActiveAt: new Date(NOW - 48 * HOUR).toISOString() }),
        NOW,
      ),
    ).toBe(3)
    expect(sessionUrgencyRank(idle('e', '/w', { status: 'exited' }), NOW)).toBe(3)
  })

  it('a snoozed needs-you session is not rank 0', () => {
    const s = needsYou('a', '/w', { snoozedUntil: new Date(NOW + HOUR).toISOString() })
    expect(sessionUrgencyRank(s, NOW)).toBe(2)
  })

  it('mostUrgentSession returns the lowest-ranked child', () => {
    const urgent = needsYou('u', '/w')
    expect(mostUrgentSession([working('w1', '/w'), urgent, idle('i1', '/w')], NOW)).toBe(urgent)
    expect(mostUrgentSession([], NOW)).toBeUndefined()
  })
})

describe('unifiedWorkList (content filter + status ordering)', () => {
  it('excludes backlog/done issues with no sessions and no worktree', () => {
    const rows = unifiedWorkList(
      emptySections([]),
      [
        issue({ id: 'b1', stage: 'backlog' }),
        issue({ id: 'd1', stage: 'done' }),
        issue({ id: 'p1', stage: 'planning' }),
      ],
      [],
      [],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['p1'])
  })

  it('includes a backlog issue that has a worktree or sessions', () => {
    const wt = '/r/a/.worktrees/i1'
    const rows = unifiedWorkList(
      emptySections([]),
      [
        issue({ id: 'w1', stage: 'backlog', worktreePath: wt }),
        issue({ id: 's1', stage: 'backlog' }),
      ],
      [sess('x', '/elsewhere', { issueId: 's1' })],
      [wt],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : '')).sort()).toEqual(['s1', 'w1'])
  })

  it('includes drafts only when they have sessions; non-human issues stay out', () => {
    const rows = unifiedWorkList(
      emptySections([]),
      [
        issue({ id: 'dr1', draft: true, stage: 'backlog' }),
        issue({ id: 'dr2', draft: true, stage: 'backlog' }),
        issue({ id: 'ag1', origin: 'agent' as IssueWire['origin'], stage: 'in_progress' }),
      ],
      [sess('x', '/elsewhere', { issueId: 'dr2' })],
      [],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['dr2'])
  })

  it('only lists worktrees that have at least one session', () => {
    const withSess = navWt('/r/a/.worktrees/x', {
      isMain: false,
      sessions: [idle('s', '/r/a/.worktrees/x')],
    })
    const bare = navWt('/r/a')
    const rows = unifiedWorkList(emptySections([withSess, bare]), [], [], [], NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('worktree')
  })

  it('orders by rank asc (needs-you first, working, ready, stale, session-less last)', () => {
    const iNeeds = issue({ id: 'needs' })
    const iWork = issue({ id: 'work' })
    const iIdle = issue({ id: 'idle' })
    const iEmpty = issue({ id: 'empty', stage: 'planning' })
    const sessions = [
      needsYou('sn', '/x', { issueId: 'needs' }),
      working('sw', '/x'),
      idle('si', '/x', { issueId: 'idle' }),
    ]
    sessions[1] = { ...sessions[1], issueId: 'work' } as SessionMeta
    const rows = unifiedWorkList(
      emptySections([]),
      [iEmpty, iIdle, iWork, iNeeds],
      sessions,
      [],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual([
      'needs',
      'work',
      'idle',
      'empty',
    ])
    expect(rows[3]?.rank).toBe(UNIFIED_ROW_EMPTY_RANK)
  })

  it('within a rank, most-recent child activity wins; empty rows tiebreak on updatedAt', () => {
    const older = issue({ id: 'old' })
    const newer = issue({ id: 'new' })
    const sessions = [
      idle('a', '/x', { issueId: 'old', lastActiveAt: new Date(NOW - 5 * HOUR).toISOString() }),
      idle('b', '/x', { issueId: 'new', lastActiveAt: new Date(NOW - HOUR).toISOString() }),
    ]
    const rows = unifiedWorkList(emptySections([]), [older, newer], sessions, [], NOW)
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['new', 'old'])

    const e1 = issue({ id: 'e1', stage: 'planning', updatedAt: '2026-06-10T00:00:00.000Z' })
    const e2 = issue({ id: 'e2', stage: 'planning', updatedAt: '2026-06-25T00:00:00.000Z' })
    const empties = unifiedWorkList(emptySections([]), [e1, e2], [], [], NOW)
    expect(empties.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['e2', 'e1'])
  })
})
