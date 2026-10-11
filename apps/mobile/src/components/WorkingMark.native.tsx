import { memo, useCallback, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
import Svg, { Ellipse } from 'react-native-svg'
import { restingPicture } from '@podium/working-mark/frames'
import { tetra } from '@podium/working-mark/designs'
import type { Picture } from '@podium/working-mark'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { color } from '../theme/theme'
import type { WorkingMarkProps } from './WorkingMark.shared'
import { subscribeWorkingMark } from './working-mark-motion.native'

const rest = restingPicture(tetra)

/** Native SVG uses the package's tetra pictures, without loading its DOM renderer. */
export const WorkingMark = memo(function WorkingMark({
  size = 12,
  tint = color.workingText,
}: WorkingMarkProps) {
  const dots = useRef<(Ellipse | null)[]>([])
  const reduceMotion = useReduceMotion()
  const paint = useCallback((picture: Picture) => {
    picture.forEach(([cx, cy, rx, ry, opacity], index) => {
      dots.current[index]?.setNativeProps({ cx, cy, rx, ry, opacity })
    })
  }, [])
  useFocusEffect(useCallback(() => {
    paint(rest)
    if (!reduceMotion) return subscribeWorkingMark(paint)
  }, [paint, reduceMotion]))

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
      {rest.map(([cx, cy, rx, ry, opacity], index) => (
        <Ellipse
          key={index}
          ref={dot => { dots.current[index] = dot }}
          cx={cx} cy={cy} rx={rx} ry={ry} opacity={opacity} fill={tint}
        />
      ))}
    </Svg>
  )
})
