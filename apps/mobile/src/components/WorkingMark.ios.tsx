import { tetra } from '@podium/working-mark/designs'
import { requireNativeModule, requireNativeView } from 'expo'
import { memo } from 'react'
import type { ViewProps } from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useContentVisible } from '../lib/visible-content'
import { color } from '../theme/theme'
import type { WorkingMarkProps } from './WorkingMark.shared'
import { workingMarkRest, workingMarkSamples } from './working-mark-frames'

const NativeMark = requireNativeView<ViewProps & { active: boolean; tint: string }>(
  'PodiumListRow',
  'PodiumWorkingMarkView',
)

// One hand-over of the shared tetra table: native Core Animation draws the same
// samples, rest picture and loop as the RN worklet path on web and Android.
requireNativeModule<{
  setWorkingMarkFrames(samples: number[], dots: number, rest: number[], loopMs: number): void
}>('PodiumListRow').setWorkingMarkFrames(
  workingMarkSamples.flatMap((picture) => picture.flat()),
  workingMarkRest.length,
  workingMarkRest.flat(),
  tetra.loop,
)

/** iOS: the four tetra dots as Core Animation keyframes. The render server runs
 * the loop; the app computes no frame. React keeps the gate (visible, uncovered
 * content, Reduce Motion); native adds window membership and app foreground. */
export const WorkingMark = memo(function WorkingMark({
  size = 12,
  tint = color.workingText,
}: WorkingMarkProps) {
  const reduceMotion = useReduceMotion()
  const focused = useContentVisible()
  return (
    <NativeMark
      testID="working-mark"
      active={focused && !reduceMotion}
      tint={tint}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: Math.round(size * 0.66), height: size }}
    />
  )
})
