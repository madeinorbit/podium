import { memo, useEffect } from 'react'
import Animated, { useAnimatedProps } from 'react-native-reanimated'
import Svg, { Ellipse } from 'react-native-svg'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useContentVisible } from '../lib/visible-content'
import { color } from '../theme/theme'
import type { WorkingMarkProps } from './WorkingMark.shared'
import { workingMarkDot, workingMarkRest } from './working-mark-frames'
import { subscribeWorkingMark, workingMarkProgress } from './working-mark-motion.native'

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse)

/** Four SVG dots driven by one UI-runtime clock, with no JS work per frame. */
export const WorkingMark = memo(function WorkingMark({
  size = 12,
  tint = color.workingText,
}: WorkingMarkProps) {
  const reduceMotion = useReduceMotion()
  // Focus state also chooses static dots on covered screens, even if another screen keeps the clock alive.
  const focused = useContentVisible()
  useEffect(
    () => (focused && !reduceMotion ? subscribeWorkingMark() : undefined),
    [focused, reduceMotion],
  )

  return (
    <Svg
      testID="working-mark"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      viewBox="-0.5 -0.5 1 1"
      width={Math.round(size * 0.66)}
      height={size}
    >
      {workingMarkRest.map(([cx, cy, rx, ry, opacity], index) =>
        focused && !reduceMotion ? (
          <MovingDot key={`${cx}:${cy}`} index={index} tint={tint} />
        ) : (
          <Ellipse
            key={`${cx}:${cy}`}
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            opacity={opacity}
            fill={tint}
          />
        ),
      )}
    </Svg>
  )
})

function MovingDot({ index, tint }: { index: number; tint: string }) {
  const animatedProps = useAnimatedProps(() => workingMarkDot(index, workingMarkProgress.get()))
  return <AnimatedEllipse animatedProps={animatedProps} fill={tint} />
}
