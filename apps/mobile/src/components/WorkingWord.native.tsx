import { memo, useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useContentVisible } from '../lib/visible-content'
import { color } from '../theme/theme'
import { useLiveInk } from '../theme/use-live-ink'
import { type WorkingWordProps, workingWordPhase } from './WorkingWord.shared'
import { subscribeWorkingWord, workingWordProgress } from './working-word-motion'

const ease = Easing.bezierFn(0.42, 0, 0.58, 1)

/** The window's offset at a clock position. The last third rests with the window
 * outside the text, as on desktop. */
function glintOffset(progress: number, phase: number, width: number): number {
  'worklet'
  return (-0.4 + 1.4 * ease(Math.min(1, ((progress + phase) % 1) / 0.66))) * width
}

/** Desktop's Working glint: a clipped bright copy, moved only by transforms.
 * The real text keeps its colour, wrapping and accessibility even with motion off. */
export const WorkingWord = memo(function WorkingWord({
  children,
  seed,
  active = true,
  style,
  numberOfLines,
  maxFontSizeMultiplier,
  glint = children,
}: WorkingWordProps) {
  const reduced = useReduceMotion()
  const focused = useContentVisible()
  const moving = active && focused && !reduced
  // Same stable phase as desktop; mounting another row never restarts the clock.
  const phase = workingWordPhase(seed)
  useEffect(() => (moving ? subscribeWorkingWord() : undefined), [moving])
  const textProps = { numberOfLines, maxFontSizeMultiplier }
  return (
    <View style={styles.word} testID={active ? 'working-word' : undefined} pointerEvents="none">
      <Text {...textProps} style={style}>
        {children}
      </Text>
      {moving ? (
        <Glint phase={phase} style={style} {...textProps}>
          {glint}
        </Glint>
      ) : null}
    </View>
  )
})

/** Only moving words allocate animated styles; quiet list rows do no frame work. */
function Glint({
  phase,
  style,
  children,
  ...textProps
}: Pick<WorkingWordProps, 'style' | 'children' | 'numberOfLines' | 'maxFontSizeMultiplier'> & {
  phase: number
}) {
  const ink = useLiveInk(color.text)
  const width = useSharedValue(0)
  // Read both shared values inside each updater: Reanimated re-runs a style only
  // for the shared values in its own closure, never ones inside a called worklet.
  const windowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: glintOffset(workingWordProgress.get(), phase, width.get()) }],
  }))
  const copyStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -glintOffset(workingWordProgress.get(), phase, width.get()) }],
  }))
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={StyleSheet.absoluteFill}
      onLayout={(event) => width.set(event.nativeEvent.layout.width)}
      testID="working-word-glint"
    >
      <Animated.View style={[styles.window, windowStyle]}>
        <Animated.View style={[styles.copy, copyStyle]}>
          <Text {...textProps} style={[style, { color: ink }]}>
            {children}
          </Text>
        </Animated.View>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  word: { flexShrink: 1, minWidth: 0, overflow: 'hidden' },
  window: {
    ...StyleSheet.absoluteFill,
    width: '40%',
    overflow: 'hidden',
    opacity: 0.75,
  },
  copy: { width: '250%' },
})
