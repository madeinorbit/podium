import { describe, expect, it, vi } from 'vitest'
import {
  isGenericClaudeTitle,
  isTransientTitle,
  makeTitleDebouncer,
  titleFromPrompt,
} from './title-filter'

describe('isGenericClaudeTitle', () => {
  it('matches the bare placeholder, not a real title', () => {
    expect(isGenericClaudeTitle('Claude Code')).toBe(true)
    expect(isGenericClaudeTitle('  Claude Code  ')).toBe(true)
    expect(isGenericClaudeTitle('Fix the parser')).toBe(false)
  })
})

describe('titleFromPrompt', () => {
  it('takes the first non-empty line, collapsed and capped', () => {
    expect(titleFromPrompt('  \n Fix the   parser \n more')).toBe('Fix the parser')
    expect(titleFromPrompt('')).toBeUndefined()
    expect(titleFromPrompt('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('isTransientTitle', () => {
  it('flags spinner/braille and control-laden titles', () => {
    expect(isTransientTitle('⠋ thinking')).toBe(true)
    expect(isTransientTitle('\x1b[2K')).toBe(true)
    expect(isTransientTitle('   ')).toBe(true)
  })
  it('keeps a normal title', () => {
    expect(isTransientTitle('Fix the minimap bug')).toBe(false)
  })
})

describe('makeTitleDebouncer', () => {
  it('emits only the last stable title after the quiet window', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const d = makeTitleDebouncer((t) => seen.push(t), 500)
    d.push('⠋ working')
    d.push('⠙ working')
    d.push('Refactor parser')
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['Refactor parser'])
    vi.useRealTimers()
  })
})
