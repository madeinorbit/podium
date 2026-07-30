import { describe, expect, it } from 'vitest'
import { lineForTop, topForLine, type BlockPos } from './scroll-sync'

const blocks: BlockPos[] = [
  { line: 1, top: 0 },
  { line: 5, top: 100 },
  { line: 9, top: 250 },
]

describe('topForLine', () => {
  it('returns the top of the greatest block at-or-before the line', () => {
    expect(topForLine(blocks, 1)).toBe(0)
    expect(topForLine(blocks, 4)).toBe(0)
    expect(topForLine(blocks, 5)).toBe(100)
    expect(topForLine(blocks, 7)).toBe(100)
    expect(topForLine(blocks, 100)).toBe(250)
  })
  it('returns 0 for a line before the first block', () => {
    expect(topForLine(blocks, 0)).toBe(0)
  })
})

describe('lineForTop', () => {
  it('returns the line of the topmost block at-or-above scrollTop', () => {
    expect(lineForTop(blocks, 0)).toBe(1)
    expect(lineForTop(blocks, 99)).toBe(1)
    expect(lineForTop(blocks, 100)).toBe(5)
    expect(lineForTop(blocks, 260)).toBe(9)
  })
  it('handles empty input', () => {
    expect(lineForTop([], 50)).toBe(1)
  })
})
