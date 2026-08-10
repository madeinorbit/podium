import { asIssueId, asSessionId, type IssueWire, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { ReferentExit } from '../session-ownership'
import {
  branchRollup,
  filterIssueNav,
  issueAwaitingMerge,
  issueFinishedAt,
  issueNavList,
  issuePendingDecision,
  issuePendingMergeCommits,
  pendingDecisionLabel,
  pendingDecisionTitle,
  resolveIssueEdge,
  subIssuesOf,
  type IssueNavigationModel,
} from './issues'

// ---------------------------------------------------------------------------
// POD-330 — the ISSUES slice.
//
// Two things are being protected here, and only one of them is the arithmetic:
//
//  1. the issue-entity derivations the worklist consumes (`issuePendingDecision`,
//     `issueFinishedAt`) keep their exact meaning across the cut — they had NO
//     external importer, so nothing outside `derive.ts` was pinning them;
//  2. an edge to an issue the principal cannot SEE is renderable BOTH ways
//     (§3.1.2), the policy comes from the caller, and `not-visible` never
//     collapses into `removed`.
// ---------------------------------------------------------------------------

function issue(id: string, over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: asIssueId(id),
    repoPath: '/repo/podium',
    seq: 1,
    title: id,
    description: '',
    stage: 'in_progress',
    worktreePath: '/repo/podium',
    branch: null,
    parentBranch: 'main',
    closedReason: null,
    closedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archived: false,
    audience: 'human',
    origin: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    deps: [],
    ...over,
  } as unknown as IssueWire
}

function navIssue(id: string, over: Partial<IssueNavigationModel> = {}): IssueNavigationModel {
  return issue(id, over as Partial<IssueWire>) as unknown as IssueNavigationModel
}

