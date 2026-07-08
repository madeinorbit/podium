import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  archivedSessionsForIssue,
  archivedSessionsForWorktreePath,
  groupUnifiedWorkRows,
  isIssueSnoozed,
  isRowUnread,
  issueReturnedFromDefer,
  rowUnreadEmphasized,
  mostUrgentSession,
  partitionUnifiedWork,
  type RepoNavView,
  repoUsageAt,
  type SidebarSections,
  sessionUrgencyRank,
  spawnTargetForRepo,
  type UnifiedWorkRow,
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
    audience: 'human' as const,
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
    path: '/src/podium',
    name: 'podium',
    worktrees,
  })
  const own = navWt('/src/podium', { repoPath: '/src/podium' })
  const clone = navWt('/src/podium-conv-identity', { repoPath: '/src/podium-conv-identity' })
  const branch = navWt('/src/podium/.worktrees/x', { isMain: false, repoPath: '/src/podium' })

  it("always picks the repo's OWN main checkout, never a sibling clone", () => {
    const t = spawnTargetForRepo(repo([clone, own, branch]))
    expect(t.worktree.path).toBe('/src/podium')
    expect(t.repoName).toBe('podium')
  })

  it('never picks a linked worktree', () => {
    const t = spawnTargetForRepo(repo([branch, own]))
    expect(t.worktree.isMain).toBe(true)
    expect(t.worktree.path).toBe('/src/podium')
  })

  it('label is the registered repo name even when clones differ', () => {
    const t = spawnTargetForRepo(repo([clone, own]))
    expect(t.repoName).toBe('podium')
  })

  it('reconstructs the main checkout when nothing matches the repo path', () => {
    const t = spawnTargetForRepo({ path: '/gone', name: 'gone', worktrees: [clone, branch] })
    expect(t.worktree).toEqual({ path: '/gone', repoPath: '/gone', isMain: true })
    expect(t.repoName).toBe('gone')
  })

  it('reconstructs the main checkout when the nav list is empty', () => {
    const t = spawnTargetForRepo({ path: '/r/a', name: 'a', worktrees: [] })
    expect(t.worktree).toEqual({ path: '/r/a', repoPath: '/r/a', isMain: true })
    expect(t.repoName).toBe('a')
  })

  it('uses the selected machine main checkout when one is provided', () => {
    const podium-host = navWt('/home/podium-host/podium', {
      repoPath: '/home/podium-host/podium',
      machineId: 'podium-host',
    })
    const vmi = navWt('/home/vmi34/podium', {
      repoPath: '/home/vmi34/podium',
      machineId: 'vmi34',
    })
    const t = spawnTargetForRepo(
      { path: '/home/podium-host/podium', name: 'podium', worktrees: [podium-host, vmi] },
      'vmi34',
    )
    expect(t.worktree).toMatchObject({
      path: '/home/vmi34/podium',
      repoPath: '/home/vmi34/podium',
      machineId: 'vmi34',
      isMain: true,
    })
    expect(t.repoName).toBe('podium')
  })
})

describe('sessionUrgencyRank / mostUrgentSession', () => {
  it('ranks needs-you AND finished-idle 0 (above working), working 1, stale/exited 3', () => {
    expect(sessionUrgencyRank(needsYou('a', '/w'), NOW)).toBe(0)
    expect(sessionUrgencyRank(working('b', '/w'), NOW)).toBe(1)
    // A just-finished agent is attention, not background — it outranks working.
    expect(sessionUrgencyRank(idle('c', '/w'), NOW)).toBe(0)
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
    const olderIdle = idle('i1', '/w', { lastActiveAt: new Date(NOW - 2 * HOUR).toISOString() })
    expect(mostUrgentSession([working('w1', '/w'), urgent, olderIdle], NOW)).toBe(urgent)
    expect(mostUrgentSession([], NOW)).toBeUndefined()
  })
})

