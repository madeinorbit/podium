import { render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { View as RNView } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The web build resolves react-native-svg's `.web.js` entry through Metro's
// platform extensions; this lane resolves the native one, which is Flow-typed
// source no transform here parses. Stub the drawing and record what the mark
// asks each dot to be — the geometry IS what this component contributes.
const drawn: Record<string, unknown>[] = []
const cells: Record<string, unknown>[] = []
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children, ...props }: ComponentProps<typeof RNView>) => {
    cells.push(props as Record<string, unknown>)
    return <View>{children}</View>
  }
  const Circle = (props: Record<string, unknown>) => {
    drawn.push(props)
    return null
  }
  return { default: Svg, Svg, Circle }
})

let reduceMotion = false
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => reduceMotion }))

const { DELAYS_MS, WorkingMark, wavePhase } = await import('./WorkingMark')

/** The keyframe the web mark animates, as amplitude over one cycle. */
function baseWave(t: number): number {
  const stops: [number, number][] = [
    [0, 0],
    [0.16, 1],
    [0.44, 0],
    [1, 0],
  ]
  for (let i = 1; i < stops.length; i += 1) {
    const [t0, v0] = stops[i - 1]
    const [t1, v1] = stops[i]
    if (t <= t1) return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)
  }
  return 0
}

/** Read an interpolation config back the way Animated would. */
function sample(
  { inputRange, outputRange }: { inputRange: number[]; outputRange: number[] },
  c: number,
): number {
  for (let i = 1; i < inputRange.length; i += 1) {
    if (c <= inputRange[i]) {
      const span = inputRange[i] - inputRange[i - 1]
      const at = span === 0 ? 0 : (c - inputRange[i - 1]) / span
      return outputRange[i - 1] + (outputRange[i] - outputRange[i - 1]) * at
    }
  }
  return outputRange[outputRange.length - 1]
}

/** The mark's OWN delays, as phases of the 1.5s cycle — read from the
 *  component so that flattening the stagger fails these tests rather than
 *  quietly turning the wave into a blink. */
const PHASES = DELAYS_MS.map((ms) => ms / 1500)

