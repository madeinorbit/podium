import { describe, expect, it } from 'vitest'
import { formatClock, formatCompactDuration } from './session-status'

const m = 60_000
const h = 60 * m

describe('formatCompactDuration', () => {
  it('is formatClock under an hour', () => {
    for (const ms of [0, 3 * m + 14_000, h - 1000])
      expect(formatCompactDuration(ms)).toBe(formatClock(ms))
    expect(formatCompactDuration(3 * m + 14_000)).toBe('3:14')
  })
  it('reads hours and minutes up to two days', () => {
    expect(formatCompactDuration(h)).toBe('1h 0m')
    expect(formatCompactDuration(29 * h + 58 * m + 41_000)).toBe('29h 58m')
    expect(formatCompactDuration(48 * h - 1000)).toBe('47h 59m')
  })
  it('reads days and hours from two days', () => {
    expect(formatCompactDuration(48 * h)).toBe('2d 0h')
    expect(formatCompactDuration(1798 * h)).toBe('74d 22h')
  })
  it('never goes negative', () => expect(formatCompactDuration(-5000)).toBe('0:00'))
})