describe('unifiedWorkList (content filter + status ordering)', () => {
  it('hides every issue with no live session — worktree/stage alone is not enough', () => {
    const rows = unifiedWorkList(
      emptySections([]),
      [
        issue({ id: 'b1', stage: 'backlog' }),
        issue({ id: 'd1', stage: 'done' }),
        issue({ id: 'p1', stage: 'planning' }), // non-backlog stage, but no session → hidden now
        issue({ id: 'wt1', stage: 'backlog', worktreePath: '/r/a/.worktrees/wt1' }), // worktree, no session → hidden
      ],
      [],
      ['/r/a/.worktrees/wt1'],
      NOW,
    )
    expect(rows).toEqual([])
  })

  it('includes an issue only when it has ≥1 non-archived live session', () => {
    const wt = '/r/a/.worktrees/i1'
    const rows = unifiedWorkList(
      emptySections([]),
      [
        issue({ id: 'w1', stage: 'backlog', worktreePath: wt }), // worktree, no session → hidden
        issue({ id: 's1', stage: 'backlog' }), // has a session → shown
        issue({ id: 'a1', stage: 'in_progress' }), // only an ARCHIVED session → hidden
      ],
      [
        sess('x', '/elsewhere', { issueId: 's1' }),
        sess('y', '/elsewhere', { issueId: 'a1', archived: true }),
      ],
      [wt],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['s1'])
  })

  it('includes drafts only when they have sessions; internal (audience:agent) issues stay out even with a session (#198)', () => {
    const rows = unifiedWorkList(
      emptySections([]),
      [
        issue({ id: 'dr1', draft: true, stage: 'backlog' }),
        issue({ id: 'dr2', draft: true, stage: 'backlog' }),
        // Internal, with a live session — still excluded from the human work list.
        issue({ id: 'ag1', audience: 'agent' as IssueWire['audience'], stage: 'in_progress' }),
      ],
      [sess('x', '/elsewhere', { issueId: 'dr2' }), sess('y', '/ag', { issueId: 'ag1' })],
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

  it('suppresses a worktree row whose sessions are ALL attached to live issues', () => {
    // Agent self-created worktree; the issue never stamped worktreePath. The
    // session already renders under the issue row — no duplicate worktree row.
    const wtPath = '/r/a/.worktrees/i1'
    const owned = idle('s', wtPath, { issueId: 'i1' })
    const wt = navWt(wtPath, { isMain: false, sessions: [owned] })
    const rows = unifiedWorkList(emptySections([wt]), [issue({ id: 'i1' })], [owned], [], NOW)
    expect(rows.map((r) => r.kind)).toEqual(['issue'])
  })

  it('a worktree row keeps only sessions NOT owned by a live issue (archived issues do not own)', () => {
    const wtPath = '/r/a/.worktrees/x'
    const owned = idle('s1', wtPath, { issueId: 'i1' })
    const free = idle('s2', wtPath)
    const orphanRef = idle('s3', wtPath, { issueId: 'gone-archived' })
    const wt = navWt(wtPath, { isMain: false, sessions: [owned, free, orphanRef] })
    const rows = unifiedWorkList(
      emptySections([wt]),
      [issue({ id: 'i1' })],
      [owned, free, orphanRef],
      [],
      NOW,
    )
    const wtRow = rows.find((r) => r.kind === 'worktree')
    expect(wtRow?.kind).toBe('worktree')
    expect(
      wtRow?.kind === 'worktree' ? wtRow.worktree.sessions.map((s) => s.sessionId) : [],
    ).toEqual(['s2', 's3'])
  })

  it('orders by rank asc (attention incl. finished first, then working)', () => {
    const iNeeds = issue({ id: 'needs' })
    const iWork = issue({ id: 'work' })
    const iIdle = issue({ id: 'idle' })
    const sessions = [
      needsYou('sn', '/x', { issueId: 'needs' }),
      working('sw', '/x'),
      idle('si', '/x', { issueId: 'idle' }),
    ]
    sessions[1] = { ...sessions[1], issueId: 'work' } as SessionMeta
    // Finished-idle shares rank 0 with needs-you; recency breaks the tie.
    sessions[2] = {
      ...sessions[2],
      lastActiveAt: new Date(NOW - 2 * HOUR).toISOString(),
    } as SessionMeta
    const rows = unifiedWorkList(emptySections([]), [iIdle, iWork, iNeeds], sessions, [], NOW)
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual([
      'needs',
      'idle',
      'work',
    ])
  })

  it('within a rank, most-recent child activity wins', () => {
    const older = issue({ id: 'old' })
    const newer = issue({ id: 'new' })
    const sessions = [
      idle('a', '/x', { issueId: 'old', lastActiveAt: new Date(NOW - 5 * HOUR).toISOString() }),
      idle('b', '/x', { issueId: 'new', lastActiveAt: new Date(NOW - HOUR).toISOString() }),
    ]
    const rows = unifiedWorkList(emptySections([]), [older, newer], sessions, [], NOW)
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['new', 'old'])
  })

  it('floats pinned & returned-from-defer to the top band, sinks snoozed to the bottom', () => {
    const pin = issue({ id: 'pin', pinned: true })
    const ret = issue({ id: 'ret', deferUntil: new Date(NOW - HOUR).toISOString() })
    const norm = issue({ id: 'norm' })
    const snz = issue({ id: 'snz', deferUntil: new Date(NOW + HOUR).toISOString() })
    const sessions = [
      idle('a', '/x', { issueId: 'pin' }),
      idle('b', '/x', { issueId: 'ret' }),
      idle('c', '/x', { issueId: 'norm' }),
      idle('d', '/x', { issueId: 'snz' }),
    ]
    const rows = unifiedWorkList(emptySections([]), [norm, snz, ret, pin], sessions, [], NOW)
    const ids = rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))
    expect(ids.slice(0, 2).sort()).toEqual(['pin', 'ret']) // top band
    expect(ids[2]).toBe('norm') // middle band
    expect(ids[3]).toBe('snz') // bottom band
  })
})

