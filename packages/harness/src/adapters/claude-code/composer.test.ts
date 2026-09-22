/**
 * Claude Code's composer rules (POD-4477): extractor edge cases plus the
 * section's injectable/clear/verify contract — the composer test suite, moved
 * with the rules from `driver/families/terminal/`.
 */

import { describe, expect, it } from 'vitest'
import { CTRL_U } from '../shared/composer.js'
import { claudeComposer, extractClaudePromptDraft } from './composer.js'

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

describe('claudeComposer section', () => {
  const d = claudeComposer

  it('reads the raw screen (no dim stripping)', () => {
    expect(d.dimStripped).toBe(false)
  })

  it('extract delegates to the claude box extractor', () => {
    expect(d.extract(box('> hi'))).toBe('hi')
    expect(d.extract(['no box'])).toBe(null)
  })

  it('injectable is true for a clean composer box, false otherwise', () => {
    expect(d.injectable(box('> hi'))).toBe(true)
    expect(d.injectable(box('>'))).toBe(true) // empty composer is still injectable
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
    expect(d.verify(box('> hello'), 'hello')).toBe('match')
    expect(d.verify(box('> [Pasted text #1]'), 'a long\nmultiline draft')).toBe('placeholder')
    expect(d.verify(box('> something else'), 'hello')).toBe('mismatch')
    expect(d.verify(['no box'], 'hello')).toBe('mismatch')
  })

  it('verify tolerates terminal line wrap: a wide injected line scrapes back wrapped', () => {
    // The PTY wrapped the injected line, so the extractor joins two rows with \n —
    // exact equality would false-mismatch → re-inject → self-demote (reviewer
    // blocker 3). Whitespace-normalized comparison keeps it a match.
    const wrapped = box('> a very long line that', '  wraps onto a second row')
    expect(d.verify(wrapped, 'a very long line that wraps onto a second row')).toBe('match')
  })

  it('declares no input-ready heuristic', () => {
    expect(d.inputReady).toBe(undefined)
  })
})
