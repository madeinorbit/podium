import { dayKey, dayLabel, dayMarksByPosition } from '@podium/client-core/transcript-time'
import { describe, expect, it } from 'vitest'

describe('dayKey', () => {
  it('is the LOCAL calendar day, zero-padded and sortable', () => {
    expect(dayKey(new Date(2026, 7, 3, 23, 59))).toBe('2026-08-03')
    expect(dayKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })
})

describe('dayLabel', () => {
  const now = new Date(2026, 7, 10, 12, 0)

  it('names the two days a reader thinks of by name', () => {
    expect(dayLabel(new Date(2026, 7, 10, 8, 0), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 7, 9, 23, 59), now)).toBe('Yesterday')
  })

  it('crosses a month boundary backwards without arithmetic damage', () => {
    expect(dayLabel(new Date(2026, 6, 31, 10, 0), new Date(2026, 7, 1, 12, 0))).toBe('Yesterday')
  })

  it('carries the year only when it is not the current one', () => {
    expect(dayLabel(new Date(2026, 2, 4, 10, 0), now)).not.toMatch(/2026/)
    expect(dayLabel(new Date(2024, 2, 4, 10, 0), now)).toMatch(/2024/)
  })
})

it('marks only boundaries and treats undated rows as transparent', () => {
  const now = new Date(2026, 0, 1, 12)
  const rows = [
    new Date(2025, 11, 30),
    undefined,
    new Date(2025, 11, 31),
    new Date(2025, 11, 31, 23),
    new Date(2026, 0, 1),
  ]
  expect([...dayMarksByPosition(rows, now, (date) => date)]).toEqual([
    [0, dayLabel(rows[0]!, now)],
    [2, 'Yesterday'],
    [4, 'Today'],
  ])
  expect(dayMarksByPosition([now, undefined, now], now, (date) => date).size).toBe(0)
})
