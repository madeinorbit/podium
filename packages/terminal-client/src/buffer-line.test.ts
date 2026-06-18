import { describe, expect, it } from 'vitest'
import { stitchLogicalLine } from './buffer-line'

// Minimal fake xterm buffer: rows of [char, styled] pairs; row N>0 wrapped flag.
function fakeBuf(rows: Array<{ cells: Array<[string, boolean]>; wrapped: boolean }>) {
  return {
    getLine(y: number) {
      const row = rows[y]
      if (!row) return undefined
      return {
        length: row.cells.length,
        isWrapped: row.wrapped,
        getCell(x: number) {
          const c = row.cells[x]
          if (!c) return undefined
          return {
            getChars: () => c[0],
            getWidth: () => 1,
            isBold: () => c[1],
            isUnderline: () => false,
            getFgColor: () => -1,
            getFgColorMode: () => 0,
          }
        },
      }
    },
  }
}

describe('stitchLogicalLine', () => {
  it('joins a path that wraps across two rows into one logical line with real coords', () => {
    // "/repo/a" on row 0, "bc.ts" wrapped onto row 1, all bold (styled).
    const buf = fakeBuf([
      { cells: [...'/repo/a'].map((c) => [c, true] as [string, boolean]), wrapped: false },
      { cells: [...'bc.ts'].map((c) => [c, true] as [string, boolean]), wrapped: true },
    ])
    const cells = stitchLogicalLine(buf, 1) // ask about the continuation row
    expect(cells.map((c) => c.char).join('')).toBe('/repo/abc.ts')
    expect(cells.find((c) => c.char === 'b')!).toMatchObject({ x: 0, y: 1 })
    expect(cells.every((c) => c.styled)).toBe(true)
  })

  it('marks default-fg, non-bold cells as not styled', () => {
    const buf = fakeBuf([{ cells: [['x', false]], wrapped: false }])
    expect(stitchLogicalLine(buf, 0)[0]!.styled).toBe(false)
  })
})
