import { describe, expect, it } from 'vitest'
import { ISSUE_SYSTEM_POINTER } from './issue-system-pointer.js'

describe('issue system pointer offer guidance', () => {
  it('tells agents to lead with the best review artifact within the visual budget', () => {
    expect(ISSUE_SYSTEM_POINTER).toContain('single best review target first')
    expect(ISSUE_SYSTEM_POINTER).toContain('interactive HTML concept')
    expect(ISSUE_SYSTEM_POINTER).toContain('at most three artifact items')
  })
})