describe('isRowUnread (sidebar unread emphasis)', () => {
  const issueRow = (over: Partial<IssueWire>): Extract<UnifiedWorkRow, { kind: 'issue' }> => ({
    kind: 'issue',
    issue: issue(over),
    sessions: [],
    activityAt: NOW,
    rank: 0,
  })
  const wtRow = (sessions: SessionMeta[]): Extract<UnifiedWorkRow, { kind: 'worktree' }> => ({
    kind: 'worktree',
    worktree: navWt('/r/a/.worktrees/x', { isMain: false, sessions }),
    activityAt: NOW,
    rank: 0,
  })

  it('an issue row follows the issue own server-derived unread flag', () => {
    expect(isRowUnread(issueRow({ unread: true } as Partial<IssueWire>))).toBe(true)
    expect(isRowUnread(issueRow({ unread: false } as Partial<IssueWire>))).toBe(false)
  })

  it('a worktree row is unread iff ANY of its sessions is unread', () => {
    expect(
      isRowUnread(
        wtRow([
          idle('a', '/r/a/.worktrees/x', { unread: false } as Partial<SessionMeta>),
          idle('b', '/r/a/.worktrees/x', { unread: true } as Partial<SessionMeta>),
        ]),
      ),
    ).toBe(true)
    expect(
      isRowUnread(
        wtRow([idle('a', '/r/a/.worktrees/x', { unread: false } as Partial<SessionMeta>)]),
      ),
    ).toBe(false)
  })

  it('a sessionless worktree row is read', () => {
    expect(isRowUnread(wtRow([]))).toBe(false)
  })
})

describe('rowUnreadEmphasized (#138: suppress unread while actively working)', () => {
  const issueRow = (
    over: Partial<IssueWire>,
    sessions: SessionMeta[] = [],
  ): Extract<UnifiedWorkRow, { kind: 'issue' }> => ({
    kind: 'issue',
    issue: issue(over),
    sessions,
    activityAt: NOW,
    rank: 0,
  })
  const wtRow = (sessions: SessionMeta[]): Extract<UnifiedWorkRow, { kind: 'worktree' }> => ({
    kind: 'worktree',
    worktree: navWt('/r/a/.worktrees/x', { isMain: false, sessions }),
    activityAt: NOW,
    rank: 0,
  })

  it('emphasizes an unread issue row with no working session', () => {
    expect(
      rowUnreadEmphasized(issueRow({ unread: true } as Partial<IssueWire>, [idle('a', '/w')])),
    ).toBe(true)
  })

  it('suppresses an unread issue row that has a currently-working session', () => {
    expect(
      rowUnreadEmphasized(issueRow({ unread: true } as Partial<IssueWire>, [working('a', '/w')])),
    ).toBe(false)
  })

  it('suppresses an unread worktree row that has a currently-working session', () => {
    expect(
      rowUnreadEmphasized(
        wtRow([idle('a', '/w', { unread: true } as Partial<SessionMeta>), working('b', '/w')]),
      ),
    ).toBe(false)
  })

  it('leaves a read row un-emphasized regardless of working state', () => {
    expect(
      rowUnreadEmphasized(issueRow({ unread: false } as Partial<IssueWire>, [working('a', '/w')])),
    ).toBe(false)
  })
})

