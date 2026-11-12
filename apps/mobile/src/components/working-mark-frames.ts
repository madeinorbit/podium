import { tetra } from '@podium/working-mark/designs'
import { dotsAt, restingPicture } from '@podium/working-mark/frames'

// Sample the shared design once, not its trigonometry on every UI frame.
const SAMPLE_COUNT = 120
export const workingMarkRest = restingPicture(tetra)
const samples = Array.from({ length: SAMPLE_COUNT + 1 }, (_, i) =>
  dotsAt(tetra, (i * tetra.loop) / SAMPLE_COUNT),
)

/** Linear interpolation keeps the original design and its four-second loop. */
export function workingMarkDot(index: number, progress: number) {
  'worklet'
  const position = Math.max(0, Math.min(1, progress)) * SAMPLE_COUNT
  const frame = Math.min(SAMPLE_COUNT - 1, Math.floor(position))
  const mix = position - frame
  // biome-ignore lint/style/noNonNullAssertion: the fixed tetra sample table contains every frame and dot.
  const a = samples[frame]![index]!
  // biome-ignore lint/style/noNonNullAssertion: the table includes the endpoint after the final interpolated frame.
  const b = samples[frame + 1]![index]!
  return {
    cx: a[0] + (b[0] - a[0]) * mix,
    cy: a[1] + (b[1] - a[1]) * mix,
    rx: a[2] + (b[2] - a[2]) * mix,
    ry: a[3] + (b[3] - a[3]) * mix,
    opacity: a[4] + (b[4] - a[4]) * mix,
  }
}
