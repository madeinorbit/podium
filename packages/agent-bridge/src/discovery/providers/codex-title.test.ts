import { describe, expect, it } from 'vitest'
import { cleanCodexTitle } from './codex.js'

describe('cleanCodexTitle', () => {
  it('keeps a short prompt as-is and collapses whitespace', () => {
    expect(cleanCodexTitle('  Fix   the parser  ')).toBe('Fix the parser')
  })

  it('drops empty and injected <…> preambles', () => {
    expect(cleanCodexTitle('')).toBeUndefined()
    expect(cleanCodexTitle('<environment>…')).toBeUndefined()
  })

  it('prefers the first sentence when it ends early', () => {
    expect(cleanCodexTitle('Add telegram notifications next. Then wire the UI and test it.')).toBe(
      'Add telegram notifications next.',
    )
  })

  it('cuts a long run-on at a word boundary, not mid-word', () => {
    const runon =
      'I want you to fix something that is occurring now we already did an external plugin that detects links'
    const out = cleanCodexTitle(runon)
    expect(out?.endsWith('…')).toBe(true)
    expect(out?.length ?? 0).toBeLessThanOrEqual(81)
    const head = out?.slice(0, -1) ?? ''
    // The kept head is a prefix of the original and ends at a word boundary.
    expect(runon.startsWith(head)).toBe(true)
    expect(runon[head.length]).toBe(' ')
  })
})
