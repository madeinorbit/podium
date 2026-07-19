import { describe, expect, it } from 'vitest'
import { extractClaudePromptDraft, extractCodexPromptDraft } from './prompt-extract'

// A minimal Claude composer box: rounded borders around `> <content>` rows, with a
// footer hint below (as the live TUI renders it).
function box(...contentRows: string[]): string[] {
  return [
    'earlier transcript output',
    '╭────────────────────────────╮',
    ...contentRows.map((r) => `│ ${r.padEnd(26)} │`),
    '╰────────────────────────────╯',
    '  ? for shortcuts',
  ]
}

describe('extractClaudePromptDraft', () => {
  it('extracts a single typed line', () => {
    expect(extractClaudePromptDraft(box('> hello world'))).toBe('hello world')
  })

  it('joins wrapped/continuation rows with newlines', () => {
    expect(extractClaudePromptDraft(box('> first line', '  second line'))).toBe(
      'first line\nsecond line',
    )
  })

  it('returns empty string for an empty box', () => {
    expect(extractClaudePromptDraft(box('>'))).toBe('')
  })

  it('returns empty string for the placeholder hint text', () => {
    expect(extractClaudePromptDraft(box('> Try "how do I..."'))).toBe('')
  })

  it('returns null when there is no box', () => {
    expect(extractClaudePromptDraft(['just some output', 'no composer here'])).toBe(null)
  })

  it('returns null for the startup splash box (no > caret)', () => {
    const splash = [
      '╭────────────────────────────╮',
      '│  ✻ Welcome to Claude Code   │',
      '│  the crab art etc.          │',
      '╰────────────────────────────╯',
    ]
    expect(extractClaudePromptDraft(splash)).toBe(null)
  })

  it('returns null when an overlay replaced the box interior', () => {
    const overlay = [
      '╭────────────────────────────╮',
      '  /clear   clear conversation',
      '  /model   pick a model',
      '╰────────────────────────────╯',
    ]
    expect(extractClaudePromptDraft(overlay)).toBe(null)
  })
})

// Codex draws no box: a `› <text>` marker row near the bottom, then dim
// hint/status rows below. The caller feeds dim-stripped lines, so those hints read
// blank. Multiline/wrapped input renders as indent-aligned continuation rows under
// the marker.
const MARKER = '›'
function codexScreen(...rows: string[]): string[] {
  // Trailing blank rows model codex's dim hint/footer after dropDim blanking.
  return ['transcript above', ...rows, '', '']
}

describe('extractCodexPromptDraft', () => {
  it('extracts a single typed line', () => {
    expect(extractCodexPromptDraft(codexScreen(`${MARKER} hello from codex`))).toBe(
      'hello from codex',
    )
  })

  it('returns empty string for an empty composer (marker only)', () => {
    expect(extractCodexPromptDraft(codexScreen(MARKER))).toBe('')
  })

  it('tolerates a leading-indented marker row', () => {
    expect(extractCodexPromptDraft(codexScreen(`   ${MARKER} indented`))).toBe('indented')
  })

  it('returns null when there is no marker line', () => {
    expect(extractCodexPromptDraft(['just output', 'no composer'])).toBe(null)
  })

  // POD-506: the OLD extractor returned only the marker row, truncating multiline
  // input. The fix captures the indent-aligned continuation rows below it.
  it('joins a multiline draft (POD-506 regression)', () => {
    const screen = codexScreen(`${MARKER} first line`, '  second line', '  third line')
    expect(extractCodexPromptDraft(screen)).toBe('first line\nsecond line\nthird line')
  })

  it('joins a wrapped long line into its continuation rows', () => {
    const screen = codexScreen(`${MARKER} a very long prompt that`, '  wrapped onto a new row')
    expect(extractCodexPromptDraft(screen)).toBe('a very long prompt that\nwrapped onto a new row')
  })

  it('stops at the dim hint/status boundary (blank after dropDim)', () => {
    // A hint row would sit right below the composer; after dropDim it is blank and
    // must never be captured as draft text.
    const screen = ['transcript', `${MARKER} only line`, '', '  ⏎ send   ⌃J newline']
    expect(extractCodexPromptDraft(screen)).toBe('only line')
  })

  it('an EMPTY composer stays empty even with a non-blank status line right below it', () => {
    // The model/repo status row (`gpt-5.6 · /repo`) is dim in real codex; if a caller
    // feeds raw (non-dropDim) lines, an empty `›` must NOT vacuum it up as a draft —
    // the composer's first line is empty, so it is empty (codex readiness detection).
    const screen = ['transcript', `  ${MARKER}`, '  gpt-5.6 · /repo']
    expect(extractCodexPromptDraft(screen)).toBe('')
  })

  it('picks the lowest marker (composer), not an echoed scrollback prompt', () => {
    const screen = [
      `${MARKER} an old submitted prompt in scrollback`,
      'assistant reply...',
      `${MARKER} the live draft`,
      '',
    ]
    expect(extractCodexPromptDraft(screen)).toBe('the live draft')
  })
})
