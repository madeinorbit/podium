/** Braille-cell geometry shared by the native and web marks. */
export const WORKING_MARK_DOTS: readonly (readonly [number, number])[] = [
  [17, 18],
  [49, 18],
  [17, 39],
  [49, 39],
  [17, 61],
  [49, 61],
  [17, 82],
  [49, 82],
]

export const WORKING_MARK_CYCLE_MS = 1500
export const DELAYS_MS: readonly number[] = [0, 120, 210, 330, 420, 540, 630, 750]

const WAVE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.16, 1],
  [0.44, 0],
  [1, 0],
]

function amplitudeAt(t: number): number {
  for (let i = 1; i < WAVE.length; i += 1) {
    const [t0, v0] = WAVE[i - 1]
    const [t1, v1] = WAVE[i]
    if (t <= t1) return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)
  }
  return 0
}

/** Shift the CSS keyframe around one normalized cycle for a staggered dot. */
export function wavePhase(phase: number): {
  inputRange: number[]
  outputRange: number[]
} {
  const shift = ((phase % 1) + 1) % 1
  const read = (clock: number) => amplitudeAt((((clock - shift) % 1) + 1) % 1)
  const stops = new Set([0, 1])
  for (const [time] of WAVE) stops.add((((time + shift) % 1) + 1) % 1)
  const inputRange = [...stops].sort((a, b) => a - b)
  return { inputRange, outputRange: inputRange.map(read) }
}

export function workingMarkRadius(size: number): number {
  return size >= 18 ? 9.5 : size >= 14 ? 10.5 : 11
}

export interface WorkingMarkProps {
  /** Cell height in px; width follows the 66:100 cell. */
  size?: number
  tint?: string
  /** Set null where adjacent text already announces the working state. */
  label?: string | null
}