function session(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    title: id,
    cwd: '/repo/podium',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

const unmerged = {
  updatedAt: '2026-07-01T00:00:00.000Z',
  branch: 'issue/1',
  shared: false,
  merged: false,
  ahead: 3,
  dirtyFiles: 0,
}

describe('pending decision — merge is distinguishable from review', () => {
  it('reads a finished issue with 3 unlanded commits as a MERGE of exactly 3', () => {
    const i = issue('POD-1', { stage: 'done', branch: 'issue/1', gitState: unmerged })
    expect(issuePendingDecision(i)).toBe('merge')
    expect(issuePendingMergeCommits(i)).toBe(3)
    expect(issueAwaitingMerge(i)).toBe(true)
    expect(pendingDecisionLabel(i, 'merge')).toBe('ready to merge · 3')
    expect(pendingDecisionTitle(i, 'merge')).toBe('3 commits ready to land on main')
  })

  it('reads a review-stage issue with nothing to land as a REVIEW, and counts 0 commits', () => {
    const i = issue('POD-2', { stage: 'review' })
    expect(issuePendingDecision(i)).toBe('review')
    expect(issuePendingMergeCommits(i)).toBe(0)
    expect(pendingDecisionLabel(i, 'review')).toBe('needs review')
  })

  it('asks for no decision while an open dependency blocks the delivery', () => {
    const i = issue('POD-7', {
      stage: 'review',
      branch: 'issue/7',
      gitState: unmerged,
      blocked: true,
    })
    expect(issuePendingDecision(i)).toBeNull()
    expect(issuePendingMergeCommits(i)).toBe(0)
  })

  it('asks nothing of the human for work in progress', () => {
    expect(issuePendingDecision(issue('POD-3'))).toBeNull()
  })

  it('stays conservative when git state is unknown — no merge is claimed', () => {
    const i = issue('POD-4', { stage: 'done', branch: 'issue/4' })
    expect(issuePendingDecision(i)).toBeNull()
    expect(issueAwaitingMerge(i)).toBe(false)
  })

  it('anchors finishedAt on closedAt when stamped, not on updatedAt', () => {
    const closed = issue('POD-5', {
      closedAt: '2026-07-02T00:00:00.000Z',
      updatedAt: '2026-07-09T00:00:00.000Z',
    })
    expect(issueFinishedAt(closed)).toBe(Date.parse('2026-07-02T00:00:00.000Z'))
    // Legacy rows have no closure stamp: their last update is when they settled.
    expect(issueFinishedAt(issue('POD-6', { updatedAt: '2026-07-09T00:00:00.000Z' }))).toBe(
      Date.parse('2026-07-09T00:00:00.000Z'),
    )
  })
})

describe('sub-issues and roll-up', () => {
  const tree = [
    issue('POD-10'),
    issue('POD-11', { parentId: asIssueId('POD-10'), seq: 2 }),
    issue('POD-12', { parentId: asIssueId('POD-10'), seq: 1, stage: 'done' }),
    issue('POD-13', { parentId: asIssueId('POD-12'), seq: 3 }),
  ]

  it('orders direct children by seq', () => {
    expect(subIssuesOf(tree, 'POD-10').map((i) => i.id)).toEqual(['POD-12', 'POD-11'])
  })

  it('rolls up the whole visible subtree: 3 total, 1 done', () => {
    expect(branchRollup(tree, 'POD-10')).toEqual({ total: 3, done: 1 })
  })

  it('counts only what the replica HOLDS — an invisible descendant is not guessed at', () => {
    // POD-12 has been evicted (a share was revoked). Its own child is still
    // present but now unreachable from the root by parentId edges.
    const scoped = tree.filter((i) => i.id !== 'POD-12')
    expect(branchRollup(scoped, 'POD-10')).toEqual({ total: 1, done: 0 })
  })

  it('leaves ARCHIVED descendants out of the k/m — history is the count, not the archive', () => {
    const withArchived = [...tree, issue('POD-14', { parentId: asIssueId('POD-10'), archived: true })]
    expect(branchRollup(withArchived, 'POD-10')).toEqual({ total: 3, done: 1 })
  })

  it('terminates on a parent cycle rather than spinning', () => {
    const cyclic = [
      issue('POD-20', { parentId: asIssueId('POD-21') }),
      issue('POD-21', { parentId: asIssueId('POD-20') }),
    ]
    expect(branchRollup(cyclic, 'POD-20')).toEqual({ total: 1, done: 0 })
  })
})

describe('cross-boundary edges are renderable BOTH ways (§3.1.2)', () => {
  const visible = issue('POD-30')
  const lookup = (id: string) => (id === 'POD-30' ? visible : undefined)
  const evicted = (id: string): ReferentExit | undefined =>
    id === 'POD-31' ? 'evicted' : id === 'POD-32' ? 'removed' : undefined

  it('renders a visible target as the issue itself under either policy', () => {
    for (const policy of ['hidden', 'opaque'] as const) {
      const edge = resolveIssueEdge('POD-30', lookup, policy, evicted)
      expect(edge.render).toBe('issue')
      expect(edge.resolution.value).toBe(visible)
    }
  })

  it('renders an INVISIBLE target per the caller policy — hidden OR opaque, never deleted', () => {
    const hidden = resolveIssueEdge('POD-31', lookup, 'hidden', evicted)
    const opaque = resolveIssueEdge('POD-31', lookup, 'opaque', evicted)
    expect(hidden.render).toBe('hidden')
    expect(opaque.render).toBe('opaque')
    // Both agree on the FACT, and the fact is not a deletion.
    expect(hidden.resolution.state).toBe('not-visible')
    expect(opaque.resolution.state).toBe('not-visible')
    expect(opaque.resolution.state).not.toBe('removed')
    // An opaque edge is anonymous: no identity leaks through it.
    expect(opaque.resolution.value).toBeUndefined()
  })

  it('never spins: a not-yet-arrived target is pending and a deleted one is hidden', () => {
    expect(resolveIssueEdge('POD-99', lookup, 'opaque', evicted).render).toBe('pending')
    expect(resolveIssueEdge('POD-32', lookup, 'opaque', evicted).render).toBe('hidden')
    expect(resolveIssueEdge('POD-32', lookup, 'opaque', evicted).resolution.state).toBe('removed')
  })

  it('re-granting wins over a stale eviction record', () => {
    const regranted = (id: string) => (id === 'POD-31' ? issue('POD-31') : lookup(id))
    expect(resolveIssueEdge('POD-31', regranted, 'opaque', evicted).render).toBe('issue')
  })
})

describe('issue nav list', () => {
  const now = Date.parse('2026-07-10T00:00:00.000Z')

  it('orders by live session activity, falling back to updatedAt', () => {
    const issues = [
      navIssue('POD-40', {
        worktreePath: '/repo/a',
        updatedAt: '2026-07-01T00:00:00.000Z',
        memberSessionIds: ['s-old'],
      }),
      navIssue('POD-41', {
        worktreePath: '/repo/b',
        updatedAt: '2026-07-02T00:00:00.000Z',
        memberSessionIds: ['s-new'],
      }),
      navIssue('POD-42', { worktreePath: '/repo/c', updatedAt: '2026-07-09T00:00:00.000Z' }),
    ]
    // The session timestamps deliberately INVERT the updatedAt order: POD-40 is
    // the stalest issue but has the freshest agent. A list that fell back to
    // updatedAt would sort these two the other way round, which is the whole
    // point of ordering on live activity.
    const sessions = [
      session('s-old', { cwd: '/repo/a', lastActiveAt: '2026-07-08T00:00:00.000Z' }),
      session('s-new', { cwd: '/repo/b', lastActiveAt: '2026-07-03T00:00:00.000Z' }),
    ]
    const list = issueNavList(issues, sessions, now)
    expect(list.map((v) => v.issue.id)).toEqual(['POD-42', 'POD-40', 'POD-41'])
    expect(list[0]?.repoName).toBe('podium')
    expect(list.find((v) => v.issue.id === 'POD-41')?.sessions.map((s) => s.sessionId)).toEqual([
      's-new',
    ])
  })

  it('drops archived and deleted issues', () => {
    const issues = [
      navIssue('POD-43'),
      navIssue('POD-44', { archived: true }),
      navIssue('POD-45', { deletedAt: '2026-07-01T00:00:00.000Z' }),
    ]
    expect(issueNavList(issues, [], now).map((v) => v.issue.id)).toEqual(['POD-43'])
  })

  it('filters on title, repo name and stage', () => {
    const list = issueNavList([navIssue('POD-46', { title: 'Slice derive' })], [], now)
    expect(filterIssueNav(list, 'slice')).toHaveLength(1)
    expect(filterIssueNav(list, 'podium')).toHaveLength(1)
    expect(filterIssueNav(list, 'in_progress')).toHaveLength(1)
    expect(filterIssueNav(list, 'nothing')).toHaveLength(0)
    expect(filterIssueNav(list, '   ')).toHaveLength(1)
  })

  it('leaves an evicted member session out with no tombstone row', () => {
    const i = navIssue('POD-47', { memberSessionIds: ['s-kept', 's-evicted'] })
    const view = issueNavList([i], [session('s-kept')], now)[0]
    expect(view?.sessions.map((s) => s.sessionId)).toEqual(['s-kept'])
    // Nothing stands in for the evicted row — the issue simply has one session.
    expect(view?.sessions).toHaveLength(1)
  })
})
