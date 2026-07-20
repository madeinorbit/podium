// M6 coordinator elevate + started-by issue nesting (POD-902).
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  elevateCoordinatorSession,
  isCoordinatorSession,
  issueIdOwningSession,
  issueVisibleInSidebar,
  nestStartedByIssues,
  orderTabs,
  rowMotionPhase,
  rowStatusLine,
  rowWaitingCount,
  sessionVisibleInSidebar,
  type SidebarSections,
  type UnifiedIssueRow,
  unifiedWorkList,
} from './derive'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')
const HOUR = 3_600_000

function sess(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: id,
    cwd: '/r/a',
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: id,
    ...over,
  } as unknown as SessionMeta
}

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'i1',
    repoPath: '/r/a',
    seq: 1,
    title: 'Issue',
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

const emptySections = (): SidebarSections => ({
  pinnedPanels: [],
  pinnedWorktrees: [],
  pinnedRepos: [],
  repos: [],
})

describe('elevateCoordinatorSession / isCoordinatorSession', () => {
  it('moves the coordinator to the front; no-op when unset or missing', () => {
    const a = sess('a')
    const b = sess('b')
    const c = sess('c')
    expect(elevateCoordinatorSession([a, b, c], 'b').map((s) => s.sessionId)).toEqual([
      'b',
      'a',
      'c',
    ])
    expect(elevateCoordinatorSession([a, b, c], undefined)).toEqual([a, b, c])
    expect(elevateCoordinatorSession([a, b, c], 'gone')).toEqual([a, b, c])
    expect(elevateCoordinatorSession([a, b, c], 'a').map((s) => s.sessionId)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('isCoordinatorSession matches the issue field', () => {
    const iss = issue({ coordinatorSessionId: 'coord' })
    expect(isCoordinatorSession(iss, 'coord')).toBe(true)
    expect(isCoordinatorSession(iss, 'other')).toBe(false)
    expect(isCoordinatorSession(issue(), 'coord')).toBe(false)
  })

  it('orderTabs elevates coordinator ahead of pin order', () => {
    const a = sess('a')
    const b = sess('b')
    const c = sess('c')
    const ordered = orderTabs(
      [a, b, c],
      undefined,
      { panels: ['c'], worktrees: [], repos: [] },
      'b',
    )
    expect(ordered.map((s) => s.sessionId)).toEqual(['b', 'c', 'a'])
  })
})

describe('issueIdOwningSession', () => {
  it('prefers explicit issueId when the issue is in the set', () => {
    const s = sess('s1', { issueId: 'parent' })
    expect(issueIdOwningSession('s1', [s], [issue({ id: 'parent' })], [])).toBe('parent')
    expect(issueIdOwningSession('s1', [s], [issue({ id: 'other' })], [])).toBeNull()
  })

  it('falls back to worktree containment for unattached sessions', () => {
    const s = sess('s1', { cwd: '/r/a/wt' })
    const iss = issue({ id: 'wt-issue', worktreePath: '/r/a/wt' })
    expect(issueIdOwningSession('s1', [s], [iss], ['/r/a', '/r/a/wt'])).toBe('wt-issue')
  })
})

describe('nestStartedByIssues', () => {
  const row = (iss: IssueWire, sessions: SessionMeta[]): UnifiedIssueRow => ({
    kind: 'issue',
    issue: iss,
    sessions,
    activityAt: NOW,
    rank: 0,
  })

  it('nests a top-level agent-started issue under the starter session issue', () => {
    const parentSess = sess('starter', { issueId: 'parent' })
    const childSess = sess('worker', { issueId: 'child' })
    const parent = row(issue({ id: 'parent', title: 'Parent' }), [parentSess])
    const child = row(
      issue({
        id: 'child',
        title: 'Child',
        startedBySession: 'starter',
        origin: 'agent',
        seq: 2,
      }),
      [childSess],
    )
    const nested = nestStartedByIssues([parent, child], [parentSess, childSess], [])
    expect(nested).toHaveLength(1)
    const top = nested[0] as UnifiedIssueRow
    expect(top.issue.id).toBe('parent')
    expect(top.startedByChildren?.map((c) => c.issue.id)).toEqual(['child'])
  })

  it('keeps the issue top-level when the starter session is not in view', () => {
    const childSess = sess('worker', { issueId: 'child' })
    const child = row(
      issue({ id: 'child', startedBySession: 'missing-starter', origin: 'agent' }),
      [childSess],
    )
    const nested = nestStartedByIssues([child], [childSess], [])
    expect(nested).toHaveLength(1)
    expect((nested[0] as UnifiedIssueRow).issue.id).toBe('child')
    expect((nested[0] as UnifiedIssueRow).startedByChildren).toBeUndefined()
  })

  it('keeps the issue top-level when the starter session issue is not in the list', () => {
    // Starter lives on an issue that has no live sessions → not in sidebar rows.
    const starter = sess('starter', { issueId: 'hidden-parent' })
    const childSess = sess('worker', { issueId: 'child' })
    const child = row(issue({ id: 'child', startedBySession: 'starter', origin: 'agent' }), [
      childSess,
    ])
    // Only the child row is in the work list; hidden-parent is not.
    const nested = nestStartedByIssues([child], [starter, childSess], [])
    expect(nested).toHaveLength(1)
    expect((nested[0] as UnifiedIssueRow).issue.id).toBe('child')
  })

  it('nests formal sub-issues and lets parentId win over startedBy provenance', () => {
    const parentSess = sess('starter', { issueId: 'parent' })
    const childSess = sess('worker', { issueId: 'child' })
    const parent = row(issue({ id: 'parent' }), [parentSess])
    const child = row(
      issue({
        id: 'child',
        parentId: 'parent',
        startedBySession: 'starter',
        origin: 'agent',
      }),
      [childSess],
    )
    const nested = nestStartedByIssues([parent, child], [parentSess, childSess], [])
    expect(nested).toHaveLength(1)
    expect((nested[0] as UnifiedIssueRow).startedByChildren?.map((row) => row.issue.id)).toEqual([
      'child',
    ])
  })

  it('nests through a sessionless internal bookkeeping ancestor', () => {
    const parentSession = sess('parent-worker', { issueId: 'parent' })
    const childSession = sess('child-worker', { issueId: 'child' })
    const parentIssue = issue({ id: 'parent' })
    const hiddenInternal = issue({
      id: 'hidden',
      parentId: 'parent',
      audience: 'agent',
      origin: 'agent',
    })
    const childIssue = issue({
      id: 'child',
      parentId: 'hidden',
      audience: 'agent',
      origin: 'agent',
    })
    const nested = nestStartedByIssues(
      [row(parentIssue, [parentSession]), row(childIssue, [childSession])],
      [parentSession, childSession],
      [],
      [parentIssue, hiddenInternal, childIssue],
      NOW,
    )
    expect((nested[0] as UnifiedIssueRow).startedByChildren?.[0]?.issue.id).toBe('child')
  })

  it('does not hide either issue on a started-by cycle', () => {
    const sA = sess('sa', { issueId: 'a' })
    const sB = sess('sb', { issueId: 'b' })
    const a = row(issue({ id: 'a', startedBySession: 'sb', origin: 'agent' }), [sA])
    const b = row(issue({ id: 'b', startedBySession: 'sa', origin: 'agent' }), [sB])
    const nested = nestStartedByIssues([a, b], [sA, sB], [])
    // First edge wins; second is cycle-rejected → one nests, the other stays top
    // OR both stay top. Either way neither is dropped.
    const topIds = nested.map((r) => (r as UnifiedIssueRow).issue.id)
    const childIds = nested.flatMap((r) =>
      r.kind === 'issue' ? (r.startedByChildren?.map((c) => c.issue.id) ?? []) : [],
    )
    const all = new Set([...topIds, ...childIds])
    expect(all.has('a')).toBe(true)
    expect(all.has('b')).toBe(true)
    expect(topIds.length + childIds.length).toBe(2)
  })

  it('bubbles descendant attention and activity to every ancestor row', () => {
    const parentSess = sess('parent-idle', { issueId: 'parent' })
    const childSess = sess('child-waiting', {
      issueId: 'child',
      agentState: {
        phase: 'needs_user',
        since: new Date(NOW - HOUR).toISOString(),
        nativeSubagentCount: 0,
        need: { kind: 'question' },
      },
    })
    const parent = row(issue({ id: 'parent' }), [parentSess])
    const child = row(
      issue({ id: 'child', parentId: 'parent', audience: 'agent', origin: 'agent' }),
      [childSess],
    )
    const nested = nestStartedByIssues([parent, child], [parentSess, childSess], [])
    const top = nested[0] as UnifiedIssueRow
    expect(top.aggregateSessions?.map((session) => session.sessionId)).toEqual([
      'parent-idle',
      'child-waiting',
    ])
    expect(rowMotionPhase(top)).toBe('waiting')
    expect(rowWaitingCount(top)).toBe(1)
  })

  it('never leaves an internal issue at top level', () => {
    const worker = sess('worker', { issueId: 'internal' })
    const internal = row(issue({ id: 'internal', audience: 'agent', origin: 'agent' }), [worker])
    expect(nestStartedByIssues([internal], [worker], [])).toEqual([])
  })
})

describe('sidebar completion decay [spec:SP-6144]', () => {
  it('keeps unseen completions, then applies a 24h grace after read', () => {
    const stoppedAt = new Date(NOW - 48 * HOUR).toISOString()
    const oldRead = new Date(NOW - 47 * HOUR).toISOString()
    const recentRead = new Date(NOW - HOUR).toISOString()
    const stopped = sess('stopped', {
      status: 'hibernated',
      stoppedAt,
      stopReason: 'self',
      readAt: oldRead,
      unread: false,
    })
    expect(sessionVisibleInSidebar({ ...stopped, unread: true }, NOW)).toBe(true)
    expect(sessionVisibleInSidebar(stopped, NOW)).toBe(false)
    expect(sessionVisibleInSidebar({ ...stopped, readAt: recentRead }, NOW)).toBe(true)
  })

  it('keeps a sessionless completed MILESTONE CHILD until seen plus 24h; top-level stays out', () => {
    const finishedAt = new Date(NOW - 48 * HOUR).toISOString()
    const parent = issue({ id: 'parent', stage: 'in_progress' })
    const worker = sess('worker', { issueId: parent.id })
    const completed = issue({
      id: 'completed',
      stage: 'done',
      parentId: parent.id,
      updatedAt: finishedAt,
      readAt: null,
      unread: true,
    })
    expect(issueVisibleInSidebar(completed, NOW)).toBe(true)
    const rows = unifiedWorkList(emptySections(), [parent, completed], [worker], [], NOW)
    const flat = JSON.stringify(rows)
    expect(flat).toContain('"completed"')
    const seen = { ...completed, unread: false, readAt: new Date(NOW - HOUR).toISOString() }
    expect(issueVisibleInSidebar(seen, NOW)).toBe(true)
    const expired = { ...completed, unread: false, readAt: new Date(NOW - 47 * HOUR).toISOString() }
    expect(issueVisibleInSidebar(expired, NOW)).toBe(false)
    expect(
      JSON.stringify(unifiedWorkList(emptySections(), [parent, expired], [worker], [], NOW)),
    ).not.toContain('"completed"')
    // A sessionless finished issue with NO parent (the historical done backlog,
    // unread since before readAt existed) must never resurface at top level.
    const topLevel = { ...completed, parentId: undefined }
    expect(unifiedWorkList(emptySections(), [topLevel], [], [], NOW)).toEqual([])
  })

  it('surfaces descendant completion progress on ancestor status', () => {
    const worker = sess('worker')
    const parent: UnifiedIssueRow = {
      kind: 'issue',
      issue: issue({ childCount: 6, childDoneCount: 4 }),
      sessions: [worker],
      activityAt: NOW,
      rank: 1,
    }
    // POD-85 grammar: progress speaks of subtasks ("done · 0/1 done" read as
    // nonsense before).
    expect(rowStatusLine(parent, NOW)).toContain('4/6 subtasks')
  })

  it('excludes proposed issues even if a session is attached', () => {
    const proposal = issue({ id: 'proposal', stage: 'proposed' })
    const worker = sess('worker', { issueId: proposal.id })
    expect(unifiedWorkList(emptySections(), [proposal], [worker], [], NOW)).toEqual([])
  })
})

describe('unifiedWorkList + coordinator + started-by', () => {
  it('elevates coordinator among issue sessions and nests started-by children', () => {
    const parentSess = sess('coord', {
      issueId: 'parent',
      lastActiveAt: new Date(NOW - 2 * HOUR).toISOString(),
    })
    const helper = sess('helper', {
      issueId: 'parent',
      lastActiveAt: new Date(NOW - HOUR).toISOString(),
    })
    const childSess = sess('child-agent', { issueId: 'child' })
    const parent = issue({
      id: 'parent',
      title: 'Parent',
      coordinatorSessionId: 'coord',
      createdAt: '2026-06-01T00:00:00.000Z',
      seq: 1,
    })
    const child = issue({
      id: 'child',
      title: 'Started child',
      startedBySession: 'coord',
      origin: 'agent',
      createdAt: '2026-06-02T00:00:00.000Z',
      seq: 2,
    })
    const rows = unifiedWorkList(
      emptySections(),
      [parent, child],
      [helper, parentSess, childSess],
      [],
      NOW,
    )
    expect(rows).toHaveLength(1)
    const top = rows[0] as UnifiedIssueRow
    expect(top.issue.id).toBe('parent')
    // Coordinator first even though helper is more recent.
    expect(top.sessions.map((s) => s.sessionId)).toEqual(['coord', 'helper'])
    expect(top.startedByChildren?.map((c) => c.issue.id)).toEqual(['child'])
  })
})
