import { describe, expect, it } from 'vitest'
import { computeGrid, InjectableViewportSource } from './viewport'

describe('computeGrid', () => {
  it('floors pixel size by cell size into cols x rows (min 1)', () => {
    expect(computeGrid({ width: 800, height: 480 }, { width: 10, height: 20 })).toEqual({
      cols: 80,
      rows: 24,
    })
    expect(computeGrid({ width: 805, height: 489 }, { width: 10, height: 20 })).toEqual({
      cols: 80,
      rows: 24,
    })
    expect(computeGrid({ width: 5, height: 5 }, { width: 10, height: 20 })).toEqual({
      cols: 1,
      rows: 1,
    })
  })
})

describe('InjectableViewportSource', () => {
  it('reports current size and notifies on change', () => {
    const vp = new InjectableViewportSource({ width: 800, height: 480, dpr: 2 })
    expect(vp.current()).toEqual({ width: 800, height: 480, dpr: 2 })
    const seen: { width: number; height: number; dpr: number }[] = []
    const off = vp.onChange((v) => seen.push(v))
    vp.setSize(400, 300)
    expect(vp.current()).toEqual({ width: 400, height: 300, dpr: 2 })
    expect(seen.at(-1)).toEqual({ width: 400, height: 300, dpr: 2 })
    off()
    vp.setSize(100, 100)
    expect(seen).toHaveLength(1)
  })

  it('simulateKeyboard shrinks height by the inset and notifies, restore brings it back', () => {
    const vp = new InjectableViewportSource({ width: 400, height: 800, dpr: 3 })
    const seen: number[] = []
    vp.onChange((v) => seen.push(v.height))
    vp.simulateKeyboard(300)
    expect(vp.current().height).toBe(500)
    vp.simulateKeyboard(0)
    expect(vp.current().height).toBe(800)
    expect(seen).toEqual([500, 800])
  })
})
