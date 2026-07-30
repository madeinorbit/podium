import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  groupUnifiedWorkRows,
  rowAwaitsTuck,
  rowInClosedFold,
  rowInSnoozedFold,
  type IssueNavigationModel,
  type SidebarSections,
  type UnifiedIssueRow,
  unifiedWorkList,
} from './derive'

const NOW = Date.parse('2026-07-23T12:00:00.000Z')

function issue(over: Partial<IssueNavigationModel> = {}): IssueNavigationModel {
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
    memberSessionIds: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    unread: false,
    readAt: '2026-07-23T11:00:00.000Z',
    ...over,
  } as IssueNavigationModel
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

function row(value: IssueNavigationModel, sessions: SessionMeta[] = []): UnifiedIssueRow {
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

  it('folds a read closed issue even when a historical stale offer remains (POD-290)', () => {
    // Closing retires offers server-side; this guards residual client state so
    // finished work cannot keep demanding a decision forever. Past the finished
    // grace window it folds on its own, offer or not (POD-293).
    const closed = issue({
      stage: 'done',
      closedReason: 'done',
      closedAt: '2026-07-21T09:00:00.000Z',
    })
    const offered = session({
      issueId: closed.id,
      offer: {
        message: 'Ready to merge',
        actions: [{ label: 'Merge', prompt: 'Merge it' }],
        createdAt: '2026-07-23T10:00:00.000Z',
      },
    })
    expect(rowInClosedFold(row(closed, [offered]), null, false, NOW)).toBe(true)
  })

  it('holds a freshly finished issue open until tucked, then folds it (POD-293)', () => {
    // Settled but finished only 30 minutes ago: it no longer vanishes on finish —
    // it stays a live "done" row the operator can dismiss. Read is not required.
    const done = issue({
      stage: 'done',
      closedReason: 'done',
      closedAt: '2026-07-23T11:30:00.000Z',
    })
    const r = row(done)
    expect(rowInClosedFold(r, null, false, NOW)).toBe(false)
    expect(rowAwaitsTuck(r, null, false, NOW)).toBe(true)
    // Selecting the open done row must not hide Tuck away — only tuck/grace does.
    expect(rowAwaitsTuck(r, done.id, false, NOW)).toBe(true)
    expect(rowInClosedFold(r, done.id, false, NOW)).toBe(false)
    // Unread / never-read finished work still offers tuck (manual dismiss path;
    // the old auto-fold-on-read gate no longer applies).
    const unread = row(
      issue({
        id: 'unread-done',
        stage: 'done',
        closedReason: 'done',
        closedAt: '2026-07-23T11:30:00.000Z',
        unread: true,
        readAt: undefined,
      }),
    )
    expect(rowAwaitsTuck(unread, null, false, NOW)).toBe(true)
    expect(rowInClosedFold(unread, null, false, NOW)).toBe(false)
    // A still-working session must not hide Tuck away once the issue is closed —
    // the operator dismissed the work; agents winding down are not a live ask.
    const stillWorking = row(
      issue({
        id: 'working-done',
        stage: 'done',
        closedReason: 'done',
        closedAt: '2026-07-23T11:30:00.000Z',
      }),
      [
        session({
          sessionId: 'worker',
          issueId: 'working-done',
          agentState: {
            phase: 'working',
            since: '2026-07-23T11:30:00.000Z',
            nativeSubagentCount: 0,
          },
        }),
      ],
    )
    expect(rowAwaitsTuck(stillWorking, null, false, NOW)).toBe(true)
    expect(rowInClosedFold(stillWorking, null, false, NOW)).toBe(false)
    // Tucking folds into Closed at once — even while still selected — and stops
    // awaiting dismissal. Selection lane-stickiness must not delay explicit tuck.
    // The dismissal rides on the ISSUE now (POD-333: server truth, so a reload or
    // a second client folds the same row), not a local set of ids.
    const tucked = row(
      issue({
        ...done,
        tuckedAt: '2026-07-23T11:45:00.000Z',
      }),
    )
    expect(rowInClosedFold(tucked, done.id, false, NOW)).toBe(true)
    expect(rowInClosedFold(tucked, null, false, NOW)).toBe(true)
    expect(rowAwaitsTuck(tucked, done.id, false, NOW)).toBe(false)
    expect(rowAwaitsTuck(tucked, null, false, NOW)).toBe(false)
  })

  it('keeps open review work with a live offer out of the closed fold', () => {
    const review = issue({ stage: 'review' })
    const offered = session({
      issueId: review.id,
      offer: {
        message: 'Ready to merge',
        actions: [{ label: 'Merge', prompt: 'Merge it' }],
        createdAt: '2026-07-23T10:00:00.000Z',
      },
    })
    expect(rowInClosedFold(row(review, [offered]), null)).toBe(false)
  })

  it('folds only actively snoozed issues and leaves returned rows open', () => {
    const snoozed = issue({
      id: 'snoozed',
      deferUntil: '2026-07-23T13:00:00.000Z',
      deferred: true,
    })
    const returned = issue({
      id: 'returned',
      deferUntil: '2026-07-23T11:00:00.000Z',
      deferred: false,
    })

    expect(rowInSnoozedFold(row(snoozed), NOW)).toBe(true)
    expect(rowInSnoozedFold(row(returned), NOW)).toBe(false)

    const [group] = groupUnifiedWorkRows([row(returned), row(snoozed)], null, false, NOW)
    expect(
      group?.rows.map((candidate) =>
        candidate.kind === 'issue' ? candidate.issue.id : candidate.worktree.path,
      ),
    ).toEqual(['returned'])
    expect(group?.snoozedRows.map((candidate) => candidate.issue.id)).toEqual(['snoozed'])
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
