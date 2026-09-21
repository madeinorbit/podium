import { describe, expect, it } from 'vitest'
import {
  CTRL_C,
  CTRL_U,
  claudeComposerDriver,
  codexComposerDriver,
  composerDriverFor,
  PASTE_END,
  PASTE_START,
} from './driver'

function claudeBox(...contentRows: string[]): string[] {
  return [
    'transcript',
    '╭────────────────────────────╮',
    ...contentRows.map((r) => `│ ${r.padEnd(26)} │`),
    '╰────────────────────────────╯',
    '  ? for shortcuts',
  ]
}
const codexScreen = (...rows: string[]): string[] => ['transcript', ...rows, '', '']

describe('composerDriverFor', () => {
  it('returns the claude driver for claude-code and the codex driver for codex', () => {
    expect(composerDriverFor('claude-code')).toBe(claudeComposerDriver)
    expect(composerDriverFor('codex')).toBe(codexComposerDriver)
  })

  it('returns null for harnesses without a composer driver', () => {
    expect(composerDriverFor('grok')).toBe(null)
    expect(composerDriverFor('shell')).toBe(null)
  })
})

describe('dimStripped', () => {
  it('is false for claude (reads raw screen) and true for codex (blanks dim hints)', () => {
    expect(claudeComposerDriver.dimStripped).toBe(false)
    expect(codexComposerDriver.dimStripped).toBe(true)
  })
})

describe('claudeComposerDriver', () => {
  const d = claudeComposerDriver

  it('extract delegates to the claude box extractor', () => {
    expect(d.extract(claudeBox('> hi'))).toBe('hi')
    expect(d.extract(['no box'])).toBe(null)
  })

  it('injectable is true for a clean composer box, false otherwise', () => {
    expect(d.injectable(claudeBox('> hi'))).toBe(true)
    expect(d.injectable(claudeBox('>'))).toBe(true) // empty composer is still injectable
    expect(d.injectable(['no box, streaming output'])).toBe(false)
  })

  it('clearSequence sends one Ctrl-U per composer line', () => {
    expect(d.clearSequence('one line')).toBe(CTRL_U)
    expect(d.clearSequence('l1\nl2\nl3')).toBe(CTRL_U + CTRL_U + CTRL_U)
    expect(d.clearSequence('')).toBe(CTRL_U) // still one, harmless on an empty line
  })

  it('typeSequence types literally with backslash+Enter continuations for newlines', () => {
    expect(d.typeSequence('hello')).toBe('hello')
    expect(d.typeSequence('a\nb')).toBe('a\\\rb')
  })

  it('verify: match, [Pasted text #N] placeholder, mismatch, and null screen', () => {
    expect(d.verify(claudeBox('> hello'), 'hello')).toBe('match')
    expect(d.verify(claudeBox('> [Pasted text #1]'), 'a long\nmultiline draft')).toBe('placeholder')
    expect(d.verify(claudeBox('> something else'), 'hello')).toBe('mismatch')
    expect(d.verify(['no box'], 'hello')).toBe('mismatch')
  })

  it('verify tolerates terminal line wrap: a wide injected line scrapes back wrapped', () => {
    // The PTY wrapped the injected line, so the extractor joins two rows with \n —
    // exact equality would false-mismatch → re-inject → self-demote (reviewer
    // blocker 3). Whitespace-normalized comparison keeps it a match.
    const wrapped = claudeBox('> a very long line that', '  wraps onto a second row')
    expect(d.verify(wrapped, 'a very long line that wraps onto a second row')).toBe('match')
  })
})

describe('codexComposerDriver', () => {
  const d = codexComposerDriver

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
