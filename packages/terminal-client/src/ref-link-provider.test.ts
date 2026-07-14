import { describe, expect, it } from 'vitest'
import type { Cell } from './buffer-line'
import { findRefMatches } from './ref-link-provider'

/** Build a row of unstyled cells from a string. */
function cells(text: string): Cell[] {
  return [...text].map((char, x) => ({ char, x, y: 0, styled: false }))
}

const known = (p: string): boolean => p === 'POD' || p === 'WEB'

describe('findRefMatches', () => {
  it('matches a bare issue ref with a known prefix', () => {
    const m = findRefMatches(cells('see POD-13 now'), known)
    expect(m.map((x) => x.ref)).toEqual(['POD-13'])
    expect(m[0]?.cells[0]?.x).toBe(4)
  })

  it('matches session and draft refs', () => {
    expect(findRefMatches(cells('POD-13-A and POD-DRAFT-3'), known).map((x) => x.ref)).toEqual([
      'POD-13-A',
      'POD-DRAFT-3',
    ])
  })

  it('ignores unknown prefixes (e.g. UTF-8)', () => {
    expect(findRefMatches(cells('UTF-8 encoded'), known)).toEqual([])
    expect(findRefMatches(cells('ZZZ-9 here'), known)).toEqual([])
  })

  it('matches multiple refs on one row', () => {
    expect(findRefMatches(cells('POD-1 WEB-2'), known).map((x) => x.ref)).toEqual([
      'POD-1',
      'WEB-2',
    ])
  })
})