describe('wavePhase', () => {
  it('staggers the dots exactly as the web mark does', () => {
    // Verbatim from `.pod-mark circle:nth-child(n)` in motion.css. Half the
    // cycle, so the crest is always somewhere in the cell.
    expect(DELAYS_MS).toEqual([0, 120, 210, 330, 420, 540, 630, 750])
    expect(Math.max(...DELAYS_MS)).toBe(750)
  })

  it('is the plain wave at zero delay', () => {
    const zero = wavePhase(0)
    for (let c = 0; c <= 1; c += 0.01) {
      expect(sample(zero, c)).toBeCloseTo(baseWave(c), 6)
    }
  })

  it.each(PHASES)('reads the wave at an offset phase (delay %s)', (phase) => {
    const shifted = wavePhase(phase)
    for (let c = 0; c <= 1; c += 0.005) {
      const expected = baseWave((((c - phase) % 1) + 1) % 1)
      expect(sample(shifted, c)).toBeCloseTo(expected, 6)
    }
  })

  // The eight shipped delays all sit in the first half of the cycle, so their
  // crests never straddle the cycle boundary and the wrap goes unexercised.
  // wavePhase is general, though, and a retuned stagger would lean on it.
  it.each([0.6, 0.8, 0.97, 1.3, -0.2])('wraps a crest across the cycle (phase %s)', (phase) => {
    const shifted = wavePhase(phase)
    for (let c = 0; c <= 1; c += 0.005) {
      expect(sample(shifted, c)).toBeCloseTo(baseWave((((c - phase) % 1) + 1) % 1), 6)
    }
  })

  it.each(PHASES)('spans the whole cycle and loops seamlessly (delay %s)', (phase) => {
    const { inputRange, outputRange } = wavePhase(phase)
    expect(inputRange[0]).toBe(0)
    expect(inputRange[inputRange.length - 1]).toBe(1)
    // Animated rejects a range that does not strictly increase.
    for (let i = 1; i < inputRange.length; i += 1) {
      expect(inputRange[i]).toBeGreaterThan(inputRange[i - 1])
    }
    // The cell never jumps at the wrap: the last value IS the first.
    expect(outputRange[outputRange.length - 1]).toBeCloseTo(outputRange[0], 6)
  })

  it('never lights the whole cell at once — it is a wave, not a pulse', () => {
    // The dots peak one after another, so a synchronous blink (which is what a
    // regressed stagger would look like) can never happen.
    for (let c = 0; c <= 1; c += 0.005) {
      const lit = PHASES.map((p) => sample(wavePhase(p), c))
      expect(Math.min(...lit)).toBeLessThan(0.9)
    }
  })

  it('stays inside the keyframe — no dot over-peaks or drops below rest', () => {
    for (const phase of PHASES) {
      for (let c = 0; c <= 1; c += 0.005) {
        const a = sample(wavePhase(phase), c)
        expect(a).toBeGreaterThanOrEqual(-1e-9)
        expect(a).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('crests in reading order down the cell', () => {
    // Each dot peaks 16% of a cycle after its own delay, so the peaks arrive in
    // the order the dots are drawn.
    const peaks = PHASES.map((p) => {
      let best = 0
      let bestC = 0
      for (let c = 0; c <= 1; c += 0.001) {
        const v = sample(wavePhase(p), c)
        if (v > best) {
          best = v
          bestC = c
        }
      }
      return bestC
    })
    for (let i = 1; i < peaks.length; i += 1) {
      expect(peaks[i]).toBeGreaterThan(peaks[i - 1])
    }
  })
})

describe('WorkingMark', () => {
  beforeEach(() => {
    drawn.length = 0
    reduceMotion = false
  })
  afterEach(() => {
    reduceMotion = false
  })

  it('draws the braille cell: two columns of four', () => {
    render(<WorkingMark size={12} />)
    expect(drawn.map((d) => [d.cx, d.cy])).toEqual([
      [17, 18],
      [49, 18],
      [17, 39],
      [49, 39],
      [17, 61],
      [49, 61],
      [17, 82],
      [49, 82],
    ])
  })

  it.each([
    [24, 9.5],
    [18, 9.5],
    [15, 10.5],
    [14, 10.5],
    [12, 11],
    [7, 11],
  ])('fattens the dots as the cell shrinks (%spx tall → r %s)', (size, radius) => {
    reduceMotion = true
    render(<WorkingMark size={size} />)
    for (const dot of drawn) expect(dot.r).toBe(radius)
  })

  it.each([
    [24, 16],
    [12, 8],
    [11, 7],
    [7, 5],
  ])('keeps the 66:100 cell at every size (%spx tall → %spx wide)', (size, width) => {
    cells.length = 0
    render(<WorkingMark size={size} />)
    expect(cells).toHaveLength(1)
    expect(cells[0].viewBox).toBe('0 0 66 100')
    expect(cells[0].width).toBe(width)
    expect(cells[0].height).toBe(size)
  })

  it('rests fully lit under reduced motion', () => {
    reduceMotion = true
    render(<WorkingMark size={12} />)
    expect(drawn).toHaveLength(8)
    for (const dot of drawn) {
      // No wave: every dot sits at full radius with nothing dimming it.
      expect(dot.r).toBe(11)
      expect(dot.opacity).toBeUndefined()
    }
  })

  it('holds the cell at the wave trough when motion is allowed', () => {
    // Animated resolves its nodes to the CURRENT value before the child sees
    // them, so this reads the mark at clock 0 — the moment before the first
    // crest enters the cell, with every dot at the keyframe's rest.
    render(<WorkingMark size={12} />)
    expect(drawn).toHaveLength(8)
    for (const dot of drawn) {
      expect(dot.opacity).toBeCloseTo(0.2, 6)
      expect(dot.r as number).toBeCloseTo(11 * 0.8, 6)
    }
  })

  it('announces itself, since on most surfaces it is the only cue', () => {
    cells.length = 0
    render(<WorkingMark size={12} />)
    expect(cells[0].accessibilityRole).toBe('progressbar')
    expect(cells[0].accessibilityLabel).toBe('Working')
  })

  it('goes quiet where a label already sits beside it', () => {
    // The feed tail spells out "Working" in text; the mark must not say it
    // again on top of that.
    cells.length = 0
    render(<WorkingMark size={18} label={null} />)
    expect(cells[0].accessibilityRole).toBe('none')
    expect(cells[0].accessibilityLabel).toBeUndefined()
  })

  it('paints the reserved working blue, and retints on request', () => {
    reduceMotion = true
    render(<WorkingMark size={12} />)
    expect(new Set(drawn.map((d) => d.fill))).toEqual(new Set(['#6f9dff']))
    drawn.length = 0
    render(<WorkingMark size={12} tint="#ffffff" />)
    expect(new Set(drawn.map((d) => d.fill))).toEqual(new Set(['#ffffff']))
  })
})
