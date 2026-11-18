import { requireNativeView } from 'expo'
import { memo } from 'react'
import { StyleSheet, Text, View, type ViewProps } from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useContentVisible } from '../lib/visible-content'
import { color } from '../theme/theme'
import { useLiveInk } from '../theme/use-live-ink'
import { type WorkingWordProps, workingWordPhase } from './WorkingWord.shared'

const NativeGlint = requireNativeView<ViewProps & { active: boolean; phase: number }>(
  'PodiumListRow',
  'PodiumWorkingGlintView',
)

/** iOS: desktop's Working glint as a Core Animation mask over a bright copy.
 * The render server moves the mask (2.2s, ease 0.42/0.58 over the first two
 * thirds, rest the last third, stable seed phase); the app computes no frame.
 * The real text keeps its colour, wrapping and accessibility with motion off. */
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
  const textProps = { numberOfLines, maxFontSizeMultiplier }
  return (
    <View style={styles.word} testID={active ? 'working-word' : undefined} pointerEvents="none">
      <Text {...textProps} style={style}>
        {children}
      </Text>
      {moving ? (
        <Glint phase={workingWordPhase(seed)} style={style} {...textProps}>
          {glint}
        </Glint>
      ) : null}
    </View>
  )
})

/** Only moving words mount the glint; quiet rows keep no native layer. */
function Glint({
  phase,
  style,
  children,
  ...textProps
}: Pick<WorkingWordProps, 'style' | 'children' | 'numberOfLines' | 'maxFontSizeMultiplier'> & {
  phase: number
}) {
  const ink = useLiveInk(color.text)
  return (
    <NativeGlint
      active
      phase={phase}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      testID="working-word-glint"
    >
      <Text {...textProps} style={[style, { color: ink }]}>
        {children}
      </Text>
    </NativeGlint>
  )
}

const styles = StyleSheet.create({
  word: { flexShrink: 1, minWidth: 0, overflow: 'hidden' },
})
