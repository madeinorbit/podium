/**
 * Codex's composer rules (POD-4477): extractor edge cases plus the section's
 * injectable/clear/verify contract and the input-ready heuristic — the
 * composer test suite, moved with the rules from
 * `driver/families/terminal/` and `packages/terminal-client/src/session-mount.ts`.
 */

import { describe, expect, it } from 'vitest'
import { CTRL_C, PASTE_END, PASTE_START } from '../shared/composer.js'
import { codexComposer, extractCodexPromptDraft } from './composer.js'

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

describe('codexComposer section', () => {
  const d = codexComposer

  it('strips dim cells before extraction', () => {
    expect(d.dimStripped).toBe(true)
  })

  it('extract delegates to the codex extractor (multiline aware)', () => {
    expect(d.extract(codexScreen('› first', '  second'))).toBe('first\nsecond')
    expect(d.extract(['no marker'])).toBe(null)
  })

  it('injectable is true when the composer marker is present', () => {
    expect(d.injectable(codexScreen('› hi'))).toBe(true)
    expect(d.injectable(['no marker'])).toBe(false)
  })

  it('clearSequence is Ctrl-C ONLY for a non-empty composer, null for empty', () => {
    // Codex Ctrl-C on an empty composer arms quit — must never be sent blind.
    expect(d.clearSequence('some text')).toBe(CTRL_C)
    expect(d.clearSequence('')).toBe(null)
  })

  it('typeSequence is a single bracketed-paste burst with literal newlines, no submit', () => {
    expect(d.typeSequence('hi\nthere')).toBe(`${PASTE_START}hi\nthere${PASTE_END}`)
    expect(d.typeSequence('hi\nthere').endsWith('\r')).toBe(false)
  })

  it('verify: match, ≥1000-char [Pasted Content N chars] placeholder, mismatch', () => {
    expect(d.verify(codexScreen('› hello'), 'hello')).toBe('match')
    expect(d.verify(codexScreen('› [Pasted Content 1500 chars]'), 'x'.repeat(1500))).toBe(
      'placeholder',
    )
    expect(d.verify(codexScreen('› other'), 'hello')).toBe('mismatch')
    expect(d.verify(['no marker'], 'hello')).toBe('mismatch')
  })

  it('verify tolerates line wrap on a wide injected codex line', () => {
    const wrapped = codexScreen('› a very long prompt that', '  wrapped to the next line')
    expect(d.verify(wrapped, 'a very long prompt that wrapped to the next line')).toBe('match')
  })
})

describe('codexComposer inputReady', () => {
  it('is true only for an empty composer on dim-stripped lines', () => {
    expect(codexComposer.inputReady?.(codexScreen('›'))).toBe(true)
    expect(codexComposer.inputReady?.(codexScreen('› already typed'))).toBe(false)
    expect(codexComposer.inputReady?.(['starting MCP servers…', 'no composer'])).toBe(false)
  })
})
