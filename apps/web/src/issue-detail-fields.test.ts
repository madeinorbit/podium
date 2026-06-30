import { describe, expect, it } from 'vitest'
import { issueDetailFields } from './issue-detail-fields'
import { makeIssue } from './test-issue'

describe('issueDetailFields', () => {
  it('builds the rich-field view-model', () => {
    const v = issueDetailFields(
      makeIssue({
        priority: 1,
        type: 'feature',
        assignee: 'agent:claude',
        labels: ['ui'],
        deps: [{ id: 'iss_b', type: 'blocks' }],
        comments: [{ id: 'c1', author: 'mike', body: 'hi', createdAt: 't' }],
        childCount: 3,
        childDoneCount: 2,
      }),
    )
    expect(v.priorityLabel).toBe('P1')
    expect(v.typeLabel).toBe('feature')
    expect(v.assignee).toBe('agent:claude')
    expect(v.labels).toEqual(['ui'])
    expect(v.deps).toEqual([{ id: 'iss_b', type: 'blocks' }])
    expect(v.comments[0]?.author).toBe('mike')
    expect(v.childSummary).toBe('2/3 done')
  })
  it('lifecycle reflects supersede/duplicate/closedReason', () => {
    expect(issueDetailFields(makeIssue({ supersededBy: 'iss_x' })).lifecycle).toMatch(/superseded/i)
    expect(issueDetailFields(makeIssue({ duplicateOf: 'iss_y' })).lifecycle).toMatch(/duplicate/i)
    expect(issueDetailFields(makeIssue({ closedReason: 'wontfix' })).lifecycle).toMatch(/wontfix/i)
  })
})
