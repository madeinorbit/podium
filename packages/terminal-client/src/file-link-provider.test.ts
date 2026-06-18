import { describe, expect, it } from 'vitest'
import type { Cell } from './buffer-line'
import { findStyledPathMatches } from './file-link-provider'

function cells(s: string, styled: boolean, y = 0): Cell[] {
  return [...s].map((char, x) => ({ char, x, y, styled }))
}

describe('findStyledPathMatches', () => {
  const cfg = { cwd: '/repo', knownPaths: new Set(['/repo/apps/web/src/derive.ts']), onOpen: () => {} }

  it('matches a styled path-like run', () => {
    const m = findStyledPathMatches(cells('edit apps/web/src/derive.ts', true), cfg)
    expect(m).toHaveLength(1)
    expect(m[0]!.path).toBe('apps/web/src/derive.ts')
  })

  it('ignores an unstyled run even if path-like', () => {
    expect(findStyledPathMatches(cells('apps/web/src/derive.ts', false), cfg)).toHaveLength(0)
  })

  it('keeps the real coords of the matched cells for wrapped runs', () => {
    const run = [...cells('/repo/a', true, 0), ...cells('bc.ts', true, 1)]
    const m = findStyledPathMatches(run, cfg)
    expect(m[0]!.cells[0]).toMatchObject({ y: 0 })
    expect(m[0]!.cells.at(-1)).toMatchObject({ y: 1 })
  })
})
