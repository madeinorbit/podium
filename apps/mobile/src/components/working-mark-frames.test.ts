import { tetra } from '@podium/working-mark/designs'
import { dotsAt } from '@podium/working-mark/frames'
import { expect, it } from 'vitest'
import { workingMarkDot, workingMarkRest, workingMarkViewDot } from './working-mark-frames'

it('keeps the sampled UI animation within 0.02pt of the shared tetra at the largest 24pt size', () => {
  let worst = 0
  let opacityError = 0
  for (let ms = 0; ms <= tetra.loop; ms += 7) {
    dotsAt(tetra, ms).forEach((expected, index) => {
      const dot = workingMarkDot(index, ms / tetra.loop)
      const actual = [dot.cx, dot.cy, dot.rx, dot.ry, dot.opacity]
      actual.forEach((value, property) => {
        const error = Math.abs(value - (expected[property] ?? 0))
        if (property < 4) worst = Math.max(worst, error * 24)
        else opacityError = Math.max(opacityError, error)
      })
    })
  }
  expect(worst).toBeLessThan(0.02)
  expect(opacityError).toBeLessThan(0.001)
  expect(workingMarkDot(0, 0)).toEqual(workingMarkDot(0, 1))
})

it.each([
  9, 12, 18, 24,
])('preserves SVG ellipse centres, radii and opacity with fixed View transforms at %spt', (size) => {
  const width = Math.round(size * 0.66)
  for (let tick = 0; tick <= 120; tick++) {
    for (let index = 0; index < 4; index++) {
      const dot = workingMarkDot(index, tick / 120)
      const { opacity, transform } = workingMarkViewDot(dot, width)
      const [x, y, sx, sy] = transform
      if (!x || !y || !sx || !sy) throw new Error('Missing dot transform')
      // A 2pt circle is centred at width/2, height/2. Scale affects its
      // radii; translation then places that centre in the old SVG viewBox.
      expect((x.translateX ?? 0) + width / 2).toBeCloseTo((dot.cx + 0.5) * width, 10)
      expect((y.translateY ?? 0) + size / 2).toBeCloseTo(dot.cy * width + size / 2, 10)
      expect(sx.scaleX).toBe(dot.rx * width)
      expect(sy.scaleY).toBe(dot.ry * width)
      expect(opacity).toBe(dot.opacity)
    }
  }
  for (const [cx, cy, rx, ry, opacity] of workingMarkRest) {
    expect(workingMarkViewDot({ cx, cy, rx, ry, opacity }, width)).toEqual({
      opacity,
      transform: [
        { translateX: cx * width },
        { translateY: cy * width },
        { scaleX: rx * width },
        { scaleY: ry * width },
      ],
    })
  }
})
