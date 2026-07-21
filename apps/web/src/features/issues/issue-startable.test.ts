import { describe, expect, it } from 'vitest'
import { isIssueStartable } from './issue-startable'

describe('isIssueStartable (POD-110)', () => {
  it('startable: no worktree, open, live', () => {
    expect(isIssueStartable({})).toBe(true)
    expect(isIssueStartable({ worktreePath: null, closedReason: null, archived: false })).toBe(true)
  })

  it('a worktree means an agent is (or was) already on it', () => {
    expect(isIssueStartable({ worktreePath: '/r/.worktrees/issue-4' })).toBe(false)
  })

  it('closed, archived, and deleted issues are not startable', () => {
    expect(isIssueStartable({ closedReason: 'done' })).toBe(false)
    expect(isIssueStartable({ closedReason: 'wontfix' })).toBe(false)
    expect(isIssueStartable({ archived: true })).toBe(false)
    expect(isIssueStartable({ deletedAt: 't' })).toBe(false)
  })
})