describe('isIssueSnoozed / issueReturnedFromDefer', () => {
  it('snoozed while deferUntil is in the future', () => {
    const future = new Date(NOW + HOUR).toISOString()
    expect(isIssueSnoozed(issue({ deferUntil: future }), NOW)).toBe(true)
    expect(issueReturnedFromDefer(issue({ deferUntil: future }), NOW)).toBe(false)
  })
  it('returned-from-defer once deferUntil has lapsed but is still set', () => {
    const past = new Date(NOW - HOUR).toISOString()
    expect(isIssueSnoozed(issue({ deferUntil: past }), NOW)).toBe(false)
    expect(issueReturnedFromDefer(issue({ deferUntil: past }), NOW)).toBe(true)
  })
  it('neither when deferUntil is unset', () => {
    expect(isIssueSnoozed(issue(), NOW)).toBe(false)
    expect(issueReturnedFromDefer(issue(), NOW)).toBe(false)
  })
})

describe('partitionUnifiedWork (WORKING move-out)', () => {
  const owned = (id: string, mk: (i: string, c: string) => SessionMeta, issueId: string) =>
    ({ ...mk(id, '/x'), issueId }) as SessionMeta

  it('moves a fully-working issue to WORKING and out of WORK', () => {
    const s = owned('w', working, 'i')
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [issue({ id: 'i' })],
      [s],
      [],
      NOW,
    )
    expect(work).toEqual([])
    expect(w.map((e) => e.kind)).toEqual(['issue'])
    expect(w[0]?.kind === 'issue' ? w[0].row.issue.id : '').toBe('i')
  })

  it('lifts working sessions from a partial issue; the issue stays in WORK with the rest', () => {
    const needs = owned('n', needsYou, 'i')
    const work1 = owned('w', working, 'i')
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [issue({ id: 'i' })],
      [needs, work1],
      [],
      NOW,
    )
    expect(work.map((r) => r.kind)).toEqual(['issue'])
    const row = work[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect(row.sessions.map((s) => s.sessionId)).toEqual(['n']) // working one removed
    expect(w.map((e) => e.kind)).toEqual(['session'])
    expect(w[0]?.kind === 'session' ? w[0].session.sessionId : '').toBe('w')
  })

  it('keeps a fully non-working issue entirely in WORK', () => {
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [issue({ id: 'i' })],
      [owned('a', idle, 'i')],
      [],
      NOW,
    )
    expect(w).toEqual([])
    expect(work.map((r) => r.kind)).toEqual(['issue'])
  })

  it('exempts a pinned issue from move-out (stays in WORK even when fully working)', () => {
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [issue({ id: 'i', pinned: true })],
      [owned('w', working, 'i')],
      [],
      NOW,
    )
    expect(w).toEqual([])
    expect(work.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['i'])
  })

  it('moves a fully-working unowned worktree to WORKING', () => {
    const wt = navWt('/r/a/.worktrees/x', {
      isMain: false,
      sessions: [working('s', '/r/a/.worktrees/x')],
    })
    const { working: w, work } = partitionUnifiedWork(emptySections([wt]), [], [], [], NOW)
    expect(work).toEqual([])
    expect(w.map((e) => e.kind)).toEqual(['worktree'])
  })
})

describe('archivedSessionsForIssue / archivedSessionsForWorktreePath', () => {
  it('returns only the archived members of an issue (issueId or containment)', () => {
    const live = sess('l', '/wt', { issueId: 'i' })
    const arch = sess('a', '/wt', { issueId: 'i', archived: true })
    const other = sess('o', '/wt', { issueId: 'j', archived: true })
    const got = archivedSessionsForIssue(
      issue({ id: 'i', worktreePath: '/wt' }),
      [live, arch, other],
      ['/wt'],
    )
    expect(got.map((s) => s.sessionId)).toEqual(['a'])
  })
  it('returns archived sessions contained in a worktree path', () => {
    const live = sess('l', '/wt')
    const arch = sess('a', '/wt', { archived: true })
    const got = archivedSessionsForWorktreePath([live, arch], '/wt', ['/wt'])
    expect(got.map((s) => s.sessionId)).toEqual(['a'])
  })
})

