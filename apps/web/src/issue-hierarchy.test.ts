import type { IssueWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  childStageCounts,
  flattenRowGroups,
  isEpic,
  issuePageOrderIds,
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

describe('cycle fallback (#85 review)', () => {
  const a = issue({ id: 'a', parentId: 'b', stage: 'backlog' })
  const b = issue({ id: 'b', parentId: 'a', stage: 'backlog' })

  it('a parentId cycle promotes a member to root instead of vanishing both', () => {
    const { roots, childrenByParent } = partitionIssueTree([a, b])
    // One member becomes the root; the other stays reachable as its child.
    expect(roots.map((i) => i.id)).toEqual(['a'])
    expect(childrenByParent.get('a')?.map((i) => i.id)).toEqual(['b'])
    // And nothing is lost from the rendered rows.
    const groups = issueRowsByStage([a, b], 'priority', {
      flatten: false,
      expanded: new Set(['a']),
    })
    expect(flattenRowGroups(groups)).toEqual(['a', 'b'])
  })

  it('a cycle hanging off a healthy child stays reachable', () => {
    const child = issue({ id: 'c', parentId: 'a', stage: 'backlog' })
    const { roots, childrenByParent } = partitionIssueTree([a, b, child])
    expect(roots.length).toBeGreaterThan(0)
    const reachable = new Set(roots.map((i) => i.id))
    const stack = [...reachable]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      for (const kid of childrenByParent.get(cur) ?? []) {
        if (!reachable.has(kid.id)) {
          reachable.add(kid.id)
          stack.push(kid.id)
        }
      }
    }
    expect([...reachable].sort()).toEqual(['a', 'b', 'c'])
  })

  it('issueRowsByStage terminates on an expanded cycle (path guard)', () => {
    const groups = issueRowsByStage([a, b], 'priority', {
      flatten: false,
      expanded: new Set(['a', 'b']),
    })
    const ids = flattenRowGroups(groups)
    expect(ids.length).toBeLessThanOrEqual(4) // finite; each id at most once per path
    expect(new Set(ids)).toEqual(new Set(['a', 'b']))
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
    expect(issuePageOrderIds(['p', 'l'], ['p', 'c', 'l'], 'p')).toEqual(['p', 'l'])
  })
  it('falls back to the full flat order for a hidden (collapsed) child', () => {
    expect(issuePageOrderIds(['p', 'l'], ['p', 'c', 'l'], 'c')).toEqual(['p', 'c', 'l'])
  })
})
