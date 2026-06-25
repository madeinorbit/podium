// packages/terminal-client/src/session-viewport.test.ts
import { describe, expect, it } from 'vitest'
import { decideResizeAction } from './session-viewport'

describe('decideResizeAction', () => {
  it('resizes when the fitted grid differs from the server grid', () => {
    expect(
      decideResizeAction({ cols: 200, rows: 50 }, { cols: 80, rows: 24 }, { forceRedrawIfSame: false }),
    ).toEqual({ kind: 'resize', cols: 200, rows: 50 })
  })

  it('redraws (not resize) when grids match and a repaint is forced (reveal)', () => {
    expect(
      decideResizeAction({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { forceRedrawIfSame: true }),
    ).toEqual({ kind: 'redraw' })
  })

  it('does nothing when grids match and no repaint is forced (steady-state viewport tick)', () => {
    expect(
      decideResizeAction({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { forceRedrawIfSame: false }),
    ).toEqual({ kind: 'none' })
  })
})
