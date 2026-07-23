import { describe, expect, it } from 'vitest'
import { stickyPromptsEnabled } from './sticky-prompts'

describe('sticky prompt preference', () => {
  it('defaults on and only an explicit false disables it', () => {
    expect(stickyPromptsEnabled(null)).toBe(true)
    expect(stickyPromptsEnabled('true')).toBe(true)
    expect(stickyPromptsEnabled('false')).toBe(false)
  })
})
