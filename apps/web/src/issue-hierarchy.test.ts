import type { IssueWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  flattenRowGroups,
  isEpic,
  issueRowsByStage,
  partitionByParent,
  partitionIssueTree,
} from './issue-hierarchy'

function issue(over: Partial<IssueWire> = {}): IssueWire {
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
    blockedBy: [],
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
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
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

describe('partitionIssueTree', () => {
  const parent = issue({ id: 'p', childCount: 2 })
  const c1 = issue({ id: 'c1', parentId: 'p' })
  const c2 = issue({ id: 'c2', parentId: 'p' })

  it('splits roots from children keyed by parent', () => {
    const { roots, childrenByParent } = partitionIssueTree([parent, c1, c2])
    expect(roots.map((i) => i.id)).toEqual(['p'])
    expect(childrenByParent.get('p')?.map((i) => i.id)).toEqual(['c1', 'c2'])
  })

  it('promotes a child to root when its parent is absent (filtered out)', () => {
    const { roots } = partitionIssueTree([c1, c2])
    expect(roots.map((i) => i.id)).toEqual(['c1', 'c2'])
  })

  it('a self-referential parentId does not orphan the issue', () => {
    const weird = issue({ id: 'w', parentId: 'w' })
    const { roots } = partitionIssueTree([weird])
    expect(roots.map((i) => i.id)).toEqual(['w'])
  })

  it('generic partitionByParent works on arbitrary shapes', () => {
    const items = [
      { key: 'a', up: undefined },
      { key: 'b', up: 'a' },
    ]
    const { roots, childrenByParent } = partitionByParent(
      items,
      (t) => t.key,
      (t) => t.up,
    )
    expect(roots.map((t) => t.key)).toEqual(['a'])
    expect(childrenByParent.get('a')?.map((t) => t.key)).toEqual(['b'])
  })
})

describe('issueRowsByStage', () => {
  const parent = issue({ id: 'p', stage: 'backlog', childCount: 2, seq: 1 })
  const cBacklog = issue({ id: 'cb', parentId: 'p', stage: 'backlog', seq: 2 })
  const cDone = issue({ id: 'cd', parentId: 'p', stage: 'done', seq: 3 })
  const lone = issue({ id: 'l', stage: 'planning', seq: 4 })
  const all = [parent, cBacklog, cDone, lone]

  it('collapsed: only roots are visible, children hidden', () => {
    const groups = issueRowsByStage(all, 'priority', { flatten: false, expanded: new Set() })
    expect(flattenRowGroups(groups)).toEqual(['p', 'l'])
    const backlog = groups.find((g) => g.stage === 'backlog')
    expect(backlog?.rows[0]).toMatchObject({ depth: 0, childCount: 2, expanded: false })
  })

  it('expanded: children follow their parent, indented, regardless of own stage', () => {
    const groups = issueRowsByStage(all, 'priority', {
      flatten: false,
      expanded: new Set(['p']),
    })
    const backlog = groups.find((g) => g.stage === 'backlog')
    expect(backlog?.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ['p', 0],
      ['cb', 1],
      ['cd', 1],
    ])
    // The done-stage child rides under its backlog parent, not in the done group.
    expect(groups.find((g) => g.stage === 'done')?.rows).toEqual([])
  })

  it('expanding a leaf id is a no-op (no chevron rows stay childless)', () => {
    const groups = issueRowsByStage(all, 'priority', {
      flatten: false,
      expanded: new Set(['l']),
    })
    expect(flattenRowGroups(groups)).toEqual(['p', 'l'])
  })

  it('flatten: reproduces the old flat view (everyone at depth 0 in own stage)', () => {
    const groups = issueRowsByStage(all, 'priority', { flatten: true, expanded: new Set() })
    expect(flattenRowGroups(groups)).toEqual(['p', 'cb', 'l', 'cd'])
    for (const g of groups) for (const r of g.rows) expect(r.depth).toBe(0)
  })

  it('nested children are ordered by the active ordering', () => {
    const p2 = issue({ id: 'p2', stage: 'backlog', childCount: 2 })
    const hi = issue({ id: 'hi', parentId: 'p2', stage: 'backlog', priority: 0, seq: 9 })
    const lo = issue({ id: 'lo', parentId: 'p2', stage: 'backlog', priority: 4, seq: 8 })
    const groups = issueRowsByStage([p2, lo, hi], 'priority', {
      flatten: false,
      expanded: new Set(['p2']),
    })
    expect(flattenRowGroups(groups)).toEqual(['p2', 'hi', 'lo'])
  })

  it('supports nested expansion (grandchildren)', () => {
    const mid = issue({ id: 'm', parentId: 'p', stage: 'backlog', childCount: 1 })
    const leaf = issue({ id: 'g', parentId: 'm', stage: 'backlog' })
    const groups = issueRowsByStage([parent, mid, leaf], 'priority', {
      flatten: false,
      expanded: new Set(['p', 'm']),
    })
    const backlog = groups.find((g) => g.stage === 'backlog')
    expect(backlog?.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ['p', 0],
      ['m', 1],
      ['g', 2],
    ])
  })
})
