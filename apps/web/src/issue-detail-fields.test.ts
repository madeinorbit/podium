import { describe, expect, it } from 'vitest'
import { issueDetailFields } from './issue-detail-fields'
import { makeIssue } from './test-issue'

describe('issueDetailFields', () => {
  it('normalizes the comment thread to the displayed shape', () => {
    const v = issueDetailFields(
      makeIssue({
        comments: [{ id: 'c1', author: 'mike', body: 'hi', createdAt: 't' }],
      }),
    )
    expect(v.comments).toEqual([{ author: 'mike', body: 'hi', createdAt: 't' }])
  })
  it('yields an empty thread when there are no comments', () => {
    expect(issueDetailFields(makeIssue({ comments: [] })).comments).toEqual([])
  })
})
