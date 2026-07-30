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
    expect(m[0]!.path).toBe('/repo/apps/web/src/derive.ts')
  })

  it('ignores an unstyled run even if path-like', () => {
    expect(findStyledPathMatches(cells('apps/web/src/derive.ts', false), cfg)).toHaveLength(0)
  })

  it('does NOT link a branch ref like feat/studio (cwd-relative, no file extension)', () => {
    expect(findStyledPathMatches(cells('feat/studio', true), cfg)).toHaveLength(0)
    expect(findStyledPathMatches(cells('release/v2', true), cfg)).toHaveLength(0)
  })

  it('still links a cwd-relative path that HAS a file extension', () => {
    const m = findStyledPathMatches(cells('src/new/thing.ts', true), cfg)
    expect(m).toHaveLength(1)
    expect(m[0]!.path).toBe('/repo/src/new/thing.ts')
  })

  it('resolves a truncated styled token to the full known path (suffix match)', () => {
    const line = [...cells('see ', false), ...cells('derive.ts', true), ...cells(' here', false)]
    const m = findStyledPathMatches(line, cfg)
    expect(m).toHaveLength(1)
    expect(m[0]!.path).toBe('/repo/apps/web/src/derive.ts')
  })

  it('keeps the real coords of the matched cells for wrapped runs', () => {
    const run = [...cells('/repo/a', true, 0), ...cells('bc.ts', true, 1)]
    const m = findStyledPathMatches(run, cfg)
    expect(m[0]!.cells[0]).toMatchObject({ y: 0 })
    expect(m[0]!.cells.at(-1)!).toMatchObject({ y: 1 })
  })
})