describe('groupUnifiedWorkRows', () => {
  const rowsFor = (
    issues: IssueWire[],
    sessions: SessionMeta[],
    worktrees: WorktreeNavView[] = [],
  ) => unifiedWorkList(emptySections(worktrees), issues, sessions, [], NOW)

  it('merges rows from different paths that share a repoId into one group', () => {
    const rows = rowsFor(
      [
        issue({ id: 'i1', repoPath: '/machine1/a', repoId: 'repo-a' } as Partial<IssueWire>),
        issue({ id: 'i2', repoPath: '/machine2/a', repoId: 'repo-a' } as Partial<IssueWire>),
      ],
      [idle('s1', '/x', { issueId: 'i1' }), idle('s2', '/x', { issueId: 'i2' })],
    )
    const groups = groupUnifiedWorkRows(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('repo-a')
    expect(groups[0]?.rows).toHaveLength(2)
  })

  it('falls back to repoPath when repoId is missing; labels from repoName / path tail', () => {
    const wt = navWt('/r/b/.worktrees/x', {
      isMain: false,
      repoPath: '/r/b',
      repoName: 'b',
      sessions: [idle('s1', '/r/b/.worktrees/x')],
    })
    const rows = rowsFor(
      [issue({ id: 'i1', repoPath: '/r/a' })],
      [idle('s0', '/x', { issueId: 'i1' })],
      [wt],
    )
    const groups = groupUnifiedWorkRows(rows)
    expect(groups.map((g) => g.key).sort()).toEqual(['/r/a', '/r/b'])
    expect(groups.find((g) => g.key === '/r/a')?.label).toBe('a')
    expect(groups.find((g) => g.key === '/r/b')?.label).toBe('b')
  })

  it('preserves incoming row order within groups and orders groups by first row', () => {
    const rows = rowsFor(
      [
        issue({ id: 'a-needs', repoPath: '/r/a' }),
        issue({ id: 'b-needs', repoPath: '/r/b' }),
        issue({ id: 'a-work', repoPath: '/r/a' }),
      ],
      [
        needsYou('s1', '/x', { issueId: 'a-needs' }),
        needsYou('s2', '/x', {
          issueId: 'b-needs',
          lastActiveAt: new Date(NOW - 2 * HOUR).toISOString(),
        }),
        working('s3', '/x'),
      ].map((s, i) => (i === 2 ? ({ ...s, issueId: 'a-work' } as SessionMeta) : s)),
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual([
      'a-needs',
      'b-needs',
      'a-work',
    ])
    const groups = groupUnifiedWorkRows(rows)
    expect(groups.map((g) => g.key)).toEqual(['/r/a', '/r/b'])
    expect(groups[0]?.rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual([
      'a-needs',
      'a-work',
    ])
  })

  it('groups worktree rows by worktree.repoId when present', () => {
    const wt1 = navWt('/m1/a/.worktrees/x', {
      isMain: false,
      repoPath: '/m1/a',
      repoName: 'a',
      repoId: 'repo-a',
      sessions: [idle('s1', '/m1/a/.worktrees/x')],
    })
    const wt2 = navWt('/m2/a/.worktrees/y', {
      isMain: false,
      repoPath: '/m2/a',
      repoName: 'a',
      repoId: 'repo-a',
      sessions: [idle('s2', '/m2/a/.worktrees/y')],
    })
    const groups = groupUnifiedWorkRows(rowsFor([], [], [wt1, wt2]))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('repo-a')
    expect(groups[0]?.label).toBe('a')
  })
})

describe('repoUsageAt', () => {
  const wire = (path: string, worktrees: { path: string }[] = []) =>
    ({ path, kind: 'repository', worktrees }) as never
  it('takes the max session activity over the repo root and its worktrees', () => {
    const r = wire('/src/a', [{ path: '/src/a/.worktrees/x' }])
    const s1 = sess('s1', '/src/a/pkg', { lastActiveAt: new Date(NOW - 2 * HOUR).toISOString() })
    const s2 = sess('s2', '/src/a/.worktrees/x', {
      lastActiveAt: new Date(NOW - HOUR).toISOString(),
    })
    const other = sess('s3', '/src/b', { lastActiveAt: new Date(NOW).toISOString() })
    expect(repoUsageAt(r, [s1, s2, other])).toBe(NOW - HOUR)
    expect(repoUsageAt(wire('/src/never'), [s1, s2, other])).toBe(0)
  })
  it('does not match sibling path prefixes without a boundary', () => {
    const r = wire('/src/a')
    const s1 = sess('s1', '/src/a-other')
    expect(repoUsageAt(r, [s1])).toBe(0)
  })
})
