import { describe, expect, it } from 'vitest'
import { assigneeInitials } from './issue-glyphs'

describe('assigneeInitials', () => {
  it('takes first letters of the first two words, uppercased', () => {
    expect(assigneeInitials('mike wirth')).toBe('MW')
    expect(assigneeInitials('claude')).toBe('C')
  })
  it('handles separators and noise', () => {
    expect(assigneeInitials('mike.wirth')).toBe('MW')
    expect(assigneeInitials('  spaced   out  ')).toBe('SO')
    expect(assigneeInitials('')).toBe('?')
  })
})
