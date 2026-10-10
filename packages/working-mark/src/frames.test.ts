// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { allDesigns } from './all'
import { tetra, wave } from './designs'
import { dotsAt, period, restingPicture, sheetOf, smoothFps } from './frames'

describe('frames', () => {
  it('every design draws visible dots inside its box at every moment of its loop', () => {
    expect(allDesigns.length).toBe(44)
    expect(new Set(allDesigns.map((d) => d.id)).size).toBe(allDesigns.length)
    for (const d of allDesigns) {
      for (let s = 0; s < 12; s++) {
        const pic = dotsAt(d, (s / 12) * d.loop)
        for (const [x, y, rx, ry, o] of pic) {
          expect(Number.isFinite(x + y + rx + ry + o), d.id).toBe(true)
          expect(Math.abs(x) + rx, d.id).toBeLessThan(0.75)
          expect(Math.abs(y) + ry, d.id).toBeLessThan(0.75)
        }
      }
      expect(restingPicture(d).length, d.id).toBeGreaterThan(0)
    }
  })

  it('finds the repeat period: the tetrahedron repeats every half loop, the wave only every loop', () => {
    expect(period(tetra)).toBe(2000)
    expect(period(wave)).toBe(1500)
  })

  it('cuts one period into distinct pictures and holds that cover it end to end', () => {
    for (const d of allDesigns) {
      const sh = sheetOf(d, 12, 15, 2)
      expect(sh.F, d.id).toBe(Math.max(2, Math.round((sh.P / 1000) * 15)))
      expect(sh.holds[0]?.from, d.id).toBe(0)
      expect(sh.holds.at(-1)?.to, d.id).toBeCloseTo(1, 9)
      for (let i = 1; i < sh.holds.length; i++)
        expect(sh.holds[i]?.from, d.id).toBeCloseTo(sh.holds[i - 1]?.to ?? -1, 9)
      expect(sh.cells.length, d.id).toBeLessThanOrEqual(sh.F)
      expect(Math.max(...sh.holds.map((h) => h.cell)), d.id).toBe(sh.cells.length - 1)
    }
    const t = sheetOf(tetra, 12, 15, 2)
    expect([t.F, t.cellW, t.cellH]).toEqual([30, 12, 12])
  })

  it("keeps each design's smooth frame rate within the measured range", () => {
    for (const d of allDesigns) expect([20, 24, 30, 40], d.id).toContain(smoothFps(d))
    expect(smoothFps(tetra)).toBe(30)
  })
})
