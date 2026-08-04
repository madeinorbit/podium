import * as Haptics from 'expo-haptics'
import { useEffect, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

type StyleArg = StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>)

/**
 * The style and the scale land on the SAME element. Wrapping the children in a
 * styled inner view instead would silently break every call site whose style
 * positions it inside its parent — `alignSelf`, `flex`, `margin` would apply to
 * the wrapper while the Pressable itself stayed unstyled.
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * The app's one press affordance: a quick spring scale-down + light haptic.
 * Web gets the scale without haptics. Use for every card/button — consistent
 * physical feedback is most of what makes a UI feel native.
 *
 * A drop-in for `Pressable` [POD-366]: it accepts the same
 * `style={({ pressed }) => …}` callback form, so swapping a call site never
 * loses its pressed styling. Honours Reduce Motion (the haptic still fires —
 * that preference is about movement, not touch feedback) and stays inert while
 * `disabled`.
 */
export function PressableScale({
  children,
  style,
  haptic = true,
  hapticStyle = Haptics.ImpactFeedbackStyle.Light,
  scaleTo = 0.97,
  disabled,
  onPressIn,
  onPressOut,
  onPress,
  ...rest
}: Omit<PressableProps, 'style'> & {
  style?: StyleArg
  haptic?: boolean
  hapticStyle?: Haptics.ImpactFeedbackStyle
  scaleTo?: number
}) {
  const scale = useRef(new Animated.Value(1)).current
  const [pressed, setPressed] = useState(false)
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    let alive = true
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (alive) setReduceMotion(on)
    })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    return () => {
      alive = false
      sub.remove()
    }
  }, [])

  const spring = (toValue: number, speed: number, bounciness: number) => {
    Animated.spring(scale, {
      toValue,
      useNativeDriver: Platform.OS !== 'web',
      speed,
      bounciness,
    }).start()
  }

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      style={[
        typeof style === 'function' ? style({ pressed }) : style,
        { transform: [{ scale }] },
      ]}
      onPressIn={(e) => {
        setPressed(true)
        if (!reduceMotion) spring(scaleTo, 50, 0)
        onPressIn?.(e)
      }}
      onPressOut={(e) => {
        setPressed(false)
        if (!reduceMotion) spring(1, 30, 8)
        onPressOut?.(e)
      }}
      onPress={(e) => {
        if (haptic && Platform.OS !== 'web') {
          Haptics.impactAsync(hapticStyle).catch(() => {})
        }
        onPress?.(e)
      }}
    >
      {children as React.ReactNode}
    </AnimatedPressable>
  )
}
