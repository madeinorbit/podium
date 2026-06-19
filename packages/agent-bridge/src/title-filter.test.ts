import { describe, expect, it, vi } from 'vitest'
import { isTransientTitle, makeTitleDebouncer } from './title-filter'

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
    d.push('⠋ working'); d.push('⠙ working'); d.push('Refactor parser')
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['Refactor parser'])
    vi.useRealTimers()
  })
})
