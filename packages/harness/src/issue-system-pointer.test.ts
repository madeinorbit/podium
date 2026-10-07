import { describe, expect, it } from 'vitest'
import { ISSUE_SYSTEM_POINTER } from './issue-system-pointer.js'

describe('issue system pointer offer guidance', () => {
  it('tells agents to lead with the best review artifact within the visual budget', () => {
    expect(ISSUE_SYSTEM_POINTER).toContain('single best review target first')
    expect(ISSUE_SYSTEM_POINTER).toContain('interactive HTML concept')
    expect(ISSUE_SYSTEM_POINTER).toContain('at most three artifact items')
  })
})

describe('issue system pointer closing guidance', () => {
  it('forbids self-closing and routes a finished issue through review', () => {
    expect(ISSUE_SYSTEM_POINTER).toContain('Never close your own issue or set it to `done` unless the user tells you to')
    expect(ISSUE_SYSTEM_POINTER).toContain('move it to `review` and post an offer with a Close action')
    expect(ISSUE_SYSTEM_POINTER).not.toContain('claim`/`close` as you go')
  })
})
