import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  groupUnifiedWorkRows,
  rowInClosedFold,
  type SidebarSections,
  type UnifiedIssueRow,
  unifiedWorkList,
} from './derive'

const NOW = Date.parse('2026-07-23T12:00:00.000Z')

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'issue',
    repoPath: '/r/a',
    seq: 1,
    title: 'Issue',
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    blockedBy: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    unread: false,
    readAt: '2026-07-23T11:00:00.000Z',
    ...over,
  } as IssueWire
}

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: 'session',
    cwd: '/r/a',
    createdAt: '2026-07-22T00:00:00.000Z',
    lastActiveAt: '2026-07-23T10:00:00.000Z',
    agentKind: 'codex',
    status: 'hibernated',
    archived: false,
    title: 'Agent',
    unread: false,
    readAt: '2026-07-23T11:00:00.000Z',
    ...over,
  } as SessionMeta
}

const sections: SidebarSections = { pinnedWorktrees: [], pinnedRepos: [], repos: [] }

function row(value: IssueWire, sessions: SessionMeta[] = []): UnifiedIssueRow {
  return { kind: 'issue', issue: value, sessions, activityAt: NOW, rank: 4 }
}

describe('issue/session lifecycle in the unified sidebar', () => {
  it.each([
    'planning',
    'in_progress',
    'review',
  ] as const)('keeps a sessionless %s human issue visible after its session is retired', (stage) => {
    const active = issue({ stage })
    const retired = session({ issueId: active.id, archived: true })
    const rows = unifiedWorkList(sections, [active], [retired], [], NOW)
    expect(rows.map((candidate) => (candidate.kind === 'issue' ? candidate.issue.id : ''))).toEqual(
      [active.id],
    )
  })

  it('keeps backlog sessionless issues out of the live sidebar', () => {
    expect(unifiedWorkList(sections, [issue({ stage: 'backlog' })], [], [], NOW)).toEqual([])
  })

  it('keeps a read closed issue with a pending offer out of the closed fold', () => {
    const closed = issue({
      stage: 'done',
      closedReason: 'done',
      closedAt: '2026-07-23T09:00:00.000Z',
    })
    const offered = session({
      issueId: closed.id,
      offer: {
        message: 'Ready to merge',
        actions: [{ label: 'Merge', prompt: 'Merge it' }],
        createdAt: '2026-07-23T10:00:00.000Z',
      },
    })
    expect(rowInClosedFold(row(closed, [offered]), null)).toBe(false)
  })

  it('orders folded closures by closedAt newest-first, ignoring incoming manual order', () => {
    const oldest = issue({
      id: 'oldest',
      seq: 3,
      stage: 'done',
      closedReason: 'done',
      closedAt: '2026-07-20T09:00:00.000Z',
    })
    const newest = issue({
      id: 'newest',
      seq: 1,
      stage: 'done',
      closedReason: 'done',
      closedAt: '2026-07-23T09:00:00.000Z',
    })
    const middle = issue({
      id: 'middle',
      seq: 2,
      stage: 'done',
      closedReason: 'done',
      closedAt: '2026-07-22T09:00:00.000Z',
    })
    const [group] = groupUnifiedWorkRows([row(oldest), row(newest), row(middle)])
    expect(group?.closedRows.map((candidate) => candidate.issue.id)).toEqual([
      'newest',
      'middle',
      'oldest',
    ])
  })
})
