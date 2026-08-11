import { asIssueId, type IssueWire, type IssueWireInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { childStageCounts, isEpic, issuePageOrderIds } from './issue-hierarchy'

/**
 * What is left here after POD-724: the two derivations that read desktop-only
 * fields (`childCount`, and the page's neighbour order). The tree partition and
 * the nested-row emitter moved to client-core with their cases —
 * `packages/client-core/src/viewmodels/issue-board-rows.test.ts` — because the
 * phone's Tasks tab renders from them too. `issues-nested-nav.test.ts` still
 * exercises the façade in this app, which is what proves the move was neutral.
 */

function issue(over: Partial<IssueWireInput> = {}): IssueWire {
  return {
    id: 'i',
    repoPath: '/home/u/acme',
    seq: 1,
    title: 'Fix login',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedByNotes: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    origin: 'human' as const,
    draft: false,
    ...over,
  } as IssueWire
}

describe('isEpic', () => {
  it('true for type=epic even with no children', () => {
    expect(isEpic(issue({ type: 'epic' }))).toBe(true)
  })
  it('true for any issue with children', () => {
    expect(isEpic(issue({ type: 'task', childCount: 2 }))).toBe(true)
  })
  it('false for a plain childless task', () => {
    expect(isEpic(issue({ type: 'task' }))).toBe(false)
  })
})

describe('childStageCounts', () => {
  it('rolls DIRECT children up per stage, ISSUE_STAGES order, zero stages omitted', () => {
    const p = issue({ id: 'p', childCount: 3 })
    const kids = [
      issue({ id: 'k1', parentId: 'p', stage: 'in_progress' }),
      issue({ id: 'k2', parentId: 'p', stage: 'in_progress' }),
      issue({ id: 'k3', parentId: 'p', stage: 'done' }),
      issue({ id: 'g1', parentId: 'k1', stage: 'review' }), // grandchild → counts under k1
    ]
    const counts = childStageCounts([p, ...kids])
    expect(counts.get('p')).toEqual([
      { stage: 'in_progress', count: 2 },
      { stage: 'done', count: 1 },
    ])
    expect(counts.get('k1')).toEqual([{ stage: 'review', count: 1 }])
    expect(counts.has('k3')).toBe(false)
  })
})

describe('issuePageOrderIds', () => {
  it('uses the visible order when the open issue is visible', () => {
    expect(
      issuePageOrderIds(
        [asIssueId('p'), asIssueId('l')],
        [asIssueId('p'), asIssueId('c'), asIssueId('l')],
        asIssueId('p'),
      ),
    ).toEqual(['p', 'l'])
  })
  it('falls back to the full flat order for a hidden (collapsed) child', () => {
    expect(
      issuePageOrderIds(
        [asIssueId('p'), asIssueId('l')],
        [asIssueId('p'), asIssueId('c'), asIssueId('l')],
        asIssueId('c'),
      ),
    ).toEqual(['p', 'c', 'l'])
  })
})
