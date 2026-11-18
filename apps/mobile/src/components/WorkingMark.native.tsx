import { memo, useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useContentVisible } from '../lib/visible-content'
import { color } from '../theme/theme'
import type { WorkingMarkProps } from './WorkingMark.shared'
import { workingMarkDot, workingMarkRest, workingMarkViewDot } from './working-mark-frames'
import { subscribeWorkingMark, workingMarkProgress } from './working-mark-motion.native'

/** Four fixed-size Views share one clock. Transform/opacity updates use the
 * synchronous iOS path instead of committing the screen's shadow tree. */
export const WorkingMark = memo(function WorkingMark({
  size = 12,
  tint = color.workingText,
}: WorkingMarkProps) {
  const reduceMotion = useReduceMotion()
  // Focus state also chooses static dots on covered screens, even if another screen keeps the clock alive.
  const focused = useContentVisible()
  const width = Math.round(size * 0.66)
  const dotStyle = [styles.dot, { left: width / 2 - 1, top: size / 2 - 1, backgroundColor: tint }]
  useEffect(
    () => (focused && !reduceMotion ? subscribeWorkingMark() : undefined),
    [focused, reduceMotion],
  )

  return (
    <View
      testID="working-mark"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width, height: size }}
    >
      {workingMarkRest.map(([cx, cy, rx, ry, opacity], index) =>
        focused && !reduceMotion ? (
          <MovingDot key={`${cx}:${cy}`} index={index} width={width} style={dotStyle} />
        ) : (
          <View
            key={`${cx}:${cy}`}
            style={[dotStyle, workingMarkViewDot({ cx, cy, rx, ry, opacity }, width)]}
          />
        ),
      )}
    </View>
  )
})

function MovingDot({
  index,
  width,
  style,
}: {
  index: number
  width: number
  style: React.ComponentProps<typeof View>['style']
}) {
  const animatedStyle = useAnimatedStyle(() =>
    workingMarkViewDot(workingMarkDot(index, workingMarkProgress.get()), width),
  )
  return <Animated.View style={[style, animatedStyle]} />
}

const styles = StyleSheet.create({
  dot: { position: 'absolute', width: 2, height: 2, borderRadius: 1 },
})
