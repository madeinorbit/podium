import * as Haptics from 'expo-haptics'
import { useRef, useState } from 'react'
import {
  Animated,
  Platform,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { spring } from '../theme/theme'

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
 * Use for every card/button — consistent physical feedback is most of what
 * makes a UI feel native.
 *
 * A drop-in for `Pressable` [POD-366]: it accepts the same
 * `style={({ pressed }) => …}` callback form, so swapping a call site never
 * loses its pressed styling. The critically damped press spring has no bounce,
 * so Reduce Motion keeps the direct-manipulation feedback but removes the
 * oscillation instead of removing the scale entirely. Stays inert while disabled.
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

  const runSpring = (toValue: number) => {
    Animated.spring(scale, {
      toValue,
      useNativeDriver: Platform.OS !== 'web',
      ...spring.press,
    }).start()
  }

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      style={[typeof style === 'function' ? style({ pressed }) : style, { transform: [{ scale }] }]}
      onPressIn={(e) => {
        setPressed(true)
        runSpring(scaleTo)
        onPressIn?.(e)
      }}
      onPressOut={(e) => {
        setPressed(false)
        runSpring(1)
        onPressOut?.(e)
      }}
      onPress={(e) => {
        if (haptic) {
          Haptics.impactAsync(hapticStyle).catch(() => {})
        }
        onPress?.(e)
      }}
    >
      {children as React.ReactNode}
    </AnimatedPressable>
  )
}
