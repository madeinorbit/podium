import type { ChatRow } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { clockLabel, dayKey, dayLabel, parseTs, rowTimestamp } from './transcript-time'

const item = (ts?: string): TranscriptItem =>
  ({ id: 'i1', role: 'assistant', text: 'x', ...(ts ? { ts } : {}) }) as TranscriptItem

const blockRow = (ts?: string): ChatRow => ({
  kind: 'block',
  block: { item: item(ts) },
  blockIndex: 0,
})
const toolsRow = (...tss: (string | undefined)[]): ChatRow => ({
  kind: 'tools',
  blocks: tss.map((ts) => ({ item: item(ts) })),
  blockIndices: tss.map((_, i) => i),
  title: 'Ran tools',
})

describe('parseTs', () => {
  it('is undefined for absent and unparseable input rather than the epoch', () => {
    expect(parseTs(undefined)).toBeUndefined()
    expect(parseTs('')).toBeUndefined()
    expect(parseTs('not a time')).toBeUndefined()
  })
})

describe('rowTimestamp', () => {
  it('takes a block row from its own item and a run from its first call', () => {
    expect(rowTimestamp(blockRow('2026-08-10T14:32:05Z'))?.toISOString()).toBe(
      '2026-08-10T14:32:05.000Z',
    )
    expect(
      rowTimestamp(toolsRow('2026-08-10T09:00:00Z', '2026-08-10T09:04:00Z'))?.toISOString(),
    ).toBe('2026-08-10T09:00:00.000Z')
  })

  it('is undefined for a row with no timestamp, so nothing downstream invents one', () => {
    expect(rowTimestamp(blockRow(undefined))).toBeUndefined()
    expect(rowTimestamp(toolsRow(undefined))).toBeUndefined()
  })
})

describe('dayKey', () => {
  it('is the LOCAL calendar day, zero-padded and sortable', () => {
    expect(dayKey(new Date(2026, 7, 3, 23, 59))).toBe('2026-08-03')
    expect(dayKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })
})

describe('clockLabel', () => {
  it('zero-pads to one width so the column never jitters', () => {
    expect(clockLabel(new Date(2026, 7, 10, 9, 4))).toBe('09:04')
    expect(clockLabel(new Date(2026, 7, 10, 23, 59))).toBe('23:59')
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
