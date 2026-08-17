import { useEffect, useMemo } from 'react'
import { Animated, Easing } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { color } from '../theme/theme'

/**
 * THE WORKING MARK — the one mark the app uses to say "an agent is computing
 * right now", on every surface: spine rows, session cards, ID-square corner
 * badges, the mission bar and the superagent status line.
 *
 * It is the braille cell this app used to SPIN, held still and lit in a
 * travelling wave instead. Eight dots, two columns of four; the light walks
 * down the cell on staggered delays. No rotation, no frame stepping, and no
 * beat you could point at — which is what lets the same mark sit inside a
 * dense mono row AND be stared at for a minute without reading as a terminal
 * artefact.
 *
 * This is the web mark (apps/web/src/lib/motion/WorkingMark.tsx + the
 * `.pod-mark` rules in motion.css) ported to React Native, so a phone and a
 * desktop describe the same working session with the same shape. Geometry,
 * cycle and per-dot delays are carried over verbatim; the only translation is
 * mechanical, because RN has no CSS keyframes.
 *
 * It renders ONLY while an agent is actually computing — gating stays the
 * caller's job, exactly as it was for the spinner.
 */

/** Cell geometry, verbatim from the design (viewBox 66×100): two columns of
 *  four. Order is the wave's path — left, right, one row down, repeat. */
const DOTS: readonly (readonly [number, number])[] = [
  [17, 18],
  [49, 18],
  [17, 39],
  [49, 39],
  [17, 61],
  [49, 61],
  [17, 82],
  [49, 82],
]

const CYCLE_MS = 1500

/** The stagger, verbatim from `.pod-mark circle:nth-child(n)`: reading order
 *  down the cell, spread over half the cycle, so one crest is always
 *  travelling and the cell never goes fully dark or fully lit. */
export const DELAYS_MS: readonly number[] = [0, 120, 210, 330, 420, 540, 630, 750]

/**
 * ONE clock for every mark on screen, inherited from the spinner it replaces
 * [POD-366]: a mark per working session used to mean a timer per session, all
 * showing the same frame. The marks are in lockstep by construction — each dot
 * reads its own phase off this one value — so a screen full of working
 * sessions still drives exactly one animation, and it only runs while a mark
 * is mounted.
 */
const clock = new Animated.Value(0)
let loop: Animated.CompositeAnimation | null = null
let mounted = 0

function runClock(): () => void {
  mounted += 1
  if (!loop) {
    loop = Animated.loop(
      Animated.timing(clock, {
        toValue: 1,
        duration: CYCLE_MS,
        easing: Easing.linear,
        // SVG geometry is not a native-driver prop: `r` has to be written on
        // the JS side. Nothing here re-renders React, though — Animated writes
        // the props straight onto the views.
        useNativeDriver: false,
      }),
    )
    loop.start()
  }
  return () => {
    mounted -= 1
    if (mounted === 0 && loop) {
      loop.stop()
      loop = null
      clock.setValue(0)
    }
  }
}

/** `@keyframes podium-mark-wave` as amplitude over one normalised cycle: dark
 *  and small at rest, one crest at 16%, back down by 44%. */
const WAVE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.16, 1],
  [0.44, 0],
  [1, 0],
]

/** Sample the wave at `t` ∈ [0,1], linear between stops — CSS's default. */
function amplitudeAt(t: number): number {
  for (let i = 1; i < WAVE.length; i += 1) {
    const [t0, v0] = WAVE[i - 1]
    const [t1, v1] = WAVE[i]
    if (t <= t1) return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0)
  }
  return 0
}

/**
 * CSS's `animation-delay` as an interpolation of the shared clock.
 *
 * A delayed dot is just the wave read at an offset phase, so instead of eight
 * clocks with eight start times we shift the CURVE and keep one clock: the
 * wave's stops move by `phase` and wrap around, and the segment that falls off
 * the end reappears at the start. Exported for its test — the wrap is the part
 * worth pinning down.
 */
export function wavePhase(phase: number): {
  inputRange: number[]
  outputRange: number[]
} {
  const shift = ((phase % 1) + 1) % 1
  const read = (c: number) => amplitudeAt((((c - shift) % 1) + 1) % 1)
  const stops = new Set([0, 1])
  for (const [t] of WAVE) stops.add((((t + shift) % 1) + 1) % 1)
  const inputRange = [...stops].sort((a, b) => a - b)
  return { inputRange, outputRange: inputRange.map(read) }
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

export function WorkingMark({
  size = 12,
  tint = color.working,
  label = 'Working',
}: {
  /** Cell HEIGHT in px; width follows the 66:100 cell (≈0.66×). */
  size?: number
  tint?: string
  /** What a screen reader hears. `null` where a label already sits beside the
   *  mark and would otherwise be announced twice — the web mark is decorative
   *  for the same reason. Everywhere else the mark IS the only cue, which is
   *  why it keeps the spinner's announcement rather than going silent. */
  label?: string | null
}) {
  const reduceMotion = useReduceMotion()

  // Small cells get FATTER dots: at 12px tall a 9.5-unit dot is a grey smudge
  // and the wave has nothing to travel across. Ladder verbatim from the design.
  const radius = size >= 18 ? 9.5 : size >= 14 ? 10.5 : 11

  useEffect(() => {
    if (reduceMotion) return
    return runClock()
  }, [reduceMotion])

  const dots = useMemo(
    () =>
      DELAYS_MS.map((delay) => {
        const { inputRange, outputRange } = wavePhase(delay / CYCLE_MS)
        return {
          // opacity .2 → 1 and scale .8 → 1.16, as the keyframe has them. For a
          // circle, scaling about its centre IS its radius, so the radius
          // carries the scale and RN needs no transform-origin.
          opacity: clock.interpolate({
            inputRange,
            outputRange: outputRange.map((a) => 0.2 + 0.8 * a),
          }),
          r: clock.interpolate({
            inputRange,
            outputRange: outputRange.map((a) => radius * (0.8 + 0.36 * a)),
          }),
        }
      }),
    [radius],
  )

  return (
    <Svg
      accessibilityRole={label === null ? 'none' : 'progressbar'}
      accessibilityLabel={label ?? undefined}
      viewBox="0 0 66 100"
      width={Math.round(size * 0.66)}
      height={size}
    >
      {DOTS.map(([cx, cy], i) =>
        // Under reduced motion the wave stops and the cell rests fully lit —
        // the same resting state `prefers-reduced-motion` leaves on the web.
        reduceMotion ? (
          <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={radius} fill={tint} />
        ) : (
          <AnimatedCircle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={dots[i].r}
            fill={tint}
            opacity={dots[i].opacity}
          />
        ),
      )}
    </Svg>
  )
}
