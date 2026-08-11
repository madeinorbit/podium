import type { IssueStage } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type BoardRowIssue,
  flattenRowGroups,
  flattenStageGroups,
  groupIssuesByStage,
  issueRowsByStage,
  orderIssues,
  partitionByParent,
  partitionIssueTree,
} from './issue-board-rows'

/**
 * These cases came over WITH the derivation (POD-724) from
 * `apps/web/src/features/issues/issue-hierarchy.test.ts` and
 * `issue-list.test.ts`; the assertions are unchanged, only the fixture shrank to
 * the seven fields the module actually reads. That is the point of the move —
 * the desktop and the phone now fail the same test when the board's shape
 * changes, instead of one of them quietly growing a second answer.
 */
function issue(over: Partial<BoardRowIssue> = {}): BoardRowIssue {
  return {
    id: 'i',
    stage: 'backlog' as IssueStage,
    priority: 2,
    seq: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...over,
  }
}

describe('orderIssues', () => {
  it('priority: ascending priority, then seq', () => {
    const a = issue({ id: 'a', seq: 2, priority: 2 })
    const b = issue({ id: 'b', seq: 1, priority: 0 })
    const c = issue({ id: 'c', seq: 3, priority: 2 })
    expect(orderIssues([a, c, b], 'priority').map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })

  it('updated: most recently updated first; created likewise', () => {
    const old = issue({ id: 'old', updatedAt: '2026-01-01', createdAt: '2026-01-02' })
    const fresh = issue({ id: 'new', updatedAt: '2026-06-01', createdAt: '2026-01-01' })
    expect(orderIssues([old, fresh], 'updated')[0]?.id).toBe('new')
    expect(orderIssues([old, fresh], 'created')[0]?.id).toBe('old')
  })

  it('does not mutate its input', () => {
    const input = [issue({ id: 'a', priority: 4 }), issue({ id: 'b', priority: 0 })]
    orderIssues(input, 'priority')
    expect(input.map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('groupIssuesByStage', () => {
  it('returns all stages in order with ordered members', () => {
    const g = groupIssuesByStage(
      [
        issue({ id: 'a', stage: 'review', priority: 3 }),
        issue({ id: 'b', stage: 'review', priority: 0 }),
        issue({ id: 'c', stage: 'backlog' }),
      ],
      'priority',
    )
    expect(g.map((x) => x.stage)).toEqual([
      'proposed',
      'backlog',
      'planning',
      'in_progress',
      'review',
      'done',
    ])
    expect(g[4]?.issues.map((i) => i.id)).toEqual(['b', 'a'])
    expect(g[2]?.issues).toEqual([])
  })

  it('flattenStageGroups yields ids in visual order', () => {
    const g = groupIssuesByStage(
      [issue({ id: 'a', stage: 'done' }), issue({ id: 'b', stage: 'backlog' })],
      'updated',
    )
    expect(flattenStageGroups(g)).toEqual(['b', 'a'])
  })
})

describe('partitionIssueTree', () => {
  const parent = issue({ id: 'p' })
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
  const parent = issue({ id: 'p', stage: 'backlog', seq: 1 })
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
    const p2 = issue({ id: 'p2', stage: 'backlog' })
    const hi = issue({ id: 'hi', parentId: 'p2', stage: 'backlog', priority: 0, seq: 9 })
    const lo = issue({ id: 'lo', parentId: 'p2', stage: 'backlog', priority: 4, seq: 8 })
    const groups = issueRowsByStage([p2, lo, hi], 'priority', {
      flatten: false,
      expanded: new Set(['p2']),
    })
    expect(flattenRowGroups(groups)).toEqual(['p2', 'hi', 'lo'])
  })

  it('supports nested expansion (grandchildren)', () => {
    const mid = issue({ id: 'm', parentId: 'p', stage: 'backlog' })
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
