import { describe, expect, it } from 'vitest'
import { extractClaudePromptDraft } from './prompt-extract'

const box = (...inner: string[]): string[] => [
  'some transcript output above',
  '╭────────────────────────────╮',
  ...inner.map((s) => `│ ${s.padEnd(26)} │`),
  '╰────────────────────────────╯',
  '  ? for shortcuts',
]

describe('extractClaudePromptDraft', () => {
  it('extracts single-line in-progress text after the caret', () => {
    expect(extractClaudePromptDraft(box('> fix the chat view'))).toBe('fix the chat view')
  })
  it('joins wrapped continuation lines', () => {
    expect(extractClaudePromptDraft(box('> first line', '  second line'))).toBe('first line\nsecond line')
  })
  it('returns empty string for an empty prompt box', () => {
    expect(extractClaudePromptDraft(box('>'))).toBe('')
  })
  it('treats known placeholder text as empty', () => {
    expect(extractClaudePromptDraft(box('> Try "edit <file>" or ask a question'))).toBe('')
  })
  it('returns null when there is no prompt box (no clobber)', () => {
    expect(extractClaudePromptDraft(['just output', 'no box here'])).toBeNull()
  })
})
