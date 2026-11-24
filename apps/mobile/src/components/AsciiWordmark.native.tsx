import { useEffect } from 'react'
import { StyleSheet } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { ASCII_WORDMARK } from './AsciiWordmark.shared'

export const REVEAL_DURATION_MS = 1000

/** Typeset the wordmark once; only opacity changes during the busy launch path. */
export function AsciiWordmark({
  color,
  fontSize = 6.5,
  variant = 'shimmer',
}: {
  color: string
  fontSize?: number
  variant?: 'shimmer' | 'reveal'
}) {
  const reduced = useReduceMotion()
  const reveal = variant === 'reveal' && !reduced
  const opacity = useSharedValue(reveal ? 0 : 1)
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }))
  useEffect(() => {
    cancelAnimation(opacity)
    if (reveal) {
      opacity.set(0)
      opacity.set(
        withTiming(1, {
          duration: REVEAL_DURATION_MS,
          easing: Easing.bezier(0.23, 1, 0.32, 1),
          reduceMotion: ReduceMotion.System,
        }),
      )
    } else opacity.set(1)
    return () => cancelAnimation(opacity)
  }, [opacity, reveal])

  return (
    <Animated.Text
      accessibilityRole="image"
      accessibilityLabel="Podium"
      style={[styles.pre, { color, fontSize, lineHeight: fontSize }, animatedStyle]}
    >
      {ASCII_WORDMARK}
    </Animated.Text>
  )
}

const styles = StyleSheet.create({ pre: { fontFamily: 'Courier', letterSpacing: 0 } })
