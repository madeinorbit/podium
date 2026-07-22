import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  archivedSessionsForIssue,
  archivedSessionsForWorktreePath,
  branchRollup,
  deepAttentionSource,
  groupUnifiedWorkRows,
  isIssueSnoozed,
  isRowUnread,
  issueReturnedFromDefer,
  issueVisibleInSidebar,
  mostUrgentSession,
  partitionUnifiedWork,
  type RepoNavView,
  repoUsageAt,
  rowStatusLine,
  rowUnreadEmphasized,
  rowWaitingCount,
  type SidebarSections,
  sessionUrgencyRank,
  spawnTargetForRepo,
  splitPinnedWork,
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
    const hostMain = navWt('/home/podium-host/podium', {
      repoPath: '/home/podium-host/podium',
      machineId: 'podium-host',
    })
    const vmi = navWt('/home/vmi34/podium', {
      repoPath: '/home/vmi34/podium',
      machineId: 'vmi34',
    })
    const t = spawnTargetForRepo(
      { path: '/home/podium-host/podium', name: 'podium', worktrees: [hostMain, vmi] },
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
  it('keeps started human work visible without a live session, but not backlog or plain done', () => {
    const rows = unifiedWorkList(
      emptySections([]),
      [
        issue({ id: 'b1', stage: 'backlog' }),
        issue({ id: 'd1', stage: 'done' }),
        issue({ id: 'p1', stage: 'planning' }), // started lifecycle survives session retirement
        issue({ id: 'wt1', stage: 'backlog', worktreePath: '/r/a/.worktrees/wt1' }), // worktree, no session → hidden
      ],
      [],
      ['/r/a/.worktrees/wt1'],
      NOW,
    )
    expect(rows.map((row) => (row.kind === 'issue' ? row.issue.id : ''))).toEqual(['p1'])
  })

  it('keeps an active issue when its only session is archived', () => {
    const wt = '/r/a/.worktrees/i1'
    const rows = unifiedWorkList(
      emptySections([]),
      [
        issue({ id: 'w1', stage: 'backlog', worktreePath: wt }), // worktree, no session → hidden
        issue({ id: 's1', stage: 'backlog' }), // has a session → shown
        issue({ id: 'a1', stage: 'in_progress' }), // issue lifecycle outlives retired session
      ],
      [
        sess('x', '/elsewhere', { issueId: 's1' }),
        sess('y', '/elsewhere', { issueId: 'a1', archived: true }),
      ],
      [wt],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['a1', 's1'])
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

  it('never promotes session-bearing worktrees into pseudo-issue rows', () => {
    const withSess = navWt('/r/a/.worktrees/x', {
      isMain: false,
      sessions: [idle('s', '/r/a/.worktrees/x')],
    })
    const bare = navWt('/r/a')
    const rows = unifiedWorkList(emptySections([withSess, bare]), [], [], [], NOW)
    expect(rows).toEqual([])
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

  it('keeps unattached and orphaned sessions out of the issue-only work list', () => {
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
    expect(rows.map((row) => (row.kind === 'issue' ? row.issue.id : row.kind))).toEqual(['i1'])
  })

  it('orders newest-created first — immutable creation order, not urgency (#64)', () => {
    // The OLDEST issue carries the most urgent session; the NEWEST is idle.
    // Creation order must win regardless.
    const oldest = issue({ id: 'oldest', seq: 1, createdAt: '2026-06-01T00:00:00.000Z' })
    const middle = issue({ id: 'middle', seq: 2, createdAt: '2026-06-10T00:00:00.000Z' })
    const newest = issue({ id: 'newest', seq: 3, createdAt: '2026-06-20T00:00:00.000Z' })
    const sessions = [
      needsYou('sn', '/x', { issueId: 'oldest' }),
      { ...working('sw', '/x'), issueId: 'middle' } as SessionMeta,
      idle('si', '/x', { issueId: 'newest' }),
    ]
    const rows = unifiedWorkList(emptySections([]), [oldest, newest, middle], sessions, [], NOW)
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual([
      'newest',
      'middle',
      'oldest',
    ])
  })

  it('never reorders on activity/attention changes — seq then id break created-at ties', () => {
    const t = '2026-06-15T00:00:00.000Z'
    const a = issue({ id: 'a', seq: 5, createdAt: t })
    const b = issue({ id: 'b', seq: 7, createdAt: t })
    const quiet = [
      idle('sa', '/x', { issueId: 'a', lastActiveAt: new Date(NOW - 5 * HOUR).toISOString() }),
      idle('sb', '/x', { issueId: 'b', lastActiveAt: new Date(NOW - 5 * HOUR).toISOString() }),
    ]
    const before = unifiedWorkList(emptySections([]), [a, b], quiet, [], NOW)
    // Same createdAt → higher seq (created later) first.
    expect(before.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['b', 'a'])
    // Agent on the LOWER row starts working and needs the human: order holds.
    const busy = [
      needsYou('sa', '/x', { issueId: 'a', lastActiveAt: new Date(NOW).toISOString() }),
      quiet[1] as SessionMeta,
    ]
    const after = unifiedWorkList(emptySections([]), [a, b], busy, [], NOW)
    expect(after.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['b', 'a'])
  })

  it('ignores worktree rows while preserving issue order', () => {
    const i = issue({ id: 'i', createdAt: '2026-06-01T00:00:00.000Z' })
    const wtB = navWt('/r/a/b', { isMain: false, sessions: [idle('w1', '/r/a/b')] })
    const wtA = navWt('/r/a/a', { isMain: false, sessions: [idle('w2', '/r/a/a')] })
    const rows = unifiedWorkList(
      emptySections([wtB, wtA]),
      [i],
      [idle('si', '/x', { issueId: 'i' }), idle('w1', '/r/a/b'), idle('w2', '/r/a/a')],
      ['/r/a/b', '/r/a/a'],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : r.worktree.path))).toEqual(['i'])
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

describe('splitPinnedWork (PINNED section, POD-166)', () => {
  it('moves pinned issue rows out into the pinned list, preserving order', () => {
    const pinA = issue({ id: 'pinA', pinned: true })
    const pinB = issue({ id: 'pinB', pinned: true, createdAt: new Date(NOW - HOUR).toISOString() })
    const norm = issue({ id: 'norm' })
    const sessions = [
      idle('a', '/x', { issueId: 'pinA' }),
      idle('b', '/x', { issueId: 'pinB' }),
      idle('c', '/x', { issueId: 'norm' }),
    ]
    const rows = unifiedWorkList(emptySections([]), [norm, pinA, pinB], sessions, [], NOW)
    const { pinned, rest } = splitPinnedWork(rows)
    // Banded creation order carries over: pinB is newer-created, so it leads.
    expect(pinned.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['pinB', 'pinA'])
    // Move, not copy: the pinned rows are gone from the rest of the list.
    expect(rest.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['norm'])
  })

  it('leaves worktree rows and unpinned issues untouched', () => {
    const rows = unifiedWorkList(
      emptySections([]),
      [issue({ id: 'i' })],
      [idle('a', '/x', { issueId: 'i' })],
      [],
      NOW,
    )
    const { pinned, rest } = splitPinnedWork(rows)
    expect(pinned).toEqual([])
    expect(rest).toEqual(rows)
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

  it('shows a working pinned issue in BOTH WORKING and WORK (no move-out)', () => {
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [issue({ id: 'i', pinned: true })],
      [owned('w', working, 'i')],
      [],
      NOW,
    )
    expect(work.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['i'])
    expect(w.map((e) => (e.kind === 'issue' ? e.row.issue.id : e.kind))).toEqual(['i'])
  })

  it('keeps a partially-working pinned issue whole in WORK and mirrors it into WORKING', () => {
    const needs = owned('n', needsYou, 'i')
    const run = owned('w', working, 'i')
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [issue({ id: 'i', pinned: true })],
      [needs, run],
      [],
      NOW,
    )
    const row = work[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect(row.sessions.map((s) => s.sessionId).sort()).toEqual(['n', 'w'])
    expect(w.map((e) => e.kind)).toEqual(['issue'])
  })

  it('keeps an idle pinned issue out of WORKING', () => {
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [issue({ id: 'i', pinned: true })],
      [owned('a', idle, 'i')],
      [],
      NOW,
    )
    expect(w).toEqual([])
    expect(work.map((r) => r.kind)).toEqual(['issue'])
  })

  it('keeps a hibernated session with a preserved working phase out of WORKING (#161)', () => {
    // The server intentionally keeps agentState.phase='working' across a
    // hibernate; the parked status is ground truth and overrides it.
    const parked = {
      ...owned('h', working, 'i'),
      status: 'hibernated',
    } as SessionMeta
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [issue({ id: 'i' })],
      [parked],
      [],
      NOW,
    )
    expect(w).toEqual([])
    expect(work.map((r) => r.kind)).toEqual(['issue'])
  })

  it('keeps a fully-working unowned worktree out of both sidebar partitions', () => {
    const wt = navWt('/r/a/.worktrees/x', {
      isMain: false,
      sessions: [working('s', '/r/a/.worktrees/x')],
    })
    const { working: w, work } = partitionUnifiedWork(emptySections([wt]), [], [], [], NOW)
    expect(work).toEqual([])
    expect(w).toEqual([])
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

  it('falls back to repoPath when repoId is missing and ignores worktree-only groups', () => {
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
    expect(groups.map((g) => g.key).sort()).toEqual(['/r/a'])
    expect(groups.find((g) => g.key === '/r/a')?.label).toBe('a')
  })

  it('preserves incoming creation order within groups and orders groups by first row (#64)', () => {
    // Newest issue overall lives in /r/a, so /r/a groups first; inside each
    // group rows keep the newest-created-first order — urgency never matters.
    const rows = rowsFor(
      [
        issue({ id: 'a-new', repoPath: '/r/a', seq: 3, createdAt: '2026-06-20T00:00:00.000Z' }),
        issue({ id: 'b-mid', repoPath: '/r/b', seq: 2, createdAt: '2026-06-10T00:00:00.000Z' }),
        issue({ id: 'a-old', repoPath: '/r/a', seq: 1, createdAt: '2026-06-01T00:00:00.000Z' }),
      ],
      [
        idle('s1', '/x', { issueId: 'a-new' }),
        needsYou('s2', '/x', { issueId: 'b-mid' }),
        { ...working('s3', '/x'), issueId: 'a-old' } as SessionMeta,
      ],
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual([
      'a-new',
      'b-mid',
      'a-old',
    ])
    const groups = groupUnifiedWorkRows(rows)
    expect(groups.map((g) => g.key)).toEqual(['/r/a', '/r/b'])
    expect(groups[0]?.rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual([
      'a-new',
      'a-old',
    ])
  })

  it('does not create groups for worktrees even when they share a repoId', () => {
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
    expect(groups).toEqual([])
  })

  it('folds only settled top-level closures while open selection stays visible', () => {
    const closedRow = (
      id: string,
      over: Partial<IssueWire> = {},
      sessions: SessionMeta[] = [],
    ): UnifiedWorkRow => ({
      kind: 'issue',
      issue: issue({
        id,
        stage: 'done',
        closedReason: 'done',
        unread: false,
        readAt: new Date(NOW - HOUR).toISOString(),
        ...over,
      }),
      sessions,
      activityAt: NOW,
      rank: 4,
    })
    const rows: UnifiedWorkRow[] = [
      closedRow('settled'),
      closedRow('unread', { unread: true, readAt: undefined }),
      closedRow('selected'),
      closedRow('child', { parentId: 'parent' }),
      closedRow('awaiting', {
        branch: 'issue/awaiting',
        gitState: { shared: false, merged: false, ahead: 1 } as IssueWire['gitState'],
      }),
      closedRow('needs-human', { needsHuman: true }),
      closedRow('working', {}, [working('worker', '/r/a')]),
      closedRow('done-only', { closedReason: undefined }),
    ]

    const [group] = groupUnifiedWorkRows(rows, 'selected')
    expect(group?.closedRows.map((row) => row.issue.id)).toEqual(['settled'])
    expect(
      group?.rows.map((row) => (row.kind === 'issue' ? row.issue.id : row.worktree.path)),
    ).toEqual(['unread', 'selected', 'child', 'awaiting', 'needs-human', 'working', 'done-only'])
  })

  it('keeps a selected closure in its closed-time order', () => {
    const closedRow = (id: string, daysAgo: number): UnifiedWorkRow => ({
      kind: 'issue',
      issue: issue({
        id,
        stage: 'done',
        closedReason: 'done',
        unread: false,
        readAt: new Date(NOW - HOUR).toISOString(),
        closedAt: new Date(NOW - daysAgo * 24 * HOUR).toISOString(),
      }),
      sessions: [],
      activityAt: NOW,
      rank: 4,
    })

    const [group] = groupUnifiedWorkRows(
      [closedRow('oldest', 3), closedRow('selected', 2), closedRow('newest', 1)],
      'selected',
      true,
    )

    expect(group?.closedRows.map((row) => row.issue.id)).toEqual(['newest', 'selected', 'oldest'])
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

describe('POD-996 review fixes: ancestor-chain surfacing, decay anchors, no double-render', () => {
  const DAY = 24 * HOUR

  it('H1/L6: a live internal session deep under sessionless ancestors surfaces under its tracked human root', () => {
    const root = issue({ id: 'root', title: 'Epic', audience: 'human' })
    const mid = issue({ id: 'mid', audience: 'agent' as IssueWire['audience'], parentId: 'root' })
    const leaf = issue({ id: 'leaf', audience: 'agent' as IssueWire['audience'], parentId: 'mid' })
    const rows = unifiedWorkList(
      emptySections([]),
      [root, mid, leaf],
      [{ ...working('w', '/x'), issueId: 'leaf' } as SessionMeta],
      [],
      NOW,
    )
    // Exactly one top-level row: the human root. The working leaf is nested
    // beneath it (via the leaf row), never dropped, never a bare top-level row.
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['root'])
    const rootRow = rows[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect((rootRow.aggregateSessions ?? []).map((s) => s.sessionId)).toContain('w')
  })

  it('H1: rescued human ancestors render under their tracked root, not as extra roots', () => {
    const root = issue({ id: 'root', title: 'Root', audience: 'human' })
    const mid = issue({ id: 'mid', title: 'Mid', audience: 'human', parentId: 'root' })
    const leaf = issue({ id: 'leaf', audience: 'agent' as IssueWire['audience'], parentId: 'mid' })
    const rows = unifiedWorkList(
      emptySections([]),
      [root, mid, leaf],
      [{ ...working('w', '/x'), issueId: 'leaf' } as SessionMeta],
      [],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['root'])
    const rootRow = rows[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect((rootRow.startedByChildren ?? []).map((c) => c.issue.id)).toEqual(['mid'])
  })

  it('B5: a finished ancestor is not resurrected as a rescue row', () => {
    const doneParent = issue({
      id: 'p',
      stage: 'done',
      audience: 'human',
      closedAt: new Date(NOW - 30 * DAY).toISOString(),
    })
    const leaf = issue({ id: 'leaf', audience: 'agent' as IssueWire['audience'], parentId: 'p' })
    const rows = unifiedWorkList(
      emptySections([]),
      [doneParent, leaf],
      [{ ...working('w', '/x'), issueId: 'leaf' } as SessionMeta],
      [],
      NOW,
    )
    // No live human ancestor: the long-closed epic must not reappear.
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).not.toContain('p')
  })

  it('POD-183: closed top-level human issues persist for folding without changing done decay', () => {
    const old = new Date(NOW - 30 * DAY).toISOString()
    expect(
      issueVisibleInSidebar(
        issue({
          stage: 'done',
          closedReason: 'done',
          audience: 'human',
          unread: true,
          readAt: undefined,
          closedAt: old,
        }),
        NOW,
      ),
    ).toBe(true)
    expect(
      issueVisibleInSidebar(
        issue({
          stage: 'done',
          closedReason: 'done',
          audience: 'human',
          unread: false,
          readAt: old,
          closedAt: old,
        }),
        NOW,
      ),
    ).toBe(true)
    expect(issueVisibleInSidebar(issue({ stage: 'done', closedAt: old }), NOW)).toBe(false)
  })

  it('B5: unread keeps a finished issue visible only within 7 days of finishing (closedAt anchor)', () => {
    const base = { stage: 'done' as IssueWire['stage'], unread: true, readAt: undefined }
    expect(
      issueVisibleInSidebar(
        issue({ ...base, closedAt: new Date(NOW - 2 * DAY).toISOString() }),
        NOW,
      ),
    ).toBe(true)
    expect(
      issueVisibleInSidebar(
        issue({ ...base, closedAt: new Date(NOW - 10 * DAY).toISOString() }),
        NOW,
      ),
    ).toBe(false)
    // Legacy row without closedAt falls back to updatedAt.
    expect(
      issueVisibleInSidebar(
        issue({ ...base, updatedAt: new Date(NOW - 10 * DAY).toISOString() }),
        NOW,
      ),
    ).toBe(false)
  })

  it('M3: post-close churn (updatedAt) does not restart the 24h read grace — closedAt anchors', () => {
    const churned = issue({
      stage: 'done',
      unread: false,
      readAt: new Date(NOW - 3 * DAY).toISOString(),
      closedAt: new Date(NOW - 3 * DAY).toISOString(),
      updatedAt: new Date(NOW - HOUR).toISOString(), // steward touch after close
    })
    expect(issueVisibleInSidebar(churned, NOW)).toBe(false)
    const fresh = issue({
      stage: 'done',
      unread: false,
      readAt: new Date(NOW - 2 * HOUR).toISOString(),
      closedAt: new Date(NOW - 3 * DAY).toISOString(),
    })
    expect(issueVisibleInSidebar(fresh, NOW)).toBe(true)
  })

  it('H3: a working nested child session is not lifted out of its parent row (no double-render)', () => {
    const parent = issue({ id: 'p', title: 'Parent', audience: 'human' })
    const child = issue({ id: 'c', audience: 'agent' as IssueWire['audience'], parentId: 'p' })
    const idleOwn = { ...idle('own', '/x'), issueId: 'p' } as SessionMeta
    const workingChild = { ...working('cw', '/y'), issueId: 'c' } as SessionMeta
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [parent, child],
      [idleOwn, workingChild],
      [],
      NOW,
    )
    // The child's working session renders once, under the kept parent row —
    // nothing is lifted into WORKING.
    expect(w).toEqual([])
    expect(work.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['p'])
    const row = work[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect(row.sessions.map((s) => s.sessionId)).toEqual(['own'])
    expect((row.startedByChildren ?? []).map((c) => c.issue.id)).toEqual(['c'])
  })

  it('H3: a row with nested children never moves whole into WORKING off a descendant', () => {
    const parent = issue({ id: 'p', title: 'Parent', audience: 'human' })
    const child = issue({ id: 'c', audience: 'agent' as IssueWire['audience'], parentId: 'p' })
    const workingOwn = { ...working('own', '/x'), issueId: 'p' } as SessionMeta
    const workingChild = { ...working('cw', '/y'), issueId: 'c' } as SessionMeta
    const { working: w, work } = partitionUnifiedWork(
      emptySections([]),
      [parent, child],
      [workingOwn, workingChild],
      [],
      NOW,
    )
    // Own working session lifts individually; the row (with its child) stays.
    expect(work.map((r) => (r.kind === 'issue' ? r.issue.id : ''))).toEqual(['p'])
    expect(w.map((e) => (e.kind === 'session' ? e.session.sessionId : e.kind))).toEqual(['own'])
  })
})

describe('POD-171: depth roll-up + branch attention (L3/L4/L5)', () => {
  const DAY = 24 * HOUR
  // A three-deep formal tree: root > mid > leaf, with the needs-you at the leaf.
  const tree = () => {
    const root = issue({ id: 'root', seq: 1, title: 'Epic', audience: 'human' })
    const mid = issue({ id: 'mid', seq: 2, title: 'Mid', audience: 'human', parentId: 'root' })
    const leaf = issue({
      id: 'leaf',
      seq: 3,
      audience: 'agent' as IssueWire['audience'],
      parentId: 'mid',
    })
    return { root, mid, leaf }
  }
  const rowsFor = (issues: IssueWire[], sessions: SessionMeta[]) =>
    unifiedWorkList(emptySections([]), issues, sessions, [], NOW)

  it('L3: the parent pill counts needs-you across the whole branch, rolled-up depth included', () => {
    const { root, mid, leaf } = tree()
    const rows = rowsFor(
      [root, mid, leaf],
      [
        { ...working('rw', '/x'), issueId: 'root' } as SessionMeta,
        { ...needsYou('lw', '/y'), issueId: 'leaf' } as SessionMeta,
      ],
    )
    const rootRow = rows[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect(rootRow.issue.id).toBe('root')
    expect(rowWaitingCount(rootRow)).toBe(1)
    // The depth-1 child aggregates its own hidden branch too.
    const midRow = (rootRow.startedByChildren ?? [])[0]
    expect(midRow?.issue.id).toBe('mid')
    expect(rowWaitingCount(midRow as UnifiedWorkRow)).toBe(1)
  })

  it('L3: the sub-line whispers the deepest source when the yellow is beyond visible depth', () => {
    const { root, mid, leaf } = tree()
    const rows = rowsFor(
      [root, mid, leaf],
      [
        { ...working('rw', '/x'), issueId: 'root' } as SessionMeta,
        { ...needsYou('lw', '/y'), issueId: 'leaf' } as SessionMeta,
      ],
    )
    const rootRow = rows[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect(deepAttentionSource(rootRow)).toMatchObject({ depth: 2 })
    expect(rowStatusLine(rootRow, NOW)).toBe('2 agents · working · deep: #3 needs you')
    // A depth-capped child (visibleDepth 0) whispers even for a direct child source.
    const midRow = (rootRow.startedByChildren ?? [])[0] as Extract<
      UnifiedWorkRow,
      { kind: 'issue' }
    >
    expect(rowStatusLine(midRow, NOW, 0)).toBe('deep: #3 needs you')
  })

  it('L3: a VISIBLE waiting child explains itself — no whisper at default depth', () => {
    const { root, mid } = tree()
    const rows = rowsFor(
      [root, mid],
      [
        { ...working('rw', '/x'), issueId: 'root' } as SessionMeta,
        { ...needsYou('mw', '/y'), issueId: 'mid' } as SessionMeta,
      ],
    )
    const rootRow = rows[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect(rowWaitingCount(rootRow)).toBe(1)
    expect(rowStatusLine(rootRow, NOW)).not.toContain('deep:')
  })

  it('L4: branchRollup counts ALL descendants via parentId — decayed done children included', () => {
    const { root, mid, leaf } = tree()
    // Done grandchild long past its decay window: gone from rows, kept in k/m.
    const settled = issue({
      id: 'settled',
      seq: 4,
      parentId: 'mid',
      stage: 'done',
      readAt: new Date(NOW - 30 * DAY).toISOString(),
      closedAt: new Date(NOW - 30 * DAY).toISOString(),
    })
    const ghost = issue({ id: 'ghost', seq: 5, parentId: 'mid', archived: true })
    expect(branchRollup([root, mid, leaf, settled, ghost], 'mid')).toEqual({ total: 2, done: 1 })
    expect(branchRollup([root, mid, leaf, settled, ghost], 'root')).toEqual({ total: 3, done: 1 })
    expect(branchRollup([root, mid, leaf, settled, ghost], 'leaf')).toEqual({ total: 0, done: 0 })
  })

  it('L5: the shipped done-decay applies to nested children — no fold, just the clock', () => {
    const { root } = tree()
    const doneChild = (over: Partial<IssueWire>) =>
      issue({
        id: 'dc',
        seq: 9,
        audience: 'human',
        parentId: 'root',
        stage: 'done' as IssueWire['stage'],
        unread: true,
        ...over,
      })
    const own = { ...working('rw', '/x'), issueId: 'root' } as SessionMeta
    // Inside the 7-day unread window: the sessionless done child keeps its nested row.
    const fresh = rowsFor(
      [root, doneChild({ closedAt: new Date(NOW - 2 * DAY).toISOString() })],
      [own],
    )
    const rootRow = fresh[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect((rootRow.startedByChildren ?? []).map((c) => c.issue.id)).toEqual(['dc'])
    // Past the window: the row decays away — history lives in k/m and the peek.
    const stale = rowsFor(
      [root, doneChild({ closedAt: new Date(NOW - 10 * DAY).toISOString() })],
      [own],
    )
    const staleRoot = stale[0] as Extract<UnifiedWorkRow, { kind: 'issue' }>
    expect(staleRoot.startedByChildren ?? []).toEqual([])
  })
})
