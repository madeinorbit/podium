import { describe, expect, it } from 'vitest'
import { extractClaudePromptDraft, extractCodexPromptDraft } from './prompt-extract'

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
  it('ignores a rounded box that is not the composer (startup splash, no caret)', () => {
    // The welcome/splash panel is a rounded box too, but its rows have no '>'
    // prompt marker — capturing it dumped the logo/art into the draft.
    expect(extractClaudePromptDraft(box('🦀 Welcome to Claude Code', '  /help for help'))).toBeNull()
  })
})

// Codex's composer is a single line prefixed with `› ` (U+203A), not a box. The
// empty composer shows a DIM placeholder suggestion; the caller passes lines from
// screenText({dropDim:true}), which blanks dim cells — so an empty composer
// collapses to just the marker, and only genuinely typed text survives.
const MARKER = '›'
describe('extractCodexPromptDraft', () => {
  it('extracts the typed prompt after the marker', () => {
    expect(
      extractCodexPromptDraft(['transcript above', `${MARKER} render the home board`, '  gpt-5.5 · /repo']),
    ).toBe('render the home board')
  })
  it('returns empty string for an empty composer (dim placeholder blanked → marker only)', () => {
    expect(extractCodexPromptDraft(['transcript above', MARKER, '  gpt-5.5 · /repo'])).toBe('')
  })
  it('handles a leading-indented marker', () => {
    expect(extractCodexPromptDraft([`  ${MARKER} hi there`])).toBe('hi there')
  })
  it('returns null when no composer line is present (no clobber)', () => {
    expect(extractCodexPromptDraft(['just output', 'no marker here'])).toBeNull()
  })
})
