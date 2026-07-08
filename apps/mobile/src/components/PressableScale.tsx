import * as Haptics from 'expo-haptics'
import { useRef } from 'react'
import { Animated, Platform, Pressable, type PressableProps, type ViewStyle } from 'react-native'

/**
 * The app's one press affordance: a quick spring scale-down + light haptic.
 * Web gets the scale without haptics. Use for every card/button — consistent
 * physical feedback is most of what makes a UI feel native.
 */
export function PressableScale({
  children,
  style,
  haptic = true,
  scaleTo = 0.97,
  onPressIn,
  onPressOut,
  onPress,
  ...rest
}: PressableProps & {
  style?: ViewStyle | ViewStyle[]
  haptic?: boolean
  scaleTo?: number
}) {
  const scale = useRef(new Animated.Value(1)).current

  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        Animated.spring(scale, {
          toValue: scaleTo,
          useNativeDriver: Platform.OS !== 'web',
          speed: 50,
          bounciness: 0,
        }).start()
        onPressIn?.(e)
      }}
      onPressOut={(e) => {
        Animated.spring(scale, {
          toValue: 1,
          useNativeDriver: Platform.OS !== 'web',
          speed: 30,
          bounciness: 8,
        }).start()
        onPressOut?.(e)
      }}
      onPress={(e) => {
        if (haptic && Platform.OS !== 'web') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
        }
        onPress?.(e)
      }}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>
        {children as React.ReactNode}
      </Animated.View>
    </Pressable>
  )
}
