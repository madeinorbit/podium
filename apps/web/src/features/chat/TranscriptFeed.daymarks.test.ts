import type { ChatRow, RenderableRow } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { dayMarksByPosition } from './TranscriptFeed'

const row = (ts?: string): ChatRow => ({
  kind: 'block',
  block: {
    item: { id: 'i', role: 'assistant', text: 'x', ...(ts ? { ts } : {}) } as TranscriptItem,
  },
  blockIndex: 0,
})
const feed = (...tss: (string | undefined)[]): RenderableRow[] =>
  tss.map((ts, index) => ({ row: row(ts), index }))

const at = (y: number, m: number, d: number, h = 12): string => new Date(y, m, d, h).toISOString()

describe('dayMarksByPosition', () => {
  const now = new Date(2026, 7, 10, 15, 0)

  it('draws nothing when the whole window is today', () => {
    const marks = dayMarksByPosition(feed(at(2026, 7, 10, 9), at(2026, 7, 10, 14)), now)
    expect(marks.size).toBe(0)
  })

  it('marks the head when the window does NOT open on today', () => {
    const marks = dayMarksByPosition(feed(at(2026, 7, 8), at(2026, 7, 8, 18)), now)
    expect([...marks.keys()]).toEqual([0])
    expect(marks.get(0)).toMatch(/8/)
    expect(marks.get(0)).not.toBe('Today')
  })

  it('marks every date boundary, at the first row of the new day', () => {
    const marks = dayMarksByPosition(
      feed(at(2026, 7, 8), at(2026, 7, 9, 10), at(2026, 7, 9, 20), at(2026, 7, 10, 9)),
      now,
    )
    expect([...marks.keys()]).toEqual([0, 1, 3])
    expect(marks.get(1)).toBe('Yesterday')
    expect(marks.get(3)).toBe('Today')
  })

  it('treats an undated row as transparent — no mark, and it does not reset the day', () => {
    const marks = dayMarksByPosition(feed(at(2026, 7, 10, 9), undefined, at(2026, 7, 10, 11)), now)
    expect(marks.size).toBe(0)
  })

  it('is inert on a transcript that carries no timestamps at all', () => {
    expect(dayMarksByPosition(feed(undefined, undefined), now).size).toBe(0)
  })
})
