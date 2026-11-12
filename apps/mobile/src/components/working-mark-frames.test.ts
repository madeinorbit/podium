import { tetra } from '@podium/working-mark/designs'
import { dotsAt } from '@podium/working-mark/frames'
import { expect, it } from 'vitest'
import { workingMarkDot } from './working-mark-frames'

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
