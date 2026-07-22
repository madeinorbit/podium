// POD-168 — manual order via persisted sortKey (POD-100 §4, R1/R2):
// keyed rows sort ascending by key within their band; unkeyed legacy rows keep
// newest-first creation order below keyed rows; snoozed still sinks and nothing
// else (urgency/activity) sorts; a parent's children sort by their own keys.
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type SidebarSections, type UnifiedIssueRow, unifiedWorkList } from './derive'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')
const HOUR = 3_600_000

// Rows need a live member session to surface in the unified list.
function sess(id: string, issueId: string): SessionMeta {
  return {
    sessionId: id,
    issueId,
    cwd: '/r/a',
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: id,
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
  pinnedWorktrees: [],
  pinnedRepos: [],
  repos: [],
})

const idsOf = (rows: ReturnType<typeof unifiedWorkList>): string[] =>
  rows.map((r) => (r.kind === 'issue' ? r.issue.id : `wt:${r.worktree.path}`))

describe('sortKey manual order (POD-168)', () => {
  it('keyed rows sort ascending by key, ignoring creation order', () => {
    const rows = unifiedWorkList(
      emptySections(),
      [
        issue({ id: 'a', seq: 1, sortKey: 'r', createdAt: '2026-06-03T00:00:00.000Z' }),
        issue({ id: 'b', seq: 2, sortKey: 'c', createdAt: '2026-06-01T00:00:00.000Z' }),
        issue({ id: 'c', seq: 3, sortKey: 'i', createdAt: '2026-06-02T00:00:00.000Z' }),
      ],
      [sess('sa', 'a'), sess('sb', 'b'), sess('sc', 'c')],
      [],
      NOW,
    )
    expect(idsOf(rows)).toEqual(['b', 'c', 'a'])
  })

  it('keyed rows sit above unkeyed legacy rows; legacy keeps newest-first', () => {
    const rows = unifiedWorkList(
      emptySections(),
      [
        issue({ id: 'old1', seq: 1, createdAt: '2026-06-01T00:00:00.000Z' }),
        issue({ id: 'old2', seq: 2, createdAt: '2026-06-02T00:00:00.000Z' }),
        issue({ id: 'new1', seq: 3, sortKey: 'i', createdAt: '2026-05-01T00:00:00.000Z' }),
      ],
      [sess('s1', 'old1'), sess('s2', 'old2'), sess('s3', 'new1')],
      [],
      NOW,
    )
    // new1 is keyed → top, despite being the oldest by creation.
    expect(idsOf(rows)).toEqual(['new1', 'old2', 'old1'])
  })

  it('snoozed still sinks below everything, even with the smallest key', () => {
    const rows = unifiedWorkList(
      emptySections(),
      [
        issue({ id: 'a', seq: 1, sortKey: 'r' }),
        issue({
          id: 'z',
          seq: 2,
          sortKey: 'c',
          deferUntil: new Date(NOW + 3_600_000).toISOString(),
          deferred: true,
        }),
      ],
      [sess('sa', 'a'), sess('sz', 'z')],
      [],
      NOW,
    )
    expect(idsOf(rows)).toEqual(['a', 'z'])
  })

  it('pinned floats regardless of key; keys order the pinned band itself', () => {
    const rows = unifiedWorkList(
      emptySections(),
      [
        issue({ id: 'a', seq: 1, sortKey: 'c' }),
        issue({ id: 'p1', seq: 2, sortKey: 'x', pinned: true }),
        issue({ id: 'p2', seq: 3, sortKey: 'i', pinned: true }),
      ],
      [sess('sa', 'a'), sess('sp1', 'p1'), sess('sp2', 'p2')],
      [],
      NOW,
    )
    expect(idsOf(rows)).toEqual(['p2', 'p1', 'a'])
  })

  it("a parent's children sort by their own key space", () => {
    const rows = unifiedWorkList(
      emptySections(),
      [
        issue({ id: 'parent', seq: 1, sortKey: 'i' }),
        issue({ id: 'c1', seq: 2, parentId: 'parent', sortKey: 'r' }),
        issue({ id: 'c2', seq: 3, parentId: 'parent', sortKey: 'c' }),
      ],
      [sess('sp', 'parent'), sess('s1', 'c1'), sess('s2', 'c2')],
      [],
      NOW,
    )
    expect(idsOf(rows)).toEqual(['parent'])
    const parent = rows[0] as UnifiedIssueRow
    expect((parent.startedByChildren ?? []).map((c) => c.issue.id)).toEqual(['c2', 'c1'])
  })
})
