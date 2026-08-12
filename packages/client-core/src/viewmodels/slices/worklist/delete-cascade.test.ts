/**
 * POD-781 design constraint (b) — THE DELETE CASCADE, pinned.
 *
 * `IssueSessionLifecycle.deleteIssue` tombstones the issue AND every session on
 * it, so an optimistic delete that hid only the issue row while its sessions
 * kept rendering would be painting a state the server never produces.
 *
 * The engine's overlay does exactly one thing: it stamps `deletedAt` on the
 * issue. This file is the reason that is enough — and the guard that keeps it
 * true. The two facts it rests on are both properties of the worklist, not of
 * the outbox, which is precisely why they need a test HERE:
 *
 *   1. the work sidebar is ISSUE-ONLY (`rows.ts` — "a repository branch is
 *      never promoted into a pseudo-issue row"), so a session reaches the screen
 *      only nested under the issue that owns it;
 *   2. ownership is already delete-aware (`issueIdOwningSession` refuses to own
 *      a session whose issue carries `deletedAt`).
 *
 * If either changed — a future orphan-session lane, say — a delete would start
 * leaving its sessions on screen for the length of the round trip, and this file
 * is what says so before a user finds out.
 */

import type { SessionMeta, SessionMetaInput, UnbrandIds } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type IssueNavigationModel,
  type SidebarSections,
  type UnifiedWorkRow,
  unifiedWorkList,
} from '../../index'

const NOW = Date.parse('2026-08-12T12:00:00.000Z')

function issue(over: Partial<UnbrandIds<IssueNavigationModel>> = {}): IssueNavigationModel {
  return {
    id: 'i1',
    repoPath: '/r/a',
    seq: 1,
    title: 'Doomed',
    description: '',
    stage: 'in_progress',
    worktreePath: '/r/a',
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    blockedByNotes: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
    archived: false,
    needsHuman: false,
    memberSessionIds: ['s1'],
    sessionSummary: { total: 1, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    unread: false,
    readAt: '2026-08-12T11:00:00.000Z',
    ...over,
  } as IssueNavigationModel
}

function session(over: Partial<SessionMetaInput> = {}): SessionMeta {
  return {
    sessionId: 's1',
    issueId: 'i1',
    cwd: '/r/a',
    createdAt: '2026-08-11T00:00:00.000Z',
    lastActiveAt: '2026-08-12T10:00:00.000Z',
    agentKind: 'codex',
    status: 'live',
    archived: false,
    title: 'Agent',
    unread: false,
    readAt: '2026-08-12T11:00:00.000Z',
    ...over,
  } as SessionMeta
}

const sections: SidebarSections = { pinnedWorktrees: [], pinnedRepos: [], repos: [] }

/** Every session id anywhere in the row tree — nested rows included, because a
 *  session that survives one level down is still a session on screen. */
function sessionIdsIn(rows: UnifiedWorkRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.kind !== 'issue') return []
    return [
      ...row.sessions.map((s) => s.sessionId as string),
      ...sessionIdsIn(row.startedByChildren ?? []),
    ]
  })
}

describe('POD-781 — an optimistically deleted issue takes its sessions with it', () => {
  const live = [session()]

  it('renders the issue and its member session while the issue is live', () => {
    const rows = unifiedWorkList(sections, [issue()], live, ['/r/a'], NOW)
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : r.worktree.path))).toEqual(['i1'])
    expect(sessionIdsIn(rows)).toEqual(['s1'])
  })

  it('drops BOTH the row and its member session on a `deletedAt` stamp — one overlay, whole cascade', () => {
    // Exactly what `overlayForOutboxEntry('issueDelete')` folds over the replica
    // row: one field, on the issue, and nothing on the sessions.
    const deleted = issue({ deletedAt: '2026-08-12T12:00:00.000Z' })
    const rows = unifiedWorkList(sections, [deleted], live, ['/r/a'], NOW)

    expect(rows).toEqual([])
    // The load-bearing half: the session is not re-homed onto some other row,
    // and it does not reappear as a worktree/orphan row of its own.
    expect(sessionIdsIn(rows)).toEqual([])
  })

  it('does the same for archive, which is the other row-removing patch', () => {
    const archived = issue({ archived: true })
    const rows = unifiedWorkList(sections, [archived], live, ['/r/a'], NOW)
    expect(rows).toEqual([])
    expect(sessionIdsIn(rows)).toEqual([])
  })

  it('leaves a SIBLING issue and its sessions alone — the overlay is one row, not a sweep', () => {
    const other = issue({ id: 'i2', seq: 2, memberSessionIds: ['s2'] })
    const otherSession = session({ sessionId: 's2', issueId: 'i2' })
    const rows = unifiedWorkList(
      sections,
      [issue({ deletedAt: '2026-08-12T12:00:00.000Z' }), other],
      [...live, otherSession],
      ['/r/a'],
      NOW,
    )
    expect(rows.map((r) => (r.kind === 'issue' ? r.issue.id : r.worktree.path))).toEqual(['i2'])
    expect(sessionIdsIn(rows)).toEqual(['s2'])
  })
})
