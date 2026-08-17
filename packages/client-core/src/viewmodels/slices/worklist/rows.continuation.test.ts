import type { SessionMeta, SessionMetaInput, UnbrandIds } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { IssueNavigationModel } from '../issues'
import type { SidebarSections } from './nav'
import { rowPendingDecision, rowStatusLine } from './row-attention'
import type { UnifiedIssueRow } from './row-types'
import { unifiedWorkList } from './rows'

const NOW = Date.parse('2026-08-17T12:00:00.000Z')

function issue(over: Partial<UnbrandIds<IssueNavigationModel>> = {}): IssueNavigationModel {
  return {
    id: 'origin',
    repoPath: '/r/a',
    seq: 1158,
    displayRef: 'POD-1158',
    title: 'Chat feed motion',
    description: '',
    stage: 'review',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedByNotes: [],
    deps: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-17T11:00:00.000Z',
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
    readAt: '2026-08-17T11:30:00.000Z',
    ...over,
  } as IssueNavigationModel
}

function session(over: Partial<SessionMetaInput> = {}): SessionMeta {
  return {
    sessionId: 'live',
    cwd: '/r/a',
    createdAt: '2026-08-17T10:00:00.000Z',
    lastActiveAt: '2026-08-17T11:50:00.000Z',
    agentKind: 'claude-code',
    status: 'live',
    archived: false,
    title: 'Agent',
    unread: false,
    ...over,
  } as SessionMeta
}

const sections: SidebarSections = { pinnedWorktrees: [], pinnedRepos: [], repos: [] }

function issueRows(issues: IssueNavigationModel[], sessions: SessionMeta[]): UnifiedIssueRow[] {
  return unifiedWorkList(sections, issues, sessions, [], NOW).filter(
    (row): row is UnifiedIssueRow => row.kind === 'issue',
  )
}

/**
 * POD-1193 — WHERE THE WORK WENT IS STAMPED ON THE ROW.
 *
 * The row's own module cannot answer it: {@link issueContinuation} needs the
 * whole issue graph and every session in the replica. So the slice answers it
 * once at construction, and attention and copy both read that one verdict —
 * the defect being that the sidebar decided its amber from one derivation and
 * its words from another, and could disagree with itself.
 */
describe('a vacated origin is a signpost, not an ask', () => {
  const origin = issue()
  const spinOff = issue({
    id: 'spin',
    seq: 1192,
    displayRef: 'POD-1192',
    title: 'Brief shelf toggle flicker',
    stage: 'in_progress',
    deps: [{ id: 'origin', type: 'discovered-from' }],
  })
  const onSpinOff = session({ sessionId: 'live', issueId: 'spin' })

  it('stamps the continuation and withdraws the review ask', () => {
    const rows = issueRows([origin, spinOff], [onSpinOff])
    const row = rows.find((candidate) => candidate.issue.id === 'origin')
    expect(row).toBeDefined()
    if (!row) return
    expect(row.continuation).toBe('continued · POD-1192')
    expect(rowPendingDecision(row)).toBeNull()
    expect(rowStatusLine(row, NOW)).toBe('continued · POD-1192')
  })

  it('leaves a review with nobody to carry it on asking', () => {
    // The control case: same issue, same stage, no started spin-off. This IS a
    // decision the operator owes, and withdrawing its amber would be the bug.
    const rows = issueRows([origin], [])
    const row = rows.find((candidate) => candidate.issue.id === 'origin')
    expect(row?.continuation).toBeUndefined()
    expect(row && rowPendingDecision(row)).toBe('review')
  })

  it('stays an ask while an agent is still on the origin itself', () => {
    // A real mission that also discovered something is not a signpost.
    const own = session({ sessionId: 'own', issueId: 'origin' })
    const rows = issueRows([origin, spinOff], [onSpinOff, own])
    const row = rows.find((candidate) => candidate.issue.id === 'origin')
    expect(row).toBeDefined()
    expect(row?.continuation).toBeUndefined()
  })
})
