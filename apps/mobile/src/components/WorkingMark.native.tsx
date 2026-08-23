import { useEffect } from 'react'
import Svg, { Circle } from 'react-native-svg'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  makeMutable,
  ReduceMotion,
  type SharedValue,
  useAnimatedProps,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { color } from '../theme/theme'
import {
  DELAYS_MS,
  wavePhase,
  WORKING_MARK_CYCLE_MS,
  WORKING_MARK_DOTS,
  type WorkingMarkProps,
  workingMarkRadius,
} from './WorkingMark.shared'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

/** One UI-runtime clock keeps every mounted mark in phase. */
const clock = makeMutable(0)
let mounted = 0

function startClock(): () => void {
  mounted += 1
  if (mounted === 1) {
    clock.set(
      withRepeat(
        withTiming(1, {
          duration: WORKING_MARK_CYCLE_MS,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        false,
        undefined,
        ReduceMotion.System,
      ),
    )
  }
  return () => {
    mounted -= 1
    if (mounted === 0) {
      cancelAnimation(clock)
      clock.set(0)
    }
  }
}

function WorkingDot({
  progress,
  cx,
  cy,
  delay,
  radius,
  tint,
}: {
  progress: SharedValue<number>
  cx: number
  cy: number
  delay: number
  radius: number
  tint: string
}) {
  const { inputRange, outputRange } = wavePhase(delay / WORKING_MARK_CYCLE_MS)
  const animatedProps = useAnimatedProps(() => {
    const amplitude = interpolate(progress.get(), inputRange, outputRange)
    return {
      opacity: 0.2 + 0.8 * amplitude,
      r: radius * (0.8 + 0.36 * amplitude),
    }
  })

  return <AnimatedCircle cx={cx} cy={cy} r={radius} fill={tint} animatedProps={animatedProps} />
}

/** Native status mark. Reanimated updates SVG props on the UI runtime. */
export function WorkingMark({
  size = 12,
  tint = color.working,
  label = 'Working',
}: WorkingMarkProps) {
  const reduceMotion = useReduceMotion()
  const radius = workingMarkRadius(size)

  useEffect(() => {
    if (reduceMotion) return
    return startClock()
  }, [reduceMotion])

  return (
    <Svg
      accessibilityRole={label === null ? 'none' : 'progressbar'}
      accessibilityLabel={label ?? undefined}
      viewBox="0 0 66 100"
      width={Math.round(size * 0.66)}
      height={size}
    >
      {WORKING_MARK_DOTS.map(([cx, cy], index) =>
        reduceMotion ? (
          <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={radius} fill={tint} />
        ) : (
          <WorkingDot
            key={`${cx}-${cy}`}
            progress={clock}
            cx={cx}
            cy={cy}
            delay={DELAYS_MS[index] ?? 0}
            radius={radius}
            tint={tint}
          />
        ),
      )}
    </Svg>
  )
}
