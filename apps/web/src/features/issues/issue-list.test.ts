import { describe, expect, it } from 'vitest'
import { flattenGroups, groupIssuesByStage } from './issue-list'
import { makeIssue as issue } from './test-issue'

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
      'backlog',
      'planning',
      'in_progress',
      'review',
      'done',
    ])
    expect(g[3]?.issues.map((i) => i.id)).toEqual(['b', 'a'])
    expect(g[1]?.issues).toEqual([])
  })
})

describe('flattenGroups', () => {
  it('yields ids in visual order', () => {
    const g = groupIssuesByStage(
      [issue({ id: 'a', stage: 'done' }), issue({ id: 'b', stage: 'backlog' })],
      'updated',
    )
    expect(flattenGroups(g)).toEqual(['b', 'a'])
  })
})
